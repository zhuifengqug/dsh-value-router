/**
 * 路由引擎——纯函数，离线可测。
 *
 * ## 优先级（0.10.0 冻结，顺序即契约）
 *
 * ```
 * 用户硬指定线路
 *   → 主模型合法 route 偏好
 *     → difficulty 档位
 *       → 档内轮转
 *         → 同档替代
 *           → 逐档降级
 *             → 全局 fallback
 * ```
 *
 * ## 硬约束（每条都有对应单测）
 *
 * 1. 用户显式 provider/model/reasoning_effort 不可用时，任务保持 pending/blocked；
 * 2. 用户硬路由**不能**自动使用 fallback；
 * 3. 主模型非法 route 只记录 `route-rejected`，然后继续按 difficulty/role 自动重选；
 * 4. 自动路由**禁止无提示升档**：降级只朝成本更低的方向走，绝不升到比 difficulty 更高的档；
 * 5. 普通 subagent 没有任务描述时默认 medium/general，不在 agent/request 层猜难度；
 * 6. 主模型永远不能被本引擎改写——引擎只在被显式调用时对**子代理/成员**做决策，
 *    主会话路由的丢弃判断在 `core/routing.ts` 里独立完成。
 *
 * 引擎不做 IO：目录以 `CatalogSnapshot` 注入，可用性判定在 `core/catalog.ts`。
 */

import {
  isCompleteLine,
  degradationChain,
  resolveConfig,
  tierOf,
  tierLabel,
  type Difficulty,
  type ResolvedLine,
  type ValueRouterConfig,
} from './config.ts'
import { classifyLine, type CatalogSnapshot } from './catalog.ts'
import {
  validateRouteIntent,
  type NormalizedRoute,
  type RouteIntent,
  type RouteSource,
  type RouteStatus,
} from './intent.ts'

/** 审计步骤：每一步都能在 UI 与日志里被单独识别。 */
export type RouteAuditStep =
  | 'validate'
  | 'user-route'
  | 'captain-route'
  | 'route-rejected'
  | 'tier-rotate'
  | 'same-tier-substitute'
  | 'tier-degrade'
  | 'fallback'
  | 'pending'

/** 一条审计记录。 */
export interface RouteAuditEntry {
  at: number
  step: RouteAuditStep
  outcome: 'ok' | 'rejected' | 'skipped' | 'pending' | 'blocked'
  detail: string
  tier?: Difficulty
  route?: Partial<ResolvedLine>
}

/** 解析输入。 */
export interface RouteResolveInput {
  /** 原始全局配置（未分类）。 */
  config: Partial<ValueRouterConfig> | undefined | null
  /** 目录快照。 */
  catalog: CatalogSnapshot
  /** 任务难度；缺省 medium。非法值 → blocked。 */
  difficulty?: unknown
  /** 任务角色；缺省 general。非法值 → blocked。 */
  role?: unknown
  /** 可选的显式线路。 */
  route?: RouteIntent | null
  /**
   * 显式线路的来源。**必须显式给出**：`user` = 用户硬指定（不可用即 pending/blocked，不走 fallback），
   * `captain` = 主模型偏好（非法只记录 route-rejected 后继续自动重选）。
   * 给了 `route` 却不给来源时按 `captain` 处理——主模型是最常见的来源，而把它误判成
   * 用户硬路由会让任务卡住等待人介入，代价更大。
   */
  routeSource?: 'user' | 'captain'
  /** 档内轮转序号（同一难度内的派发序号）。缺省 0。 */
  rotationIndex?: number
  /** 时间注入（测试用）。 */
  now?: number
}

/** 解析结果。 */
export interface RouteResolution {
  provider: string
  model: string
  reasoning_effort: string
  routeSource: RouteSource
  routeStatus: RouteStatus
  /** 是否使用了全局 fallback。 */
  fallback: boolean
  /** 是否发生了档位降级（最终档位低于请求难度）。 */
  degraded: boolean
  requestedDifficulty?: Difficulty
  resolvedDifficulty?: Difficulty
  normalizedRole?: string
  /** 是否应当派发（仅 `resolved` 为 true）。**false 时调用方必须保持任务待定，不得派发。** */
  dispatchable: boolean
  errors: string[]
  reason?: string
  audit: RouteAuditEntry[]
}

function nowOf(input: { now?: number }): number {
  return typeof input.now === 'number' ? input.now : Date.now()
}

function entry(
  at: number,
  step: RouteAuditStep,
  outcome: RouteAuditEntry['outcome'],
  detail: string,
  extra: { tier?: Difficulty; route?: Partial<ResolvedLine> } = {},
): RouteAuditEntry {
  return { at, step, outcome, detail, ...extra }
}

function lineOf(line: ResolvedLine): Partial<ResolvedLine> {
  return {
    provider: line.provider,
    model: line.model,
    reasoning_effort: line.reasoning_effort,
    status: line.status,
  }
}

/** 显式线路的可用性判定结果。 */
interface LineVerdict {
  usable: boolean
  /** 不可用时：是「等环境」还是「要人管」。 */
  status: RouteStatus
  reason: string
  detail: string
}

/**
 * 判定一条显式线路能否直接派发。
 *
 * 判定顺序与宿主一致：白名单 → reasoning_effort 能力 → 目录存在性。
 * 目录**读不到或适配器不声明**时视为可用（不能拿"没声明"当"不存在"），
 * 但 reasoning_effort 被明确否定时一律不可用（宿主会在 provider IO 之前拒绝）。
 */
function judgeExplicitRoute(
  route: NormalizedRoute,
  catalog: CatalogSnapshot,
  who: '用户' | '主模型',
): LineVerdict {
  const label = `${route.provider}/${route.model}`
  if (catalog.allowlist !== undefined) {
    const blocked = !catalog.allowlist.some(
      item => item.provider === route.provider && item.model === route.model,
    )
    if (blocked) {
      return {
        usable: false,
        status: 'blocked',
        reason: 'route-blocked',
        detail: `${who}线路 ${label} 不在宿主白名单内，派发会被宿主拒绝`,
      }
    }
  }
  const verdict = classifyLine(
    { provider: route.provider, model: route.model, reasoning_effort: route.reasoning_effort },
    catalog,
  )
  if (verdict.status === 'available') return { usable: true, status: 'resolved', reason: '', detail: '' }
  if (verdict.status === 'blocked') {
    return { usable: false, status: 'blocked', reason: 'route-blocked', detail: `${who}线路 ${label}：${verdict.statusDetail ?? '被白名单挡住'}` }
  }
  const detail = `${who}线路 ${label} 当前不可用：${verdict.statusDetail ?? '不在宿主模型目录中'}`
  // reasoning_effort 被明确否定 = 配置本身错了，人不管就永远不会好 → blocked；
  // 仅仅是目录里暂时看不到 = 等环境恢复 → pending。
  const effortRejected = verdict.statusDetail?.includes('不支持 reasoning_effort') === true
  return {
    usable: false,
    status: effortRejected ? 'blocked' : 'pending',
    reason: effortRejected ? 'route-invalid' : 'route-unavailable',
    detail,
  }
}

/**
 * 档内候选顺序：从 `rotationIndex` 开始环形展开。
 *
 * 展开顺序本身就是「档内轮转 + 同档替代」：第 0 个是轮转应得的那条，
 * 后面的是它的同档替代。调用方取第一个 `available` 的即可，
 * 跳过的条数就是替代次数（审计里可见）。
 */
export function orderedCandidates(lines: readonly ResolvedLine[], rotationIndex: number): ResolvedLine[] {
  if (lines.length === 0) return []
  const size = lines.length
  const start = ((rotationIndex % size) + size) % size
  return Array.from({ length: size }, (_, offset) => lines[(start + offset) % size]!)
}

/**
 * 解析一次任务路由。
 *
 * **永不抛错**：任何输入都会返回一份带 `audit` 的结果；`dispatchable=false` 时
 * 调用方必须保持任务待定（pending/blocked），不得自行降级或换线路。
 */
export function resolveRoute(input: RouteResolveInput): RouteResolution {
  const at = nowOf(input)
  const audit: RouteAuditEntry[] = []
  const validation = validateRouteIntent({
    difficulty: input.difficulty,
    role: input.role,
    route: input.route,
  })

  if (!validation.ok) {
    for (const error of validation.errors) {
      audit.push(entry(at, 'validate', 'blocked', error))
    }
    return {
      provider: '', model: '', reasoning_effort: '',
      routeSource: 'none',
      routeStatus: 'blocked',
      fallback: false,
      degraded: false,
      dispatchable: false,
      errors: validation.errors,
      reason: 'invalid-intent',
      audit,
    }
  }

  const requestedDifficulty = validation.difficulty!
  const normalizedRole = validation.normalizedRole!
  audit.push(entry(at, 'validate', 'ok', `difficulty=${requestedDifficulty} role=${normalizedRole}`))

  // —— 1. 用户硬指定线路：不可用时绝不换线路、绝不走 fallback ——
  if (validation.route !== undefined && input.routeSource === 'user') {
    const route = validation.route
    const verdict = judgeExplicitRoute(route, input.catalog, '用户')
    if (verdict.usable) {
      audit.push(entry(at, 'user-route', 'ok', `用户硬路由 ${route.provider}/${route.model} 可用`, {
        route: { provider: route.provider, model: route.model, reasoning_effort: route.reasoning_effort },
      }))
      return {
        provider: route.provider,
        model: route.model,
        reasoning_effort: route.reasoning_effort,
        routeSource: 'user',
        routeStatus: 'resolved',
        fallback: false,
        degraded: false,
        requestedDifficulty,
        resolvedDifficulty: requestedDifficulty,
        normalizedRole,
        dispatchable: true,
        errors: [],
        audit,
      }
    }
    audit.push(entry(at, 'user-route', verdict.status === 'blocked' ? 'blocked' : 'pending',
      `${verdict.detail}（用户硬路由不自动换线路、不使用 fallback）`))
    return {
      provider: '', model: '', reasoning_effort: '',
      routeSource: 'user',
      routeStatus: verdict.status,
      fallback: false,
      degraded: false,
      requestedDifficulty,
      normalizedRole,
      dispatchable: false,
      errors: verdict.status === 'blocked' ? [verdict.detail] : [],
      reason: `user-${verdict.reason}`,
      audit,
    }
  }

  // —— 2. 主模型 route 偏好：非法只记录 route-rejected，然后继续自动重选 ——
  if (validation.route !== undefined) {
    const route = validation.route
    const verdict = judgeExplicitRoute(route, input.catalog, '主模型')
    if (verdict.usable) {
      audit.push(entry(at, 'captain-route', 'ok', `主模型线路 ${route.provider}/${route.model} 可用`, {
        route: { provider: route.provider, model: route.model, reasoning_effort: route.reasoning_effort },
      }))
      return {
        provider: route.provider,
        model: route.model,
        reasoning_effort: route.reasoning_effort,
        routeSource: 'captain',
        routeStatus: 'resolved',
        fallback: false,
        degraded: false,
        requestedDifficulty,
        resolvedDifficulty: requestedDifficulty,
        normalizedRole,
        dispatchable: true,
        errors: [],
        audit,
      }
    }
    audit.push(entry(at, 'route-rejected', 'rejected',
      `主模型线路 ${route.provider}/${route.model} 被拒：${verdict.detail}；继续按 difficulty/role 自动重选`, {
        route: { provider: route.provider, model: route.model, reasoning_effort: route.reasoning_effort },
      }))
  }

  // —— 3~6. difficulty 档位 → 档内轮转 → 同档替代 → 逐档降级 ——
  const cfg = resolveConfig(input.config)
  const rotationIndex = Number.isFinite(input.rotationIndex) ? Math.trunc(input.rotationIndex as number) : 0
  for (const tierId of degradationChain(requestedDifficulty)) {
    const tier = tierOf(cfg.tiers, tierId)
    const candidates = orderedCandidates(tier.lines, rotationIndex).map(line => {
      const verdict = classifyLine(line, input.catalog)
      return { ...line, ...verdict }
    })
    if (candidates.length === 0) {
      audit.push(entry(at, 'tier-degrade', 'skipped', `${tierLabel(tierId)}档未配置任何线路`, { tier: tierId }))
      continue
    }
    const preferred = candidates[0]!
    const substituted = candidates.findIndex(line => line.status === 'available')
    if (substituted === -1) {
      audit.push(entry(at, 'tier-degrade', 'skipped',
        `${tierLabel(tierId)}档 ${candidates.length} 条线路全部不可用`, { tier: tierId }))
      continue
    }
    const chosen = candidates[substituted]!
    audit.push(entry(at, 'tier-rotate', 'ok',
      `${tierLabel(tierId)}档内轮转：槽位 ${rotationIndex} 命中第 ${substituted} 顺位是 ${chosen.provider}/${chosen.model}`,
      { tier: tierId, route: lineOf(chosen) }))
    if (substituted > 0) {
      audit.push(entry(at, 'same-tier-substitute', 'ok',
        `轮转首选 ${preferred.provider}/${preferred.model} 不可用，同档替代 ${substituted} 步后落到 ${chosen.provider}/${chosen.model}`,
        { tier: tierId, route: lineOf(chosen) }))
    }
    const degraded = tierId !== requestedDifficulty
    if (degraded) {
      audit.push(entry(at, 'tier-degrade', 'ok',
        `请求难度 ${tierLabel(requestedDifficulty)} 在本档及所有更低档均无可用线路，降级到 ${tierLabel(tierId)} 档（只降不升）`,
        { tier: tierId }))
    }
    return {
      provider: chosen.provider,
      model: chosen.model,
      reasoning_effort: chosen.reasoning_effort,
      routeSource: 'difficulty',
      routeStatus: 'resolved',
      fallback: false,
      degraded,
      requestedDifficulty,
      resolvedDifficulty: tierId,
      normalizedRole,
      dispatchable: true,
      errors: [],
      audit,
    }
  }

  // —— 7. 全局 fallback（不是任何档位的轮转成员）——
  const fallback = cfg.fallback
  if (isCompleteLine(fallback) && classifyLine(fallback, input.catalog).status === 'available') {
    audit.push(entry(at, 'fallback', 'ok',
      `四档均无可用线路，使用全局兜底 ${fallback.provider}/${fallback.model}`, { route: lineOf(fallback) }))
    return {
      provider: fallback.provider,
      model: fallback.model,
      reasoning_effort: fallback.reasoning_effort,
      routeSource: 'fallback',
      routeStatus: 'resolved',
      fallback: true,
      degraded: true,
      requestedDifficulty,
      normalizedRole,
      dispatchable: true,
      errors: [],
      audit,
    }
  }

  if (isCompleteLine(fallback)) {
    audit.push(entry(at, 'fallback', 'skipped',
      `全局兜底 ${fallback.provider}/${fallback.model} 不可用：${classifyLine(fallback, input.catalog).statusDetail ?? '原因未知'}`))
  } else {
    audit.push(entry(at, 'fallback', 'skipped', '未配置全局兜底线路'))
  }
  audit.push(entry(at, 'pending', 'pending', '四档与全局兜底均无可用线路，任务保持待定'))
  return {
    provider: '', model: '', reasoning_effort: '',
    routeSource: 'none',
    routeStatus: 'pending',
    fallback: false,
    degraded: false,
    requestedDifficulty,
    normalizedRole,
    dispatchable: false,
    errors: [],
    reason: 'no-route',
    audit,
  }
}

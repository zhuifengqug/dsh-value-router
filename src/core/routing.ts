/**
 * agent/request 路由决策——纯函数，便于离线单测。
 *
 * 判定顺序（任一不满足即放行普通 DSH 路由）：
 *   1. 总开关 enabled；
 *   2. **origin === 'subagent'**——主会话永不被改写（最关键回归项，第一位）；
 *   3. 既没有可用池、也没有完整兜底线路 → 无处可派；
 *   4. B+1 放行：子会话的「首见意图」线路与父线路不同 ⇒ 主控显式指定过 ⇒ 尊重它；
 *      与父线路相同时按 ambiguousPolicy 决定（歧义，见 config.ts 的注释）；
 *   5. 目标线路 = 最低档（tiers[0]）的可路由线路里轮转 pool[N % 池长]；无则用兜底 executor；
 *   6. 目标 provider 不可用 → 降级到 executor；executor 也不可用 → 放行；
 *   7. 目标 === 本次请求本来会用的线路 → no-op 放行（不改写、不计数）。
 *
 * 版本语义变化：
 * - 0.2.0 **删掉 scope 门控**（专属预设已摘除，插件对全部预设生效）；
 *   同时**删掉「无条件改写」**，只在主控没指定时才分配线路。
 * - 0.4.0 扁平 pool → **用户自定义的档位列表**；兜底只轮转最低档。
 */

import type {
  AmbiguousPolicy,
  ResolvedModelRoute,
  ResolvedPoolLine,
  ResolvedTier,
  ResolvedValueRouterConfig,
  SessionOverrideConfig,
  ValueRouterConfig,
} from './config.ts'
import { isCompleteModelRoute, resolveEffectiveConfig, routableLines, routeKey, sanitizeExecutor } from './config.ts'
import type { ChildRouteIntent } from './state.ts'

/** 跳过路由的原因（用于日志与遥测）。 */
export type RouteSkipReason =
  | 'disabled'
  | 'not-subagent'
  | 'no-target'
  | 'explicit-route'
  | 'executor-incomplete'
  | 'executor-unavailable'
  | 'noop'

/**
 * 会话是否是被派发的子代理。
 *
 * **单一判定源**：0.1.0 里 index.ts 与本文件各写了一遍 `origin === 'subagent'`，
 * 两处漂移过一次。收敛到这里，两边共用。
 *
 * 顺带说明 Agent Team：队友也是 provider-owned subagent child
 * （dsh-experimental-agent-team 走 startContinuable，dsh-subagent 的
 * child-agent.js 写死 `origin: 'subagent'`），所以队友也会命中这里——
 * 这正是轮转方案不需要"识别队友"的原因。
 */
export function isSubagentSession(header: { origin?: unknown } | undefined | null): boolean {
  return header?.origin === 'subagent'
}

/** 生效覆写来源。 */
export type OverrideSource = 'session' | 'parent' | 'global'

export interface RouteDecisionInput {
  /** 全局（设置页）配置原文，可能是旧版本/缺字段。 */
  globalConfig: Partial<ValueRouterConfig> | undefined | null
  /** 会话来源（session.header.origin）。 */
  origin?: string
  /** 会话自身的覆写（一般只有主会话有）。 */
  sessionOverride?: SessionOverrideConfig
  /** 父会话覆写（子代理的 header.parentSession 指向主会话）。 */
  parentOverride?: SessionOverrideConfig
  /** 本次请求本来会用的线路（= `await next()` 的返回值）。 */
  resolvedRoute?: { provider?: string; model?: string } | undefined
  /** 该子会话的线路意图快照（首次观察时由插件记录）。 */
  intent?: ChildRouteIntent | undefined
  /** 该子会话在父会话下的轮转序号（首次观察时分配，之后固定不变）。 */
  rotationIndex?: number | undefined
  /** 目标 provider 可用性判定（由调用方用 ctx.llm 判定）。 */
  targetAvailable: boolean
  /** 兜底线路 provider 可用性判定。 */
  fallbackAvailable: boolean
}

export type RouteDecision =
  | { route: false; reason: RouteSkipReason }
  | {
    route: true
    provider: string
    model: string
    reasoningEffort?: string
    /** 本次改写来自轮转池还是兜底线路。 */
    source: 'pool' | 'fallback'
    overrideSource: OverrideSource
    effective: ResolvedValueRouterConfig
  }

/** 选出用于本会话的覆写（自身 → 父会话 → 无）。 */
export function pickOverride(
  sessionOverride?: SessionOverrideConfig,
  parentOverride?: SessionOverrideConfig,
): { override?: SessionOverrideConfig; source: OverrideSource } {
  if (sessionOverride !== undefined) return { override: sessionOverride, source: 'session' }
  if (parentOverride !== undefined) return { override: parentOverride, source: 'parent' }
  return { override: undefined, source: 'global' }
}

/**
 * 选目标线路：在**最低档**（`tiers[0]`）的白名单放行线路里按序号轮转；无则用兜底线路。
 *
 * 为什么只轮转最低档：用户的设计意图是「省 token 优先」——主控没指定线路时，
 * 默认落最便宜的档；更高档位由**主控显式指定**命中（提示词里给了选档准则）。
 * 副作用要知道：这样拿到的是**同档内的供应商多样性**，不是跨档多样性。
 *
 * 最低档自身无可路由线路时（例如全被白名单挡掉）依次尝试更高的档位，最后才用兜底线路
 * ——总比让子代理继承主模型（最贵的一条）强。
 *
 * 轮转序号在会话首次观察时分配一次并固定（见 state.rotationIndexOf），
 * 因此同一子会话的多 step 请求永远落在同一条线上。
 */
export function pickTargetRoute(
  tiers: readonly ResolvedTier[],
  executor: ResolvedModelRoute,
  rotationIndex: number,
): { route: ResolvedPoolLine | ResolvedModelRoute; source: 'pool' | 'fallback' } {
  for (const tier of tiers) {
    const usable = routableLines(tier.pool)
    if (usable.length === 0) continue
    const index = ((rotationIndex % usable.length) + usable.length) % usable.length
    return { route: usable[index]!, source: 'pool' }
  }
  return { route: executor, source: 'fallback' }
}

/**
 * B+1 放行判定：主控是否显式指定过线路。
 *
 * 固有歧义：`next()` 分不清「没指定、继承父模型」和「显式指定了和父一样的模型」。
 * 两种情形下线路都等于父线路，只能由 `ambiguousPolicy` 决定：
 * - rotate（默认）：当作没指定 → 继续走轮转；
 * - respect：当作显式指定 → 放行，保留继承。
 * 线路**不等于**父线路时无歧义：一律认定为主控显式指定，放行。
 */
export function isExplicitSelection(
  intent: ChildRouteIntent | undefined,
  policy: AmbiguousPolicy,
): boolean {
  if (!intent) return false
  const intentKey = routeKey(intent.provider, intent.model)
  if (intent.parentRoute !== undefined && intentKey !== intent.parentRoute) return true
  return policy === 'respect'
}

/** 决定本次 agent/request 是否改写线路。 */
export function decideSubagentRoute(input: RouteDecisionInput): RouteDecision {
  const { override, source } = pickOverride(input.sessionOverride, input.parentOverride)
  const effective = resolveEffectiveConfig(input.globalConfig, override)
  const executor = sanitizeExecutor(effective.executor)

  if (!effective.enabled) return { route: false, reason: 'disabled' }
  // 永不接管主模型：只有子代理会话被改写。**第一位**，任何配置都不可绕过。
  if (input.origin !== 'subagent') return { route: false, reason: 'not-subagent' }

  const hasPool = effective.tiers.some(tier => routableLines(tier.pool).length > 0)
  const hasFallback = isCompleteModelRoute(executor)
  if (!hasPool && !hasFallback) return { route: false, reason: 'no-target' }

  // B+1：主控显式指定过线路就尊重，不再改写。
  if (isExplicitSelection(input.intent, effective.ambiguousPolicy)) {
    return { route: false, reason: 'explicit-route' }
  }

  const { route: target, source: targetSource } = pickTargetRoute(
    effective.tiers,
    executor,
    input.rotationIndex ?? 0,
  )

  // 目标线路不可用：降级到兜底线路；兜底也没有就安全放行。
  let chosen: ResolvedPoolLine | ResolvedModelRoute = target
  let chosenSource = targetSource
  if (!input.targetAvailable) {
    if (targetSource === 'fallback' || !hasFallback || !input.fallbackAvailable) {
      return { route: false, reason: targetSource === 'fallback' ? 'executor-unavailable' : 'executor-incomplete' }
    }
    chosen = executor
    chosenSource = 'fallback'
  }

  // 同模型 no-op：宿主本来就会用这条线，别白改一次。
  if (
    input.resolvedRoute?.provider === chosen.provider
    && input.resolvedRoute?.model === chosen.model
  ) {
    return { route: false, reason: 'noop' }
  }

  return {
    route: true,
    provider: chosen.provider,
    model: chosen.model,
    ...(chosen.reasoningEffort ? { reasoningEffort: chosen.reasoningEffort } : {}),
    source: chosenSource,
    overrideSource: source,
    effective: { ...effective, executor },
  }
}

/** 人读的跳过原因（日志用）。 */
export function routeSkipText(reason: RouteSkipReason): string {
  switch (reason) {
    case 'disabled': return '价值路由未启用'
    case 'not-subagent': return '非子代理会话（主模型永不被接管）'
    case 'no-target': return '轮转池为空且兜底线路未配置'
    case 'explicit-route': return '主控显式指定了线路，予以放行'
    case 'executor-incomplete': return '兜底线路未配置完整'
    case 'executor-unavailable': return '兜底线路 provider 不可用'
    case 'noop': return '目标线路与当前一致，无需改写'
  }
}

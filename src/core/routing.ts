/**
 * `agent/request` 决策——普通 subagent 的线路改写。
 *
 * ## 边界（0.10.0）
 *
 * - **主模型永不被改写**：`origin !== 'subagent'` 一律放行，这是第一位的不变量。
 * - 普通 subagent **没有任务描述**：`agent/request` 的 payload 只有 `{agent, turn, step, signal}`，
 *   插件在路由层无法判定难度，因此**不猜难度**——固定 `difficulty = medium`、`role = 'general'`。
 *   真正的难度路由属于任务级（Agent Teams 的任务路由字段）。
 * - 主控在 `subagent` 工具里**显式指定**的线路仍然被尊重：它等价于新契约里的
 *   「主模型 route 偏好」。判定方式是首见意图与父会话线路不同——
 *   与父相同即视为「没指定」（固定规则，不再有 `ambiguousPolicy` 开关）。
 *
 * 纯函数：目录以值对象注入，不做 IO。
 */

import type { CatalogSnapshot } from './catalog.ts'
import { DEFAULT_DIFFICULTY, resolveConfig, type ValueRouterConfig } from './config.ts'
import { DEFAULT_ROLE } from './config.ts'
import { resolveRoute, type RouteResolution } from './route.ts'
import { routeKey } from './config.ts'
import type { ChildRouteIntent } from './state.ts'

/** 跳过改写的原因。 */
export type RouteSkipReason =
  | 'disabled'
  | 'not-subagent'
  | 'not-dispatchable'
  | 'noop'

export interface SubagentRouteInput {
  /** 原始全局配置。 */
  config: Partial<ValueRouterConfig> | undefined | null
  /** 目录快照。 */
  catalog: CatalogSnapshot
  /** 会话来源（`session.header.origin`）。 */
  origin?: string
  /** 本次请求本来会用的线路（= `await next()` 的返回值）。 */
  resolvedRoute?: { provider?: string; model?: string; reasoningEffort?: string } | undefined
  /** 该子会话的首次线路意图快照。 */
  intent?: ChildRouteIntent | undefined
  /** 父会话线路的 `provider/model` 键。 */
  parentRouteKey?: string | undefined
  /** 该子会话在父会话下的轮转序号。 */
  rotationIndex?: number | undefined
}

export type SubagentRouteDecision =
  | { route: false; reason: RouteSkipReason }
  | { route: true; resolution: RouteResolution }

/**
 * 会话是否是被派发的子代理。
 *
 * **单一判定源**：0.1.0 里 index.ts 与本文件各写了一遍 `origin === 'subagent'`，
 * 两处漂移过一次。收敛到这里，两边共用。
 *
 * 顺带说明 Agent Team：队友也是 provider-owned subagent child，
 * 所以队友也会命中这里。但队友的线路由 Agent Teams 侧按任务路由冻结在创建时，
 * 本 hook 只在**普通 subagent** 上生效（队友会话的 harness 路由与团队记录保持一致）。
 */
export function isSubagentSession(header: { origin?: unknown } | undefined | null): boolean {
  return header?.origin === 'subagent'
}

/**
 * 主控是否在 `subagent` 工具里显式指定过线路。
 *
 * 固定规则：首见意图的 `provider/model` 与父会话线路**不同**即为显式指定。
 * 相同视为「继承、没指定」——`next()` 分不清这两者，硬猜只会两边都错，
 * 所以选一个不会擅自打断继承的默认走向。
 */
export function isExplicitCaptainRoute(intent: ChildRouteIntent | undefined, parentRouteKey: string | undefined): boolean {
  if (intent === undefined) return false
  if (parentRouteKey === undefined) return false
  return routeKey(intent.provider, intent.model) !== parentRouteKey
}

/** 决定本次 `agent/request` 是否改写线路。 */
export function decideSubagentRoute(input: SubagentRouteInput): SubagentRouteDecision {
  const config = resolveConfig(input.config)
  if (!config.enabled) return { route: false, reason: 'disabled' }
  // 永不接管主模型。**第一位**，任何配置都不可绕过。
  if (input.origin !== 'subagent') return { route: false, reason: 'not-subagent' }

  const explicit = isExplicitCaptainRoute(input.intent, input.parentRouteKey)
  const resolution = resolveRoute({
    config: input.config,
    catalog: input.catalog,
    // 普通 subagent 没有任务描述：不猜难度，固定 medium/general。
    difficulty: DEFAULT_DIFFICULTY,
    role: DEFAULT_ROLE,
    route: explicit && input.intent !== undefined
      ? {
          provider: input.intent.provider,
          model: input.intent.model,
          reasoning_effort: input.intent.reasoningEffort ?? '',
        }
      : undefined,
    routeSource: 'captain',
    ...(input.rotationIndex === undefined ? {} : { rotationIndex: input.rotationIndex }),
  })

  if (!resolution.dispatchable) return { route: false, reason: 'not-dispatchable' }
  if (
    input.resolvedRoute?.provider === resolution.provider
    && input.resolvedRoute?.model === resolution.model
  ) {
    return { route: false, reason: 'noop' }
  }
  return { route: true, resolution }
}

/** 人读的跳过原因（日志用）。 */
export function routeSkipText(reason: RouteSkipReason): string {
  switch (reason) {
    case 'disabled': return '价值路由未启用'
    case 'not-subagent': return '非子代理会话（主模型永不被接管）'
    case 'not-dispatchable': return '本次无人可派（线路不可用 / 用户硬路由挂起）'
    case 'noop': return '目标线路与当前一致，无需改写'
  }
}

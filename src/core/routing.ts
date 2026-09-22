/**
 * agent/request 路由决策（规格 §3.2）——纯函数，便于离线单测。
 *
 * 顺序（任一不满足即放行普通 DSH 路由）：
 *   1. 总开关 enabled；
 *   2. scope 门控（preset / global + excludePresets）；
 *   3. origin === 'subagent'——**主会话永不被改写**（最关键回归项）；
 *   4. 全局配置 ⊕ 会话覆写后仍 enabled 且 executor 完整；
 *   5. executor provider 可用（不可用则安全降级为普通路由）。
 *
 * 会话覆写来源：子代理会话自己没有气泡，所以先看自身（兼容手动写入），
 * 再看父会话（气泡挂在主会话上，header.parentSession），最后回落到全局配置。
 */

import type { ResolvedValueRouterConfig, SessionOverrideConfig, ValueRouterConfig } from './config.ts'
import { isCompleteModelRoute, resolveEffectiveConfig, scopeAllowsPreset } from './config.ts'

/** 跳过路由的原因（用于日志与遥测）。 */
export type RouteSkipReason =
  | 'disabled'
  | 'scope'
  | 'not-subagent'
  | 'executor-incomplete'
  | 'executor-unavailable'

/**
 * 解析会话**当前**所在的预设 id。
 *
 * 为什么不能只看 `session.header.agentPreset`：DSH 的注释明确写着 header 是
 * 「会话**开始**时所用的预设」（`dsh-agent-presets/lib/index.js` 的
 * agentPresetProjectionDefinition 段），且不可变；切换预设走的是
 * `agent-preset/selected` 事件——`swap()` 会先 `recompose(agent.ctx)`，
 * 再追加该事件推进 `agentPreset` 投影。
 *
 * 实测事故：新建会话时 header 记的是 `standard`，用户随即切成 `value-router`，
 * 于是按 header 判定「不在生效范围」→ 提示段不注入、子代理路由被 `scope` 跳过，
 * 表现为「选了价值路由预设却一次都不派子代理」。
 *
 * 优先级：实时组合（agent.ctx 的 standing mount，最权威）→ 会话投影（durable 记录）
 * → 创建 header（兜底旧行为）。三者都可能缺失，返回 undefined。
 */
export function resolveCurrentPreset(sources: {
  composed?: string | null | undefined
  projection?: string | null | undefined
  header?: string | null | undefined
}): string | undefined {
  for (const value of [sources.composed, sources.projection, sources.header]) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/** 生效覆写来源。 */
export type OverrideSource = 'session' | 'parent' | 'global'

export interface RouteDecisionInput {
  /** 全局（设置页）配置原文，可能是旧版本/缺字段。 */
  globalConfig: Partial<ValueRouterConfig> | undefined | null
  /** 当前会话的预设 id（用 resolveCurrentPreset() 解析，勿直接传 session.header.agentPreset）。 */
  agentPreset?: string
  /** 会话来源（session.header.origin）。 */
  origin?: string
  /** 会话自身的覆写（一般只有主会话有）。 */
  sessionOverride?: SessionOverrideConfig
  /** 父会话覆写（子代理的 header.parentSession 指向主会话）。 */
  parentOverride?: SessionOverrideConfig
  /** executor provider 是否可用（由调用方用 ctx.llm 判定）。 */
  executorAvailable: boolean
}

export type RouteDecision =
  | { route: false; reason: RouteSkipReason }
  | {
    route: true
    provider: string
    model: string
    reasoningEffort?: string
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

/** 决定本次 agent/request 是否改写到 executor 路由。 */
export function decideSubagentRoute(input: RouteDecisionInput): RouteDecision {
  const { override, source } = pickOverride(input.sessionOverride, input.parentOverride)
  const effective = resolveEffectiveConfig(input.globalConfig, override)

  if (!effective.enabled) return { route: false, reason: 'disabled' }
  if (!scopeAllowsPreset(effective, input.agentPreset)) return { route: false, reason: 'scope' }
  // 永不接管主模型：只有子代理会话被改写。
  if (input.origin !== 'subagent') return { route: false, reason: 'not-subagent' }
  if (!isCompleteModelRoute(effective.executor)) return { route: false, reason: 'executor-incomplete' }
  if (!input.executorAvailable) return { route: false, reason: 'executor-unavailable' }

  return {
    route: true,
    provider: effective.executor.provider,
    model: effective.executor.model,
    ...(effective.executor.reasoningEffort ? { reasoningEffort: effective.executor.reasoningEffort } : {}),
    overrideSource: source,
    effective,
  }
}

/** 人读的跳过原因（日志用）。 */
export function routeSkipText(reason: RouteSkipReason): string {
  switch (reason) {
    case 'disabled': return '价值路由未启用'
    case 'scope': return '当前预设不在生效范围内'
    case 'not-subagent': return '非子代理会话（主模型永不被接管）'
    case 'executor-incomplete': return 'executor 未配置完整'
    case 'executor-unavailable': return 'executor provider 不可用'
  }
}

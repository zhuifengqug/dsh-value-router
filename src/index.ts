/**
 * 价值路由 @gjs27/dsh-value-router —— 宿主侧（Node.js）。
 *
 * 定位：DSH 会话内成本感知协作层。
 * - 主模型（用户在预设/会话里选的）永不被插件接管；
 * - 带工具的子任务 → 自动下沉给便宜的 DSH executor 子代理（agent/request 改写）；
 * - 生效范围 scope = 'preset'（专属预设内）| 'global'（所有预设，支持排除清单）。
 *
 * 退役记录（2026-09-22）：桥接通道（Chat2API 外发 + bridge_* 三工具 + 12 道门控 +
 * 脱敏/限额/压缩回注/字符估算记账）整体删除，本插件只剩子代理路由这一条通道，
 * 因此不再注册任何工具、不再持有任何 HTTP 客户端或批次队列。
 *
 * 注意：不要 `export default apply`（loader unwrapExports 会丢弃模块级 inject）。
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'

import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  VALUE_ROUTER_PRESET_ID,
  VALUE_ROUTER_SETTINGS_NAMESPACE,
  assertConfigValid,
  formatModelRoute,
  isCompleteModelRoute,
  resolveConfig,
  resolveEffectiveConfig,
  scopeAllowsPreset,
  type ResolvedValueRouterConfig,
  type SessionOverrideConfig,
  type ValueRouterConfig,
} from './core/config.ts'
import { Config } from './core/schema.ts'
import { buildSystemPromptGuidance, VALUE_ROUTER_SECTION_NAME, VALUE_ROUTER_SECTION_ORDER } from './core/policy.ts'
import { checkRouteAvailability, type ExecutorHealth } from './core/model-selection.ts'
import { decideSubagentRoute, resolveCurrentPreset, routeSkipText } from './core/routing.ts'
import { emitValueRouterRuntimeTelemetry, routeErrorType, routeParameters, type RouteParameters } from './core/runtime-telemetry.ts'
import { valueRouterState, type SessionMetricsSnapshot } from './core/state.ts'
import type { ValueRouterStatusSnapshot } from './core/snapshot.ts'
import { ValueRouterStatusController } from './status-controller.ts'
import { dshHome } from './dsh-home.ts'
import { syncPresetTrees } from './sync.ts'

export const name = 'value-router'
export const inject = ['systemPrompt', 'settings', 'llm']

export * from './core/config.ts'
export * from './core/policy.ts'
export * from './core/routing.ts'
export * from './core/state.ts'
export * from './core/model-selection.ts'
export * from './core/runtime-telemetry.ts'
export * from './core/snapshot.ts'
export * from './typert.ts'

export interface ValueRouterService {
  snapshot(): ValueRouterStatusSnapshot
  sessionMetrics(sessionId: string): SessionMetricsSnapshot
}

/** executor provider 可用性的刷新间隔（徽章 executorStatus 的数据来源）。 */
export const EXECUTOR_HEALTH_REFRESH_MS = 30_000

/** 插件自带预设树的绝对路径（打包进包内的 presets/）。 */
export function bundledPresetsRoot(metaUrl: string = import.meta.url): string {
  return fileURLToPath(new URL('../presets/', metaUrl))
}

/**
 * 把 bundled 预设同步到 `<DSH_HOME>/.agent-presets`，使「价值路由」模式在模式选择器
 * 中可选。与设置开关无关（用户需能在配置 executor 之前先选到该模式）。
 */
function syncBundledPreset(ctx: Context): void {
  try {
    const targetRoot = join(dshHome(), '.agent-presets')
    const result = syncPresetTrees(bundledPresetsRoot(), targetRoot)
    for (const { id, error } of result.failed) {
      ctx.logger?.warn?.(`value-router: 预设 ${id} 同步失败：${error}`)
    }
    if (result.synced.length > 0) {
      ctx.logger?.info?.(`value-router: 预设已同步到 ${targetRoot}：${result.synced.join(', ')}`)
    }
  } catch (error) {
    ctx.logger?.warn?.(`value-router: 预设同步失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 从 agent/request、agent/status 的 payload 里取会话 id（header.id 是权威来源）。 */
function sessionIdOf(payload: unknown): string | undefined {
  const agent = (payload as { agent?: { id?: unknown; session?: { header?: { id?: unknown } } } })?.agent
  const fromHeader = agent?.session?.header?.id
  if (typeof fromHeader === 'string' && fromHeader) return fromHeader
  return typeof agent?.id === 'string' && agent.id ? agent.id : undefined
}
export function apply(ctx: Context, initialConfig: Partial<ValueRouterConfig> = {}): void | Promise<void> {
  // 先同步预设，保证模式在启动后即可被选择（与设置开关无关）。
  syncBundledPreset(ctx)

  let currentConfig: ResolvedValueRouterConfig = resolveConfig(initialConfig)
  let currentSource: () => Partial<ValueRouterConfig> = () => initialConfig

  const getConfig = (): ResolvedValueRouterConfig => resolveConfig(currentSource())

  /**
   * 读取 agent **当前**所在的预设 id。
   *
   * 不能只看 `session.header.agentPreset`：那是会话「创建时」的预设且不可变，
   * 用户切换预设只追加 `agent-preset/selected` 事件并重组合 agent ctx。
   * 详见 core/routing.ts 的 resolveCurrentPreset 注释（实测事故复盘）。
   */
  const currentPresetOf = (agent: unknown): string | undefined => {
    const value = agent as
      | { ctx?: Context; session?: { header?: { agentPreset?: string | null } } }
      | undefined
    let composed: string | null | undefined
    try {
      const presets = ctx.get('agentPresets' as never) as
        | { composedPreset?: (agentCtx: Context) => string | undefined }
        | undefined
      if (value?.ctx !== undefined && typeof presets?.composedPreset === 'function') {
        composed = presets.composedPreset(value.ctx) ?? null
      }
    } catch { /* 服务缺失 → 回落到投影 */ }
    let projection: string | null | undefined
    try {
      const projections = ctx.get('sessionProjections' as never) as
        | { stateOf?: (session: unknown, key: string) => unknown }
        | undefined
      if (value?.session !== undefined && typeof projections?.stateOf === 'function') {
        const state = projections.stateOf(value.session, 'agentPreset')
        projection = typeof state === 'string' ? state : null
      }
    } catch { /* 服务缺失 → 回落到 header */ }
    return resolveCurrentPreset({ composed, projection, header: value?.session?.header?.agentPreset })
  }

  // —— executor 健康缓存（同步快照用；探活间隔刷新）——
  let executorHealth: ExecutorHealth = { status: 'disabled', executorHealth: 'unconfigured' }
  const refreshExecutorHealth = async (): Promise<void> => {
    const effective = resolveEffectiveConfig(currentSource())
    executorHealth = await checkRouteAvailability(ctx.llm, effective.executor).then((h) => ({
      status: !effective.enabled ? 'disabled' as const
        : h === 'unconfigured' ? 'unconfigured' as const
          : h === 'unavailable' ? 'degraded' as const
            : 'active' as const,
      executorHealth: h,
      ...(h === 'unconfigured' ? { reason: 'executor 未配置完整' } : {}),
      ...(h === 'unavailable' ? { reason: 'executor provider 不可用' } : {}),
    }))
  }

  // —— 设置：注册命名空间（自动生成 GUI 开关），并同步 currentConfig ——
  ctx.settings.installSection(ctx, VALUE_ROUTER_SETTINGS_NAMESPACE, Config, currentConfig, {
    setSource: (source) => {
      currentSource = source
      currentConfig = resolveConfig(source())
      void refreshExecutorHealth()
    },
    onChange: () => {
      currentConfig = resolveConfig(currentSource())
      void refreshExecutorHealth()
    },
    validate: (value) => {
      assertConfigValid(value)
    },
  })

  // —— 系统提示段（order 145）：scope 门控内、生效配置启用时注入 ——
  ctx.systemPrompt.section({
    name: VALUE_ROUTER_SECTION_NAME,
    order: VALUE_ROUTER_SECTION_ORDER,
    text: (assembly: {
      agent?: {
        ctx?: Context
        session?: { header?: { agentPreset?: string; origin?: string; id?: string; parentSession?: string } }
      }
    }) => {
      const header = assembly?.agent?.session?.header
      const globalConfig = currentSource()
      const base = resolveConfig(globalConfig)
      if (!base.enabled) return ''
      if (!scopeAllowsPreset(base, currentPresetOf(assembly?.agent))) return ''
      const sessionId = typeof header?.id === 'string' ? header.id : undefined
      const override = sessionOverrideFor(sessionId, header?.parentSession)
      const effective = resolveEffectiveConfig(globalConfig, override)
      if (!effective.enabled) return ''
      return buildSystemPromptGuidance(effective, {
        role: header?.origin === 'subagent' ? 'subagent' : 'controller',
      })
    },
  })

  // —— 会话覆写解析：自身 → 父会话 → 全局 ——
  function sessionOverrideFor(sessionId?: string, parentSessionId?: string): SessionOverrideConfig | undefined {
    if (sessionId !== undefined) {
      const own = valueRouterState.getSessionOverride(sessionId)
      if (own !== undefined) return own
    }
    if (parentSessionId !== undefined) return valueRouterState.getSessionOverride(parentSessionId)
    return undefined
  }

  // —— agent/request 路由：只改写子代理会话（主模型永不被接管）——
  const routedRequestAttempts = new Map<string, { timestamp: number; params: RouteParameters }>()
  const streams = new Map<string, string>()

  const requestKey = (payload: unknown): string | undefined => {
    const value = payload as { agent?: { id?: unknown; session?: { header?: { id?: unknown } } }; turn?: unknown; step?: unknown }
    const id = sessionIdOf(payload)
    if (id === undefined || !Number.isSafeInteger(value.turn) || !Number.isSafeInteger(value.step)) return undefined
    return `${id}:${value.turn}:${value.step}`
  }

  const pruneRoutedRequestAttempts = (now: number): void => {
    for (const [key, { timestamp }] of routedRequestAttempts) {
      if (now - timestamp > 10 * 60_000) routedRequestAttempts.delete(key)
    }
    while (routedRequestAttempts.size > 2_048) {
      const oldest = routedRequestAttempts.keys().next().value
      if (typeof oldest !== 'string') break
      routedRequestAttempts.delete(oldest)
    }
    for (const [stream, key] of streams) if (!routedRequestAttempts.has(key)) streams.delete(stream)
  }

  ctx.on('agent/request', async (payload, next) => {
    // lineage 先记（与路由门是两个独立职责）：子会话的父会话归属供覆写查询与计量聚合。
    const sessionId = sessionIdOf(payload)
    const header = payload.agent?.session?.header
    const parentSessionId = typeof header?.parentSession === 'string' ? header.parentSession : undefined
    if (sessionId !== undefined && parentSessionId !== undefined) {
      valueRouterState.trackChildSession(sessionId, parentSessionId)
    }

    const resolved = await next()

    const globalConfig = currentSource()
    const base = resolveConfig(globalConfig)
    const agentPreset = currentPresetOf(payload.agent)
    // 廉价预检：不启用 / 不在生效范围 / 不是子代理 → 直接放行，不触碰 llm。
    if (!base.enabled) return resolved
    if (!scopeAllowsPreset(base, agentPreset)) return resolved
    if (header?.origin !== 'subagent') return resolved

    const override = sessionOverrideFor(sessionId, parentSessionId)
    const effective = resolveEffectiveConfig(globalConfig, override)
    if (!effective.enabled || !isCompleteModelRoute(effective.executor)) return resolved

    const available = (await checkRouteAvailability(ctx.llm, effective.executor)) === 'ready'
    const decision = decideSubagentRoute({
      globalConfig,
      agentPreset,
      origin: header?.origin,
      ...(sessionId !== undefined ? { sessionOverride: valueRouterState.getSessionOverride(sessionId) } : {}),
      ...(parentSessionId !== undefined ? { parentOverride: valueRouterState.getSessionOverride(parentSessionId) } : {}),
      executorAvailable: available,
    })
    if (!decision.route) {
      ctx.logger?.debug?.(`value-router: 放行普通路由（${routeSkipText(decision.reason)}）`)
      return resolved
    }

    // 同模型路由是 no-op：保留原请求（含其 reasoningEffort），也不计一次 executor 调用。
    if (resolved.provider === decision.provider && resolved.model === decision.model) return resolved

    valueRouterState.recordExecutorCall(sessionId)
    const key = requestKey(payload)
    const params = routeParameters('subagent', decision.effective.strategy, decision.model)
    if (key !== undefined) {
      const now = Date.now()
      pruneRoutedRequestAttempts(now)
      routedRequestAttempts.set(key, { timestamp: now, params })
    }
    emitValueRouterRuntimeTelemetry({ event: 'value_router_route', params, timestamp: new Date().toISOString() })

    // 目标模型自己拥有 reasoning effort：不继承原请求的 effort
    // （executor 不支持该档位时会让整轮失败 UNSUPPORTED_REASONING_EFFORT）。
    const { reasoningEffort: _inheritedEffort, ...routed } = resolved as LlmCallConfig & { reasoningEffort?: string }
    return {
      ...routed,
      provider: decision.provider,
      model: decision.model,
      ...(decision.reasoningEffort ? { reasoningEffort: decision.reasoningEffort as LlmCallConfig['reasoningEffort'] } : {}),
    }
  })

  ctx.on('agent/request-error', async (payload, next) => {
    const key = requestKey(payload)
    const attempt = key === undefined ? undefined : routedRequestAttempts.get(key)
    if (attempt && key !== undefined) {
      routedRequestAttempts.delete(key)
      emitValueRouterRuntimeTelemetry({
        event: 'value_router_route',
        timestamp: new Date().toISOString(),
        params: { ...attempt.params, result: 'failure', error_type: routeErrorType((payload as { failure?: unknown }).failure) },
      })
    }
    return next()
  })

  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    const stream = `${agent.id}:${frame.attemptId}`
    if (frame.type === 'start') {
      const key = requestKey({ agent, turn: frame.turn, step: frame.step })
      if (key && routedRequestAttempts.has(key)) streams.set(stream, key)
      return
    }
    if (frame.type !== 'end') return
    const key = streams.get(stream)
    streams.delete(stream)
    const attempt = key === undefined ? undefined : routedRequestAttempts.get(key)
    if (!attempt || key === undefined) return
    if (frame.outcome.kind === 'committed' && frame.outcome.eventType === 'assistant/attempt') return
    routedRequestAttempts.delete(key)
    const success = frame.outcome.kind === 'committed' && frame.outcome.eventType === 'assistant/message'
    emitValueRouterRuntimeTelemetry({
      event: 'value_router_route',
      timestamp: new Date().toISOString(),
      params: { ...attempt.params, result: success ? 'success' : 'cancelled', error_type: success ? 'none' : 'cancelled' },
    })
  })

  // —— 状态服务 + 状态控制器（Remote 通道：快照 / 会话指标 / 会话覆写写入）——
  const service: ValueRouterService = {
    snapshot: (): ValueRouterStatusSnapshot => {
      const c = getConfig()
      return {
        enabled: c.enabled,
        scope: c.scope,
        strategy: c.strategy,
        executor: { ...c.executor },
        executorStatus: executorHealth.status,
        ...(executorHealth.reason !== undefined ? { executorReason: executorHealth.reason } : {}),
        executorCallsTotal: valueRouterState.getGlobalMetrics().executorCalls,
      }
    },
    sessionMetrics: (sessionId: string) => valueRouterState.getSessionMetrics(sessionId),
  }
  ctx.provide('valueRouter', service)

  let controllerFiber: { await(): Promise<unknown> }
  try {
    controllerFiber = ctx.plugin(ValueRouterStatusController) as unknown as { await(): Promise<unknown> }
  } catch (error) {
    ctx.logger?.warn?.(`value-router: 状态通道挂载失败，GUI 状态将保持默认：${String(error)}`)
    controllerFiber = { await: async () => undefined }
  }

  // —— 启动探活 + 周期刷新（ctx.effect 管理生命周期）——
  void refreshExecutorHealth()
  ctx.effect(() => {
    const timer = setInterval(() => {
      void refreshExecutorHealth()
    }, EXECUTOR_HEALTH_REFRESH_MS)
    ;(timer as unknown as { unref?: () => void }).unref?.()
    return () => {
      clearInterval(timer)
    }
  }, 'value-router: executor health probe')

  try {
    ctx.logger?.info?.(
      `value-router: apply() 完成（scope=${currentConfig.scope}, strategy=${currentConfig.strategy}, executor=${formatModelRoute(currentConfig.executor)}, preset=${VALUE_ROUTER_PRESET_ID}）`,
    )
  } catch { /* ignore */ }

  return controllerFiber.await().then(() => undefined)
}

/**
 * 价值路由 @gjs27/dsh-value-router —— 宿主侧（Node.js）。
 *
 * 定位：DSH 的**唯一模型路由 owner**。它回答一个问题：
 * 「这次派发该用哪个 provider/model/reasoning_effort？」
 *
 * 两条通道：
 * 1. **普通 subagent**：`agent/request` 钩子。主模型永不被改写；
 *    子代理按其首见意图（主控显式指定的线路）或固定 medium/general 档位解析。
 * 2. **能力服务 `valueRouterRouting`**：任何插件可探测调用 `catalog()/validate()/resolve()/record()`，
 *    用于任务级路由（Agent Teams 走这条）。服务缺席时调用方保持原行为，本插件不提供替身。
 *
 * 0.10.0 退役（无迁移、无双读）：扁平 `pool`、旧动态 `tiers`、`executor`、`strategy`、
 * `ambiguousPolicy`、`tierRouting`、会话级覆写、`migrateLegacyPool`。
 *
 * 注意：不要 `export default apply`（loader unwrapExports 会丢弃模块级 inject）。
 */

import { appendFileSync } from 'node:fs'

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'

import {
  VALUE_ROUTER_SETTINGS_NAMESPACE,
  DEFAULT_DIFFICULTY,
  DEFAULT_ROLE,
  resolveConfig,
  type ResolvedValueRouterConfig,
  type ValueRouterConfig,
} from './core/config.ts'
import type { AllowlistEntry } from './core/catalog.ts'
import { Config } from './core/schema.ts'
import { buildSystemPromptGuidance, VALUE_ROUTER_SECTION_NAME, VALUE_ROUTER_SECTION_ORDER } from './core/policy.ts'
import { TYPERT } from './typert.ts'
import { readHostAllowlist } from './core/model-selection.ts'
import { isExplicitCaptainRoute, isSubagentSession, routeSkipText } from './core/routing.ts'
import { routeKey } from './core/config.ts'
import { emitValueRouterRuntimeTelemetry, routeErrorType, routeParameters, type RouteParameters } from './core/runtime-telemetry.ts'
import { valueRouterState, type ChildRouteIntent } from './core/state.ts'
import { buildStatusSnapshot, type SnapshotDispatch, type ValueRouterStatusSnapshot } from './core/snapshot.ts'
import { RouteEventLog } from './core/audit.ts'
import { createRoutingService, VALUE_ROUTER_SERVICE_NAME, type ValueRouterRoutingService } from './service.ts'
import { ValueRouterStatusController } from './status-controller.ts'

export const name = 'value-router'
export const inject = ['systemPrompt', 'settings', 'llm', 'configEditor']

/** Loader 条目的结构（不 import loader 包，避免新增 peerDep）。 */
interface SettingsConfigEntry {
  options?: { id?: string; config?: unknown }
}

export * from './core/config.ts'
export * from './core/catalog.ts'
export * from './core/intent.ts'
export * from './core/route.ts'
export * from './core/audit.ts'
export * from './core/policy.ts'
export * from './core/routing.ts'
export * from './core/state.ts'
export * from './core/model-selection.ts'
export * from './core/snapshot.ts'
export * from './service.ts'
export * from './typert.ts'

/**
 * 设置 schema **必须从 entry 模块导出**。
 *
 * 宿主 `dsh-settings` 读的是 `entry.fiber?.runtime?.Config`，而 `entry.fiber.runtime`
 * 就是本包**主入口模块**的导出对象。少这一行 re-export，宿主拿到 `undefined` →
 * `describe()` 把整个条目跳过 → 命名空间不被服务，表现为「设置里没有卡片」
 * 与「当前配置不可写」。这个坑栽过两次（一次漏 `.volatile()`，一次漏导出 `Config`）。
 */
export { Config } from './core/schema.ts'

/** 顶栏徽章读取的快照服务。 */
export interface ValueRouterService {
  snapshot(): ValueRouterStatusSnapshot
}

/** 目录/可用性刷新的周期（快照缓存与徽章数据来源）。 */
export const CATALOG_REFRESH_MS = 30_000

/** 快照同步读取的容忍年龄；超龄时后台刷新但仍返回旧值。 */
export const SNAPSHOT_STALE_MS = 5_000

/** 从 agent/request、agent/status 的 payload 里取会话 id（header.id 是权威来源）。 */
function sessionIdOf(payload: unknown): string | undefined {
  const agent = (payload as { agent?: { id?: unknown; session?: { header?: { id?: unknown } } } })?.agent
  const fromHeader = agent?.session?.header?.id
  if (typeof fromHeader === 'string' && fromHeader) return fromHeader
  return typeof agent?.id === 'string' && agent.id ? agent.id : undefined
}

export function apply(ctx: Context, initialConfig: Partial<ValueRouterConfig> = {}): void | Promise<void> {
  let currentSource: () => Partial<ValueRouterConfig> = () => initialConfig
  /** 最近一次目录分类后的配置（四档线路带 status）。提示词段需要同步读数。 */
  let classified: ResolvedValueRouterConfig = resolveConfig(initialConfig)

  const events = new RouteEventLog()

  /** 宿主白名单（读不到返回 undefined → 不做白名单拦截）。 */
  function hostAllowlist(): AllowlistEntry[] | undefined {
    return readHostAllowlist(ctx as unknown as { get(key: never): unknown })
  }

  const routing: ValueRouterRoutingService = createRoutingService({
    getConfig: () => currentSource(),
    llm: () => ctx.llm,
    readAllowlist: () => hostAllowlist(),
    events,
  })

  /**
   * 快照缓存。`snapshot()` 必须同步返回（Remote 控制器直接返回它），
   * 因此这里在配置绑定、周期刷新与按需过期时异步重建缓存。
   */
  let snapshotCache: ValueRouterStatusSnapshot = buildStatusSnapshot({
    config: resolveConfig(initialConfig),
    allowlistKnown: hostAllowlist() !== undefined,
    routedCallsTotal: 0,
    recentDispatches: [],
    recentEvents: [],
  })
  let snapshotAt = 0
  let refreshing = false

  async function refreshSnapshot(): Promise<void> {
    if (refreshing) return
    refreshing = true
    try {
      const view = await routing.catalog()
      const raw = resolveConfig(currentSource())
      classified = {
        enabled: raw.enabled,
        tiers: view.tiers.map(tier => ({ id: tier.id, lines: tier.lines })),
        fallback: view.fallback,
      }
      snapshotCache = buildStatusSnapshot({
        config: classified,
        allowlistKnown: view.allowlistKnown,
        routedCallsTotal: valueRouterState.getRoutedCalls(),
        recentDispatches: valueRouterState.recentDispatches(12).map(record => ({
          provider: record.provider,
          model: record.model,
          difficulty: record.difficulty,
          routeSource: record.routeSource,
          fallback: record.fallback,
          degraded: record.degraded,
          at: record.at,
        } satisfies SnapshotDispatch)),
        recentEvents: events.list().slice(-40).reverse(),
      })
      snapshotAt = Date.now()
    } catch (error) {
      ctx.logger?.warn?.(`value-router: 状态快照刷新失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      refreshing = false
    }
  }

  const warn = (message: string): void => {
    try { ctx.logger?.warn?.(message) } catch { /* ignore */ }
  }
  const info = (message: string): void => {
    try { ctx.logger?.info?.(message) } catch { /* ignore */ }
  }

  // —— 设置：配置编辑权归 ctx.configEditor（profile patch + Loader 热重载）——
  let settingsEntry = findOwnConfigEntry()
  const settingsSection = registerSettingsSection()
  ctx.effect(() => settingsSection ?? (() => undefined), 'value-router: settings surface')

  /** 把宿主 `settings.describe()` 的真实结果打进日志（排查"设置里没有卡片"）。 */
  function reportSettingsSurface(): void {
    const probe = (phase: string): void => {
      let line: string
      try {
        const settings = ctx.settings as { describe?: () => readonly { ns?: unknown }[] } | undefined
        const rows = settings?.describe?.()
        if (rows === undefined) {
          line = `${phase}：describe() 不可用`
        } else {
          const namespaces = rows.map(row => String(row.ns)).sort()
          const present = namespaces.includes(VALUE_ROUTER_SETTINGS_NAMESPACE)
          line = `${phase}：${namespaces.length} 个命名空间；本插件 ${present ? '**在列**' : '**不在列**'}`
        }
      } catch (error) {
        line = `${phase}：describe() 抛错：${error instanceof Error ? error.message : String(error)}`
      }
      info(`value-router: 诊断——${line}`)
      const sink = process.env.VALUE_ROUTER_DIAG_SINK
      if (sink === undefined || sink === '') return
      try {
        appendFileSync(sink, `[${new Date().toISOString()}] ${line}\n`, 'utf8')
      } catch { /* 诊断失败不影响插件 */ }
    }

    probe('apply() 同步')
    const timer = setTimeout(() => probe('+3s 稳态'), 3_000)
    ;(timer as unknown as { unref?: () => void }).unref?.()
  }

  function findOwnConfigEntry(): SettingsConfigEntry | undefined {
    try {
      const editor = ctx.get('configEditor' as never) as
        | { entries?: () => readonly SettingsConfigEntry[] }
        | undefined
      const rows = editor?.entries?.()
      if (Array.isArray(rows)) {
        const own = rows.find(row => row?.options?.id === VALUE_ROUTER_SETTINGS_NAMESPACE)
        if (own !== undefined) return own
      }
    } catch { /* configEditor 缺失/未就绪 → 回落到 loader */ }
    try {
      const loader = ctx.get('loader' as never) as { entries?: () => Iterable<SettingsConfigEntry> } | undefined
      for (const row of loader?.entries?.() ?? []) {
        if (row?.options?.id === VALUE_ROUTER_SETTINGS_NAMESPACE) return row
      }
    } catch { /* loader 不可用 → 保持 initialConfig 解析 */ }
    return undefined
  }

  /** 把 currentSource 指向 Loader 条目上的实时配置。 */
  function bindConfigFromEntry(): void {
    const entry = settingsEntry
    if (entry === undefined) return
    currentSource = () => (entry.options?.config ?? {}) as Partial<ValueRouterConfig>
    void refreshSnapshot()
  }

  /**
   * 注册设置页策略并建立「外部写入 → 重算配置」的监听。
   *
   * DSH 0.2.0-rc.2 起 `configure()` 对同一 fiber 重复注册直接抛错，
   * 且 `presentations` 强引用 fiber；因此把 configure 的 disposer 与条目轮询的 disposer
   * 合成一个交给 `ctx.effect`，卸载时两个都跑掉。
   */
  function registerSettingsSection(): (() => void) | undefined {
    try {
      const settings = ctx.settings as {
        configure?: (presentation: { auto?: boolean }, owner?: unknown) => unknown
      } | undefined
      if (settings === undefined || typeof settings.configure !== 'function') {
        warn('value-router: ctx.settings.configure 不可用；设置页降级为 Loader 条目配置。')
        return undefined
      }
      bindConfigFromEntry()
      const disposePresentation = settings.configure({ auto: true }, ctx.fiber)
      const stopWatchingEntry = buildSettingsEntryWatcher()
      info(`value-router: settings 命名空间 "${VALUE_ROUTER_SETTINGS_NAMESPACE}" 就绪`)
      reportSettingsSurface()
      return () => {
        stopWatchingEntry()
        if (typeof disposePresentation === 'function') disposePresentation()
      }
    } catch (error) {
      warn(`value-router: 设置页注册失败（${error instanceof Error ? error.message : String(error)}）；降级为 Loader 条目配置。`)
      return undefined
    }
  }

  /** 只读轮询：configEditor 没有变更事件，条目被热替换时重绑 source。 */
  function buildSettingsEntryWatcher(): () => void {
    const timer = setInterval(() => {
      const next = findOwnConfigEntry()
      if (next !== undefined && next !== settingsEntry) {
        settingsEntry = next
        bindConfigFromEntry()
      }
    }, CATALOG_REFRESH_MS)
    ;(timer as unknown as { unref?: () => void }).unref?.()
    return () => {
      clearInterval(timer)
      currentSource = () => initialConfig
      void refreshSnapshot()
    }
  }

  // —— 系统提示段（order 145）——
  // 读分类缓存而不是 await：提示段装配是同步的，目录刷新走后台周期任务。
  ctx.systemPrompt.section({
    name: VALUE_ROUTER_SECTION_NAME,
    order: VALUE_ROUTER_SECTION_ORDER,
    text: (assembly: {
      agent?: { session?: { header?: { origin?: string; id?: string; parentSession?: string } } }
    }) => {
      const header = assembly?.agent?.session?.header
      const raw = resolveConfig(currentSource())
      if (!raw.enabled) return ''
      return buildSystemPromptGuidance({ ...classified, enabled: raw.enabled }, {
        role: isSubagentSession(header) ? 'subagent' : 'controller',
      })
    },
  })

  // —— agent/request 路由：只改写子代理会话（主模型永不被接管）——
  const routedRequestAttempts = new Map<string, { timestamp: number; params: RouteParameters }>()
  const streams = new Map<string, string>()

  const requestKey = (payload: unknown): string | undefined => {
    const value = payload as { agent?: { id?: unknown; session?: { header?: { id?: unknown } } }; turn?: unknown; step?: unknown }
    const id = sessionIdOf(payload)
    if (id === undefined || !Number.isSafeInteger(value.turn) || !Number.isSafeInteger(value.step)) return undefined
    return `${id}:${value.turn}:${value.step}`
  }

  const pruneRoutedRequestAttempts = (at: number): void => {
    for (const [key, { timestamp }] of routedRequestAttempts) {
      if (at - timestamp > 10 * 60_000) routedRequestAttempts.delete(key)
    }
    while (routedRequestAttempts.size > 2_048) {
      const oldest = routedRequestAttempts.keys().next().value
      if (typeof oldest !== 'string') break
      routedRequestAttempts.delete(oldest)
    }
    for (const [stream, key] of streams) if (!routedRequestAttempts.has(key)) streams.delete(stream)
  }

  ctx.on('agent/request', async (payload, next) => {
    // lineage 先记：子会话的父会话归属供线路意图比对与派发聚合使用。
    const sessionId = sessionIdOf(payload)
    const header = payload.agent?.session?.header
    const parentSessionId = typeof header?.parentSession === 'string' ? header.parentSession : undefined
    if (sessionId !== undefined && parentSessionId !== undefined) {
      valueRouterState.trackChildSession(sessionId, parentSessionId)
    }

    const resolved = await next()

    // 线路意图快照：**必须在任何改写之前**拍下来，且只拍第一次。
    // next() 首次返回 agent options、其后返回 logged header——一旦本插件改写过，
    // 后续 step 读到的就是插件自己写的值，"主控原始意图"会被自己污染掉。
    if (sessionId !== undefined && valueRouterState.intentFor(sessionId) === undefined) {
      const intent: ChildRouteIntent = {
        provider: resolved.provider ?? '',
        model: resolved.model ?? '',
        ...(resolved.reasoningEffort ? { reasoningEffort: resolved.reasoningEffort } : {}),
        observedAt: { turn: payload.turn ?? 0, step: payload.step ?? 0 },
        parentRoute: undefined,
        source: 'first-seen',
      }
      valueRouterState.rememberIntent(sessionId, intent)
    }
    valueRouterState.pruneIntents(2_048)

    // 廉价预检：不启用 / 不是子代理 → 直接放行，不触碰目录。
    if (!resolveConfig(currentSource()).enabled) return resolved
    if (!isSubagentSession(header)) return resolved

    const parentIntent = parentSessionId !== undefined ? valueRouterState.intentFor(parentSessionId) : undefined
    const parentRouteKey = parentIntent !== undefined ? routeKey(parentIntent.provider, parentIntent.model) : undefined
    if (sessionId !== undefined) valueRouterState.attachParentRoute(sessionId, parentRouteKey)

    const rotationIndex = sessionId === undefined
      ? undefined
      : valueRouterState.rotationIndexOf(sessionId, parentSessionId)
    const intent = sessionId === undefined ? undefined : valueRouterState.intentFor(sessionId)
    const explicit = isExplicitCaptainRoute(intent, parentRouteKey)

    const resolution = await routing.resolve({
      difficulty: DEFAULT_DIFFICULTY,
      role: DEFAULT_ROLE,
      route: explicit && intent !== undefined
        ? { provider: intent.provider, model: intent.model, reasoning_effort: intent.reasoningEffort ?? '' }
        : undefined,
      routeSource: 'captain',
      ...(rotationIndex === undefined ? {} : { rotationIndex }),
    })

    if (!resolution.dispatchable) {
      ctx.logger?.debug?.(`value-router: 放行普通路由（${routeSkipText('not-dispatchable')}：${resolution.reason ?? resolution.routeStatus}）`)
      return resolved
    }
    if (resolved.provider === resolution.provider && resolved.model === resolution.model) {
      ctx.logger?.debug?.(`value-router: 放行普通路由（${routeSkipText('noop')}）`)
      return resolved
    }

    valueRouterState.recordDispatch({
      sessionId: sessionId ?? '?',
      provider: resolution.provider,
      model: resolution.model,
      ...(resolution.reasoning_effort === '' ? {} : { reasoning_effort: resolution.reasoning_effort }),
      difficulty: resolution.requestedDifficulty ?? DEFAULT_DIFFICULTY,
      routeSource: resolution.routeSource,
      fallback: resolution.fallback,
      degraded: resolution.degraded,
      at: Date.now(),
    })
    const key = requestKey(payload)
    const telemetryDifficulty = resolution.fallback ? 'fallback' : (resolution.requestedDifficulty ?? DEFAULT_DIFFICULTY)
    const params = routeParameters('subagent', telemetryDifficulty, resolution.model)
    if (key !== undefined) {
      const at = Date.now()
      pruneRoutedRequestAttempts(at)
      routedRequestAttempts.set(key, { timestamp: at, params })
    }
    emitValueRouterRuntimeTelemetry({ event: 'value_router_route', params, timestamp: new Date().toISOString() })

    // 目标模型自己拥有 reasoning effort：不继承原请求的 effort
    // （目标不支持该档位时会让整轮失败 UNSUPPORTED_REASONING_EFFORT）。
    const { reasoningEffort: _inheritedEffort, ...routed } = resolved as LlmCallConfig & { reasoningEffort?: string }
    return {
      ...routed,
      provider: resolution.provider,
      model: resolution.model,
      ...(resolution.reasoning_effort === ''
        ? {}
        : { reasoningEffort: resolution.reasoning_effort as LlmCallConfig['reasoningEffort'] }),
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

  // —— 服务 ——
  // 1) 路由服务：其他插件（Agent Teams）通过能力探测使用。
  ctx.provide(VALUE_ROUTER_SERVICE_NAME, routing)
  // 2) 状态快照：顶栏徽章 / 设置卡。
  const statusService: ValueRouterService = {
    snapshot: () => {
      if (Date.now() - snapshotAt > SNAPSHOT_STALE_MS) void refreshSnapshot()
      return snapshotCache
    },
  }
  ctx.provide('valueRouter', statusService)

  let controllerFiber: { await(): Promise<unknown> }
  try {
    controllerFiber = ctx.plugin(ValueRouterStatusController) as unknown as { await(): Promise<unknown> }
  } catch (error) {
    ctx.logger?.warn?.(`value-router: 状态通道挂载失败，GUI 状态将保持默认：${String(error)}`)
    controllerFiber = { await: async () => undefined }
  }

  // —— 启动刷新 + 周期刷新 ——
  void refreshSnapshot()
  ctx.effect(() => {
    const timer = setInterval(() => { void refreshSnapshot() }, CATALOG_REFRESH_MS)
    ;(timer as unknown as { unref?: () => void }).unref?.()
    return () => { clearInterval(timer) }
  }, 'value-router: catalog refresh')

  try {
    const snapshot = snapshotCache
    ctx.logger?.info?.(
      `value-router: apply() 完成（enabled=${snapshot.enabled}, 可用线路=${snapshot.availableLines} 条, `
      + `missing=${snapshot.missingLines}, blocked=${snapshot.blockedLines}, 白名单可读=${snapshot.allowlistKnown}）`,
    )
  } catch { /* ignore */ }

  return controllerFiber.await().then(() => undefined)
}

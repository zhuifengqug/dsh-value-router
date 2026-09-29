/**
 * 价值路由 @gjs27/dsh-value-router —— 宿主侧（Node.js）。
 *
 * 定位：DSH 会话内的成本感知 + 多模型协作层。
 * - 主模型（用户在会话里选的）永不被插件接管；
 * - 子代理：主控**没显式指定线路**时，按轮转池 `N % 池长` 分配一条线路——
 *   于是并行的子代理（以及 Agent Team 的队友）会自然落在**不同模型**上；
 * - 主控**显式指定**了线路（且指定了与父模型不同的线路）→ 放行，尊重主控；
 * - 池为空、或池中目标 provider 不可用 → 降级到「兜底线路」executor。
 *
 * 2026-09-29（0.2.0）：专属预设已摘除，插件对**全部预设**生效，scope 门控整体删除。
 *
 * 更早的退役记录（2026-09-22）：桥接通道（Chat2API 外发 + bridge_* 三工具 + 12 道门控 +
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

import {
  VALUE_ROUTER_SETTINGS_NAMESPACE,
  applyAllowlist,
  formatModelRoute,
  isCompleteModelRoute,
  resolveConfig,
  resolveEffectiveConfig,
  routableLines,
  sanitizeExecutor,
  type ResolvedValueRouterConfig,
  type SessionOverrideConfig,
  type ValueRouterConfig,
} from './core/config.ts'
import { Config } from './core/schema.ts'
import { buildSystemPromptGuidance, VALUE_ROUTER_SECTION_NAME, VALUE_ROUTER_SECTION_ORDER } from './core/policy.ts'
import { checkRouteAvailability, type ExecutorHealth } from './core/model-selection.ts'
import { decideSubagentRoute, isSubagentSession, pickTargetRoute, routeSkipText } from './core/routing.ts'
import { emitValueRouterRuntimeTelemetry, routeErrorType, routeParameters, type RouteParameters } from './core/runtime-telemetry.ts'
import { routeKey, valueRouterState, type ChildRouteIntent, type SessionMetricsSnapshot } from './core/state.ts'
import type { ValueRouterStatusSnapshot } from './core/snapshot.ts'
import { ValueRouterStatusController } from './status-controller.ts'

export const name = 'value-router'
export const inject = ['systemPrompt', 'settings', 'llm', 'configEditor']

/**
 * 本插件在 Loader 里的配置条目（只依赖用到的字段）。
 *
 * `@deepseek-ai/cordis-plugin-loader` 不在本包依赖里，用结构化类型代替 import。
 */
interface SettingsConfigEntry {
  options?: { id?: string; config?: unknown }
}

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

/** 兜底线路 provider 可用性的刷新间隔（徽章 executorStatus 的数据来源）。 */
export const EXECUTOR_HEALTH_REFRESH_MS = 30_000

/** 子会话意图/轮转槽位的内存上限（超出按 FIFO 淘汰最老的）。 */
export const CHILD_INTENT_MAX_ENTRIES = 2_048

/** 从 agent/request、agent/status 的 payload 里取会话 id（header.id 是权威来源）。 */
function sessionIdOf(payload: unknown): string | undefined {
  const agent = (payload as { agent?: { id?: unknown; session?: { header?: { id?: unknown } } } })?.agent
  const fromHeader = agent?.session?.header?.id
  if (typeof fromHeader === 'string' && fromHeader) return fromHeader
  return typeof agent?.id === 'string' && agent.id ? agent.id : undefined
}
export function apply(ctx: Context, initialConfig: Partial<ValueRouterConfig> = {}): void | Promise<void> {
  let currentConfig: ResolvedValueRouterConfig = resolveConfig(initialConfig)
  let currentSource: () => Partial<ValueRouterConfig> = () => initialConfig

  /**
   * 读宿主 `subagent-model-selection-settings` 的白名单。
   *
   * 宿主在**子代理创建前**用它校验主控显式指定的线路（`assertAllowedModelSelection`），
   * 但纯继承不校验。插件的改写发生在创建之后，宿主根本看不到——所以必须由插件自己
   * 拿同一份名单当闸门，否则主控指定一条被宿主拒绝的线路就会让工具调用失败。
   *
   * 用结构化类型而不是 import：`@deepseek-ai/dsh-tool-subagent/model-selection-settings`
   * 是子路径导出的可选服务，宿主没挂载（或老宿主没有）时读不到。此时返回 undefined，
   * applyAllowlist 会**全部放行**——宁可多派，也不静默清空用户的通道。
   * （与本文件对 configEditor / agentPresets 的既有取法一致，不新增 peerDep。）
   */
  function hostAllowlist(): { provider: string; model: string }[] | undefined {
    try {
      const service = ctx.get('subagentModelSelection' as never) as
        | { current?: () => { enabled?: unknown; allowedModels?: unknown } }
        | undefined
      const allowedModels = service?.current?.()?.allowedModels
      if (!Array.isArray(allowedModels)) return undefined
      const out: { provider: string; model: string }[] = []
      for (const item of allowedModels) {
        if (typeof item !== 'object' || item === null) continue
        const route = item as Record<string, unknown>
        if (typeof route.provider === 'string' && typeof route.model === 'string') {
          out.push({ provider: route.provider, model: route.model })
        }
      }
      return out
    } catch {
      return undefined
    }
  }

  /** 全局配置 + 宿主白名单闸门。会话覆写在此之后叠加。 */
  function resolveGated(raw: Partial<ValueRouterConfig> | undefined | null): ResolvedValueRouterConfig {
    return applyAllowlist(resolveConfig(raw), hostAllowlist())
  }

  const getConfig = (): ResolvedValueRouterConfig => resolveGated(currentSource())

  // —— 兜底线路健康缓存（同步快照用；探活间隔刷新）——
  let executorHealth: ExecutorHealth = { status: 'disabled', executorHealth: 'unconfigured' }
  const refreshExecutorHealth = async (): Promise<void> => {
    const effective = resolveGated(currentSource())
    const executor = sanitizeExecutor(effective.executor)
    executorHealth = await checkRouteAvailability(ctx.llm, executor).then((h) => ({
      status: !effective.enabled ? 'disabled' as const
        : h === 'unconfigured' ? 'unconfigured' as const
          : h === 'unavailable' ? 'degraded' as const
            : 'active' as const,
      executorHealth: h,
      ...(h === 'unconfigured' ? { reason: '兜底线路未配置完整' } : {}),
      ...(h === 'unavailable' ? { reason: '兜底线路 provider 不可用' } : {}),
    }))
  }

  /** 结构化日志（与 status-controller 一致：缺失/抛错都不影响路由）。 */
  const warn = (message: string): void => {
    try {
      ctx.logger?.warn?.(message)
    } catch { /* ignore */ }
  }
  const info = (message: string): void => {
    try {
      ctx.logger?.info?.(message)
    } catch { /* ignore */ }
  }

  // —— 设置：DSH 0.1.7-rc.2 起 installSection() 已移除 ——
  //
  // 旧版本靠 installSection(ctx, ns, Config, value, { setSource, onChange, validate })
  // 注册命名空间并拿到一个「随配置热更新」的 source。rc.2 把配置编辑权收归
  // ctx.configEditor（profile patch 文件 + Loader 热重载），SettingsForms 只负责
  // 表单（configure/describe/update/replace/mutate）：
  //   - 表单本身：宿主从 Loader runtime 读模块导出的 Config（dsh-settings 的
  //     SettingsForms.schema(entry) => entry.fiber.runtime.Config），因此这里
  //     不需要（也没有 API）再注册一次 schema；命名空间仍是 Loader 条目 id，
  //     即 VALUE_ROUTER_SETTINGS_NAMESPACE，与客户端 SettingsScope 一致。
  //   - 配置值：编辑落盘后 Loader 会重建条目、以新 config 重新调用 apply()，
  //     所以「记住本条目」再按需读回，就能在每次 apply 后拿到最新值。
  // 任何一步不可用都只降级（保留 entry config 解析 + 一条 warning），不抛错。
  let settingsEntry = findOwnConfigEntry()
  const settingsSection = registerSettingsSection()
  ctx.effect(() => settingsSection ?? (() => undefined), 'value-router: settings surface')

  /**
   * 取出本插件在 Loader 里的配置条目。
   *
   * 优先用 configEditor.entries()（带 profile patch 层），退化为遍历 loader.entries()。
   * 找不到就返回 undefined——apply() 仍然依赖传入的 initialConfig 正常工作。
   */
  function findOwnConfigEntry(): SettingsConfigEntry | undefined {
    try {
      const editor = ctx.get('configEditor' as never) as
        | { entries?: () => readonly SettingsConfigEntry[] }
        | undefined
      const rows = editor?.entries?.()
      if (Array.isArray(rows)) {
        const own = rows.find((row) => row?.options?.id === VALUE_ROUTER_SETTINGS_NAMESPACE)
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

  /**
   * 把 currentSource 指向 Loader 条目上的实时配置。
   *
   * 一次 apply 期间条目 config 不变，所以只在启动时和「条目被热替换后」重绑；
   * 绑定时同步 currentConfig 与 executor 健康，等价于旧的 onChange()。
   */
  function bindConfigFromEntry(): void {
    const entry = settingsEntry
    if (entry === undefined) return
    currentSource = () => (entry.options?.config ?? {}) as Partial<ValueRouterConfig>
    currentConfig = resolveGated(currentSource())
    void refreshExecutorHealth()
  }

  /**
   * 注册设置页策略并建立「外部写入 → 重算 currentConfig」的监听。
   *
   * SettingsForms.configure() 只声明表单策略、不接收配置回调，因此这里在
   * configure 之后按需自建监听：宿主写入（configEditor.edit → Loader 热重载）
   * 会替换条目，此时重新绑定 source 并刷新 executor 健康。
   */
  function registerSettingsSection(): (() => void) | undefined {
    try {
      const settings = ctx.settings as {
        configure?: (presentation: { auto?: boolean }, owner?: unknown) => unknown
        describe?: () => readonly { ns?: unknown }[]
      } | undefined
      if (settings === undefined || typeof settings.configure !== 'function') {
        warn('value-router: ctx.settings.configure 不可用；设置页降级为 Loader 条目配置。')
        return undefined
      }
      bindConfigFromEntry()
      // auto: true 与宿主默认一致，显式写出以声明「本条目由宿主自动生成表单」；
      // 客户端 settings.plugin.item 卡片按同一 namespace 挂载。
      settings.configure({ auto: true }, ctx.fiber)
      info(
        `value-router: settings 命名空间 "${VALUE_ROUTER_SETTINGS_NAMESPACE}" 就绪（settings.configure，条目 id 即 namespace）`,
      )
      return buildSettingsEntryWatcher()
    } catch (error) {
      warn(
        `value-router: 设置页注册失败（${error instanceof Error ? error.message : String(error)}）；降级为 Loader 条目配置。`,
      )
      return undefined
    }
  }

  /**
   * 自建「条目热替换 → 重绑 source」监听：configEditor 没有变更事件，
   * 只能只读轮询（与 executor 健康探活同样 30s 一次，不写任何文件）。
   *
   * 返回 dispose：取消轮询并回到 initialConfig，交给调用方注册进 ctx.effect。
   */
  function buildSettingsEntryWatcher(): () => void {
    const timer = setInterval(() => {
      const next = findOwnConfigEntry()
      if (next !== undefined && next !== settingsEntry) {
        settingsEntry = next
        bindConfigFromEntry()
      }
    }, EXECUTOR_HEALTH_REFRESH_MS)
    ;(timer as unknown as { unref?: () => void }).unref?.()
    return () => {
      clearInterval(timer)
      resetConfigSource()
    }
  }

  /** 取消条目绑定，回到 apply() 收到的 initialConfig。 */
  function resetConfigSource(): void {
    currentSource = () => initialConfig
    currentConfig = resolveGated(initialConfig)
    void refreshExecutorHealth()
  }

  // —— 系统提示段（order 145）：生效配置启用时注入，对全部预设生效 ——
  ctx.systemPrompt.section({
    name: VALUE_ROUTER_SECTION_NAME,
    order: VALUE_ROUTER_SECTION_ORDER,
    text: (assembly: {
      agent?: {
        session?: { header?: { origin?: string; id?: string; parentSession?: string } }
      }
    }) => {
      const header = assembly?.agent?.session?.header
      const globalConfig = currentSource()
      if (!resolveConfig(globalConfig).enabled) return ''
      const sessionId = typeof header?.id === 'string' ? header.id : undefined
      const override = sessionOverrideFor(sessionId, header?.parentSession)
      const effective = applyAllowlist(
        resolveEffectiveConfig(globalConfig, override),
        hostAllowlist(),
      )
      if (!effective.enabled) return ''
      return buildSystemPromptGuidance(effective, {
        role: isSubagentSession(header) ? 'subagent' : 'controller',
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
    // lineage 先记（与路由门是两个独立职责）：子会话的父会话归属供覆写查询、轮转计数与计量聚合。
    const sessionId = sessionIdOf(payload)
    const header = payload.agent?.session?.header
    const parentSessionId = typeof header?.parentSession === 'string' ? header.parentSession : undefined
    if (sessionId !== undefined && parentSessionId !== undefined) {
      valueRouterState.trackChildSession(sessionId, parentSessionId)
    }

    const resolved = await next()

    const globalConfig = currentSource()
    const base = applyAllowlist(resolveConfig(globalConfig), hostAllowlist())

    // 线路意图快照：**必须在任何改写之前**拍下来，且只拍第一次。
    // 官方注释（dsh-agent runtime-types.d.ts:312-314）明确 next() 首次返回
    // agent options、其后返回 logged header——一旦本插件改写过，后续 step 读到的
    // 就是插件自己写的值，"主控原始意图"会被自己污染掉。
    //
    // 主会话**也**要记：只有记下父会话（= 用户选的）线路，才能区分
    // 「子代理没指定、继承了父模型」和「主控显式指定了和父一样的模型」这组固有歧义。
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
    valueRouterState.pruneIntents(CHILD_INTENT_MAX_ENTRIES)

    // 廉价预检：不启用 / 不是子代理 / 无可轮转线路且兜底未配 → 直接放行，不触碰 llm。
    if (!base.enabled) return resolved
    if (!isSubagentSession(header)) return resolved
    if (routableLines(base.pool).length === 0 && !isCompleteModelRoute(sanitizeExecutor(base.executor))) return resolved

    // 父会话线路 = 用户为这个父会话选的线路（子代理默认继承的就是它）。
    // 父会话不在表里（插件中途加载/冷恢复）→ undefined，走 ambiguousPolicy 近似。
    const parentIntent = parentSessionId !== undefined ? valueRouterState.intentFor(parentSessionId) : undefined
    const parentRoute = parentIntent !== undefined ? routeKey(parentIntent.provider, parentIntent.model) : undefined
    if (sessionId !== undefined) valueRouterState.attachParentRoute(sessionId, parentRoute)

    // 轮转序号：子会话首次观察时分配一次，之后固定不变。
    const rotationIndex = sessionId === undefined
      ? undefined
      : valueRouterState.rotationIndexOf(sessionId, parentSessionId)

    const override = sessionOverrideFor(sessionId, parentSessionId)
    const effective = applyAllowlist(
      resolveEffectiveConfig(globalConfig, override),
      hostAllowlist(),
    )
    const executor = sanitizeExecutor(effective.executor)

    // 池中目标线路的可用性（无可轮转线路时目标就是兜底线路，只探一次）。
    const { route: target } = pickTargetRoute(effective.pool, executor, rotationIndex ?? 0)
    const targetAvailable = (await checkRouteAvailability(ctx.llm, target)) === 'ready'
    const hasRoutable = routableLines(effective.pool).length > 0
    const fallbackAvailable = hasRoutable && isCompleteModelRoute(executor)
      ? (await checkRouteAvailability(ctx.llm, executor)) === 'ready'
      : targetAvailable

    const decision = decideSubagentRoute({
      globalConfig,
      origin: header?.origin,
      ...(sessionId !== undefined ? { sessionOverride: valueRouterState.getSessionOverride(sessionId) } : {}),
      ...(parentSessionId !== undefined ? { parentOverride: valueRouterState.getSessionOverride(parentSessionId) } : {}),
      resolvedRoute: resolved,
      ...(sessionId !== undefined ? { intent: valueRouterState.intentFor(sessionId) } : {}),
      ...(rotationIndex !== undefined ? { rotationIndex } : {}),
      targetAvailable,
      fallbackAvailable,
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
        strategy: c.strategy,
        pool: c.pool.map(line => ({ ...line })),
        executor: { ...c.executor },
        executorStatus: executorHealth.status,
        ...(executorHealth.reason !== undefined ? { executorReason: executorHealth.reason } : {}),
        executorCallsTotal: valueRouterState.getGlobalMetrics().executorCalls,
        allowlistKnown: hostAllowlist() !== undefined,
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
      `value-router: apply() 完成（strategy=${currentConfig.strategy}, 池=${currentConfig.pool.length} 条, 兜底线路=${formatModelRoute(currentConfig.executor)}）`,
    )
  } catch { /* ignore */ }

  return controllerFiber.await().then(() => undefined)
}

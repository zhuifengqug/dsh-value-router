/**
 * 价值路由配置：类型、安全默认值、归一化。
 *
 * 设计约束：
 * - 缺少字段必须回落到安全默认值，旧配置缺新增字段仍可加载（逐字段独立兜底）；
 * - **永不抛错**。DSH 0.1.7-rc.2 删掉了插件可注册的 settings validate 回调
 *   （dsh-settings 的 SettingsForms 没有 validate 钩子），在这里抛错会让整个
 *   插件树加载失败。半配置一律 sanitize 成「未配置」并记 warn，不中断会话；
 * - 本模块是纯逻辑，不 import 任何运行时依赖，便于离线单测；
 * - 插件不保存任何凭据。
 *
 * 2026-09-29（0.2.0）变更：
 * - 摘除专属预设，删除 `scope` / `excludePresets` 两个字段。旧配置里的 `scope` 值
 *   会变成未知键，而 schemastery 的 object 解析在非 strict 模式下会 merge 保留未知键，
 *   因此**不需要迁移代码，也不会让插件加载失败**。保留一个默认值错误的枚举反而更危险
 *   ——旧值 'preset' 会让 scopeAllowsPreset 把所有会话判为不在范围，且无任何报错。
 * - 新增 `pool`（轮转线路池）与 `ambiguousPolicy`。
 * - `executor` 语义从「子代理执行模型（唯一目标）」改为「兜底线路」：只在轮转池为空
 *   或池中目标 provider 不可用时使用。**不能删**——宿主不提供任何默认 executor，
 *   主控未显式指定模型时子代理会继承主模型（最贵的那条），删掉等于池空时直接烧主模型。
 *
 * 更早的退役记录（2026-09-22）：桥接通道（Chat2API 外发）整体删除，配置面从
 * 30+ 字段收缩到当时的 5 个。被删除的都是桥的所有权：bridge.*、tuning.*、
 * autoDelegate、allowCodeSnippet / allowLocalFileContent /
 * requireConfirmationForCommands、defaultThinking、fallbackMode、maxDepth。
 */

export const VALUE_ROUTER_SETTINGS_NAMESPACE = 'value-router'

/** 三档策略：决定子代理派发提示文案的积极程度。 */
export type ValueRouterStrategy = 'saver' | 'balanced' | 'powerful'

/** 系统提示段角色：主控模型 / 执行子代理。 */
export type ValueRouterRole = 'controller' | 'subagent'

/** 线路档位标注。仅用于①生成提示词文案 ②UI 排序分组，**不参与路由判据**。 */
export type ValueRouterTier = 'cheap' | 'mid' | 'strong'

/**
 * 「显式指定 == 父模型」这一固有歧义的处置。
 *
 * `agent/request` 的 `next()` 只能给出「本次请求实际会用的线路」，无法区分
 * 「主控没指定，子代理继承了父模型」和「主控显式指定了和父模型一样的线路」。
 * - rotate（默认）：当作没指定，交给轮转。省 token，符合本插件的存在目的。
 * - respect：当没指定处理，保留继承。主控极少显式指定与父相同的模型，选它是为了
 *   「绝不擅自改动主控明确写下的东西」。
 */
export type AmbiguousPolicy = 'rotate' | 'respect'

/** DSH 模型路由选择。 */
export interface ModelRouteSelection {
  provider?: string
  model?: string
  reasoningEffort?: string
}

/** 归一化后的模型路由选择：三个字段都保证是字符串。 */
export interface ResolvedModelRoute {
  provider: string
  model: string
  reasoningEffort: string
}

/** 轮转池里的一条线路。`allowed` 由宿主白名单推导，不写进设置。 */
export interface PoolLine {
  provider: string
  model: string
  reasoningEffort?: string
  tier: ValueRouterTier
  /**
   * 是否在宿主 `subagent-model-selection-settings.allowedModels` 里。
   * 只有 true 的线路参与轮转——这就是「不与白名单冲突」的实现方式：
   * 白名单是唯一真源，插件不自己发明第二套授权。
   * 读不到宿主白名单时全部视为 true（宁可放行也不静默清空通道）。
   */
  allowed?: boolean
}

/** 归一化后的池内线路。 */
export interface ResolvedPoolLine {
  provider: string
  model: string
  reasoningEffort: string
  tier: ValueRouterTier
  allowed: boolean
}

/** 会话级覆写（顶栏气泡写入，不污染全局配置）。 */
export interface SessionOverrideConfig {
  enabled?: boolean
  strategy?: ValueRouterStrategy
  executor?: ModelRouteSelection
}

/** 用户层配置（字段可缺，逐字段兜底）。 */
export interface ValueRouterConfig {
  /** 总开关。 */
  enabled?: boolean
  strategy?: ValueRouterStrategy
  /** 轮转线路池，最多 POOL_MAX_LINES 条；空池 = 只做提示词，不改写任何线路。 */
  pool?: PoolLine[]
  /** 兜底线路：池为空、或池中目标 provider 不可用时使用。 */
  executor?: ModelRouteSelection
  ambiguousPolicy?: AmbiguousPolicy
}

/** 归一化后的配置：所有字段必填。 */
export interface ResolvedValueRouterConfig {
  enabled: boolean
  strategy: ValueRouterStrategy
  pool: ResolvedPoolLine[]
  executor: ResolvedModelRoute
  ambiguousPolicy: AmbiguousPolicy
}

export const DEFAULT_STRATEGY: ValueRouterStrategy = 'balanced'
export const DEFAULT_AMBIGUOUS_POLICY: AmbiguousPolicy = 'rotate'

/** 默认配置（`resolveConfig(undefined)` 的结果）。 */
export const DEFAULT_CONFIG: ResolvedValueRouterConfig = {
  enabled: true,
  strategy: DEFAULT_STRATEGY,
  pool: [],
  executor: { provider: '', model: '', reasoningEffort: '' },
  ambiguousPolicy: DEFAULT_AMBIGUOUS_POLICY,
}

// —————————————————————————— 归一化辅助 ——————————————————————————

function bool(v: unknown, dflt: boolean): boolean {
  return typeof v === 'boolean' ? v : dflt
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], dflt: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : dflt
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** 线路的 'provider/model' 归一化键——白名单比对与歧义判定共用同一口径。 */
export function routeKey(provider: string, model: string): string {
  return `${provider}/${model}`
}

/** 归一化模型路由选择：全部为 trim 后的字符串，缺省空串。 */
export function resolveModelRoute(v: unknown): ResolvedModelRoute {
  const raw = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>
  return {
    provider: str(raw.provider),
    model: str(raw.model),
    reasoningEffort: str(raw.reasoningEffort),
  }
}

/**
 * 归一化轮转池。**不设条数上限**——用户的现实是订阅分散在多家 provider，
 * 同一个模型可以在多家各放一条，用轮转把额度摊开；硬上限反而挡了 legitimate 用法。
 *
 * 逐项校验：单项非法只丢这一项，不整池丢弃——编辑到一半的半成品不应该让其余线路全废。
 * `allowed` 默认 true；真正的白名单闸门在 resolvePoolEligibility() 里做。
 */
export function resolvePool(v: unknown): ResolvedPoolLine[] {
  if (!Array.isArray(v)) return []
  const out: ResolvedPoolLine[] = []
  for (const item of v) {
    if (typeof item !== 'object' || item === null) continue
    const raw = item as Record<string, unknown>
    const provider = str(raw.provider)
    const model = str(raw.model)
    if (provider === '' || model === '') continue
    out.push({
      provider,
      model,
      reasoningEffort: str(raw.reasoningEffort),
      tier: oneOf(raw.tier, ['cheap', 'mid', 'strong'] as const, 'mid'),
      allowed: raw.allowed === false ? false : true,
    })
  }
  return out
}

/**
 * 用宿主白名单给池子打闸：不在 `allowedModels` 里的线路 `allowed=false`。
 *
 * 白名单是唯一真源——插件不自己发明第二套授权。主控在提示词里看不到被挡的线路，
 * 就不会去指定它们；轮转也不会派到它们。两条冲突路径一起堵死。
 *
 * @param config 已归一化的配置
 * @param allowlist 宿主白名单；`undefined` 表示**读不到**（服务未挂载 / 旧宿主），
 *   此时全部放行——宁可多派，也不把用户的通道静默清空。
 */
export function applyAllowlist(
  config: ResolvedValueRouterConfig,
  allowlist: readonly { provider: string; model: string }[] | undefined,
): ResolvedValueRouterConfig {
  const pool = config.pool.map(line => {
    if (allowlist === undefined) return line.allowed ? line : { ...line, allowed: true }
    const permitted = allowlist.some(route => routeKey(route.provider, route.model) === routeKey(line.provider, line.model))
    return { ...line, allowed: permitted }
  })
  return { ...config, pool }
}

/** 池里真正可参与轮转的线路。 */
export function routableLines(pool: readonly ResolvedPoolLine[]): ResolvedPoolLine[] {
  return pool.filter(line => line.allowed)
}

/**
 * 把任意（可能缺字段 / 来自旧版本）的配置归一化为完整、安全的配置。
 * 每个字段独立兜底，因此新增字段不会让旧配置加载失败。
 *
 * 注意：`raw` 必传（可为 undefined），默认配置请用 `resolveConfig(undefined)`。
 */
export function resolveConfig(raw: Partial<ValueRouterConfig> | undefined | null): ResolvedValueRouterConfig {
  const c = raw ?? {}
  return {
    enabled: bool(c.enabled, DEFAULT_CONFIG.enabled),
    strategy: oneOf(c.strategy, ['saver', 'balanced', 'powerful'] as const, DEFAULT_STRATEGY),
    pool: resolvePool(c.pool),
    executor: resolveModelRoute(c.executor),
    ambiguousPolicy: oneOf(c.ambiguousPolicy, ['rotate', 'respect'] as const, DEFAULT_AMBIGUOUS_POLICY),
  }
}

// —————————————————————————— 路由/会话辅助 ——————————————————————————

/** 模型路由是否完整（provider + model 都非空）。 */
export function isCompleteModelRoute(
  route?: ModelRouteSelection,
): route is ModelRouteSelection & { provider: string; model: string } {
  return (
    typeof route?.provider === 'string' &&
    route.provider.trim().length > 0 &&
    typeof route?.model === 'string' &&
    route.model.trim().length > 0
  )
}

/**
 * 半配置的 executor（只填了 provider 或只填了 model）归一化为「未配置」。
 *
 * 旧版本试图用 `assertConfigValid` 在设置写入时拒绝半配置，但那个函数在 0.1.0 里
 * **根本没有调用点**（死导入），所以线上一直存在半配置的可能。0.2.0 把处理下沉到
 * 读路径：半配置 = 兜底线路不可用 = 退化成「不改写」，而不是抛错让插件树加载失败。
 */
export function sanitizeExecutor(route: ResolvedModelRoute): ResolvedModelRoute {
  if (route.provider === '' && route.model === '') return route
  if (route.provider === '' || route.model === '') {
    return { provider: '', model: '', reasoningEffort: '' }
  }
  return route
}

/** 人读的模型标签，用于系统提示段。 */
export function formatModelRoute(route?: ModelRouteSelection): string {
  if (!isCompleteModelRoute(route)) return '（未配置）'
  return `${route.provider}/${route.model}`
}

/**
 * 合并全局配置与会话级覆写（覆写只覆盖显式给出的字段）。
 *
 * 注意：会话级覆写**不覆盖 pool 与 ambiguousPolicy**——轮转序号是按父会话累计的，
 * 临时改池会让同一父会话下的前后子代理跳线路，破坏「同一会话生命周期内线路不变」
 * 这条不变量。气泡只允许临时关掉通道或改档位/兜底线路。
 */
export function resolveSessionConfig(
  globalConfig: Partial<ValueRouterConfig> = {},
  override?: SessionOverrideConfig,
): Partial<ValueRouterConfig> {
  if (!override) return globalConfig
  return {
    ...globalConfig,
    ...(override.enabled !== undefined ? { enabled: override.enabled } : {}),
    ...(override.strategy !== undefined ? { strategy: override.strategy } : {}),
    ...(override.executor !== undefined ? { executor: override.executor } : {}),
  }
}

/** 归一化「全局配置 ⊕ 会话覆写」后的生效配置。 */
export function resolveEffectiveConfig(
  globalConfig: Partial<ValueRouterConfig> | undefined | null,
  override?: SessionOverrideConfig,
): ResolvedValueRouterConfig {
  return resolveConfig(resolveSessionConfig(globalConfig ?? {}, override))
}

/** 策略人读名（系统提示段与 UI 共用）。 */
export function strategyLabel(strategy: ValueRouterStrategy): string {
  return strategy === 'saver' ? '更省' : strategy === 'powerful' ? '更强' : '平衡'
}

/** 档位人读名。 */
export function tierLabel(tier: ValueRouterTier): string {
  return tier === 'cheap' ? '省' : tier === 'strong' ? '强' : '中'
}

/**
 * 把任意输入（来自浏览器 Remote 的 JSON）归一化为受支持的会话覆写：
 * 丢弃未知键与非法值；null / 空对象 → undefined（= 清除覆写）。
 */
export function normalizeSessionOverride(raw: unknown): SessionOverrideConfig | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const value = raw as Record<string, unknown>
  const out: SessionOverrideConfig = {}
  if (typeof value.enabled === 'boolean') out.enabled = value.enabled
  if (value.strategy === 'saver' || value.strategy === 'balanced' || value.strategy === 'powerful') {
    out.strategy = value.strategy
  }
  if (typeof value.executor === 'object' && value.executor !== null) {
    const route = value.executor as Record<string, unknown>
    const executor: ModelRouteSelection = {}
    if (typeof route.provider === 'string') executor.provider = route.provider.trim()
    if (typeof route.model === 'string') executor.model = route.model.trim()
    if (typeof route.reasoningEffort === 'string') executor.reasoningEffort = route.reasoningEffort.trim()
    out.executor = executor
  }
  return Object.keys(out).length > 0 ? out : undefined
}

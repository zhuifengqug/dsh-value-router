/**
 * 价值路由配置：类型、安全默认值、归一化。
 *
 * 设计约束：
 * - 缺少字段必须回落到安全默认值，旧配置缺新增字段仍可加载（逐字段独立兜底）；
 * - 本模块是纯逻辑，不 import 任何运行时依赖，便于离线单测；
 * - 插件不保存任何凭据。
 *
 * 退役记录（2026-09-22）：桥接通道（Chat2API 外发）整体删除，配置面随之从
 * 30+ 字段收缩到 5 个。被删除的都是**桥的所有权**：bridge.*、tuning.*、
 * autoDelegate、任务类型白名单、allowCodeSnippet / allowLocalFileContent /
 * requireConfirmationForCommands、defaultThinking、fallbackMode、maxDepth。
 * 保留的字段同时服务两条通道中的幸存者（子代理路由）：
 * scope / excludePresets 是生效范围，strategy 驱动派发提示文案，executor 是路由目标。
 *
 * 注意：历史 settings.yaml 里可能残留 `value-router.bridge` 块。schemastery 的
 * object 解析对未知键不报错（非 schema 键不参与迭代，strict 与否只决定是否透传），
 * 因此旧配置不会让插件加载失败——不需要手工清理设置文件。
 */

export const VALUE_ROUTER_SETTINGS_NAMESPACE = 'value-router'

/** 专属预设 id（scope = preset 时唯一生效的预设）。 */
export const VALUE_ROUTER_PRESET_ID = 'value-router'

/** 生效范围：专属预设内 / 全局所有预设（可用 excludePresets 排除）。 */
export type ValueRouterScope = 'preset' | 'global'

/** 三档策略：决定子代理派发提示文案的积极程度。 */
export type ValueRouterStrategy = 'saver' | 'balanced' | 'powerful'

/** 系统提示段角色：主控模型 / 执行子代理。 */
export type ValueRouterRole = 'controller' | 'subagent'

/** DSH 模型路由选择（executor 目标）。 */
export interface ModelRouteSelection {
  provider?: string
  model?: string
  reasoningEffort?: string
}

/** 归一化后的模型路由选择：三个字段都保证是字符串（resolveModelRoute 的产物）。 */
export interface ResolvedModelRoute {
  provider: string
  model: string
  reasoningEffort: string
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
  scope?: ValueRouterScope
  /** 仅 global 模式生效的排除清单。 */
  excludePresets?: string[]
  strategy?: ValueRouterStrategy
  /** 子代理路由目标（DSH provider 模型）。 */
  executor?: ModelRouteSelection
}

/** 归一化后的配置：所有字段必填，策略推导已完成。 */
export interface ResolvedValueRouterConfig {
  enabled: boolean
  scope: ValueRouterScope
  excludePresets: string[]
  strategy: ValueRouterStrategy
  executor: ResolvedModelRoute
}

export const DEFAULT_STRATEGY: ValueRouterStrategy = 'balanced'
export const DEFAULT_SCOPE: ValueRouterScope = 'preset'

/** 默认配置（`resolveConfig(undefined)` 的结果）。 */
export const DEFAULT_CONFIG: ResolvedValueRouterConfig = {
  enabled: true,
  scope: DEFAULT_SCOPE,
  excludePresets: [],
  strategy: DEFAULT_STRATEGY,
  executor: { provider: '', model: '', reasoningEffort: '' },
}

// —————————————————————————— 归一化辅助 ——————————————————————————

function bool(v: unknown, dflt: boolean): boolean {
  return typeof v === 'boolean' ? v : dflt
}

/** 允许显式清空的字符串清单（excludePresets：空数组就是「不排除任何预设」）。 */
function strListAllowEmpty(v: unknown, dflt: string[]): string[] {
  if (!Array.isArray(v)) return [...dflt]
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], dflt: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : dflt
}

/** 归一化模型路由选择：全部为 trim 后的字符串，缺省空串。 */
export function resolveModelRoute(v: unknown): ResolvedModelRoute {
  const raw = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>
  return {
    provider: typeof raw.provider === 'string' ? raw.provider.trim() : '',
    model: typeof raw.model === 'string' ? raw.model.trim() : '',
    reasoningEffort: typeof raw.reasoningEffort === 'string' ? raw.reasoningEffort.trim() : '',
  }
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
    scope: oneOf(c.scope, ['preset', 'global'] as const, DEFAULT_SCOPE),
    excludePresets: strListAllowEmpty(c.excludePresets, DEFAULT_CONFIG.excludePresets),
    strategy: oneOf(c.strategy, ['saver', 'balanced', 'powerful'] as const, DEFAULT_STRATEGY),
    executor: resolveModelRoute(c.executor),
  }
}

// —————————————————————————— 路由/会话辅助 ——————————————————————————

/** executor 路由是否完整（provider + model 都非空）。 */
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

/** 人读的模型标签，用于系统提示段。 */
export function formatModelRoute(route?: ModelRouteSelection): string {
  if (!isCompleteModelRoute(route)) return '（未配置）'
  return `${route.provider}/${route.model}`
}

/**
 * 合并全局配置与会话级覆写（覆写只覆盖显式给出的字段）。
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

/**
 * 生效范围门控：
 * - preset：只有 agentPreset === 'value-router' 的会话生效；
 * - global：除 excludePresets 之外的预设全部生效（未选择预设的会话也生效）。
 */
export function scopeAllowsPreset(config: ResolvedValueRouterConfig, agentPreset?: string): boolean {
  if (config.scope === 'preset') return agentPreset === VALUE_ROUTER_PRESET_ID
  if (typeof agentPreset === 'string' && config.excludePresets.includes(agentPreset)) return false
  return true
}

/** 策略人读名（系统提示段与 UI 共用）。 */
export function strategyLabel(strategy: ValueRouterStrategy): string {
  return strategy === 'saver' ? '更省' : strategy === 'powerful' ? '更强' : '平衡'
}

/**
 * 设置校验：拒绝「半配置」的 executor（只填了 provider 或只填了 model）。
 *
 * 完全为空是**合法**状态，表示尚未选择执行模型：子代理通道自动关闭
 * （routing.ts 的 `executor-incomplete`），插件照常加载，用户可在首次引导或
 * 设置卡里补全。因此这里不能要求 executor 必须完整——settings 的 validate 会在
 * 注册命名空间时就被调用一次，抛错会让整个插件树加载失败（实测踩过）。
 */
export function assertConfigValid(raw: Partial<ValueRouterConfig> | undefined | null): void {
  const resolved = resolveConfig(raw)
  if (!resolved.enabled) return
  const provider = resolved.executor.provider.trim()
  const model = resolved.executor.model.trim()
  if ((provider === '') !== (model === '')) {
    throw new Error('子代理执行模型（executor）需要同时选择 provider 与 model，或两者都留空')
  }
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

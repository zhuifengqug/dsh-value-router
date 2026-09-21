/**
 * 价值路由配置：类型、策略 → 参数映射、安全默认值、归一化。
 *
 * 设计约束（沿用两个来源插件的实战结论）：
 * - 缺少字段必须回落到安全默认值，旧配置缺新增字段仍可加载（逐字段独立兜底）；
 * - 任何字段都不保存凭据；bridge.apiKey 只从设置/环境变量进入，永不回显、不入日志；
 * - 本模块是纯逻辑，不 import 任何运行时依赖，便于离线单测。
 *
 * 与来源插件的差异：
 * - 删除 expert（主控）配置与健康检查——主模型由用户在预设/会话里选择，插件永不接管；
 * - 新增 scope（preset | global）、excludePresets；
 * - tuning 显式字段可覆盖「策略推导值」。
 */

export const VALUE_ROUTER_SETTINGS_NAMESPACE = 'value-router'

/** 专属预设 id（scope = preset 时唯一生效的预设）。 */
export const VALUE_ROUTER_PRESET_ID = 'value-router'

/** 生效范围：专属预设内 / 全局所有预设（可用 excludePresets 排除）。 */
export type ValueRouterScope = 'preset' | 'global'

/** 三档策略：同时决定子代理派发提示文案与桥门控参数。 */
export type ValueRouterStrategy = 'saver' | 'balanced' | 'powerful'

/** 系统提示段角色：主控模型 / 执行子代理。 */
export type ValueRouterRole = 'controller' | 'subagent'

export type FallbackMode = 'continue-with-primary' | 'skip-delegation' | 'ask-user'
export type ThinkingMode = 'off' | 'on' | 'silent'
export type RiskLevel = 'low' | 'medium' | 'high'
/** 外部答案的置信度（压缩与来源标记用）。 */
export type Confidence = 'low' | 'medium' | 'high'

/**
 * 桥接模型映射：不同模式路由到不同模型。
 *
 * 值可以是桥 `/v1/models` 暴露的任意 id（不限 DeepSeek 系）。
 * 空字符串表示「该能力不可用」——`thinking`/`thinkingSearch` 为空时回落到
 * `plain`/`search`；`plain` 为空视为配置错误（桥没有可用模型，不猜测）。
 */
export interface BridgeModelMap {
  plain: string
  thinking: string
  thinkingSearch: string
  search: string
}

/** Chat2API 桥接配置。 */
export interface BridgeConfig {
  enabled: boolean
  /** Chat2API 地址，默认 'http://127.0.0.1:8080/v1'。 */
  baseUrl: string
  /** API Key（机密，永不回显）；环境变量兜底在 src/index.ts 处理。 */
  apiKey: string
  modelMap: BridgeModelMap
  /** 额外请求头，仅保留 string→string 项。 */
  extraHeaders: Record<string, string>
  /**
   * thinking !== 'off' 时并入请求体的额外参数。
   * 缺省 {} = 不做额外开关（各家约定不同，按目标模型实测填）。
   */
  thinkingBody: Record<string, unknown>
  /** webSearch === true 时并入请求体的额外参数。缺省 {}。 */
  searchBody: Record<string, unknown>
  /** 思考内容字段名，默认 'reasoning_content'。 */
  reasoningField: string
  /**
   * 是否信任桥返回的 usage。
   *
   * 背景：本机定制版 Chat2API 实测**完全不输出 usage**（要么真实三元组、要么没有该字段），
   * 所以默认路径是字符估算 + `estimateOnly=true`（如实标注，不冒充真实计量）。
   *
   * - 'auto'（默认）：按请求规模校验 usage，明显不符（占位值/异常值）时回落估算并标 estimateOnly。
   * - 'always'：无条件采信桥返回的 usage（仅当桥确实给出真实值时才值得用）。
   * - 'never'：一律按估算记账。
   */
  trustUsage: 'auto' | 'always' | 'never'
  /** 请求超时（毫秒），默认 180000。 */
  timeoutMs: number
  /** 健康探测缓存（毫秒），默认 30000。 */
  healthCacheTtlMs: number
  /** 并发数，默认 1（网页版同账号单路输出，账号安全）。 */
  concurrency: number
  /** 批次最大条目数，默认 10。 */
  maxBatchItems: number
}

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

/** 显式调参：存在时覆盖「策略推导值」。 */
export interface ValueRouterTuning {
  minEstimatedSavedTokens?: number
  maxDelegationsPerTask?: number
  maxDelegationsPerHour?: number
  maxConcurrentDelegations?: number
  maxRetriesPerRequest?: number
  requestTimeoutMs?: number
  maxInputCharacters?: number
  maxResultCharacters?: number
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
  /** 固定护栏（默认 1，不随档位变化）。 */
  maxDepth?: number
  /** 桥自动委派（false 时仅手动调用工具）。 */
  autoDelegate?: boolean
  allowedTaskTypes?: string[]
  blockedTaskTypes?: string[]
  allowCodeSnippet?: boolean
  allowLocalFileContent?: boolean
  requireConfirmationForCommands?: boolean
  defaultThinking?: ThinkingMode
  fallbackMode?: FallbackMode
  /** 显式覆盖策略推导值。 */
  tuning?: ValueRouterTuning
  bridge?: Partial<BridgeConfig>
}

/** 归一化后的配置：所有字段必填，策略推导 + tuning 覆盖已完成。 */
export interface ResolvedValueRouterConfig {
  enabled: boolean
  scope: ValueRouterScope
  excludePresets: string[]
  strategy: ValueRouterStrategy
  executor: ResolvedModelRoute
  maxDepth: number
  autoDelegate: boolean
  allowedTaskTypes: string[]
  blockedTaskTypes: string[]
  allowCodeSnippet: boolean
  allowLocalFileContent: boolean
  requireConfirmationForCommands: boolean
  defaultThinking: ThinkingMode
  fallbackMode: FallbackMode
  minEstimatedSavedTokens: number
  maxDelegationsPerTask: number
  maxDelegationsPerHour: number
  maxConcurrentDelegations: number
  maxRetriesPerRequest: number
  requestTimeoutMs: number
  maxInputCharacters: number
  maxResultCharacters: number
  bridge: BridgeConfig
}

/** 默认允许委派给桥的独立、低风险任务类型。 */
export const DEFAULT_ALLOWED_TASK_TYPES = [
  'general-knowledge',
  'explanation',
  'simple-comparison',
  'text-transformation',
  'regex-generation',
  'api-usage-example',
  'copy-polish',
]

/** 默认禁止自动委派的任务类型。 */
export const DEFAULT_BLOCKED_TASK_TYPES = [
  'local-file-operation',
  'code-modification',
  'command-execution',
  'credential-related',
  'destructive-operation',
  'database-access',
  'multi-step-planning',
  'final-decision',
]

export const DEFAULT_STRATEGY: ValueRouterStrategy = 'balanced'
export const DEFAULT_SCOPE: ValueRouterScope = 'preset'
export const DEFAULT_MAX_DEPTH = 1

/**
 * 策略 → 桥门控参数（规格 §3.4）。
 * 只影响「桥外发」的准入与额度；executor 路由的开关不随档位变化。
 */
export const STRATEGY_TUNING: Record<ValueRouterStrategy, {
  minEstimatedSavedTokens: number
  maxDelegationsPerTask: number
  maxDelegationsPerHour: number
}> = {
  saver: { minEstimatedSavedTokens: 300, maxDelegationsPerTask: 6, maxDelegationsPerHour: 20 },
  balanced: { minEstimatedSavedTokens: 200, maxDelegationsPerTask: 10, maxDelegationsPerHour: 30 },
  powerful: { minEstimatedSavedTokens: 100, maxDelegationsPerTask: 16, maxDelegationsPerHour: 48 },
}

/**
 * 与档位无关的固定护栏：
 * - maxConcurrentDelegations / bridge.concurrency 恒为 1（网页版同账号单路输出，账号安全）；
 * - 其余为全局默认，可被 tuning 显式覆盖。
 */
export const DEFAULT_TUNING: Required<ValueRouterTuning> = {
  minEstimatedSavedTokens: STRATEGY_TUNING[DEFAULT_STRATEGY].minEstimatedSavedTokens,
  maxDelegationsPerTask: STRATEGY_TUNING[DEFAULT_STRATEGY].maxDelegationsPerTask,
  maxDelegationsPerHour: STRATEGY_TUNING[DEFAULT_STRATEGY].maxDelegationsPerHour,
  maxConcurrentDelegations: 1,
  maxRetriesPerRequest: 1,
  requestTimeoutMs: 180000,
  maxInputCharacters: 8000,
  maxResultCharacters: 16000,
}

/** 桥接模型映射默认值（本机定制版 Chat2API `/v1/models` 的 DeepSeek 系约定）。 */
export const DEFAULT_MODEL_MAP: BridgeModelMap = {
  plain: 'deepseek-v4.1-flash',
  thinking: 'deepseek-v4.1-flash-think',
  thinkingSearch: 'deepseek-v4.1-flash-think-search',
  search: 'deepseek-v4.1-flash-search',
}

/** 桥接配置安全默认值。 */
export const DEFAULT_BRIDGE_CONFIG: BridgeConfig = {
  enabled: true,
  baseUrl: 'http://127.0.0.1:8080/v1',
  apiKey: '',
  modelMap: { ...DEFAULT_MODEL_MAP },
  extraHeaders: {},
  thinkingBody: {},
  searchBody: {},
  reasoningField: 'reasoning_content',
  trustUsage: 'auto',
  timeoutMs: DEFAULT_TUNING.requestTimeoutMs,
  healthCacheTtlMs: 30000,
  concurrency: DEFAULT_TUNING.maxConcurrentDelegations,
  maxBatchItems: 10,
}

/** 默认配置（`resolveConfig(undefined)` 的结果）。 */
export const DEFAULT_CONFIG: ResolvedValueRouterConfig = {
  enabled: true,
  scope: DEFAULT_SCOPE,
  excludePresets: [],
  strategy: DEFAULT_STRATEGY,
  executor: { provider: '', model: '', reasoningEffort: '' },
  maxDepth: DEFAULT_MAX_DEPTH,
  autoDelegate: true,
  allowedTaskTypes: [...DEFAULT_ALLOWED_TASK_TYPES],
  blockedTaskTypes: [...DEFAULT_BLOCKED_TASK_TYPES],
  allowCodeSnippet: false,
  allowLocalFileContent: false,
  requireConfirmationForCommands: true,
  defaultThinking: 'silent',
  fallbackMode: 'continue-with-primary',
  ...DEFAULT_TUNING,
  bridge: { ...DEFAULT_BRIDGE_CONFIG },
}

// —————————————————————————— 归一化辅助 ——————————————————————————

function bool(v: unknown, dflt: boolean): boolean {
  return typeof v === 'boolean' ? v : dflt
}
function int(v: unknown, dflt: number, min: number, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : dflt
  return Math.min(max, Math.max(min, n))
}
function str(v: unknown, dflt: string): string {
  return typeof v === 'string' && v.length > 0 ? v : dflt
}
function strList(v: unknown, dflt: string[]): string[] {
  if (!Array.isArray(v)) return [...dflt]
  const cleaned = v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
  return cleaned.length > 0 ? cleaned : [...dflt]
}
/** 允许显式清空的字符串清单（excludePresets：空数组就是「不排除任何预设」）。 */
function strListAllowEmpty(v: unknown, dflt: string[]): string[] {
  if (!Array.isArray(v)) return [...dflt]
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
}
function oneOf<T extends string>(v: unknown, allowed: readonly T[], dflt: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : dflt
}
/** 把 extraHeaders 归一化为纯 string→string，丢弃非字符串值。 */
function strRecord(v: unknown, dflt: Record<string, string>): Record<string, string> {
  if (typeof v !== 'object' || v === null) return { ...dflt }
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string') out[k] = val
  }
  return out
}
/** 归一化任意对象记录（thinkingBody/searchBody）：非对象一律回落到空对象。 */
function objRecord(v: unknown): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return {}
  return { ...(v as Record<string, unknown>) }
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

/** 归一化 bridge.modelMap：每个键独立兜底到 DEFAULT_MODEL_MAP。 */
function resolveModelMap(v: unknown): BridgeModelMap {
  const raw = (typeof v === 'object' && v !== null) ? v as Record<string, unknown> : {}
  return {
    plain: str(raw.plain, DEFAULT_MODEL_MAP.plain),
    thinking: str(raw.thinking, DEFAULT_MODEL_MAP.thinking),
    thinkingSearch: str(raw.thinkingSearch, DEFAULT_MODEL_MAP.thinkingSearch),
    search: str(raw.search, DEFAULT_MODEL_MAP.search),
  }
}

/** 把任意（可能缺字段 / 来自旧版本）的桥接配置归一化为完整、安全的配置。 */
export function resolveBridgeConfig(raw: Partial<BridgeConfig> | undefined): BridgeConfig {
  const b = raw ?? {}
  return {
    enabled: bool(b.enabled, DEFAULT_BRIDGE_CONFIG.enabled),
    baseUrl: str(b.baseUrl, DEFAULT_BRIDGE_CONFIG.baseUrl),
    apiKey: typeof b.apiKey === 'string' ? b.apiKey : '',
    modelMap: resolveModelMap(b.modelMap),
    extraHeaders: strRecord(b.extraHeaders, DEFAULT_BRIDGE_CONFIG.extraHeaders),
    thinkingBody: objRecord(b.thinkingBody),
    searchBody: objRecord(b.searchBody),
    reasoningField: str(b.reasoningField, DEFAULT_BRIDGE_CONFIG.reasoningField),
    trustUsage: oneOf(b.trustUsage, ['auto', 'always', 'never'] as const, DEFAULT_BRIDGE_CONFIG.trustUsage),
    timeoutMs: int(b.timeoutMs, DEFAULT_BRIDGE_CONFIG.timeoutMs, 5000, 600000),
    healthCacheTtlMs: int(b.healthCacheTtlMs, DEFAULT_BRIDGE_CONFIG.healthCacheTtlMs, 1000, 300000),
    // 账号安全：并发固定 1，设置里的值被夹到 1（不允许同账号多路输出）。
    concurrency: 1,
    maxBatchItems: int(b.maxBatchItems, DEFAULT_BRIDGE_CONFIG.maxBatchItems, 1, 50),
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
  const strategy = oneOf(c.strategy, ['saver', 'balanced', 'powerful'] as const, DEFAULT_STRATEGY)
  const derived = STRATEGY_TUNING[strategy]
  const tuning = (typeof c.tuning === 'object' && c.tuning !== null ? c.tuning : {}) as ValueRouterTuning

  return {
    enabled: bool(c.enabled, DEFAULT_CONFIG.enabled),
    scope: oneOf(c.scope, ['preset', 'global'] as const, DEFAULT_SCOPE),
    excludePresets: strListAllowEmpty(c.excludePresets, DEFAULT_CONFIG.excludePresets),
    strategy,
    executor: resolveModelRoute(c.executor),
    maxDepth: int(c.maxDepth, DEFAULT_MAX_DEPTH, 1, 1),
    autoDelegate: bool(c.autoDelegate, DEFAULT_CONFIG.autoDelegate),
    allowedTaskTypes: strList(c.allowedTaskTypes, DEFAULT_CONFIG.allowedTaskTypes),
    blockedTaskTypes: strList(c.blockedTaskTypes, DEFAULT_CONFIG.blockedTaskTypes),
    allowCodeSnippet: bool(c.allowCodeSnippet, DEFAULT_CONFIG.allowCodeSnippet),
    allowLocalFileContent: bool(c.allowLocalFileContent, DEFAULT_CONFIG.allowLocalFileContent),
    requireConfirmationForCommands: bool(c.requireConfirmationForCommands, DEFAULT_CONFIG.requireConfirmationForCommands),
    defaultThinking: oneOf(c.defaultThinking, ['off', 'on', 'silent'] as const, DEFAULT_CONFIG.defaultThinking),
    fallbackMode: oneOf(c.fallbackMode, ['continue-with-primary', 'skip-delegation', 'ask-user'] as const, DEFAULT_CONFIG.fallbackMode),
    // 策略推导值 → tuning 显式覆盖
    minEstimatedSavedTokens: int(tuning.minEstimatedSavedTokens, derived.minEstimatedSavedTokens, 0, 1_000_000),
    maxDelegationsPerTask: int(tuning.maxDelegationsPerTask, derived.maxDelegationsPerTask, 0, 1000),
    maxDelegationsPerHour: int(tuning.maxDelegationsPerHour, derived.maxDelegationsPerHour, 1, 10000),
    // 账号安全：并发固定 1
    maxConcurrentDelegations: 1,
    maxRetriesPerRequest: int(tuning.maxRetriesPerRequest, DEFAULT_TUNING.maxRetriesPerRequest, 0, 3),
    requestTimeoutMs: int(tuning.requestTimeoutMs, DEFAULT_TUNING.requestTimeoutMs, 5000, 600000),
    maxInputCharacters: int(tuning.maxInputCharacters, DEFAULT_TUNING.maxInputCharacters, 500, 200000),
    maxResultCharacters: int(tuning.maxResultCharacters, DEFAULT_TUNING.maxResultCharacters, 500, 200000),
    bridge: resolveBridgeConfig(c.bridge),
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

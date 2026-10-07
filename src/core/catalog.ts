/**
 * 宿主模型目录 → 线路可用性判定。
 *
 * ## 目录规则（唯一真源）
 *
 * 1. 宿主 LLM 目录是 provider/model 的**唯一真源**：本插件不维护第二份模型清单，
 *    也不根据名字猜能力（不猜 context、不猜 reasoning_effort）。
 * 2. 新模型默认**未分档**：目录里出现但没被用户配进任何档位的模型不参与派发。
 *    分档是显式配置行为，不是自动发现行为。
 * 3. 已分档但从目录消失的模型：**保留配置**并把线路标记 `missing`，不自动派发、不静默删除。
 * 4. **不读 API Key**：本模块只消费 `listProviders()` / `listModels()` 的公开元数据。
 * 5. **不猜测未知 reasoning_effort**：模型未声明 efforts 时判定为 `unknown`，
 *    既不拒绝也不改写用户填的值（拒绝会把可用线路误杀，改写就是猜测）。
 * 6. 全局 fallback **不是轮转池成员**：它只经 `core/route.ts` 的最后一步使用，本模块只判可用性。
 *
 * 纯逻辑：目录以 `CatalogSnapshot` 值对象注入，本模块不直接接触 ctx.llm。
 */

import {
  type ResolvedLine,
  type ResolvedValueRouterConfig,
  type LineStatus,
  lineKey,
  routeKey,
} from './config.ts'

/** 目录里一个模型的可公开元数据。 */
export interface CatalogModel {
  id: string
  name?: string
  /** 适配器声明的推理等级 id 列表；`undefined` = 未声明（不得猜测）。 */
  efforts?: string[]
  /** 适配器声明的默认推理等级。 */
  defaultEffort?: string
}

/** 目录里一个 provider。 */
export interface CatalogProvider {
  id: string
  name?: string
  /** 该 provider 声明的模型；空数组 = 适配器不声明目录（无法证伪）。 */
  models: CatalogModel[]
  /** 目录读取是否成功；读取失败时为 false，此时 `models` 不可作为否定证据。 */
  catalogKnown: boolean
}

/** 宿主白名单条目。 */
export interface AllowlistEntry {
  provider: string
  model: string
}

/** 一次目录快照。 */
export interface CatalogSnapshot {
  providers: CatalogProvider[]
  /**
   * 宿主 `subagentModelSelection.allowedModels`。
   * `undefined` = **读不到**（服务未挂载 / 旧宿主），此时不做白名单拦截——
   * 宁可放行让宿主自己拒绝，也不静默清空用户的通道。
   */
  allowlist: readonly AllowlistEntry[] | undefined
  /** 采样时间（epoch ms）。 */
  at: number
}

/** 空目录（LLM 运行时未就绪时的安全值）。 */
export const EMPTY_CATALOG: CatalogSnapshot = Object.freeze({
  providers: [],
  allowlist: undefined,
  at: 0,
})

/** 目录里是否有这个 provider。 */
export function findProvider(catalog: CatalogSnapshot, provider: string): CatalogProvider | undefined {
  return catalog.providers.find(item => item.id === provider)
}

/** 目录里是否有这条精确线路的模型条目。 */
export function findModel(catalog: CatalogSnapshot, provider: string, model: string): CatalogModel | undefined {
  return findProvider(catalog, provider)?.models.find(item => item.id === model)
}

/** 三元判定：`yes` 在目录中，`no` 明确不在，`unknown` 目录读不到/不声明（不能作为否定证据）。 */
export type Ternary = 'yes' | 'no' | 'unknown'

/**
 * provider/model 是否在宿主目录中。
 *
 * 只有「provider 存在、目录非空、且没有这个 model」才算 `no`。其余一律 `unknown`：
 * 适配器完全可以合法地不声明目录，把"没声明"当成"不存在"会误杀可用线路。
 */
export function catalogHasRoute(catalog: CatalogSnapshot, provider: string, model: string): Ternary {
  const entry = findProvider(catalog, provider)
  if (entry === undefined) return catalog.providers.length === 0 ? 'unknown' : 'no'
  if (!entry.catalogKnown) return 'unknown'
  if (entry.models.length === 0) return 'unknown'
  return entry.models.some(item => item.id === model) ? 'yes' : 'no'
}

/**
 * reasoning_effort 是否被该模型支持。
 *
 * 空 effort（= 用模型默认）永远算支持。模型未声明 efforts 时返回 `unknown`——
 * **不猜测**，交由调用方按"不拒绝也不改写"处理。
 */
export function effortSupport(
  catalog: CatalogSnapshot,
  provider: string,
  model: string,
  reasoningEffort: string,
): Ternary {
  if (reasoningEffort === '') return 'yes'
  const entry = findModel(catalog, provider, model)
  if (entry?.efforts === undefined || entry.efforts.length === 0) return 'unknown'
  return entry.efforts.includes(reasoningEffort) ? 'yes' : 'no'
}

/** 白名单判定：`true` = 被挡住。读不到白名单时永远不挡。 */
export function isAllowlistBlocked(
  catalog: CatalogSnapshot,
  provider: string,
  model: string,
): boolean {
  const allowlist = catalog.allowlist
  if (allowlist === undefined) return false
  const key = routeKey(provider, model)
  return !allowlist.some(entry => routeKey(entry.provider, entry.model) === key)
}

/**
 * 判定一条线路的可用性。
 *
 * 优先级：白名单拦截 > 目录缺失 > 可用。白名单排第一是因为宿主会在**子代理创建前**
 * 用它校验并直接拒绝，被挡的线路无论目录如何都派不出去。
 */
export function classifyLine(line: {
  provider: string
  model: string
  reasoning_effort: string
}, catalog: CatalogSnapshot): { status: LineStatus; statusDetail?: string } {
  if (isAllowlistBlocked(catalog, line.provider, line.model)) {
    return { status: 'blocked', statusDetail: '不在宿主白名单内' }
  }
  const presence = catalogHasRoute(catalog, line.provider, line.model)
  if (presence === 'no') {
    const provider = findProvider(catalog, line.provider)
    return {
      status: 'missing',
      statusDetail: provider === undefined
        ? `provider "${line.provider}" 未注册`
        : `模型 "${line.model}" 不在 provider "${line.provider}" 的目录中`,
    }
  }
  const effort = effortSupport(catalog, line.provider, line.model, line.reasoning_effort)
  if (effort === 'no') {
    return {
      status: 'missing',
      statusDetail: `模型 "${line.model}" 不支持 reasoning_effort "${line.reasoning_effort}"`,
    }
  }
  if (effort === 'unknown' && line.reasoning_effort !== '') {
    return { status: 'available', statusDetail: 'reasoning_effort 未被模型声明，按原值保留未做校验' }
  }
  return { status: 'available' }
}

/** 给整份配置的每条线路（含 fallback）打可用性标记。 */
export function classifyConfig(
  config: ResolvedValueRouterConfig,
  catalog: CatalogSnapshot,
): ResolvedValueRouterConfig {
  const apply = (line: ResolvedLine): ResolvedLine => {
    if (line.provider === '' || line.model === '') return line
    const verdict = classifyLine(line, catalog)
    return { ...line, ...verdict }
  }
  return {
    ...config,
    tiers: config.tiers.map(tier => ({ ...tier, lines: tier.lines.map(apply) })),
    fallback: apply(config.fallback),
  }
}

/** 可派发的线路（目录可见且未被白名单挡住）。 */
export function availableLines(lines: readonly ResolvedLine[]): ResolvedLine[] {
  return lines.filter(line => line.status === 'available')
}

/** 配置里出现但目录中已消失的线路（审计与 UI 用）。 */
export function missingLines(config: ResolvedValueRouterConfig): ResolvedLine[] {
  const out: ResolvedLine[] = []
  for (const tier of config.tiers) {
    for (const line of tier.lines) if (line.status === 'missing') out.push(line)
  }
  if (config.fallback.status === 'missing' && config.fallback.model !== '') out.push(config.fallback)
  return out
}

/** 去重后的线路身份，用于日志。 */
export function describeLine(line: Pick<ResolvedLine, 'provider' | 'model' | 'reasoning_effort'>): string {
  const effort = line.reasoning_effort === '' ? '' : ` (${line.reasoning_effort})`
  return `${routeKey(line.provider, line.model)}${effort}`
}

/** 完整键（含 effort）——成员复用与去重共用。 */
export { lineKey }

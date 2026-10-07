/**
 * 宿主 LLM 目录 → `CatalogSnapshot`。这是本插件与宿主之间的**唯一**模型信息通道。
 *
 * ## 纪律
 *
 * - 只读公开元数据：`listProviders()` / `listModels()` / `resolveModelInfo()`。
 *   **不读 API Key**，不读凭据配置，不猜端点。
 * - 目录读不到（LLM 运行时未就绪 / provider 不存在）时返回**空目录**而不是抛错；
 *   空目录在 `core/catalog.ts` 里被解释为「无法证伪」——不误杀线路。
 * - `reasoning_effort` 能力**只为配置里真正出现的线路**查询（可能触发适配器的异步查找，
 *   全量枚举代价不可接受）。查不到就保持「未声明」，不做任何猜测。
 */

import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { AllowlistEntry, CatalogModel, CatalogProvider, CatalogSnapshot } from './catalog.ts'
import type { RouteLine } from './config.ts'

/** 宿主白名单服务（可选子路径服务，用结构化类型读取以避免新增 peerDep）。 */
interface HostModelSelectionService {
  current?: () => { enabled?: unknown; allowedModels?: unknown } | undefined
}

/**
 * 读宿主 `subagentModelSelection.allowedModels`。
 *
 * 宿主在**子代理创建前**用它校验主控显式指定的线路，但纯继承不校验。插件的改写发生在
 * 创建之后，宿主看不到——所以必须由插件拿同一份名单当闸门。
 *
 * @returns `undefined` = **读不到**（服务未挂载 / 旧宿主）→ 不做白名单拦截。
 */
export function readHostAllowlist(ctx: { get(key: never): unknown }): AllowlistEntry[] | undefined {
  try {
    const service = ctx.get('subagentModelSelection' as never) as HostModelSelectionService | undefined
    const allowed = service?.current?.()?.allowedModels
    if (!Array.isArray(allowed)) return undefined
    const out: AllowlistEntry[] = []
    for (const item of allowed) {
      if (typeof item !== 'object' || item === null) continue
      const entry = item as Record<string, unknown>
      if (typeof entry.provider === 'string' && typeof entry.model === 'string') {
        out.push({ provider: entry.provider, model: entry.model })
      }
    }
    return out
  } catch {
    return undefined
  }
}

/** 枚举 provider 及其目录。单个 provider 失败只影响它自己。 */
export async function buildCatalog(
  llm: LlmRuntime | undefined,
  allowlist: readonly AllowlistEntry[] | undefined,
): Promise<CatalogSnapshot> {
  if (llm === undefined) return { providers: [], allowlist, at: Date.now() }
  let providers: CatalogProvider[]
  try {
    providers = llm.listProviders().map(item => ({ id: item.id, name: item.name, models: [], catalogKnown: false }))
  } catch {
    return { providers: [], allowlist, at: Date.now() }
  }
  const settled = await Promise.all(providers.map(async (provider): Promise<CatalogProvider> => {
    try {
      const models = await llm.listModels(provider.id)
      return {
        ...provider,
        catalogKnown: true,
        models: models.map(model => ({ id: model.id, name: model.name })),
      }
    } catch {
      // 目录读取失败：保留 provider，标记目录不可信（不作为否定证据）。
      return { ...provider, catalogKnown: false, models: [] }
    }
  }))
  return { providers: settled, allowlist, at: Date.now() }
}

/**
 * 为配置里出现过的精确线路补齐 `reasoning_effort` 能力声明。
 *
 * 只查去重后的 (provider, model) 对，且只在目录里已经有该模型时才查——
 * 目录里没有的线路已经判定为 `missing`，再查一次没有意义。
 */
export async function enrichEfforts(
  llm: LlmRuntime | undefined,
  catalog: CatalogSnapshot,
  lines: readonly RouteLine[],
): Promise<CatalogSnapshot> {
  if (llm === undefined) return catalog
  const targets = new Map<string, { provider: string; model: string }>()
  for (const line of lines) {
    if (line.provider === '' || line.model === '') continue
    const provider = catalog.providers.find(item => item.id === line.provider)
    if (provider === undefined || !provider.catalogKnown) continue
    if (provider.models.length > 0 && !provider.models.some(model => model.id === line.model)) continue
    targets.set(`${line.provider}\u0000${line.model}`, { provider: line.provider, model: line.model })
  }
  if (targets.size === 0) return catalog

  const resolved = new Map<string, CatalogModel | undefined>()
  await Promise.all([...targets.entries()].map(async ([key, target]) => {
    try {
      const info = await llm.resolveModelInfo(target.provider, target.model)
      const efforts = info.reasoning?.efforts?.map(effort => String(effort.id)) ?? []
      resolved.set(key, {
        id: info.id,
        name: info.name,
        ...(efforts.length > 0 ? { efforts } : {}),
        ...(info.reasoning?.defaultEffort === undefined ? {} : { defaultEffort: String(info.reasoning.defaultEffort) }),
      })
    } catch {
      // 精确型号查询失败：保持"未声明"，不猜测。
      resolved.set(key, undefined)
    }
  }))

  const providers = catalog.providers.map((provider) => {
    const models = provider.models.map((model) => {
      const extra = resolved.get(`${provider.id}\u0000${model.id}`)
      return extra === undefined ? model : { ...model, ...extra }
    })
    // 目录为空但精确查询成功：把该型号补进目录，让它成为可见线路。
    const extras: CatalogModel[] = []
    for (const [key, value] of resolved) {
      if (value === undefined) continue
      const [providerId, modelId] = key.split('\u0000')
      if (providerId !== provider.id || modelId === undefined) continue
      if (models.some(model => model.id === modelId)) continue
      extras.push(value)
    }
    return { ...provider, models: [...models, ...extras] }
  })
  return { ...catalog, providers }
}

/**
 * 价值路由配置：四档模型池 + 单一全局 fallback。
 *
 * ## 契约（0.10.0 起）
 *
 * - 档位固定四档：`low` / `medium` / `high` / `max`，顺序即成本顺序。
 * - 每档是一个线路列表 `lines`，每条线路三个字段：`provider` / `model` / `reasoning_effort`。
 * - 同一个 provider/model 可以跨档各配一条（哪怕只差 reasoning_effort），档位归属由用户显式配置决定。
 * - `fallback` 是**单一**全局兜底线路，**不是任何档位的轮转成员**：只有四档全部无可用线路时才用。
 *
 * ## 已退役（0.10.0，无迁移、无双读）
 *
 * `pool`（扁平池）、旧的动态 `tiers`（`{id,label,pool}`）、`executor`、`strategy`、
 * `ambiguousPolicy`、`tierRouting`、`migrateLegacyPool` 全部删除。旧配置里残留的这些键
 * 会被当成未知键丢弃，**不再产生任何路由效果**——不做兼容读取，也不做迁移。
 *
 * ## 本模块的纪律
 *
 * 纯逻辑：不 import 任何运行时依赖（不碰 ctx、不碰 fs），便于离线单测。
 * 归一化**永不抛错**：半配置一律 sanitize 成「未配置」，由路由引擎判定为不可用。
 */

export const VALUE_ROUTER_SETTINGS_NAMESPACE = 'value-router'

/** 四档难度/成本档位，顺序即成本从低到高。 */
export const DIFFICULTIES = ['low', 'medium', 'high', 'max'] as const

export type Difficulty = (typeof DIFFICULTIES)[number]

/** 合法难度判定（唯一真源）。 */
export function isDifficulty(value: unknown): value is Difficulty {
  return typeof value === 'string' && (DIFFICULTIES as readonly string[]).includes(value)
}

/** 缺省难度：普通 subagent 没有任务描述时用它（不在 agent/request 层猜难度）。 */
export const DEFAULT_DIFFICULTY: Difficulty = 'medium'

/** 缺省角色。 */
export const DEFAULT_ROLE = 'general'

/**
 * 一条线路：provider + model + reasoning_effort。
 *
 * 字段名用 `reasoning_effort`（snake_case）而不是宿主的 `reasoningEffort`：
 * 配置、服务返回值、任务路由字段三处共用同一份字面量契约，避免在跨插件边界反复改名。
 * 与宿主 `LlmCallConfig.reasoningEffort` 的桥接只发生在 `core/model-selection.ts` 一处。
 */
export interface RouteLine {
  provider: string
  model: string
  reasoning_effort: string
}

/** 归一化后的线路：字段保证是 trim 过的字符串。 */
export interface ResolvedLine extends RouteLine {
  /** 目录/白名单判定结果，由 `core/catalog.ts` 写入。 */
  status: LineStatus
  /** 判定依据的人读说明（缺失原因），便于审计与 UI 展示。 */
  statusDetail?: string
}

/**
 * 线路可用性。
 *
 * - `available`：目录中可见（或目录为空无法证伪）且未被宿主白名单挡住。
 * - `missing`：曾经分档、但已从宿主模型目录消失——**保留配置并标记**，不自动派发。
 * - `blocked`：被宿主白名单挡住，派发会被宿主拒绝。
 */
export type LineStatus = 'available' | 'missing' | 'blocked'

/** 一个档位的配置。 */
export interface TierConfig {
  lines: RouteLine[]
}

/** 四档配置的定长映射。 */
export type TiersConfig = Record<Difficulty, TierConfig>

/** 用户层配置（字段可缺，逐字段兜底）。 */
export interface ValueRouterConfig {
  /** 总开关。 */
  enabled?: boolean
  /** 四档线路池。缺档 = 空档。 */
  tiers?: Partial<Record<Difficulty, Partial<TierConfig> | undefined>>
  /** 单一全局兜底线路。 */
  fallback?: Partial<RouteLine>
}

/** 归一化后的档位。 */
export interface ResolvedTier {
  id: Difficulty
  lines: ResolvedLine[]
}

/** 归一化后的配置：所有字段必填，四档齐备。 */
export interface ResolvedValueRouterConfig {
  enabled: boolean
  tiers: ResolvedTier[]
  fallback: ResolvedLine
}

/** 空线路（未配置）。 */
export const EMPTY_LINE: ResolvedLine = Object.freeze({
  provider: '',
  model: '',
  reasoning_effort: '',
  status: 'missing' as LineStatus,
})

export const DEFAULT_CONFIG: ResolvedValueRouterConfig = {
  enabled: true,
  tiers: DIFFICULTIES.map(id => ({ id, lines: [] })),
  fallback: { ...EMPTY_LINE },
}

// —————————————————————————— 归一化 ——————————————————————————

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** 线路是否完整（provider 与 model 都非空）。`reasoning_effort` 允许为空 = 用模型默认。 */
export function isCompleteLine(line: Partial<RouteLine> | undefined | null): boolean {
  return str(line?.provider) !== '' && str(line?.model) !== ''
}

/** 线路的 `provider/model` 归一化键。 */
export function routeKey(provider: string, model: string): string {
  return `${provider}/${model}`
}

/** 线路的完整归一化键：三段都参与，用于成员复用与同档去重。 */
export function lineKey(line: Partial<RouteLine> | undefined | null): string {
  return `${str(line?.provider)}/${str(line?.model)}#${str(line?.reasoning_effort)}`
}

/** 归一化一条线路；不完整则返回 undefined（调用方丢弃这一条）。 */
export function resolveLine(raw: unknown): ResolvedLine | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const input = raw as Record<string, unknown>
  const provider = str(input.provider)
  const model = str(input.model)
  if (provider === '' || model === '') return undefined
  return {
    provider,
    model,
    // 空串 = 不指定，交给目标模型自身默认；不猜测、不补默认值。
    reasoning_effort: str(input.reasoning_effort),
    status: 'available',
  }
}

/**
 * 归一化四档。
 *
 * **同档内按完整键去重**：同一档里重复的 (provider, model, reasoning_effort) 只会占一个轮转槽位。
 * 跨档不去重——同一个 provider/model 出现在不同档是明确支持的配置方式。
 */
export function resolveTiers(raw: Partial<ValueRouterConfig> | undefined | null): ResolvedTier[] {
  const tiers = raw?.tiers
  return DIFFICULTIES.map((id) => {
    const section = tiers?.[id]
    const items = Array.isArray(section?.lines) ? section.lines : []
    const seen = new Set<string>()
    const lines: ResolvedLine[] = []
    for (const item of items) {
      const line = resolveLine(item)
      if (line === undefined) continue
      const key = lineKey(line)
      if (seen.has(key)) continue
      seen.add(key)
      lines.push(line)
    }
    return { id, lines }
  })
}

/** 归一化兜底线路。半配置（只填 provider 或只填 model）归一化为「未配置」。 */
export function resolveFallback(raw: Partial<ValueRouterConfig> | undefined | null): ResolvedLine {
  const fallback = resolveLine(raw?.fallback)
  return fallback ?? { ...EMPTY_LINE }
}

/**
 * 把任意（可能缺字段 / 来自旧版本）的配置归一化为完整、安全的配置。
 *
 * **不做旧键迁移**：`pool`、`executor`、`strategy`、`ambiguousPolicy`、`tierRouting` 一律忽略。
 */
export function resolveConfig(raw: Partial<ValueRouterConfig> | undefined | null): ResolvedValueRouterConfig {
  const config = raw ?? {}
  return {
    enabled: typeof config.enabled === 'boolean' ? config.enabled : DEFAULT_CONFIG.enabled,
    tiers: resolveTiers(config),
    fallback: resolveFallback(config),
  }
}

/** 找一档。 */
export function tierOf(tiers: readonly ResolvedTier[], id: Difficulty): ResolvedTier {
  return tiers.find(tier => tier.id === id) ?? { id, lines: [] }
}

/** 从某档开始向下（成本更低）的档位序列，含自身。`low` 只含自身。 */
export function degradationChain(from: Difficulty): Difficulty[] {
  const index = DIFFICULTIES.indexOf(from)
  if (index <= 0) return [from]
  return DIFFICULTIES.slice(0, index + 1).reverse()
}

/** 人读档位名。 */
export function tierLabel(id: Difficulty): string {
  switch (id) {
    case 'low': return '低'
    case 'medium': return '中'
    case 'high': return '高'
    case 'max': return '最高'
  }
}

/** 配置里是否一条线路都没配（含 fallback）。 */
export function isEmptyConfig(config: ResolvedValueRouterConfig): boolean {
  return config.tiers.every(tier => tier.lines.length === 0) && !isCompleteLine(config.fallback)
}

/**
 * Cordis 服务 `valueRouterRouting` —— 本插件对外的**唯一**路由 API。
 *
 * 设计目标：让别的插件（尤其 Agent Teams）**不必知道本插件的配置形状**，
 * 只通过能力探测调用它：
 *
 * ```ts
 * const router = ctx.get('valueRouterRouting')
 * if (router !== undefined) { const r = await router.resolve({ difficulty, role, route, routeSource }) }
 * ```
 *
 * 服务缺席时调用方必须保持原有行为——本模块不提供任何"降级替身"。
 *
 * ## 契约
 *
 * | 方法 | 语义 |
 * | --- | --- |
 * | `catalog()` | 宿主模型目录 + 四档分档结果（含 missing / blocked 标记）。异步。 |
 * | `validate(intent)` | 纯校验：难度、角色、显式线路。非法值走 `errors`，不静默回落。 |
 * | `resolve(input)` | 完整路由链，返回最终三元组 + 来源 + 状态 + 降级/兜底 + 审计。 |
 * | `record(event)` | 追加一条运行事件（派发/复用/排队/兜底/降级/线路被拒）。 |
 *
 * **绝不抛错**：`resolve` 内部任何失败都退化成一个 `routeStatus: 'pending'` 的结果，
 * 让调用方安全地不派发，而不是把异常炸进别人的调度流程。
 */

import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import {
  classifyLine,
  type AllowlistEntry,
  type CatalogProvider,
  type CatalogSnapshot,
} from './core/catalog.ts'
import { resolveConfig, type ResolvedValueRouterConfig, type ValueRouterConfig } from './core/config.ts'
import { RouteEventLog, type RouteEvent, type RecordedRouteEvent } from './core/audit.ts'
import { buildCatalog, enrichEfforts } from './core/model-selection.ts'
import { validateRouteIntent, type RouteIntent, type RouteValidation } from './core/intent.ts'
import { resolveRoute, type RouteResolution } from './core/route.ts'
import type { SnapshotLine, SnapshotTier } from './core/snapshot.ts'

/** 服务在 Cordis 里的键名（调用方用 `ctx.get(...)` 探测）。 */
export const VALUE_ROUTER_SERVICE_NAME = 'valueRouterRouting'

/** `catalog()` 的返回：宿主目录 + 分档结果。全部是 detached、JSON 安全的普通对象。 */
export interface ValueRouterCatalogView {
  /** 宿主 LLM 目录。`catalogKnown=false` 表示该 provider 的目录读不到（不能作为否定证据）。 */
  providers: {
    id: string
    name?: string
    catalogKnown: boolean
    models: { id: string; name?: string; efforts?: string[]; defaultEffort?: string }[]
  }[]
  /** 四档分档结果，含每条线路的可用性标记。 */
  tiers: SnapshotTier[]
  /** 单一全局兜底线路。 */
  fallback: SnapshotLine
  /** 宿主 `subagentModelSelection` 白名单是否可读。false = 读不到 → 不做白名单拦截。 */
  allowlistKnown: boolean
  /** 目录快照时间（epoch ms）。 */
  at: number
}

/** `resolve()` 的输入。 */
export interface ValueRouterResolveInput {
  /** 任务难度。缺省 `medium`；非法值 → `blocked`。 */
  difficulty?: unknown
  /** 任务角色（自由文本）。缺省 `general`。 */
  role?: unknown
  /** 可选显式线路。 */
  route?: RouteIntent | null
  /** 显式线路来源：`user`（用户硬指定）/ `captain`（主模型偏好）。 */
  routeSource?: 'user' | 'captain'
  /** 档内轮转序号（调用方按自己的派发计数给出，保证同一任务稳定）。 */
  rotationIndex?: number
  /** 审计归属。 */
  teamId?: string
  taskId?: string
}

/** 服务接口。 */
export interface ValueRouterRoutingService {
  catalog(): Promise<ValueRouterCatalogView>
  validate(intent: { difficulty?: unknown; role?: unknown; route?: RouteIntent | null }): RouteValidation
  resolve(input?: ValueRouterResolveInput): Promise<RouteResolution>
  record(event: RouteEvent): void
  /** 只读事件流（面板用）。 */
  events(): RecordedRouteEvent[]
}

/** 目录缓存的默认存活时间：避免每次 resolve 都打一遍 listModels。 */
export const CATALOG_TTL_MS = 5_000

export interface RoutingServiceDeps {
  /** 当前生效配置（含 loader / 设置页的最新值）。 */
  getConfig: () => Partial<ValueRouterConfig>
  /** 宿主 LLM 运行时；未就绪时为 undefined。 */
  llm: () => LlmRuntime | undefined
  /** 宿主白名单读取；读不到返回 undefined。 */
  readAllowlist: () => readonly AllowlistEntry[] | undefined
  /** 事件日志（共享实例，便于快照读取）。 */
  events?: RouteEventLog
  /** 时钟注入（测试用）。 */
  now?: () => number
}

/** 配置里出现过的全部线路（含 fallback），用于按需补齐 reasoning effort 能力。 */
function configuredLines(config: ResolvedValueRouterConfig) {
  return [
    ...config.tiers.flatMap(tier => tier.lines),
    ...(config.fallback.model === '' ? [] : [config.fallback]),
  ]
}

function detachCatalog(catalog: CatalogSnapshot): ValueRouterCatalogView['providers'] {
  return catalog.providers.map((provider: CatalogProvider) => ({
    id: provider.id,
    ...(provider.name === undefined ? {} : { name: provider.name }),
    catalogKnown: provider.catalogKnown,
    models: provider.models.map(model => ({
      id: model.id,
      ...(model.name === undefined ? {} : { name: model.name }),
      ...(model.efforts === undefined ? {} : { efforts: [...model.efforts] }),
      ...(model.defaultEffort === undefined ? {} : { defaultEffort: model.defaultEffort }),
    })),
  }))
}

function toSnapshotLine(line: {
  provider: string
  model: string
  reasoning_effort: string
  status: SnapshotLine['status']
  statusDetail?: string
}): SnapshotLine {
  return {
    provider: line.provider,
    model: line.model,
    reasoning_effort: line.reasoning_effort,
    status: line.status,
    ...(line.statusDetail === undefined ? {} : { statusDetail: line.statusDetail }),
  }
}

/**
 * 组装服务实现。
 *
 * 目录缓存按 TTL 生效；构建期间的并发调用共享同一次构建（in-flight 去重），
 * 避免 N 个任务同时进来把 `listModels` 打 N 遍。
 */
export function createRoutingService(deps: RoutingServiceDeps): ValueRouterRoutingService {
  const events = deps.events ?? new RouteEventLog()
  const now = deps.now ?? (() => Date.now())
  let cached: { at: number; catalog: CatalogSnapshot } | undefined
  let inFlight: Promise<CatalogSnapshot> | undefined

  /** 归一化 + 目录分类后的配置。 */
  async function classifiedConfig(): Promise<{ config: ResolvedValueRouterConfig; catalog: CatalogSnapshot }> {
    const config = resolveConfig(deps.getConfig())
    const catalog = await catalogSnapshot(config)
    return {
      config: {
        ...config,
        tiers: config.tiers.map(tier => ({
          ...tier,
          lines: tier.lines.map(line => ({ ...line, ...(line.model === '' ? {} : classifyLine(line, catalog)) })),
        })),
        fallback: { ...config.fallback, ...(config.fallback.model === '' ? {} : classifyLine(config.fallback, catalog)) },
      },
      catalog,
    }
  }

  async function catalogSnapshot(config: ResolvedValueRouterConfig): Promise<CatalogSnapshot> {
    const at = now()
    if (cached !== undefined && at - cached.at < CATALOG_TTL_MS) return cached.catalog
    if (inFlight !== undefined) return inFlight
    inFlight = (async () => {
      const llm = deps.llm()
      const base = await buildCatalog(llm, deps.readAllowlist())
      const enriched = await enrichEfforts(llm, base, configuredLines(config))
      cached = { at: now(), catalog: enriched }
      return enriched
    })().finally(() => { inFlight = undefined })
    return inFlight
  }

  return {
    async catalog(): Promise<ValueRouterCatalogView> {
      const { config, catalog } = await classifiedConfig()
      return {
        providers: detachCatalog(catalog),
        tiers: config.tiers.map(tier => ({
          id: tier.id,
          lines: tier.lines.map(toSnapshotLine),
        })),
        fallback: toSnapshotLine(config.fallback),
        allowlistKnown: catalog.allowlist !== undefined,
        at: catalog.at,
      }
    },

    validate(intent) {
      return validateRouteIntent(intent)
    },

    async resolve(input: ValueRouterResolveInput = {}): Promise<RouteResolution> {
      let catalog: CatalogSnapshot
      try {
        // 目录（含 TTL 缓存）必须先就绪：resolveRoute 会用它对每条候选线路做可用性判定。
        catalog = (await classifiedConfig()).catalog
      } catch (error) {
        // 目录不可用不能让调用方炸掉：退化成"无人可派"，任务保持待定。
        const detail = `目录不可用：${error instanceof Error ? error.message : String(error)}`
        return {
          provider: '', model: '', reasoning_effort: '',
          routeSource: 'none',
          routeStatus: 'pending',
          fallback: false,
          degraded: false,
          dispatchable: false,
          errors: [],
          reason: 'catalog-unavailable',
          audit: [{ at: now(), step: 'pending', outcome: 'pending', detail }],
        }
      }

      const resolution = resolveRoute({
        config: deps.getConfig(),
        catalog,
        difficulty: input.difficulty,
        role: input.role,
        route: input.route,
        ...(input.routeSource === undefined ? {} : { routeSource: input.routeSource }),
        ...(input.rotationIndex === undefined ? {} : { rotationIndex: input.rotationIndex }),
        now: now(),
      })

      // 自动落审计：调用方不必记得为每条决策单独调用 record()。
      events.record({
        type: resolution.dispatchable
          ? resolution.fallback ? 'fallback' : resolution.degraded ? 'degrade' : 'dispatch'
          : resolution.routeStatus === 'blocked' ? 'blocked'
            : resolution.routeSource === 'user' ? 'user-route-pending' : 'queue',
        at: now(),
        ...(input.teamId === undefined ? {} : { teamId: input.teamId }),
        ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
        ...(resolution.requestedDifficulty === undefined ? {} : { difficulty: resolution.requestedDifficulty }),
        ...(resolution.normalizedRole === undefined ? {} : { role: resolution.normalizedRole }),
        route: { provider: resolution.provider, model: resolution.model, reasoning_effort: resolution.reasoning_effort },
        routeSource: resolution.routeSource,
        routeStatus: resolution.routeStatus,
        detail: resolution.audit.at(-1)?.detail ?? '',
        ...(resolution.dispatchable ? {} : { queueReason: resolution.reason ?? resolution.routeStatus }),
      })

      return resolution
    },

    record(event: RouteEvent): void {
      events.record(event)
    },

    events(): RecordedRouteEvent[] {
      return events.list()
    },
  }
}

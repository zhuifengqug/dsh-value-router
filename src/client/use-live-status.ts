/**
 * 宿主侧 `valueRouterStatus` Remote 通道（浏览器侧读取层）。
 *
 * 两个方法与 src/typert.ts 的 invocations 一一对应（声明顺序 = 线上顺序）；
 * descriptor 的 typeSymbol 必须与宿主声明**逐字一致** —— DSH 的 api-gateway 只在
 * dsh-typert-loader 注册了 strict typeSymbol 之后才能调度该 Remote 服务。
 * 客户端这里的 schema 只是本地透传编解码（真正的 Zod 校验在宿主侧）。
 *
 * 0.10.0 删除：`setSessionOverride` 与「本会话覆写」读取（所依赖的
 * strategy/executor 契约已退役）；`status` 的行形状也从池（pool/strategy/executor）
 * 收敛为四档线路 + 单一兜底线路。
 *
 * 通道不可用（旧宿主 / 尚未挂载）时保持 undefined，不抛错、不影响开关与设置。
 */

import { useEffect, useRef, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { DEFAULT_DIFFICULTY, isDifficulty, type Difficulty } from '../core/config.ts'

const REMOTE_PACKAGE = '@gjs27/dsh-value-router'
const REMOTE_TYPES = `${REMOTE_PACKAGE}/types`
const REMOTE_SERVICE = 'valueRouterStatus'

/**
 * 只读状态快照的浏览器侧视图（src/core/snapshot.ts 的线上形状镜像）。
 *
 * tsconfig.client.json 只收录 src/client/** 与 src/core/**，这里保留一份结构性
 * 镜像，避免客户端工程越过自己的文件边界。
 */

/** 线路可用性，与宿主 `lineStatusSchema` 一致。 */
export type ValueRouterLineStatus = 'available' | 'missing' | 'blocked'

/** 线路来源，与宿主 `routeSourceSchema` 一致。 */
export type ValueRouterRouteSource = 'user' | 'captain' | 'difficulty' | 'fallback' | 'none'

/** 线路的排队/解析状态，与宿主 `routeStatusSchema` 一致。 */
export type ValueRouterRouteStatus = 'resolved' | 'pending' | 'blocked'

/** 一条已配置线路（字段名与配置契约一致：`reasoning_effort` 是 snake_case）。 */
export interface ValueRouterLineView {
  provider: string
  model: string
  reasoning_effort: string
  status: ValueRouterLineStatus
  statusDetail?: string
}

/** 一个难度档位；顺序固定 low → medium → high → max。 */
export interface ValueRouterTierView {
  id: Difficulty
  lines: ValueRouterLineView[]
}

/** 一条实际派发记录的浏览器侧镜像。 */
export interface ValueRouterDispatchView {
  provider: string
  model: string
  difficulty: Difficulty
  routeSource: ValueRouterRouteSource
  /** 这一条是否走了全局兜底线路。 */
  fallback: boolean
  /** 是否降级到更低档命中。 */
  degraded: boolean
  at: number
}

/** 一条运行事件的浏览器侧镜像（字段可缺，逐项兜底）。 */
export interface ValueRouterRouteEventView {
  type: string
  at: number
  teamId?: string
  taskId?: string
  member?: string
  sessionId?: string
  difficulty?: string
  role?: string
  route?: { provider: string; model: string; reasoning_effort?: string }
  routeSource?: ValueRouterRouteSource
  routeStatus?: ValueRouterRouteStatus
  detail?: string
  queueReason?: string
}

export interface ValueRouterStatusView {
  enabled: boolean
  tiers: ValueRouterTierView[]
  fallback: ValueRouterLineView
  availableLines: number
  missingLines: number
  blockedLines: number
  allowlistKnown: boolean
  routedCallsTotal: number
  recentDispatches: ValueRouterDispatchView[]
  recentEvents: ValueRouterRouteEventView[]
}

/** 会话计量线上形状（src/status-controller.ts 的 SessionMetricsWire 镜像）。 */
export interface ValueRouterSessionMetrics {
  routedCalls: number
  /** 本会话（含后代子代理）的实际派发记录。 */
  recentDispatches: ValueRouterDispatchView[]
}

/** 只有宿主的 `status` / `sessionMetrics` 两个方法存在（0.10.0 删除了会话覆写写入）。 */
export interface ValueRouterRemoteFace {
  status(input: Record<string, unknown>): Promise<unknown>
  sessionMetrics(input: { sessionId?: string }): Promise<unknown>
}

// —— descriptor（id 与 typeSymbol 与宿主 src/typert.ts 对齐） ——

/**
 * 客户端贡献的 strict codec 形状。
 *
 * **必须是 `create` 工厂，不能是 `schema` 对象**——宿主的 `requireStrictCodec`
 * （dsh-typert-loader/lib/index.js:206-211）检查的是 `typeof codec.create === 'function'`。
 * 0.2.x 这里写的是旧的 `{ mode, typeSymbol, schema }`，后果是 `remote.$mount()`
 * 对这份不合规的贡献**既不 resolve 也不 reject**——客户端于是永远停在
 * 「正在连接宿主状态通道…」，界面上什么线索都没有。
 *
 * 同一个错误在宿主清单（src/typert.ts）和测试里都犯过、也都被单独修掉了，
 * 唯独这一处漏了。三处必须一起改。
 */
function descriptor(method: string, inputSymbol: string, resultSymbol: string) {
  const passthrough = (typeSymbol: string) => ({
    mode: 'strict' as const,
    typeSymbol,
    // 按需物化的直通 schema：宿主只要求 create 是函数，这里不做真实校验
    // （真正的 strict 校验在宿主侧用 src/typert.ts 里那份真 schema 做）。
    create: () => ({
      parse: (value: unknown) => value,
      safeParse: (value: unknown) => ({ success: true as const, data: value }),
    }),
  })
  return {
    id: `${REMOTE_PACKAGE}#${REMOTE_SERVICE}/${method}`,
    service: REMOTE_SERVICE,
    namespace: REMOTE_SERVICE,
    method,
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'input',
      wire: 'input',
      source: 'json',
      codec: passthrough(inputSymbol),
    }],
    result: passthrough(resultSymbol),
  }
}

export const REMOTE_CONTRIBUTION = {
  package: REMOTE_PACKAGE,
  descriptors: [
    descriptor('status', `${REMOTE_TYPES}#StatusInput`, `${REMOTE_TYPES}#ValueRouterStatusStatusResult`),
    descriptor('sessionMetrics', `${REMOTE_TYPES}#SessionMetricsInput`, `${REMOTE_TYPES}#ValueRouterStatusSessionMetricsResult`),
  ],
}

// —— 挂载（每个 ctx 一次） ——

const mountCache = new WeakMap<object, Promise<ValueRouterRemoteFace | undefined>>()

/**
 * $mount 的挂起上限。宿主对不合规的贡献可能既不 resolve 也不 reject
 * （见上面 descriptor 的注释），没有上限的话界面会永远停在「正在连接」。
 */
const MOUNT_TIMEOUT_MS = 8_000

function mountRemote(ctx: Context): Promise<ValueRouterRemoteFace | undefined> {
  const key = ctx as unknown as object
  const cached = mountCache.get(key)
  if (cached) return cached
  const pending = (async (): Promise<ValueRouterRemoteFace | undefined> => {
    try {
      const remote = ctx.remote as unknown as { $mount?: (contribution: unknown) => Promise<unknown> }
      if (typeof remote.$mount !== 'function') return undefined
      await Promise.race([
        remote.$mount(REMOTE_CONTRIBUTION),
        new Promise((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`$mount 超过 ${MOUNT_TIMEOUT_MS / 1000}s 未返回（贡献可能被宿主拒绝且不报错）`)),
            MOUNT_TIMEOUT_MS,
          )
          ;(timer as unknown as { unref?: () => void }).unref?.()
        }),
      ])
      const mounted = (ctx as unknown as { reflect?: { get?: (key: string) => unknown } })
        .reflect?.get?.(`remote.${REMOTE_SERVICE}`) as ValueRouterRemoteFace | undefined
      if (mounted && typeof mounted.status === 'function') return mounted
      return undefined
    } catch {
      return undefined
    }
  })().then((face) => {
    // 挂载失败不缓存：下一次轮询可以重试（宿主可能还没注册该服务）。
    if (!face) mountCache.delete(key)
    return face
  })
  mountCache.set(key, pending)
  return pending
}

// —— 信封与防御式归一化 ——

function unwrapEnvelope(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value
  const record = value as { ok?: unknown; value?: unknown; result?: unknown }
  if (record.result !== undefined) return unwrapEnvelope(record.result)
  if (record.ok === true && record.value !== undefined) return record.value
  if (record.ok === false) return undefined
  return value
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : fallback
}

const LINE_STATUSES = ['available', 'missing', 'blocked'] as const
const ROUTE_SOURCES = ['user', 'captain', 'difficulty', 'fallback', 'none'] as const
const ROUTE_STATUSES = ['resolved', 'pending', 'blocked'] as const

/** 逐条解码一个数组，坏条目丢弃、其余照常。 */
function listOf<T>(value: unknown, decode: (item: unknown) => T | undefined): T[] {
  if (!Array.isArray(value)) return []
  const out: T[] = []
  for (const item of value) {
    const decoded = decode(item)
    if (decoded !== undefined) out.push(decoded)
  }
  return out
}

/** 一条线路：provider/model 缺一就丢弃这一条，其余字段逐项兜底。 */
function asLine(value: unknown): ValueRouterLineView | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.provider !== 'string' || typeof raw.model !== 'string') return undefined
  const detail = optionalString(raw.statusDetail)
  return {
    provider: raw.provider,
    model: raw.model,
    reasoning_effort: typeof raw.reasoning_effort === 'string' ? raw.reasoning_effort : '',
    status: oneOf(raw.status, LINE_STATUSES, 'missing' as ValueRouterLineStatus),
    ...(detail !== undefined ? { statusDetail: detail } : {}),
  }
}

/** 档位视图：逐项兜底，宿主送来半残数据时不至于整档消失。 */
function asTier(value: unknown): ValueRouterTierView | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  if (!isDifficulty(raw.id)) return undefined
  return {
    id: raw.id,
    lines: listOf(raw.lines, asLine),
  }
}

/** 一条派发记录：字段缺失就丢弃这一条，不影响其余。 */
function asDispatch(value: unknown): ValueRouterDispatchView | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.provider !== 'string' || typeof raw.model !== 'string') return undefined
  return {
    provider: raw.provider,
    model: raw.model,
    difficulty: isDifficulty(raw.difficulty) ? raw.difficulty : DEFAULT_DIFFICULTY,
    routeSource: oneOf(raw.routeSource, ROUTE_SOURCES, 'none' as ValueRouterRouteSource),
    fallback: raw.fallback === true,
    degraded: raw.degraded === true,
    at: num(raw.at),
  }
}

function asEventRoute(value: unknown): ValueRouterRouteEventView['route'] | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.provider !== 'string' || typeof raw.model !== 'string') return undefined
  const effort = optionalString(raw.reasoning_effort)
  return {
    provider: raw.provider,
    model: raw.model,
    ...(effort !== undefined ? { reasoning_effort: effort } : {}),
  }
}

/** 一条运行事件：`type` 是唯一必需字段，其余逐项兜底。 */
function asEvent(value: unknown): ValueRouterRouteEventView | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const type = optionalString(raw.type)
  if (type === undefined) return undefined
  const event: ValueRouterRouteEventView = { type, at: num(raw.at) }
  const teamId = optionalString(raw.teamId)
  if (teamId !== undefined) event.teamId = teamId
  const taskId = optionalString(raw.taskId)
  if (taskId !== undefined) event.taskId = taskId
  const member = optionalString(raw.member)
  if (member !== undefined) event.member = member
  const sessionId = optionalString(raw.sessionId)
  if (sessionId !== undefined) event.sessionId = sessionId
  const difficulty = optionalString(raw.difficulty)
  if (difficulty !== undefined) event.difficulty = difficulty
  const role = optionalString(raw.role)
  if (role !== undefined) event.role = role
  const route = asEventRoute(raw.route)
  if (route !== undefined) event.route = route
  if (typeof raw.routeSource === 'string') event.routeSource = oneOf(raw.routeSource, ROUTE_SOURCES, 'none' as ValueRouterRouteSource)
  if (typeof raw.routeStatus === 'string') event.routeStatus = oneOf(raw.routeStatus, ROUTE_STATUSES, 'pending' as ValueRouterRouteStatus)
  const detail = optionalString(raw.detail)
  if (detail !== undefined) event.detail = detail
  const queueReason = optionalString(raw.queueReason)
  if (queueReason !== undefined) event.queueReason = queueReason
  return event
}

/**
 * 只保留本插件拥有的最小数据对象，不持有任何宿主对象引用。
 *
 * 形状不认识时返回 undefined（而不是拼一个半残对象）：调用方据此把
 * 「通道断了」和「宿主返回了别的东西」两类失败分开报告。
 */
function asStatusSnapshot(value: unknown): ValueRouterStatusView | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.enabled !== 'boolean' || !Array.isArray(raw.tiers)) return undefined
  const fallback = asLine(raw.fallback)
  if (fallback === undefined) return undefined
  return {
    enabled: raw.enabled,
    tiers: listOf(raw.tiers, asTier),
    fallback,
    availableLines: num(raw.availableLines),
    missingLines: num(raw.missingLines),
    blockedLines: num(raw.blockedLines),
    allowlistKnown: raw.allowlistKnown !== false,
    routedCallsTotal: num(raw.routedCallsTotal),
    recentDispatches: listOf(raw.recentDispatches, asDispatch),
    recentEvents: listOf(raw.recentEvents, asEvent),
  }
}

function asSessionMetrics(value: unknown): ValueRouterSessionMetrics | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.routedCalls !== 'number') return undefined
  return {
    routedCalls: num(raw.routedCalls),
    recentDispatches: listOf(raw.recentDispatches, asDispatch),
  }
}

// —— Hooks ——

/**
 * 轮询结果与上一次逐字段相同的比较。
 *
 * 归一化函数每次都构造新对象，若直接 setState 会让订阅组件每 4~5 秒无谓重渲染一次；
 * 两个载荷都是固定键序的小型纯数据对象，序列化比较既便宜又准确。
 */
function unchanged(previous: unknown, next: unknown): boolean {
  if (previous === undefined) return false
  try {
    return JSON.stringify(previous) === JSON.stringify(next)
  } catch {
    return false
  }
}

/**
 * 订阅宿主只读状态快照（顶栏气泡 / 设置卡打开时轮询；关闭即停）。
 */
/** 状态通道的读取结果：数据 + 上一次的失败原因。 */
export interface LiveStatusResult {
  data: ValueRouterStatusView | undefined
  /** 最近一次读取失败的原因；成功读取后清空。用于在界面上说清"为什么没有数据"。 */
  error: string | undefined
}

export function useLiveStatus(ctx: Context | undefined, active: boolean): LiveStatusResult {
  const [status, setStatus] = useState<ValueRouterStatusView | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const faceRef = useRef<ValueRouterRemoteFace | null>(null)

  useEffect(() => {
    if (!ctx || !active) return
    let disposed = false
    const read = async (): Promise<void> => {
      const face = faceRef.current
      if (!face) return
      try {
        const raw = await face.status({})
        if (disposed) return
        const parsed = asStatusSnapshot(unwrapEnvelope(raw))
        if (parsed) {
          setStatus((previous) => (unchanged(previous, parsed) ? previous : parsed))
          setError(undefined)
        } else {
          // 有响应但形状不对：也要说出来，否则界面只能显示"空"，看不出是断线还是数据异常
          setError('宿主返回的状态形状无法识别')
        }
      } catch (cause) {
        if (disposed) return
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    }
    void mountRemote(ctx).then((face) => {
      if (disposed) return
      faceRef.current = face ?? null
      if (face === null) setError('Remote 通道挂载失败')
      void read()
    })
    const timer = setInterval(() => { void read() }, 4000)
    ;(timer as unknown as { unref?: () => void }).unref?.()
    return () => { disposed = true; clearInterval(timer) }
  }, [ctx, active])

  return { data: status, error }
}

/**
 * 订阅宿主侧「本会话（含后代子代理）」的改写次数与派发记录。
 *
 * `refreshToken` 变化会立即重读一次；只读通道下没有写入后的回读需求，
 * 保留该入参是为了调用方仍可主动触发一次刷新。
 */
export function useLiveSessionMetrics(
  ctx: Context | undefined,
  sessionId: string | undefined,
  active: boolean,
  refreshToken = 0,
): ValueRouterSessionMetrics | undefined {
  const [metrics, setMetrics] = useState<ValueRouterSessionMetrics | undefined>(undefined)
  const faceRef = useRef<ValueRouterRemoteFace | null>(null)

  useEffect(() => {
    if (!ctx || !active || !sessionId) {
      setMetrics(undefined)
      return
    }
    let disposed = false
    const read = async (): Promise<void> => {
      const face = faceRef.current
      if (!face) return
      try {
        const raw = await face.sessionMetrics({ sessionId })
        if (disposed) return
        const parsed = asSessionMetrics(unwrapEnvelope(raw))
        if (parsed) setMetrics((previous) => (unchanged(previous, parsed) ? previous : parsed))
      } catch {
        // 保持旧值。
      }
    }
    void mountRemote(ctx).then((face) => {
      if (disposed) return
      faceRef.current = face ?? null
      void read()
    })
    const timer = setInterval(() => { void read() }, 5000)
    ;(timer as unknown as { unref?: () => void }).unref?.()
    return () => { disposed = true; clearInterval(timer) }
  }, [ctx, sessionId, active, refreshToken])

  return metrics
}

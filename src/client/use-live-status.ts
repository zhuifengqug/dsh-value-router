/**
 * 宿主侧 `valueRouterStatus` Remote 通道（浏览器侧读取层）。
 *
 * 三个方法与 src/typert.ts 的 invocations 一一对应；descriptor 的 typeSymbol
 * 必须与宿主声明**逐字一致** —— DSH 的 api-gateway 只在 dsh-typert-loader 注册了
 * strict typeSymbol 之后才能调度该 Remote 服务。客户端这里的 schema 只是本地
 * 透传编解码（真正的 Zod 校验在宿主侧）。
 *
 * 通道不可用（旧宿主 / 尚未挂载）时保持 undefined，不抛错、不影响开关与设置。
 */

import { useEffect, useRef, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ModelRouteSelection, SessionOverrideConfig, ValueRouterStrategy } from '../core/config.ts'

const REMOTE_PACKAGE = '@gjs27/dsh-value-router'
const REMOTE_TYPES = `${REMOTE_PACKAGE}/types`
const REMOTE_SERVICE = 'valueRouterStatus'

/**
 * 只读状态快照的浏览器侧视图（src/core/snapshot.ts 的线上形状镜像）。
 *
 * tsconfig.client.json 只收录 src/client/** 与 src/core/**，这里保留一份结构性
 * 镜像，避免客户端工程越过自己的文件边界。
 */
export interface ValueRouterPoolLineView {
  provider: string
  model: string
  reasoningEffort: string
  allowed: boolean
}

/** 一个档位。顺序即优先级，`tiers[0]` 是最低档 = 兜底轮转池。 */
export interface ValueRouterTierView {
  id: string
  label: string
  pool: ValueRouterPoolLineView[]
}

/** 一条实际派发记录的浏览器侧镜像。 */
export interface ValueRouterDispatchView {
  provider: string
  model: string
  /** 实际派发的档位下标；落在兜底线路时为 null。 */
  tierIndex: number | null
  origin: 'pool' | 'explicit' | 'fallback'
  at: number
}

export interface ValueRouterStatusView {
  enabled: boolean
  strategy: ValueRouterStrategy
  tiers: ValueRouterTierView[]
  executor: ModelRouteSelection
  executorStatus: 'active' | 'disabled' | 'unconfigured' | 'degraded'
  executorReason?: string
  executorCallsTotal: number
  tierRouting: 'tier-rotate' | 'controller'
  recentDispatches: ValueRouterDispatchView[]
  allowlistKnown: boolean
}

/** 会话计量线上形状（src/status-controller.ts 的 SessionMetricsWire 镜像）。 */
export interface ValueRouterSessionMetrics {
  executorCalls: number
  override: SessionOverrideConfig | null
  /** 本会话（含后代子代理）的实际派发记录，最新的在前。 */
  recentDispatches: ValueRouterDispatchView[]
}

export interface ValueRouterRemoteFace {
  status(input: Record<string, unknown>): Promise<unknown>
  sessionMetrics(input: { sessionId?: string }): Promise<unknown>
  setSessionOverride(input: { sessionId: string; override: SessionOverrideConfig | null }): Promise<unknown>
}

// —— descriptor（id 与 typeSymbol 与宿主 src/typert.ts 对齐） ——

function descriptor(method: string, inputSymbol: string, resultSymbol: string) {
  const passthrough = (typeSymbol: string) => ({
    mode: 'strict',
    typeSymbol,
    schema: { parse: (value: unknown) => value },
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
    descriptor('setSessionOverride', `${REMOTE_TYPES}#SetSessionOverrideInput`, `${REMOTE_TYPES}#ValueRouterStatusSetSessionOverrideResult`),
  ],
}

// —— 挂载（每个 ctx 一次） ——

const mountCache = new WeakMap<object, Promise<ValueRouterRemoteFace | undefined>>()

function mountRemote(ctx: Context): Promise<ValueRouterRemoteFace | undefined> {
  const key = ctx as unknown as object
  const cached = mountCache.get(key)
  if (cached) return cached
  const pending = (async (): Promise<ValueRouterRemoteFace | undefined> => {
    try {
      const remote = ctx.remote as unknown as { $mount?: (contribution: unknown) => Promise<unknown> }
      if (typeof remote.$mount !== 'function') return undefined
      await remote.$mount(REMOTE_CONTRIBUTION)
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

function asRoute(value: unknown): { provider: string; model: string; reasoningEffort: string } {
  const route = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  return {
    provider: typeof route.provider === 'string' ? route.provider : '',
    model: typeof route.model === 'string' ? route.model : '',
    reasoningEffort: typeof route.reasoningEffort === 'string' ? route.reasoningEffort : '',
  }
}

/** 轮转池的单条线路视图（宿主可能送来半残数据，逐项兜底）。 */
function asPoolLine(value: unknown): ValueRouterPoolLineView | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.provider !== 'string' || typeof raw.model !== 'string') return undefined
  return {
    provider: raw.provider,
    model: raw.model,
    reasoningEffort: typeof raw.reasoningEffort === 'string' ? raw.reasoningEffort : '',
    allowed: raw.allowed !== false,
  }
}

/** 一条派发记录：字段缺失就丢弃这一条，不影响其余。 */
function asDispatch(value: unknown): ValueRouterDispatchView[] {
  if (typeof value !== 'object' || value === null) return []
  const raw = value as Record<string, unknown>
  if (typeof raw.provider !== 'string' || typeof raw.model !== 'string') return []
  return [{
    provider: raw.provider,
    model: raw.model,
    tierIndex: typeof raw.tierIndex === 'number' ? raw.tierIndex : null,
    origin: raw.origin === 'explicit' || raw.origin === 'fallback' ? raw.origin : 'pool',
    at: num(raw.at),
  }]
}

/** 档位视图：逐项兜底，宿主送来半残数据时不至于整档消失。 */
function asTier(value: unknown): ValueRouterTierView | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.id !== 'string' || typeof raw.label !== 'string') return undefined
  return {
    id: raw.id,
    label: raw.label,
    pool: Array.isArray(raw.pool)
      ? raw.pool.map(asPoolLine).filter((line): line is ValueRouterPoolLineView => line !== undefined)
      : [],
  }
}

/** 只保留本插件拥有的最小数据对象，不持有任何宿主对象引用。 */
function asStatusSnapshot(value: unknown): ValueRouterStatusView | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.enabled !== 'boolean' || typeof raw.strategy !== 'string') return undefined
  return {
    enabled: raw.enabled,
    strategy: oneOf(raw.strategy, ['saver', 'balanced', 'powerful'] as const, 'balanced'),
    tiers: Array.isArray(raw.tiers)
      ? raw.tiers.map(asTier).filter((tier): tier is ValueRouterTierView => tier !== undefined)
      : [],
    executor: asRoute(raw.executor),
    executorStatus: oneOf(raw.executorStatus, ['active', 'disabled', 'unconfigured', 'degraded'] as const, 'disabled'),
    ...(optionalString(raw.executorReason) !== undefined ? { executorReason: optionalString(raw.executorReason) } : {}),
    executorCallsTotal: num(raw.executorCallsTotal),
    tierRouting: raw.tierRouting === 'controller' ? 'controller' : 'tier-rotate',
    recentDispatches: Array.isArray(raw.recentDispatches)
      ? raw.recentDispatches.flatMap(asDispatch)
      : [],
    allowlistKnown: raw.allowlistKnown !== false,
  }
}

function asOverride(value: unknown): SessionOverrideConfig | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  const out: SessionOverrideConfig = {}
  if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled
  if (raw.strategy === 'saver' || raw.strategy === 'balanced' || raw.strategy === 'powerful') out.strategy = raw.strategy
  if (typeof raw.executor === 'object' && raw.executor !== null) {
    const route = raw.executor as Record<string, unknown>
    const executor: NonNullable<SessionOverrideConfig['executor']> = {}
    if (typeof route.provider === 'string') executor.provider = route.provider
    if (typeof route.model === 'string') executor.model = route.model
    if (typeof route.reasoningEffort === 'string') executor.reasoningEffort = route.reasoningEffort
    out.executor = executor
  }
  return Object.keys(out).length > 0 ? out : null
}

function asSessionMetrics(value: unknown): ValueRouterSessionMetrics | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.executorCalls !== 'number') return undefined
  return {
    executorCalls: num(raw.executorCalls),
    override: asOverride(raw.override),
    recentDispatches: Array.isArray(raw.recentDispatches)
      ? raw.recentDispatches.flatMap(asDispatch)
      : [],
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
export function useLiveStatus(ctx: Context | undefined, active: boolean): ValueRouterStatusView | undefined {
  const [status, setStatus] = useState<ValueRouterStatusView | undefined>(undefined)
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
        if (parsed) setStatus((previous) => (unchanged(previous, parsed) ? previous : parsed))
      } catch {
        // 通道抖动时保持旧值，下次轮询再试。
      }
    }
    void mountRemote(ctx).then((face) => {
      if (disposed) return
      faceRef.current = face ?? null
      void read()
    })
    const timer = setInterval(() => { void read() }, 4000)
    ;(timer as unknown as { unref?: () => void }).unref?.()
    return () => { disposed = true; clearInterval(timer) }
  }, [ctx, active])

  return status
}

/**
 * 订阅宿主侧会话计量与「本会话覆写」。
 *
 * `refreshToken` 变化会立即重读一次（写入覆写后用于回读宿主结果）。
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

/**
 * 写入 / 清除会话级覆写（不污染全局设置）。返回是否被宿主接受。
 */
export async function writeSessionOverride(
  ctx: Context | undefined,
  sessionId: string | undefined,
  override: SessionOverrideConfig | null,
): Promise<boolean> {
  if (!ctx || !sessionId) return false
  try {
    const face = await mountRemote(ctx)
    if (!face || typeof face.setSessionOverride !== 'function') return false
    const raw = unwrapEnvelope(await face.setSessionOverride({ sessionId, override }))
    if (typeof raw !== 'object' || raw === null) return false
    return (raw as { ok?: unknown }).ok === true
  } catch {
    return false
  }
}

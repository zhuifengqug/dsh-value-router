import { useEffect, useRef, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'

export interface ValueModeLiveMetrics {
  controllerCalls: number
  subagentCalls: number
  executorCalls: number
  expertCalls: number
  inputTokens: number
  outputTokens: number
  estimatedSavingsPercent: number
  consultationsCount: number
}

const EMPTY_METRICS: ValueModeLiveMetrics = {
  controllerCalls: 0,
  subagentCalls: 0,
  executorCalls: 0,
  expertCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  estimatedSavingsPercent: 0,
  consultationsCount: 0,
}

type MetricsRemote = {
  metrics(input: { sessionId?: string }): Promise<unknown>
}

function unwrapEnvelope(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value
  const record = value as { ok?: unknown; value?: unknown; result?: unknown }
  if (record.result !== undefined) return unwrapEnvelope(record.result)
  if (record.ok === true && record.value !== undefined) return record.value
  if (record.ok === false) return undefined
  return value
}

function asMetrics(value: unknown): ValueModeLiveMetrics | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const r = value as Record<string, unknown>
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0)
  if (typeof r.controllerCalls !== 'number' && typeof r.expertCalls !== 'number') return undefined
  const controllerCalls = num(r.controllerCalls ?? r.expertCalls)
  const subagentCalls = num(r.subagentCalls ?? r.executorCalls)
  return {
    controllerCalls,
    subagentCalls,
    executorCalls: num(r.executorCalls ?? subagentCalls),
    expertCalls: num(r.expertCalls ?? controllerCalls),
    inputTokens: num(r.inputTokens),
    outputTokens: num(r.outputTokens),
    estimatedSavingsPercent: Math.min(100, Math.max(0, num(r.estimatedSavingsPercent))),
    consultationsCount: num(r.consultationsCount),
  }
}

function descriptor(method: string, inputSymbol: string, resultSymbol: string) {
  const passthrough = (typeSymbol: string) => ({
    mode: 'strict',
    typeSymbol,
    schema: { parse: (value: unknown) => value },
  })
  return {
    id: `@linxin666/dsh-value-mode#valueModeMetrics/${method}`,
    service: 'valueModeMetrics',
    namespace: 'valueModeMetrics',
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

const REMOTE_CONTRIBUTION = {
  package: '@linxin666/dsh-value-mode',
  descriptors: [
    descriptor('metrics', '@linxin666/dsh-value-mode/types#MetricsInput', '@linxin666/dsh-value-mode/types#ValueModeMetricsResult'),
  ],
}

/**
 * 订阅宿主侧会话累计计数（background-run 同款 Remote 直连模式）。
 *
 * Header 浮层打开时读一次，之后每 5s 轮询；关闭即停。通道不可用（旧宿主 /
 * 未挂载）时保持全 0，不抛错、不影响开关与设置。
 */
export function useLiveSessionMetrics(ctx: Context | undefined, sessionId: string | undefined, active: boolean): ValueModeLiveMetrics {
  const [metrics, setMetrics] = useState<ValueModeLiveMetrics>(EMPTY_METRICS)
  const remoteRef = useRef<MetricsRemote | null>(null)

  useEffect(() => {
    if (!ctx || !active || !sessionId) {
      setMetrics(EMPTY_METRICS)
      return
    }
    let disposed = false
    const read = async (): Promise<void> => {
      try {
        const remote = remoteRef.current
        if (!remote) return
        const raw = await remote.metrics({ sessionId })
        if (disposed) return
        const parsed = asMetrics(unwrapEnvelope(raw))
        if (parsed) setMetrics(parsed)
      } catch {
        // 通道抖动时保持旧值，下次轮询再试。
      }
    }
    try {
      const mountP = (ctx.remote as unknown as { $mount?: (c: unknown) => Promise<unknown> }).$mount?.(REMOTE_CONTRIBUTION)
      void Promise.resolve(mountP).then(() => {
        if (disposed) return
        try {
          const mounted = (ctx as unknown as { reflect?: { get?: (k: string) => unknown } }).reflect?.get?.('remote.valueModeMetrics') as MetricsRemote | undefined
          if (mounted && typeof mounted.metrics === 'function') remoteRef.current = mounted
        } catch {
          remoteRef.current = null
        }
        void read()
      }).catch(() => {
        // $mount 失败：保持全 0。
      })
    } catch {
      // 无 remote 面：保持全 0。
    }
    const timer = setInterval(() => { void read() }, 5000)
    if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
      (timer as unknown as { unref: () => void }).unref()
    }
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [ctx, sessionId, active])

  return metrics
}

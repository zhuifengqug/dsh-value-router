/**
 * 价值路由状态的浏览器通道（Typert Remote）。
 *
 * 浏览器侧顶栏徽章 / 设置卡经此读取宿主真实状态：
 * - status：路由配置 + executor 健康 + executor 调用计数；
 * - sessionMetrics：某会话的 executor 调用次数与覆写；
 * - setSessionOverride：写入/清除会话级覆写（气泡「仅本会话」档）。
 *
 * Remote 标记用 background-run 同款 plain-JS 写法（不使用装饰器）；
 * 方法顺序必须与 src/typert.ts 的 invocations 顺序一致。
 */

import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionOverrideConfig } from './core/config.ts'
import { normalizeSessionOverride } from './core/config.ts'
import type { ValueRouterStatusSnapshot, DispatchView } from './core/snapshot.ts'
import { EMPTY_STATUS_SNAPSHOT } from './core/snapshot.ts'
import { valueRouterState } from './core/state.ts'

/** 会话指标的线上形状（扁平化，便于 strict codec）。 */
export interface SessionMetricsWire {
  executorCalls: number
  override: SessionOverrideConfig | null
  /**
   * **本会话**（含其后代子代理）的实际派发记录，最新的在前。
   *
   * 放在会话指标而不是全局状态里，是因为徽章是按会话挂的——用户问的永远是
   * 「这个会话把子代理派到哪去了」，不是「所有会话一共派了哪些」。
   */
  recentDispatches: DispatchView[]
}

export class ValueRouterStatusController extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, 'valueRouterStatus', { namespace: 'valueRouterStatus' })
    runRemoteMarks(this)
  }

  async status(_input: Record<string, unknown> = {}): Promise<ValueRouterStatusSnapshot> {
    void _input
    const service = this.ctx.get('valueRouter' as never) as
      | { snapshot(): ValueRouterStatusSnapshot }
      | undefined
    if (!service) {
      return { ...EMPTY_STATUS_SNAPSHOT, executorReason: '价值路由服务未加载。' }
    }
    return service.snapshot()
  }

  async sessionMetrics(_input: Record<string, unknown> = {}): Promise<SessionMetricsWire> {
    const input = (_input ?? {}) as { sessionId?: unknown }
    const sessionId = typeof input.sessionId === 'string' ? input.sessionId : ''
    const m = valueRouterState.getSessionMetrics(sessionId)
    return {
      executorCalls: m.executorCalls,
      override: m.override ?? null,
      recentDispatches: valueRouterState.recentDispatchesFor(sessionId, 8).map(record => ({
        provider: record.provider,
        model: record.model,
        tierIndex: record.tierIndex ?? null,
        origin: record.origin,
        at: record.at,
      })),
    }
  }

  async setSessionOverride(_input: Record<string, unknown> = {}): Promise<{ ok: boolean }> {
    const input = (_input ?? {}) as { sessionId?: unknown; override?: unknown }
    const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : ''
    if (!sessionId) return { ok: false }
    valueRouterState.setSessionOverride(sessionId, normalizeSessionOverride(input.override))
    return { ok: true }
  }
}

// —— background-run 同款 Remote 标记（plain-JS，无装饰器）——
const remoteMarks: Array<{ proto: object; method: string; fn: (this: unknown) => void }> = []
function markRemote(proto: object, method: string): void {
  const context = {
    kind: 'method',
    name: method,
    private: false,
    static: false,
    addInitializer(fn: (this: unknown) => void) {
      remoteMarks.push({ proto, method, fn })
    },
  }
  ;(Remote as (method: string) => (fn: unknown, ctx: unknown) => void)(method)(
    (proto as Record<string, unknown>)[method],
    context,
  )
}

function runRemoteMarks(instance: unknown): void {
  const proto = Object.getPrototypeOf(instance)
  for (const mark of remoteMarks) {
    if (mark.proto === proto) mark.fn.call(instance)
  }
}

// 顺序必须与 src/typert.ts 的 invocations 顺序一致。
for (const method of ['status', 'sessionMetrics', 'setSessionOverride']) {
  markRemote(ValueRouterStatusController.prototype, method)
}

export default ValueRouterStatusController

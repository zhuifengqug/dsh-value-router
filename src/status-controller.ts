/**
 * 价值路由状态的浏览器通道（Typert Remote）。
 *
 * 浏览器侧顶栏徽章 / 设置卡经此读取宿主真实状态：
 * - status：路由配置 + executor 健康 + 桥健康 / 委派统计 / 批次进度；
 * - sessionMetrics：某会话的 executor 与桥计量；
 * - setSessionOverride：写入/清除会话级覆写（气泡「仅本会话」档）。
 *
 * Remote 标记用 background-run 同款 plain-JS 写法（不使用装饰器）；
 * 方法顺序必须与 src/typert.ts 的 invocations 顺序一致。
 */

import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionOverrideConfig } from './core/config.ts'
import { normalizeSessionOverride } from './core/config.ts'
import type { ValueRouterStatusSnapshot } from './core/snapshot.ts'
import { EMPTY_BRIDGE_SNAPSHOT } from './core/snapshot.ts'
import { valueRouterState } from './core/state.ts'

/** 会话指标的线上形状（扁平化，便于 strict codec）。 */
export interface SessionMetricsWire {
  executorCalls: number
  executorInputTokens: number
  executorOutputTokens: number
  bridgeDelegations: number
  bridgePromptTokens: number
  bridgeCompletionTokens: number
  bridgeTotalTokens: number
  bridgeSavedTokens: number
  estimateOnlyCount: number
  executorSharePercent: number
  override: SessionOverrideConfig | null
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
      return {
        enabled: false,
        scope: 'preset',
        strategy: 'balanced',
        executor: { provider: '', model: '', reasoningEffort: '' },
        executorStatus: 'disabled',
        executorCallsTotal: 0,
        bridgeDelegationsTotal: 0,
        bridgeEnabled: EMPTY_BRIDGE_SNAPSHOT.enabled,
        autoDelegate: EMPTY_BRIDGE_SNAPSHOT.autoDelegate,
        bridgeStatus: EMPTY_BRIDGE_SNAPSHOT.bridgeStatus,
        delegating: EMPTY_BRIDGE_SNAPSHOT.delegating,
        lastTaskDelegations: EMPTY_BRIDGE_SNAPSHOT.lastTaskDelegations,
        maxDelegationsPerTask: EMPTY_BRIDGE_SNAPSHOT.maxDelegationsPerTask,
        delegationsTotal: EMPTY_BRIDGE_SNAPSHOT.delegationsTotal,
        bridgeTokensTotal: { ...EMPTY_BRIDGE_SNAPSHOT.bridgeTokensTotal },
        savedTokensTotal: EMPTY_BRIDGE_SNAPSHOT.savedTokensTotal,
        estimateOnlyCount: EMPTY_BRIDGE_SNAPSHOT.estimateOnlyCount,
        lastOutcome: EMPTY_BRIDGE_SNAPSHOT.lastOutcome,
        lastMessage: '价值路由服务未加载。',
      }
    }
    return service.snapshot()
  }

  async sessionMetrics(_input: Record<string, unknown> = {}): Promise<SessionMetricsWire> {
    const input = (_input ?? {}) as { sessionId?: unknown }
    const sessionId = typeof input.sessionId === 'string' ? input.sessionId : ''
    const m = valueRouterState.getSessionMetrics(sessionId)
    return {
      executorCalls: m.executorCalls,
      executorInputTokens: m.executorTokens.inputTokens,
      executorOutputTokens: m.executorTokens.outputTokens,
      bridgeDelegations: m.bridgeDelegations,
      bridgePromptTokens: m.bridgeTokens.promptTokens,
      bridgeCompletionTokens: m.bridgeTokens.completionTokens,
      bridgeTotalTokens: m.bridgeTokens.total,
      bridgeSavedTokens: m.bridgeSavedTokens,
      estimateOnlyCount: m.estimateOnlyCount,
      executorSharePercent: m.executorSharePercent,
      override: m.override ?? null,
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

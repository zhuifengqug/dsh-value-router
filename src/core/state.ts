/**
 * 会话级状态与计量（从 value-mode 的 state 移植，删除 expert/咨询相关字段，新增桥指标）。
 *
 * 两类数据：
 * - 会话覆写（顶栏气泡写入，只影响本会话，不污染全局配置）；
 * - 会话计量（executor 调用次数/token 来自遥测链路实值；桥委派次数/token/节省来自
 *   字符估算口径，estimateOnly 标注）。
 *
 * 子会话归属：浏览器 header 只知道父会话 id，而子代理的计数记在子会话名下，
 * 因此查询父会话时把后代计数聚合回来。
 */

import type { SessionOverrideConfig } from './config.ts'

export interface TokenPair {
  inputTokens: number
  outputTokens: number
}

export interface SessionValueRouterMetrics {
  executorCalls: number
  executorTokens: TokenPair
  bridgeDelegations: number
  bridgeTokens: { promptTokens: number; completionTokens: number; total: number }
  bridgeSavedTokens: number
  estimateOnlyCount: number
  override?: SessionOverrideConfig
}

export interface SessionMetricsSnapshot {
  executorCalls: number
  executorTokens: TokenPair
  bridgeDelegations: number
  bridgeTokens: { promptTokens: number; completionTokens: number; total: number }
  bridgeSavedTokens: number
  estimateOnlyCount: number
  /**
   * 在下沉工作量中的 executor 占比（executor 调用 / (executor 调用 + 桥委派)）。
   * 主会话调用不在此口径内——主模型永不被插件接管，也不被计量。
   */
  executorSharePercent: number
  override?: SessionOverrideConfig
}

export interface GlobalMetricsSnapshot {
  executorCalls: number
  bridgeDelegations: number
  activeSessions: number
}

function emptyMetrics(): SessionValueRouterMetrics {
  return {
    executorCalls: 0,
    executorTokens: { inputTokens: 0, outputTokens: 0 },
    bridgeDelegations: 0,
    bridgeTokens: { promptTokens: 0, completionTokens: 0, total: 0 },
    bridgeSavedTokens: 0,
    estimateOnlyCount: 0,
  }
}

class ValueRouterStateManager {
  private sessions = new Map<string, SessionValueRouterMetrics>()
  private globalExecutorCalls = 0
  private globalBridgeDelegations = 0
  /**
   * 子会话 -> 直接父会话（来自 agent/request 的 session.header.parentSession）。
   * 含环保护，避免异常 lineage 造成死循环。
   */
  private parents = new Map<string, string>()

  /** 记录子会话的父会话归属；不创建会话条目，因此对非本插件会话调用也无副作用。 */
  trackChildSession(childId: string, parentSessionId: string): void {
    if (!childId || !parentSessionId || childId === parentSessionId) return
    let current: string | undefined = parentSessionId
    const seen = new Set<string>([childId])
    while (current !== undefined) {
      if (seen.has(current)) return
      seen.add(current)
      current = this.parents.get(current)
    }
    this.parents.set(childId, parentSessionId)
  }

  /** 该会话的直接父会话 id（用于查父会话的覆写）。 */
  getParentSession(sessionId: string): string | undefined {
    return this.parents.get(sessionId)
  }

  private isDescendantOf(sessionId: string, ancestorId: string): boolean {
    let current = this.parents.get(sessionId)
    const seen = new Set<string>([sessionId])
    while (current !== undefined) {
      if (current === ancestorId) return true
      if (seen.has(current)) return false
      seen.add(current)
      current = this.parents.get(current)
    }
    return false
  }

  private getSessionState(sessionId: string): SessionValueRouterMetrics {
    let state = this.sessions.get(sessionId)
    if (!state) {
      state = emptyMetrics()
      this.sessions.set(sessionId, state)
    }
    return state
  }

  /** 记录一次 executor 路由调用（token 为遥测链路实值，可能缺省）。 */
  recordExecutorCall(sessionId?: string, usage?: Partial<TokenPair>): void {
    this.globalExecutorCalls++
    if (!sessionId) return
    const state = this.getSessionState(sessionId)
    state.executorCalls++
    state.executorTokens.inputTokens += usage?.inputTokens ?? 0
    state.executorTokens.outputTokens += usage?.outputTokens ?? 0
  }

  /** 记录一次桥委派（token 为字符估算口径，estimateOnly 标注）。 */
  recordBridgeDelegation(
    sessionId?: string,
    usage?: { promptTokens?: number; completionTokens?: number; total?: number; estimateOnly?: boolean },
    savedTokens = 0,
  ): void {
    this.globalBridgeDelegations++
    if (!sessionId) return
    const state = this.getSessionState(sessionId)
    state.bridgeDelegations++
    state.bridgeTokens.promptTokens += usage?.promptTokens ?? 0
    state.bridgeTokens.completionTokens += usage?.completionTokens ?? 0
    state.bridgeTokens.total += usage?.total ?? 0
    if (usage?.estimateOnly) state.estimateOnlyCount++
    if (Number.isFinite(savedTokens) && savedTokens > 0) state.bridgeSavedTokens += Math.floor(savedTokens)
  }

  setSessionOverride(sessionId: string, override?: SessionOverrideConfig): void {
    const state = this.getSessionState(sessionId)
    state.override = override ? { ...override } : undefined
  }

  /** 只读查询：不创建会话条目（子代理会话不该因为查询而常驻内存）。 */
  getSessionOverride(sessionId: string): SessionOverrideConfig | undefined {
    return this.sessions.get(sessionId)?.override
  }

  clearSessionOverride(sessionId: string): void {
    const state = this.sessions.get(sessionId)
    if (state) state.override = undefined
  }

  getSessionMetrics(sessionId: string): SessionMetricsSnapshot {
    const state = this.sessions.get(sessionId) ?? emptyMetrics()
    let executorCalls = state.executorCalls
    let bridgeDelegations = state.bridgeDelegations
    let executorInput = state.executorTokens.inputTokens
    let executorOutput = state.executorTokens.outputTokens
    let bridgePrompt = state.bridgeTokens.promptTokens
    let bridgeCompletion = state.bridgeTokens.completionTokens
    let bridgeTotal = state.bridgeTokens.total
    let bridgeSaved = state.bridgeSavedTokens
    let estimateOnly = state.estimateOnlyCount

    for (const [childId, child] of this.sessions) {
      if (childId === sessionId) continue
      if (!this.isDescendantOf(childId, sessionId)) continue
      executorCalls += child.executorCalls
      bridgeDelegations += child.bridgeDelegations
      executorInput += child.executorTokens.inputTokens
      executorOutput += child.executorTokens.outputTokens
      bridgePrompt += child.bridgeTokens.promptTokens
      bridgeCompletion += child.bridgeTokens.completionTokens
      bridgeTotal += child.bridgeTokens.total
      bridgeSaved += child.bridgeSavedTokens
      estimateOnly += child.estimateOnlyCount
    }

    const totalOffloaded = executorCalls + bridgeDelegations
    return {
      executorCalls,
      executorTokens: { inputTokens: executorInput, outputTokens: executorOutput },
      bridgeDelegations,
      bridgeTokens: { promptTokens: bridgePrompt, completionTokens: bridgeCompletion, total: bridgeTotal },
      bridgeSavedTokens: bridgeSaved,
      estimateOnlyCount: estimateOnly,
      executorSharePercent: totalOffloaded > 0 ? Math.min(99, Math.round((executorCalls / totalOffloaded) * 100)) : 0,
      ...(state.override !== undefined ? { override: { ...state.override } } : {}),
    }
  }

  getGlobalMetrics(): GlobalMetricsSnapshot {
    return {
      executorCalls: this.globalExecutorCalls,
      bridgeDelegations: this.globalBridgeDelegations,
      activeSessions: this.sessions.size,
    }
  }

  resetAll(): void {
    this.sessions.clear()
    this.parents.clear()
    this.globalExecutorCalls = 0
    this.globalBridgeDelegations = 0
  }
}

export const valueRouterState = new ValueRouterStateManager()

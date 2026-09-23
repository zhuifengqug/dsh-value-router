/**
 * 会话级状态与计量（从 value-mode 的 state 移植）。
 *
 * 两类数据：
 * - 会话覆写（顶栏气泡写入，只影响本会话，不污染全局配置）；
 * - 会话计量：executor 路由调用次数（宿主实值）。
 *
 * 桥接通道退役后，桥委派次数 / token 估算 / 节省估算 / estimateOnly 记账与
 * 由此派生的 executor 占比一并删除；只保留可如实陈述的实值计数。
 *
 * 子会话归属：浏览器 header 只知道父会话 id，而子代理的计数记在子会话名下，
 * 因此查询父会话时把后代计数聚合回来。
 */

import type { SessionOverrideConfig } from './config.ts'

export interface SessionValueRouterMetrics {
  executorCalls: number
  override?: SessionOverrideConfig
}

export interface SessionMetricsSnapshot {
  executorCalls: number
  override?: SessionOverrideConfig
}

export interface GlobalMetricsSnapshot {
  executorCalls: number
}

function emptyMetrics(): SessionValueRouterMetrics {
  return { executorCalls: 0 }
}

class ValueRouterStateManager {
  private sessions = new Map<string, SessionValueRouterMetrics>()
  private globalExecutorCalls = 0
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

  /** 记录一次 executor 路由调用。 */
  recordExecutorCall(sessionId?: string): void {
    this.globalExecutorCalls++
    if (!sessionId) return
    this.getSessionState(sessionId).executorCalls++
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

    for (const [childId, child] of this.sessions) {
      if (childId === sessionId) continue
      if (!this.isDescendantOf(childId, sessionId)) continue
      executorCalls += child.executorCalls
    }

    return {
      executorCalls,
      ...(state.override !== undefined ? { override: { ...state.override } } : {}),
    }
  }

  getGlobalMetrics(): GlobalMetricsSnapshot {
    return { executorCalls: this.globalExecutorCalls }
  }

  resetAll(): void {
    this.sessions.clear()
    this.parents.clear()
    this.globalExecutorCalls = 0
  }
}

export const valueRouterState = new ValueRouterStateManager()

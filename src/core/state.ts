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
import { routeKey } from './config.ts'

/** 线路键转出，供既有从 state.ts 导入的调用方使用（定义在 config.ts）。 */
export { routeKey }

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

/**
 * 一个子会话「本插件第一次见到它时」的线路意图快照。
 *
 * 为什么需要它：`agent/request` 的 `next()` 只能给出「本次请求实际会用的线路」，
 * 官方注释明确「首次请求返回 agent options，之后返回 logged header」
 * （dsh-agent/lib/types/runtime-types.d.ts:312-314）。插件一旦在首次请求改写过线路，
 * 后续 step 读到的就是**插件自己写进去的值**，"主控原始意图"就丢了。
 * 必须在改写之前把这个值拍下来。
 */
export interface ChildRouteIntent {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
  /** 首次观察到的 turn/step，仅用于日志与冷恢复诊断。 */
  readonly observedAt: { readonly turn: number; readonly step: number }
  /**
   * 父会话线路 'provider/model'。用于判定「是否与父相同」——而这正是
   * `ambiguousPolicy` 唯一能介入的地方。
   */
  readonly parentRoute: string | undefined
  /**
   * first-seen = 本进程内首次见到该子会话；restored = 插件中途加载/重启后第一次见到，
   * 拿不到真实首请求（next() 此时已是 logged header），只能当近似用。
   */
  readonly source: 'first-seen' | 'restored'
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
  /**
   * 子会话 -> 首次观察到的线路意图。**只在首次观察时写入，永不覆盖**
   * （覆盖等于把插件自己的改写结果当成主控的原始意图）。
   */
  private intents = new Map<string, ChildRouteIntent>()
  /**
   * 轮转序号。key 是**子会话**，值是该子会话在其父会话下的创建序号。
   * 同一个子会话在生命周期内只会分配一次——这是防止多 step 子代理在 step 之间
   * 跳模型的关键（跳模型会让同一段对话历史由不同模型生成，宿主会插入
   * model-switch notice）。因此这里**不是**每次 request 递增的计数器。
   */
  private rotationSlots = new Map<string, number>()
  /** 父会话 -> 已分配出去��轮转序号个数。 */
  private rotationCounters = new Map<string, number>()
  /** 父会话缺失（冷恢复/异常）时的进程级兜底计数器。 */
  private orphanRotationCounter = 0

  /**
   * 取（或首次分配）该子会话的轮转序号。
   *
   * @param childId 子会话 id
   * @param parentId 父会话 id；缺失时退化为进程级单调计数
   */
  rotationIndexOf(childId: string, parentId?: string): number {
    const existing = this.rotationSlots.get(childId)
    if (existing !== undefined) return existing
    let index: number
    if (parentId) {
      index = this.rotationCounters.get(parentId) ?? 0
      this.rotationCounters.set(parentId, index + 1)
    } else {
      index = this.orphanRotationCounter++
    }
    this.rotationSlots.set(childId, index)
    return index
  }

  /** 记录子会话的线路意图；已存在则不覆盖。 */
  rememberIntent(sessionId: string, intent: ChildRouteIntent): void {
    if (!sessionId) return
    if (this.intents.has(sessionId)) return
    this.intents.set(sessionId, intent)
  }

  intentFor(sessionId: string): ChildRouteIntent | undefined {
    return this.intents.get(sessionId)
  }

  /**
   * 给已记录的意图补上父会话线路。已补过或本来就没有父会话时不动。
   *
   * 与 rememberIntent 分开是因为两者时机不同：线路在首次请求就拍下，而父会话
   * 线路要等父会话自己的意图也被记录后才拿得到（子代理先于父会话被观察到的情况
   * 不会发生，但插件中途加载时可能拿不到）。
   */
  attachParentRoute(sessionId: string, parentRoute: string | undefined): void {
    if (parentRoute === undefined) return
    const intent = this.intents.get(sessionId)
    if (intent === undefined || intent.parentRoute !== undefined) return
    this.intents.set(sessionId, { ...intent, parentRoute })
  }

  clearIntent(sessionId: string): void {
    this.intents.delete(sessionId)
    this.rotationSlots.delete(sessionId)
  }

  /**
   * 清理过期的意图与轮转槽位（长跑进程里子会话会无限增长）。
   *
   * Map 保持插入序，所以超限时按 FIFO 淘汰最老的条目即可；不需要时间戳——
   * `ChildRouteIntent.observedAt` 存的是 turn/step 计数，本来就不是时间。
   *
   * @param maxEntries 保留上限
   * @returns 被清理的条目数
   */
  pruneIntents(maxEntries: number): number {
    const overflow = this.intents.size - maxEntries
    if (overflow <= 0) return 0
    let removed = 0
    for (const id of [...this.intents.keys()]) {
      if (removed >= overflow) break
      this.intents.delete(id)
      this.rotationSlots.delete(id)
      removed++
    }
    return removed
  }

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
    this.intents.clear()
    this.rotationSlots.clear()
    this.rotationCounters.clear()
    this.orphanRotationCounter = 0
    this.globalExecutorCalls = 0
  }
}

export const valueRouterState = new ValueRouterStateManager()

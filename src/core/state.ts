/**
 * 进程内状态：子会话线路意图、轮转槽位、派发记录。
 *
 * ## 为什么需要「首次意图」快照
 *
 * `agent/request` 的 `next()` 只能给出「本次请求实际会用的线路」，官方注释明确
 * 「首次请求返回 agent options，之后返回 logged header」。插件一旦在首次请求改写过线路，
 * 后续 step 读到的就是**插件自己写进去的值**，"主控原始意图"就丢了。
 * 因此必须在改写之前把首见值拍下来 —— 这正是 `ChildRouteIntent` 的唯一用途：
 * 判断主控是否**显式指定过**一条与父会话不同的线路（= 新契约里的
 * 「主模型 route 偏好」，`routeSource: 'captain'`）。
 *
 * ## 已退役（0.10.0）
 *
 * 会话级覆写（顶栏气泡写 `strategy` / `executor`）、`ambiguousPolicy` 歧义开关、
 * `executorCalls` 计量一并删除：它们承载的配置字段已经不存在。
 * 「显式指定 == 父模型」的固有歧义现在用**固定规则**消解——
 * 与父相同即视为没指定（无配置开关），与父不同即视为显式指定。
 */

import type { Difficulty } from './config.ts'
import { routeKey } from './config.ts'
import type { RouteSource } from './intent.ts'

/** 线路键转出，供既有从 state.ts 导入的调用方使用（定义在 config.ts）。 */
export { routeKey }

/**
 * 一个子会话「本插件第一次见到它时」的线路意图快照。
 */
export interface ChildRouteIntent {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
  /** 首次观察到的 turn/step，仅用于日志与冷恢复诊断。 */
  readonly observedAt: { readonly turn: number; readonly step: number }
  /** 父会话线路 'provider/model'，用于判定主控是否显式指定过。 */
  readonly parentRoute: string | undefined
  /**
   * first-seen = 本进程内首次见到该子会话；restored = 插件中途加载/重启后第一次见到，
   * 拿不到真实首请求（next() 此时已是 logged header），只能当近似用。
   */
  readonly source: 'first-seen' | 'restored'
}

/** 一次实际发生的线路改写。 */
export interface DispatchRecord {
  /** 被改写的子会话；缺失时记为 '?'。 */
  readonly sessionId: string
  readonly provider: string
  readonly model: string
  readonly reasoning_effort?: string
  /** 决策时使用的难度档。 */
  readonly difficulty: Difficulty
  /** 线路来源（difficulty / captain / fallback…）。 */
  readonly routeSource: RouteSource
  /** 是否走了全局兜底线路。 */
  readonly fallback: boolean
  /** 是否发生了档位降级。 */
  readonly degraded: boolean
  readonly at: number
}

/** 派发记录的最大条数（有界环形，长跑进程不无限增长）。 */
export const MAX_DISPATCH_RECORDS = 50

/** 子会话意图/轮转槽位的内存上限（超出按 FIFO 淘汰最老的）。 */
export const CHILD_INTENT_MAX_ENTRIES = 2_048

class ValueRouterStateManager {
  private routedCalls = 0
  private sessionRoutedCalls = new Map<string, number>()
  private dispatches: DispatchRecord[] = []
  /**
   * 子会话 -> 直接父会话（来自 agent/request 的 session.header.parentSession）。
   * 含环保护，避免异常 lineage 造成死循环。
   */
  private parents = new Map<string, string>()
  /** 子会话 -> 首次观察到的线路意图。**只在首次观察时写入，永不覆盖**。 */
  private intents = new Map<string, ChildRouteIntent>()
  /**
   * 轮转序号。key 是**子会话**，值是该子会话在其父会话下的创建序号。
   * 同一个子会话在生命周期内只会分配一次——防止多 step 子代理在 step 之间跳模型
   * （跳模型会让同一段对话历史由不同模型生成，宿主会插入 model-switch notice）。
   */
  private rotationSlots = new Map<string, number>()
  /** 父会话 -> 已分配出去的轮转序号个数。 */
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

  /**
   * 记录一次**实际改写**的线路——这是「插件到底干了什么」的唯一可观测出口。
   *
   * 为什么必须有：子代理会话头不带模型信息，`subagent` 工具的返回也不带，
   * 所以主控和用户在对话里**无法验证**派发是否真的分散了。改写时 provider/model
   * 就在插件手上，必须把它显示出来，否则这个机制没法被验收。
   */
  recordDispatch(entry: DispatchRecord): void {
    this.routedCalls++
    this.dispatches.push(entry)
    const session = entry.sessionId || '?'
    this.sessionRoutedCalls.set(session, (this.sessionRoutedCalls.get(session) ?? 0) + 1)
    // 有界环形：只留最近若干条，长跑进程不无限增长。
    while (this.dispatches.length > MAX_DISPATCH_RECORDS) this.dispatches.shift()
  }

  /** 最近的实际派发记录，最新的在前。 */
  recentDispatches(limit = 12): DispatchRecord[] {
    return this.dispatches.slice(-limit).reverse()
  }

  /**
   * **某个会话**最近的实际派发记录，最新的在前。
   *
   * 徽章是按会话挂的，所以它要展示的是「这个会话派过什么」而不是全局流水——
   * 混在一起会让人把别的会话的派发误当成自己的。子代理会话自己也会被派发，
   * 因此按 `parentSession` 回溯一层：顶层会话的记录包含它所有后代子代理的记录。
   */
  recentDispatchesFor(sessionId: string, limit = 8): DispatchRecord[] {
    if (!sessionId) return []
    return this.dispatches
      .filter(record => record.sessionId === sessionId || this.isDescendantOf(record.sessionId, sessionId))
      .slice(-limit)
      .reverse()
  }

  /** 本会话（含后代子代理）的改写次数。 */
  routedCallsFor(sessionId: string): number {
    if (!sessionId) return 0
    let total = 0
    for (const [session, count] of this.sessionRoutedCalls) {
      if (session === sessionId || this.isDescendantOf(session, sessionId)) total += count
    }
    return total
  }

  /** 进程级改写次数。 */
  getRoutedCalls(): number {
    return this.routedCalls
  }

  intentFor(sessionId: string): ChildRouteIntent | undefined {
    return this.intents.get(sessionId)
  }

  /**
   * 给已记录的意图补上父会话线路。已补过或本来就没有父会话时不动。
   *
   * 与 rememberIntent 分开是因为两者时机不同：线路在首次请求就拍下，而父会话
   * 线路要等父会话自己的意图也被记录后才拿得到。
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
   * Map 保持插入序，所以超限时按 FIFO 淘汰最老的条目即可。
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

  /** 记录子会话的父会话归属；含环保护。 */
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

  /** 该会话的直接父会话 id。 */
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

  resetAll(): void {
    this.routedCalls = 0
    this.sessionRoutedCalls.clear()
    this.parents.clear()
    this.intents.clear()
    this.rotationSlots.clear()
    this.rotationCounters.clear()
    this.orphanRotationCounter = 0
    this.dispatches.length = 0
  }
}

export const valueRouterState = new ValueRouterStateManager()

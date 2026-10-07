/**
 * 路由审计与派发记录。
 *
 * 两件事分开记：
 * - **决策审计**：`resolveRoute()` 返回的 `audit[]` 挂在任务上（`routeAudit` 字段），随团队状态落盘，
 *   所以"为什么这条任务落在这个模型上"在冷恢复后依然可查。
 * - **运行事件**：`record(event)` 收集跨任务的派发/复用/排队/兜底事件，供设置卡与顶栏展示。
 *   这是一个**有界环形缓冲**：内存里只留最近 N 条，不落盘、不影响路由。
 */

import type { RouteSource, RouteStatus } from './intent.ts'

/** 一次运行事件的类型。 */
export type RouteEventType =
  /** 解析出线路并派发。 */
  | 'dispatch'
  /** 复用了既有空闲成员（没有新建）。 */
  | 'reuse'
  /** 因达到 maxMembers 而排队。 */
  | 'queue'
  /** 使用了全局 fallback。 */
  | 'fallback'
  /** 发生了档位降级。 */
  | 'degrade'
  /** 主模型线路被拒。 */
  | 'route-rejected'
  /** 用户硬路由不可用，任务挂起。 */
  | 'user-route-pending'
  /** 任务被阻塞（非法意图 / 白名单 / 能力不匹配）。 */
  | 'blocked'

/** 一条运行事件。 */
export interface RouteEvent {
  type: RouteEventType
  /** 事件时间（epoch ms）；缺省由缓冲补当前时间。 */
  at?: number
  /** 团队标识。 */
  teamId?: string
  /** 任务标识。 */
  taskId?: string
  /** 成员名。 */
  member?: string
  /** 子代理会话语义标识（普通 subagent 用）。 */
  sessionId?: string
  difficulty?: string
  role?: string
  route?: { provider: string; model: string; reasoning_effort?: string }
  routeSource?: RouteSource
  routeStatus?: RouteStatus
  /** 人读说明；排队原因等就放这里。 */
  detail?: string
  /** 排队原因（`type: 'queue'` 时必填，活动面板直接展示）。 */
  queueReason?: string
}

/** 落库后的事件：时间一定存在。 */
export type RecordedRouteEvent = RouteEvent & { at: number }

/** 运行事件缓冲的默认容量。 */
export const ROUTE_EVENT_CAPACITY = 512

/**
 * 有界事件缓冲。
 *
 * 容量满时丢弃最旧的（FIFO）。**每条事件在写入时被冻结**：审计记录是不可变的证据，
 * 让调用方拿到一个可以随手改掉的对象会让"审计"这件事失效。读取返回新的数组（元素是冻结的）。
 */
export class RouteEventLog {
  private readonly events: RecordedRouteEvent[] = []

  constructor(private readonly capacity: number = ROUTE_EVENT_CAPACITY) {}

  record(event: RouteEvent): RecordedRouteEvent {
    const recorded: RecordedRouteEvent = Object.freeze({
      ...event,
      at: typeof event.at === 'number' ? event.at : Date.now(),
    })
    this.events.push(recorded)
    const overflow = this.events.length - this.capacity
    if (overflow > 0) this.events.splice(0, overflow)
    return recorded
  }

  /** 全部事件（插入顺序）。 */
  list(): RecordedRouteEvent[] {
    return [...this.events]
  }

  /** 按类型过滤。 */
  ofType(type: RouteEventType): RecordedRouteEvent[] {
    return this.events.filter(event => event.type === type)
  }

  /** 按任务过滤（板面按任务展示用）。 */
  forTask(taskId: string): RecordedRouteEvent[] {
    return this.events.filter(event => event.taskId === taskId)
  }

  size(): number {
    return this.events.length
  }

  clear(): void {
    this.events.length = 0
  }
}

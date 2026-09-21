/**
 * 并发、去重与限额协调器（规格 §11）。
 *
 * 防止：多任务同时调用网页端、同一问题重复提交、委派结果再次触发委派（递归）、
 * 超过单任务/全局上限、超时后仍占用任务锁。
 *
 * 纯状态逻辑，时钟可注入，便于离线单测。不直接依赖运行时。
 */

export interface CoordinatorOptions {
  maxDelegationsPerTask: number
  maxConcurrentDelegations: number
  maxDelegationsPerHour: number
  maxRetriesPerRequest: number
  /** 去重窗口（毫秒）：同任务同问题在此窗口内视为重复。 */
  dedupeWindowMs: number
  now?: () => number
}

export interface BeginResult {
  ok: boolean
  reason?: string
}

interface InFlight {
  requestId: string
  taskKey: string
  questionHash: string
  startedAt: number
  retries: number
}

function hash(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

export class DelegationCoordinator {
  private readonly opts: Required<Omit<CoordinatorOptions, 'now'>> & { now: () => number }
  /** taskKey → 已委派次数。 */
  private readonly perTask = new Map<string, number>()
  /** taskKey → questionHash → 最近委派时间。 */
  private readonly seen = new Map<string, Map<string, number>>()
  /** 近一小时的委派时间戳（全局）。 */
  private readonly hourWindow: number[] = []
  /** 在途请求。 */
  private readonly inFlight = new Map<string, InFlight>()
  /** requestId → 重试次数。 */
  private readonly retries = new Map<string, number>()
  /** 并发信号量等待队列。 */
  private waiters: Array<() => void> = []
  private active = 0

  constructor(opts: CoordinatorOptions) {
    this.opts = {
      maxDelegationsPerTask: opts.maxDelegationsPerTask,
      maxConcurrentDelegations: Math.max(1, opts.maxConcurrentDelegations),
      maxDelegationsPerHour: opts.maxDelegationsPerHour,
      maxRetriesPerRequest: opts.maxRetriesPerRequest,
      dedupeWindowMs: opts.dedupeWindowMs,
      now: opts.now ?? Date.now,
    }
  }

  private pruneHour(): void {
    const cutoff = this.opts.now() - 3_600_000
    while (this.hourWindow.length > 0 && (this.hourWindow[0] ?? 0) < cutoff) this.hourWindow.shift()
  }

  taskDelegations(taskKey: string): number {
    return this.perTask.get(taskKey) ?? 0
  }

  hourDelegations(): number {
    this.pruneHour()
    return this.hourWindow.length
  }

  inFlightCount(): number {
    return this.inFlight.size
  }

  /** 决策前的只读检查：是否会因限额/去重被拒。 */
  check(taskKey: string, question: string, hasNewInfo = false): BeginResult {
    if (this.taskDelegations(taskKey) >= this.opts.maxDelegationsPerTask) {
      return { ok: false, reason: '已达单任务委派上限' }
    }
    this.pruneHour()
    if (this.hourWindow.length >= this.opts.maxDelegationsPerHour) {
      return { ok: false, reason: '已达全局每小时委派上限' }
    }
    if (!hasNewInfo && this.isDuplicate(taskKey, question)) {
      return { ok: false, reason: '同一问题在去重窗口内已委派' }
    }
    return { ok: true }
  }

  isDuplicate(taskKey: string, question: string): boolean {
    const h = hash(question)
    const m = this.seen.get(taskKey)
    const last = m?.get(h)
    if (last === undefined) return false
    return this.opts.now() - last < this.opts.dedupeWindowMs
  }

  /** 记录一次委派开始（通过决策后调用）。 */
  begin(requestId: string, taskKey: string, question: string): void {
    const now = this.opts.now()
    this.perTask.set(taskKey, this.taskDelegations(taskKey) + 1)
    this.hourWindow.push(now)
    let m = this.seen.get(taskKey)
    if (!m) {
      m = new Map()
      this.seen.set(taskKey, m)
    }
    m.set(hash(question), now)
    this.inFlight.set(requestId, { requestId, taskKey, questionHash: hash(question), startedAt: now, retries: 0 })
  }

  /** 尝试登记一次重试；超过上限返回 false。 */
  tryRetry(requestId: string): boolean {
    const info = this.inFlight.get(requestId)
    if (!info) return false
    const n = (this.retries.get(requestId) ?? 0) + 1
    if (n > this.opts.maxRetriesPerRequest) return false
    this.retries.set(requestId, n)
    info.retries = n
    return true
  }

  /** 结束一次委派（成功/失败/超时/取消都要调用），释放状态。 */
  end(requestId: string): void {
    this.inFlight.delete(requestId)
    this.retries.delete(requestId)
  }

  /** 获取并发许可（串行化网页端委派）；返回释放函数。 */
  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.active < this.opts.maxConcurrentDelegations) {
      this.active += 1
      return this.makeReleaser()
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        this.waiters = this.waiters.filter((w) => w !== wake)
        reject(new Error('delegation cancelled'))
      }
      const wake = (): void => {
        signal?.removeEventListener?.('abort', onAbort)
        resolve()
      }
      signal?.addEventListener?.('abort', onAbort, { once: true })
      this.waiters.push(wake)
    })
    this.active += 1
    return this.makeReleaser()
  }

  private makeReleaser(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      this.active = Math.max(0, this.active - 1)
      const next = this.waiters.shift()
      if (next) next()
    }
  }

  /** 任务结束时清理其计数与去重记录。 */
  releaseTask(taskKey: string): void {
    this.perTask.delete(taskKey)
    this.seen.delete(taskKey)
    for (const [id, info] of this.inFlight) {
      if (info.taskKey === taskKey) this.inFlight.delete(id)
    }
  }
}

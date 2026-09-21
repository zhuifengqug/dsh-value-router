/**
 * 批次队列：Promise 驱动的后台批量执行引擎。
 *
 * 设计约束（契约 §4）：
 * - 纯 Promise 驱动泵，不用 setInterval/setTimeout 轮询；
 * - submit 立即返回，逐条入参校验（空问题 / 超限 / 重复）；
 * - 状态机 pending → running → done|failed，单条失败不阻塞后续；
 * - usageTotals 为已完成条目累加，任一条 estimateOnly 则批次 estimateOnly = true；
 * - snapshot 返回防御性深拷贝，不泄漏内部可变引用；
 * - releaseTask 清理该任务全部批次记录，运行中条目标记 failed + reason；
 * - dispose 清空所有状态，已在途的 runItem Promise 不会强制终止（它们自然完成后
 *   回调检测 disposed 标记即跳过后续泵操作）。
 *
 * 本模块仅 import ThinkingMode（来自 config.ts），不依赖 bridge.ts 或项目其他模块。
 */

import type { ThinkingMode } from '../core/config.ts'

// ─── 导出类型（契约 §4 冻结接口） ───

export type BatchItemStatus = 'pending' | 'running' | 'done' | 'failed'

export interface BatchItemInput {
  taskType: string
  question: string
  context?: string
  thinking?: ThinkingMode
  webSearch?: boolean
  /** 按次指定模型 id；缺省则由桥按 modelMap 槽位选择。 */
  model?: string
}

export interface BatchItemState {
  index: number
  id: string
  taskType: string
  /** 提交该批次时传入的任务键，供执行方记账 / 清理使用。 */
  taskKey: string
  status: BatchItemStatus
  injectedText?: string
  /** 结构同 bridge.BridgeUsage；queue.ts 不 import bridge.ts，靠结构化类型兼容。 */
  usage?: BatchUsageTotals
  reason?: string
  startedAt?: number
  finishedAt?: number
}

export interface BatchUsageTotals {
  promptTokens: number
  completionTokens: number
  total: number
  estimateOnly: boolean
}

export interface BatchRecord {
  batchId: string
  taskKey: string
  createdAt: number
  items: BatchItemState[]
  usageTotals: BatchUsageTotals
}

export interface BatchRejection {
  index: number
  reason: string
}

export interface BatchSubmitOutcome {
  batchId: string
  accepted: number[]
  rejected: BatchRejection[]
}

export interface BatchQueueOptions {
  getConcurrency: () => number
  /** 单条执行：返回注入文本与 usage；失败时抛错或返回 { ok:false, reason }。 */
  runItem: (
    input: BatchItemInput,
    item: BatchItemState,
  ) => Promise<
    { injectedText: string; usage: BatchUsageTotals } | { ok: false; reason: string }
  >
  now?: () => number
}

// ─── 内部类型 ───

interface InternalItem {
  index: number
  id: string
  taskType: string
  taskKey: string
  question: string
  context?: string
  thinking?: ThinkingMode
  webSearch?: boolean
  model?: string
  status: BatchItemStatus
  injectedText?: string
  usage?: BatchUsageTotals
  reason?: string
  startedAt?: number
  finishedAt?: number
}

interface InternalBatch {
  batchId: string
  taskKey: string
  createdAt: number
  items: InternalItem[]
  usageTotals: BatchUsageTotals
}

// ─── 辅助函数 ───

function zeroUsage(): BatchUsageTotals {
  return { promptTokens: 0, completionTokens: 0, total: 0, estimateOnly: false }
}

/** 从内部条目生成防御性快照（不泄漏可变引用）。 */
function snapshotItem(item: InternalItem): BatchItemState {
  return {
    index: item.index,
    id: item.id,
    taskType: item.taskType,
    taskKey: item.taskKey,
    status: item.status,
    injectedText: item.injectedText,
    usage: item.usage ? { ...item.usage } : undefined,
    reason: item.reason,
    startedAt: item.startedAt,
    finishedAt: item.finishedAt,
  }
}

/** 深拷贝批次记录，供 snapshot() 返回。 */
function copyBatch(batch: InternalBatch): BatchRecord {
  return {
    batchId: batch.batchId,
    taskKey: batch.taskKey,
    createdAt: batch.createdAt,
    items: batch.items.map(snapshotItem),
    usageTotals: { ...batch.usageTotals },
  }
}

// ─── 主类 ───

export class BatchQueue {
  private readonly opts: BatchQueueOptions
  private readonly nowFn: () => number

  /** batchId → 批次（submit 写入，releaseTask / dispose 删除）。 */
  private readonly batches = new Map<string, InternalBatch>()
  /** taskKey → 该任务拥有的 batchId 集合。 */
  private readonly taskBatches = new Map<string, Set<string>>()

  /** batchId 自增序号，保证同一毫秒内唯一。 */
  private seq = 0
  /** 当前正在执行 runItem 的条目数。 */
  private runningCount = 0
  private disposed = false
  /** 泵重入保护。 */
  private pumpGuard = false

  constructor(options: BatchQueueOptions) {
    this.opts = options
    this.nowFn = options.now ?? (() => Date.now())
  }

  /**
   * 提交一批任务，立即返回。
   *
   * 逐条校验：
   * - 空 / 纯空白问题 → rejected，中文原因；
   * - 下标 >= maxItems → rejected；
   * - 同批内问题（trim 后精确匹配）重复 → rejected。
   *
   * accepted 持有通过校验的原始下标，按原始顺序。
   */
  submit(
    taskKey: string,
    inputs: BatchItemInput[],
    maxItems: number,
  ): BatchSubmitOutcome {
    if (this.disposed) {
      return {
        batchId: '',
        accepted: [],
        rejected: inputs.map((_, i) => ({ index: i, reason: '队列已销毁' })),
      }
    }

    const batchId = this.generateBatchId()
    const accepted: number[] = []
    const rejected: BatchRejection[] = []
    const items: InternalItem[] = []
    const seen = new Set<string>()

    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i]!
      const trimmed = (input.question ?? '').trim()

      // 1. 空 / 纯空白问题
      if (trimmed.length === 0) {
        rejected.push({ index: i, reason: '问题不能为空' })
        continue
      }

      // 2. 下标越界
      if (i >= maxItems) {
        rejected.push({ index: i, reason: `超过批次最大条目数 ${maxItems}` })
        continue
      }

      // 3. 同批内重复
      if (seen.has(trimmed)) {
        rejected.push({ index: i, reason: '同批次内存在重复问题' })
        continue
      }
      seen.add(trimmed)

      items.push({
        index: i,
        id: `${batchId}-${i}`,
        taskType: input.taskType,
        taskKey,
        question: trimmed,
        context: input.context,
        thinking: input.thinking,
        webSearch: input.webSearch,
        model: input.model,
        status: 'pending',
      })
      accepted.push(i)
    }

    const batch: InternalBatch = {
      batchId,
      taskKey,
      createdAt: this.nowFn(),
      items,
      usageTotals: zeroUsage(),
    }

    this.batches.set(batchId, batch)

    let set = this.taskBatches.get(taskKey)
    if (!set) {
      set = new Set()
      this.taskBatches.set(taskKey, set)
    }
    set.add(batchId)

    // 触发泵——submit 是泵的唯二手动入口（另一个是完成回调）
    this.pump()

    return { batchId, accepted, rejected }
  }

  /**
   * 返回批次防御性快照（深拷贝），不存在时返回 undefined。
   * 调用方可安全序列化，泵不会篡改返回值。
   */
  snapshot(batchId: string): BatchRecord | undefined {
    const batch = this.batches.get(batchId)
    return batch ? copyBatch(batch) : undefined
  }

  /**
   * 任务结束时调用：删除该任务的全部批次，pending / running 条目
   * 标记为 failed + reason '任务已结束'。
   *
   * 已在途的 runItem Promise 仍会自然完成，但回调检测批次已删除后
   * 会跳过结果写入，仅递减 runningCount。
   */
  releaseTask(taskKey: string): void {
    const batchIds = this.taskBatches.get(taskKey)
    if (!batchIds) return

    for (const batchId of batchIds) {
      const batch = this.batches.get(batchId)
      if (!batch) continue

      for (const item of batch.items) {
        if (item.status === 'pending' || item.status === 'running') {
          item.status = 'failed'
          item.reason = '任务已结束'
          item.finishedAt = this.nowFn()
        }
      }

      this.batches.delete(batchId)
    }

    this.taskBatches.delete(taskKey)
    // 不调整 runningCount——在途回调会自行递减
  }

  /**
   * 卸载：停止泵并清空全部状态。
   * 已在途的 runItem Promise 不会被强制终止（无法 abort），
   * 它们自然完成后回调检测 disposed 标记即跳过。
   */
  dispose(): void {
    this.disposed = true

    for (const batch of this.batches.values()) {
      for (const item of batch.items) {
        if (item.status === 'pending' || item.status === 'running') {
          item.status = 'failed'
          item.reason = '队列已销毁'
          item.finishedAt = this.nowFn()
        }
      }
    }

    this.batches.clear()
    this.taskBatches.clear()
    this.runningCount = 0
  }

  // ─── 私有方法 ───

  private generateBatchId(): string {
    const t = this.nowFn().toString(36)
    const s = (this.seq++).toString(36)
    return `bw-${t}-${s}`
  }

  /**
   * 按批次创建顺序，找第一个 status === 'pending' 的条目。
   * Map 迭代顺序 = 插入顺序，符合 FIFO 语义。
   */
  private findNextPending(): { item: InternalItem; batch: InternalBatch } | undefined {
    for (const batch of this.batches.values()) {
      for (const item of batch.items) {
        if (item.status === 'pending') {
          return { item, batch }
        }
      }
    }
    return undefined
  }

  /**
   * Promise 驱动泵：提交后启动，每条完成后继续下一条，
   * 在途数 < concurrency 时并发派发。
   *
   * 重入保护：pump 由 submit 和完成回调触发，
   * 但自身是同步的（startItem 不 await），因此 pumpGuard 防止重入。
   */
  private pump(): void {
    if (this.pumpGuard || this.disposed) return
    this.pumpGuard = true

    try {
      while (this.runningCount < this.opts.getConcurrency()) {
        const next = this.findNextPending()
        if (!next) break
        this.startItem(next.item, next.batch)
      }
    } finally {
      this.pumpGuard = false
    }
  }

  /**
   * 启动单条执行：fire-and-forget，不 await。
   * 完成回调（.then / .catch）写回结果、递减 runningCount、再次 pump。
   */
  private startItem(item: InternalItem, batch: InternalBatch): void {
    item.status = 'running'
    item.startedAt = this.nowFn()
    this.runningCount++

    const input: BatchItemInput = {
      taskType: item.taskType,
      question: item.question,
      context: item.context,
      thinking: item.thinking,
      webSearch: item.webSearch,
      model: item.model,
    }

    // fire-and-forget：用 void 标记，.catch 兜底防止未处理 rejection
    void this.opts
      .runItem(input, snapshotItem(item))
      .then((result) => {
        // 批次已释放或队列已销毁 → 跳过结果写入
        if (this.disposed || !this.batches.has(batch.batchId)) return

        if ('ok' in result && !result.ok) {
          item.status = 'failed'
          item.reason = result.reason
        } else {
          const ok = result as { injectedText: string; usage: BatchUsageTotals }
          item.status = 'done'
          item.injectedText = ok.injectedText
          item.usage = { ...ok.usage }
          batch.usageTotals.promptTokens += ok.usage.promptTokens
          batch.usageTotals.completionTokens += ok.usage.completionTokens
          batch.usageTotals.total += ok.usage.total
          if (ok.usage.estimateOnly) batch.usageTotals.estimateOnly = true
        }
      })
      .catch((err: unknown) => {
        // runItem 抛错或 reject → 记录失败，不阻塞后续条目
        if (this.disposed || !this.batches.has(batch.batchId)) return
        item.status = 'failed'
        item.reason = err instanceof Error ? err.message : String(err)
      })
      .then(() => {
        // 无论成功 / 失败 / 已释放，都递减并继续泵
        this.runningCount = Math.max(0, this.runningCount - 1)
        if (!this.disposed) this.pump()
      })
  }
}

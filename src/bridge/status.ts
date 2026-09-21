/**
 * GUI 状态快照（v2 规格 §8）。纯逻辑，可离线测试。
 *
 * 只暴露脱敏后的最小必要状态：是否启用、桥健康、当前是否有委派在途、
 * 本次任务剩余次数、累计真实 Token、批次进度、最近一次结果/失败原因。
 * 不默认展示完整请求内容。
 */

export interface DelegationStatusSnapshot {
  enabled: boolean
  autoDelegate: boolean
  /** 桥接服务健康状态。 */
  bridgeStatus: 'up' | 'down' | 'unknown'
  /** 最近一次桥接探测时间（epoch ms）。 */
  bridgeCheckedAt?: number
  /** 桥接探测附加信息（如 HTTP 状态码、超时等）。 */
  bridgeDetail?: string
  /** 当前是否有在途委派。 */
  delegating: boolean
  /** 最近一次任务的已委派次数与上限。 */
  lastTaskDelegations: number
  maxDelegationsPerTask: number
  /** 累计委派次数（所有任务）。 */
  delegationsTotal: number
  /** 桥返回的真实 token 合计（usage 实值或估算值）。 */
  bridgeTokensTotal: { promptTokens: number; completionTokens: number; total: number }
  /** 累计节省 Token（v2 口径：真实记账）。 */
  savedTokensTotal: number
  /** usage 为估算值的委派次数。 */
  estimateOnlyCount: number
  /** 当前批次进度（如有）。 */
  batch?: { batchId: string; done: number; total: number; running: boolean }
  /** 最近一次委派结果：ok / fail / none。 */
  lastOutcome: 'ok' | 'fail' | 'none'
  lastMessage?: string
  lastError?: string
  /** 桥最近一次成功探测到的可用模型 id（上限 20 个）。 */
  availableModels?: string[]
}

export class StatusTracker {
  private enabled = false
  private autoDelegate = false
  private bridgeStatusValue: 'up' | 'down' | 'unknown' = 'unknown'
  private bridgeCheckedAt: number | undefined
  private bridgeDetail: string | undefined
  private lastTaskKey = 'default'
  private lastTaskDelegations = 0
  private delegationsTotal = 0
  private bridgeTokens = { promptTokens: 0, completionTokens: 0, total: 0 }
  private savedTotal = 0
  private estimateOnlyCount = 0
  private batchState: { batchId: string; done: number; total: number; running: boolean } | undefined
  private lastOutcome: 'ok' | 'fail' | 'none' = 'none'
  private lastMessage: string | undefined
  private lastError: string | undefined
  private availableModels: string[] | undefined
  private inflight = 0

  /**
   * 接受当前运行时状态的 getter。
   *
   * 向后兼容：v1 的 src/index.ts 只传 { enabled, autoDelegate, maxDelegationsPerTask,
   * taskDelegations, inFlightCount }；新字段通过可选 getter key 按需传入，
   * 不传时 StatusTracker 使用内部默认值。
   */
  private readonly getEnabled: () => {
    enabled: boolean
    autoDelegate: boolean
    maxDelegationsPerTask: number
    taskDelegations: (k: string) => number
    inFlightCount: () => number
    delegationsTotal?: number
    savedTokensTotal?: number
    bridgeTokensTotal?: { promptTokens: number; completionTokens: number; total: number }
    estimateOnlyCount?: number
  }
  constructor(getEnabled: () => {
    enabled: boolean
    autoDelegate: boolean
    maxDelegationsPerTask: number
    taskDelegations: (k: string) => number
    inFlightCount: () => number
    delegationsTotal?: number
    savedTokensTotal?: number
    bridgeTokensTotal?: { promptTokens: number; completionTokens: number; total: number }
    estimateOnlyCount?: number
  }) {
    this.getEnabled = getEnabled
  }

  noteDelegated(taskKey: string): void {
    this.lastTaskKey = taskKey
    this.lastTaskDelegations = this.getEnabled().taskDelegations(taskKey)
    this.inflight = this.getEnabled().inFlightCount()
    this.delegationsTotal++
  }

  noteSaved(tokens: number): void {
    if (Number.isFinite(tokens) && tokens > 0) this.savedTotal += Math.floor(tokens)
  }

  noteOutcome(outcome: 'ok' | 'fail', message?: string): void {
    this.lastOutcome = outcome
    this.lastMessage = message
    this.inflight = this.getEnabled().inFlightCount()
  }

  /** 记录桥健康探测结果（含可用模型列表副本）。 */
  noteBridgeHealth(health: { status: 'up' | 'down' | 'unknown'; checkedAt: number; detail?: string; models?: string[] }): void {
    this.bridgeStatusValue = health.status
    this.bridgeCheckedAt = health.checkedAt
    this.bridgeDetail = health.detail
    this.availableModels = health.models?.slice()
  }

  /** 累加桥返回的真实 token 用量。 */
  noteUsage(usage: { promptTokens: number; completionTokens: number; total: number; estimateOnly: boolean }): void {
    this.bridgeTokens.promptTokens += usage.promptTokens
    this.bridgeTokens.completionTokens += usage.completionTokens
    this.bridgeTokens.total += usage.total
    if (usage.estimateOnly) this.estimateOnlyCount++
  }

  /** 更新批次进度（传 undefined 清除）。 */
  noteBatch(progress: { batchId: string; done: number; total: number; running: boolean } | undefined): void {
    this.batchState = progress
  }

  /** 记录最近错误。 */
  noteError(message: string): void {
    this.lastError = message
  }

  snapshot(): DelegationStatusSnapshot {
    const cfg = this.getEnabled()
    this.enabled = cfg.enabled
    this.autoDelegate = cfg.autoDelegate
    this.lastTaskDelegations = cfg.taskDelegations(this.lastTaskKey)
    this.inflight = cfg.inFlightCount()
    return {
      enabled: this.enabled,
      autoDelegate: this.autoDelegate,
      bridgeStatus: this.bridgeStatusValue,
      ...(this.bridgeCheckedAt != null ? { bridgeCheckedAt: this.bridgeCheckedAt } : {}),
      ...(this.bridgeDetail != null ? { bridgeDetail: this.bridgeDetail } : {}),
      delegating: this.inflight > 0,
      lastTaskDelegations: this.lastTaskDelegations,
      maxDelegationsPerTask: cfg.maxDelegationsPerTask,
      delegationsTotal: this.delegationsTotal,
      bridgeTokensTotal: { ...this.bridgeTokens },
      savedTokensTotal: this.savedTotal,
      estimateOnlyCount: this.estimateOnlyCount,
      ...(this.batchState != null ? { batch: { ...this.batchState } } : {}),
      lastOutcome: this.lastOutcome,
      ...(this.lastMessage != null ? { lastMessage: this.lastMessage } : {}),
      ...(this.lastError != null ? { lastError: this.lastError } : {}),
      ...(this.availableModels != null ? { availableModels: this.availableModels } : {}),
    }
  }
}

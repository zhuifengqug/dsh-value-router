/**
 * Token 记账（v2 重构）。
 *
 * v1：全部是基于字符数的启发式估算（网页端无法获取真实 usage）。
 * v2：优先使用桥返回的真实 usage（estimateOnly=false）；仅 usage 缺失时回退估算。
 *
 * 纯函数，不依赖运行时。
 */

// —————————————————————————— 基础估算 ——————————————————————————

/** 粗略估算一段文本的 token 数：CJK 约 1 字 ≈ 1 token，拉丁约 4 字符 ≈ 1 token。 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  let other = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    // 常见中日韩区间
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3040 && code <= 0x30ff)
    ) {
      cjk += 1
    } else if (!/\s/.test(ch)) {
      other += 1
    }
  }
  return Math.max(1, Math.round(cjk + other / 4))
}

// —————————————————————————— v1 旧接口（保留，decision 预估算仍使用） ——————————————————————————

export interface TokenSavingRecord {
  primaryModelEstimatedTokens: number
  delegatedWebEstimatedTokens: number
  estimatedSavedTokens: number
  delegatedAt: string
  taskType: string
  /** 明确标记：这是估算值，不是精确账单。 */
  estimateOnly: true
}

/**
 * 估算一次委派节省的主模型 Token（v1 口径）。
 *
 * 口径：主模型若自己处理这个子问题，需要把「输入上下文 + 预期输出」都放进
 * 自己的上下文并生成；委派后主模型只需消费压缩后的结果。
 *   saved ≈ (输入估算 + 网页回答估算) − 注入结果估算
 * 结果为负时按 0 处理（委派反而更贵，决策层会据此拒绝）。
 */
export function buildSavingRecord(args: {
  inputText: string
  webAnswerText: string
  injectedResultText: string
  taskType: string
  now?: () => string
}): TokenSavingRecord {
  const inputTokens = estimateTokens(args.inputText)
  const answerTokens = estimateTokens(args.webAnswerText)
  const injectedTokens = estimateTokens(args.injectedResultText)
  const primary = inputTokens + answerTokens
  const saved = Math.max(0, primary - injectedTokens)
  return {
    primaryModelEstimatedTokens: primary,
    delegatedWebEstimatedTokens: answerTokens,
    estimatedSavedTokens: saved,
    delegatedAt: (args.now ?? (() => new Date().toISOString()))(),
    taskType: args.taskType,
    estimateOnly: true,
  }
}

// —————————————————————————— v2 新增：真实计量 ——————————————————————————

/** 桥返回的 usage 接口（兼容 OpenAI 格式）。 */
export interface BridgeUsageLike {
  promptTokens: number
  completionTokens: number
  total: number
}

/**
 * 一次委派的完整 token 记账。
 *
 * 「节省」口径（v2 修正）：
 *   savedEstimate = primaryModelDirectEstimate − mainModelOverheadEstimate
 *
 *  - primaryModelDirectEstimate：主模型若自己回答的估算成本 = 输入估算 × 2.5
 *    （输入 + 预期输出约为输入的 1.5 倍）。
 *  - mainModelOverheadEstimate：主模型搬运开销 = 本次工具入参（question + context）的估算
 *    + 返回文本（injectedText）的估算。
 *  - 节省 = 主模型直接答的成本 − 搬运开销，下限 0。
 *
 * 说明：v1 的"估算节省"未计搬运开销（webPrompt 输出两遍、答案原文输出两遍），
 * 导致口径失真。v2 口径必须写入字段说明，避免重犯。
 */
export interface TokenAccounting {
  /** 桥返回的真实 usage（缺失时为估算值，见 estimateOnly）。 */
  bridgeUsageActual: BridgeUsageLike
  /**
   * 主模型搬运开销：本次工具入参（question + context）+ 返回（injectedText）的估算。
   */
  mainModelOverheadEstimate: number
  /**
   * 主模型若自己回答的估算成本：输入 + 预期输出（输入估算 × 2.5）。
   */
  primaryModelDirectEstimate: number
  /**
   * 节省 = primaryModelDirectEstimate − mainModelOverheadEstimate，下限 0。
   * 口径：主模型直接答的成本减去搬运桥结果的开销。若桥结果比自答更贵（罕见），返回 0。
   */
  savedEstimate: number
  /**
   * true = 桥未返回真实 usage，此条记账全部为估算值。
   * 当桥返回 usage 时为 false（即使搬运开销本身是估算的）。
   */
  estimateOnly: boolean
}

/**
 * 构建一次委派的完整 token 记账（纯函数）。
 *
 * @param question    工具入参中的问题文本
 * @param context     工具入参中的上下文（可选）
 * @param answerText  桥返回的原始答案文本（用于桥 usage 缺失时估算）
 * @param injectedText 压缩后注入主模型的文本（用于搬运开销估算）
 * @param usage       桥返回的 usage（可选，缺失时全部为估算）
 * @param usageEstimateOnly 外部强制标记为估算（可选，默认按 usage 是否存在推断）
 */
export function buildAccounting(args: {
  question: string
  context?: string
  answerText: string
  injectedText: string
  usage?: BridgeUsageLike
  usageEstimateOnly?: boolean
}): TokenAccounting {
  // 桥 usage：优先用真实值，缺失时用 answerText 估算
  const bridgeUsageActual: BridgeUsageLike = args.usage ?? {
    promptTokens: estimateTokens(args.question + (args.context ?? '')),
    completionTokens: estimateTokens(args.answerText),
    total: estimateTokens(args.question + (args.context ?? '')) + estimateTokens(args.answerText),
  }

  // 搬运开销 = 入参估算 + 返回文本估算
  const inputTokens = estimateTokens(args.question + (args.context ?? ''))
  const injectedTokens = estimateTokens(args.injectedText)
  const mainModelOverheadEstimate = inputTokens + injectedTokens

  // 主模型直接答的估算成本 = 输入估算 × 2.5
  const primaryModelDirectEstimate = Math.round(inputTokens * 2.5)

  // 节省 = 直接成本 − 搬运开销，下限 0
  const savedEstimate = Math.max(0, primaryModelDirectEstimate - mainModelOverheadEstimate)

  const estimateOnly = args.usageEstimateOnly ?? (args.usage === undefined)

  return {
    bridgeUsageActual,
    mainModelOverheadEstimate,
    primaryModelDirectEstimate,
    savedEstimate,
    estimateOnly,
  }
}

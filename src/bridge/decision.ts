/**
 * 自动委派决策引擎（v2 规格 §7）。
 *
 * 明确、可解释的规则；任一硬门槛不满足即不委派；判断不明确时默认不委派。
 * 不只看关键词：调用方需给出结构化事实（是否需要本地工具、是否含凭据等），
 * 这些事实由模型在调用工具时提供，并由插件对上下文做独立脱敏扫描兜底。
 *
 * v2 变更：删除浏览器路径（browserAvailable/browserLoggedIn），新增桥健康门控；
 * 删除确认流（全自动形态）；删除 webPrompt 产出（v2 由 bridge 组装请求）。
 *
 * 纯函数，不依赖运行时。
 */

import type { ResolvedValueRouterConfig, RiskLevel } from '../core/config.ts'
import { redact } from './redact.ts'
import { estimateTokens } from './tokens.ts'

export interface DelegationFacts {
  taskType: string
  question: string
  /** 候选上下文（未脱敏），决策前会独立扫描 + 脱敏。 */
  context: string
  constraints?: string[]
  /** 是否需要本地工具/文件/命令/数据库/仓库修改。 */
  needsLocalTools?: boolean
  /** 是否依赖当前项目私有上下文。 */
  requiresProjectContext?: boolean
  /** 是否需要连续多轮规划。 */
  multiStepPlanning?: boolean
  /** 是否要求事实准确性为高风险。 */
  accuracyCritical?: boolean
  /** 是否让外部模型代替主模型做最终决策。 */
  finalDecision?: boolean
  /** 本次任务已委派次数。 */
  delegationsThisTask?: number
  /** 全局近一小时已委派次数。 */
  delegationsThisHour?: number
  /** 该问题是否此前已委派且无新增信息。 */
  isDuplicate?: boolean
  /** 桥健康状态（v2 新增）。unknown 不直接拒绝，交由调用方先探活。 */
  bridgeHealth?: 'up' | 'down' | 'unknown'
}

export interface DelegationDecision {
  shouldDelegate: boolean
  reason: string
  taskType: string
  estimatedInputTokens: number
  estimatedSavedTokens: number
  risk: RiskLevel
  /** 脱敏后的上下文（仅当允许发送时非空）。 */
  redactedContext: string
  /** 脱敏命中的类别。 */
  redactionCategories: string[]
  /** 硬阻断（凭据/黑名单/本地工具等）：不得自动发送。 */
  hardBlocked: boolean
}

function decide(config: ResolvedValueRouterConfig, facts: DelegationFacts): DelegationDecision {
  const taskType = (facts.taskType ?? '').trim() || 'unknown'
  const question = (facts.question ?? '').trim()
  const rawContext = facts.context ?? ''

  const red = redact(rawContext)
  const redQ = redact(question)
  const redactedContext = red.hasSensitive ? red.text : rawContext
  const categories = [...new Set([...red.categories, ...redQ.categories])]
  const hasCredential = red.hasCredential || redQ.hasCredential

  const base = {
    taskType,
    redactionCategories: categories,
    redactedContext,
    estimatedInputTokens: 0,
    estimatedSavedTokens: 0,
  } as const

  const finish = (
    shouldDelegate: boolean,
    reason: string,
    risk: RiskLevel,
    hardBlocked: boolean,
    saved = 0,
  ): DelegationDecision => ({
    ...base,
    shouldDelegate,
    reason,
    risk,
    hardBlocked,
    estimatedSavedTokens: saved,
    estimatedInputTokens: estimateTokens(question + '\n' + redactedContext),
  })

  // —— 硬门槛 ——
  if (!config.enabled) return finish(false, '网页端协作未启用。', 'low', false)
  if (!config.autoDelegate) {
    return finish(false, '自动委派开关已关闭，仅可在用户明确要求时手动使用。', 'low', false)
  }
  if (!question) return finish(false, '问题为空。', 'low', true)
  if (config.blockedTaskTypes.includes(taskType)) {
    return finish(false, `任务类型「${taskType}」在禁止自动委派清单中。`, 'high', true)
  }
  if (!config.allowedTaskTypes.includes(taskType)) {
    return finish(false, `任务类型「${taskType}」不在允许自动委派清单中，默认交由主模型。`, 'medium', false)
  }
  if (hasCredential) {
    return finish(false, '上下文含凭据/密钥/令牌/私钥，禁止发送到外部模型。', 'high', true)
  }
  if (facts.needsLocalTools) {
    return finish(false, '子问题需要本地工具/文件/命令/数据库，无法委派。', 'high', true)
  }
  if (facts.requiresProjectContext) {
    return finish(false, '子问题依赖当前项目私有上下文，不适合外发。', 'high', true)
  }
  if (facts.multiStepPlanning) {
    return finish(false, '子问题需要连续多轮规划，应留在主模型。', 'medium', true)
  }
  if (facts.finalDecision) {
    return finish(false, '不允许外部模型代替主模型做最终决策。', 'high', true)
  }
  if (facts.isDuplicate) {
    return finish(false, '同一问题此前已委派且无新增信息，避免重复提问与递归。', 'low', true)
  }

  // —— 桥健康门控（v2 新增）——
  // down → 明确拒绝；unknown 不直接拒绝，交由调用方（ask 工具）先探活。
  if (facts.bridgeHealth === 'down') {
    return finish(false, '桥接服务不可用（down），请检查 Chat2API 是否正在运行，或由主模型直接处理。', 'low', false)
  }

  // —— 限额 ——
  const used = facts.delegationsThisTask ?? 0
  if (used >= config.maxDelegationsPerTask) {
    return finish(false, `已达本次任务委派上限（${config.maxDelegationsPerTask}）。`, 'low', false)
  }
  const hourUsed = facts.delegationsThisHour ?? 0
  if (hourUsed >= config.maxDelegationsPerHour) {
    return finish(false, `已达全局每小时委派上限（${config.maxDelegationsPerHour}）。`, 'low', false)
  }

  // —— 上下文规模与代码/文件策略 ——
  if (rawContext.length > config.maxInputCharacters && !config.allowCodeSnippet) {
    return finish(false, '上下文超出上限且未开启发送代码片段，交由主模型。', 'medium', false)
  }

  // —— 收益门槛：估算节省 Token ——
  // 与 tokens.ts 的 buildAccounting 完全同口径：
  //   overheadEst = inputEst + injectEst  （搬运开销 = 工具入参 + 工具返回）
  //   saved = primaryEst − overheadEst    （主模型自答成本 − 搬运开销）
  // 注入块（来源标记 + 结论 + 置信度 + 注意事项 + 给主模型的提示）有固定开销，
  // 实机实测约 200 token；短问句因这个固定开销会被判定为不值得委派。
  // （200 是经验下限，非账单数据。）
  const INJECTION_FLOOR_TOKENS = 200
  const sendableContext = redactedContext.slice(0, config.maxInputCharacters)
  const inputEst = estimateTokens(question + '\n' + sendableContext)
  const primaryEst = Math.round(inputEst * 2.5)                                  // 主模型自答：输入 + 预期输出
  const injectEst = Math.max(Math.round(inputEst * 0.3), INJECTION_FLOOR_TOKENS) // 注入结果，含固定开销下限
  const overheadEst = inputEst + injectEst                                       // 搬运开销 = 工具入参 + 工具返回
  const estimatedSavedTokens = Math.max(0, primaryEst - overheadEst)
  if (estimatedSavedTokens < config.minEstimatedSavedTokens) {
    return finish(false, `估算节省 Token（约 ${estimatedSavedTokens}）低于阈值（${config.minEstimatedSavedTokens}），不值得委派。`, 'low', false, estimatedSavedTokens)
  }

  // —— 风险评估（v2：全自动，无确认步骤） ——
  let risk: RiskLevel = 'low'
  if (facts.accuracyCritical) risk = 'medium'
  if (categories.length > 0) risk = risk === 'low' ? 'medium' : risk

  return finish(true, '满足自动委派条件：低风险、独立、可脱敏、收益达阈值、桥可用、未超限。', risk, false, estimatedSavedTokens)
}

export const decideDelegation = decide

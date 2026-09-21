/**
 * bridge_ask 工具 + 共享委派管道。
 *
 * 一次调用闭环：决策门控 → 脱敏 → 限额/去重 → bridge.chat → 压缩 →
 * 来源标记 → 真实计量 → 状态记账 → 释放锁。
 *
 * 共享管道 runDelegation 由 batch.ts 复用。
 * 注释用中文，标识符用英文。
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ResolvedValueRouterConfig, ThinkingMode } from '../core/config.ts'
import { decideDelegation, type DelegationFacts } from '../bridge/decision.ts'
import type { BridgeClient, BridgeResult } from '../bridge/bridge.ts'
import type { DelegationCoordinator } from '../bridge/limits.ts'
import type { StatusTracker } from '../bridge/status.ts'
import type { BatchQueue } from '../bridge/queue.ts'
import { compressAnswer, renderInjection } from '../bridge/compress.ts'
import { buildAccounting, type TokenAccounting } from '../bridge/tokens.ts'

// —————————————————————————— 共享管道类型 ——————————————————————————

/** 一次委派的完整结果。 */
export interface DelegationOutcome {
  ok: boolean
  injectedText?: string
  conversationRef?: string
  thinkingUsed: boolean
  webSearchUsed: boolean
  usage: { promptTokens: number; completionTokens: number; total: number; estimateOnly: boolean }
  accounting: TokenAccounting
  requestId: string
  reason?: string
  degraded: boolean
}

/** 委派管道运行时依赖。 */
export interface DelegationRuntime {
  getConfig(): ResolvedValueRouterConfig
  coordinator: DelegationCoordinator
  bridge: BridgeClient
  status: StatusTracker
  batches: BatchQueue
  nextRequestId(): string
  /**
   * 记账回调（可选）：把「本会话的桥委派次数/token/节省」写进会话级计量，
   * 供顶栏徽章读取。taskKey = 调用方会话 id。
   */
  noteAccounted?(
    taskKey: string,
    usage: { promptTokens: number; completionTokens: number; total: number; estimateOnly: boolean },
    savedEstimate: number,
  ): void
}

// —————————————————————————— 共享管道实现 ——————————————————————————

/** 零值 usage（失败/拒绝时使用）。 */
const ZERO_USAGE = { promptTokens: 0, completionTokens: 0, total: 0, estimateOnly: false }

/**
 * 完整委派管道：bridge.chat → 压缩 → 来源标记 → 真实计量 → 状态记账 → 释放锁。
 *
 * 每条路径必须调用 coordinator.end(requestId) 恰好一次。
 * 任何异常不逃逸：包裹后转为 { ok:false, degraded:true, reason }。
 */
export async function runDelegation(
  rt: DelegationRuntime,
  taskKey: string,
  input: {
    requestId: string
    taskType: string
    question: string
    context: string
    thinking: ThinkingMode
    webSearch: boolean
    /** 按次指定模型 id；缺省则由桥按 modelMap 槽位选择。 */
    model?: string
    continueFromRequestId?: string
    signal?: AbortSignal
  },
): Promise<DelegationOutcome> {
  const { requestId, taskType, question, context, thinking, webSearch, model, continueFromRequestId, signal } = input
  const config = rt.getConfig()

  try {
    // 1. 调用桥接（model 有值时透传，桥直接使用该 id）
    const chatReq: Record<string, unknown> = {
      requestId,
      taskType,
      question,
      context,
      thinking,
      webSearch,
      continueFromRequestId,
      signal,
    }
    if (model) chatReq.model = model
    const answer: BridgeResult = await rt.bridge.chat(chatReq as unknown as Parameters<typeof rt.bridge.chat>[0])

    // 2. 桥接失败 → 释放锁 + 记录错误 + 返回降级结果
    if (!answer.ok) {
      rt.coordinator.end(requestId)
      rt.status.noteError(answer.reason)
      return {
        ok: false,
        thinkingUsed: false,
        webSearchUsed: false,
        usage: ZERO_USAGE,
        accounting: buildAccounting({ question, context, answerText: '', injectedText: '' }),
        requestId,
        reason: `${answer.reason}（请由主模型直接完成该子问题，fallbackMode）`,
        degraded: true,
      }
    }

    // 3. 压缩 + 来源标记（用桥回填的实际模型 id）
    const compressed = compressAnswer({
      rawAnswer: answer.text,
      question,
      taskType,
      model: answer.model,
      requestId,
      createdAt: new Date().toISOString(),
      maxResultCharacters: config.maxResultCharacters,
    })
    let injectedText = renderInjection(compressed, question, taskType)

    // 4. 思考摘要（thinking='on' 且桥返回 reasoning 时追加）
    if (thinking === 'on' && answer.reasoning) {
      injectedText += `\n\n【思考摘要（外部模型，未验证）】\n${answer.reasoning}`
    }

    // 5. 构建记账
    const usage = answer.usage
    const accounting = buildAccounting({
      question,
      context,
      answerText: answer.text,
      injectedText,
      usage: { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, total: usage.total },
      usageEstimateOnly: usage.estimateOnly,
    })

    // 6. 状态记账 + 释放锁
    rt.status.noteUsage(usage)
    rt.status.noteSaved(accounting.savedEstimate)
    rt.status.noteOutcome('ok')
    rt.noteAccounted?.(taskKey, usage, accounting.savedEstimate)
    rt.coordinator.end(requestId)

    return {
      ok: true,
      injectedText,
      conversationRef: answer.conversationRef,
      thinkingUsed: answer.thinkingUsed,
      webSearchUsed: answer.webSearchUsed,
      usage: { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, total: usage.total, estimateOnly: usage.estimateOnly },
      accounting,
      requestId,
      degraded: false,
    }
  } catch (err: unknown) {
    // 异常兜底：释放锁 + 记录错误 + 返回降级
    rt.coordinator.end(requestId)
    const reason = err instanceof Error ? err.message : String(err)
    rt.status.noteError(reason)
    return {
      ok: false,
      thinkingUsed: false,
      webSearchUsed: false,
      usage: ZERO_USAGE,
      accounting: buildAccounting({ question, context, answerText: '', injectedText: '' }),
      requestId,
      reason: `${reason}（请由主模型直接完成该子问题，fallbackMode）`,
      degraded: true,
    }
  }
}

// —————————————————————————— bridge_ask 工具 ——————————————————————————

export function createAskTool(rt: DelegationRuntime): ToolDefinition {
  return defineTool({
    name: 'bridge_ask',
    description:
      '判断某个独立子问题是否适合经本地桥接（Chat2API）交给网页端模型以节省主模型 Token。' +
      '传入子问题、任务类型与结构化事实（是否需要本地工具/项目上下文等）。' +
      '插件会做可解释判断、脱敏与限额；通过后经桥接获取回答并压缩回注。' +
      '不通过时请由你直接处理。不得绕过本工具发送凭据或敏感内容。',
    parameters: {
      taskType: {
        type: 'string',
        required: true,
        description: '子问题类型，如 general-knowledge / explanation / simple-comparison / text-transformation / regex-generation / api-usage-example / copy-polish。',
      },
      question: { type: 'string', required: true, description: '要交给网页端模型的独立子问题（一次问答可完成）。' },
      context: { type: 'string', description: '完成该子问题所需的最小背景/输入片段（未脱敏原文，插件会自动脱敏与截断）。不要发送完整会话历史或凭据。' },
      needsLocalTools: { type: 'boolean', description: '是否需要本地文件/命令/数据库/仓库操作。为 true 时不委派。' },
      requiresProjectContext: { type: 'boolean', description: '是否依赖当前项目私有上下文。为 true 时不委派。' },
      multiStepPlanning: { type: 'boolean', description: '是否需要连续多轮规划。为 true 时不委派。' },
      accuracyCritical: { type: 'boolean', description: '是否为需要保证事实准确性的高风险问题。' },
      finalDecision: { type: 'boolean', description: '是否试图让外部模型代替主模型做最终决策。为 true 时不委派。' },
      hasNewInfo: { type: 'boolean', description: '若此前委派过同一问题但本次有新增信息，置 true 以跳过去重。' },
      thinking: { type: 'string', description: "思考模式：'off' | 'on' | 'silent'，默认取配置 defaultThinking。" },
      webSearch: { type: 'boolean', description: '是否启用联网搜索（默认 false）。' },
      continueFromRequestId: { type: 'string', description: '先前成功的 requestId，用于服务端接续追问。' },
      model: { type: 'string', description: '按次指定桥上的模型 id（缺省按配置的 modelMap 槽位选择）。可用 id 见桥的 /v1/models；写错时错误信息会列出可用模型。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          requestId: { type: 'string', required: true },
          injectedText: { type: 'string' },
          thinkingUsed: { type: 'boolean' },
          webSearchUsed: { type: 'boolean' },
          bridgeUsage: {
            type: 'object',
            additionalProperties: false,
            properties: {
              promptTokens: { type: 'number' },
              completionTokens: { type: 'number' },
              total: { type: 'number' },
              estimateOnly: { type: 'boolean' },
            },
          },
          mainModelOverheadEstimate: { type: 'number' },
          savedEstimate: { type: 'number' },
          estimateOnly: { type: 'boolean' },
          conversationRef: { type: 'string' },
          remainingDelegations: { type: 'number' },
          degraded: { type: 'boolean' },
          reason: { type: 'string' },
        },
      },
      render(_args, value) {
        const v = value as {
          ok: boolean
          requestId: string
          injectedText?: string
          bridgeUsage?: { promptTokens: number; completionTokens: number; total: number }
          mainModelOverheadEstimate?: number
          savedEstimate?: number
          reason?: string
          degraded?: boolean
        }
        if (!v.ok) {
          return [{ type: 'text', text: `降级：${v.reason ?? '桥接不可用'}，请由主模型直接完成该子问题。` }]
        }
        const u = v.bridgeUsage ?? { promptTokens: 0, completionTokens: 0, total: 0 }
        const overhead = v.mainModelOverheadEstimate ?? 0
        const saved = v.savedEstimate ?? 0
        return [
          { type: 'text', text: v.injectedText ?? '' },
          { type: 'text', text: `（桥：prompt ${u.promptTokens} + completion ${u.completionTokens} = ${u.total} token；主模型搬运估算 ${overhead}；估算节省 ${saved}）` },
        ]
      },
    },
    async execute(rawArgs, exec) {
      const args = rawArgs as {
        taskType?: string
        question?: string
        context?: string
        needsLocalTools?: boolean
        requiresProjectContext?: boolean
        multiStepPlanning?: boolean
        accuracyCritical?: boolean
        finalDecision?: boolean
        hasNewInfo?: boolean
        thinking?: ThinkingMode
        webSearch?: boolean
        continueFromRequestId?: string
        model?: string
      }
      const config = rt.getConfig()
      const taskKey = (exec as { sessionId?: string }).sessionId ?? 'default'
      const question = (args.question ?? '').trim()

      // 兜底拒绝结果（不触碰 coordinator）
      const refuse = (reason: string, degraded = false) => ({
        ok: false as const,
        requestId: '' as string,
        injectedText: undefined as string | undefined,
        thinkingUsed: false,
        webSearchUsed: false,
        bridgeUsage: ZERO_USAGE,
        mainModelOverheadEstimate: 0,
        savedEstimate: 0,
        estimateOnly: true,
        conversationRef: undefined as string | undefined,
        remainingDelegations: Math.max(0, config.maxDelegationsPerTask - rt.coordinator.taskDelegations(taskKey)),
        degraded,
        reason,
      })

      // —— 桥健康探测：unknown 时先探活 ——
      const h = rt.bridge.health()
      if (h.status === 'unknown') {
        const health = await rt.bridge.probeHealth(true)
        rt.status.noteBridgeHealth(health)
      }
      const bridgeHealth = rt.bridge.health().status

      // —— 决策门控 ——
      const facts: DelegationFacts = {
        taskType: args.taskType ?? '',
        question,
        context: args.context ?? '',
        needsLocalTools: args.needsLocalTools,
        requiresProjectContext: args.requiresProjectContext,
        multiStepPlanning: args.multiStepPlanning,
        accuracyCritical: args.accuracyCritical,
        finalDecision: args.finalDecision,
        delegationsThisTask: rt.coordinator.taskDelegations(taskKey),
        delegationsThisHour: rt.coordinator.hourDelegations(),
        isDuplicate: rt.coordinator.isDuplicate(taskKey, question) && !args.hasNewInfo,
        bridgeHealth,
      }
      const decision = decideDelegation(config, facts)

      // 决策拒绝 → 不触碰 coordinator；桥 down 时标记 degraded 与系统提示段一致
      if (!decision.shouldDelegate) {
        return refuse(decision.reason, bridgeHealth === 'down')
      }

      // —— 通过决策：登记并执行 ——
      const requestId = rt.nextRequestId()
      rt.coordinator.begin(requestId, taskKey, question)
      rt.status.noteDelegated(taskKey)

      const thinking: ThinkingMode = (args.thinking ?? config.defaultThinking) as ThinkingMode
      const webSearch = args.webSearch ?? false

      const result = await runDelegation(rt, taskKey, {
        requestId,
        taskType: decision.taskType,
        question,
        context: decision.redactedContext,
        thinking,
        webSearch,
        model: args.model,
        continueFromRequestId: args.continueFromRequestId,
      })

      // 剩余次数（执行后计算）
      const remainingDelegations = Math.max(0, config.maxDelegationsPerTask - rt.coordinator.taskDelegations(taskKey))

      if (!result.ok) {
        return {
          ok: false,
          requestId,
          injectedText: undefined as string | undefined,
          thinkingUsed: result.thinkingUsed,
          webSearchUsed: result.webSearchUsed,
          bridgeUsage: result.usage,
          mainModelOverheadEstimate: result.accounting.mainModelOverheadEstimate,
          savedEstimate: result.accounting.savedEstimate,
          estimateOnly: result.accounting.estimateOnly,
          conversationRef: undefined as string | undefined,
          remainingDelegations,
          degraded: result.degraded,
          reason: result.reason,
        }
      }

      // 成功
      return {
        ok: true,
        requestId,
        injectedText: result.injectedText,
        thinkingUsed: result.thinkingUsed,
        webSearchUsed: result.webSearchUsed,
        bridgeUsage: result.usage,
        mainModelOverheadEstimate: result.accounting.mainModelOverheadEstimate,
        savedEstimate: result.accounting.savedEstimate,
        estimateOnly: result.accounting.estimateOnly,
        conversationRef: result.conversationRef as string | undefined,
        remainingDelegations,
        degraded: false,
      }
    },
  })
}

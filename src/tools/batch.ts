/**
 * bridge_batch + bridge_batch_result 工具（v2 契约 §6.2/§6.3）。
 *
 * - batch：立即返回，逐条决策 + 限额预检 + 提交到后台队列。
 * - batch_result：轮询批次进度，返回逐条状态与 usageTotals。
 *
 * 执行复用 ask.ts 的完整管道（脱敏/压缩/计量/来源标记）。
 * 注释用中文，标识符用英文。
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ThinkingMode } from '../core/config.ts'
import { decideDelegation, type DelegationFacts } from '../bridge/decision.ts'
import type { DelegationRuntime } from './ask.ts'
import { runDelegation } from './ask.ts'

// —————————————————————————— 深拷贝辅助 ——————————————————————————

interface BatchItemInputLocal {
  taskType: string
  question: string
  context?: string
  thinking?: ThinkingMode
  webSearch?: boolean
  /** 按次指定模型 id；缺省则由桥按 modelMap 槽位选择。 */
  model?: string
}

// —————————————————————————— bridge_batch ——————————————————————————

export function createBatchTool(rt: DelegationRuntime): ToolDefinition {
  return defineTool({
    name: 'bridge_batch',
    description:
      '批量提交多个独立子问题经本地桥接（Chat2API）交给网页端模型。' +
      '传入 items 数组（上限由 bridge.maxBatchItems 配置）。' +
      '立即返回 batchId 与逐条接受/拒绝结果，不等待执行。' +
      '用 bridge_batch_result 查询进度与结果。',
    parameters: {
      items: {
        type: 'array',
        required: true,
        description: '批次条目数组，每项包含 taskType / question / context? / thinking? / webSearch?。',
      },
      needsLocalTools: { type: 'boolean', description: '批次级事实：是否需要本地文件/命令/数据库/仓库操作。为 true 时不委派。' },
      requiresProjectContext: { type: 'boolean', description: '批次级事实：是否依赖当前项目私有上下文。为 true 时不委派。' },
      multiStepPlanning: { type: 'boolean', description: '批次级事实：是否需要连续多轮规划。为 true 时不委派。' },
      accuracyCritical: { type: 'boolean', description: '批次级事实：是否为需要保证事实准确性的高风险问题。' },
      finalDecision: { type: 'boolean', description: '批次级事实：是否试图让外部模型代替主模型做最终决策。为 true 时不委派。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          batchId: { type: 'string', required: true },
          accepted: { type: 'array', items: { type: 'number' } },
          rejected: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                index: { type: 'number' },
                reason: { type: 'string' },
              },
            },
          },
          maxBatchItems: { type: 'number', required: true },
        },
      },
      render(_args, value) {
        const v = value as {
          ok: boolean
          batchId: string
          accepted: number[]
          rejected: Array<{ index: number; reason: string }>
          maxBatchItems: number
        }
        const lines: string[] = []
        lines.push(`批次已提交：batchId=${v.batchId}，${v.accepted.length} 条已接受，${v.rejected.length} 条被拒。`)
        if (v.rejected.length > 0) {
          lines.push('被拒条目：')
          for (const r of v.rejected) lines.push(`  #${r.index}: ${r.reason}`)
        }
        lines.push(`请用 bridge_batch_result(batchId="${v.batchId}") 查询结果。`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(rawArgs, exec) {
      const args = rawArgs as unknown as {
        items?: Array<BatchItemInputLocal>
        needsLocalTools?: boolean
        requiresProjectContext?: boolean
        multiStepPlanning?: boolean
        accuracyCritical?: boolean
        finalDecision?: boolean
      }
      const config = rt.getConfig()
      const taskKey = (exec as { sessionId?: string }).sessionId ?? 'default'
      const items: BatchItemInputLocal[] = args.items ?? []
      const maxBatchItems = config.bridge.maxBatchItems

      const rejections: Array<{ index: number; reason: string }> = []
      const acceptedIndices: number[] = []
      const acceptedInputs: BatchItemInputLocal[] = []
      let acceptedSoFar = 0

      for (let i = 0; i < items.length; i++) {
        const item = items[i]!
        const trimmed = (item.question ?? '').trim()

        // 1. 空问题 → 拒绝
        if (trimmed.length === 0) {
          rejections.push({ index: i, reason: '问题不能为空' })
          continue
        }

        // 2. 决策门控
        const facts: DelegationFacts = {
          taskType: item.taskType ?? '',
          question: trimmed,
          context: item.context ?? '',
          needsLocalTools: args.needsLocalTools,
          requiresProjectContext: args.requiresProjectContext,
          multiStepPlanning: args.multiStepPlanning,
          accuracyCritical: args.accuracyCritical,
          finalDecision: args.finalDecision,
          delegationsThisTask: rt.coordinator.taskDelegations(taskKey),
          delegationsThisHour: rt.coordinator.hourDelegations(),
          isDuplicate: rt.coordinator.isDuplicate(taskKey, trimmed),
        }
        const decision = decideDelegation(config, facts)
        if (!decision.shouldDelegate) {
          rejections.push({ index: i, reason: decision.reason })
          continue
        }

        // 3. 限额预检（计入本批次已接受的条目）
        if (rt.coordinator.taskDelegations(taskKey) + acceptedSoFar >= config.maxDelegationsPerTask) {
          rejections.push({ index: i, reason: `已达本次任务委派上限（${config.maxDelegationsPerTask}）。` })
          continue
        }
        if (rt.coordinator.hourDelegations() + acceptedSoFar >= config.maxDelegationsPerHour) {
          rejections.push({ index: i, reason: `已达全局每小时委派上限（${config.maxDelegationsPerHour}）。` })
          continue
        }

        // 通过：加入接受列表
        acceptedIndices.push(i)
        acceptedInputs.push({ ...item, question: trimmed })
        acceptedSoFar++
      }

      // 提交到队列（立即返回）
      const outcome = rt.batches.submit(taskKey, acceptedInputs, maxBatchItems)

      // 合并队列拒绝（队列下标映射回原始下标）
      for (const qr of outcome.rejected) {
        const originalIndex = acceptedIndices[qr.index]!
        rejections.push({ index: originalIndex, reason: qr.reason })
      }

      // 用队列返回的 accepted 替换（队列可能额外拒绝了部分）
      const finalAccepted = outcome.accepted.map((qi) => acceptedIndices[qi]!)

      // 进度由模型轮询驱动刷新；提交后上报初始进度，让状态卡立即显示批次
      if (finalAccepted.length > 0) {
        rt.status.noteBatch({ batchId: outcome.batchId, done: 0, total: finalAccepted.length, running: true })
      }

      return {
        ok: true,
        batchId: outcome.batchId,
        accepted: finalAccepted,
        rejected: rejections,
        maxBatchItems,
      }
    },
  })
}

// —————————————————————————— bridge_batch_result ——————————————————————————

export function createBatchResultTool(rt: DelegationRuntime): ToolDefinition {
  return defineTool({
    name: 'bridge_batch_result',
    description:
      '查询 bridge_batch 提交的批次执行进度与逐条结果。' +
      '返回逐条状态（pending/running/done/failed）、已注入文本、批次 usageTotals。' +
      '全部条目完成前可反复轮询。',
    parameters: {
      batchId: { type: 'string', required: true, description: 'bridge_batch 返回的 batchId。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          batchId: { type: 'string', required: true },
          status: { type: 'string', required: true },
          items: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                index: { type: 'number' },
                status: { type: 'string' },
                injectedText: { type: 'string' },
                reason: { type: 'string' },
              },
            },
          },
          usageTotals: {
            type: 'object',
            additionalProperties: false,
            properties: {
              promptTokens: { type: 'number' },
              completionTokens: { type: 'number' },
              total: { type: 'number' },
              estimateOnly: { type: 'boolean' },
            },
          },
          doneCount: { type: 'number', required: true },
          total: { type: 'number', required: true },
          reason: { type: 'string' },
        },
      },
      render(_args, value) {
        const v = value as {
          ok: boolean
          batchId: string
          status: string
          items?: Array<{ index: number; status: string; injectedText?: string; reason?: string }>
          usageTotals?: { promptTokens: number; completionTokens: number; total: number; estimateOnly: boolean }
          doneCount: number
          total: number
          reason?: string
        }
        if (!v.ok) {
          return [{ type: 'text', text: `查询失败：${v.reason ?? '未知批次'}` }]
        }
        const lines: string[] = []
        lines.push(`批次 ${v.batchId}：状态=${v.status}，完成=${v.doneCount}/${v.total}`)
        if (v.usageTotals) {
          lines.push(`Token 合计：prompt ${v.usageTotals.promptTokens} + completion ${v.usageTotals.completionTokens} = ${v.usageTotals.total}${v.usageTotals.estimateOnly ? '（含估算值）' : ''}`)
        }
        if (v.items) {
          for (const item of v.items) {
            const s = item.status === 'done' ? '✓' : item.status === 'failed' ? '✗' : item.status
            lines.push(`  #${item.index} [${s}]${item.reason ? ` ${item.reason}` : ''}`)
          }
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(rawArgs) {
      const args = rawArgs as unknown as { batchId?: string }
      const batchId = (args.batchId ?? '').trim()
      if (!batchId) {
        return { ok: false, batchId: '', status: 'failed', items: [] as Record<string, unknown>[], usageTotals: ZERO_USAGE, doneCount: 0, total: 0, reason: 'batchId 不能为空。' }
      }

      const batch = rt.batches.snapshot(batchId)
      if (!batch) {
        return { ok: false, batchId, status: 'failed', items: [] as Record<string, unknown>[], usageTotals: ZERO_USAGE, doneCount: 0, total: 0, reason: `未找到批次 ${batchId}，请检查 batchId 是否正确。` }
      }

      // 批次整体状态
      let batchStatus: string
      const hasRunning = batch.items.some((it) => it.status === 'running')
      const hasPending = batch.items.some((it) => it.status === 'pending')
      if (!hasRunning && !hasPending) {
        batchStatus = 'done'
      } else if (hasRunning) {
        batchStatus = 'running'
      } else {
        batchStatus = 'pending'
      }

      const doneCount = batch.items.filter((it) => it.status === 'done' || it.status === 'failed').length

      // 进度由模型轮询驱动刷新；每次查询后更新状态卡
      rt.status.noteBatch({ batchId, done: doneCount, total: batch.items.length, running: batchStatus !== 'done' })

      return {
        ok: true,
        batchId,
        status: batchStatus,
        items: batch.items.map((it) => ({
          index: it.index,
          status: it.status,
          ...(it.injectedText != null ? { injectedText: it.injectedText } : {}),
          ...(it.reason != null ? { reason: it.reason } : {}),
        })),
        usageTotals: { ...batch.usageTotals },
        doneCount,
        total: batch.items.length,
      }
    },
  })
}

// —————————————————————————— 辅助 ——————————————————————————

const ZERO_USAGE = { promptTokens: 0, completionTokens: 0, total: 0, estimateOnly: false }

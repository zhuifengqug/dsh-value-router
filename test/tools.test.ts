/**
 * 工具层集成测试（v2 ask/batch 工具）。
 *
 * 运行：node --experimental-strip-types test/tools.test.ts
 *
 * 覆盖：
 * - ask 成功：injectedText 含来源标记，真实 usage 上报，remainingDelegations 递减
 * - ask 拒绝：黑名单/凭据不消耗委派次数
 * - bridge down → degraded:true + 可操作中文指引 + 释放锁
 * - batch 立即返回 + 逐条拒绝原因
 * - batch_result 收敛到 done + usageTotals 累加
 * - unknown batchId 安全失败
 * - 回归守卫：所有工具返回键 ⊆ output.schema 声明键
 *
 * 不依赖任何真实服务，全 mock bridge。
 */
import assert from 'node:assert/strict'
import { test as registerTest } from 'node:test'

import { createAskTool, type DelegationRuntime } from '../src/tools/ask.ts'
import { createBatchTool, createBatchResultTool } from '../src/tools/batch.ts'
import { DelegationCoordinator } from '../src/bridge/limits.ts'
import { StatusTracker } from '../src/bridge/status.ts'
import { BatchQueue } from '../src/bridge/queue.ts'
import { resolveConfig, type ValueRouterConfig } from '../src/core/config.ts'
import type { BridgeClient, BridgeChatRequest, BridgeResult, BridgeHealth } from '../src/bridge/bridge.ts'

// —————————————————————————— 辅助 ——————————————————————————

/** 工具 execute 的精简类型（绕过 ToolRunContext 的复杂字段）。 */
type ToolExec = (args: unknown, exec: unknown) => Promise<Record<string, unknown>>

/** 调用工具 execute（绕过 ToolRunContext 类型限制）。 */
function callExec(def: { execute: unknown }, args: unknown, exec: unknown): Promise<Record<string, unknown>> {
  return (def.execute as ToolExec)(args, exec)
}

/** 简单延迟，等待队列泵完成。 */
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 标准成功桥回答。 */
function okAnswer(overrides: Partial<BridgeResult> = {}): BridgeResult {
  return {
    ok: true,
    text: '快速排序平均 O(n log n)，最坏 O(n^2)。堆排序始终 O(n log n)。归并排序稳定 O(n log n)。',
    thinkingUsed: false,
    webSearchUsed: false,
    model: 'deepseek-v4-flash',
    usage: { promptTokens: 80, completionTokens: 60, total: 140, estimateOnly: false },
    conversationRef: 'conv-1',
    requestId: 'r1',
    ...overrides,
  } as BridgeResult
}

// —————————————————————————— Fake BridgeClient ——————————————————————————

class FakeBridgeClient {
  public chatCalls: BridgeChatRequest[] = []
  public probeCalls = 0
  private _chatResult: BridgeResult
  private _health: BridgeHealth

  constructor(chatResult?: BridgeResult, health?: BridgeHealth) {
    this._chatResult = chatResult ?? okAnswer()
    this._health = health ?? { status: 'up', checkedAt: Date.now() }
  }

  setChatResult(r: BridgeResult): void { this._chatResult = r }
  setHealth(h: BridgeHealth): void { this._health = h }

  health(): BridgeHealth { return this._health }

  async probeHealth(_force?: boolean): Promise<BridgeHealth> {
    this.probeCalls++
    return this._health
  }

  async chat(req: BridgeChatRequest): Promise<BridgeResult> {
    this.chatCalls.push(req)
    return this._chatResult
  }

  releaseConversations(_taskKey: string): void { /* no-op */ }
}

// —————————————————————————— 运行时构造 ——————————————————————————

function makeRuntime(
  configOverride?: Partial<ValueRouterConfig>,
  chatResult?: BridgeResult,
  health?: BridgeHealth,
) {
  const config = resolveConfig(configOverride)
  const fakeBridge = new FakeBridgeClient(chatResult, health) as unknown as BridgeClient
  const coordinator = new DelegationCoordinator({
    maxDelegationsPerTask: config.maxDelegationsPerTask,
    maxConcurrentDelegations: config.maxConcurrentDelegations,
    maxDelegationsPerHour: config.maxDelegationsPerHour,
    maxRetriesPerRequest: config.maxRetriesPerRequest,
    dedupeWindowMs: 15 * 60_000,
  })
  const status = new StatusTracker(() => {
    const c = config
    return {
      enabled: c.enabled,
      autoDelegate: c.autoDelegate,
      maxDelegationsPerTask: c.maxDelegationsPerTask,
      taskDelegations: (k: string) => coordinator.taskDelegations(k),
      inFlightCount: () => coordinator.inFlightCount(),
    }
  })
  const batches = new BatchQueue({
    getConcurrency: () => config.bridge.concurrency,
    runItem: async (input, item) => {
      const requestId = `dw-batch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      coordinator.begin(requestId, item.taskKey, input.question)
      status.noteDelegated(item.taskKey)
      const chatReq: Record<string, unknown> = {
        requestId,
        taskType: input.taskType,
        question: input.question,
        context: input.context,
        thinking: input.thinking ?? 'silent',
        webSearch: input.webSearch ?? false,
      }
      if (input.model) chatReq.model = input.model
      const answer = await fakeBridge.chat(chatReq as unknown as BridgeChatRequest)
      if (!answer.ok) {
        coordinator.end(requestId)
        status.noteError(answer.reason)
        return { ok: false as const, reason: answer.reason }
      }
      const { compressAnswer, renderInjection } = await import('../src/bridge/compress.ts')
      const compressed = compressAnswer({
        rawAnswer: answer.text,
        question: input.question,
        taskType: input.taskType,
        model: answer.model,
        requestId,
        createdAt: new Date().toISOString(),
        maxResultCharacters: config.maxResultCharacters,
      })
      const injectedText = renderInjection(compressed, input.question, input.taskType)
      const usage = answer.usage
      status.noteUsage(usage)
      status.noteOutcome('ok')
      coordinator.end(requestId)
      return {
        injectedText,
        usage: { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, total: usage.total, estimateOnly: usage.estimateOnly },
      }
    },
  })

  let seq = 0
  const rt: DelegationRuntime = {
    getConfig: () => config,
    coordinator,
    bridge: fakeBridge,
    status,
    batches,
    nextRequestId: () => `dw-test-${++seq}`,
  }
  const exec = { sessionId: 'sess-1' }
  return { rt, config, coordinator, status, batches, fakeBridge, exec }
}

// —————————————————————————— 测试 ——————————————————————————

/**
 * 测试注册：交给测试框架执行（vitest 或 node:test，见 test/node-test-shim.ts）。
 * 返回 void，调用点的 `await runTest(...)` 因此不会与收集阶段互相等待。
 */
function runTest(name: string, fn: () => Promise<void>): void {
  registerTest(name, fn)
}

function main(): void {
  // ─── ask 成功 ───
  runTest('ask: 成功时 injectedText 含来源标记，usage 上报，remainingDelegations 递减', async () => {
    const { rt, coordinator, exec } = makeRuntime({ tuning: { minEstimatedSavedTokens: 50 } })
    const askDef = createAskTool(rt)
    const result = await callExec(askDef, {
      taskType: 'explanation',
      question: 'Compare REST vs GraphQL vs gRPC for a public read API with caching and auth tradeoffs. Provide a decision table.',
      context: 'We are choosing an API style for a documentation-heavy public service with CDN caching needs. '.repeat(16),
    }, exec)

    assert.equal(result.ok, true, `ask should succeed, got: ${result.reason}`)
    assert.ok(String(result.injectedText).includes('[来自 DeepSeek 网页端协作结果]'), 'injectedText 应含来源标记')
    assert.ok(String(result.injectedText).includes('不是主模型自身推理'), 'injectedText 应含警示')
    assert.equal(result.thinkingUsed, false)
    assert.equal(result.webSearchUsed, false)
    const usage = result.bridgeUsage as { promptTokens: number; completionTokens: number; total: number }
    assert.ok(usage.total > 0, 'usage.total 应 > 0')
    assert.equal(typeof result.mainModelOverheadEstimate, 'number')
    assert.equal(typeof result.savedEstimate, 'number')
    assert.equal(result.estimateOnly, false)
    assert.equal(result.degraded, false)
    assert.ok(typeof result.remainingDelegations === 'number')
    assert.ok(coordinator.taskDelegations('sess-1') >= 1, '应记录委派')
  })

  // ─── ask 指定模型：model 透传到桥，来源标记按实际模型 ───
  runTest('ask: model=GLM-5 透传到桥，injectedText 含 [来自 GLM协作结果] 不含 DeepSeek', async () => {
    const glmAnswer = okAnswer({ model: 'GLM-5' })
    const { rt, fakeBridge, exec } = makeRuntime({ tuning: { minEstimatedSavedTokens: 50 } }, glmAnswer)
    const fb = fakeBridge as unknown as FakeBridgeClient
    const askDef = createAskTool(rt)
    const result = await callExec(askDef, {
      taskType: 'explanation',
      question: 'Compare REST vs GraphQL vs gRPC for a public read API with caching and auth tradeoffs. Provide a decision table.',
      context: 'We are choosing an API style for a documentation-heavy public service with CDN caching needs. '.repeat(16),
      model: 'GLM-5',
    }, exec)

    assert.equal(result.ok, true, `ask should succeed, got: ${result.reason}`)
    // 桥应收到 model='GLM-5'
    const lastCall = fb.chatCalls[fb.chatCalls.length - 1]!
    assert.equal(lastCall.model, 'GLM-5', '桥应收到 model=GLM-5')
    // 来源标记应按实际模型（无空格）
    assert.ok(String(result.injectedText).includes('[来自 GLM协作结果]'), 'injectedText 应含 [来自 GLM协作结果]')
    assert.ok(!String(result.injectedText).includes('[来自 DeepSeek'), 'injectedText 不应含 DeepSeek 来源标记')
  })

  // ─── 默认模型仍标 DeepSeek ───
  runTest('ask: 默认模型下 injectedText 仍含 [来自 DeepSeek 网页端协作结果]', async () => {
    const { rt, fakeBridge, exec } = makeRuntime({ tuning: { minEstimatedSavedTokens: 50 } })
    const fb = fakeBridge as unknown as FakeBridgeClient
    const askDef = createAskTool(rt)
    const result = await callExec(askDef, {
      taskType: 'explanation',
      question: 'Compare REST vs GraphQL vs gRPC for a public read API with caching and auth tradeoffs. Provide a decision table.',
      context: 'We are choosing an API style for a documentation-heavy public service with CDN caching needs. '.repeat(16),
    }, exec)
    assert.equal(result.ok, true)
    // 桥没收到 model 字段（由 modelMap 槽位推导）
    const lastCall = fb.chatCalls[fb.chatCalls.length - 1]!
    assert.equal(lastCall.model, undefined, '默认时桥不应收到 model 字段')
    assert.ok(String(result.injectedText).includes('[来自 DeepSeek 网页端协作结果]'), '默认模型应标 DeepSeek')
  })

  // ─── batch item 带 model ───
  runTest('batch: item 带 model 时桥收到对应 model', async () => {
    const qwenAnswer = okAnswer({ model: 'Qwen3.7-Max' })
    const { rt, fakeBridge, exec } = makeRuntime({ tuning: { minEstimatedSavedTokens: 50, maxDelegationsPerTask: 10 } }, qwenAnswer)
    const fb = fakeBridge as unknown as FakeBridgeClient
    const batchDef = createBatchTool(rt)
    const longCtx = 'We are evaluating options for a public read API: caching semantics, schema evolution, auth patterns, rate limiting, error modeling, payload size over slow networks, and gateway cost. '.repeat(6)
    const submitResult = await callExec(batchDef, {
      items: [
        { taskType: 'explanation', question: 'Explain quicksort algorithm with average and worst case complexity analysis.', context: longCtx, model: 'Qwen3.7-Max' },
      ],
    }, exec)
    assert.equal(submitResult.ok, true)

    // 等队列泵执行
    await delay(300)

    // 检查桥收到的请求
    const lastCall = fb.chatCalls[fb.chatCalls.length - 1]!
    assert.equal(lastCall.model, 'Qwen3.7-Max', '桥应收到 item 的 model')
  })

  // ─── ask 拒绝：黑名单 ───
  runTest('ask: 黑名单任务类型被拒绝，不消耗委派次数', async () => {
    const { rt, coordinator, exec } = makeRuntime({ tuning: { minEstimatedSavedTokens: 50 } })
    const askDef = createAskTool(rt)
    const result = await callExec(askDef, {
      taskType: 'command-execution',
      question: 'Delete the old migration files.',
    }, exec)

    assert.equal(result.ok, false)
    assert.equal(result.degraded, false)
    assert.match(String(result.reason), /禁止/)
    assert.equal(coordinator.taskDelegations('sess-1'), 0)
  })

  // ─── ask 拒绝：凭据 ───
  runTest('ask: 含凭据被拒绝，不消耗委派次数', async () => {
    const { rt, coordinator, exec } = makeRuntime({ tuning: { minEstimatedSavedTokens: 50 } })
    const askDef = createAskTool(rt)
    const result = await callExec(askDef, {
      taskType: 'explanation',
      question: 'What to do with key sk-abcdefghijklmnopqrstuvwxyz123456?',
    }, exec)

    assert.equal(result.ok, false)
    assert.match(String(result.reason), /凭据/)
    assert.equal(coordinator.taskDelegations('sess-1'), 0)
  })

  // ─── ask bridge down → degraded ───
  runTest('ask: bridge down → degraded:true + 可操作中文原因 + 释放锁', async () => {
    const bridgeDown: BridgeResult = { ok: false, kind: 'unreachable', reason: '无法连接桥接服务' }
    const { rt, coordinator, status, exec } = makeRuntime({ tuning: { minEstimatedSavedTokens: 50 } }, bridgeDown)
    status.noteBridgeHealth({ status: 'up', checkedAt: Date.now() })
    const askDef = createAskTool(rt)
    const result = await callExec(askDef, {
      taskType: 'explanation',
      question: 'Compare REST vs GraphQL vs gRPC for a public read API with caching and auth tradeoffs. Provide a decision table.',
      context: 'We are choosing an API style for a documentation-heavy public service with CDN caching needs. '.repeat(16),
    }, exec)

    assert.equal(result.ok, false, '应返回 ok:false')
    assert.equal(result.degraded, true, '应标记 degraded')
    assert.match(String(result.reason), /请由主模型直接完成/, '应含可操作指引')
    assert.equal(coordinator.inFlightCount(), 0, '在途锁应已释放')
    // 再次调用应正常
    const rt2 = makeRuntime({ tuning: { minEstimatedSavedTokens: 50 } })
    rt2.status.noteBridgeHealth({ status: 'up', checkedAt: Date.now() })
    const askDef2 = createAskTool(rt2.rt)
    const r2 = await callExec(askDef2, {
      taskType: 'explanation',
      question: 'Compare REST vs GraphQL vs gRPC for a public read API with caching and auth tradeoffs. Provide a decision table.',
      context: 'We are choosing an API style for a documentation-heavy public service with CDN caching needs. '.repeat(16),
    }, { sessionId: 'sess-recover' })
    assert.equal(r2.ok, true, '后续调用应成功')
  })

  // ─── ask refuse → coordinator 不触碰 + degraded=false（策略拒绝） ───
  runTest('ask: 策略拒绝时不触碰 coordinator，degraded=false', async () => {
    const { rt, coordinator, exec } = makeRuntime({ tuning: { minEstimatedSavedTokens: 50 } })
    const askDef = createAskTool(rt)
    const result = await callExec(askDef, { taskType: 'code-modification', question: 'Refactor this function.' }, exec)
    assert.equal(result.ok, false)
    assert.equal(result.degraded, false, '策略拒绝（非桥问题）应 degraded=false')
    assert.equal(coordinator.taskDelegations('sess-1'), 0, '拒绝时不应增加委派计数')
    assert.equal(coordinator.inFlightCount(), 0, '拒绝时不应有在途')
  })

  // ─── ask refuse: 桥 down → 决策拒绝 → degraded=true ───
  runTest('ask: 桥 down 导致决策拒绝时 degraded=true，reason 可操作', async () => {
    const { rt, exec } = makeRuntime({ tuning: { minEstimatedSavedTokens: 50 } })
    // 模拟探活发现 Chat2API 停掉：桥客户端返回 down
    ;(rt.bridge as unknown as FakeBridgeClient).setHealth({ status: 'down', checkedAt: Date.now(), detail: 'unreachable' })
    const askDef = createAskTool(rt)
    const result = await callExec(askDef, {
      taskType: 'explanation',
      question: 'Compare REST vs GraphQL vs gRPC for a public read API with caching and auth tradeoffs. Provide a decision table.',
      context: 'We are choosing an API style for a documentation-heavy public service with CDN caching needs. '.repeat(16),
    }, exec)
    assert.equal(result.ok, false)
    assert.equal(result.degraded, true, '桥 down 时应 degraded=true（与系统提示段一致）')
    assert.match(String(result.reason), /桥/, 'reason 应提及桥')
    assert.match(String(result.reason), /不可用|down/, 'reason 应说明不可用')
  })

  // ─── batch 立即返回 + 逐条拒绝 ───
  runTest('batch: 立即返回，含决策拒绝和空问题拒绝', async () => {
    const { rt, exec } = makeRuntime({ tuning: { minEstimatedSavedTokens: 50, maxDelegationsPerTask: 10 } })
    const batchDef = createBatchTool(rt)
    const longCtx = 'We are evaluating options for a public read API: caching semantics, schema evolution, auth patterns, rate limiting, error modeling, payload size over slow networks, and gateway cost. '.repeat(6)
    const result = await callExec(batchDef, {
      items: [
        { taskType: 'explanation', question: 'Explain binary search with time complexity analysis and common pitfalls.', context: longCtx },
        { taskType: 'command-execution', question: 'Delete old migration files from the database.' },
        { taskType: 'explanation', question: '' },
      ],
    }, exec)

    assert.equal(result.ok, true)
    assert.ok(typeof result.batchId === 'string' && result.batchId.length > 0)
    const accepted = result.accepted as number[]
    const rejected = result.rejected as Array<{ index: number; reason: string }>
    assert.ok(accepted.length >= 1, '至少应有 1 条被接受')
    assert.ok(rejected.length >= 2, '至少应有 2 条被拒绝')
    const reasons = rejected.map((r) => r.reason).join('; ')
    assert.ok(reasons.includes('禁止') || reasons.includes('不能') || reasons.includes('空'), `拒绝原因应具体: ${reasons}`)
  })

  // ─── batch + batch_result 收敛 + 进度上报 + 会话键记账 ───
  runTest('batch_result: 批次收敛到 done，usageTotals 累加正确，进度上报到状态卡', async () => {
    const { rt, coordinator, status, exec } = makeRuntime({ tuning: { minEstimatedSavedTokens: 50, maxDelegationsPerTask: 10 } })
    const batchDef = createBatchTool(rt)
    const resultDef = createBatchResultTool(rt)
    const longCtx = 'We are evaluating options for a public read API: caching semantics, schema evolution, auth patterns, rate limiting, error modeling, payload size over slow networks, and gateway cost. '.repeat(6)
    const submitResult = await callExec(batchDef, {
      items: [
        { taskType: 'explanation', question: 'Explain quicksort algorithm with average and worst case complexity analysis, including common pivot selection strategies.', context: longCtx },
        { taskType: 'explanation', question: 'Explain mergesort algorithm with space complexity analysis and when to prefer it over quicksort for large datasets.', context: longCtx },
      ],
    }, exec)
    assert.equal(submitResult.ok, true)
    const batchId = submitResult.batchId as string
    const accepted = submitResult.accepted as number[]
    assert.ok(accepted.length >= 2, '应全部接受')

    // 提交后状态卡应显示批次进度（noteBatch 由 batch 工具触发）
    const snapAfterSubmit = status.snapshot()
    assert.ok(snapAfterSubmit.batch, '提交后状态卡应显示批次进度')
    assert.equal(snapAfterSubmit.batch!.total, accepted.length, '批次 total 应等于接受条数')
    assert.equal(snapAfterSubmit.batch!.running, true, '提交后批次应为 running')

    await delay(300)

    const pollResult = await callExec(resultDef, { batchId }, exec)
    assert.equal(pollResult.ok, true)
    assert.equal(pollResult.status, 'done', '批次应收敛到 done')
    const items = pollResult.items as Array<{ index: number; status: string; injectedText?: string }>
    const doneItems = items.filter((it) => it.status === 'done')
    assert.ok(doneItems.length >= 2, '所有条目应完成')
    for (const it of doneItems) {
      assert.ok(String(it.injectedText).includes('[来自 DeepSeek 网页端协作结果]'), `条目 #${it.index} 应含来源标记`)
    }
    const totals = pollResult.usageTotals as { promptTokens: number; completionTokens: number; total: number; estimateOnly: boolean }
    assert.ok(totals.total > 0, 'usageTotals.total 应 > 0')
    assert.equal(totals.estimateOnly, false, '真实 usage 不应标记为估算')
    assert.equal(pollResult.doneCount, items.length, 'doneCount 应等于总条目数')

    // 查询后状态卡应显示 done
    const snapAfterPoll = status.snapshot()
    assert.equal(snapAfterPoll.batch!.done, items.length, '批次 done 应等于总条目数')
    assert.equal(snapAfterPoll.batch!.running, false, '完成后批次应为非 running')

    // 批次条目应按会话键（sess-1）记账，不是按 taskType
    assert.ok(coordinator.taskDelegations('sess-1') >= 2, '批次委派应记到会话键 sess-1 上')
  })

  // ─── unknown batchId ───
  runTest('batch_result: 未知 batchId 安全失败', async () => {
    const { rt, exec } = makeRuntime()
    const resultDef = createBatchResultTool(rt)
    const result = await callExec(resultDef, { batchId: 'bw-nonexistent' }, exec)
    assert.equal(result.ok, false)
    assert.match(String(result.reason), /未找到/)
    assert.equal(result.doneCount, 0)
    assert.equal(result.total, 0)
  })

  // ─── batch 限额预检 ───
  runTest('batch: 限额预检在同批次内正确计数', async () => {
    const { rt, coordinator, exec } = makeRuntime({ tuning: { minEstimatedSavedTokens: 50, maxDelegationsPerTask: 2 } })
    const askDef = createAskTool(rt)
    const longCtx = 'We are evaluating options for a public read API: caching semantics, schema evolution, auth patterns, rate limiting, error modeling, payload size over slow networks, and gateway cost. '.repeat(6)
    await callExec(askDef, {
      taskType: 'explanation',
      question: 'Compare REST vs GraphQL vs gRPC for a public read API with caching and auth tradeoffs.',
      context: longCtx,
    }, exec)
    assert.equal(coordinator.taskDelegations('sess-1'), 1)

    const batchDef = createBatchTool(rt)
    const result = await callExec(batchDef, {
      items: [
        { taskType: 'explanation', question: 'Explain hashing with collision resolution strategies and performance characteristics.', context: longCtx },
        { taskType: 'explanation', question: 'Explain balanced tree data structures with insertion and deletion complexity.', context: longCtx },
        { taskType: 'explanation', question: 'Explain graph traversal algorithms with use cases.', context: longCtx },
      ],
    }, exec)
    const accepted = result.accepted as number[]
    const rejected = result.rejected as Array<{ index: number; reason: string }>
    assert.ok(accepted.length <= 1, `最多接受 1 条，实际 ${accepted.length}`)
    assert.ok(rejected.length >= 2, `至少 2 条被拒，实际 ${rejected.length}`)
  })

  // ─── 回归守卫：所有工具返回键 ⊆ output.schema 声明键 ───
  runTest('回归守卫: ask 成功/失败返回键 ⊆ schema 声明键', async () => {
    const { rt, exec } = makeRuntime({ tuning: { minEstimatedSavedTokens: 50 } })
    const askDef = createAskTool(rt)
    const declaredKeys = new Set(Object.keys((askDef as { output?: { schema?: { properties?: Record<string, unknown> } } }).output?.schema?.properties ?? {}))

    const okResult = await callExec(askDef, {
      taskType: 'explanation',
      question: 'Compare REST vs GraphQL vs gRPC for a public read API with caching and auth tradeoffs.',
      context: 'We are choosing an API style for a documentation-heavy public service with CDN caching needs. '.repeat(16),
    }, exec)
    for (const key of Object.keys(okResult)) {
      assert.ok(declaredKeys.has(key), `ask 成功返回了未声明字段: ${key}`)
    }

    const failResult = await callExec(askDef, { taskType: 'command-execution', question: 'q' }, exec)
    for (const key of Object.keys(failResult)) {
      assert.ok(declaredKeys.has(key), `ask 失败返回了未声明字段: ${key}`)
    }
  })

  runTest('回归守卫: batch 返回键 ⊆ schema 声明键', async () => {
    const { rt, exec } = makeRuntime({ tuning: { minEstimatedSavedTokens: 50 } })
    const batchDef = createBatchTool(rt)
    const declaredKeys = new Set(Object.keys((batchDef as { output?: { schema?: { properties?: Record<string, unknown> } } }).output?.schema?.properties ?? {}))
    const longCtx = 'We are evaluating options for a public read API: caching semantics, schema evolution, auth patterns, rate limiting, error modeling, payload size over slow networks, and gateway cost. '.repeat(6)
    const result = await callExec(batchDef, { items: [{ taskType: 'explanation', question: 'Explain hashing with collision resolution strategies and performance tradeoffs.', context: longCtx }] }, exec)
    for (const key of Object.keys(result)) {
      assert.ok(declaredKeys.has(key), `batch 返回了未声明字段: ${key}`)
    }
  })

  runTest('回归守卫: batch_result 成功/失败返回键 ⊆ schema 声明键', async () => {
    const { rt, exec } = makeRuntime({ tuning: { minEstimatedSavedTokens: 50 } })
    const resultDef = createBatchResultTool(rt)
    const declaredKeys = new Set(Object.keys((resultDef as { output?: { schema?: { properties?: Record<string, unknown> } } }).output?.schema?.properties ?? {}))

    const failResult = await callExec(resultDef, { batchId: 'bw-nonexistent' }, exec)
    for (const key of Object.keys(failResult)) {
      assert.ok(declaredKeys.has(key), `batch_result 失败返回了未声明字段: ${key}`)
    }

    const batchDef = createBatchTool(rt)
    const longCtx = 'We are evaluating options for a public read API: caching semantics, schema evolution, auth patterns, rate limiting, error modeling, payload size over slow networks, and gateway cost. '.repeat(6)
    const submit = await callExec(batchDef, { items: [{ taskType: 'explanation', question: 'Explain hashing with collision resolution strategies and performance tradeoffs.', context: longCtx }] }, exec)
    await delay(200)
    const okResult = await callExec(resultDef, { batchId: submit.batchId }, exec)
    for (const key of Object.keys(okResult)) {
      assert.ok(declaredKeys.has(key), `batch_result 成功返回了未声明字段: ${key}`)
    }
  })

}

// 同步注册全部用例（不 await：收集阶段必须在本模块求值内完成）。
main()

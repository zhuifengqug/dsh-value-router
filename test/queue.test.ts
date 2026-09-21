/**
 * 批次队列离线单测（契约 §4 + 任务 E3 验收清单）。
 *
 * 运行：node --experimental-strip-types test/queue.test.ts
 *
 * 不依赖任何测试框架，纯 assert + 手动计数。
 * 所有 runItem / now 均为注入 mock，不触碰真实网络。
 */

import assert from 'node:assert/strict'
import { test as registerTest } from 'node:test'
import {
  BatchQueue,
  type BatchItemInput,
  type BatchItemState,
  type BatchItemStatus,
  type BatchUsageTotals,
} from '../src/bridge/queue.ts'

// ─── 测试基础设施 ───

/**
 * 测试注册：交给测试框架执行（vitest 或 node:test，见 test/node-test-shim.ts）。
 * 返回 void，调用点的 `await test(...)` 因此不会与收集阶段互相等待。
 */
function test(name: string, fn: () => void | Promise<void>): void {
  registerTest(name, fn)
}

/** 创建可手动 resolve 的 Promise。 */
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (r?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** 等待一个 macrotask，让所有微任务（Promise 回调链）排空。 */
function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

const noopUsage: BatchUsageTotals = {
  promptTokens: 10,
  completionTokens: 20,
  total: 30,
  estimateOnly: false,
}

function okResult(
  text = 'answer',
  usage: BatchUsageTotals = noopUsage,
): { injectedText: string; usage: BatchUsageTotals } {
  return { injectedText: text, usage }
}

/** 构造最简 BatchItemInput。 */
function inp(q: string, over: Partial<BatchItemInput> = {}): BatchItemInput {
  return { taskType: 'explanation', question: q, ...over }
}

// ─── 用例 ───

async function main() {
  console.log('queue.test.ts\n')

  // ① submit 立即返回，报告 accepted / rejected 及原因
  test('submit returns immediately with accepted/rejected', () => {
    const queue = new BatchQueue({
      getConcurrency: () => 1,
      // 永不 resolve → 验证 submit 不等结果
      runItem: () => new Promise(() => {}),
    })

    const out = queue.submit('task1', [inp('hello'), inp('world')], 10)
    assert.ok(out.batchId.startsWith('bw-'))
    assert.deepEqual(out.accepted, [0, 1])
    assert.equal(out.rejected.length, 0)

    queue.dispose()
  })

  // ② 空问题被拒
  test('empty / whitespace question rejected', () => {
    const queue = new BatchQueue({
      getConcurrency: () => 1,
      runItem: async () => okResult(),
    })

    const out = queue.submit('t', [inp(''), inp('   '), inp('ok')], 10)
    assert.deepEqual(out.accepted, [2])
    assert.equal(out.rejected.length, 2)
    assert.equal(out.rejected[0]!.index, 0)
    assert.match(out.rejected[0]!.reason, /不能为空/)
    assert.equal(out.rejected[1]!.index, 1)

    queue.dispose()
  })

  // ③ 超过 maxItems
  test('over-limit items rejected', () => {
    const queue = new BatchQueue({
      getConcurrency: () => 1,
      runItem: async () => okResult(),
    })

    const out = queue.submit(
      't',
      [inp('a'), inp('b'), inp('c'), inp('d'), inp('e')],
      3,
    )
    assert.deepEqual(out.accepted, [0, 1, 2])
    assert.equal(out.rejected.length, 2)
    assert.equal(out.rejected[0]!.index, 3)
    assert.match(out.rejected[0]!.reason, /超过/)
    assert.equal(out.rejected[1]!.index, 4)

    queue.dispose()
  })

  // ④ 同批内重复问题
  test('duplicate question in same batch rejected', () => {
    const queue = new BatchQueue({
      getConcurrency: () => 1,
      runItem: async () => okResult(),
    })

    const out = queue.submit(
      't',
      [inp('same'), inp('different'), inp(' same '), inp('unique')],
      10,
    )
    // 'same' 和 ' same ' trim 后相同 → 第三个被拒
    assert.deepEqual(out.accepted, [0, 1, 3])
    assert.equal(out.rejected.length, 1)
    assert.equal(out.rejected[0]!.index, 2)
    assert.match(out.rejected[0]!.reason, /重复/)

    queue.dispose()
  })

  // ⑤ concurrency=1 严格顺序
  test('strict ordering with concurrency 1', async () => {
    const callOrder: number[] = []

    const queue = new BatchQueue({
      getConcurrency: () => 1,
      runItem: async (input) => {
        callOrder.push(Number(input.question))
        return okResult()
      },
    })

    queue.submit('t', [inp('0'), inp('1'), inp('2')], 10)

    // 等所有条目完成
    await tick()
    await tick()

    assert.deepEqual(callOrder, [0, 1, 2])

    queue.dispose()
  })

  // ⑥ concurrency > 1 真并发（用 deferred 观察）
  test('concurrency > 1 dispatches in parallel', async () => {
    const deferreds: ReturnType<typeof deferred<{ injectedText: string; usage: BatchUsageTotals }>>[] = []

    const queue = new BatchQueue({
      getConcurrency: () => 2,
      runItem: async () => {
        const d = deferred<{ injectedText: string; usage: BatchUsageTotals }>()
        deferreds.push(d)
        return d.promise
      },
    })

    queue.submit('t', [inp('q0'), inp('q1'), inp('q2')], 10)
    await tick()

    // 并发 2 → 前两条立即派发，第三条排队
    assert.equal(deferreds.length, 2, '应有 2 条在途')

    // 完成第一条
    deferreds[0]!.resolve(okResult())
    await tick()
    await tick()

    // 第三条应已被泵出
    assert.equal(deferreds.length, 3, 'q0 完成后 q2 应被派发')

    // 完成剩余
    deferreds[1]!.resolve(okResult())
    deferreds[2]!.resolve(okResult())
    await tick()

    queue.dispose()
  })

  // ⑦ 单条失败不阻塞后续
  test('one failing item does not block the rest', async () => {
    const completed: string[] = []

    const queue = new BatchQueue({
      getConcurrency: () => 1,
      runItem: async (input) => {
        if (input.question === 'bad') {
          throw new Error('boom')
        }
        completed.push(input.question)
        return okResult()
      },
    })

    queue.submit('t', [inp('bad'), inp('good')], 10)
    await tick()
    await tick()

    assert.deepEqual(completed, ['good'])
    const snap = queue.snapshot(
      // 取到唯一的 batchId
      [...(queue as unknown as { batches: Map<string, unknown> }).batches.keys()][0] as string,
    )
    // bad → failed, good → done
    assert.equal(snap!.items[0]!.status, 'failed')
    assert.equal(snap!.items[0]!.reason, 'boom')
    assert.equal(snap!.items[1]!.status, 'done')

    queue.dispose()
  })

  // ⑧ usageTotals 累加 + estimateOnly 传播
  test('usageTotals accumulates and estimateOnly propagates', async () => {
    const usage1: BatchUsageTotals = { promptTokens: 100, completionTokens: 200, total: 300, estimateOnly: false }
    const usage2: BatchUsageTotals = { promptTokens: 50, completionTokens: 80, total: 130, estimateOnly: true }
    const usage3: BatchUsageTotals = { promptTokens: 30, completionTokens: 40, total: 70, estimateOnly: false }

    let callCount = 0
    const queue = new BatchQueue({
      getConcurrency: () => 3,
      runItem: async () => {
        const usages = [usage1, usage2, usage3]
        return okResult('a', usages[callCount++]!)
      },
    })

    const out = queue.submit('t', [inp('a'), inp('b'), inp('c')], 10)
    await tick()
    await tick()

    const snap = queue.snapshot(out.batchId)!
    assert.equal(snap.usageTotals.promptTokens, 180)
    assert.equal(snap.usageTotals.completionTokens, 320)
    assert.equal(snap.usageTotals.total, 500)
    assert.equal(snap.usageTotals.estimateOnly, true, '任一条 estimateOnly → 批次 true')

    queue.dispose()
  })

  // ⑨ releaseTask 清理记录、pending/running 标记失败
  test('releaseTask clears records and fails stragglers', async () => {
    const deferreds: ReturnType<typeof deferred<{ injectedText: string; usage: BatchUsageTotals }>>[] = []

    const queue = new BatchQueue({
      getConcurrency: () => 1,
      runItem: async () => {
        const d = deferred<{ injectedText: string; usage: BatchUsageTotals }>()
        deferreds.push(d)
        return d.promise
      },
    })

    const out = queue.submit('task-release', [inp('q0'), inp('q1')], 10)
    await tick()

    // q0 在途，q1 pending
    assert.equal(deferreds.length, 1)

    queue.releaseTask('task-release')

    // 批次记录已被删除
    assert.equal(queue.snapshot(out.batchId), undefined)

    // 在途 runItem 完成后不应崩溃（回调检测批次已删除）
    deferreds[0]!.resolve(okResult())
    await tick()
    await tick()

    // 再次释放（幂等）
    queue.releaseTask('task-release')

    queue.dispose()
  })

  // ⑩ batchId 唯一
  test('batchId uniqueness', () => {
    const queue = new BatchQueue({
      getConcurrency: () => 1,
      runItem: async () => okResult(),
    })

    const ids = new Set<string>()
    for (let i = 0; i < 50; i++) {
      const out = queue.submit('t', [inp(`q${i}`)], 10)
      assert.ok(!ids.has(out.batchId), `batchId ${out.batchId} 重复`)
      ids.add(out.batchId)
    }

    queue.dispose()
  })

  // ⑪ snapshot 返回深拷贝，外部修改不影响内部
  test('snapshot returns a defensive copy', async () => {
    const queue = new BatchQueue({
      getConcurrency: () => 1,
      runItem: async () => okResult(),
    })

    const out = queue.submit('t', [inp('q0'), inp('q1')], 10)
    await tick()
    await tick()

    const snap1 = queue.snapshot(out.batchId)!
    // 篡改快照
    snap1.items[0]!.status = 'failed' as BatchItemStatus
    snap1.items[0]!.reason = 'tampered'
    snap1.usageTotals.promptTokens = 99999
    snap1.items.push({
      index: 999,
      id: 'fake',
      taskType: 'x',
      taskKey: 'fake-task',
      status: 'done',
    })

    const snap2 = queue.snapshot(out.batchId)!
    assert.equal(snap2.items[0]!.status, 'done', '内部状态不应被篡改')
    assert.equal(snap2.items[0]!.reason, undefined)
    assert.equal(snap2.items.length, 2, '不应多出伪造条目')
    assert.equal(snap2.usageTotals.promptTokens, 20, 'usageTotals 不应被篡改')

    queue.dispose()
  })

  // ⑫ dispose 后 submit 返回空 accepted
  test('dispose rejects all further submits', () => {
    const queue = new BatchQueue({
      getConcurrency: () => 1,
      runItem: async () => okResult(),
    })

    queue.dispose()

    const out = queue.submit('t', [inp('a'), inp('b')], 10)
    assert.equal(out.batchId, '')
    assert.deepEqual(out.accepted, [])
    assert.equal(out.rejected.length, 2)
    assert.match(out.rejected[0]!.reason, /销毁/)
  })

  // ⑬ runItem reject（非 throw）也被正确捕获
  test('runItem rejection is caught as failure', async () => {
    const queue = new BatchQueue({
      getConcurrency: () => 1,
      runItem: async () => {
        return Promise.reject(new Error('rejected promise'))
      },
    })

    const out = queue.submit('t', [inp('q')], 10)
    await tick()
    await tick()

    const snap = queue.snapshot(out.batchId)!
    assert.equal(snap.items[0]!.status, 'failed')
    assert.equal(snap.items[0]!.reason, 'rejected promise')

    queue.dispose()
  })

  // ⑭ failed item 不贡献 usage
  test('failed items contribute nothing to usageTotals', async () => {
    let callIdx = 0
    const queue = new BatchQueue({
      getConcurrency: () => 1,
      runItem: async () => {
        if (callIdx++ === 0) {
          return { ok: false as const, reason: 'fail' }
        }
        return okResult('a', { promptTokens: 100, completionTokens: 200, total: 300, estimateOnly: false })
      },
    })

    const out = queue.submit('t', [inp('fail'), inp('ok')], 10)
    await tick()
    await tick()

    const snap = queue.snapshot(out.batchId)!
    assert.equal(snap.items[0]!.status, 'failed')
    assert.equal(snap.items[1]!.status, 'done')
    // 只有成功条目贡献 usage
    assert.equal(snap.usageTotals.total, 300)

    queue.dispose()
  })

  // ⑮ 条目 taskKey 等于 submit 传入的键，runItem 回调也能拿到
  test('items carry taskKey from submit; runItem receives it', async () => {
    const seenTaskKeys: string[] = []

    const queue = new BatchQueue({
      getConcurrency: () => 1,
      runItem: async (_input, item) => {
        seenTaskKeys.push(item.taskKey)
        return okResult()
      },
    })

    const out = queue.submit('session-abc', [inp('q0'), inp('q1')], 10)
    await tick()
    await tick()

    // runItem 回调拿到的 taskKey
    assert.deepEqual(seenTaskKeys, ['session-abc', 'session-abc'])

    // snapshot 返回的条目也带 taskKey
    const snap = queue.snapshot(out.batchId)!
    for (const item of snap.items) {
      assert.equal(item.taskKey, 'session-abc')
    }

    queue.dispose()
  })

  // ⑯ releaseTask 只清理对应任务，不影响其它任务
  test('releaseTask only affects the specified taskKey', async () => {
    const deferreds: ReturnType<typeof deferred<{ injectedText: string; usage: BatchUsageTotals }>>[] = []

    const queue = new BatchQueue({
      getConcurrency: () => 1,
      runItem: async () => {
        const d = deferred<{ injectedText: string; usage: BatchUsageTotals }>()
        deferreds.push(d)
        return d.promise
      },
    })

    const outA = queue.submit('task-A', [inp('a0'), inp('a1')], 10)
    const outB = queue.submit('task-B', [inp('b0')], 10)
    await tick()

    // task-A 的 a0 在途，task-B 的 b0 排队（concurrency=1）
    queue.releaseTask('task-A')

    // task-A 的批次消失
    assert.equal(queue.snapshot(outA.batchId), undefined)

    // task-B 的批次仍然存在
    const snapB = queue.snapshot(outB.batchId)!
    assert.equal(snapB.taskKey, 'task-B')
    // b0 现在应被泵出（task-A 释放后 concurrency 槽位空出）
    deferreds[0]!.resolve(okResult())
    await tick()
    await tick()

    // b0 的 runItem 已被泵出（deferreds[1] 已创建），resolve 它
    assert.equal(deferreds.length, 2, 'b0 应已被泵出')
    deferreds[1]!.resolve(okResult())
    await tick()
    await tick()

    const snapB2 = queue.snapshot(outB.batchId)!
    assert.equal(snapB2.items[0]!.status, 'done', 'task-B 的条目应正常完成')
    assert.equal(snapB2.items[0]!.taskKey, 'task-B')

    // 再释放 task-B
    queue.releaseTask('task-B')
    assert.equal(queue.snapshot(outB.batchId), undefined)

    queue.dispose()
  })

  // ⑰ model 字段透传：带 model 的条目传到 runItem，不带的为 undefined
  test('model field is passed through to runItem; absent = undefined', async () => {
    const seen: (string | undefined)[] = []

    const queue = new BatchQueue({
      getConcurrency: () => 3,
      runItem: async (input) => {
        seen.push(input.model)
        return okResult()
      },
    })

    queue.submit(
      't',
      [
        inp('q0'),                          // 无 model
        inp('q1', { model: 'GLM-5' }),      // 指定 model
        inp('q2'),                          // 无 model
        inp('q3', { model: 'kimi-v2' }),    // 指定 model
      ],
      10,
    )
    await tick()
    await tick()

    assert.deepEqual(seen, [undefined, 'GLM-5', undefined, 'kimi-v2'])

    queue.dispose()
  })

}

// 同步注册全部用例（不 await：收集阶段必须在本模块求值内完成）。
main()

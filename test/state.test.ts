/**
 * 会话状态与计量测试：executor 调用计数、会话覆写存取、lineage 聚合。
 * 计量口径只有「可如实陈述的实值」：executorCalls（全局 + 按会话）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { MAX_DISPATCH_RECORDS, valueRouterState, routeKey, type ChildRouteIntent } from '../src/core/state.ts'

function intentOf(provider: string, model: string, parentRoute?: string): ChildRouteIntent {
  return {
    provider,
    model,
    observedAt: { turn: 0, step: 0 },
    parentRoute,
    source: 'first-seen',
  }
}

// —— 轮转序号：本次迭代的核心状态 ——

test('轮转序号：同一子会话在生命周期内只分配一次（多 step 不得跳模型）', () => {
  // 这是防止「同一段对话历史由不同模型生成」的关键：序号若在每个 request 上递增，
  // 多 step 子代理会在 step 之间换模型，宿主会插入 model-switch notice。
  valueRouterState.resetAll()
  assert.equal(valueRouterState.rotationIndexOf('c1', 'p'), 0)
  assert.equal(valueRouterState.rotationIndexOf('c1', 'p'), 0, '第二次观察必须拿到同一个序号')
  assert.equal(valueRouterState.rotationIndexOf('c1', 'p'), 0)
})

test('轮转序号：同一父会话下按子会话创建顺序递增 0,1,2', () => {
  valueRouterState.resetAll()
  assert.equal(valueRouterState.rotationIndexOf('c1', 'parent'), 0)
  assert.equal(valueRouterState.rotationIndexOf('c2', 'parent'), 1)
  assert.equal(valueRouterState.rotationIndexOf('c3', 'parent'), 2)
  // 不同父会话各自从 0 开始
  assert.equal(valueRouterState.rotationIndexOf('c4', 'other'), 0)
})

test('轮转序号：父会话缺失时退化为进程级单调计数', () => {
  valueRouterState.resetAll()
  assert.equal(valueRouterState.rotationIndexOf('c1', undefined), 0)
  assert.equal(valueRouterState.rotationIndexOf('c2', undefined), 1)
  assert.equal(valueRouterState.rotationIndexOf('c1', undefined), 0, '已有槽位不重新分配')
})

// —— 线路意图快照 ——

test('线路意图：只记录第一次，后续不覆盖（否则会被自己的改写结果污染）', () => {
  valueRouterState.resetAll()
  valueRouterState.rememberIntent('c1', intentOf('main', 'main-model', 'main/main-model'))
  valueRouterState.rememberIntent('c1', intentOf('hijacked', 'other-model', 'main/main-model'))
  const intent = valueRouterState.intentFor('c1')
  assert.equal(intent?.provider, 'main')
  assert.equal(intent?.model, 'main-model')
})

test('attachParentRoute：可补写父线路，但已补过的不再改', () => {
  valueRouterState.resetAll()
  valueRouterState.rememberIntent('c1', intentOf('sub', 'sub-model'))
  assert.equal(valueRouterState.intentFor('c1')?.parentRoute, undefined)

  valueRouterState.attachParentRoute('c1', 'main/main-model')
  assert.equal(valueRouterState.intentFor('c1')?.parentRoute, 'main/main-model')

  valueRouterState.attachParentRoute('c1', 'other/other-model')
  assert.equal(valueRouterState.intentFor('c1')?.parentRoute, 'main/main-model', '不应被二次改写')
})

test('attachParentRoute：父线路为 undefined 或会话不存在时是安全的空操作', () => {
  valueRouterState.resetAll()
  assert.doesNotThrow(() => valueRouterState.attachParentRoute('ghost', 'main/main-model'))
  valueRouterState.rememberIntent('c1', intentOf('sub', 'sub-model'))
  assert.doesNotThrow(() => valueRouterState.attachParentRoute('c1', undefined))
  assert.equal(valueRouterState.intentFor('c1')?.parentRoute, undefined)
})

test('clearIntent 同时清掉轮转槽位', () => {
  valueRouterState.resetAll()
  assert.equal(valueRouterState.rotationIndexOf('c1', 'p'), 0)
  valueRouterState.rememberIntent('c1', intentOf('a', 'b'))
  valueRouterState.clearIntent('c1')
  assert.equal(valueRouterState.intentFor('c1'), undefined)
  // 槽位已清 → 重新分配时会拿到父会话计数器的下一个值（而不是沿用旧的 0）
  assert.equal(valueRouterState.rotationIndexOf('c1', 'p'), 1)
})

test('pruneIntents：超过上限时按 FIFO 淘汰最老的', () => {
  valueRouterState.resetAll()
  for (let i = 0; i < 5; i++) valueRouterState.rememberIntent(`c${i}`, intentOf('p', 'm'))
  assert.equal(valueRouterState.pruneIntents(3), 2)
  assert.equal(valueRouterState.intentFor('c0'), undefined)
  assert.equal(valueRouterState.intentFor('c1'), undefined)
  assert.ok(valueRouterState.intentFor('c4'))
  assert.equal(valueRouterState.pruneIntents(10), 0, '未超上限时是空操作')
  valueRouterState.resetAll()
})

test('routeKey 归一化线路标识', () => {
  assert.equal(routeKey('p', 'm'), 'p/m')
})

test('resetAll 清空轮转与意图', () => {
  valueRouterState.resetAll()
  valueRouterState.rotationIndexOf('c1', 'parent')
  valueRouterState.rememberIntent('c1', intentOf('a', 'b'))
  valueRouterState.resetAll()
  assert.equal(valueRouterState.intentFor('c1'), undefined)
  assert.equal(valueRouterState.rotationIndexOf('c1', 'parent'), 0)
})

test('会话覆写：写入 / 读取 / 清除', () => {
  valueRouterState.resetAll()
  assert.equal(valueRouterState.getSessionOverride('s1'), undefined)
  valueRouterState.setSessionOverride('s1', { enabled: true, strategy: 'saver' })
  assert.deepEqual(valueRouterState.getSessionOverride('s1'), { enabled: true, strategy: 'saver' })
  // getSessionMetrics 返回的覆写是副本：改它不会污染内部状态
  const viaMetrics = valueRouterState.getSessionMetrics('s1')
  assert.deepEqual(viaMetrics.override, { enabled: true, strategy: 'saver' })
  viaMetrics.override!.strategy = 'powerful'
  assert.deepEqual(valueRouterState.getSessionOverride('s1'), { enabled: true, strategy: 'saver' })

  valueRouterState.clearSessionOverride('s1')
  assert.equal(valueRouterState.getSessionOverride('s1'), undefined)
  // 覆写写入会返回随 metrics 一起携带
  assert.equal(valueRouterState.getSessionMetrics('s1').override, undefined)
  valueRouterState.resetAll()
})

test('只读查询返回空指标，不残留覆写', () => {
  valueRouterState.resetAll()
  assert.equal(valueRouterState.getSessionOverride('ghost'), undefined)
  const m = valueRouterState.getSessionMetrics('ghost')
  assert.equal(m.executorCalls, 0)
  assert.equal(m.override, undefined)
  assert.deepEqual(valueRouterState.getGlobalMetrics(), { executorCalls: 0 })
})

test('recordExecutorCall：按会话与全局分别计数（无 usage 参数）', () => {
  valueRouterState.resetAll()
  valueRouterState.recordExecutorCall('s1')
  valueRouterState.recordExecutorCall('s1')
  valueRouterState.recordExecutorCall() // 无会话 id：只进全局
  valueRouterState.recordExecutorCall('s2')

  assert.equal(valueRouterState.getSessionMetrics('s1').executorCalls, 2)
  assert.equal(valueRouterState.getSessionMetrics('s2').executorCalls, 1)
  assert.equal(valueRouterState.getSessionMetrics('s3').executorCalls, 0)
  assert.deepEqual(valueRouterState.getGlobalMetrics(), { executorCalls: 4 })
  valueRouterState.resetAll()
})

test('getSessionMetrics 携带该会话的覆写', () => {
  valueRouterState.resetAll()
  valueRouterState.recordExecutorCall('s1')
  valueRouterState.setSessionOverride('s1', { strategy: 'saver', executor: { provider: 'p', model: 'm' } })
  const m = valueRouterState.getSessionMetrics('s1')
  assert.equal(m.executorCalls, 1)
  assert.deepEqual(m.override, { strategy: 'saver', executor: { provider: 'p', model: 'm' } })
  // 未设置覆写的会话不带 override 键
  assert.equal(valueRouterState.getSessionMetrics('s2').override, undefined)
  valueRouterState.resetAll()
})

test('lineage：子会话计数聚合回父会话', () => {
  valueRouterState.resetAll()
  valueRouterState.trackChildSession('child', 'parent')
  valueRouterState.trackChildSession('grandchild', 'child')
  valueRouterState.recordExecutorCall('child')
  valueRouterState.recordExecutorCall('child')
  valueRouterState.recordExecutorCall('grandchild')

  const parent = valueRouterState.getSessionMetrics('parent')
  assert.equal(parent.executorCalls, 3, '子会话调用计入父会话查询结果')
  // 自身计数与聚合计数分开看
  assert.equal(valueRouterState.getSessionMetrics('child').executorCalls, 3)
  // 兄弟会话不互相污染
  assert.equal(valueRouterState.getSessionMetrics('sibling').executorCalls, 0)
  assert.equal(valueRouterState.getParentSession('grandchild'), 'child')
  assert.equal(valueRouterState.getParentSession('parent'), undefined)
  valueRouterState.resetAll()
})

test('lineage 环保护：自环与回环被拒绝', () => {
  valueRouterState.resetAll()
  valueRouterState.trackChildSession('a', 'a')
  assert.equal(valueRouterState.getParentSession('a'), undefined)
  valueRouterState.trackChildSession('b', 'a')
  valueRouterState.trackChildSession('a', 'b')
  assert.equal(valueRouterState.getParentSession('a'), undefined)
  // a→b 被拒绝，lineage 仍是 b→a 的树：聚合沿既有树进行，不会死循环
  valueRouterState.recordExecutorCall('a')
  valueRouterState.recordExecutorCall('b')
  assert.equal(valueRouterState.getSessionMetrics('b').executorCalls, 1)
  assert.equal(valueRouterState.getSessionMetrics('a').executorCalls, 2, 'b 是 a 的后代，计数聚合回来')
  valueRouterState.resetAll()
})

test('全局计数与空会话指标', () => {
  valueRouterState.resetAll()
  valueRouterState.recordExecutorCall('s1')
  assert.deepEqual(valueRouterState.getGlobalMetrics(), { executorCalls: 1 })
  const empty = valueRouterState.getSessionMetrics('nobody')
  assert.equal(empty.executorCalls, 0)
  assert.equal(empty.override, undefined)
  // resetAll 一并清掉全局计数、会话条目与 lineage
  valueRouterState.resetAll()
  assert.deepEqual(valueRouterState.getGlobalMetrics(), { executorCalls: 0 })
  assert.equal(valueRouterState.getParentSession('child'), undefined)
})

// —— 派发记录：插件「到底干了什么」的唯一可观测出口 ——

test('派发记录：最新的在前，按 limit 截取', () => {
  valueRouterState.resetAll()
  for (let i = 1; i <= 3; i++) {
    valueRouterState.recordDispatch({
      sessionId: `s${i}`,
      provider: 'p',
      model: `m${i}`,
      tierIndex: 0,
      origin: 'pool',
      at: i,
    })
  }
  const recent = valueRouterState.recentDispatches(2)
  assert.deepEqual(recent.map(record => record.model), ['m3', 'm2'], '最新的排在最前')
  assert.equal(valueRouterState.recentDispatches(10).length, 3)
})

test('派发记录：有界，不会随长跑进程无限增长', () => {
  valueRouterState.resetAll()
  for (let i = 0; i < MAX_DISPATCH_RECORDS + 20; i++) {
    valueRouterState.recordDispatch({
      sessionId: `s${i}`,
      provider: 'p',
      model: `m${i}`,
      tierIndex: undefined,
      origin: 'fallback',
      at: i,
    })
  }
  const all = valueRouterState.recentDispatches(MAX_DISPATCH_RECORDS)
  assert.equal(all.length, MAX_DISPATCH_RECORDS)
  // 保留的是最近的那些
  assert.equal(all[0]?.model, `m${MAX_DISPATCH_RECORDS + 19}`)
})

test('派发记录：resetAll 一并清空', () => {
  valueRouterState.resetAll()
  valueRouterState.recordDispatch({
    sessionId: 's1', provider: 'p', model: 'm', tierIndex: 0, origin: 'pool', at: 1,
  })
  valueRouterState.resetAll()
  assert.deepEqual(valueRouterState.recentDispatches(), [])
})

test('派发记录按会话隔离：徽章只显示本会话的，不串到别的会话', () => {
  valueRouterState.resetAll()
  valueRouterState.recordDispatch({
    sessionId: 'A', provider: 'p', model: 'a1', tierIndex: 0, origin: 'pool', at: 1,
  })
  valueRouterState.recordDispatch({
    sessionId: 'B', provider: 'q', model: 'b1', tierIndex: 0, origin: 'pool', at: 2,
  })
  valueRouterState.recordDispatch({
    sessionId: 'A', provider: 'p', model: 'a2', tierIndex: 0, origin: 'pool', at: 3,
  })
  assert.deepEqual(valueRouterState.recentDispatchesFor('A').map(r => r.model), ['a2', 'a1'])
  assert.deepEqual(valueRouterState.recentDispatchesFor('B').map(r => r.model), ['b1'])
  assert.deepEqual(valueRouterState.recentDispatchesFor('nobody'), [])
})

test('派发记录按会话聚合后代子代理：顶层会话看得到它派出的子代理', () => {
  valueRouterState.resetAll()
  valueRouterState.trackChildSession('child1', 'root')
  valueRouterState.trackChildSession('child2', 'root')
  valueRouterState.recordDispatch({
    sessionId: 'child1', provider: 'p', model: 'c1', tierIndex: 0, origin: 'pool', at: 1,
  })
  valueRouterState.recordDispatch({
    sessionId: 'child2', provider: 'p', model: 'c2', tierIndex: 0, origin: 'pool', at: 2,
  })
  assert.deepEqual(
    valueRouterState.recentDispatchesFor('root').map(r => r.model),
    ['c2', 'c1'],
    '顶层会话应看到两个子代理的记录',
  )
  // 子会话自己只看到自己的
  assert.deepEqual(valueRouterState.recentDispatchesFor('child1').map(r => r.model), ['c1'])
})

/**
 * 会话状态与计量测试：executor 调用计数、会话覆写存取、lineage 聚合。
 * 计量口径只有「可如实陈述的实值」：executorCalls（全局 + 按会话）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { valueRouterState } from '../src/core/state.ts'

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

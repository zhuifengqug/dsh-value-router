/**
 * 会话状态与计量测试：覆写存取、lineage 聚合、占比口径。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { valueRouterState } from '../src/core/state.ts'

test('会话覆写：写入 / 读取 / 清除', () => {
  valueRouterState.resetAll()
  assert.equal(valueRouterState.getSessionOverride('s1'), undefined)
  valueRouterState.setSessionOverride('s1', { enabled: true, strategy: 'saver' })
  assert.deepEqual(valueRouterState.getSessionOverride('s1'), { enabled: true, strategy: 'saver' })
  valueRouterState.setSessionOverride('s1', undefined)
  assert.equal(valueRouterState.getSessionOverride('s1'), undefined)
  valueRouterState.resetAll()
})

test('只读查询不会创建会话条目（子代理查询不常驻内存）', () => {
  valueRouterState.resetAll()
  valueRouterState.getSessionOverride('ghost')
  valueRouterState.getSessionMetrics('ghost')
  assert.equal(valueRouterState.getGlobalMetrics().activeSessions, 0)
})

test('executor 与桥委派分别计量', () => {
  valueRouterState.resetAll()
  valueRouterState.recordExecutorCall('s1', { inputTokens: 100, outputTokens: 20 })
  valueRouterState.recordExecutorCall('s1')
  valueRouterState.recordBridgeDelegation('s1', { promptTokens: 30, completionTokens: 10, total: 40, estimateOnly: true }, 250)

  const m = valueRouterState.getSessionMetrics('s1')
  assert.equal(m.executorCalls, 2)
  assert.equal(m.executorTokens.inputTokens, 100)
  assert.equal(m.executorTokens.outputTokens, 20)
  assert.equal(m.bridgeDelegations, 1)
  assert.equal(m.bridgeTokens.total, 40)
  assert.equal(m.bridgeSavedTokens, 250)
  assert.equal(m.estimateOnlyCount, 1)
  // 2 次 executor / (2 + 1) = 67%
  assert.equal(m.executorSharePercent, 67)
  valueRouterState.resetAll()
})

test('lineage：子会话计数聚合回父会话', () => {
  valueRouterState.resetAll()
  valueRouterState.trackChildSession('child', 'parent')
  valueRouterState.trackChildSession('grandchild', 'child')
  valueRouterState.recordExecutorCall('child')
  valueRouterState.recordExecutorCall('grandchild')
  valueRouterState.recordBridgeDelegation('grandchild', { total: 5 })

  const parent = valueRouterState.getSessionMetrics('parent')
  assert.equal(parent.executorCalls, 2)
  assert.equal(parent.bridgeDelegations, 1)
  // 兄弟会话不互相污染
  assert.equal(valueRouterState.getSessionMetrics('sibling').executorCalls, 0)
  assert.equal(valueRouterState.getParentSession('grandchild'), 'child')
  valueRouterState.resetAll()
})

test('lineage 环保护：自环与回环被拒绝', () => {
  valueRouterState.resetAll()
  valueRouterState.trackChildSession('a', 'a')
  assert.equal(valueRouterState.getParentSession('a'), undefined)
  valueRouterState.trackChildSession('b', 'a')
  valueRouterState.trackChildSession('a', 'b')
  assert.equal(valueRouterState.getParentSession('a'), undefined)
  valueRouterState.resetAll()
})

test('全局计数与空会话指标', () => {
  valueRouterState.resetAll()
  valueRouterState.recordExecutorCall('s1')
  valueRouterState.recordBridgeDelegation(undefined)
  const global = valueRouterState.getGlobalMetrics()
  assert.equal(global.executorCalls, 1)
  assert.equal(global.bridgeDelegations, 1)
  const empty = valueRouterState.getSessionMetrics('nobody')
  assert.equal(empty.executorCalls, 0)
  assert.equal(empty.executorSharePercent, 0)
  valueRouterState.resetAll()
})

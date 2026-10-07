/**
 * 运行事件缓冲：有界、保序、可过滤。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { RouteEventLog, ROUTE_EVENT_CAPACITY } from '../src/core/audit.ts'

test('缺省容量是一个正数常量', () => {
  assert.ok(ROUTE_EVENT_CAPACITY > 0)
})

test('记录时补当前时间，调用方给了时间就保留', () => {
  const log = new RouteEventLog(4)
  const before = Date.now()
  const stamped = log.record({ type: 'dispatch' })
  assert.ok(stamped.at >= before && stamped.at <= Date.now())
  const explicit = log.record({ type: 'queue', at: 42 })
  assert.equal(explicit.at, 42)
})

test('超过容量时丢最旧的（FIFO）', () => {
  const log = new RouteEventLog(3)
  for (const taskId of ['t1', 't2', 't3', 't4', 't5']) log.record({ type: 'dispatch', taskId })
  assert.equal(log.size(), 3)
  assert.deepEqual(log.list().map(event => event.taskId), ['t3', 't4', 't5'])
})

test('list() 返回新数组，且每条事件都是冻结的（审计记录不可被调用方改写）', () => {
  const log = new RouteEventLog(4)
  log.record({ type: 'dispatch', taskId: 't1' })
  const listed = log.list()
  assert.notEqual(listed, log.list(), '每次读取都是新数组')
  assert.equal(Object.isFrozen(listed[0]), true)
  assert.equal(Reflect.set(listed[0] as object, 'taskId', 'mutated'), false)
  listed.push({ type: 'queue', at: 0 })
  assert.equal(log.size(), 1)
  assert.equal(log.list()[0]!.taskId, 't1')
})

test('ofType / forTask 过滤', () => {
  const log = new RouteEventLog(8)
  log.record({ type: 'dispatch', taskId: 't1' })
  log.record({ type: 'reuse', taskId: 't1', member: 'm1' })
  log.record({ type: 'queue', taskId: 't2', queueReason: '达到 maxMembers' })
  assert.deepEqual(log.ofType('dispatch').map(event => event.taskId), ['t1'])
  assert.deepEqual(log.forTask('t1').map(event => event.type), ['dispatch', 'reuse'])
  assert.deepEqual(log.forTask('nope'), [])
})

test('clear() 清空', () => {
  const log = new RouteEventLog(4)
  log.record({ type: 'dispatch' })
  log.clear()
  assert.equal(log.size(), 0)
  assert.deepEqual(log.list(), [])
})

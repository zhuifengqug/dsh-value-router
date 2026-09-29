/**
 * 设置 schema 的**宿主契约测试**。
 *
 * 这条测试存在的理由：DSH 0.1.7-rc.2 时代 `Config` 用普通 `.default()` 一直没问题，
 * 但宿主在 0.2.0 的 `volatileForm()` 里改成**只保留 volatile 字段**，于是整个条目被
 * 静默跳过——设置里不出现卡片、写入报「配置不可写」，而 tsc 与既有 92 个测试**全绿**。
 * 类型和纯函数都测不出这个问题，只有复刻宿主那条过滤规则才测得出来。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { Config } from '../src/core/schema.ts'

/**
 * 复刻 `dsh-settings/lib/index.js:122-131` 的 volatileForm()。
 * 返回宿主会看到的「设置表单字段数」；0 就意味着该条目会被 `describe()` 跳过。
 */
function volatileFormFieldCount(schema: unknown): number {
  const node = schema as { meta?: { volatile?: boolean }; type?: string; dict?: Record<string, unknown> }
  if (node?.meta?.volatile === true) return 1
  if (node?.type === 'object') {
    return Object.values(node.dict ?? {})
      .reduce<number>((sum, child) => sum + volatileFormFieldCount(child), 0)
  }
  return 0
}

test('回归：Config 的每个字段都必须标记 volatile，否则命名空间不会被宿主服务', () => {
  // 0.2.0 的 bug：这里是 0，宿主 describe() 直接返回 []，卡片不渲染 + 写入报不可写。
  const count = volatileFormFieldCount(Config)
  assert.ok(count >= 5, `设置表单只认出 ${count} 个字段；宿主会跳过整个 value-router 命名空间`)

  // 逐个点名：少任何一个字段都会让对应设置项在 GUI 里消失
  const fields = (Config as unknown as { dict: Record<string, unknown> }).dict
  for (const key of ['enabled', 'strategy', 'pool', 'executor', 'ambiguousPolicy']) {
    assert.ok(key in fields, `缺少字段 ${key}`)
  }
  for (const [key, field] of Object.entries(fields)) {
    const volatile = volatileFormFieldCount(field)
    assert.ok(volatile > 0, `字段 ${key} 没有 volatile 子字段，GUI 里会缺失`)
  }
})

test('兜底线路与池内线路的子字段也都必须是 volatile', () => {
  const fields = (Config as unknown as { dict: Record<string, unknown> }).dict
  const executor = fields.executor as { type?: string; dict: Record<string, unknown> }
  // schemastery 的数组节点用 `inner` 持有元素 schema（不是 zod 的 `item`）
  const poolArray = fields.pool as { type?: string; meta?: { volatile?: boolean }; inner?: { dict: Record<string, unknown> } }

  assert.equal(volatileFormFieldCount(executor), 3, 'provider/model/reasoningEffort 三项都要在')
  assert.equal(poolArray.type, 'array')
  assert.equal(poolArray.meta?.volatile, true, 'pool 本身必须是 volatile，否则整个池设置项不出现')
  assert.ok(poolArray.inner, '数组节点应持有元素 schema')
  assert.equal(volatileFormFieldCount(poolArray.inner), 4, 'provider/model/reasoningEffort/tier 四项都要在')
})

/**
 * 设置 schema 的**宿主契约测试**。
 *
 * 这条测试存在的原因：同一个症状栽了两次，都是「设置里没有卡片 + 写入报不可写」，
 * 而 tsc 与既有测试**全绿**：
 *
 * 1. 忘了给字段加 `.volatile()` —— 宿主 `volatileForm()` 只保留 volatile 字段，
 *    每个叶子被丢弃，整个条目在 `describe():419` 被跳过。
 * 2. 忘了从 **entry 模块** re-export `Config` —— 宿主 `schema(entry)` 读的是
 *    `entry.fiber.runtime.Config`，也就是主入口模块的导出对象，整个模块对它不可见。
 *
 * 所以本文件**必须从 entry 模块导入**：只测 `core/schema.ts` 会漏掉第 2 种。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { Config } from '../src/index.ts'
import { Config as SchemaModuleConfig } from '../src/core/schema.ts'

test('回归：entry 模块必须导出 Config —— 宿主读的是 entry.fiber.runtime.Config', () => {
  assert.notEqual(Config, undefined, 'entry 模块没有导出 Config，宿主读不到设置 schema')
  assert.equal(Config, SchemaModuleConfig, 'entry 导出的必须是 core/schema.ts 里那一个')
  // schemastery 的 schema 是**可调用对象**（函数 + toJSON），不是普通对象；
  // 宿主判断用的是 `schema !== undefined && 'toJSON' in schema`，函数同样满足。
  assert.equal(typeof (Config as { toJSON?: unknown }).toJSON, 'function', '宿主要求 schema 有 toJSON')
  assert.equal(typeof (Config as { meta?: unknown }).meta, 'object', '宿主要读 schema.meta.volatile')
})

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
  assert.ok(count >= 6, `设置表单只认出 ${count} 个字段；宿主会跳过整个 value-router 命名空间`)

  // 逐个点名：少任何一个字段都会让对应设置项在 GUI 里消失
  const fields = (Config as unknown as { dict: Record<string, unknown> }).dict
  for (const key of ['enabled', 'strategy', 'tiers', 'executor', 'ambiguousPolicy', 'tierRouting']) {
    assert.ok(key in fields, `缺少字段 ${key}`)
  }
  for (const [key, field] of Object.entries(fields)) {
    const volatile = volatileFormFieldCount(field)
    assert.ok(volatile > 0, `字段 ${key} 没有 volatile 子字段，GUI 里会缺失`)
  }
})

test('兜底线路、档位与池内线路的子字段也都必须是 volatile', () => {
  const fields = (Config as unknown as { dict: Record<string, unknown> }).dict
  const executor = fields.executor as { type?: string; dict: Record<string, unknown> }
  // schemastery 的数组节点用 `inner` 持有元素 schema（不是 zod 的 `item`）
  const tiersArray = fields.tiers as {
    type?: string
    meta?: { volatile?: boolean }
    inner?: { type?: string; dict: Record<string, unknown> }
  }

  assert.equal(volatileFormFieldCount(executor), 3, 'provider/model/reasoningEffort 三项都要在')
  assert.equal(tiersArray.type, 'array')
  assert.equal(tiersArray.meta?.volatile, true, 'tiers 本身必须是 volatile，否则整个档位设置项不出现')
  assert.ok(tiersArray.inner, '数组节点应持有元素 schema')
  assert.equal(volatileFormFieldCount(tiersArray.inner), 3, '档位的 id/label/pool 三项都要在')
  // 档位的 pool 是嵌套数组，内层三条线路字段也必须 volatile
  const tierNode = tiersArray.inner as { dict: Record<string, { inner?: unknown }> }
  assert.equal(volatileFormFieldCount(tierNode.dict.pool?.inner), 3, '线路的 provider/model/reasoningEffort 三项都要在')
})

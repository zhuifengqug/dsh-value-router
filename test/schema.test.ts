/**
 * 设置 schema 回归守卫。
 *
 * 历史两次「设置里没有卡片 + 当前配置不可写」的根因都在这份 schema 上，因此这里
 * 把两条规则**结构性地**钉死：
 *
 * 1. 三个顶层字段（`enabled` / `tiers` / `fallback`）必须都是 volatile，
 *    否则宿主 `volatileForm()` 会把它们逐个丢掉，命名空间不被服务；
 * 2. volatile 只能落在固定对象路径，且**不能被外层 volatile 包住**——
 *    给 `tiers.*.lines.*` 的内层标 volatile 会让 Loader 拒绝整份配置。
 *
 * 另外钉死 `Config` 必须能从**入口模块**导出：宿主从 `entry.fiber.runtime.Config`
 * 读它，少这一行 re-export 就等于没写 schema。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { Config } from '../src/core/schema.ts'
import * as entry from '../src/index.ts'

interface SchemaLike {
  type?: string
  meta?: { volatile?: boolean; default?: unknown }
  dict?: Record<string, SchemaLike>
  inner?: SchemaLike
}

const root = Config as unknown as SchemaLike

test('入口模块必须导出 Config（宿主从 entry.fiber.runtime.Config 读它）', () => {
  // schemastery 的 schema 是可调用的（`Config(value)` 即校验+补默认值），因此断言"非空且同一引用"，
  // 而不是断言它是普通对象。
  const exported = (entry as { Config?: unknown }).Config
  assert.ok(exported !== undefined && exported !== null, 'entry 必须导出 Config')
  assert.equal(exported, Config)
  assert.equal(typeof (exported as { dict?: unknown }).dict, 'object')
})

test('顶层字段恰好是 enabled / tiers / fallback，且三个都是 volatile', () => {
  assert.deepEqual(Object.keys(root.dict ?? {}).sort(), ['enabled', 'fallback', 'tiers'])
  for (const field of ['enabled', 'tiers', 'fallback']) {
    assert.equal(root.dict?.[field]?.meta?.volatile, true, `${field} 必须 volatile`)
  }
})

test('tiers 是**定长对象**（low/medium/high/max），不是数组', () => {
  const tiers = root.dict?.tiers
  assert.equal(tiers?.type, 'object')
  assert.deepEqual(Object.keys(tiers?.dict ?? {}), ['low', 'medium', 'high', 'max'])
})

test('每个档位只含 lines 数组，且内层一律不标 volatile', () => {
  const tiers = root.dict?.tiers
  for (const id of ['low', 'medium', 'high', 'max']) {
    const tier = tiers?.dict?.[id]
    assert.equal(tier?.meta?.volatile, undefined, `tiers.${id} 不能 volatile（会被外层 volatile 包住）`)
    assert.deepEqual(Object.keys(tier?.dict ?? {}), ['lines'])
    const lines = tier?.dict?.lines
    assert.equal(lines?.type, 'array')
    assert.equal(lines?.meta?.volatile, undefined, 'lines 不能 volatile')
    assert.equal(lines?.inner?.meta?.volatile, undefined, '线路元素不能 volatile')
    assert.deepEqual(Object.keys(lines?.inner?.dict ?? {}).sort(), ['model', 'provider', 'reasoning_effort'])
    for (const field of ['provider', 'model', 'reasoning_effort']) {
      assert.equal(lines?.inner?.dict?.[field]?.meta?.volatile, undefined, `线路字段 ${field} 不能 volatile`)
    }
  }
})

test('fallback 是一个整对象 volatile，字段名是 reasoning_effort（snake_case）', () => {
  const fallback = root.dict?.fallback
  assert.equal(fallback?.type, 'object')
  assert.equal(fallback?.meta?.volatile, true)
  assert.deepEqual(Object.keys(fallback?.dict ?? {}).sort(), ['model', 'provider', 'reasoning_effort'])
})

test('退役字段不再出现在 schema 里', () => {
  const names = new Set<string>()
  const walk = (schema: SchemaLike | undefined): void => {
    for (const [key, child] of Object.entries(schema?.dict ?? {})) {
      names.add(key)
      walk(child)
      if (child.inner) walk(child.inner)
    }
  }
  walk(root)
  for (const retired of ['strategy', 'pool', 'executor', 'ambiguousPolicy', 'tierRouting', 'label', 'id']) {
    assert.equal(names.has(retired), false, `退役字段 ${retired} 不应出现在 schema 中`)
  }
})

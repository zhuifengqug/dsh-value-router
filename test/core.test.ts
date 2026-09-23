/**
 * 核心契约离线单测（桥接通道退役后的第三版规格）。
 * 运行：node --experimental-strip-types --experimental-test-isolation=none --test "test/core.test.ts"
 *
 * 只覆盖跨模块的**契约形状**；字段语义见 config.test.ts，提示段见 policy.test.ts，
 * 计量见 state.test.ts，typert codec 见 typert.test.ts。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_CONFIG,
  DEFAULT_SCOPE,
  DEFAULT_STRATEGY,
  VALUE_ROUTER_PRESET_ID,
  VALUE_ROUTER_SETTINGS_NAMESPACE,
  resolveConfig,
} from '../src/core/config.ts'
import { EMPTY_STATUS_SNAPSHOT } from '../src/core/snapshot.ts'

/** 归一化后配置的键集（新契约：恰好 5 个字段）。 */
const CONFIG_KEYS = ['enabled', 'excludePresets', 'executor', 'scope', 'strategy'] as const
/** 状态快照的必填键集（executorReason 是唯一的可选键，缺省时不出现）。 */
const SNAPSHOT_KEYS = ['enabled', 'executor', 'executorCallsTotal', 'executorStatus', 'scope', 'strategy'] as const

test('配置面契约：resolveConfig 输出恰好 5 个字段', () => {
  const c = resolveConfig(undefined)
  assert.deepEqual(Object.keys(c).sort(), [...CONFIG_KEYS].sort())
  assert.deepEqual(c, DEFAULT_CONFIG)
  assert.deepEqual(c.executor, { provider: '', model: '', reasoningEffort: '' })
  // 共享常量的契约
  assert.equal(VALUE_ROUTER_SETTINGS_NAMESPACE, 'value-router')
  assert.equal(VALUE_ROUTER_PRESET_ID, 'value-router')
  assert.equal(DEFAULT_STRATEGY, 'balanced')
  assert.equal(DEFAULT_SCOPE, 'preset')
})

test('旧配置缺字段仍可加载：每个字段独立兜底', () => {
  // 只给了 scope：其余字段落到默认值
  const onlyScope = resolveConfig({ scope: 'global' })
  assert.equal(onlyScope.enabled, DEFAULT_CONFIG.enabled)
  assert.equal(onlyScope.strategy, DEFAULT_CONFIG.strategy)
  assert.deepEqual(onlyScope.excludePresets, [])
  assert.deepEqual(onlyScope.executor, { provider: '', model: '', reasoningEffort: '' })

  // 非法枚举值逐字段回落，不影响其它字段
  const mixed = resolveConfig({
    scope: 'everything' as never,
    strategy: 'turbo' as never,
    executor: { provider: ' p ', model: 42 } as never,
  })
  assert.equal(mixed.scope, 'preset')
  assert.equal(mixed.strategy, 'balanced')
  assert.deepEqual(mixed.executor, { provider: 'p', model: '', reasoningEffort: '' })

  // executor 整体缺失/类型不对 → 空三元组，不抛错
  assert.deepEqual(resolveConfig({ executor: undefined }).executor, { provider: '', model: '', reasoningEffort: '' })
  assert.deepEqual(resolveConfig({ executor: 'junk' as never }).executor, { provider: '', model: '', reasoningEffort: '' })
})

test('状态快照契约：EMPTY_STATUS_SNAPSHOT 是服务未挂载时的安全默认值', () => {
  assert.deepEqual(Object.keys(EMPTY_STATUS_SNAPSHOT).sort(), [...SNAPSHOT_KEYS].sort())
  assert.equal(EMPTY_STATUS_SNAPSHOT.enabled, false, '未挂载时总开关读作关闭')
  assert.equal(EMPTY_STATUS_SNAPSHOT.scope, 'preset')
  assert.equal(EMPTY_STATUS_SNAPSHOT.strategy, 'balanced')
  assert.deepEqual(EMPTY_STATUS_SNAPSHOT.executor, { provider: '', model: '', reasoningEffort: '' })
  assert.equal(EMPTY_STATUS_SNAPSHOT.executorStatus, 'disabled')
  assert.equal(EMPTY_STATUS_SNAPSHOT.executorCallsTotal, 0)
  assert.ok(!('executorReason' in EMPTY_STATUS_SNAPSHOT), '可选的 executorReason 缺省时不应出现')
})

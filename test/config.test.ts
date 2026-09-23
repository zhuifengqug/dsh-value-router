/**
 * 配置归一化测试：安全默认值、生效范围、策略、executor 归一化、
 * 设置校验（assertConfigValid）、会话覆写合并与清洗。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_CONFIG,
  assertConfigValid,
  isCompleteModelRoute,
  normalizeSessionOverride,
  resolveConfig,
  resolveEffectiveConfig,
  resolveSessionConfig,
  scopeAllowsPreset,
} from '../src/core/config.ts'

test('resolveConfig(undefined) 返回安全默认值', () => {
  const c = resolveConfig(undefined)
  assert.equal(c.enabled, true)
  assert.equal(c.scope, 'preset')
  assert.deepEqual(c.excludePresets, [])
  assert.equal(c.strategy, 'balanced')
  assert.deepEqual(c.executor, { provider: '', model: '', reasoningEffort: '' })
  assert.deepEqual(c, DEFAULT_CONFIG)
})

test('旧配置缺新增字段仍可加载（逐字段兜底）', () => {
  const c = resolveConfig({ enabled: true, executor: { provider: 'p', model: 'm' } })
  assert.equal(c.scope, 'preset')
  assert.equal(c.strategy, 'balanced')
  assert.deepEqual(c.excludePresets, [])
  // 只给了 provider/model：reasoningEffort 补空串
  assert.deepEqual(c.executor, { provider: 'p', model: 'm', reasoningEffort: '' })
})

test('非法枚举值回落到默认档位', () => {
  const c = resolveConfig({ strategy: 'turbo' as never, scope: 'everything' as never })
  assert.equal(c.strategy, 'balanced')
  assert.equal(c.scope, 'preset')
})

test('executor 归一化：trim、非字符串字段回落空串', () => {
  const c = resolveConfig({
    executor: { provider: ' deepseek ', model: ' deepseek-chat ', reasoningEffort: ' low ' } as never,
  })
  assert.deepEqual(c.executor, { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'low' })

  const partial = resolveConfig({ executor: { provider: 'p', model: '', reasoningEffort: 7 } as never })
  assert.deepEqual(partial.executor, { provider: 'p', model: '', reasoningEffort: '' })

  const junk = resolveConfig({ executor: null as never })
  assert.deepEqual(junk.executor, { provider: '', model: '', reasoningEffort: '' })
})

// —— 回归：历史 settings.yaml 里可能残留已退役通道的配置块 ——
test('旧配置残留 bridge 字段不影响加载', () => {
  // schemastery 的 object 对未知键不报错，resolveConfig 也必须同样宽容：
  // 逐字段读取、绝不透传残留键，用户不需要手工清理设置文件。
  // （本用例是退役验收唯一允许出现该字面量的位置。）
  let resolved: ReturnType<typeof resolveConfig> | undefined
  assert.doesNotThrow(() => {
    resolved = resolveConfig({ enabled: true, bridge: { enabled: true } } as never)
  })
  const c = resolved!
  assert.equal(c.enabled, true)
  assert.equal(Object.hasOwn(c, 'bridge'), false, '归一化结果不应出现残留的 bridge 键')
  assert.deepEqual(c.executor, { provider: '', model: '', reasoningEffort: '' })
  assert.deepEqual(Object.keys(c).sort(), ['enabled', 'excludePresets', 'executor', 'scope', 'strategy'])
})

test('excludePresets 归一化：非法项被丢弃，空数组保留', () => {
  assert.deepEqual(resolveConfig({ excludePresets: ['liangshen', '', 42 as never, '  '] }).excludePresets, ['liangshen'])
  assert.deepEqual(resolveConfig({ excludePresets: [] }).excludePresets, [])
  assert.deepEqual(resolveConfig({ excludePresets: 'nope' as never }).excludePresets, [])
})

test('isCompleteModelRoute 要求 provider 与 model 都非空', () => {
  assert.equal(isCompleteModelRoute({ provider: 'p', model: 'm' }), true)
  assert.equal(isCompleteModelRoute({ provider: 'p', model: '  ' }), false)
  assert.equal(isCompleteModelRoute({}), false)
  assert.equal(isCompleteModelRoute(undefined), false)
})

test('resolveSessionConfig 只覆盖显式给出的字段', () => {
  const merged = resolveSessionConfig({ strategy: 'balanced', enabled: true }, { strategy: 'saver' })
  assert.equal(merged.strategy, 'saver')
  assert.equal(merged.enabled, true)
  assert.equal(resolveSessionConfig({ strategy: 'balanced' }, undefined).strategy, 'balanced')
})

test('resolveEffectiveConfig 合并覆写后再归一化', () => {
  const c = resolveEffectiveConfig(
    { enabled: true, executor: { provider: 'p', model: 'm' } },
    { strategy: 'powerful', executor: { provider: 'x', model: 'y' } },
  )
  assert.equal(c.strategy, 'powerful')
  assert.equal(c.executor.provider, 'x')
  assert.equal(c.executor.model, 'y')
  // 覆写只带 provider/model 时 reasoningEffort 仍补空串
  assert.equal(c.executor.reasoningEffort, '')
  assert.equal(c.scope, 'preset')
})

test('scopeAllowsPreset：preset 模式只认专属预设；global 模式用排除清单', () => {
  const preset = resolveConfig({ scope: 'preset' })
  assert.equal(scopeAllowsPreset(preset, 'value-router'), true)
  assert.equal(scopeAllowsPreset(preset, 'standard'), false)
  assert.equal(scopeAllowsPreset(preset, undefined), false)

  const global = resolveConfig({ scope: 'global', excludePresets: ['liangshen'] })
  assert.equal(scopeAllowsPreset(global, 'liangshen'), false)
  assert.equal(scopeAllowsPreset(global, 'standard'), true)
  assert.equal(scopeAllowsPreset(global, undefined), true)
})

test('normalizeSessionOverride 丢弃未知键与非法值', () => {
  assert.equal(normalizeSessionOverride(null), undefined)
  assert.equal(normalizeSessionOverride({}), undefined)
  assert.equal(normalizeSessionOverride({ evil: true }), undefined)
  assert.deepEqual(normalizeSessionOverride({ enabled: false, strategy: 'nope', extra: 1 }), { enabled: false })
  assert.deepEqual(
    normalizeSessionOverride({ strategy: 'saver', executor: { provider: ' p ', model: 'm', nope: 1 } }),
    { strategy: 'saver', executor: { provider: 'p', model: 'm' } },
  )
  assert.deepEqual(
    normalizeSessionOverride({ executor: { reasoningEffort: ' high ' } }),
    { executor: { reasoningEffort: 'high' } },
  )
})

test('assertConfigValid：默认（未选 executor）必须可加载，半配置才抛错', () => {
  // 回归项：settings 的 validate 会在注册时被调用，这里抛错会让插件树加载失败。
  assert.doesNotThrow(() => assertConfigValid(undefined))
  assert.doesNotThrow(() => assertConfigValid({}))
  assert.doesNotThrow(() => assertConfigValid({ enabled: true }))
  assert.doesNotThrow(() => assertConfigValid({ enabled: true, executor: { provider: '', model: '' } }))
  // 半配置（只填一边）是真错误
  assert.throws(() => assertConfigValid({ enabled: true, executor: { provider: 'p' } }))
  assert.throws(() => assertConfigValid({ enabled: true, executor: { model: 'm' } }))
  assert.doesNotThrow(() => assertConfigValid({ enabled: true, executor: { provider: 'p', model: 'm' } }))
})

test('assertConfigValid：enabled=false 时跳过 executor 校验', () => {
  // 总开关关闭 → 子代理通道整体不生效，半配置不阻塞加载
  assert.doesNotThrow(() => assertConfigValid({ enabled: false }))
  assert.doesNotThrow(() => assertConfigValid({ enabled: false, executor: { provider: 'p' } }))
  assert.doesNotThrow(() => assertConfigValid({ enabled: false, executor: { model: 'm' } }))
})

/**
 * 配置归一化测试：安全默认值、策略 → 门控参数映射、tuning 覆盖、会话覆写合并。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_CONFIG,
  STRATEGY_TUNING,
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
  assert.equal(c.maxDepth, 1)
  assert.equal(c.bridge.baseUrl, 'http://127.0.0.1:8080/v1')
  assert.equal(c.bridge.trustUsage, 'auto')
  // 账号安全：桥并发与委派并发恒为 1
  assert.equal(c.bridge.concurrency, 1)
  assert.equal(c.maxConcurrentDelegations, 1)
})

test('旧配置缺新增字段仍可加载（逐字段兜底）', () => {
  const c = resolveConfig({ enabled: true, executor: { provider: 'p', model: 'm' } })
  assert.equal(c.scope, 'preset')
  assert.equal(c.strategy, 'balanced')
  assert.equal(c.bridge.modelMap.plain, DEFAULT_CONFIG.bridge.modelMap.plain)
  assert.equal(c.bridge.maxBatchItems, 10)
})

test('非法枚举值回落到默认档位', () => {
  const c = resolveConfig({ strategy: 'turbo' as never, scope: 'everything' as never, defaultThinking: 'maybe' as never })
  assert.equal(c.strategy, 'balanced')
  assert.equal(c.scope, 'preset')
  assert.equal(c.defaultThinking, 'silent')
})

test('策略推导门控参数', () => {
  for (const strategy of ['saver', 'balanced', 'powerful'] as const) {
    const c = resolveConfig({ strategy })
    assert.equal(c.minEstimatedSavedTokens, STRATEGY_TUNING[strategy].minEstimatedSavedTokens)
    assert.equal(c.maxDelegationsPerTask, STRATEGY_TUNING[strategy].maxDelegationsPerTask)
    assert.equal(c.maxDelegationsPerHour, STRATEGY_TUNING[strategy].maxDelegationsPerHour)
  }
  assert.ok(STRATEGY_TUNING.saver.minEstimatedSavedTokens > STRATEGY_TUNING.powerful.minEstimatedSavedTokens)
})

test('tuning 显式字段覆盖策略推导值', () => {
  const c = resolveConfig({
    strategy: 'saver',
    tuning: { minEstimatedSavedTokens: 50, maxDelegationsPerTask: 99, maxInputCharacters: 2000 },
  })
  assert.equal(c.minEstimatedSavedTokens, 50)
  assert.equal(c.maxDelegationsPerTask, 99)
  assert.equal(c.maxInputCharacters, 2000)
  // 未显式给出的字段仍按策略推导
  assert.equal(c.maxDelegationsPerHour, STRATEGY_TUNING.saver.maxDelegationsPerHour)
})

test('并发护栏不可被 tuning 突破', () => {
  const c = resolveConfig({ tuning: { maxConcurrentDelegations: 8 } })
  assert.equal(c.maxConcurrentDelegations, 1)
  const c2 = resolveConfig({ bridge: { concurrency: 8 } as never })
  assert.equal(c2.bridge.concurrency, 1)
})

test('bridge 配置逐字段兜底且丢弃非法 extraHeaders', () => {
  const c = resolveConfig({
    bridge: {
      baseUrl: 'http://127.0.0.1:9999/v1',
      apiKey: 'secret',
      extraHeaders: { 'X-A': 'ok', 'X-B': 42 } as never,
      modelMap: { plain: 'p1' } as never,
      trustUsage: 'never',
    },
  })
  assert.equal(c.bridge.baseUrl, 'http://127.0.0.1:9999/v1')
  assert.equal(c.bridge.apiKey, 'secret')
  assert.deepEqual(c.bridge.extraHeaders, { 'X-A': 'ok' })
  assert.equal(c.bridge.modelMap.plain, 'p1')
  assert.equal(c.bridge.modelMap.thinking, DEFAULT_CONFIG.bridge.modelMap.thinking)
  assert.equal(c.bridge.trustUsage, 'never')
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
  assert.equal(c.minEstimatedSavedTokens, STRATEGY_TUNING.powerful.minEstimatedSavedTokens)
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
})

test('assertConfigValid：enabled 但 executor 不完整时抛错', () => {
  assert.throws(() => assertConfigValid({ enabled: true, executor: { provider: 'p' } }))
  assert.doesNotThrow(() => assertConfigValid({ enabled: true, executor: { provider: 'p', model: 'm' } }))
  assert.doesNotThrow(() => assertConfigValid({ enabled: false }))
})

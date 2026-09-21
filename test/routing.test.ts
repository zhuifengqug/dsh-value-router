/**
 * 路由决策回归测试（规格 §3.2 + 验收「任何情况下主会话模型不被改写」）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { decideSubagentRoute, pickOverride } from '../src/core/routing.ts'
import type { ValueRouterConfig } from '../src/core/config.ts'

const EXECUTOR = { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: '' }

function baseConfig(overrides: Partial<ValueRouterConfig> = {}): Partial<ValueRouterConfig> {
  return {
    enabled: true,
    scope: 'preset',
    strategy: 'balanced',
    executor: { ...EXECUTOR },
    ...overrides,
  }
}

const SUBAGENT = { agentPreset: 'value-router', origin: 'subagent' }

test('scope=preset：专属预设内的子代理被路由到 executor', () => {
  const decision = decideSubagentRoute({
    globalConfig: baseConfig(),
    ...SUBAGENT,
    executorAvailable: true,
  })
  assert.equal(decision.route, true)
  if (!decision.route) return
  assert.equal(decision.provider, 'deepseek')
  assert.equal(decision.model, 'deepseek-chat')
  assert.equal(decision.overrideSource, 'global')
})

test('scope=preset：其它预设的会话不被路由', () => {
  const decision = decideSubagentRoute({
    globalConfig: baseConfig(),
    agentPreset: 'standard',
    origin: 'subagent',
    executorAvailable: true,
  })
  assert.deepEqual(decision, { route: false, reason: 'scope' })
})

test('scope=global：未选择预设的会话也生效', () => {
  const decision = decideSubagentRoute({
    globalConfig: baseConfig({ scope: 'global' }),
    origin: 'subagent',
    executorAvailable: true,
  })
  assert.equal(decision.route, true)
})

test('scope=global：excludePresets 命中的预设不被路由', () => {
  const decision = decideSubagentRoute({
    globalConfig: baseConfig({ scope: 'global', excludePresets: ['liangshen'] }),
    agentPreset: 'liangshen',
    origin: 'subagent',
    executorAvailable: true,
  })
  assert.deepEqual(decision, { route: false, reason: 'scope' })
})

test('主会话（origin 非 subagent）永不被改写——最关键回归项', () => {
  for (const origin of [undefined, 'user', 'command'] as const) {
    const decision = decideSubagentRoute({
      globalConfig: baseConfig({ scope: 'global' }),
      agentPreset: 'value-router',
      ...(origin !== undefined ? { origin } : {}),
      executorAvailable: true,
    })
    assert.deepEqual(decision, { route: false, reason: 'not-subagent' })
  }
})

test('总开关关闭时不路由', () => {
  const decision = decideSubagentRoute({
    globalConfig: baseConfig({ enabled: false }),
    ...SUBAGENT,
    executorAvailable: true,
  })
  assert.deepEqual(decision, { route: false, reason: 'disabled' })
})

test('executor 未配置完整时不路由（executor 缺失不影响桥工具，此处只关子代理通道）', () => {
  const decision = decideSubagentRoute({
    globalConfig: baseConfig({ executor: { provider: 'deepseek', model: '' } }),
    ...SUBAGENT,
    executorAvailable: true,
  })
  assert.deepEqual(decision, { route: false, reason: 'executor-incomplete' })
})

test('executor provider 不可用时安全降级为普通路由', () => {
  const decision = decideSubagentRoute({
    globalConfig: baseConfig(),
    ...SUBAGENT,
    executorAvailable: false,
  })
  assert.deepEqual(decision, { route: false, reason: 'executor-unavailable' })
})

test('会话覆写可关闭本会话路由', () => {
  const decision = decideSubagentRoute({
    globalConfig: baseConfig(),
    ...SUBAGENT,
    sessionOverride: { enabled: false },
    executorAvailable: true,
  })
  assert.deepEqual(decision, { route: false, reason: 'disabled' })
})

test('会话覆写可换 executor，并带上 reasoningEffort', () => {
  const decision = decideSubagentRoute({
    globalConfig: baseConfig(),
    ...SUBAGENT,
    sessionOverride: {
      strategy: 'saver',
      executor: { provider: 'other', model: 'cheap-model', reasoningEffort: 'low' },
    },
    executorAvailable: true,
  })
  assert.equal(decision.route, true)
  if (!decision.route) return
  assert.equal(decision.provider, 'other')
  assert.equal(decision.model, 'cheap-model')
  assert.equal(decision.reasoningEffort, 'low')
  assert.equal(decision.overrideSource, 'session')
  assert.equal(decision.effective.strategy, 'saver')
  // 策略随之影响桥门控参数（saver 更严格）
  assert.equal(decision.effective.minEstimatedSavedTokens, 300)
})

test('子代理没有自身覆写时使用父会话覆写', () => {
  const decision = decideSubagentRoute({
    globalConfig: baseConfig(),
    ...SUBAGENT,
    parentOverride: { executor: { provider: 'parent-provider', model: 'parent-model' } },
    executorAvailable: true,
  })
  assert.equal(decision.route, true)
  if (!decision.route) return
  assert.equal(decision.provider, 'parent-provider')
  assert.equal(decision.overrideSource, 'parent')
})

test('自身覆写优先于父会话覆写', () => {
  const decision = decideSubagentRoute({
    globalConfig: baseConfig(),
    ...SUBAGENT,
    sessionOverride: { executor: { provider: 'own', model: 'own-model' } },
    parentOverride: { executor: { provider: 'parent-provider', model: 'parent-model' } },
    executorAvailable: true,
  })
  assert.equal(decision.route, true)
  if (!decision.route) return
  assert.equal(decision.provider, 'own')
  assert.equal(decision.overrideSource, 'session')
})

test('pickOverride：无覆写时回落到全局配置', () => {
  assert.deepEqual(pickOverride(undefined, undefined), { override: undefined, source: 'global' })
  assert.equal(pickOverride(undefined, { enabled: true }).source, 'parent')
  assert.equal(pickOverride({ enabled: true }, { enabled: false }).source, 'session')
})

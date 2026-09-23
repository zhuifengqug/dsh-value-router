/**
 * 路由决策回归测试（规格 §3.2 + 验收「任何情况下主会话模型不被改写」）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { decideSubagentRoute, pickOverride, resolveCurrentPreset } from '../src/core/routing.ts'
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

test('executor 未配置完整时不路由（此处只关子代理通道）', () => {
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
  // 覆写后的生效配置仍是完整的 5 字段形状
  assert.equal(decision.effective.scope, 'preset')
  assert.deepEqual(decision.effective.excludePresets, [])
  assert.deepEqual(decision.effective.executor, { provider: 'other', model: 'cheap-model', reasoningEffort: 'low' })
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

// —— 会话当前预设的解析（实测事故回归：header 是创建时的值，切换预设不改它）——

test('resolveCurrentPreset：实时组合优先于会话投影优先于创建 header', () => {
  assert.equal(
    resolveCurrentPreset({ composed: 'value-router', projection: 'standard', header: 'standard' }),
    'value-router',
  )
  assert.equal(
    resolveCurrentPreset({ composed: undefined, projection: 'value-router', header: 'standard' }),
    'value-router',
  )
  assert.equal(
    resolveCurrentPreset({ composed: null, projection: null, header: 'value-router' }),
    'value-router',
  )
})

test('resolveCurrentPreset：三者都缺失/为空时返回 undefined', () => {
  assert.equal(resolveCurrentPreset({}), undefined)
  assert.equal(resolveCurrentPreset({ composed: undefined, projection: null, header: '' }), undefined)
})

test('回归：会话以 standard 创建、随即切成 value-router，scope=preset 必须仍然生效', () => {
  // 事故现场：header.agentPreset === 'standard'（创建时的值，不可变），
  // 而实时组合/投影都已经是 value-router。按 header 判定会一直「不在生效范围」，
  // 表现为「选了价值路由预设却一次都不派子代理」。
  const resolved = resolveCurrentPreset({
    composed: 'value-router',
    projection: 'value-router',
    header: 'standard',
  })
  assert.equal(resolved, 'value-router')

  const decision = decideSubagentRoute({
    globalConfig: baseConfig(),
    agentPreset: resolved,
    origin: 'subagent',
    executorAvailable: true,
  })
  assert.equal(decision.route, true, '按当前预设判定应路由')

  // 反证：如果仍然拿创建 header，就会被 scope 门静默跳过
  const wrong = decideSubagentRoute({
    globalConfig: baseConfig(),
    agentPreset: 'standard',
    origin: 'subagent',
    executorAvailable: true,
  })
  assert.deepEqual(wrong, { route: false, reason: 'scope' })
})


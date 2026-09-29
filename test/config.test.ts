/**
 * 配置归一化测试（0.2.0 新契约）：安全默认值、轮转池、兜底线路 sanitize、
 * 会话覆写合并与清洗。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_AMBIGUOUS_POLICY,
  DEFAULT_CONFIG,
  POOL_MAX_LINES,
  formatModelRoute,
  isCompleteModelRoute,
  normalizeSessionOverride,
  resolveConfig,
  resolveEffectiveConfig,
  resolvePool,
  resolveSessionConfig,
  sanitizeExecutor,
  strategyLabel,
  tierLabel,
} from '../src/core/config.ts'

test('resolveConfig(undefined) 返回安全默认值', () => {
  const c = resolveConfig(undefined)
  assert.equal(c.enabled, true)
  assert.equal(c.strategy, 'balanced')
  assert.deepEqual(c.pool, [])
  assert.deepEqual(c.executor, { provider: '', model: '', reasoningEffort: '' })
  assert.equal(c.ambiguousPolicy, 'rotate')
  assert.deepEqual(c, DEFAULT_CONFIG)
})

test('旧配置缺新增字段仍可加载（逐字段兜底）', () => {
  const c = resolveConfig({ enabled: true, executor: { provider: 'p', model: 'm' } })
  assert.equal(c.strategy, 'balanced')
  assert.deepEqual(c.pool, [], '0.1.0 的配置没有池，池应为空而不是报错')
  assert.deepEqual(c.executor, { provider: 'p', model: 'm', reasoningEffort: '' })
})

test('非法枚举值逐字段回落到默认，不影响其它字段', () => {
  const c = resolveConfig({
    strategy: 'turbo' as never,
    ambiguousPolicy: 'coin-flip' as never,
    executor: { provider: 'p', model: 'm' },
  })
  assert.equal(c.strategy, 'balanced')
  assert.equal(c.ambiguousPolicy, DEFAULT_AMBIGUOUS_POLICY)
  assert.equal(c.executor.provider, 'p')
})

test('0.1.0 的旧 scope/excludePresets 变成无害的未知键', () => {
  // 迁移策略：不写迁移代码。旧键保留在 settings 里不影响运行，
  // 也不会让插件加载失败——保留一个默认值错误的枚举反而危险。
  const c = resolveConfig({ scope: 'preset', excludePresets: ['x'] } as never)
  assert.equal(Object.hasOwn(c, 'scope'), false)
  assert.equal(Object.hasOwn(c, 'excludePresets'), false)
  assert.equal(c.enabled, true, '旧配置不会让插件整体失效')
})

test('旧配置残留 bridge 字段不影响加载', () => {
  let resolved: ReturnType<typeof resolveConfig> | undefined
  assert.doesNotThrow(() => {
    resolved = resolveConfig({ enabled: true, bridge: { enabled: true } } as never)
  })
  const c = resolved!
  assert.equal(c.enabled, true)
  assert.equal(Object.hasOwn(c, 'bridge'), false)
})

// —— 轮转池 ——

test('resolvePool：正常线路 trim 并补空 reasoningEffort / 默认 mid 档', () => {
  const pool = resolvePool([
    { provider: ' p1 ', model: ' m1 ', reasoningEffort: ' low ' },
    { provider: 'p2', model: 'm2', tier: 'strong' },
  ])
  assert.deepEqual(pool, [
    { provider: 'p1', model: 'm1', reasoningEffort: 'low', tier: 'mid' },
    { provider: 'p2', model: 'm2', reasoningEffort: '', tier: 'strong' },
  ])
})

test('resolvePool：单项非法只丢这一项，不整池丢弃', () => {
  const pool = resolvePool([
    { provider: 'p1', model: 'm1', tier: 'cheap' },
    { provider: '', model: 'm2' },
    { provider: 'p3' },
    null,
    'junk',
    { provider: 'p4', model: 'm4', tier: 'ultra' as never },
  ])
  assert.deepEqual(pool.map(line => line.provider), ['p1', 'p4'])
  assert.equal(pool[1]?.tier, 'mid', '非法 tier 回落到中性档')
})

test('resolvePool：超过上限时截断，保留靠前的线路', () => {
  const many = Array.from({ length: POOL_MAX_LINES + 3 }, (_, i) => ({
    provider: `p${i}`, model: `m${i}`, tier: 'mid' as const,
  }))
  const pool = resolvePool(many)
  assert.equal(pool.length, POOL_MAX_LINES)
  assert.equal(pool[0]?.provider, 'p0')
  assert.equal(pool[pool.length - 1]?.provider, `p${POOL_MAX_LINES - 1}`)
})

test('resolvePool：非数组一律回落空池', () => {
  assert.deepEqual(resolvePool(undefined), [])
  assert.deepEqual(resolvePool('nope'), [])
  assert.deepEqual(resolvePool({ provider: 'p' }), [])
})

// —— 兜底线路 ——

test('sanitizeExecutor：半配置归一化为「未配置」而不是抛错', () => {
  // 0.1.0 的 assertConfigValid 根本没有调用点（死导入），半配置一直可能存在。
  // 0.2.0 把处理下沉到读路径：半配置 = 兜底不可用 = 不改写，绝不中断会话。
  assert.deepEqual(
    sanitizeExecutor({ provider: 'p', model: '', reasoningEffort: '' }),
    { provider: '', model: '', reasoningEffort: '' },
  )
  assert.deepEqual(
    sanitizeExecutor({ provider: '', model: 'm', reasoningEffort: 'low' }),
    { provider: '', model: '', reasoningEffort: '' },
  )
  assert.deepEqual(
    sanitizeExecutor({ provider: 'p', model: 'm', reasoningEffort: 'low' }),
    { provider: 'p', model: 'm', reasoningEffort: 'low' },
    '完整配置原样保留',
  )
  assert.deepEqual(
    sanitizeExecutor({ provider: '', model: '', reasoningEffort: 'low' }),
    { provider: '', model: '', reasoningEffort: 'low' },
    '全空但带 effort：仍视为未配置，不产生半残状态',
  )
})

test('isCompleteModelRoute 要求 provider 与 model 都非空', () => {
  assert.equal(isCompleteModelRoute({ provider: 'p', model: 'm' }), true)
  assert.equal(isCompleteModelRoute({ provider: 'p', model: '  ' }), false)
  assert.equal(isCompleteModelRoute({}), false)
  assert.equal(isCompleteModelRoute(undefined), false)
})

test('formatModelRoute / strategyLabel / tierLabel 的人读输出', () => {
  assert.equal(formatModelRoute({ provider: 'p', model: 'm' }), 'p/m')
  assert.equal(formatModelRoute({ provider: 'p', model: '' }), '（未配置）')
  assert.equal(strategyLabel('saver'), '更省')
  assert.equal(strategyLabel('balanced'), '平衡')
  assert.equal(strategyLabel('powerful'), '更强')
  assert.equal(tierLabel('cheap'), '省')
  assert.equal(tierLabel('mid'), '中')
  assert.equal(tierLabel('strong'), '强')
})

// —— 会话覆写 ——

test('resolveSessionConfig 只覆盖显式给出的字段', () => {
  const merged = resolveSessionConfig({ strategy: 'balanced', enabled: true }, { strategy: 'saver' })
  assert.equal(merged.strategy, 'saver')
  assert.equal(merged.enabled, true)
  assert.equal(resolveSessionConfig({ strategy: 'balanced' }, undefined).strategy, 'balanced')
})

test('会话覆写不覆盖 pool 与 ambiguousPolicy（否则轮转序列会错位）', () => {
  const merged = resolveSessionConfig(
    { pool: [{ provider: 'p', model: 'm', tier: 'mid' }], ambiguousPolicy: 'rotate' },
    { enabled: false, strategy: 'saver' } as never,
  )
  assert.equal(merged.pool?.length, 1, '池不受会话覆写影响')
  assert.equal(merged.ambiguousPolicy, 'rotate')
})

test('resolveEffectiveConfig 合并覆写后再归一化', () => {
  const c = resolveEffectiveConfig(
    { enabled: true, executor: { provider: 'p', model: 'm' } },
    { strategy: 'powerful', executor: { provider: 'x', model: 'y' } },
  )
  assert.equal(c.strategy, 'powerful')
  assert.equal(c.executor.provider, 'x')
  assert.equal(c.executor.model, 'y')
  assert.equal(c.executor.reasoningEffort, '')
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

/**
 * 配置归一化测试（0.4.0 档位结构）：安全默认值、档位归一化、旧扁平 pool 迁移、
 * 兜底线路 sanitize、宿主白名单闸门、会话覆写合并与清洗。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { expandWriteOps } from '../src/client/settings-write.ts'

import {
  DEFAULT_AMBIGUOUS_POLICY,
  DEFAULT_CONFIG,
  applyAllowlist,
  formatModelRoute,
  isCompleteModelRoute,
  migrateLegacyPool,
  normalizeSessionOverride,
  resolveConfig,
  resolveEffectiveConfig,
  resolveSessionConfig,
  resolveTiers,
  routableLines,
  sanitizeExecutor,
  strategyLabel,
  type LegacyPoolLine,
  type Tier,
} from '../src/core/config.ts'

function tier(id: string, label: string, ...routes: [string, string][]): Tier {
  return {
    id,
    label,
    pool: routes.map(([provider, model]) => ({ provider, model, reasoningEffort: '' })),
  }
}

/** 旧扁平线路：tier 标签可选。 */
function legacy(provider: string, model: string, tierLabel?: string): LegacyPoolLine {
  return { provider, model, ...(tierLabel !== undefined ? { tier: tierLabel as LegacyPoolLine['tier'] } : {}) }
}

test('resolveConfig(undefined) 返回安全默认值', () => {
  const c = resolveConfig(undefined)
  assert.equal(c.enabled, true)
  assert.equal(c.strategy, 'balanced')
  assert.deepEqual(c.tiers, [])
  assert.deepEqual(c.executor, { provider: '', model: '', reasoningEffort: '' })
  assert.equal(c.ambiguousPolicy, 'rotate')
  assert.deepEqual(c, DEFAULT_CONFIG)
})

test('旧配置缺新增字段仍可加载（逐字段兜底）', () => {
  const c = resolveConfig({ enabled: true, executor: { provider: 'p', model: 'm' } })
  assert.equal(c.strategy, 'balanced')
  assert.deepEqual(c.tiers, [], '0.2.x 的配置没有档位，档位应为空而不是报错')
  assert.deepEqual(c.executor, { provider: 'p', model: 'm', reasoningEffort: '' })
})

test('旧配置残留 scope / bridge 字段是无害的未知键', () => {
  const c = resolveConfig({ scope: 'preset', excludePresets: ['x'], bridge: { enabled: true } } as never)
  assert.equal(Object.hasOwn(c, 'scope'), false)
  assert.equal(Object.hasOwn(c, 'excludePresets'), false)
  assert.equal(Object.hasOwn(c, 'bridge'), false)
  assert.equal(c.enabled, true, '旧配置不会让插件整体失效')
})

// —— 档位 ——

test('档位归一化：缺 id/label 时按位置补齐，线路逐项校验', () => {
  const tiers = resolveTiers({
    tiers: [
      { pool: [{ provider: ' p1 ', model: ' m1 ', reasoningEffort: ' low ' }] } as Tier,
      { id: 'x', label: '高档', pool: [{ provider: '', model: 'skip' }, 'junk' as never, { provider: 'p2', model: 'm2' }] },
    ],
  })
  assert.equal(tiers.length, 2)
  assert.equal(tiers[0]?.id, 'tier-1')
  assert.equal(tiers[0]?.label, 'tier-1')
  assert.deepEqual(tiers[0]?.pool[0], { provider: 'p1', model: 'm1', reasoningEffort: 'low', allowed: true })
  assert.equal(tiers[1]?.id, 'x')
  assert.equal(tiers[1]?.label, '高档')
  assert.equal(tiers[1]?.pool.length, 1, '非法线路逐条丢弃，不整池丢弃')
  assert.equal(tiers[1]?.pool[0]?.provider, 'p2')
})

test('档位数量与名称不限：用户可自定义 2 档、4 档、任意命名', () => {
  const tiers = resolveTiers({
    tiers: [
      tier('t1', '廉价', ['hetu', 'ds-flash']),
      tier('t2', '均衡', ['commandcode', 'glm']),
      tier('t3', '昂贵', ['commandcode', 'bunny']),
      tier('t4', '复核专用', ['commandcode', 'canary']),
    ],
  })
  assert.equal(tiers.length, 4)
  assert.deepEqual(tiers.map(t => t.label), ['廉价', '均衡', '昂贵', '复核专用'])
})

test('tiers 非空时优先于旧 pool（不做二次迁移）', () => {
  const tiers = resolveTiers({
    tiers: [tier('a', 'A', ['p', 'm'])],
    pool: [legacy('legacy', 'legacy-model', 'strong')],
  })
  assert.equal(tiers.length, 1)
  assert.equal(tiers[0]?.id, 'a')
})

// —— 旧扁平 pool 迁移 ——

test('迁移：按线路原有 tier 标签自动归位，只创建有线路的档位', () => {
  const tiers = migrateLegacyPool([
    legacy('a', 'm', 'cheap'),
    legacy('b', 'm', 'cheap'),
    legacy('c', 'm', 'strong'),
  ])
  assert.deepEqual(tiers.map(t => t.id), ['cheap', 'strong'], '空的 mid 档不创建')
  assert.equal(tiers[0]?.pool.length, 2)
  assert.equal(tiers[1]?.pool.length, 1)
})

test('迁移：标签缺失或非法 → 归入「中」档', () => {
  const tiers = migrateLegacyPool([
    legacy('a', 'm'),
    legacy('b', 'm', 'ultra'),
    legacy('c', 'm', 'cheap'),
  ])
  assert.deepEqual(tiers.map(t => t.id), ['cheap', 'mid'], '顺序固定为 省→中→强')
  assert.equal(tiers[1]?.pool.length, 2, '无标签与非法标签都进 mid')
})

test('迁移：旧 pool 为空或非数组 → 空档位列表', () => {
  assert.deepEqual(migrateLegacyPool([]), [])
  assert.deepEqual(migrateLegacyPool(undefined), [])
  assert.deepEqual(migrateLegacyPool('junk'), [])
  assert.deepEqual(resolveTiers({ pool: [] }), [])
})

test('迁移：tiers 缺失时自动用旧 pool 兜底，用户无需手工搬数据', () => {
  const tiers = resolveTiers({ pool: [legacy('a', 'm', 'cheap')] })
  assert.equal(tiers.length, 1)
  assert.equal(tiers[0]?.id, 'cheap')
})

// —— 兜底线路 ——

test('sanitizeExecutor：半配置归一化为「未配置」而不是抛错', () => {
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
  )
})

test('半配置兜底线路 sanitize 后 = 无处可派（不抛错）', () => {
  const c = resolveConfig({ executor: { provider: 'p', model: '' } })
  assert.equal(isCompleteModelRoute(sanitizeExecutor(c.executor)), false)
})

test('isCompleteModelRoute 要求 provider 与 model 都非空', () => {
  assert.equal(isCompleteModelRoute({ provider: 'p', model: 'm' }), true)
  assert.equal(isCompleteModelRoute({ provider: 'p', model: '  ' }), false)
  assert.equal(isCompleteModelRoute({}), false)
  assert.equal(isCompleteModelRoute(undefined), false)
})

test('formatModelRoute / strategyLabel 的人读输出', () => {
  assert.equal(formatModelRoute({ provider: 'p', model: 'm' }), 'p/m')
  assert.equal(formatModelRoute({ provider: 'p', model: '' }), '（未配置）')
  assert.equal(strategyLabel('saver'), '更省')
  assert.equal(strategyLabel('balanced'), '平衡')
  assert.equal(strategyLabel('powerful'), '更强')
})

// —— 宿主白名单闸门 ——

const ALLOWLIST = [
  { provider: 'hetu', model: 'deepseek-v4.1-flash' },
  { provider: 'commandcode', model: 'z-ai/glm-5.3-flash' },
]

test('白名单闸门：跨所有档位生效', () => {
  const config = resolveConfig({
    tiers: [
      tier('cheap', '省', ['hetu', 'deepseek-v4.1-flash'], ['blocked', 'nope']),
      tier('strong', '强', ['commandcode', 'z-ai/glm-5.3-flash']),
    ],
  })
  const gated = applyAllowlist(config, ALLOWLIST)
  assert.deepEqual(gated.tiers[0]?.pool.map(line => line.allowed), [true, false])
  assert.deepEqual(gated.tiers[1]?.pool.map(line => line.allowed), [true])
  assert.equal(config.tiers[0]?.pool[1]?.allowed, true, '原始配置不被就地修改')
})

test('白名单闸门：同一个模型在多家 provider 各一条，可分别放行', () => {
  const config = resolveConfig({
    tiers: [tier('cheap', '省', ['hetu', 'ds'], ['xiaomi-token-plan-cn', 'ds'])],
  })
  const gated = applyAllowlist(config, [{ provider: 'hetu', model: 'ds' }])
  assert.deepEqual(gated.tiers[0]?.pool.map(line => line.allowed), [true, false])
})

test('白名单闸门：读不到白名单时全部放行（不静默清空通道）', () => {
  const config = resolveConfig({ tiers: [tier('a', 'A', ['p', 'm'])] })
  const gated = applyAllowlist(config, undefined)
  assert.equal(gated.tiers[0]?.pool[0]?.allowed, true)
  assert.equal(routableLines(gated.tiers[0]!.pool).length, 1)
})

test('白名单闸门：空白名单 = 全部挡掉', () => {
  const config = resolveConfig({ tiers: [tier('a', 'A', ['p', 'm'])] })
  const gated = applyAllowlist(config, [])
  assert.equal(routableLines(gated.tiers[0]!.pool).length, 0)
})

test('routableLines：保序，轮转顺序等于列表顺序', () => {
  const config = resolveConfig({ tiers: [tier('a', 'A', ['x', 'm'], ['y', 'm'], ['z', 'm'])] })
  const gated = applyAllowlist(config, [{ provider: 'y', model: 'm' }, { provider: 'x', model: 'm' }])
  assert.deepEqual(routableLines(gated.tiers[0]!.pool).map(line => line.provider), ['x', 'y'])
})

// —— 会话覆写 ——

test('resolveSessionConfig 只覆盖显式给出的字段', () => {
  const merged = resolveSessionConfig({ strategy: 'balanced', enabled: true }, { strategy: 'saver' })
  assert.equal(merged.strategy, 'saver')
  assert.equal(merged.enabled, true)
  assert.equal(resolveSessionConfig({ strategy: 'balanced' }, undefined).strategy, 'balanced')
})

test('会话覆写不覆盖 tiers（否则轮转序列会错位）', () => {
  const merged = resolveSessionConfig(
    { tiers: [tier('a', 'A', ['p', 'm'])] },
    { enabled: false, strategy: 'saver' } as never,
  )
  assert.equal(merged.tiers?.length, 1)
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
  assert.equal(DEFAULT_AMBIGUOUS_POLICY, 'rotate')
})

// —— 写入路径：宿主的两个硬性要求（0.5.3 实测踩出）——

test('expandWriteOps：顶层字段用单段路径', () => {
  assert.deepEqual(expandWriteOps({ enabled: false, strategy: 'saver' }), [
    { op: 'set', path: ['enabled'], value: false },
    { op: 'set', path: ['strategy'], value: 'saver' },
  ])
})

test('expandWriteOps：tiers 整数组单段写入（它是顶层 volatile）', () => {
  const tiers = [{ id: 'a', label: 'A', pool: [] }]
  assert.deepEqual(expandWriteOps({ tiers }), [{ op: 'set', path: ['tiers'], value: tiers }])
})

test('expandWriteOps：executor 必须拆成多段叶子路径', () => {
  // 两个坑叠在一起：
  // ① executor 本身不是 volatile（volatile 在子字段上），整对象写会被宿主拒；
  // ② ConfigForm.set(field) 把 field 当成**一个**路径段——传 'executor.provider'
  //    会得到 ['executor.provider']，宿主查 schema.dict['executor.provider'] 必然查不到，
  //    于是**静默拒写**（返回 false，不抛错，UI 只能报「保存失败」）。
  assert.deepEqual(expandWriteOps({ executor: { provider: 'p', model: 'm', reasoningEffort: '' } }), [
    { op: 'set', path: ['executor', 'provider'], value: 'p' },
    { op: 'set', path: ['executor', 'model'], value: 'm' },
    { op: 'set', path: ['executor', 'reasoningEffort'], value: '' },
  ])
})

test('expandWriteOps：跳过 undefined 值与空补丁', () => {
  assert.deepEqual(expandWriteOps({ enabled: undefined, strategy: 'saver' }), [
    { op: 'set', path: ['strategy'], value: 'saver' },
  ])
  assert.deepEqual(expandWriteOps({}), [])
})

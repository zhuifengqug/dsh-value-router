/**
 * 路由决策回归测试（0.2.0 新判定顺序 + 验收「任何情况下主会话模型不被改写」）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  decideSubagentRoute,
  isExplicitSelection,
  isSubagentSession,
  pickOverride,
  pickTargetRoute,
  routeSkipText,
  type RouteDecisionInput,
} from '../src/core/routing.ts'
import type { ChildRouteIntent } from '../src/core/state.ts'
import type { ValueRouterConfig } from '../src/core/config.ts'

const FALLBACK = { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: '' }
const POOL = [
  { provider: 'p1', model: 'm1', reasoningEffort: '', tier: 'cheap' as const, allowed: true },
  { provider: 'p2', model: 'm2', reasoningEffort: '', tier: 'strong' as const, allowed: true },
]

function config(overrides: Partial<ValueRouterConfig> = {}): Partial<ValueRouterConfig> {
  return { enabled: true, strategy: 'balanced', executor: { ...FALLBACK }, ...overrides }
}

function input(overrides: Partial<RouteDecisionInput> = {}): RouteDecisionInput {
  return {
    globalConfig: config(),
    origin: 'subagent',
    targetAvailable: true,
    fallbackAvailable: true,
    ...overrides,
  }
}

function intent(partial: Partial<ChildRouteIntent> = {}): ChildRouteIntent {
  return {
    provider: 'main',
    model: 'main-model',
    observedAt: { turn: 0, step: 0 },
    parentRoute: 'main/main-model',
    source: 'first-seen',
    ...partial,
  }
}

// —— 轮转：本次迭代的核心行为 ——

test('轮转：池 2 条、序号 0/1/2 → 线路序列 A,B,A', () => {
  const routes = [0, 1, 2].map((index) => {
    const decision = decideSubagentRoute(input({
      globalConfig: config({ pool: POOL }),
      rotationIndex: index,
    }))
    assert.equal(decision.route, true)
    if (!decision.route) throw new Error('unreachable')
    return `${decision.provider}/${decision.model}`
  })
  assert.deepEqual(routes, ['p1/m1', 'p2/m2', 'p1/m1'])
})

test('轮转：负数序号不产生负索引', () => {
  const decision = decideSubagentRoute(input({ globalConfig: config({ pool: POOL }), rotationIndex: -1 }))
  assert.equal(decision.route, true)
  if (!decision.route) return
  assert.equal(decision.provider, 'p2')
})

test('轮转：池非空时来源标记为 pool，池空时回落到兜底线路', () => {
  const pooled = decideSubagentRoute(input({ globalConfig: config({ pool: POOL }), rotationIndex: 0 }))
  assert.equal(pooled.route, true)
  if (pooled.route) assert.equal(pooled.source, 'pool')

  const fallback = decideSubagentRoute(input({ globalConfig: config() }))
  assert.equal(fallback.route, true)
  if (fallback.route) assert.equal(fallback.source, 'fallback')
})

test('pickTargetRoute：池为空时用兜底线路', () => {
  assert.deepEqual(
    pickTargetRoute([], FALLBACK, 3),
    { route: FALLBACK, source: 'fallback' },
  )
  assert.deepEqual(
    pickTargetRoute(POOL, FALLBACK, 3),
    { route: POOL[1]!, source: 'pool' },
  )
})

test('白名单闸门：被挡住的线路不参与轮转，序号只在放行线路上循环', () => {
  const gated = [
    { ...POOL[0]!, allowed: false },
    { ...POOL[1]!, allowed: true },
  ]
  // 只有 p2 放行 → 无论序号是多少都落到 p2
  for (const index of [0, 1, 2, 3]) {
    assert.deepEqual(pickTargetRoute(gated, FALLBACK, index), { route: POOL[1]!, source: 'pool' })
  }
})

test('白名单闸门：全部被挡时回落到兜底线路', () => {
  const blocked = POOL.map(line => ({ ...line, allowed: false }))
  assert.deepEqual(pickTargetRoute(blocked, FALLBACK, 0), { route: FALLBACK, source: 'fallback' })
})

test('白名单闸门：池全被挡 + 兜底未配置 → 无处可派', () => {
  const decision = decideSubagentRoute(input({
    globalConfig: { enabled: true, strategy: 'balanced', pool: POOL.map(line => ({ ...line, allowed: false })) },
  }))
  assert.deepEqual(decision, { route: false, reason: 'no-target' })
})

test('白名单闸门：池全被挡但兜底可用 → 走兜底', () => {
  const decision = decideSubagentRoute(input({
    globalConfig: config({ pool: POOL.map(line => ({ ...line, allowed: false })) }),
  }))
  assert.equal(decision.route, true)
  if (!decision.route) return
  assert.equal(decision.provider, 'deepseek')
  assert.equal(decision.source, 'fallback')
})

// —— B+1：尊重主控显式指定 ——

test('B+1：主控显式指定了与父不同的线路 → 放行，不改写', () => {
  const decision = decideSubagentRoute(input({
    globalConfig: config({ pool: POOL }),
    rotationIndex: 0,
    intent: intent({ provider: 'other', model: 'other-model', parentRoute: 'main/main-model' }),
  }))
  assert.deepEqual(decision, { route: false, reason: 'explicit-route' })
})

test('B+1：显式指定了与父相同的线路 → 歧义，rotate(默认) 继续轮转 / respect 放行', () => {
  const same = intent({ provider: 'main', model: 'main-model', parentRoute: 'main/main-model' })
  assert.equal(isExplicitSelection(same, 'rotate'), false)
  assert.equal(isExplicitSelection(same, 'respect'), true)

  const rotate = decideSubagentRoute(input({
    globalConfig: config({ pool: POOL }), rotationIndex: 0, intent: same,
  }))
  assert.equal(rotate.route, true)

  const respect = decideSubagentRoute(input({
    globalConfig: config({ pool: POOL, ambiguousPolicy: 'respect' }), rotationIndex: 0, intent: same,
  }))
  assert.deepEqual(respect, { route: false, reason: 'explicit-route' })
})

test('B+1：没有意图快照时视为未指定，走轮转', () => {
  assert.equal(isExplicitSelection(undefined, 'rotate'), false)
  assert.equal(isExplicitSelection(undefined, 'respect'), false)
})

// —— 不可绕过的不变量 ——

test('主会话（origin 非 subagent）永不被改写——最关键回归项，任何配置都不例外', () => {
  // 注意 origin 必须显式覆盖：input() 的默认值是 'subagent'，
  // 少传字段会让「origin 缺失」这一档悄悄变成子代理而测不到。
  for (const origin of [undefined, 'user', 'command', 'teammate'] as const) {
    for (const cfg of [config(), config({ pool: POOL }), config({ ambiguousPolicy: 'respect' })]) {
      const decision = decideSubagentRoute(input({
        globalConfig: cfg,
        origin,
        rotationIndex: 0,
      }))
      assert.deepEqual(decision, { route: false, reason: 'not-subagent' }, `origin=${String(origin)} 不应被改写`)
    }
  }
})

test('isSubagentSession：只有 subagent 为真（Agent Team 队友也是 subagent child）', () => {
  assert.equal(isSubagentSession({ origin: 'subagent' }), true)
  assert.equal(isSubagentSession({ origin: 'user' }), false)
  assert.equal(isSubagentSession({}), false)
  assert.equal(isSubagentSession(undefined), false)
  assert.equal(isSubagentSession(null), false)
})

// —— 开关 / 目标缺失 ——

test('总开关关闭时不路由', () => {
  const decision = decideSubagentRoute(input({ globalConfig: config({ enabled: false }) }))
  assert.deepEqual(decision, { route: false, reason: 'disabled' })
})

test('池为空且兜底线路未配置 → 无处可派', () => {
  const decision = decideSubagentRoute(input({
    globalConfig: { enabled: true, strategy: 'balanced' },
  }))
  assert.deepEqual(decision, { route: false, reason: 'no-target' })
})

test('半配置兜底线路被 sanitize 成未配置 → 无处可派（不抛错）', () => {
  const decision = decideSubagentRoute(input({
    globalConfig: config({ executor: { provider: 'deepseek', model: '' } }),
  }))
  assert.deepEqual(decision, { route: false, reason: 'no-target' })
})

test('池中目标 provider 不可用 → 降级到兜底线路', () => {
  const decision = decideSubagentRoute(input({
    globalConfig: config({ pool: POOL }),
    rotationIndex: 0,
    targetAvailable: false,
    fallbackAvailable: true,
  }))
  assert.equal(decision.route, true)
  if (!decision.route) return
  assert.equal(decision.provider, 'deepseek')
  assert.equal(decision.model, 'deepseek-chat')
  assert.equal(decision.source, 'fallback')
})

test('池中目标不可用且兜底也不可用 → 安全放行', () => {
  const decision = decideSubagentRoute(input({
    globalConfig: config({ pool: POOL }),
    rotationIndex: 0,
    targetAvailable: false,
    fallbackAvailable: false,
  }))
  assert.equal(decision.route, false)
})

test('池为空、兜底线路 provider 不可用 → 安全放行', () => {
  const decision = decideSubagentRoute(input({ targetAvailable: false, fallbackAvailable: false }))
  assert.deepEqual(decision, { route: false, reason: 'executor-unavailable' })
})

// —— no-op ——

test('目标线路与本次请求本来会用的线路一致 → no-op，不改写', () => {
  const decision = decideSubagentRoute(input({
    globalConfig: config({ pool: POOL }),
    rotationIndex: 0,
    resolvedRoute: { provider: 'p1', model: 'm1' },
  }))
  assert.deepEqual(decision, { route: false, reason: 'noop' })
})

// —— 会话覆写 ——

test('会话覆写可关闭本会话路由', () => {
  const decision = decideSubagentRoute(input({ sessionOverride: { enabled: false } }))
  assert.deepEqual(decision, { route: false, reason: 'disabled' })
})

test('会话覆写可换兜底线路，并带上 reasoningEffort', () => {
  const decision = decideSubagentRoute(input({
    sessionOverride: {
      strategy: 'saver',
      executor: { provider: 'other', model: 'cheap-model', reasoningEffort: 'low' },
    },
  }))
  assert.equal(decision.route, true)
  if (!decision.route) return
  assert.equal(decision.provider, 'other')
  assert.equal(decision.model, 'cheap-model')
  assert.equal(decision.reasoningEffort, 'low')
  assert.equal(decision.overrideSource, 'session')
  assert.equal(decision.effective.strategy, 'saver')
  assert.deepEqual(decision.effective.executor, { provider: 'other', model: 'cheap-model', reasoningEffort: 'low' })
})

test('会话覆写不覆盖 pool：轮转序列不会因气泡改动而错位', () => {
  const decision = decideSubagentRoute(input({
    globalConfig: config({ pool: POOL }),
    sessionOverride: { executor: { provider: 'other', model: 'x' } },
    rotationIndex: 0,
  }))
  assert.equal(decision.route, true)
  if (!decision.route) return
  assert.equal(decision.source, 'pool', '池仍然生效，覆写只影响兜底线路')
})

test('子代理没有自身覆写时使用父会话覆写', () => {
  const decision = decideSubagentRoute(input({
    parentOverride: { executor: { provider: 'parent-provider', model: 'parent-model' } },
  }))
  assert.equal(decision.route, true)
  if (!decision.route) return
  assert.equal(decision.provider, 'parent-provider')
  assert.equal(decision.overrideSource, 'parent')
})

test('自身覆写优先于父会话覆写', () => {
  const decision = decideSubagentRoute(input({
    sessionOverride: { executor: { provider: 'own', model: 'own-model' } },
    parentOverride: { executor: { provider: 'parent-provider', model: 'parent-model' } },
  }))
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

test('routeSkipText 覆盖全部跳过原因（漏一个会是静默的 undefined）', () => {
  for (const reason of [
    'disabled', 'not-subagent', 'no-target', 'explicit-route',
    'executor-incomplete', 'executor-unavailable', 'noop',
  ] as const) {
    assert.ok(routeSkipText(reason).length > 0, `${reason} 缺少人读文案`)
  }
})

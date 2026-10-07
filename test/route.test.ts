/**
 * 路由引擎矩阵测试——「四档路由 / 轮转 / 降级 / fallback / 用户硬路由 / 主模型被拒」的唯一证据源。
 *
 * 每条硬约束都有对应测试，命名即契约。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { CatalogSnapshot } from '../src/core/catalog.ts'
import type { ValueRouterConfig } from '../src/core/config.ts'
import { orderedCandidates, resolveRoute, type RouteResolution } from '../src/core/route.ts'

/** 构造目录：`{ provider: [model, ...] }`。 */
function catalog(providers: Record<string, string[]>, allowlist?: { provider: string; model: string }[]): CatalogSnapshot {
  return {
    providers: Object.entries(providers).map(([id, models]) => ({
      id,
      catalogKnown: true,
      models: models.map(model => ({ id: model })),
    })),
    allowlist,
    at: 0,
  }
}

/** 目录里带 reasoning_effort 声明的模型。 */
function catalogWithEfforts(entries: { provider: string; model: string; efforts: string[] }[]): CatalogSnapshot {
  const providers = new Map<string, { id: string; catalogKnown: boolean; models: { id: string; efforts?: string[] }[] }>()
  for (const entry of entries) {
    const provider = providers.get(entry.provider) ?? { id: entry.provider, catalogKnown: true, models: [] }
    provider.models.push({ id: entry.model, efforts: entry.efforts })
    providers.set(entry.provider, provider)
  }
  return { providers: [...providers.values()], allowlist: undefined, at: 0 }
}

const line = (provider: string, model: string, reasoning_effort = '') => ({ provider, model, reasoning_effort })

function resolve(input: {
  config: Partial<ValueRouterConfig>
  catalog: CatalogSnapshot
  difficulty?: unknown
  role?: unknown
  route?: { provider?: unknown; model?: unknown; reasoning_effort?: unknown } | null
  routeSource?: 'user' | 'captain'
  rotationIndex?: number
}): RouteResolution {
  return resolveRoute({ ...input, now: 1_000 })
}

function steps(result: RouteResolution): string[] {
  return result.audit.map(entry => entry.step)
}

// —————————————————— 四档路由矩阵 ——————————————————

test('四档矩阵：每条线路在自己声明的档位内被选中（固定 difficulty → 该档）', () => {
  const config: Partial<ValueRouterConfig> = {
    tiers: {
      low: { lines: [line('p', 'low-model')] },
      medium: { lines: [line('p', 'medium-model')] },
      high: { lines: [line('p', 'high-model')] },
      max: { lines: [line('p', 'max-model')] },
    },
  }
  const cat = catalog({ p: ['low-model', 'medium-model', 'high-model', 'max-model'] })
  const expected: Record<string, string> = {
    low: 'low-model',
    medium: 'medium-model',
    high: 'high-model',
    max: 'max-model',
  }
  for (const [difficulty, model] of Object.entries(expected)) {
    const result = resolve({ config, catalog: cat, difficulty })
    assert.equal(result.dispatchable, true, `${difficulty} 档应可派发`)
    assert.equal(result.model, model)
    assert.equal(result.resolvedDifficulty, difficulty)
    assert.equal(result.degraded, false)
    assert.equal(result.routeSource, 'difficulty')
  }
})

test('档内轮转：同一档多次派发按 rotationIndex 轮转，序号绕回', () => {
  const config: Partial<ValueRouterConfig> = {
    tiers: { medium: { lines: [line('a', 'm1'), line('b', 'm2'), line('c', 'm3')] } },
  }
  const cat = catalog({ a: ['m1'], b: ['m2'], c: ['m3'] })
  const picked = [0, 1, 2, 3, 4].map(rotationIndex => resolve({ config, catalog: cat, difficulty: 'medium', rotationIndex }).model)
  assert.deepEqual(picked, ['m1', 'm2', 'm3', 'm1', 'm2'])
})

test('同档替代：轮转首选不可用时同档内换一条，并记录 same-tier-substitute', () => {
  const config: Partial<ValueRouterConfig> = {
    // a/m1 不在目录里 → missing，轮转 0 命中它时必须替代
    tiers: { medium: { lines: [line('a', 'm1'), line('b', 'm2')] } },
  }
  const cat = catalog({ b: ['m2'] })
  const result = resolve({ config, catalog: cat, difficulty: 'medium', rotationIndex: 0 })
  assert.equal(result.dispatchable, true)
  assert.equal(result.model, 'm2')
  assert.ok(steps(result).includes('same-tier-substitute'))
  assert.equal(result.degraded, false, '同档替代不是降级')
})

test('逐档降级：请求档位无可用线路时逐级向下，并记录 degraded', () => {
  const config: Partial<ValueRouterConfig> = {
    tiers: { low: { lines: [line('p', 'low-model')] }, max: { lines: [line('p', 'gone')] } },
  }
  const cat = catalog({ p: ['low-model'] })
  const result = resolve({ config, catalog: cat, difficulty: 'max' })
  assert.equal(result.dispatchable, true)
  assert.equal(result.resolvedDifficulty, 'low')
  assert.equal(result.degraded, true)
  assert.equal(result.model, 'low-model')
  assert.ok(steps(result).includes('tier-degrade'))
})

test('禁止无提示升档：低档无线路时绝不使用更高档，直接走全局 fallback', () => {
  const config: Partial<ValueRouterConfig> = {
    tiers: { medium: { lines: [line('p', 'medium-model')] } },
    fallback: line('p', 'fallback-model'),
  }
  const cat = catalog({ p: ['medium-model', 'fallback-model'] })
  const result = resolve({ config, catalog: cat, difficulty: 'low' })
  assert.equal(result.dispatchable, true)
  assert.equal(result.routeSource, 'fallback')
  assert.equal(result.model, 'fallback-model')
  assert.notEqual(result.model, 'medium-model')
  assert.equal(result.fallback, true)
})

test('全局 fallback 只在四档全部无可用线路时使用', () => {
  const config: Partial<ValueRouterConfig> = {
    tiers: { high: { lines: [line('p', 'high-model')] } },
    fallback: line('p', 'fallback-model'),
  }
  const cat = catalog({ p: ['high-model', 'fallback-model'] })
  const result = resolve({ config, catalog: cat, difficulty: 'high' })
  assert.equal(result.routeSource, 'difficulty')
  assert.equal(result.fallback, false)
  assert.equal(steps(result).includes('fallback'), false)
})

test('fallback 不是轮转成员：它不出现在任何档位的候选里', () => {
  const config: Partial<ValueRouterConfig> = {
    tiers: { low: { lines: [line('p', 'low-model')] } },
    fallback: line('p', 'fallback-model'),
  }
  const cat = catalog({ p: ['low-model', 'fallback-model'] })
  for (const rotationIndex of [0, 1, 2, 3, 7]) {
    const result = resolve({ config, catalog: cat, difficulty: 'low', rotationIndex })
    assert.equal(result.model, 'low-model', `rotationIndex=${rotationIndex} 不该轮到 fallback`)
  }
})

test('四档与 fallback 全空 → pending，不得派发', () => {
  const result = resolve({ config: {}, catalog: catalog({ p: ['m'] }) })
  assert.equal(result.dispatchable, false)
  assert.equal(result.routeStatus, 'pending')
  assert.equal(result.reason, 'no-route')
  assert.ok(steps(result).includes('pending'))
})

test('fallback 存在但目录缺失 → 仍然 pending（不派发不可用线路）', () => {
  const config: Partial<ValueRouterConfig> = { fallback: line('p', 'gone') }
  const result = resolve({ config, catalog: catalog({ p: ['other'] }) })
  assert.equal(result.dispatchable, false)
  assert.equal(result.routeStatus, 'pending')
})

// —————————————————— 用户硬指定线路 ——————————————————

test('用户硬路由可用 → 直接使用，来源为 user，不做轮转', () => {
  const config: Partial<ValueRouterConfig> = { tiers: { low: { lines: [line('p', 'low-model')] } } }
  const cat = catalog({ p: ['low-model', 'chosen'] })
  const result = resolve({
    config, catalog: cat, difficulty: 'low', rotationIndex: 0,
    route: line('p', 'chosen', 'high'), routeSource: 'user',
  })
  assert.equal(result.dispatchable, true)
  assert.equal(result.routeSource, 'user')
  assert.equal(result.model, 'chosen')
  assert.equal(result.reasoning_effort, 'high')
})

test('用户硬路由的模型不在目录中 → pending，且**绝不**换线路、**绝不**用 fallback', () => {
  const config: Partial<ValueRouterConfig> = {
    tiers: { low: { lines: [line('p', 'low-model')] } },
    fallback: line('p', 'fallback-model'),
  }
  const cat = catalog({ p: ['low-model', 'fallback-model'] })
  const result = resolve({
    config, catalog: cat, difficulty: 'low',
    route: line('p', 'user-model'), routeSource: 'user',
  })
  assert.equal(result.dispatchable, false)
  assert.equal(result.routeStatus, 'pending')
  assert.equal(result.routeSource, 'user')
  assert.equal(result.reason, 'user-route-unavailable')
  assert.equal(result.fallback, false)
  assert.equal(result.provider, '')
  assert.equal(steps(result).includes('fallback'), false, '用户硬路由不得触发 fallback')
})

test('用户硬路由被白名单挡住 → blocked（宿主本来就会拒绝）', () => {
  const config: Partial<ValueRouterConfig> = {}
  const cat = catalog({ p: ['m'] }, [{ provider: 'other', model: 'x' }])
  const result = resolve({ config, catalog: cat, route: line('p', 'm'), routeSource: 'user' })
  assert.equal(result.dispatchable, false)
  assert.equal(result.routeStatus, 'blocked')
  assert.equal(result.reason, 'user-route-blocked')
  assert.match(result.errors[0]!, /白名单/)
})

test('用户硬路由的 reasoning_effort 不被模型支持 → blocked', () => {
  const config: Partial<ValueRouterConfig> = {}
  const cat = catalogWithEfforts([{ provider: 'p', model: 'm', efforts: ['low', 'medium'] }])
  const result = resolve({ config, catalog: cat, route: line('p', 'm', 'max'), routeSource: 'user' })
  assert.equal(result.dispatchable, false)
  assert.equal(result.routeStatus, 'blocked')
  assert.equal(result.reason, 'user-route-invalid')
})

test('用户硬路由优先于主模型偏好：两条都给时用用户的', () => {
  const config: Partial<ValueRouterConfig> = {}
  const cat = catalog({ p: ['user-model', 'captain-model'] })
  const result = resolve({
    config, catalog: cat, route: line('p', 'user-model'), routeSource: 'user',
  })
  assert.equal(result.model, 'user-model')
  assert.equal(result.routeSource, 'user')
})

// —————————————————— 主模型 route 偏好 ——————————————————

test('主模型线路合法 → 采用，来源 captain', () => {
  const config: Partial<ValueRouterConfig> = { tiers: { high: { lines: [line('p', 'tier-model')] } } }
  const cat = catalog({ p: ['captain-model', 'tier-model'] })
  const result = resolve({ config, catalog: cat, difficulty: 'high', route: line('p', 'captain-model'), routeSource: 'captain' })
  assert.equal(result.routeSource, 'captain')
  assert.equal(result.model, 'captain-model')
})

test('主模型线路非法 → 只记录 route-rejected，然后按 difficulty 自动重选', () => {
  const config: Partial<ValueRouterConfig> = { tiers: { high: { lines: [line('p', 'tier-model')] } } }
  const cat = catalog({ p: ['tier-model'] })
  const result = resolve({ config, catalog: cat, difficulty: 'high', route: line('p', 'nope'), routeSource: 'captain' })
  assert.equal(result.dispatchable, true, '主模型线路被拒不能让任务失败')
  assert.equal(result.model, 'tier-model')
  assert.equal(result.routeSource, 'difficulty')
  assert.ok(steps(result).includes('route-rejected'))
  const rejected = result.audit.find(entry => entry.step === 'route-rejected')!
  assert.equal(rejected.outcome, 'rejected')
  assert.match(rejected.detail, /继续按 difficulty\/role 自动重选/)
})

test('主模型线路被白名单挡住 → route-rejected 后仍自动重选', () => {
  const config: Partial<ValueRouterConfig> = { tiers: { low: { lines: [line('p', 'allowed')] } } }
  const cat = catalog({ p: ['allowed', 'denied'] }, [{ provider: 'p', model: 'allowed' }])
  const result = resolve({ config, catalog: cat, difficulty: 'low', route: line('p', 'denied'), routeSource: 'captain' })
  assert.equal(result.dispatchable, true)
  assert.equal(result.model, 'allowed')
  assert.ok(steps(result).includes('route-rejected'))
})

test('未声明 routeSource 时按 captain 处理（不给 route 时不影响自动路由）', () => {
  const config: Partial<ValueRouterConfig> = { tiers: { medium: { lines: [line('p', 'auto')] } } }
  const cat = catalog({ p: ['auto'] })
  const implicit = resolve({ config, catalog: cat, difficulty: 'medium', route: line('p', 'auto') })
  assert.equal(implicit.routeSource, 'captain')
  const automatic = resolve({ config, catalog: cat, difficulty: 'medium' })
  assert.equal(automatic.routeSource, 'difficulty')
})

// —————————————————— 意图非法 ——————————————————

test('非法 difficulty → blocked，且不产生任何候选线路', () => {
  const config: Partial<ValueRouterConfig> = { tiers: { medium: { lines: [line('p', 'm')] } } }
  const result = resolve({ config, catalog: catalog({ p: ['m'] }), difficulty: 'URGENT' })
  assert.equal(result.dispatchable, false)
  assert.equal(result.routeStatus, 'blocked')
  assert.equal(result.reason, 'invalid-intent')
  assert.equal(result.provider, '')
  assert.equal(result.requestedDifficulty, undefined)
  assert.match(result.errors[0]!, /invalid difficulty/)
})

test('非法 role → blocked（空串与纯空白）', () => {
  const config: Partial<ValueRouterConfig> = { tiers: { medium: { lines: [line('p', 'm')] } } }
  for (const role of ['', '   ']) {
    const result = resolve({ config, catalog: catalog({ p: ['m'] }), role })
    assert.equal(result.routeStatus, 'blocked')
    assert.match(result.errors[0]!, /invalid role/)
  }
})

// —————————————————— 白名单与能力校验 ——————————————————

test('档位线路被白名单挡住 → 该线路不参与选择，其余线路照常', () => {
  const config: Partial<ValueRouterConfig> = {
    tiers: { medium: { lines: [line('p', 'denied'), line('p', 'allowed')] } },
  }
  const cat = catalog({ p: ['denied', 'allowed'] }, [{ provider: 'p', model: 'allowed' }])
  const result = resolve({ config, catalog: cat, difficulty: 'medium', rotationIndex: 0 })
  assert.equal(result.model, 'allowed')
  assert.ok(steps(result).includes('same-tier-substitute'))
})

test('白名单读不到（undefined）时不做拦截', () => {
  const config: Partial<ValueRouterConfig> = { tiers: { medium: { lines: [line('p', 'm')] } } }
  const cat = catalog({ p: ['m'] })  // allowlist 未提供
  const result = resolve({ config, catalog: cat, difficulty: 'medium' })
  assert.equal(result.dispatchable, true)
})

test('reasoning_effort 未被模型声明时不拒绝、不改写（不猜测能力）', () => {
  const config: Partial<ValueRouterConfig> = { tiers: { medium: { lines: [line('p', 'm', 'exotic')] } } }
  const cat = catalog({ p: ['m'] })
  const result = resolve({ config, catalog: cat, difficulty: 'medium' })
  assert.equal(result.dispatchable, true)
  assert.equal(result.reasoning_effort, 'exotic')
})

test('档位线路声明了不支持 effort → 视为不可用并降级', () => {
  const config: Partial<ValueRouterConfig> = {
    tiers: {
      high: { lines: [line('p', 'm', 'max')] },
      low: { lines: [line('p', 'm', '')] },
    },
  }
  const cat = catalogWithEfforts([{ provider: 'p', model: 'm', efforts: ['low', 'medium'] }])
  const result = resolve({ config, catalog: cat, difficulty: 'high' })
  assert.equal(result.dispatchable, true)
  assert.equal(result.resolvedDifficulty, 'low')
  assert.equal(result.degraded, true)
})

test('provider 目录为空（适配器不声明）时线路仍可用——不拿"没声明"当"不存在"', () => {
  const config: Partial<ValueRouterConfig> = { tiers: { medium: { lines: [line('p', 'm')] } } }
  const cat: CatalogSnapshot = { providers: [{ id: 'p', catalogKnown: true, models: [] }], allowlist: undefined, at: 0 }
  const result = resolve({ config, catalog: cat, difficulty: 'medium' })
  assert.equal(result.dispatchable, true)
})

test('provider 未注册 → 线路 missing', () => {
  const config: Partial<ValueRouterConfig> = { tiers: { medium: { lines: [line('ghost', 'm')] } } }
  const result = resolve({ config, catalog: catalog({ p: ['m'] }), difficulty: 'medium' })
  assert.equal(result.dispatchable, false)
  assert.equal(result.routeStatus, 'pending')
})

// —————————————————— 候选顺序（轮转 + 同档替代的基础） ——————————————————

test('orderedCandidates 从 rotationIndex 环形展开且不丢条目', () => {
  const lines = [line('a', '1'), line('b', '2'), line('c', '3')].map(l => ({ ...l, status: 'available' as const }))
  assert.deepEqual(orderedCandidates(lines, 0).map(l => l.model), ['1', '2', '3'])
  assert.deepEqual(orderedCandidates(lines, 1).map(l => l.model), ['2', '3', '1'])
  assert.deepEqual(orderedCandidates(lines, 5).map(l => l.model), ['3', '1', '2'])
  assert.deepEqual(orderedCandidates(lines, -1).map(l => l.model), ['3', '1', '2'])
  assert.deepEqual(orderedCandidates([], 3), [])
})

test('resolvedDifficulty 与 routeSource 在档位、降级与兜底路径上都自洽', () => {
  const config: Partial<ValueRouterConfig> = {
    tiers: { medium: { lines: [line('p', 'tier')] } },
    fallback: line('p', 'fallback'),
  }
  const cat = catalog({ p: ['tier', 'fallback'] })

  const tiered = resolve({ config, catalog: cat, difficulty: 'medium' })
  assert.equal(tiered.resolvedDifficulty, 'medium')
  assert.equal(tiered.requestedDifficulty, 'medium')
  assert.equal(tiered.routeSource, 'difficulty')
  assert.equal(tiered.degraded, false)

  // max → high → medium：降级到 medium 而不是掉进 fallback（降级优先于兜底）。
  const degraded = resolve({ config, catalog: cat, difficulty: 'max' })
  assert.equal(degraded.routeSource, 'difficulty')
  assert.equal(degraded.resolvedDifficulty, 'medium')
  assert.equal(degraded.requestedDifficulty, 'max')
  assert.equal(degraded.degraded, true)

  // 档位线路全部不可用 → 才轮到全局兜底，此时没有档位归属。
  const catWithoutTier = catalog({ p: ['fallback'] })
  const fell = resolve({ config, catalog: catWithoutTier, difficulty: 'max' })
  assert.equal(fell.resolvedDifficulty, undefined, '走兜底时没有档位归属')
  assert.equal(fell.requestedDifficulty, 'max')
  assert.equal(fell.routeSource, 'fallback')
  assert.equal(fell.fallback, true)
})

test('审计条目都带时间戳与可读说明', () => {
  const config: Partial<ValueRouterConfig> = { tiers: { medium: { lines: [line('p', 'm')] } } }
  const result = resolve({ config, catalog: catalog({ p: ['m'] }), difficulty: 'medium' })
  assert.ok(result.audit.length > 0)
  for (const entry of result.audit) {
    assert.equal(entry.at, 1_000)
    assert.equal(typeof entry.detail, 'string')
    assert.ok(entry.detail.length > 0)
  }
})

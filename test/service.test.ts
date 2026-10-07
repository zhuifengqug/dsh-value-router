/**
 * `valueRouterRouting` 服务契约。
 *
 * 这是别的插件（Agent Teams）唯一被允许依赖的接口，因此这里既测**形状**
 * （四个方法、返回字段），也测**稳定性**（目录不可用不抛错、事件自动落审计）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { RouteEventLog } from '../src/core/audit.ts'
import type { CatalogSnapshot } from '../src/core/catalog.ts'
import type { ValueRouterConfig } from '../src/core/config.ts'
import { createRoutingService, VALUE_ROUTER_SERVICE_NAME, type ValueRouterRoutingService } from '../src/service.ts'

const line = (provider: string, model: string, reasoning_effort = '') => ({ provider, model, reasoning_effort })

const CATALOG: CatalogSnapshot = {
  providers: [{ id: 'p', catalogKnown: true, models: [{ id: 'low-model' }, { id: 'high-model' }, { id: 'fb' }] }],
  allowlist: undefined,
  at: 0,
}

const CONFIG: Partial<ValueRouterConfig> = {
  tiers: {
    low: { lines: [line('p', 'low-model')] },
    high: { lines: [line('p', 'high-model')] },
  },
  fallback: line('p', 'fb'),
}

function service(overrides: {
  config?: Partial<ValueRouterConfig>
  catalog?: CatalogSnapshot
  allowlist?: { provider: string; model: string }[] | undefined
} = {}): { routing: ValueRouterRoutingService; events: RouteEventLog } {
  const events = new RouteEventLog(16)
  const routing = createRoutingService({
    getConfig: () => overrides.config ?? CONFIG,
    llm: () => undefined,
    readAllowlist: () => overrides.allowlist,
    events,
    now: () => 1_000,
  })
  return { routing, events }
}

/** 直接注入目录的服务（目录来自 llm 时是异步构建的，测试里用桩替换）。 */
function serviceWithCatalog(config: Partial<ValueRouterConfig>, catalog: CatalogSnapshot) {
  const events = new RouteEventLog(16)
  const routing = createRoutingService({
    getConfig: () => config,
    // 用一个最小 llm 桩：listProviders/listModels 直接返回注入的目录。
    llm: () => ({
      listProviders: () => catalog.providers.map(provider => ({ id: provider.id, name: provider.name ?? provider.id })),
      listModels: async (provider: string) => (catalog.providers.find(item => item.id === provider)?.models ?? []),
      resolveModelInfo: async (provider: string, model: string) => {
        const found = catalog.providers.find(item => item.id === provider)?.models.find(item => item.id === model)
        return { provider, id: model, name: found?.name ?? model, reasoning: found?.efforts === undefined ? undefined : { efforts: found.efforts.map(id => ({ id, name: id })) } }
      },
    }) as never,
    readAllowlist: () => catalog.allowlist,
    events,
    now: () => 1_000,
  })
  return { routing, events }
}

test('服务名是稳定的字符串常量', () => {
  assert.equal(VALUE_ROUTER_SERVICE_NAME, 'valueRouterRouting')
})

test('catalog() 返回四档 + fallback + 宿主目录 + 白名单可读性', async () => {
  const { routing } = serviceWithCatalog(CONFIG, CATALOG)
  const view = await routing.catalog()
  assert.deepEqual(view.tiers.map(tier => tier.id), ['low', 'medium', 'high', 'max'])
  assert.equal(view.tiers.find(tier => tier.id === 'low')!.lines[0]!.status, 'available')
  assert.equal(view.fallback.model, 'fb')
  assert.equal(view.allowlistKnown, false)
  assert.deepEqual(view.providers.map(provider => provider.id), ['p'])
  // `at` 是**目录采样时间**（真实时钟），不是注入给决策审计的 now。
  assert.ok(typeof view.at === 'number' && view.at > 0)
})

test('catalog() 把目录缺失的线路标成 missing 而不是删除', async () => {
  const { routing } = serviceWithCatalog({ tiers: { max: { lines: [line('p', 'vanished')] } } }, CATALOG)
  const view = await routing.catalog()
  const max = view.tiers.find(tier => tier.id === 'max')!
  assert.equal(max.lines.length, 1, '配置保留')
  assert.equal(max.lines[0]!.status, 'missing')
  assert.match(max.lines[0]!.statusDetail!, /不在 provider "p" 的目录中/)
})

test('validate() 是纯校验，不改状态', () => {
  const { routing } = service()
  const ok = routing.validate({ difficulty: 'high', role: ' Reviewer ' })
  assert.equal(ok.ok, true)
  assert.equal(ok.normalizedRole, 'reviewer')
  const bad = routing.validate({ difficulty: 'nope' })
  assert.equal(bad.ok, false)
  assert.match(bad.errors[0]!, /invalid difficulty/)
})

test('resolve() 返回最终三元组、来源、状态、降级/兜底与审计', async () => {
  const { routing } = serviceWithCatalog(CONFIG, CATALOG)
  const result = await routing.resolve({ difficulty: 'high', role: 'engineer' })
  assert.equal(result.dispatchable, true)
  assert.equal(result.model, 'high-model')
  assert.equal(result.routeSource, 'difficulty')
  assert.equal(result.routeStatus, 'resolved')
  assert.equal(result.fallback, false)
  assert.equal(result.degraded, false)
  assert.ok(result.audit.length > 0)
  assert.equal(result.normalizedRole, 'engineer')
})

test('resolve() 把用户硬路由不可用翻成不可派发，并保持 routeSource=user', async () => {
  const { routing } = serviceWithCatalog(CONFIG, CATALOG)
  const result = await routing.resolve({ difficulty: 'low', route: line('p', 'nope'), routeSource: 'user' })
  assert.equal(result.dispatchable, false)
  assert.equal(result.routeStatus, 'pending')
  assert.equal(result.routeSource, 'user')
  assert.equal(result.fallback, false)
})

test('resolve() 自动把决策写进事件流（调用方不必自己 record）', async () => {
  const { routing, events } = serviceWithCatalog(CONFIG, CATALOG)
  await routing.resolve({ difficulty: 'low', teamId: 't1', taskId: 't2' })
  const recorded = events.list()
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0]!.type, 'dispatch')
  assert.equal(recorded[0]!.teamId, 't1')
  assert.equal(recorded[0]!.taskId, 't2')
  assert.equal(recorded[0]!.difficulty, 'low')
  assert.equal(recorded[0]!.at, 1_000)
})

test('resolve() 对不可派发的决策记 queue 事件并带 queueReason', async () => {
  const { routing, events } = serviceWithCatalog({}, CATALOG)
  const result = await routing.resolve({ difficulty: 'medium' })
  assert.equal(result.dispatchable, false)
  const queued = events.ofType('queue')
  assert.equal(queued.length, 1)
  assert.equal(queued[0]!.queueReason, 'no-route')
})

test('resolve() 对非法意图记 blocked 事件', async () => {
  const { routing, events } = serviceWithCatalog(CONFIG, CATALOG)
  await routing.resolve({ difficulty: 'illegal' })
  assert.equal(events.ofType('blocked').length, 1)
})

test('resolve() 对走兜底的决策记 fallback 事件', async () => {
  const { routing, events } = serviceWithCatalog(
    { tiers: { low: { lines: [line('p', 'gone')] } }, fallback: line('p', 'fb') },
    CATALOG,
  )
  const result = await routing.resolve({ difficulty: 'low' })
  assert.equal(result.routeSource, 'fallback')
  assert.equal(events.ofType('fallback').length, 1)
})

test('record() 追加任意运行事件，events() 读回插入顺序', async () => {
  const { routing } = service()
  routing.record({ type: 'reuse', taskId: 't1', member: 'm1', detail: '复用空闲成员' })
  routing.record({ type: 'queue', taskId: 't2', queueReason: '达到 maxMembers' })
  const events = routing.events()
  assert.deepEqual(events.map(event => event.type), ['reuse', 'queue'])
  assert.equal(events[1]!.queueReason, '达到 maxMembers')
})

test('LLM 目录读取抛错时不抛给调用方，且不误杀用户显式配置的线路', async () => {
  const routing = createRoutingService({
    getConfig: () => CONFIG,
    llm: () => ({ listProviders: () => { throw new Error('llm offline') } }) as never,
    readAllowlist: () => undefined,
    now: () => 1_000,
  })
  // 目录读不到 = 无法证伪，不是"线路不存在"。用户显式配进 low 档的线路照常派发。
  const result = await routing.resolve({ difficulty: 'low' })
  assert.equal(result.routeStatus, 'resolved')
  assert.equal(result.model, 'low-model')
  assert.equal(result.routeSource, 'difficulty')

  // 视图仍然结构完整，只是目录为空。
  const view = await routing.catalog()
  assert.deepEqual(view.providers, [])
  assert.deepEqual(view.tiers.map(tier => tier.id), ['low', 'medium', 'high', 'max'])
})

test('resolve 永不抛错：任何 deps 异常都退化成一个结构完整的结果', async () => {
  const routing = createRoutingService({
    getConfig: () => { throw new Error('config source exploded') },
    llm: () => undefined,
    readAllowlist: () => { throw new Error('allowlist exploded') },
    now: () => 1_000,
  })
  const result = await routing.resolve({ difficulty: 'medium' })
  assert.equal(typeof result.dispatchable, 'boolean')
  assert.equal(typeof result.routeStatus, 'string')
  assert.ok(Array.isArray(result.audit))
  assert.ok(result.audit.length > 0, '异常路径也要留下审计说明')
})

test('目录构建失败时 catalog() 仍返回结构完整的四档视图', async () => {
  const routing = createRoutingService({
    getConfig: () => CONFIG,
    llm: () => undefined,
    readAllowlist: () => undefined,
    now: () => 1_000,
  })
  const view = await routing.catalog()
  assert.deepEqual(view.tiers.map(tier => tier.id), ['low', 'medium', 'high', 'max'])
  assert.deepEqual(view.providers, [])
  assert.equal(view.allowlistKnown, false)
})

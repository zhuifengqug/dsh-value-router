/**
 * 系统提示段：难度语义、只列可用线路、不复述已退役概念。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { classifyConfig, type CatalogSnapshot } from '../src/core/catalog.ts'
import { resolveConfig, type ResolvedValueRouterConfig } from '../src/core/config.ts'
import { buildSystemPromptGuidance } from '../src/core/policy.ts'

const line = (provider: string, model: string, reasoning_effort = '') => ({ provider, model, reasoning_effort })

const CATALOG: CatalogSnapshot = {
  providers: [
    { id: 'cheap', catalogKnown: true, models: [{ id: 'mini' }] },
    { id: 'strong', catalogKnown: true, models: [{ id: 'big' }] },
  ],
  allowlist: undefined,
  at: 0,
}

function guidance(config: Parameters<typeof classifyConfig>[0], role?: 'controller' | 'subagent'): string {
  return buildSystemPromptGuidance(classifyConfig(config, CATALOG), role === undefined ? {} : { role })
}

function config(raw: Parameters<typeof resolveConfig>[0]): ResolvedValueRouterConfig {
  return resolveConfig(raw)
}

test('未启用时不注入任何文本', () => {
  const disabled = config({ enabled: false, tiers: { low: { lines: [line('cheap', 'mini')] } } })
  assert.equal(buildSystemPromptGuidance(disabled, { role: 'controller' }), '')
  assert.equal(buildSystemPromptGuidance(disabled, { role: 'subagent' }), '')
})

test('主控段包含四档难度语义，并说明永不改写主模型', () => {
  const text = guidance(config({ tiers: { low: { lines: [line('cheap', 'mini')] } } }))
  assert.match(text, /主控模型/)
  assert.match(text, /永远/)
  for (const id of ['low', 'medium', 'high', 'max']) assert.match(text, new RegExp(id))
})

test('只列目录里可用的线路；missing / blocked 的线路不进清单', () => {
  const cfg = config({
    tiers: {
      low: { lines: [line('cheap', 'mini'), line('cheap', 'vanished')] },
      high: { lines: [line('strong', 'blocked-model')] },
    },
  })
  const classified = classifyConfig(cfg, {
    ...CATALOG,
    allowlist: [{ provider: 'cheap', model: 'mini' }],
  })
  const text = buildSystemPromptGuidance(classified, { role: 'controller' })
  assert.match(text, /cheap\/mini/)
  assert.equal(text.includes('vanished'), false, '目录缺失的线路不该出现在清单里')
  assert.equal(text.includes('blocked-model'), false, '被白名单挡住的线路不该出现在清单里')
  assert.match(text, /missing/, '应说明存在不可用线路及其后果')
})

test('没有任何可用线路时整段省略——不承诺不存在的围栏', () => {
  const text = guidance(config({ tiers: { low: { lines: [line('cheap', 'gone')] } } }))
  assert.equal(/cheap\/gone/.test(text), false)
  assert.equal(/difficulty=low/.test(text), false)
})

test('兜底线路只在可用时才出现在提示里，并说明它不是轮转成员', () => {
  const withFallback = guidance(config({
    tiers: { low: { lines: [line('cheap', 'mini')] } },
    fallback: line('strong', 'big'),
  }))
  assert.match(withFallback, /兜底/)
  assert.match(withFallback, /不是轮转成员/)

  const unusableFallback = guidance(config({
    tiers: { low: { lines: [line('cheap', 'mini')] } },
    fallback: line('strong', 'not-in-catalog'),
  }))
  assert.equal(unusableFallback.includes('not-in-catalog'), false)
})

test('执行子代理段不含难度清单，并禁止递归派发', () => {
  const text = guidance(config({ tiers: { low: { lines: [line('cheap', 'mini')] } } }), 'subagent')
  assert.match(text, /执行子代理/)
  assert.match(text, /不要再次派发子代理/)
  assert.equal(/difficulty=low/.test(text), false)
})

test('提示段不复述已退役概念', () => {
  const text = guidance(config({
    tiers: { low: { lines: [line('cheap', 'mini')] }, max: { lines: [line('strong', 'big')] } },
    fallback: line('cheap', 'mini'),
  }))
  for (const retired of ['saver', 'balanced', 'powerful', 'executor', 'ambiguousPolicy', 'tierRouting', '轮转池']) {
    assert.equal(text.includes(retired), false, `提示段不应再出现 ${retired}`)
  }
})

test('难度语义说明包含四档的用途描述', () => {
  const text = guidance(config({ tiers: { medium: { lines: [line('cheap', 'mini')] } } }))
  assert.match(text, /机械|批量/)
  assert.match(text, /根因|复核/)
})

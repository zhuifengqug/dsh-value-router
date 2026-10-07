/**
 * 目录判定：可用 / 目录缺失（missing）/ 白名单拦截（blocked）。
 *
 * 核心纪律：**不拿"没声明"当"不存在"**——适配器完全可以合法地不声明目录，
 * 把未知当缺失会误杀可用线路。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  availableLines,
  catalogHasRoute,
  classifyConfig,
  classifyLine,
  effortSupport,
  findModel,
  findProvider,
  isAllowlistBlocked,
  missingLines,
  type CatalogSnapshot,
} from '../src/core/catalog.ts'
import { resolveConfig } from '../src/core/config.ts'

const line = (provider: string, model: string, reasoning_effort = '') => ({ provider, model, reasoning_effort })

function snapshot(): CatalogSnapshot {
  return {
    providers: [
      { id: 'p', name: 'P', catalogKnown: true, models: [{ id: 'm1', efforts: ['low', 'high'] }, { id: 'm2' }] },
      { id: 'blank', catalogKnown: true, models: [] },
      { id: 'broken', catalogKnown: false, models: [] },
    ],
    allowlist: undefined,
    at: 1,
  }
}

test('catalogHasRoute：命中 / 明确缺失 / 未知三分', () => {
  const cat = snapshot()
  assert.equal(catalogHasRoute(cat, 'p', 'm1'), 'yes')
  assert.equal(catalogHasRoute(cat, 'p', 'nope'), 'no')
  assert.equal(catalogHasRoute(cat, 'blank', 'anything'), 'unknown', '目录为空 → 无法证伪')
  assert.equal(catalogHasRoute(cat, 'broken', 'anything'), 'unknown', '目录读取失败 → 无法证伪')
  assert.equal(catalogHasRoute(cat, 'ghost', 'anything'), 'no', '有目录但无此 provider → 明确缺失')
})

test('空目录（LLM 未就绪）时一切都算未知，不误判为缺失', () => {
  const empty: CatalogSnapshot = { providers: [], allowlist: undefined, at: 0 }
  assert.equal(catalogHasRoute(empty, 'p', 'm'), 'unknown')
})

test('effortSupport：空 effort 恒支持；未声明 → unknown；声明后按集合判定', () => {
  const cat = snapshot()
  assert.equal(effortSupport(cat, 'p', 'm1', ''), 'yes')
  assert.equal(effortSupport(cat, 'p', 'm1', 'low'), 'yes')
  assert.equal(effortSupport(cat, 'p', 'm1', 'max'), 'no')
  assert.equal(effortSupport(cat, 'p', 'm2', 'max'), 'unknown', 'm2 未声明 efforts')
})

test('isAllowlistBlocked：白名单缺失时不拦，命中时不拦，未命中时拦', () => {
  const cat = snapshot()
  assert.equal(isAllowlistBlocked(cat, 'p', 'm1'), false, '白名单 undefined → 不拦')
  const gated: CatalogSnapshot = { ...cat, allowlist: [{ provider: 'p', model: 'm1' }] }
  assert.equal(isAllowlistBlocked(gated, 'p', 'm1'), false)
  assert.equal(isAllowlistBlocked(gated, 'p', 'm2'), true)
})

test('classifyLine：白名单优先于目录判定', () => {
  const gated: CatalogSnapshot = { ...snapshot(), allowlist: [{ provider: 'p', model: 'm1' }] }
  // m2 既不在白名单、又在目录里 → blocked 胜出
  assert.equal(classifyLine(line('p', 'm2'), gated).status, 'blocked')
  // 不在白名单且目录里也没有 → 仍是 blocked
  assert.equal(classifyLine(line('p', 'ghost'), gated).status, 'blocked')
})

test('classifyLine：目录缺失 → missing 且带人读原因', () => {
  const cat = snapshot()
  const missingModel = classifyLine(line('p', 'nope'), cat)
  assert.equal(missingModel.status, 'missing')
  assert.match(missingModel.statusDetail!, /不在 provider "p" 的目录中/)

  const missingProvider = classifyLine(line('ghost', 'm'), cat)
  assert.equal(missingProvider.status, 'missing')
  assert.match(missingProvider.statusDetail!, /provider "ghost" 未注册/)
})

test('classifyLine：不支持的 reasoning_effort → missing 并说明原因', () => {
  const verdict = classifyLine(line('p', 'm1', 'max'), snapshot())
  assert.equal(verdict.status, 'missing')
  assert.match(verdict.statusDetail!, /不支持 reasoning_effort "max"/)
})

test('classifyLine：单条线路失败不影响同档其它线路', () => {
  const cat = snapshot()
  assert.equal(classifyLine(line('p', 'm1'), cat).status, 'available')
  assert.equal(classifyLine(line('p', 'nope'), cat).status, 'missing')
})

test('classifyConfig 同时覆盖四档与 fallback，并保留原始配置', () => {
  const config = resolveConfig({
    tiers: {
      low: { lines: [line('p', 'm1'), line('p', 'gone')] },
      max: { lines: [line('p', 'm2')] },
    },
    fallback: line('p', 'gone-too'),
  })
  const classified = classifyConfig(config, snapshot())
  const low = classified.tiers.find(tier => tier.id === 'low')!
  assert.deepEqual(low.lines.map(l => l.status), ['available', 'missing'])
  assert.equal(classified.tiers.find(tier => tier.id === 'max')!.lines[0]!.status, 'available')
  assert.equal(classified.fallback.status, 'missing')
  assert.equal(availableLines(low.lines).length, 1)
  assert.deepEqual(missingLines(classified).map(l => l.model), ['gone', 'gone-too'])
})

test('未配置的线路（空 provider/model）不参与可用/缺失统计', () => {
  const config = resolveConfig({ tiers: { high: { lines: [line('p', '')] } } })
  const classified = classifyConfig(config, snapshot())
  assert.deepEqual(classified.tiers.find(tier => tier.id === 'high')!.lines, [])
  assert.deepEqual(missingLines(classified), [])
})

test('findProvider / findModel 是精确匹配', () => {
  const cat = snapshot()
  assert.equal(findProvider(cat, 'p')?.id, 'p')
  assert.equal(findProvider(cat, 'P'), undefined)
  assert.equal(findModel(cat, 'p', 'm1')?.id, 'm1')
  assert.equal(findModel(cat, 'p', 'M1'), undefined)
})

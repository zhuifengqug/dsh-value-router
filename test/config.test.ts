/**
 * 新配置契约（四档 + 单一全局 fallback）的归一化测试。
 *
 * 同时守住两条**退役断言**：
 * - 旧键（`pool` / `executor` / `strategy` / `ambiguousPolicy` / `tierRouting`）不再产生任何效果；
 * - 旧形状的 `tiers`（数组）不再被解析成档位。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_CONFIG,
  DIFFICULTIES,
  degradationChain,
  isEmptyConfig,
  isCompleteLine,
  lineKey,
  resolveConfig,
  resolveLine,
  resolveTiers,
  tierLabel,
  tierOf,
  type ResolvedValueRouterConfig,
} from '../src/core/config.ts'

const line = (provider: string, model: string, reasoning_effort = '') => ({ provider, model, reasoning_effort })

test('默认配置：四档齐备且顺序为 low→max，fallback 未配置', () => {
  const config = resolveConfig(undefined)
  assert.deepEqual(config.tiers.map(tier => tier.id), ['low', 'medium', 'high', 'max'])
  assert.equal(config.enabled, true)
  assert.deepEqual(config.tiers.every(tier => tier.lines.length === 0), true)
  assert.deepEqual(
    { provider: config.fallback.provider, model: config.fallback.model, reasoning_effort: config.fallback.reasoning_effort },
    { provider: '', model: '', reasoning_effort: '' },
  )
})

test('DEFAULT_CONFIG 与 resolveConfig(undefined) 同形', () => {
  const config = resolveConfig(undefined)
  assert.equal(config.enabled, DEFAULT_CONFIG.enabled)
  assert.deepEqual(config.tiers.map(tier => tier.id), DIFFICULTIES)
})

test('四档各自独立解析；同一 provider/model 可跨档存在（含不同 reasoning_effort）', () => {
  const config = resolveConfig({
    tiers: {
      low: { lines: [line('p', 'm', 'low-effort')] },
      max: { lines: [line('p', 'm', 'high-effort')] },
    },
  })
  assert.deepEqual(tierOf(config.tiers, 'low').lines.map(l => l.reasoning_effort), ['low-effort'])
  assert.deepEqual(tierOf(config.tiers, 'medium').lines, [])
  assert.deepEqual(tierOf(config.tiers, 'max').lines.map(l => l.reasoning_effort), ['high-effort'])
})

test('同档内按完整键去重，同 provider/model 不同 effort 视为两条线路', () => {
  const config = resolveConfig({
    tiers: {
      high: {
        lines: [
          line('p', 'm', 'a'),
          line('p', 'm', 'a'),
          line('p', 'm', 'b'),
          line('p', 'm', ''),
        ],
      },
    },
  })
  assert.deepEqual(tierOf(config.tiers, 'high').lines.map(l => l.reasoning_effort), ['a', 'b', ''])
})

test('半配置线路与半配置 fallback 一律丢弃 / 归一化为未配置', () => {
  const config = resolveConfig({
    tiers: { medium: { lines: [line('only-provider', ''), line('', 'only-model'), line('p', 'm')] } },
    fallback: { provider: 'p' },
  })
  assert.deepEqual(tierOf(config.tiers, 'medium').lines.map(l => `${l.provider}/${l.model}`), ['p/m'])
  assert.equal(config.fallback.model, '')
  assert.equal(isCompleteLine(config.fallback), false)
})

test('非字符串与空白输入被安全收敛，不抛错', () => {
  const config = resolveConfig({
    enabled: 'yes' as unknown as boolean,
    tiers: { low: { lines: 'nope' as unknown as never } },
    fallback: 42 as unknown as never,
  })
  assert.equal(config.enabled, true)
  assert.deepEqual(tierOf(config.tiers, 'low').lines, [])
  assert.equal(config.fallback.provider, '')
})

test('退役键不再生效：pool / executor / strategy / ambiguousPolicy / tierRouting 被完全忽略', () => {
  const config = resolveConfig({
    enabled: true,
    // 全部是旧契约的字段，必须一个都不生效
    pool: [{ provider: 'legacy', model: 'legacy-model', tier: 'cheap' }],
    executor: { provider: 'legacy', model: 'legacy-executor', reasoningEffort: 'high' },
    strategy: 'powerful',
    ambiguousPolicy: 'respect',
    tierRouting: 'controller',
    tiers: undefined,
  } as never)
  const flat = config.tiers.flatMap(tier => tier.lines)
  assert.deepEqual(flat, [])
  assert.equal(config.fallback.provider, '')
  assert.equal('strategy' in config, false)
  assert.equal('executor' in config, false)
  assert.equal('ambiguousPolicy' in config, false)
  assert.equal('tierRouting' in config, false)
})

test('退役形状不再生效：tiers 为数组时整份档位为空（无迁移、无双读）', () => {
  const config = resolveConfig({
    tiers: [
      { id: 'cheap', label: '省', pool: [line('legacy', 'legacy-model')] },
      { id: 'strong', label: '强', pool: [line('legacy', 'strong-model', 'high')] },
    ],
  } as never)
  assert.deepEqual(config.tiers.flatMap(tier => tier.lines), [])
})

test('resolveTiers / resolveLine 是纯函数，不共享输入引用', () => {
  const source = { tiers: { max: { lines: [line('p', 'm', 'e')] } } }
  const first = resolveTiers(source)
  const second = resolveTiers(source)
  assert.notEqual(first[3], second[3])
  assert.deepEqual(first[3]!.lines, second[3]!.lines)
  assert.equal(resolveLine({ provider: 'p', model: 'm' })?.reasoning_effort, '')
  assert.equal(resolveLine({ provider: '', model: 'm' }), undefined)
})

test('degradationChain 只朝成本更低的方向展开，low 没有更低档', () => {
  assert.deepEqual(degradationChain('max'), ['max', 'high', 'medium', 'low'])
  assert.deepEqual(degradationChain('high'), ['high', 'medium', 'low'])
  assert.deepEqual(degradationChain('medium'), ['medium', 'low'])
  assert.deepEqual(degradationChain('low'), ['low'])
})

test('tierLabel 与 isEmptyConfig', () => {
  assert.equal(tierLabel('low'), '低')
  assert.equal(tierLabel('max'), '最高')
  const empty: ResolvedValueRouterConfig = resolveConfig(undefined)
  assert.equal(isEmptyConfig(empty), true)
  const withLine = resolveConfig({ tiers: { low: { lines: [line('p', 'm')] } } })
  assert.equal(isEmptyConfig(withLine), false)
  const withFallbackOnly = resolveConfig({ fallback: line('p', 'm') })
  assert.equal(isEmptyConfig(withFallbackOnly), false)
})

test('lineKey 三段参与，空 effort 与显式 effort 不碰撞', () => {
  assert.notEqual(lineKey(line('p', 'm')), lineKey(line('p', 'm', 'x')))
  assert.equal(lineKey(line('p', 'm', 'x')), lineKey({ provider: ' p ', model: 'm', reasoning_effort: 'x ' }))
})

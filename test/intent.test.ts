/**
 * 路由意图：角色归一化、难度/角色校验、成员复用键。
 *
 * 核心断言：**非法 difficulty / role 必须显式报错**，不得静默回落成缺省值。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { memberReuseKey, normalizeRole, validateRouteIntent } from '../src/core/intent.ts'

test('normalizeRole：trim + 连续空白合并 + Unicode 小写化', () => {
  assert.equal(normalizeRole('  Senior   Engineer  '), 'senior engineer')
  assert.equal(normalizeRole('RESEARCHER'), 'researcher')
  assert.equal(normalizeRole('RÉSUMÉ  WRITER'), 'résumé writer')
  assert.equal(normalizeRole('ÄÖÜ'), 'äöü')
  assert.equal(normalizeRole('a\t\n b'), 'a b')
  assert.equal(normalizeRole('数据   分析'), '数据 分析')
  assert.equal(normalizeRole('Data\u00a0Analyst'), 'data analyst')
})

test('normalizeRole：非字符串与纯空白都归一化为空串', () => {
  assert.equal(normalizeRole(undefined), '')
  assert.equal(normalizeRole(42), '')
  assert.equal(normalizeRole('   '), '')
})

test('缺省意图合法：difficulty→medium，role→general，route 未给出', () => {
  const result = validateRouteIntent({})
  assert.equal(result.ok, true)
  assert.equal(result.difficulty, 'medium')
  assert.equal(result.normalizedRole, 'general')
  assert.equal(result.route, undefined)
  assert.deepEqual(result.errors, [])
})

test('非法 difficulty 必须显式报错，而不是回落成 medium', () => {
  for (const bad of ['LOW', 'critical', 'l', 3, true, {}]) {
    const result = validateRouteIntent({ difficulty: bad })
    assert.equal(result.ok, false, `difficulty=${JSON.stringify(bad)} 必须被拒`)
    assert.equal(result.errors.length, 1)
    assert.match(result.errors[0]!, /invalid difficulty/)
    assert.equal(result.difficulty, undefined)
  }
})

test('非法 role 必须显式报错（空串、纯空白、非字符串）', () => {
  for (const bad of ['', '   ', 7, []] as unknown[]) {
    const result = validateRouteIntent({ role: bad })
    assert.equal(result.ok, false, `role=${JSON.stringify(bad)} 必须被拒`)
    assert.match(result.errors[0]!, /invalid role/)
  }
})

test('角色自由文本合法，归一化后进 normalizedRole', () => {
  const result = validateRouteIntent({ role: '  Code   REVIEWER ' })
  assert.equal(result.ok, true)
  assert.equal(result.normalizedRole, 'code reviewer')
  assert.equal(result.role, 'code reviewer')
})

test('显式线路：三段齐全才合法；缺 provider 或 model 报错', () => {
  const ok = validateRouteIntent({ route: { provider: 'p', model: 'm', reasoning_effort: 'high' } })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.route, { provider: 'p', model: 'm', reasoning_effort: 'high' })

  const noEffort = validateRouteIntent({ route: { provider: 'p', model: 'm' } })
  assert.equal(noEffort.ok, true)
  assert.equal(noEffort.route?.reasoning_effort, '')

  for (const bad of [{ provider: 'p' }, { model: 'm' }, { provider: ' ', model: 'm' }, {}]) {
    const result = validateRouteIntent({ route: bad })
    assert.equal(result.ok, false, `route=${JSON.stringify(bad)} 必须被拒`)
    assert.match(result.errors[0]!, /invalid route/)
  }
})

test('多个错误同时上报，不短路', () => {
  const result = validateRouteIntent({ difficulty: 'nope', role: '  ', route: { provider: 'p' } })
  assert.equal(result.ok, false)
  assert.equal(result.errors.length, 3)
})

test('成员复用键：五段参与，任何一段变化都必须换键', () => {
  const base = { difficulty: 'medium' as const, normalizedRole: 'engineer', provider: 'p', model: 'm', reasoning_effort: 'high' }
  const key = memberReuseKey(base)
  assert.equal(key, memberReuseKey({ ...base }))
  assert.notEqual(key, memberReuseKey({ ...base, difficulty: 'high' }))
  assert.notEqual(key, memberReuseKey({ ...base, normalizedRole: 'reviewer' }))
  assert.notEqual(key, memberReuseKey({ ...base, provider: 'q' }))
  assert.notEqual(key, memberReuseKey({ ...base, model: 'n' }))
  assert.notEqual(key, memberReuseKey({ ...base, reasoning_effort: '' }))
  // 缺省 effort 与显式空串等价（都表示"用模型默认"）。
  assert.equal(memberReuseKey({ ...base, reasoning_effort: undefined }), memberReuseKey({ ...base, reasoning_effort: '' }))
})

test('成员复用键：角色文本里的分隔符不会与分段结构撞车', () => {
  const a = memberReuseKey({ difficulty: 'low', normalizedRole: 'a\u0000b', provider: 'p', model: 'm' })
  const b = memberReuseKey({ difficulty: 'low', normalizedRole: 'a', provider: 'b', model: 'p' })
  assert.notEqual(a, b)
})

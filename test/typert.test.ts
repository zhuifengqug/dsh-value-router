/**
 * Typert 宿主清单（src/typert.ts）的契约测试。
 *
 * 这里复刻 dsh-typert-loader 的校验规则（validateTypertManifest / requireInvocation /
 * requireStrictCodec）：清单一旦不合法，Remote 服务在运行时无法调度，而浏览器侧只会
 * 表现为「读不到状态」，排查成本很高。同时交叉校验客户端 descriptor 的 typeSymbol
 * 与宿主逐字一致——两半对不上时，这里先红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { TYPERT } from '../src/typert.ts'

const PKG = '@gjs27/dsh-value-router'
const TYPES = `${PKG}/types`

/** 复刻 loader 的 requireStrictCodec。 */
function assertStrictCodec(codec: unknown, subject: string): asserts codec is { mode: string; typeSymbol: string; schema: { parse: (v: unknown) => unknown } } {
  assert.equal(typeof codec, 'object', `${subject} 必须是对象`)
  assert.ok(codec !== null, `${subject} 不能是 null`)
  const value = codec as Record<string, unknown>
  assert.equal(value.mode, 'strict', `${subject} 必须是 strict codec`)
  assert.equal(typeof value.typeSymbol, 'string', `${subject} 需要 typeSymbol`)
  const schema = value.schema as Record<string, unknown> | null
  assert.ok(schema !== null && typeof schema === 'object', `${subject} 需要 schema`)
  assert.ok('_zod' in schema, `${subject} 必须是 zod v4 实例（带 _zod 标记）`)
  assert.equal(typeof schema.parse, 'function', `${subject} 的 schema 需要 parse()`)
}

test('清单头字段符合 loader 要求', () => {
  assert.equal(TYPERT.package, PKG, 'package 必须与包名逐字一致')
  assert.equal(TYPERT.face, 'host')
  assert.ok(Array.isArray(TYPERT.schemas))
  assert.ok(Array.isArray(TYPERT.model.services))
  assert.ok(Array.isArray(TYPERT.model.events))
  assert.ok(Array.isArray(TYPERT.model.objects))
})

test('三个 invocation 的 id / service / namespace / method 与客户端 descriptor 对齐', () => {
  const expected = [
    { method: 'status', input: `${TYPES}#StatusInput`, result: `${TYPES}#ValueRouterStatusStatusResult` },
    { method: 'sessionMetrics', input: `${TYPES}#SessionMetricsInput`, result: `${TYPES}#ValueRouterStatusSessionMetricsResult` },
    { method: 'setSessionOverride', input: `${TYPES}#SetSessionOverrideInput`, result: `${TYPES}#ValueRouterStatusSetSessionOverrideResult` },
  ]
  assert.equal(TYPERT.invocations.length, expected.length, 'invocation 数量必须与 Remote 方法数一致')
  TYPERT.invocations.forEach((invocation, index) => {
    const want = expected[index]!
    assert.equal(invocation.id, `${PKG}#valueRouterStatus/${want.method}`)
    assert.equal(invocation.service, 'valueRouterStatus')
    assert.equal(invocation.namespace, 'valueRouterStatus')
    assert.equal(invocation.method, want.method)
    // 声明顺序即线上顺序，必须与 status-controller 的 markRemote 顺序一致
    assert.equal(invocation.invocation.kind, 'direct')
    const parameters = invocation.parameters as Array<Record<string, unknown>>
    assert.equal(parameters.length, 1)
    assert.equal(parameters[0]!.name, 'input')
    assert.equal(parameters[0]!.wire, 'input')
    assert.equal(parameters[0]!.source, 'json')
    assertStrictCodec(parameters[0]!.codec, `${want.method} 参数`)
    assert.equal((parameters[0]!.codec as { typeSymbol: string }).typeSymbol, want.input)
    assertStrictCodec(invocation.result, `${want.method} 结果`)
    assert.equal((invocation.result as { typeSymbol: string }).typeSymbol, want.result)
  })
})

test('客户端 descriptor 的 typeSymbol 与宿主逐字一致', () => {
  const raw = readFileSync(
    fileURLToPath(new URL('../src/client/use-live-status.ts', import.meta.url)),
    'utf8',
  )
  // 客户端用模板字符串拼 symbol（`${REMOTE_TYPES}#StatusInput`），先展开其常量再比对。
  const constants = new Map<string, string>()
  for (const [, name, value] of raw.matchAll(/const\s+(REMOTE_\w+)\s*=\s*'([^']*)'/g)) {
    constants.set(name!, value!)
  }
  // 再展开一层模板常量（REMOTE_TYPES = `${REMOTE_PACKAGE}/types`）。
  for (let pass = 0; pass < 3; pass++) {
    for (const [, name, body] of raw.matchAll(/const\s+(REMOTE_\w+)\s*=\s*`([^`]*)`/g)) {
      if (constants.has(name!)) continue
      const expanded = body!.replace(/\$\{(\w+)\}/g, (whole, ref: string) => constants.get(ref) ?? whole)
      if (!expanded.includes('${')) constants.set(name!, expanded)
    }
  }
  assert.ok(constants.size >= 3, '未解析到客户端的 REMOTE_* 常量')
  const clientSource = raw.replace(/\$\{(\w+)\}/g, (whole, name: string) => constants.get(name) ?? whole)

  for (const invocation of TYPERT.invocations) {
    for (const codec of [
      (invocation.parameters as Array<{ codec: { typeSymbol: string } }>)[0]!.codec,
      invocation.result as { typeSymbol: string },
    ]) {
      assert.ok(
        clientSource.includes(codec.typeSymbol),
        `客户端缺少宿主声明的 typeSymbol：${codec.typeSymbol}`,
      )
    }
  }
  assert.ok(clientSource.includes(`${PKG}#valueRouterStatus/`), '客户端 descriptor 的 id 前缀应与宿主一致')
})

test('codec schema 是严格 schema：拒绝未知字段', () => {
  const status = TYPERT.invocations[0]!
  const result = status.result as { schema: { safeParse: (v: unknown) => { success: boolean } } }
  assert.equal(result.schema.safeParse({ ok: true }).success, false, '未知字段应被拒绝')
  assert.equal(result.schema.safeParse({}).success, false, '缺字段应被拒绝')

  const override = TYPERT.invocations[2]!
  const input = (override.parameters as Array<{ codec: { schema: { safeParse: (v: unknown) => { success: boolean } } } }>)[0]!.codec.schema
  assert.equal(input.safeParse({ sessionId: 's1', override: null }).success, true)
  assert.equal(input.safeParse({ sessionId: 's1', override: { strategy: 'turbo' } }).success, false, '非法档位应被拒绝')
  assert.equal(input.safeParse({ sessionId: '' }).success, false, '空 sessionId 应被拒绝')
})

test('status 结果的完整形状可通过校验（与 snapshot() 的键集一致）', () => {
  const status = TYPERT.invocations[0]!
  const result = status.result as { schema: { safeParse: (v: unknown) => { success: boolean } } }
  const full = {
    enabled: true,
    scope: 'preset',
    strategy: 'balanced',
    executor: { provider: 'p', model: 'm', reasoningEffort: '' },
    executorStatus: 'active',
    executorCallsTotal: 0,
  }
  assert.equal(result.schema.safeParse(full).success, true, '快照最小形状必须能通过 strict codec')
  // executorReason 是唯一的可选键：给出时也必须通过
  assert.equal(
    result.schema.safeParse({ ...full, executorStatus: 'degraded', executorReason: 'executor provider 不可用' }).success,
    true,
  )
  // 已退役通道的字段一律被 strict 拒绝（防止宿主/客户端悄悄回潮）
  assert.equal(result.schema.safeParse({ ...full, delegationsTotal: 0 }).success, false, '退役字段应被拒绝')
  assert.equal(result.schema.safeParse({ ...full, lastOutcome: 'none' }).success, false, '退役字段应被拒绝')
  // 枚举值必须落在声明的取值内
  assert.equal(result.schema.safeParse({ ...full, executorStatus: 'up' }).success, false, '非法 executorStatus 应被拒绝')
})

test('sessionMetrics 结果形状：executorCalls + override（可 null）', () => {
  const metrics = TYPERT.invocations[1]!
  const result = metrics.result as { schema: { safeParse: (v: unknown) => { success: boolean } } }
  const base = { executorCalls: 3, override: null }
  assert.equal(result.schema.safeParse(base).success, true)
  assert.equal(
    result.schema.safeParse({ executorCalls: 0, override: { strategy: 'saver', executor: { provider: 'p', model: 'm', reasoningEffort: 'low' } } }).success,
    true,
  )
  assert.equal(result.schema.safeParse({ executorCalls: 3 }).success, false, 'override 是必填键（可为 null）')
  assert.equal(result.schema.safeParse({ override: null }).success, false, '缺 executorCalls 应被拒绝')
  assert.equal(result.schema.safeParse({ ...base, extra: 1 }).success, false, '未知字段应被拒绝')
  assert.equal(result.schema.safeParse({ ...base, executorCalls: -1 }).success, false, '负数计数应被拒绝')
  assert.equal(result.schema.safeParse({ ...base, executorCalls: 1.5 }).success, false, '非整数计数应被拒绝')
})

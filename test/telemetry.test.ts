/**
 * 路由遥测：难度映射受控、错误类别映射、仅在 Desktop 桥开启时写 stdout。
 *
 * 隐私纪律：只发固定枚举与合法模型 id，未知值一律收敛成 `unknown`，不回传原文。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  emitValueRouterRuntimeTelemetry,
  routeErrorType,
  routeParameters,
  telemetryDifficulty,
  VALUE_ROUTER_RUNTIME_TELEMETRY_PREFIX,
} from '../src/core/runtime-telemetry.ts'

test('遥测前缀是固定常量', () => {
  assert.equal(VALUE_ROUTER_RUNTIME_TELEMETRY_PREFIX, 'DSH_VALUE_ROUTER_METRIC ')
})

test('telemetryDifficulty 收敛成受控枚举', () => {
  for (const value of ['low', 'medium', 'high', 'max', 'fallback']) {
    assert.equal(telemetryDifficulty(value), value)
  }
  for (const value of ['', 'LOW', 'critical', 'user', 'difficulty', 'executor']) {
    assert.equal(telemetryDifficulty(value), 'unknown')
  }
})

test('routeParameters：难度进 difficulty，模型 id 非法时收敛为 unknown', () => {
  const params = routeParameters('subagent', 'high', 'gpt-4o-mini')
  assert.equal(params.role, 'subagent')
  assert.equal(params.difficulty, 'high')
  assert.equal(params.model, 'gpt-4o-mini')
  assert.equal(params.result, 'started')
  assert.equal(params.error_type, 'none')

  assert.equal(routeParameters('main', 'max', 'vendor/model:2024-01-01').model, 'vendor/model:2024-01-01')
  assert.equal(routeParameters('subagent', 'low', 'has space').model, 'unknown')
  assert.equal(routeParameters('subagent', 'low', '').model, 'unknown')
  assert.equal(routeParameters('subagent', 'low', 'x'.repeat(200)).model, 'unknown')
})

test('routeParameters 不再上报 strategy；未知档位收敛为 unknown', () => {
  const params = routeParameters('subagent', 'saver', 'm') as unknown as Record<string, unknown>
  assert.equal('strategy' in params, false)
  assert.equal(params.difficulty, 'unknown')
})

test('routeErrorType 按状态码与错误码分类', () => {
  assert.equal(routeErrorType({ status: 401 }), 'auth')
  assert.equal(routeErrorType({ status: 403 }), 'auth')
  assert.equal(routeErrorType({ status: 429 }), 'rate_limit')
  assert.equal(routeErrorType({ code: 'ETIMEDOUT' }), 'timeout')
  assert.equal(routeErrorType({ code: 'ECONNRESET' }), 'network')
  assert.equal(routeErrorType({ status: 503 }), 'provider')
  assert.equal(routeErrorType({ status: 400 }), 'invalid_request')
  assert.equal(routeErrorType({ status: 418 }), 'invalid_request')
  assert.equal(routeErrorType(undefined), 'unknown')
  assert.equal(routeErrorType({}), 'unknown')
})

/** 临时替换 process.env/stdout 的探针。 */
function withBridge(env: string | undefined, run: (lines: string[]) => void): void {
  const runtime = process as unknown as {
    env: Record<string, string | undefined>
    stdout: { write: (value: string) => unknown }
  }
  const originalEnv = runtime.env.DSH_DESKTOP_PRODUCT_METRICS_BRIDGE
  const originalWrite = runtime.stdout.write
  const lines: string[] = []
  if (env === undefined) delete runtime.env.DSH_DESKTOP_PRODUCT_METRICS_BRIDGE
  else runtime.env.DSH_DESKTOP_PRODUCT_METRICS_BRIDGE = env
  runtime.stdout.write = (value: string) => { lines.push(value); return true }
  try {
    run(lines)
  } finally {
    if (originalEnv === undefined) delete runtime.env.DSH_DESKTOP_PRODUCT_METRICS_BRIDGE
    else runtime.env.DSH_DESKTOP_PRODUCT_METRICS_BRIDGE = originalEnv
    runtime.stdout.write = originalWrite
  }
}

test('桥未开启时不写任何东西', () => {
  withBridge(undefined, (lines) => {
    emitValueRouterRuntimeTelemetry({ event: 'value_router_route', params: routeParameters('subagent', 'low', 'm'), timestamp: 't' })
    assert.deepEqual(lines, [])
  })
  withBridge('0', (lines) => {
    emitValueRouterRuntimeTelemetry({ event: 'value_router_route', params: routeParameters('subagent', 'low', 'm'), timestamp: 't' })
    assert.deepEqual(lines, [])
  })
})

test('桥开启时写一行带前缀的 JSON，字段不含会话与提示词', () => {
  withBridge('1', (lines) => {
    emitValueRouterRuntimeTelemetry({
      event: 'value_router_route',
      params: routeParameters('subagent', 'high', 'm'),
      timestamp: '2026-01-01T00:00:00.000Z',
    })
    assert.equal(lines.length, 1)
    const line = lines[0]!
    assert.ok(line.startsWith(VALUE_ROUTER_RUNTIME_TELEMETRY_PREFIX))
    assert.ok(line.endsWith('\n'))
    const payload = JSON.parse(line.slice(VALUE_ROUTER_RUNTIME_TELEMETRY_PREFIX.length)) as Record<string, unknown>
    assert.equal(payload.event, 'value_router_route')
    assert.deepEqual(Object.keys(payload).sort(), ['event', 'params', 'timestamp'])
    const params = payload.params as Record<string, unknown>
    assert.deepEqual(
      Object.keys(params).sort(),
      ['difficulty', 'error_type', 'model', 'result', 'role'],
    )
  })
})

test('stdout 写入失败不抛出（遥测绝不改变路由行为）', () => {
  const runtime = process as unknown as {
    env: Record<string, string | undefined>
    stdout: { write: (value: string) => unknown }
  }
  const originalEnv = runtime.env.DSH_DESKTOP_PRODUCT_METRICS_BRIDGE
  const originalWrite = runtime.stdout.write
  runtime.env.DSH_DESKTOP_PRODUCT_METRICS_BRIDGE = '1'
  runtime.stdout.write = () => { throw new Error('EPIPE') }
  try {
    assert.doesNotThrow(() => {
      emitValueRouterRuntimeTelemetry({ event: 'value_router_route', params: routeParameters('subagent', 'low', 'm'), timestamp: 't' })
    })
  } finally {
    if (originalEnv === undefined) delete runtime.env.DSH_DESKTOP_PRODUCT_METRICS_BRIDGE
    else runtime.env.DSH_DESKTOP_PRODUCT_METRICS_BRIDGE = originalEnv
    runtime.stdout.write = originalWrite
  }
})

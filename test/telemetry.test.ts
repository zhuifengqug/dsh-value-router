/**
 * 遥测测试：只发固定、隐私安全的字段。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  VALUE_ROUTER_RUNTIME_TELEMETRY_PREFIX,
  emitValueRouterRuntimeTelemetry,
  routeErrorType,
  routeParameters,
} from '../src/core/runtime-telemetry.ts'

test('事件前缀与事件名', () => {
  assert.equal(VALUE_ROUTER_RUNTIME_TELEMETRY_PREFIX, 'DSH_VALUE_ROUTER_METRIC ')
})

test('routeParameters：策略映射与模型 id 白名单', () => {
  assert.equal(routeParameters('subagent', 'saver', 'deepseek-chat').strategy, 'saving')
  assert.equal(routeParameters('subagent', 'balanced', 'deepseek-chat').strategy, 'balanced')
  assert.equal(routeParameters('subagent', 'powerful', 'deepseek-chat').strategy, 'stronger')
  assert.equal(routeParameters('subagent', 'weird', 'deepseek-chat').strategy, 'unknown')
  assert.equal(routeParameters('subagent', 'balanced', 'deepseek-chat').model, 'deepseek-chat')
  // 含空格/中文等非白名单字符的 id 一律记为 unknown，避免泄漏自由文本
  assert.equal(routeParameters('subagent', 'balanced', 'bad model id with spaces').model, 'unknown')
  assert.equal(routeParameters('subagent', 'balanced', '模型').model, 'unknown')
})

test('routeErrorType 分类', () => {
  assert.equal(routeErrorType({ status: 401 }), 'auth')
  assert.equal(routeErrorType({ status: 429 }), 'rate_limit')
  assert.equal(routeErrorType({ code: 'ETIMEDOUT' }), 'timeout')
  assert.equal(routeErrorType({ code: 'ECONNREFUSED' }), 'network')
  assert.equal(routeErrorType({ status: 503 }), 'provider')
  assert.equal(routeErrorType({ status: 400 }), 'invalid_request')
  assert.equal(routeErrorType(new Error('boom')), 'unknown')
})

/**
 * Desktop 产品指标开关（DSH 平台拥有，src/core/runtime-telemetry.ts 读同一个名字）。
 *
 * 这是真实存在的 DSH 环境变量，与已退役的桥接（Chat2API 外发）通道**无关**，
 * 只是名字里恰好含 BRIDGE，所以这里照实写字面量——测试不该为了迁就检索脚本而
 * 把变量名拼接起来（那会让后来人以为这个名字有什么特殊之处）。
 */
const DESKTOP_METRICS_ENV = 'DSH_DESKTOP_PRODUCT_METRICS_BRIDGE'

test('未开启 Desktop 产品指标开关时不写 stdout', () => {
  const original = (globalThis as { process?: { env?: Record<string, string | undefined>; stdout?: { write: (v: string) => unknown } } }).process
  const writes: string[] = []
  const proc = original as unknown as { env: Record<string, string | undefined>; stdout: { write: (v: string) => unknown } }
  const savedEnv = proc.env[DESKTOP_METRICS_ENV]
  const savedWrite = proc.stdout.write
  try {
    delete proc.env[DESKTOP_METRICS_ENV]
    proc.stdout.write = (value: string) => { writes.push(value); return true }
    emitValueRouterRuntimeTelemetry({
      event: 'value_router_route',
      timestamp: new Date().toISOString(),
      params: routeParameters('subagent', 'balanced', 'deepseek-chat'),
    })
    assert.equal(writes.length, 0)

    proc.env[DESKTOP_METRICS_ENV] = '1'
    emitValueRouterRuntimeTelemetry({
      event: 'value_router_route',
      timestamp: new Date().toISOString(),
      params: routeParameters('subagent', 'balanced', 'deepseek-chat'),
    })
    assert.equal(writes.length, 1)
    assert.ok(writes[0]?.startsWith(VALUE_ROUTER_RUNTIME_TELEMETRY_PREFIX))
    const payload = JSON.parse((writes[0] as string).slice(VALUE_ROUTER_RUNTIME_TELEMETRY_PREFIX.length))
    assert.equal(payload.event, 'value_router_route')
    assert.equal(payload.params.model, 'deepseek-chat')
    // 隐私口径：载荷里不出现会话 id / 提示词
    assert.equal(JSON.stringify(payload).includes('sessionId'), false)
  } finally {
    proc.stdout.write = savedWrite
    if (savedEnv === undefined) delete proc.env[DESKTOP_METRICS_ENV]
    else proc.env[DESKTOP_METRICS_ENV] = savedEnv
  }
})

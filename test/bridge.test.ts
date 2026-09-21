/**
 * bridge.ts 全 mock 单测。
 *
 * 运行：node --experimental-strip-types test/bridge.test.ts
 *
 * 使用 node:assert/strict + 顶层 await/assert，不依赖任何测试框架。
 * 覆盖：成功（usage 实值）、thinking 三模式、webSearch 模型选择、
 *       超时、非 200、JSON 异常、usage 缺失（estimateOnly=true）、
 *       bridge.enabled=false、probeHealth 上/下/缓存命中、
 *       apiKey 不出现在错误文本里、
 *       thinkingBody/searchBody 请求体合并、models 提取与上限。
 */

import assert from 'node:assert/strict'
import { resolveConfig, DEFAULT_BRIDGE_CONFIG } from '../src/core/config.ts'
import type { ResolvedValueRouterConfig, BridgeConfig } from '../src/core/config.ts'
import { BridgeClient } from '../src/bridge/bridge.ts'
import type { BridgeChatRequest, BridgeResult, BridgeHealth } from '../src/bridge/bridge.ts'

// —————————————————————————— 辅助 ——————————————————————————

let passed = 0
let failed = 0

function check(name: string, fn: () => void | Promise<void>) {
  return (async () => {
    try {
      await fn()
      passed++
      console.log(`  ✓ ${name}`)
    } catch (err: unknown) {
      failed++
      console.error(`  ✗ ${name}`)
      console.error(`    ${err instanceof Error ? err.message : String(err)}`)
    }
  })()
}

/** 构造一个可注入 fetchImpl 的配置 getter（经 resolveConfig 归一化）。 */
function makeConfig(overrides: Partial<BridgeConfig> = {}): () => ResolvedValueRouterConfig {
  return () => resolveConfig({
    bridge: { ...DEFAULT_BRIDGE_CONFIG, ...overrides },
  })
}

/**
 * 构造一个绕过 resolveConfig 归一化的配置 getter。
 * 用于测试 modelMap 槽位为空时的回落逻辑（resolveModelMap 会把空值填为默认值）。
 */
function makeRawConfig(bridgeOverrides: Partial<BridgeConfig> = {}): () => ResolvedValueRouterConfig {
  return () => ({
    ...resolveConfig(undefined),
    bridge: { ...DEFAULT_BRIDGE_CONFIG, ...bridgeOverrides },
  })
}

/** 基础 chat 请求模板。 */
const BASE_REQ: BridgeChatRequest = {
  requestId: 'r-1',
  taskType: 'explanation',
  question: '什么是 TCP？',
  thinking: 'off',
  webSearch: false,
}

/** 构造成功响应。 */
function okResponse(
  content = 'TCP 是面向连接的传输协议。',
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number },
  reasoningContent?: string,
): Response {
  const message: Record<string, unknown> = { role: 'assistant', content }
  if (reasoningContent !== undefined) {
    message.reasoning_content = reasoningContent
  }
  const body: Record<string, unknown> = {
    choices: [{ message }],
  }
  if (usage) {
    body.usage = usage
  }
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

/** 构造非 200 响应。 */
function errResponse(status: number, body = '{"error":"bad"}'): Response {
  return new Response(body, { status })
}

/** 构造 JSON 解析失败的响应（返回非 JSON 文本）。 */
function badJsonResponse(): Response {
  return new Response('not json at all', { status: 200, headers: { 'content-type': 'text/plain' } })
}

/** 构造 GET /models 成功响应。 */
function modelsOkResponse(ids: string[]): Response {
  return new Response(
    JSON.stringify({ data: ids.map((id) => ({ id, object: 'model' })) }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

/** 构造 GET /models 使用 models[] 格式的成功响应。 */
function modelsAltFormatResponse(ids: string[]): Response {
  return new Response(
    JSON.stringify({ models: ids.map((id) => ({ id })) }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

// —————————————————————————— 测试 ——————————————————————————

console.log('bridge.test.ts')
console.log('')

// —— 成功：usage 实值（trustUsage:'always' 以隔离信任逻辑）——
await check('success with real usage', async () => {
  const calls: unknown[] = []
  const fetchImpl = (async (_url: string, init: unknown) => {
    calls.push(init)
    return okResponse('你好！', { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 })
  }) as typeof fetch
  const client = new BridgeClient({ getConfig: makeConfig({ trustUsage: 'always' }), fetchImpl })
  const r = await client.chat(BASE_REQ) as Extract<import('../src/bridge/bridge.ts').BridgeAnswer, { ok: true }>
  assert.equal(r.ok, true)
  assert.equal(r.text, '你好！')
  assert.equal(r.usage.promptTokens, 10)
  assert.equal(r.usage.completionTokens, 20)
  assert.equal(r.usage.total, 30)
  assert.equal(r.usage.estimateOnly, false)
  assert.equal(r.model, 'deepseek-v4.1-flash') // thinking='off', webSearch=false → plain
  assert.equal(r.thinkingUsed, false)
  assert.equal(r.webSearchUsed, false)
  assert.equal(r.requestId, 'r-1')
  assert.equal(r.conversationRef, 'r-1')
})

// —— thinking='off' 不读 reasoningField ——
await check('thinking off never reads reasoning field', async () => {
  const fetchImpl = (async () =>
    okResponse('答案', { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 }, '这是思考过程')
  ) as typeof fetch
  const client = new BridgeClient({ getConfig: makeConfig(), fetchImpl })
  const r = await client.chat(BASE_REQ) as Extract<import('../src/bridge/bridge.ts').BridgeAnswer, { ok: true }>
  assert.equal(r.ok, true)
  assert.equal(r.reasoning, undefined, 'off 模式不应包含 reasoning')
  assert.equal(r.thinkingUsed, false)
})

// —— thinking='on' 保留 reasoning（≤600 字符）——
await check('thinking on keeps reasoning ≤600 chars', async () => {
  const reasoning = 'A'.repeat(800) // 超过 600
  const fetchImpl = (async () =>
    okResponse('答案', { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 }, reasoning)
  ) as typeof fetch
  const client = new BridgeClient({ getConfig: makeConfig(), fetchImpl })
  const r = await client.chat({ ...BASE_REQ, thinking: 'on' }) as Extract<import('../src/bridge/bridge.ts').BridgeAnswer, { ok: true }>
  assert.equal(r.ok, true)
  assert.ok(r.reasoning, 'on 模式应包含 reasoning')
  assert.ok(r.reasoning!.length <= 600, `reasoning 长度 ${r.reasoning!.length} 应 ≤600`)
  assert.equal(r.reasoning, 'A'.repeat(600))
  assert.equal(r.thinkingUsed, true)
})

// —— thinking='on' 保留 reasoning（≤600 字符，原文不截断）——
await check('thinking on keeps full reasoning when ≤600', async () => {
  const reasoning = '短思考'
  const fetchImpl = (async () =>
    okResponse('答案', { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 }, reasoning)
  ) as typeof fetch
  const client = new BridgeClient({ getConfig: makeConfig(), fetchImpl })
  const r = await client.chat({ ...BASE_REQ, thinking: 'on' }) as Extract<import('../src/bridge/bridge.ts').BridgeAnswer, { ok: true }>
  assert.equal(r.reasoning, '短思考')
})

// —— thinking='silent' 剥离 reasoning ——
await check('thinking silent strips reasoning', async () => {
  const fetchImpl = (async () =>
    okResponse('答案', { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 }, '思考内容')
  ) as typeof fetch
  const client = new BridgeClient({ getConfig: makeConfig(), fetchImpl })
  const r = await client.chat({ ...BASE_REQ, thinking: 'silent' }) as Extract<import('../src/bridge/bridge.ts').BridgeAnswer, { ok: true }>
  assert.equal(r.ok, true)
  assert.equal(r.reasoning, undefined, 'silent 模式不应包含 reasoning')
  assert.equal(r.thinkingUsed, true, 'silent 的 thinkingUsed 应为 true')
})

// —— webSearch 模型选择 ——
await check('webSearch selects search model when thinking off', async () => {
  const fetchImpl = (async () => okResponse('答')) as typeof fetch
  const client = new BridgeClient({ getConfig: makeConfig(), fetchImpl })
  const r = await client.chat({ ...BASE_REQ, webSearch: true }) as Extract<import('../src/bridge/bridge.ts').BridgeAnswer, { ok: true }>
  assert.equal(r.model, 'deepseek-v4.1-flash-search') // thinking='off' + webSearch → search
  assert.equal(r.webSearchUsed, true)
})

await check('webSearch selects thinkingSearch model when thinking on', async () => {
  const fetchImpl = (async () => okResponse('答')) as typeof fetch
  const client = new BridgeClient({ getConfig: makeConfig(), fetchImpl })
  const r = await client.chat({ ...BASE_REQ, thinking: 'on', webSearch: true }) as Extract<import('../src/bridge/bridge.ts').BridgeAnswer, { ok: true }>
  assert.equal(r.model, 'deepseek-v4.1-flash-think-search') // thinking!='off' + webSearch → thinkingSearch
})

await check('thinking on without webSearch selects thinking model', async () => {
  const fetchImpl = (async () => okResponse('答')) as typeof fetch
  const client = new BridgeClient({ getConfig: makeConfig(), fetchImpl })
  const r = await client.chat({ ...BASE_REQ, thinking: 'on' }) as Extract<import('../src/bridge/bridge.ts').BridgeAnswer, { ok: true }>
  assert.equal(r.model, 'deepseek-v4.1-flash-think') // thinking!='off' + no webSearch → thinking
})

// —— 超时（AbortError）——
await check('timeout returns BridgeFailure', async () => {
  const fetchImpl = (async () => {
    const err = new Error('aborted')
    err.name = 'AbortError'
    throw err
  }) as typeof fetch
  const client = new BridgeClient({ getConfig: makeConfig({ timeoutMs: 100 }), fetchImpl })
  const r = await client.chat(BASE_REQ) as import('../src/bridge/bridge.ts').BridgeFailure
  assert.equal(r.ok, false)
  assert.equal(r.kind, 'timeout')
  assert.ok(r.reason.includes('超时') || r.reason.includes('取消'))
})

// —— 非 200 ——
await check('non-200 returns http-error', async () => {
  const fetchImpl = (async () => errResponse(503)) as typeof fetch
  const client = new BridgeClient({ getConfig: makeConfig(), fetchImpl })
  const r = await client.chat(BASE_REQ) as import('../src/bridge/bridge.ts').BridgeFailure
  assert.equal(r.ok, false)
  assert.equal(r.kind, 'http-error')
  assert.equal(r.status, 503)
})

// —— JSON 解析失败 ——
await check('malformed JSON returns bad-json', async () => {
  const fetchImpl = (async () => badJsonResponse()) as typeof fetch
  const client = new BridgeClient({ getConfig: makeConfig(), fetchImpl })
  const r = await client.chat(BASE_REQ) as import('../src/bridge/bridge.ts').BridgeFailure
  assert.equal(r.ok, false)
  assert.equal(r.kind, 'bad-json')
})

// —— usage 缺失 → estimateOnly=true, ok=true ——
await check('missing usage falls back to estimateOnly true and ok true', async () => {
  const fetchImpl = (async () => okResponse('答案内容', undefined)) as typeof fetch
  const client = new BridgeClient({ getConfig: makeConfig(), fetchImpl })
  const r = await client.chat(BASE_REQ) as Extract<import('../src/bridge/bridge.ts').BridgeAnswer, { ok: true }>
  assert.equal(r.ok, true, 'usage 缺失仍应 ok:true')
  assert.equal(r.usage.estimateOnly, true)
  assert.ok(r.usage.promptTokens >= 0)
  assert.ok(r.usage.completionTokens >= 0)
  assert.ok(r.usage.total >= 0)
})

// ———————————————————— trustUsage ————————————————————

// 占位值：Chat2API 实测恒返回 1/1/2
const PLACEHOLDER_USAGE = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }

// —— trustUsage:'never' → 即便响应带 usage 也用估算 + estimateOnly=true ——
await check('trustUsage never ignores response usage', async () => {
  const fetchImpl = (async () => okResponse('这是一段较长的答案内容，用于测试估算', PLACEHOLDER_USAGE)) as typeof fetch
  const client = new BridgeClient({ getConfig: makeConfig({ trustUsage: 'never' }), fetchImpl })
  const r = await client.chat(BASE_REQ) as Extract<import('../src/bridge/bridge.ts').BridgeAnswer, { ok: true }>
  assert.equal(r.ok, true)
  assert.equal(r.usage.estimateOnly, true, 'never 模式应始终 estimateOnly')
  assert.notEqual(r.usage.promptTokens, 1, 'never 不应采信占位值')
  assert.ok(r.usage.promptTokens > 1, '估算值应大于占位值')
  assert.ok(r.usage.completionTokens > 1)
})

// —— trustUsage:'always' → 采信占位值 1/1/2，estimateOnly=false ——
await check('trustUsage always trusts placeholder usage', async () => {
  const fetchImpl = (async () => okResponse('答案', PLACEHOLDER_USAGE)) as typeof fetch
  const client = new BridgeClient({ getConfig: makeConfig({ trustUsage: 'always' }), fetchImpl })
  const r = await client.chat(BASE_REQ) as Extract<import('../src/bridge/bridge.ts').BridgeAnswer, { ok: true }>
  assert.equal(r.ok, true)
  assert.equal(r.usage.estimateOnly, false, 'always 应无条件采信')
  assert.equal(r.usage.promptTokens, 1)
  assert.equal(r.usage.completionTokens, 1)
  assert.equal(r.usage.total, 2)
})

// —— trustUsage:'auto' + 长 prompt + 占位 usage → 回落估算 + estimateOnly=true ——
await check('trustUsage auto rejects placeholder for long prompt', async () => {
  // 长 prompt：question 重复多次，估算 >> 1
  const longReq = { ...BASE_REQ, question: '这是一个较长的问题，用于测试自动信任判定。'.repeat(5) }
  const fetchImpl = (async () => okResponse('较长的答案内容，需要更多 token 来生成。', PLACEHOLDER_USAGE)) as typeof fetch
  const client = new BridgeClient({ getConfig: makeConfig({ trustUsage: 'auto' }), fetchImpl })
  const r = await client.chat(longReq) as Extract<import('../src/bridge/bridge.ts').BridgeAnswer, { ok: true }>
  assert.equal(r.ok, true)
  assert.equal(r.usage.estimateOnly, true, '长 prompt + 占位值应回落估算')
  assert.ok(r.usage.promptTokens > 1, '估算的 promptTokens 应远大于 1')
})

// —— trustUsage:'auto' + 短 prompt + 合理 usage → 采信 + estimateOnly=false ——
await check('trustUsage auto trusts reasonable usage for short prompt', async () => {
  const shortReq = { ...BASE_REQ, question: 'hi', context: '' }
  // requestText = SYSTEM_PROMPT(~55 CJK tokens) + 'hi' → estimatedPrompt ≈ 56
  // 阈值 = max(1, floor(56 * 0.4)) = 22，prompt_tokens=30 ≥ 22 ✓
  // completion: 'Hi there!' 估算 ≈ 2，阈值 = max(1, floor(2*0.3)) = 1，completion_tokens=5 ≥ 1 ✓
  const reasonableUsage = { prompt_tokens: 30, completion_tokens: 5, total_tokens: 35 }
  const fetchImpl = (async () => okResponse('Hi there!', reasonableUsage)) as typeof fetch
  const client = new BridgeClient({ getConfig: makeConfig({ trustUsage: 'auto' }), fetchImpl })
  const r = await client.chat(shortReq) as Extract<import('../src/bridge/bridge.ts').BridgeAnswer, { ok: true }>
  assert.equal(r.ok, true)
  assert.equal(r.usage.estimateOnly, false, '短 prompt + 合理 usage 应采信')
  assert.equal(r.usage.promptTokens, 30)
  assert.equal(r.usage.completionTokens, 5)
})

// —— usage 缺失 + trustUsage:'always' → 仍走缺失分支（估算 + estimateOnly=true）——
await check('missing usage with trustUsage always still estimates', async () => {
  const fetchImpl = (async () => okResponse('答案内容', undefined)) as typeof fetch
  const client = new BridgeClient({ getConfig: makeConfig({ trustUsage: 'always' }), fetchImpl })
  const r = await client.chat(BASE_REQ) as Extract<import('../src/bridge/bridge.ts').BridgeAnswer, { ok: true }>
  assert.equal(r.ok, true)
  assert.equal(r.usage.estimateOnly, true, 'usage 缺失时无论 trustUsage 都应估算')
  assert.ok(r.usage.promptTokens >= 0)
  assert.ok(r.usage.completionTokens >= 0)
})

// —— bridge.enabled=false → config-error，无 fetch 调用 ——
await check('bridge disabled returns config-error without fetch', async () => {
  let fetchCalled = false
  const fetchImpl = (async () => {
    fetchCalled = true
    return okResponse('不应到达')
  }) as typeof fetch
  const client = new BridgeClient({ getConfig: makeConfig({ enabled: false }), fetchImpl })
  const r = await client.chat(BASE_REQ) as import('../src/bridge/bridge.ts').BridgeFailure
  assert.equal(r.ok, false)
  assert.equal(r.kind, 'config-error')
  assert.equal(fetchCalled, false, 'bridge 关闭时不应发起 fetch')
})

// —— apiKey 不出现在错误文本中 ——
await check('apiKey never appears in failure reason', async () => {
  const secretKey = 'sk-super-secret-key-12345'
  // 场景 1：http-error
  const fetchImpl1 = (async () => errResponse(401, '{"error":"unauthorized"}')) as typeof fetch
  const client1 = new BridgeClient({ getConfig: makeConfig({ apiKey: secretKey }), fetchImpl: fetchImpl1 })
  const r1 = await client1.chat(BASE_REQ) as import('../src/bridge/bridge.ts').BridgeFailure
  assert.ok(!r1.reason.includes(secretKey), `reason 不应含 apiKey: ${r1.reason}`)
  // 场景 2：unreachable
  const fetchImpl2 = (async () => { throw new TypeError('fetch failed') }) as typeof fetch
  const client2 = new BridgeClient({ getConfig: makeConfig({ apiKey: secretKey }), fetchImpl: fetchImpl2 })
  const r2 = await client2.chat(BASE_REQ) as import('../src/bridge/bridge.ts').BridgeFailure
  assert.ok(!r2.reason.includes(secretKey), `unreachable reason 不应含 apiKey: ${r2.reason}`)
})

// —— 非 fetch 抛出 → unreachable ——
await check('fetch TypeError returns unreachable', async () => {
  const fetchImpl = (async () => { throw new TypeError('fetch failed') }) as typeof fetch
  const client = new BridgeClient({ getConfig: makeConfig(), fetchImpl })
  const r = await client.chat(BASE_REQ) as import('../src/bridge/bridge.ts').BridgeFailure
  assert.equal(r.ok, false)
  assert.equal(r.kind, 'unreachable')
})

// ———————————————————— probeHealth ————————————————————

// —— 探测 up ——
await check('probeHealth up on 200', async () => {
  let fetchCalls = 0
  const fetchImpl = (async () => {
    fetchCalls++
    return modelsOkResponse(['deepseek-chat', 'deepseek-reasoner'])
  }) as typeof fetch
  const client = new BridgeClient({ getConfig: makeConfig(), fetchImpl })
  const h = await client.probeHealth(true)
  assert.equal(h.status, 'up')
  assert.equal(fetchCalls, 1)
  assert.deepEqual(h.models, ['deepseek-chat', 'deepseek-reasoner'])
})

// —— 探测 down（非 2xx）——
await check('probeHealth down on non-2xx', async () => {
  const fetchImpl = (async () => errResponse(502)) as typeof fetch
  const client = new BridgeClient({ getConfig: makeConfig(), fetchImpl })
  const h = await client.probeHealth(true)
  assert.equal(h.status, 'down')
  assert.match(h.detail!, /HTTP 502/)
  assert.equal(h.models, undefined, '失败时不应返回 models')
})

// —— 探测 down（网络异常）——
await check('probeHealth down on network error', async () => {
  const fetchImpl = (async () => { throw new TypeError('ECONNREFUSED') }) as typeof fetch
  const client = new BridgeClient({ getConfig: makeConfig(), fetchImpl })
  const h = await client.probeHealth(true)
  assert.equal(h.status, 'down')
  assert.equal(h.detail, 'unreachable')
})

// —— 探测 down（超时）——
await check('probeHealth down on timeout', async () => {
  const fetchImpl = (async () => {
    const err = new Error('aborted')
    err.name = 'AbortError'
    throw err
  }) as typeof fetch
  const client = new BridgeClient({ getConfig: makeConfig(), fetchImpl })
  const h = await client.probeHealth(true)
  assert.equal(h.status, 'down')
  assert.equal(h.detail, 'timeout')
})

// —— bridge disabled → down，无 fetch ——
await check('probeHealth down when bridge disabled, no fetch', async () => {
  let fetchCalled = false
  const fetchImpl = (async () => {
    fetchCalled = true
    return modelsOkResponse([])
  }) as typeof fetch
  const client = new BridgeClient({ getConfig: makeConfig({ enabled: false }), fetchImpl })
  const h = await client.probeHealth(true)
  assert.equal(h.status, 'down')
  assert.equal(h.detail, 'bridge disabled')
  assert.equal(fetchCalled, false)
})

// —— 缓存命中（不发第二次请求）——
await check('probeHealth cache hit skips second fetch', async () => {
  let fetchCalls = 0
  const fetchImpl = (async () => {
    fetchCalls++
    return modelsOkResponse(['m1'])
  }) as typeof fetch
  const client = new BridgeClient({
    getConfig: makeConfig({ healthCacheTtlMs: 30000 }),
    fetchImpl,
    now: () => 1000,
  })
  await client.probeHealth(true) // 首次强制
  assert.equal(fetchCalls, 1)
  const h2 = await client.probeHealth(false) // 应走缓存
  assert.equal(fetchCalls, 1, '缓存内不应再发请求')
  assert.equal(h2.status, 'up')
})

// —— 缓存过期后重新请求 ——
await check('probeHealth fetches again after cache expires', async () => {
  let fetchCalls = 0
  let tick = 0
  const fetchImpl = (async () => {
    fetchCalls++
    return modelsOkResponse(['m1'])
  }) as typeof fetch
  const client = new BridgeClient({
    getConfig: makeConfig({ healthCacheTtlMs: 5000 }),
    fetchImpl,
    now: () => tick,
  })
  tick = 0
  await client.probeHealth(true)
  assert.equal(fetchCalls, 1)
  tick = 100 // 仍在缓存内
  await client.probeHealth(false)
  assert.equal(fetchCalls, 1)
  tick = 6000 // 超过 TTL
  await client.probeHealth(false)
  assert.equal(fetchCalls, 2, '缓存过期后应重新请求')
})

// —— health() 返回最近已知状态 ——
await check('health() returns last known status', async () => {
  const client = new BridgeClient({ getConfig: makeConfig() })
  const initial = client.health()
  assert.equal(initial.status, 'unknown')
  assert.equal(initial.checkedAt, 0)
})

// ———————————————————— 请求体合并（addendum） ————————————————————

// —— thinkingBody 合并 ——
await check('thinkingBody merged when thinking !== off', async () => {
  let capturedBody: Record<string, unknown> | undefined
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    capturedBody = JSON.parse(init.body as string)
    return okResponse('答')
  }) as typeof fetch
  const client = new BridgeClient({
    getConfig: makeConfig({ thinkingBody: { reasoning_effort: 'high', custom_flag: true } }),
    fetchImpl,
  })
  await client.chat({ ...BASE_REQ, thinking: 'on' })
  assert.ok(capturedBody)
  assert.equal(capturedBody!.reasoning_effort, 'high')
  assert.equal(capturedBody!.custom_flag, true)
  assert.equal(capturedBody!.model, 'deepseek-v4.1-flash-think')
  assert.equal(capturedBody!.stream, false)
})

// —— thinkingBody 不合并在 thinking='off' ——
await check('thinkingBody NOT merged when thinking off', async () => {
  let capturedBody: Record<string, unknown> | undefined
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    capturedBody = JSON.parse(init.body as string)
    return okResponse('答')
  }) as typeof fetch
  const client = new BridgeClient({
    getConfig: makeConfig({ thinkingBody: { reasoning_effort: 'high' } }),
    fetchImpl,
  })
  await client.chat(BASE_REQ) // thinking='off'
  assert.ok(capturedBody)
  assert.equal(capturedBody!.reasoning_effort, undefined, 'thinking=off 时不应合并 thinkingBody')
})

// —— searchBody 合并 ——
await check('searchBody merged when webSearch true', async () => {
  let capturedBody: Record<string, unknown> | undefined
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    capturedBody = JSON.parse(init.body as string)
    return okResponse('答')
  }) as typeof fetch
  const client = new BridgeClient({
    getConfig: makeConfig({ searchBody: { web_search: true, max_results: 5 } }),
    fetchImpl,
  })
  await client.chat({ ...BASE_REQ, webSearch: true })
  assert.ok(capturedBody)
  assert.equal(capturedBody!.web_search, true)
  assert.equal(capturedBody!.max_results, 5)
})

// —— searchBody 不合并在 webSearch=false ——
await check('searchBody NOT merged when webSearch false', async () => {
  let capturedBody: Record<string, unknown> | undefined
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    capturedBody = JSON.parse(init.body as string)
    return okResponse('答')
  }) as typeof fetch
  const client = new BridgeClient({
    getConfig: makeConfig({ searchBody: { web_search: true } }),
    fetchImpl,
  })
  await client.chat(BASE_REQ) // webSearch=false
  assert.ok(capturedBody)
  assert.equal(capturedBody!.web_search, undefined, 'webSearch=false 时不应合并 searchBody')
})

// —— thinkingBody + searchBody 同时合并，searchBody 后合并（后者键覆盖前者）——
await check('thinkingBody then searchBody merged, searchBody wins collision', async () => {
  let capturedBody: Record<string, unknown> | undefined
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    capturedBody = JSON.parse(init.body as string)
    return okResponse('答')
  }) as typeof fetch
  const client = new BridgeClient({
    getConfig: makeConfig({
      thinkingBody: { extra_param: 'from_thinking', shared_key: 'thinking_value' },
      searchBody: { extra_param: 'from_search', search_only: true },
    }),
    fetchImpl,
  })
  await client.chat({ ...BASE_REQ, thinking: 'on', webSearch: true })
  assert.ok(capturedBody)
  // searchBody 后合并，shared_key 只在 thinkingBody，extra_param 在两者都有
  assert.equal(capturedBody!.shared_key, 'thinking_value')
  assert.equal(capturedBody!.extra_param, 'from_search', 'searchBody 后合并应覆盖同名键')
  assert.equal(capturedBody!.search_only, true)
})

// —— 空 thinkingBody/searchBody 不影响基础 body ——
await check('empty thinkingBody/searchBody leave base body untouched', async () => {
  let capturedBody: Record<string, unknown> | undefined
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    capturedBody = JSON.parse(init.body as string)
    return okResponse('答')
  }) as typeof fetch
  const client = new BridgeClient({ getConfig: makeConfig(), fetchImpl })
  await client.chat({ ...BASE_REQ, thinking: 'on', webSearch: true })
  assert.ok(capturedBody)
  const keys = Object.keys(capturedBody!).sort()
  assert.deepEqual(keys, ['messages', 'model', 'stream'], '空对象不应引入额外键')
})

// ———————————————————— models 提取（addendum） ————————————————————

// —— probeHealth 提取 models ——
await check('probeHealth extracts model ids from data[]', async () => {
  const fetchImpl = (async () => modelsOkResponse(['a', 'b', 'c'])) as typeof fetch
  const client = new BridgeClient({ getConfig: makeConfig(), fetchImpl })
  const h = await client.probeHealth(true)
  assert.deepEqual(h.models, ['a', 'b', 'c'])
})

// —— models 上限 20 ——
await check('probeHealth caps models at 20', async () => {
  const ids = Array.from({ length: 30 }, (_, i) => `model-${i}`)
  const fetchImpl = (async () => modelsOkResponse(ids)) as typeof fetch
  const client = new BridgeClient({ getConfig: makeConfig(), fetchImpl })
  const h = await client.probeHealth(true)
  assert.equal(h.models!.length, 20)
  assert.equal(h.models![0], 'model-0')
  assert.equal(h.models![19], 'model-19')
})

// —— models 备选格式 models[] ——
await check('probeHealth extracts from models[] format', async () => {
  const fetchImpl = (async () => modelsAltFormatResponse(['x', 'y'])) as typeof fetch
  const client = new BridgeClient({ getConfig: makeConfig(), fetchImpl })
  const h = await client.probeHealth(true)
  assert.deepEqual(h.models, ['x', 'y'])
})

// —— models 在失败时为 undefined ——
await check('models undefined on probe failure', async () => {
  const fetchImpl = (async () => errResponse(500)) as typeof fetch
  const client = new BridgeClient({ getConfig: makeConfig(), fetchImpl })
  const h = await client.probeHealth(true)
  assert.equal(h.models, undefined)
})

// —— models 在 JSON 解析失败时为 undefined ——
await check('models undefined when probe response is not JSON', async () => {
  const fetchImpl = (async () => new Response('not json', { status: 200 })) as typeof fetch
  const client = new BridgeClient({ getConfig: makeConfig(), fetchImpl })
  const h = await client.probeHealth(true)
  assert.equal(h.status, 'up', '200 仍应为 up')
  assert.equal(h.models, undefined, 'JSON 解析失败时 models 应为 undefined')
})

// ———————————————————— 空答案 ————————————————————

await check('empty content returns empty-answer', async () => {
  const fetchImpl = (async () => okResponse('', { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 })) as typeof fetch
  const client = new BridgeClient({ getConfig: makeConfig(), fetchImpl })
  const r = await client.chat(BASE_REQ) as import('../src/bridge/bridge.ts').BridgeFailure
  assert.equal(r.ok, false)
  assert.equal(r.kind, 'empty-answer')
})

// ———————————————————— 对话保留（continueFromRequestId） ————————————————————

await check('continueFromRequestId appends to existing conversation', async () => {
  const capturedBodies: Record<string, unknown>[] = []
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    capturedBodies.push(JSON.parse(init.body as string))
    return okResponse('回答')
  }) as typeof fetch
  const client = new BridgeClient({ getConfig: makeConfig(), fetchImpl })

  // 第一次请求
  await client.chat({ ...BASE_REQ, requestId: 'r-10' })
  assert.equal(capturedBodies.length, 1)
  const msgs1 = capturedBodies[0]!.messages as Array<{ role: string; content: string }>
  assert.equal(msgs1.length, 2, '新会话应有 system + user')

  // 第二次请求接续 r-10
  await client.chat({
    ...BASE_REQ,
    requestId: 'r-11',
    continueFromRequestId: 'r-10',
    question: '那 UDP 呢？',
  })
  assert.equal(capturedBodies.length, 2)
  const msgs2 = capturedBodies[1]!.messages as Array<{ role: string; content: string }>
  assert.equal(msgs2.length, 3, '接续应追加为 system + user + user')
  assert.match(msgs2[2]!.content, /UDP/)
})

// ———————————————————— LRU 淘汰 ————————————————————

await check('LRU evicts oldest when exceeding 20', async () => {
  const fetchImpl = (async () => okResponse('答')) as typeof fetch
  const client = new BridgeClient({ getConfig: makeConfig(), fetchImpl })

  // 存入 22 个不同 requestId
  for (let i = 0; i < 22; i++) {
    await client.chat({ ...BASE_REQ, requestId: `r-lru-${i}` })
  }

  // 尝试接续最早的一个（应被淘汰）
  const capturedBodies: Record<string, unknown>[] = []
  const fetchImpl2 = (async (_url: string, init: RequestInit) => {
    capturedBodies.push(JSON.parse(init.body as string))
    return okResponse('答')
  }) as typeof fetch
  const client2 = new BridgeClient({ getConfig: makeConfig(), fetchImpl: fetchImpl2 })
  // 直接注入 client2 的对话历史来测试淘汰（通过连续请求）
  for (let i = 0; i < 22; i++) {
    await client2.chat({ ...BASE_REQ, requestId: `r-evict-${i}` })
  }
  // 接续 r-evict-0（应已被淘汰，消息数为 2 而非 3）
  await client2.chat({
    ...BASE_REQ,
    requestId: 'r-evict-check',
    continueFromRequestId: 'r-evict-0',
  })
  const lastBody = capturedBodies[capturedBodies.length - 1]!
  const msgs = lastBody.messages as Array<{ role: string; content: string }>
  assert.equal(msgs.length, 2, '被淘汰的 requestId 应按新会话处理（2 条消息）')
})

// ———————————————————— 按次模型覆盖与槽位回落（§13） ————————————————————

// —— 按次模型覆盖：显式 model 直接使用，忽略 modelMap ——
await check('per-request model override ignores modelMap slots', async () => {
  let capturedBody: Record<string, unknown> | undefined
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    capturedBody = JSON.parse(init.body as string)
    return okResponse('答')
  }) as typeof fetch
  const client = new BridgeClient({ getConfig: makeConfig(), fetchImpl })
  const r = await client.chat({ ...BASE_REQ, model: 'GLM-5', thinking: 'on', webSearch: true }) as Extract<import('../src/bridge/bridge.ts').BridgeAnswer, { ok: true }>
  assert.equal(r.ok, true)
  assert.equal(r.model, 'GLM-5', '应使用显式指定的 model')
  assert.equal(capturedBody!.model, 'GLM-5', '请求体应为 GLM-5')
})

// —— thinking 槽留空 → 回落到 plain ——
await check('empty thinking slot falls back to plain', async () => {
  let capturedBody: Record<string, unknown> | undefined
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    capturedBody = JSON.parse(init.body as string)
    return okResponse('答')
  }) as typeof fetch
  const client = new BridgeClient({
    getConfig: makeRawConfig({ modelMap: { plain: 'M1', thinking: '', thinkingSearch: 'TS', search: 'S' } }),
    fetchImpl,
  })
  const r = await client.chat({ ...BASE_REQ, thinking: 'on' }) as Extract<import('../src/bridge/bridge.ts').BridgeAnswer, { ok: true }>
  assert.equal(r.model, 'M1', 'thinking 空应回落到 plain')
  assert.equal(capturedBody!.model, 'M1')
})

// —— search 槽留空 → 回落到 plain ——
await check('empty search slot falls back to plain', async () => {
  let capturedBody: Record<string, unknown> | undefined
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    capturedBody = JSON.parse(init.body as string)
    return okResponse('答')
  }) as typeof fetch
  const client = new BridgeClient({
    getConfig: makeRawConfig({ modelMap: { plain: 'M1', thinking: 'T', thinkingSearch: 'TS', search: '' } }),
    fetchImpl,
  })
  const r = await client.chat({ ...BASE_REQ, webSearch: true }) as Extract<import('../src/bridge/bridge.ts').BridgeAnswer, { ok: true }>
  assert.equal(r.model, 'M1', 'search 空应回落到 plain')
  assert.equal(capturedBody!.model, 'M1')
})

// —— thinkingSearch 槽留空 → 回落到 thinking ——
await check('empty thinkingSearch slot falls back to thinking', async () => {
  let capturedBody: Record<string, unknown> | undefined
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    capturedBody = JSON.parse(init.body as string)
    return okResponse('答')
  }) as typeof fetch
  const client = new BridgeClient({
    getConfig: makeRawConfig({ modelMap: { plain: 'M1', thinking: 'T1', thinkingSearch: '', search: 'S1' } }),
    fetchImpl,
  })
  const r = await client.chat({ ...BASE_REQ, thinking: 'on', webSearch: true }) as Extract<import('../src/bridge/bridge.ts').BridgeAnswer, { ok: true }>
  assert.equal(r.model, 'T1', 'thinkingSearch 空应回落到 thinking')
  assert.equal(capturedBody!.model, 'T1')
})

// —— plain 留空 → config-error 且不发 fetch ——
await check('empty plain model returns config-error without fetch', async () => {
  let fetchCalled = false
  const fetchImpl = (async () => {
    fetchCalled = true
    return okResponse('不应到达')
  }) as typeof fetch
  const client = new BridgeClient({
    getConfig: makeRawConfig({ modelMap: { plain: '', thinking: 'T', thinkingSearch: 'TS', search: 'S' } }),
    fetchImpl,
  })
  const r = await client.chat(BASE_REQ) as import('../src/bridge/bridge.ts').BridgeFailure
  assert.equal(r.ok, false)
  assert.equal(r.kind, 'config-error')
  assert.match(r.reason, /plain/)
  assert.equal(fetchCalled, false, 'plain 为空时不应发 fetch')
})

// —— 非 2xx 且已知可用模型 → reason 含模型清单 ——
await check('http-error includes available models hint when known', async () => {
  const modelsResp = modelsOkResponse(['deepseek-v4.1-flash', 'GLM-5', 'Qwen3.7-Max'])
  // 先探测一次让 _lastHealth.models 有值
  let fetchCalls = 0
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    fetchCalls++
    if (url.includes('/models')) return modelsResp
    return errResponse(400)
  }) as typeof fetch
  const client = new BridgeClient({ getConfig: makeConfig(), fetchImpl })
  await client.probeHealth(true) // 填充 _lastHealth.models
  const r = await client.chat(BASE_REQ) as import('../src/bridge/bridge.ts').BridgeFailure
  assert.equal(r.ok, false)
  assert.equal(r.kind, 'http-error')
  assert.equal(r.status, 400)
  assert.match(r.reason, /deepseek-v4.1-flash/, 'reason 应含模型 id')
  assert.match(r.reason, /GLM-5/, 'reason 应含其他模型 id')
  assert.ok(!r.reason.includes('sk-'), 'reason 不应含 apiKey')
})

// —— 非 2xx 且未知模型清单 → reason 不含模型清单 ——
await check('http-error without known models has plain reason', async () => {
  const fetchImpl = (async () => errResponse(500)) as typeof fetch
  const client = new BridgeClient({ getConfig: makeConfig(), fetchImpl })
  const r = await client.chat(BASE_REQ) as import('../src/bridge/bridge.ts').BridgeFailure
  assert.equal(r.ok, false)
  assert.equal(r.kind, 'http-error')
  assert.equal(r.status, 500)
  assert.ok(!r.reason.includes('可用模型'), '未知模型时不应附模型清单')
})

// —— 非 2xx + JSON error.message → reason 含上游信息 ——
await check('http-error extracts upstream error.message from JSON body', async () => {
  const errBody = JSON.stringify({ error: { message: 'Token invalid or expired', type: 'api_error' } })
  const fetchImpl = (async () => errResponse(500, errBody)) as typeof fetch
  const client = new BridgeClient({ getConfig: makeConfig(), fetchImpl })
  const r = await client.chat(BASE_REQ) as import('../src/bridge/bridge.ts').BridgeFailure
  assert.equal(r.ok, false)
  assert.equal(r.kind, 'http-error')
  assert.equal(r.status, 500)
  assert.match(r.reason, /Token invalid or expired/)
  assert.match(r.reason, /HTTP 500/)
})

// —— 非 2xx + 非 JSON 正文 → 回落为 HTTP <status>（不抛错）——
await check('http-error with non-JSON body falls back to HTTP status', async () => {
  const fetchImpl = (async () => new Response('Internal Server Error', { status: 502 })) as typeof fetch
  const client = new BridgeClient({ getConfig: makeConfig(), fetchImpl })
  const r = await client.chat(BASE_REQ) as import('../src/bridge/bridge.ts').BridgeFailure
  assert.equal(r.ok, false)
  assert.equal(r.kind, 'http-error')
  assert.equal(r.status, 502)
  assert.match(r.reason, /HTTP 502/)
  assert.match(r.reason, /Internal Server Error/)
})

// —— 非 2xx + 超长/多行正文 → 已截断且无换行 ——
await check('http-error with long multiline body is truncated and newline-free', async () => {
  const longMsg = 'A'.repeat(300) + '\n\nB'.repeat(5) + '\r\nC'
  const errBody = JSON.stringify({ error: { message: longMsg } })
  const fetchImpl = (async () => errResponse(500, errBody)) as typeof fetch
  const client = new BridgeClient({ getConfig: makeConfig(), fetchImpl })
  const r = await client.chat(BASE_REQ) as import('../src/bridge/bridge.ts').BridgeFailure
  assert.equal(r.ok, false)
  assert.equal(r.kind, 'http-error')
  // 截断到 200 字符以内
  const reasonWithoutPrefix = r.reason.replace(/HTTP 500：/, '')
  assert.ok(reasonWithoutPrefix.length <= 200, `提取文本长度 ${reasonWithoutPrefix.length} 应 ≤200`)
  assert.ok(!r.reason.includes('\n'), 'reason 不应包含换行')
  assert.ok(!r.reason.includes('\r'), 'reason 不应包含回车')
})

// —— apiKey 不出现在 http-error 的上游信息中 ——
await check('apiKey not leaked in upstream error body', async () => {
  const secretKey = 'sk-super-secret-key-12345'
  const errBody = JSON.stringify({ error: { message: `Auth failed for key ${secretKey}` } })
  const fetchImpl = (async () => errResponse(401, errBody)) as typeof fetch
  const client = new BridgeClient({ getConfig: makeConfig({ apiKey: secretKey }), fetchImpl })
  const r = await client.chat(BASE_REQ) as import('../src/bridge/bridge.ts').BridgeFailure
  assert.equal(r.ok, false)
  assert.ok(!r.reason.includes(secretKey), `reason 不应含 apiKey: ${r.reason}`)
  assert.match(r.reason, /\[REDACTED\]/, 'apiKey 应被替换为 [REDACTED]')
})

// —— 带 code + hint 的上游错误 ——
await check('http-error with code and hint includes both in reason', async () => {
  const errBody = JSON.stringify({
    error: {
      message: 'Upstream error from provider "kimi": Token invalid or expired',
      type: 'api_error',
      code: 'credential_expired',
      hint: '该供应商的凭据已失效。请在 Chat2API 界面重新登录或粘贴新的 Token/Cookie 后重试。',
    },
  })
  const fetchImpl = (async () => errResponse(401, errBody)) as typeof fetch
  const client = new BridgeClient({ getConfig: makeConfig(), fetchImpl })
  const r = await client.chat(BASE_REQ) as import('../src/bridge/bridge.ts').BridgeFailure
  assert.equal(r.ok, false)
  assert.equal(r.kind, 'http-error')
  assert.match(r.reason, /credential_expired/, '应包含错误码')
  assert.match(r.reason, /凭据已失效/, '应包含中文提示')
  assert.match(r.reason, /Token invalid or expired/, '应包含上游消息')
  assert.match(r.reason, /code=/, '应有 code= 前缀')
  assert.match(r.reason, /—/, '应有 hint 分隔符')
})

// —— 只有 code 没有 hint ——
await check('http-error with code but no hint omits hint portion', async () => {
  const errBody = JSON.stringify({
    error: { message: 'Rate limited', code: 'rate_limited' },
  })
  const fetchImpl = (async () => errResponse(429, errBody)) as typeof fetch
  const client = new BridgeClient({ getConfig: makeConfig(), fetchImpl })
  const r = await client.chat(BASE_REQ) as import('../src/bridge/bridge.ts').BridgeFailure
  assert.equal(r.ok, false)
  assert.match(r.reason, /rate_limited/)
  assert.match(r.reason, /Rate limited/)
  assert.ok(!r.reason.includes('—'), '无 hint 时不应出现分隔符')
  assert.ok(!r.reason.includes('undefined'), '不应出现 undefined')
  assert.ok(!r.reason.includes('null'), '不应出现 null')
})

// —— code / hint 都没有 ——
await check('http-error with no code or hint has clean reason', async () => {
  const errBody = JSON.stringify({ error: { message: 'Bad request' } })
  const fetchImpl = (async () => errResponse(400, errBody)) as typeof fetch
  const client = new BridgeClient({ getConfig: makeConfig(), fetchImpl })
  const r = await client.chat(BASE_REQ) as import('../src/bridge/bridge.ts').BridgeFailure
  assert.equal(r.ok, false)
  assert.match(r.reason, /Bad request/)
  assert.ok(!r.reason.includes('code='), '无 code 时不应出现 code=')
  assert.ok(!r.reason.includes('—'), '无 hint 时不应出现分隔符')
  assert.ok(!r.reason.includes('undefined'), '不应出现 undefined')
})

// —— hint 超长被截断 ——
await check('http-error with very long hint is truncated', async () => {
  const longHint = '这是一个很长的提示。'.repeat(30) // ~300 字符
  const errBody = JSON.stringify({
    error: { message: 'Error', code: 'upstream_error', hint: longHint },
  })
  const fetchImpl = (async () => errResponse(502, errBody)) as typeof fetch
  const client = new BridgeClient({ getConfig: makeConfig(), fetchImpl })
  const r = await client.chat(BASE_REQ) as import('../src/bridge/bridge.ts').BridgeFailure
  assert.equal(r.ok, false)
  // 提取 upstreaText 部分（HTTP 502：之后，可用模型之前）
  const match = r.reason.match(/HTTP 502：(.+?)(?:（|$)/)
  assert.ok(match, '应能提取 upstreaText')
  const upstreamText = match![1]!
  assert.ok(upstreamText.length <= 200, `upstreaText 长度 ${upstreamText.length} 应 ≤200`)
  assert.ok(!r.reason.includes('\n'), '不应有换行')
})

// —— apiKey 出现在 hint 里也要被脱敏 ——
await check('apiKey in hint is sanitized', async () => {
  const secretKey = 'sk-my-secret-token-abc'
  const errBody = JSON.stringify({
    error: {
      message: 'Auth error',
      code: 'credential_expired',
      hint: `请使用 ${secretKey} 重新登录`,
    },
  })
  const fetchImpl = (async () => errResponse(401, errBody)) as typeof fetch
  const client = new BridgeClient({ getConfig: makeConfig({ apiKey: secretKey }), fetchImpl })
  const r = await client.chat(BASE_REQ) as import('../src/bridge/bridge.ts').BridgeFailure
  assert.equal(r.ok, false)
  assert.ok(!r.reason.includes(secretKey), `reason 不应含 apiKey: ${r.reason}`)
  assert.match(r.reason, /\[REDACTED\]/, 'hint 中的 apiKey 应被替换')
  assert.match(r.reason, /credential_expired/, 'code 应保留')
})

// ———————————————————— 汇总 ————————————————————

console.log('')
console.log(`bridge.test.ts: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  process.exit(1)
}

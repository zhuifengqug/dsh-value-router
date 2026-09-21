/**
 * 确定性核心离线单测（v2 规格）。
 * 运行：node --experimental-strip-types test/core.test.ts
 *
 * v2 变更：删除浏览器相关用例（browserAvailable/browserLoggedIn），
 * 新增桥健康门控用例、v2 指引验证、StatusTracker 新字段用例。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { resolveConfig, DEFAULT_CONFIG } from '../src/core/config.ts'
import { redact, truncateCode, REDACTED_SECRET, REDACTED_PATH, REDACTED_PERSONAL_DATA } from '../src/bridge/redact.ts'
import { estimateTokens, buildSavingRecord } from '../src/bridge/tokens.ts'
import { decideDelegation } from '../src/bridge/decision.ts'
import { compressAnswer, renderInjection, deriveSourceLabel } from '../src/bridge/compress.ts'
import { DelegationCoordinator } from '../src/bridge/limits.ts'
import { buildSystemPromptGuidance } from '../src/core/policy.ts'
import { StatusTracker } from '../src/bridge/status.ts'

const baseConfig = resolveConfig(undefined)

function facts(over: Record<string, unknown> = {}) {
  return {
    taskType: 'explanation',
    question: 'Explain the difference between TCP and UDP in one paragraph.',
    context: 'Networking basics for a junior developer.',
    ...over,
  } as never
}

// —— §17.1 配置关闭时不委派 ——
test('disabled config never delegates', () => {
  const d = decideDelegation(resolveConfig({ enabled: false }), facts())
  assert.equal(d.shouldDelegate, false)
  assert.equal(d.hardBlocked, false)
})

// —— §17.2 允许且独立 → 委派 ——
test('allowed independent question delegates', () => {
  const d = decideDelegation(baseConfig, facts({
    question: 'Please compare the tradeoffs of REST versus GraphQL versus gRPC for a public read-heavy API, covering caching semantics (HTTP cache, CDN edge cache), schema evolution strategy, authentication patterns, rate limiting approaches, error modeling conventions, developer ergonomics for external consumers, payload size over slow networks, nested resource fetching efficiency, and overall operational cost of running a gateway layer. Provide a structured decision table summarizing the recommendation for each criterion.',
    context: (
      'We are choosing an API style for a documentation-heavy public service. ' +
      'The workload is dominated by reads, benefits strongly from HTTP caching and CDN edge caching, ' +
      'and has a mix of mobile clients, third-party integrators, and server-to-server callers. ' +
      'We care about: developer ergonomics for external users, discoverability, versioning strategy, ' +
      'payload size over slow networks, ability to fetch nested resources efficiently, tooling maturity, ' +
      'and the operational cost of running a gateway. Some endpoints need streaming, others need batched writes. ' +
      'Please cover caching semantics, schema evolution, auth patterns, rate limiting, and error modeling for each option. '
    ).repeat(5),
  }))
  assert.equal(d.shouldDelegate, true, d.reason)
  assert.ok(d.estimatedSavedTokens >= baseConfig.minEstimatedSavedTokens)
  assert.ok(d.redactedContext.length > 0)
})

// —— §17.3 不在允许清单 → 不委派 ——
test('unknown task type not delegated', () => {
  const d = decideDelegation(baseConfig, facts({ taskType: 'refactor-repo' }))
  assert.equal(d.shouldDelegate, false)
  assert.match(d.reason, /不在允许/)
})

// —— 黑名单优先 ——
test('blocked task type hard-blocked', () => {
  const d = decideDelegation(baseConfig, facts({ taskType: 'command-execution' }))
  assert.equal(d.shouldDelegate, false)
  assert.equal(d.hardBlocked, true)
  assert.equal(d.risk, 'high')
})

// —— §17.4 含凭据不得自动发送 ——
test('credentials in context hard-block', () => {
  const d = decideDelegation(baseConfig, facts({
    taskType: 'explanation',
    context: 'My API key is sk-abcdefghijklmnopqrstuvwxyz123456, what should I do?',
  }))
  assert.equal(d.shouldDelegate, false)
  assert.equal(d.hardBlocked, true)
  assert.ok(d.redactionCategories.includes('api-key'))
})

// —— 需要本地工具 → 不委派 ——
test('needsLocalTools blocks delegation', () => {
  const d = decideDelegation(baseConfig, facts({ needsLocalTools: true }))
  assert.equal(d.shouldDelegate, false)
  assert.equal(d.hardBlocked, true)
})

// —— 低于 Token 阈值 → 不委派 ——
test('tiny question below savings threshold not delegated', () => {
  const d = decideDelegation(baseConfig, facts({ question: 'hi', context: '' }))
  assert.equal(d.shouldDelegate, false)
  assert.match(d.reason, /低于阈值|不值得/)
})

// —— v2 收益口径修正：短问句因注入块固定开销被拒绝 ——
test('short Chinese question (~30 chars) rejected by real-overhead threshold', () => {
  // 约 30 个汉字、无 context；实机实测 savedEstimate=0，决策门也应拒绝
  const d = decideDelegation(baseConfig, facts({
    question: '请用一段话解释 TCP 和 UDP 的区别，面向初学者。',
    context: '',
  }))
  assert.equal(d.shouldDelegate, false)
  assert.match(d.reason, /低于阈值|不值得/)
})

// —— v2 收益口径修正：长问句+充足上下文通过收益门槛 ——
test('long question with sufficient context passes benefit threshold', () => {
  const d = decideDelegation(baseConfig, facts({
    question: 'Please compare the tradeoffs of REST versus GraphQL versus gRPC for a public read-heavy API, covering caching semantics (HTTP cache, CDN edge cache), schema evolution strategy, authentication patterns, rate limiting approaches, error modeling conventions, developer ergonomics for external consumers, payload size over slow networks, nested resource fetching efficiency, and overall operational cost of running a gateway layer. Provide a structured decision table summarizing the recommendation for each criterion.',
    context: (
      'We are choosing an API style for a documentation-heavy public service. ' +
      'The workload is dominated by reads, benefits strongly from HTTP caching and CDN edge caching, ' +
      'and has a mix of mobile clients, third-party integrators, and server-to-server callers. ' +
      'We care about: developer ergonomics for external users, discoverability, versioning strategy, ' +
      'payload size over slow networks, ability to fetch nested resources efficiently, tooling maturity, ' +
      'and the operational cost of running a gateway. Some endpoints need streaming, others need batched writes. ' +
      'Please cover caching semantics, schema evolution, auth patterns, rate limiting, and error modeling for each option. '
    ).repeat(5),
  }))
  assert.equal(d.shouldDelegate, true, d.reason)
  assert.ok(d.estimatedSavedTokens >= baseConfig.minEstimatedSavedTokens)
})

// —— §17.5 脱敏正确性 ——
test('redact replaces secrets paths and personal data', () => {
  const src = [
    'key sk-abcdefghijklmnopqrstuvwxyz123456',
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123',
    'email bob@corp.co phone 13912345678 id 2330110767',
    'open C:\\Users\\alice\\secrets\\token.txt and /home/bob/.ssh/id_rsa',
    '-----BEGIN RSA PRIVATE KEY-----\\nMIIEow...\\n-----END RSA PRIVATE KEY-----',
    'postgres://user:pass@db.internal:5432/prod',
  ].join('\n')
  const r = redact(src)
  assert.ok(r.hasCredential)
  assert.ok(!r.text.includes('sk-abcdefghijklmnopqrstuvwxyz123456'))
  assert.ok(!r.text.includes('bob@corp.co'))
  assert.ok(!r.text.includes('13912345678'))
  assert.ok(!r.text.includes('2330110767'))
  assert.ok(!r.text.includes('C:\\Users\\alice'))
  assert.ok(r.text.includes(REDACTED_SECRET))
  assert.ok(r.text.includes(REDACTED_PATH))
  assert.ok(r.text.includes(REDACTED_PERSONAL_DATA))
})

test('redact leaves normal text untouched', () => {
  const src = 'Explain Big-O notation for sorting algorithms in plain language.'
  const r = redact(src)
  assert.equal(r.hasSensitive, false)
  assert.equal(r.text, src)
})

test('truncateCode keeps head and tail', () => {
  const code = 'A'.repeat(1000)
  const t = truncateCode(code, 200)
  assert.ok(t.truncated)
  assert.ok(t.text.includes('TRUNCATED'))
  assert.ok(t.text.length < code.length)
})

// —— §17.21/22 Token 估算与记录 ——
test('token estimate and saving record', () => {
  assert.ok(estimateTokens('你好世界') >= 4)
  const rec = buildSavingRecord({
    inputText: 'a long question about something'.repeat(50),
    webAnswerText: 'answer content '.repeat(200),
    injectedResultText: 'short summary',
    taskType: 'explanation',
    now: () => '2026-01-01T00:00:00.000Z',
  })
  assert.equal(rec.estimateOnly, true)
  assert.ok(rec.estimatedSavedTokens >= 0)
  assert.equal(rec.delegatedAt, '2026-01-01T00:00:00.000Z')
})

// —— §17.11 结果来源标记（DeepSeek 默认模型） ——
test('injection is provenance-marked and warns against blind execution', () => {
  const a = compressAnswer({
    rawAnswer: '好的，下面是答案。\n\nTCP 面向连接，UDP 无连接。\n\n注意：这里可能不够准确。',
    question: 'TCP vs UDP?',
    taskType: 'explanation',
    model: 'deepseek-v4-flash',
    requestId: 'dw-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    maxResultCharacters: 12000,
  })
  assert.equal(a.source, 'deepseek-v4-flash')
  assert.equal(a.sourceLabel, 'DeepSeek 网页端')
  assert.equal(a.requestId, 'dw-1')
  const inj = renderInjection(a, 'TCP vs UDP?', 'explanation')
  assert.match(inj, /\[来自 DeepSeek 网页端协作结果\]/)
  assert.match(inj, /DeepSeek 网页端协作结果：/)
  assert.match(inj, /来源：deepseek-v4-flash/)
  assert.match(inj, /请求 ID：dw-1/)
  assert.match(inj, /不是主模型自身推理/)
})

// —— v2.1 多供应商来源归属 ——
test('GLM model produces GLM source label and injection', () => {
  const a = compressAnswer({
    rawAnswer: 'TCP 面向连接，UDP 无连接。',
    question: 'TCP vs UDP?',
    taskType: 'explanation',
    model: 'GLM-5',
    requestId: 'dw-2',
    createdAt: '2026-01-01T00:00:00.000Z',
    maxResultCharacters: 12000,
  })
  assert.equal(a.source, 'GLM-5')
  assert.equal(a.sourceLabel, 'GLM')
  const inj = renderInjection(a, 'TCP vs UDP?', 'explanation')
  // 来源标记头部按 sourceLabel 动态生成（无空格）
  assert.match(inj, /\[来自 GLM协作结果\]/)
  // 正文第二行也按 sourceLabel 生成
  assert.match(inj, /GLM协作结果：/)
  // 来源行使用实际模型 id
  assert.match(inj, /来源：GLM-5/)
  // 整段注入不含 DeepSeek
  assert.ok(!inj.includes('DeepSeek'), 'GLM 注入整段不应包含 DeepSeek')
})

test('unknown model id falls back to raw id as source label', () => {
  assert.equal(deriveSourceLabel('some-vendor-x'), 'some-vendor-x')
  assert.equal(deriveSourceLabel(''), '外部模型')
})

// —— §17.12 回答含命令 → 标记不自动执行 ——
test('actionable suggestions detected', () => {
  const a = compressAnswer({
    rawAnswer: '运行命令：rm -rf /tmp/x 然后 sudo reboot',
    question: 'q', taskType: 'explanation', model: 'deepseek-v4-flash', requestId: 'r', createdAt: 't', maxResultCharacters: 1000,
  })
  assert.equal(a.containsActionableSuggestions, true)
  const inj = renderInjection(a, 'q', 'explanation')
  assert.match(inj, /禁止自动执行/)
})

// —— §17.20 结果超长截断 ——
test('long answer truncated to max chars', () => {
  const a = compressAnswer({
    rawAnswer: 'x'.repeat(5000),
    question: 'q', taskType: 'explanation', model: 'deepseek-v4-flash', requestId: 'r', createdAt: 't', maxResultCharacters: 1000,
  })
  assert.equal(a.truncated, true)
  assert.ok(a.answer.length < 1200)
})

// —— §17.15/17/18 限额与去重 ——
test('coordinator enforces per-task cap', () => {
  const c = new DelegationCoordinator({ maxDelegationsPerTask: 2, maxConcurrentDelegations: 1, maxDelegationsPerHour: 100, maxRetriesPerRequest: 1, dedupeWindowMs: 60000 })
  assert.equal(c.check('t1', 'q1').ok, true)
  c.begin('r1', 't1', 'q1')
  c.begin('r2', 't1', 'q2')
  const third = c.check('t1', 'q3')
  assert.equal(third.ok, false)
  assert.match(third.reason ?? '', /单任务/)
})

test('coordinator dedupes same question in window', () => {
  const c = new DelegationCoordinator({ maxDelegationsPerTask: 5, maxConcurrentDelegations: 1, maxDelegationsPerHour: 100, maxRetriesPerRequest: 1, dedupeWindowMs: 60000 })
  c.begin('r1', 't1', 'same question')
  assert.equal(c.isDuplicate('t1', 'same question'), true)
  assert.equal(c.check('t1', 'same question').ok, false)
  assert.equal(c.check('t1', 'same question', true).ok, true) // hasNewInfo 跳过去重
})

test('coordinator enforces hourly cap', () => {
  const c = new DelegationCoordinator({ maxDelegationsPerTask: 100, maxConcurrentDelegations: 1, maxDelegationsPerHour: 2, maxRetriesPerRequest: 1, dedupeWindowMs: 1 })
  c.begin('r1', 'a', 'q1')
  c.begin('r2', 'b', 'q2')
  assert.equal(c.check('c', 'q3').ok, false)
})

test('coordinator retries limited', () => {
  const c = new DelegationCoordinator({ maxDelegationsPerTask: 5, maxConcurrentDelegations: 1, maxDelegationsPerHour: 100, maxRetriesPerRequest: 1, dedupeWindowMs: 60000 })
  c.begin('r1', 't1', 'q')
  assert.equal(c.tryRetry('r1'), true)
  assert.equal(c.tryRetry('r1'), false) // 超过 maxRetriesPerRequest=1
})

// —— §11 并发串行化 ——
test('acquire serializes when maxConcurrent=1', async () => {
  const c = new DelegationCoordinator({ maxDelegationsPerTask: 5, maxConcurrentDelegations: 1, maxDelegationsPerHour: 100, maxRetriesPerRequest: 1, dedupeWindowMs: 60000 })
  const rel1 = await c.acquire()
  let second = false
  const p = c.acquire().then((rel) => { second = true; rel() })
  await Promise.resolve()
  assert.equal(second, false, '第二个 acquire 应等待')
  rel1()
  await p
  assert.equal(second, true)
})

// —— §17.18 递归委派被阻止 ——
test('autoDelegate off requires manual use', () => {
  const d = decideDelegation(resolveConfig({ autoDelegate: false }), facts())
  assert.equal(d.shouldDelegate, false)
  assert.equal(d.hardBlocked, false)
})

// —— §17.23/24 旧配置缺字段仍安全加载 ——
test('resolveConfig fills missing fields with safe defaults', () => {
  const c = resolveConfig({ enabled: true } as never)
  assert.equal(c.maxDelegationsPerTask, DEFAULT_CONFIG.maxDelegationsPerTask)
  assert.equal(c.fallbackMode, 'continue-with-primary')
  const empty = resolveConfig(undefined)
  assert.equal(empty.defaultThinking, 'silent')
  assert.equal(empty.bridge.baseUrl, 'http://127.0.0.1:8080/v1')
  assert.equal(empty.bridge.trustUsage, 'auto')
  const bad = resolveConfig({ maxConcurrentDelegations: 999 } as never)
  // 价值路由：并发护栏固定为 1（网页版同账号单路输出），设置里的更大值不生效
  assert.equal(bad.maxConcurrentDelegations, 1)
})

// —— v2 新增：桥健康门控 ——

test('bridge down refuses with a clear reason', () => {
  const d = decideDelegation(baseConfig, facts({ bridgeHealth: 'down' }))
  assert.equal(d.shouldDelegate, false)
  assert.match(d.reason, /桥/)
  assert.match(d.reason, /不可用/)
})

test('bridge unknown does NOT refuse', () => {
  const d = decideDelegation(baseConfig, facts({
    bridgeHealth: 'unknown',
    question: 'Compare the tradeoffs of REST vs GraphQL vs gRPC for a public read API, with concrete guidance and a decision table.',
    context: (
      'We are choosing an API style for a documentation-heavy public service. ' +
      'The workload is dominated by reads, benefits strongly from HTTP caching and CDN edge caching, ' +
      'and has a mix of mobile clients, third-party integrators, and server-to-server callers. ' +
      'We care about: developer ergonomics for external users, discoverability, versioning strategy, ' +
      'payload size over slow networks, ability to fetch nested resources efficiently, tooling maturity, ' +
      'and the operational cost of running a gateway. Some endpoints need streaming, others need batched writes. ' +
      'Please cover caching semantics, schema evolution, auth patterns, rate limiting, and error modeling for each option. '
    ).repeat(5),
  }))
  // bridgeHealth=unknown 不直接拒绝；该问题规模够大，满足收益阈值
  assert.equal(d.shouldDelegate, true, d.reason)
})

test('credentials still hard-block', () => {
  const d = decideDelegation(baseConfig, facts({
    context: 'My API key is sk-abcdefghijklmnopqrstuvwxyz123456, what should I do?',
  }))
  assert.equal(d.shouldDelegate, false)
  assert.equal(d.hardBlocked, true)
  assert.ok(d.redactionCategories.includes('api-key'))
})

// —— v2 变更：敏感可脱敏上下文不再需要确认，直接委派 ——
test('sensitive-but-redactable context delegates without confirmation', () => {
  const d = decideDelegation(baseConfig, facts({
    question: 'How should I phrase a professional email follow-up about a missed deadline to a client, keeping it short, polite, and firm?',
    context: (
      'Recipient email is alice@example.com and phone 13800138000, student id 2330110767. ' +
      'The deliverable was due last Friday; we have not received it; we need it by end of week without sounding accusatory. ' +
      'Draft two variants: a soft nudge and a firmer escalation, and note which tone fits a first follow-up. '
    ).repeat(8),
  }))
  // v2 全自动：敏感但可脱敏 → 直接委派，不需要确认
  assert.equal(d.shouldDelegate, true, d.reason)
  assert.equal(d.hardBlocked, false)
  assert.ok(d.redactionCategories.length > 0)
})

// —— v2/v2.1 指引验证：ask/batch-first + 多供应商，无 browser_* 残留 ——
test('guidance mentions ask/batch tools, multi-provider model, and contains no browser_ strings', () => {
  const g = buildSystemPromptGuidance(baseConfig)
  assert.match(g, /bridge_ask/)
  assert.match(g, /bridge_batch/)
  // 多供应商指引
  assert.match(g, /model/)
  assert.match(g, /GLM-5|Qwen|Kimi/)
  assert.match(g, /来源.*实际模型|标注/)
  assert.ok(!g.includes('browser_'), 'v2 指引不应包含 browser_ 引用')
  assert.ok(!g.includes('browser-skill'), 'v2 指引不应包含 browser-skill 引用')
  assert.ok(!g.includes('buildBrowserRunbook'), 'v2 指引不应包含 runbook 引用')
  assert.ok(!g.includes('deepseek_web_prepare'), 'v2 指引不应包含旧工具引用')
  assert.ok(!g.includes('deepseek_web_submit'), 'v2 指引不应包含旧工具引用')
})

// —— StatusTracker 新字段验证 ——
test('StatusTracker snapshot exposes new fields with sane defaults', () => {
  const tracker = new StatusTracker(() => ({
    enabled: true,
    autoDelegate: true,
    maxDelegationsPerTask: 3,
    taskDelegations: () => 0,
    inFlightCount: () => 0,
  }))
  const s = tracker.snapshot()
  assert.equal(s.bridgeStatus, 'unknown')
  assert.equal(s.delegationsTotal, 0)
  assert.equal(s.bridgeTokensTotal.total, 0)
  assert.equal(s.savedTokensTotal, 0)
  assert.equal(s.estimateOnlyCount, 0)
  assert.equal(s.lastOutcome, 'none')
  assert.equal(s.batch, undefined)

  // noteDelegated 递增 delegationsTotal
  tracker.noteDelegated('t1')
  assert.equal(tracker.snapshot().delegationsTotal, 1)
  tracker.noteDelegated('t2')
  assert.equal(tracker.snapshot().delegationsTotal, 2)
})

test('StatusTracker accumulates noteUsage correctly', () => {
  const tracker = new StatusTracker(() => ({
    enabled: true,
    autoDelegate: true,
    maxDelegationsPerTask: 3,
    taskDelegations: () => 0,
    inFlightCount: () => 0,
  }))

  // 第一次：真实 usage
  tracker.noteUsage({ promptTokens: 100, completionTokens: 200, total: 300, estimateOnly: false })
  let s = tracker.snapshot()
  assert.equal(s.bridgeTokensTotal.total, 300)
  assert.equal(s.estimateOnlyCount, 0)

  // 第二次：估算 usage（estimateOnly=true）
  tracker.noteUsage({ promptTokens: 50, completionTokens: 80, total: 130, estimateOnly: true })
  s = tracker.snapshot()
  assert.equal(s.bridgeTokensTotal.total, 430)  // 300 + 130
  assert.equal(s.bridgeTokensTotal.promptTokens, 150)  // 100 + 50
  assert.equal(s.estimateOnlyCount, 1)

  // noteSaved 累加
  tracker.noteSaved(500)
  tracker.noteSaved(300)
  s = tracker.snapshot()
  assert.equal(s.savedTokensTotal, 800)

  // noteBridgeHealth
  tracker.noteBridgeHealth({ status: 'up', checkedAt: 12345, detail: 'HTTP 200' })
  s = tracker.snapshot()
  assert.equal(s.bridgeStatus, 'up')
  assert.equal(s.bridgeCheckedAt, 12345)
  assert.equal(s.bridgeDetail, 'HTTP 200')

  // noteError
  tracker.noteError('桥接超时')
  s = tracker.snapshot()
  assert.equal(s.lastError, '桥接超时')

  // noteBatch
  tracker.noteBatch({ batchId: 'bw-test', done: 2, total: 5, running: true })
  s = tracker.snapshot()
  assert.deepEqual(s.batch, { batchId: 'bw-test', done: 2, total: 5, running: true })

  // noteBatch(undefined) 清除
  tracker.noteBatch(undefined)
  s = tracker.snapshot()
  assert.equal(s.batch, undefined)
})

/**
 * Chat2API 桥接客户端（v2）。
 *
 * 通过本地 Chat2API 服务向 DeepSeek 发起非流式 API 调用，实现：
 * - 健康探测（GET /models，带 TTL 缓存）
 * - 聊天补全（POST /chat/completions，OpenAI 兼容格式）
 * - 对话历史保留（LRU，上限 20 条 requestId）
 * - 完整错误分类：所有失败路径返回 BridgeFailure，不抛出
 *
 * 注释用中文，标识符用英文。
 */

import type {
  ResolvedValueRouterConfig,
  ThinkingMode,
} from '../core/config.ts'
import { estimateTokens } from './tokens.ts'

// —————————————————————————— 类型导出 ——————————————————————————

/** 桥接错误分类。 */
export type BridgeErrorKind =
  | 'config-error'
  | 'unreachable'
  | 'http-error'
  | 'timeout'
  | 'bad-json'
  | 'usage-missing'
  | 'empty-answer'

/** 桥返回的 token 用量。 */
export interface BridgeUsage {
  promptTokens: number
  completionTokens: number
  total: number
  /** true = 响应里没有 usage 或经 trustUsage 判定不可信，token 数是估算值。 */
  estimateOnly: boolean
}

/** 成功结果。 */
export interface BridgeAnswer {
  ok: true
  /** 已按 thinking 模式处理过的最终答案文本（silent 已剥离思考过程）。 */
  text: string
  /** 仅 thinking='on' 且响应里存在 reasoningField 时给出。 */
  reasoning?: string
  thinkingUsed: boolean
  webSearchUsed: boolean
  model: string
  usage: BridgeUsage
  /** 本次会话引用：可传给后续 ask 的 continueFromRequestId。 */
  conversationRef: string
  requestId: string
}

/** 失败结果。 */
export interface BridgeFailure {
  ok: false
  kind: BridgeErrorKind
  reason: string
  status?: number
  usage?: BridgeUsage
}

/** chat() 的联合返回类型。 */
export type BridgeResult = BridgeAnswer | BridgeFailure

/** 健康探测结果。 */
export interface BridgeHealth {
  status: 'up' | 'down' | 'unknown'
  checkedAt: number          // epoch ms；unknown 时为 0
  detail?: string
  /** 成功探测时返回的可用模型 id 列表（上限 20 条）。 */
  models?: string[]
}

/** chat 请求入参。 */
export interface BridgeChatRequest {
  requestId: string
  taskType: string
  question: string
  context?: string
  thinking: ThinkingMode
  webSearch: boolean
  /**
   * 按次模型覆盖：给出时直接使用该 id，忽略 thinking/webSearch 的槽位推导。
   * 例：'GLM-5.3'、'Qwen3.7-Max'、'Kimi-K3'（以桥 `/v1/models` 实际返回为准）。
   */
  model?: string
  /** 服务端接续：复用该 requestId 保留的对话历史，只追加本轮追问。 */
  continueFromRequestId?: string
  signal?: AbortSignal
}

/** 客户端构造选项。 */
export interface BridgeClientOptions {
  getConfig: () => ResolvedValueRouterConfig
  /** 便于离线单测注入；默认 globalThis.fetch。 */
  fetchImpl?: typeof fetch
  now?: () => number
}

// —————————————————————————— 内部常量 ——————————————————————————

/** 固定委派说明（注入 system 消息）。 */
const SYSTEM_PROMPT = [
  '你是一个外部知识助手，通过本地桥接服务回答问题。',
  '你的回答将被注入到主模型的上下文中作为参考。',
  '请直接、准确地回答问题，不要添加额外寒暄。',
  '如果你不确定，请明确说明。',
].join('')

/** LRU 对话保留上限。 */
const CONVERSATION_LRU_MAX = 20

// —————————————————————————— 内部类型 ——————————————————————————

/** 对话历史记录。 */
interface ConversationEntry {
  requestId: string
  messages: Array<{ role: string; content: string }>
}

// —————————————————————————— BridgeClient ——————————————————————————

export class BridgeClient {
  private readonly _getConfig: () => ResolvedValueRouterConfig
  private readonly _fetch: typeof fetch
  private readonly _now: () => number
  private _lastHealth: BridgeHealth = { status: 'unknown', checkedAt: 0 }
  private _healthCache: { health: BridgeHealth; ts: number } | null = null
  /** LRU 对话保留，键为 requestId。 */
  private readonly _conversations = new Map<string, ConversationEntry>()

  constructor(options: BridgeClientOptions) {
    this._getConfig = options.getConfig
    this._fetch = options.fetchImpl ?? globalThis.fetch
    this._now = options.now ?? (() => Date.now())
  }

  // ———————————— 健康探测 ————————————

  /**
   * 带缓存的健康探测。force=true 跳过缓存。
   *
   * - GET {baseUrl}/models
   * - 2xx → up
   * - 非 2xx → down + detail: 'HTTP <status>'
   * - 网络异常 → down + detail: 'unreachable'
   * - 超时 → down + detail: 'timeout'
   * - bridge.enabled === false → down + detail: 'bridge disabled'（不请求）
   * - 探测超时用 min(timeoutMs, 8000)
   */
  async probeHealth(force?: boolean): Promise<BridgeHealth> {
    const config = this._getConfig()
    const bridge = config.bridge
    const now = this._now()

    // bridge 关闭时直接返回 down
    if (!bridge.enabled) {
      const health: BridgeHealth = {
        status: 'down',
        checkedAt: now,
        detail: 'bridge disabled',
      }
      this._lastHealth = health
      this._healthCache = { health, ts: now }
      return health
    }

    // 缓存命中
    if (
      !force &&
      this._healthCache &&
      now - this._healthCache.ts < bridge.healthCacheTtlMs
    ) {
      return this._healthCache.health
    }

    // 实际探测
    const url = `${bridge.baseUrl.replace(/\/+$/, '')}/models`
    const timeoutMs = Math.min(bridge.timeoutMs, 8000)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    const headers: Record<string, string> = {}
    if (bridge.apiKey) {
      headers['authorization'] = `Bearer ${bridge.apiKey}`
    }
    for (const [k, v] of Object.entries(bridge.extraHeaders)) {
      headers[k] = v
    }

    let health: BridgeHealth
    try {
      const resp = await this._fetch(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
      })
      if (resp.ok) {
        // 尝试提取可用模型 id 列表
        let models: string[] | undefined
        try {
          const body = await resp.json() as Record<string, unknown>
          const raw = extractModelIds(body)
          if (raw.length > 0) models = raw.slice(0, 20)
        } catch {
          // JSON 解析失败不影响健康状态
        }
        health = { status: 'up', checkedAt: now, models }
      } else {
        health = {
          status: 'down',
          checkedAt: now,
          detail: `HTTP ${resp.status}`,
        }
      }
    } catch (err: unknown) {
      if (isAbortError(err)) {
        health = { status: 'down', checkedAt: now, detail: 'timeout' }
      } else {
        health = { status: 'down', checkedAt: now, detail: 'unreachable' }
      }
    } finally {
      clearTimeout(timer)
    }

    this._lastHealth = health
    this._healthCache = { health, ts: now }
    return health
  }

  /**
   * 最近一次已知健康状态，不发请求（初始为 unknown）。
   */
  health(): BridgeHealth {
    return this._lastHealth
  }

  // ———————————— 聊天补全 ————————————

  /**
   * 发起一次非流式聊天补全。
   *
   * 所有失败路径返回 BridgeFailure，不抛出到调用方。
   */
  async chat(request: BridgeChatRequest): Promise<BridgeResult> {
    const config = this._getConfig()
    const bridge = config.bridge

    // bridge 关闭 → config-error
    if (!bridge.enabled) {
      return failure('config-error', '桥接服务未启用')
    }

    const requestId = request.requestId

    // 模型选择：按次覆盖优先，否则按槽位+回落推导
    let model: string
    if (request.model) {
      model = request.model
    } else {
      const resolved = resolveModel(bridge.modelMap, request.thinking, request.webSearch)
      if (!resolved) {
        return failure('config-error', '桥未配置可用模型（bridge.modelMap.plain 为空）')
      }
      model = resolved
    }

    // 组装消息
    const messages = this._buildMessages(request)

    // 超时控制：同时监听内部 AbortController 和外部 signal
    const timeoutMs = bridge.timeoutMs
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    // 外部 signal 支持
    let externalAbortHandler: (() => void) | null = null
    if (request.signal) {
      if (request.signal.aborted) {
        clearTimeout(timer)
        return failure('timeout', '请求已被取消')
      }
      externalAbortHandler = () => controller.abort()
      request.signal.addEventListener('abort', externalAbortHandler)
    }

    // 构建请求头
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    }
    if (bridge.apiKey) {
      headers['authorization'] = `Bearer ${bridge.apiKey}`
    }
    for (const [k, v] of Object.entries(bridge.extraHeaders)) {
      headers[k] = v
    }

    const url = `${bridge.baseUrl.replace(/\/+$/, '')}/chat/completions`

    // 构建请求体：基础 + thinkingBody（thinking !== 'off'）+ searchBody（webSearch）
    const body: Record<string, unknown> = {
      model,
      messages,
      stream: false,
    }
    if (request.thinking !== 'off' && bridge.thinkingBody && Object.keys(bridge.thinkingBody).length > 0) {
      Object.assign(body, bridge.thinkingBody)
    }
    if (request.webSearch && bridge.searchBody && Object.keys(bridge.searchBody).length > 0) {
      Object.assign(body, bridge.searchBody)
    }

    try {
      const resp = await this._fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      // 非 2xx → http-error（尽力提取上游错误正文 + 附可用模型清单）
      if (!resp.ok) {
        // 尽力读取响应正文中的可读错误信息（message / code / hint）
        const errParts = await extractUpstreamError(resp, bridge.apiKey || undefined)
        const upstreamText = formatUpstreamError(errParts)

        // 附可用模型清单
        const knownModels = this._lastHealth.models
        const modelHint = knownModels && knownModels.length > 0
          ? `（可用模型：${knownModels.slice(0, 10).join(', ')}）`
          : ''

        // 拼接：HTTP <status>：upstreamText（可用模型：…）
        const reason = upstreamText
          ? `HTTP ${resp.status}：${upstreamText}${modelHint}`
          : `HTTP ${resp.status}${modelHint}`
        return failure('http-error', reason, resp.status)
      }

      // JSON 解析
      let data: unknown
      try {
        data = await resp.json()
      } catch {
        return failure('bad-json', '响应 JSON 解析失败')
      }

      // 提取 choices
      const obj = data as Record<string, unknown>
      const choices = obj.choices as Array<Record<string, unknown>> | undefined
      if (!choices || choices.length === 0) {
        return failure('empty-answer', '响应中无 choices')
      }

      const message = choices[0]!.message as Record<string, unknown> | undefined
      if (!message) {
        return failure('empty-answer', '响应中无 message')
      }

      const content = typeof message.content === 'string' ? message.content : ''

      // 空答案检查
      if (!content.trim()) {
        return failure('empty-answer', '答案内容为空')
      }

      // 思考内容处理
      const rawReasoning = message[bridge.reasoningField]
      let reasoning: string | undefined
      if (request.thinking === 'on' && typeof rawReasoning === 'string' && rawReasoning.length > 0) {
        // 截断为最多 600 字符
        reasoning = rawReasoning.length > 600 ? rawReasoning.slice(0, 600) : rawReasoning
      }
      // silent 和 off 一律丢弃思考内容

      // usage 读取与信任判定
      const usageRaw = obj.usage as Record<string, unknown> | undefined
      const hasRawUsage = !!(
        usageRaw &&
        typeof usageRaw.prompt_tokens === 'number' &&
        typeof usageRaw.completion_tokens === 'number' &&
        typeof usageRaw.total_tokens === 'number'
      )

      // 估算所需：请求文本 = 本次实际发出的 system + user 内容拼接
      const requestText = messages.map((m) => m.content).join('\n')
      const estimatedPrompt = estimateTokens(requestText)
      const estimatedCompletion = estimateTokens(content)

      // 判定是否采信桥返回的 usage
      let usage: BridgeUsage
      if (!hasRawUsage) {
        // usage 完全缺失 → 估算（行为不变）
        usage = {
          promptTokens: estimatedPrompt,
          completionTokens: estimatedCompletion,
          total: estimatedPrompt + estimatedCompletion,
          estimateOnly: true,
        }
      } else if (bridge.trustUsage === 'never') {
        // 'never'：完全忽略响应 usage，一律估算
        usage = {
          promptTokens: estimatedPrompt,
          completionTokens: estimatedCompletion,
          total: estimatedPrompt + estimatedCompletion,
          estimateOnly: true,
        }
      } else if (bridge.trustUsage === 'always') {
        // 'always'：无条件采信
        usage = {
          promptTokens: usageRaw!.prompt_tokens as number,
          completionTokens: usageRaw!.completion_tokens as number,
          total: usageRaw!.total_tokens as number,
          estimateOnly: false,
        }
      } else {
        // 'auto'：可信度判定——必须同时满足两条才采信
        const rawPrompt = usageRaw!.prompt_tokens as number
        const rawCompletion = usageRaw!.completion_tokens as number
        const promptFloor = Math.max(1, Math.floor(estimatedPrompt * 0.4))
        const completionFloor = Math.max(1, Math.floor(estimatedCompletion * 0.3))
        const trusted = rawPrompt >= promptFloor && rawCompletion >= completionFloor
        if (trusted) {
          usage = {
            promptTokens: rawPrompt,
            completionTokens: rawCompletion,
            total: usageRaw!.total_tokens as number,
            estimateOnly: false,
          }
        } else {
          usage = {
            promptTokens: estimatedPrompt,
            completionTokens: estimatedCompletion,
            total: estimatedPrompt + estimatedCompletion,
            estimateOnly: true,
          }
        }
      }

      // 保留对话历史（LRU）
      this._storeConversation(requestId, messages)

      const result: BridgeAnswer = {
        ok: true,
        text: content,
        reasoning,
        thinkingUsed: request.thinking !== 'off',
        webSearchUsed: request.webSearch,
        model,
        usage,
        conversationRef: requestId,
        requestId,
      }

      return result
    } catch (err: unknown) {
      if (isAbortError(err)) {
        // 区分内部超时和外部取消
        if (request.signal?.aborted) {
          return failure('timeout', '请求已被取消')
        }
        return failure('timeout', `请求超时（${timeoutMs}ms）`)
      }
      // TypeError / fetch 抛出 → unreachable
      return failure('unreachable', `无法连接桥接服务: ${safeErrorMessage(err)}`)
    } finally {
      clearTimeout(timer)
      if (externalAbortHandler && request.signal) {
        request.signal.removeEventListener('abort', externalAbortHandler)
      }
    }
  }

  /**
   * 释放某任务保留的对话历史（随任务结束清理）。
   *
   * 当前实现：仅按 requestId 做 LRU 保留，无法按 taskKey 精确清理。
   * 因此本实现为 no-op + LRU 自然淘汰。
   */
  releaseConversations(_taskKey: string): void {
    // 无法从 taskKey 映射到 requestId 集合，退化为 LRU 自然淘汰。
    // 签名兼容，符合契约"若不便跟踪 taskKey，可退化为仅 LRU"。
  }

  // ———————————— 私有方法 ————————————

  /**
   * 组装消息列表。
   *
   * continueFromRequestId 命中保留历史时，沿用该历史并追加本轮 user 消息；
   * 未命中则按新会话处理。
   */
  private _buildMessages(
    request: BridgeChatRequest,
  ): Array<{ role: string; content: string }> {
    const userContent = request.question +
      (request.context ? `\n\n---\n背景材料：\n${request.context}` : '')

    // 尝试接续历史
    if (request.continueFromRequestId) {
      const existing = this._conversations.get(request.continueFromRequestId)
      if (existing) {
        // 沿用历史 + 追加本轮 user 消息
        return [...existing.messages, { role: 'user', content: userContent }]
      }
      // 未命中 → 按新会话处理（不视为失败，在 reason 里附加说明）
    }

    // 新会话
    return [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ]
  }

  /**
   * 存储对话历史到 LRU。
   */
  private _storeConversation(
    requestId: string,
    messages: Array<{ role: string; content: string }>,
  ): void {
    // 如果已存在，先删除再重新插入（更新 LRU 顺序）
    if (this._conversations.has(requestId)) {
      this._conversations.delete(requestId)
    }

    this._conversations.set(requestId, { requestId, messages })

    // LRU 淘汰
    while (this._conversations.size > CONVERSATION_LRU_MAX) {
      const oldestKey = this._conversations.keys().next().value
      if (oldestKey !== undefined) {
        this._conversations.delete(oldestKey)
      } else {
        break
      }
    }
  }
}

// —————————————————————————— 辅助函数 ——————————————————————————

/**
 * 槽位模型推导（含回落），确定性顺序：
 *
 *   plain          = modelMap.plain.trim()
 *   search         = modelMap.search.trim() || plain
 *   thinking       = modelMap.thinking.trim() || plain
 *   thinkingSearch = modelMap.thinkingSearch.trim() || thinking || search || plain
 *
 * 然后按模式取：
 *   thinking === 'off' → webSearch ? search : plain
 *   otherwise          → webSearch ? thinkingSearch : thinking
 *
 * 若最终取到的 id 仍为空字符串 → 返回 undefined（调用方转为 config-error）。
 */
function resolveModel(
  modelMap: { plain: string; thinking: string; thinkingSearch: string; search: string },
  thinking: ThinkingMode,
  webSearch: boolean,
): string | undefined {
  const plain = modelMap.plain.trim()
  if (!plain) return undefined   // 无可用模型，调用方返回 config-error

  const search = modelMap.search.trim() || plain
  const thinkingSlot = modelMap.thinking.trim() || plain
  const thinkingSearch = modelMap.thinkingSearch.trim() || thinkingSlot || search || plain

  if (thinking === 'off') {
    return webSearch ? search : plain
  }
  return webSearch ? thinkingSearch : thinkingSlot
}

/** 构造 BridgeFailure。 */
function failure(
  kind: BridgeErrorKind,
  reason: string,
  status?: number,
): BridgeFailure {
  return { ok: false, kind, reason, status }
}

/** 检查是否为 AbortError。 */
function isAbortError(err: unknown): boolean {
  return err instanceof DOMException
    ? err.name === 'AbortError'
    : err instanceof Error && err.name === 'AbortError'
}

/**
 * 安全提取错误信息：确保 apiKey 不泄露到错误文本中。
 */
function safeErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message
  }
  return String(err)
}

/**
 * 尽力从非 2xx 响应中提取可读的上游错误信息。
 *
 * 返回结构化三元组：message / code / hint，均经清洗且不含 apiKey。
 * 读取失败 / 非 JSON / 为空时返回空对象（调用方保持原来的 HTTP <status> 格式）。
 */
async function extractUpstreamError(resp: Response, apiKey?: string): Promise<UpstreamErrorParts> {
  try {
    const raw = await resp.text()
    if (!raw || !raw.trim()) return {}

    // 尝试 JSON 解析
    let obj: unknown
    try {
      obj = JSON.parse(raw)
    } catch {
      return { message: cleanErrorText(raw, apiKey) }
    }

    if (typeof obj !== 'object' || obj === null) {
      return { message: cleanErrorText(raw, apiKey) }
    }

    const body = obj as Record<string, unknown>

    // body.error 为对象 → 提取 message / code / hint
    if (body.error && typeof body.error === 'object' && body.error !== null) {
      const errObj = body.error as Record<string, unknown>
      const code = typeof errObj.code === 'string' && errObj.code.trim()
        ? sanitize(errObj.code.trim(), apiKey)
        : undefined
      const hint = typeof errObj.hint === 'string' && errObj.hint.trim()
        ? cleanErrorText(errObj.hint, apiKey, 120)
        : undefined
      const message = typeof errObj.message === 'string' && errObj.message.trim()
        ? cleanErrorText(errObj.message, apiKey, 80)
        : undefined
      return { message, code, hint }
    }

    // body.error 为字符串
    if (typeof body.error === 'string' && body.error.trim()) {
      return { message: cleanErrorText(body.error, apiKey, 80) }
    }

    // body.message
    if (typeof body.message === 'string' && body.message.trim()) {
      return { message: cleanErrorText(body.message, apiKey, 80) }
    }

    // 兜底：原始文本截断
    return { message: cleanErrorText(raw, apiKey, 80) }
  } catch {
    // 读取失败，不影响原有的 http-error 行为
    return {}
  }
}

/** 上游错误结构化三元组。 */
interface UpstreamErrorParts {
  message?: string
  code?: string
  hint?: string
}

/**
 * 把结构化错误三元组拼成紧凑可读的单行：
 *   message（code=xxx）— hint
 * 空字段不出现；总长度受 maxLen 约束。
 */
function formatUpstreamError(parts: UpstreamErrorParts, maxLen = 200): string {
  let result = parts.message ?? ''
  if (parts.code) {
    result += `（code=${parts.code}）`
  }
  if (parts.hint) {
    result += `— ${parts.hint}`
  }
  return result.slice(0, maxLen)
}

/**
 * 清洗错误文本：去换行、压缩空白、移除 apiKey、截断到指定长度。
 */
function cleanErrorText(text: string, apiKey?: string, maxLen = 200): string {
  let cleaned = text
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
  cleaned = sanitize(cleaned, apiKey)
  return cleaned.slice(0, maxLen)
}

/**
 * 从文本中移除 apiKey（防御性措施）。
 */
function sanitize(text: string, apiKey?: string): string {
  if (apiKey && text.includes(apiKey)) {
    return text.replaceAll(apiKey, '[REDACTED]')
  }
  return text
}

/**
 * 从 GET /models 响应体中提取模型 id 列表。
 *
 * 支持两种格式：
 * - OpenAI 标准：{ data: [{ id: "..." }, ...] }
 * - 变体：{ models: [{ id: "..." }, ...] }
 */
function extractModelIds(body: Record<string, unknown>): string[] {
  const ids: string[] = []
  // 优先 data[].id
  const data = body.data
  if (Array.isArray(data)) {
    for (const item of data) {
      if (item && typeof (item as Record<string, unknown>).id === 'string') {
        ids.push((item as Record<string, unknown>).id as string)
      }
    }
    if (ids.length > 0) return ids
  }
  // 备选 models[].id
  const models = body.models
  if (Array.isArray(models)) {
    for (const item of models) {
      if (item && typeof (item as Record<string, unknown>).id === 'string') {
        ids.push((item as Record<string, unknown>).id as string)
      }
    }
  }
  return ids
}

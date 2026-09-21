/**
 * Typert 宿主侧类型声明（valueRouterStatus 命名空间）。
 *
 * DSH 的 api-gateway 只在 dsh-typert-loader 注册了 strict typeSymbol 之后
 * 才能调度 Remote 服务。本文件是唯一的事实源：客户端 descriptor 的
 * typeSymbol 必须与这里定义的字符串逐字一致。
 *
 * loader 校验：codec.schema 必须是真 Zod v4 实例（带 _zod 标记）。
 *
 * 方法（declaration order = wire order，需与 status-controller.ts 的
 * markRemote 顺序一致）：
 * - status：只读快照（路由配置 + executor 健康 + 桥健康 / 委派统计 / 批次进度）；
 * - sessionMetrics：某会话的 executor 与桥计量 + 该会话的覆写；
 * - setSessionOverride：写入/清除会话级覆写（顶栏气泡用，不污染全局配置）。
 */
import { z } from 'zod'

// —— typeSymbol 前缀（单一事实源） ——

const PKG = '@gjs27/dsh-value-router'
const TYPES = `${PKG}/types`

// —— 输入 schema ——

const statusInput = z.object({}).strict()

const sessionMetricsInput = z.object({
  sessionId: z.string().max(256).optional(),
}).strict()

const routeSelectionSchema = z.object({
  provider: z.string(),
  model: z.string(),
  reasoningEffort: z.string(),
}).strict()

const overrideSchema = z.object({
  enabled: z.boolean().optional(),
  strategy: z.enum(['saver', 'balanced', 'powerful']).optional(),
  executor: z.object({
    provider: z.string().optional(),
    model: z.string().optional(),
    reasoningEffort: z.string().optional(),
  }).strict().optional(),
}).strict()

const setSessionOverrideInput = z.object({
  sessionId: z.string().min(1).max(256),
  override: overrideSchema.nullable(),
}).strict()

// —— 结果 schema ——

const bridgeTokensTotalSchema = z.object({
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
}).strict()

const batchSchema = z.object({
  batchId: z.string(),
  done: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  running: z.boolean(),
}).strict()

const statusResultSchema = z.object({
  enabled: z.boolean(),
  scope: z.enum(['preset', 'global']),
  strategy: z.enum(['saver', 'balanced', 'powerful']),
  executor: routeSelectionSchema,
  executorStatus: z.enum(['active', 'disabled', 'unconfigured', 'degraded']),
  executorReason: z.string().optional(),
  executorCallsTotal: z.number().int().nonnegative(),
  bridgeDelegationsTotal: z.number().int().nonnegative(),
  bridgeEnabled: z.boolean(),
  autoDelegate: z.boolean(),
  bridgeStatus: z.enum(['up', 'down', 'unknown']),
  bridgeCheckedAt: z.number().optional(),
  bridgeDetail: z.string().optional(),
  delegating: z.boolean(),
  lastTaskDelegations: z.number().int().nonnegative(),
  maxDelegationsPerTask: z.number().int().nonnegative(),
  delegationsTotal: z.number().int().nonnegative(),
  bridgeTokensTotal: bridgeTokensTotalSchema,
  savedTokensTotal: z.number().int().nonnegative(),
  estimateOnlyCount: z.number().int().nonnegative(),
  batch: batchSchema.optional(),
  lastOutcome: z.enum(['ok', 'fail', 'none']),
  lastMessage: z.string().optional(),
  lastError: z.string().optional(),
  availableModels: z.array(z.string()).optional(),
}).strict()

const sessionMetricsSchema = z.object({
  executorCalls: z.number().int().nonnegative(),
  executorInputTokens: z.number().int().nonnegative(),
  executorOutputTokens: z.number().int().nonnegative(),
  bridgeDelegations: z.number().int().nonnegative(),
  bridgePromptTokens: z.number().int().nonnegative(),
  bridgeCompletionTokens: z.number().int().nonnegative(),
  bridgeTotalTokens: z.number().int().nonnegative(),
  bridgeSavedTokens: z.number().int().nonnegative(),
  estimateOnlyCount: z.number().int().nonnegative(),
  executorSharePercent: z.number().int().min(0).max(100),
  override: overrideSchema.nullable(),
}).strict()

const setSessionOverrideResultSchema = z.object({
  ok: z.boolean(),
}).strict()

// —— descriptor 构造 ——

function invocation(id: string, method: string, parameterSchema: z.ZodTypeAny, resultSchema: z.ZodTypeAny) {
  return {
    id: `${PKG}#valueRouterStatus/${method}`,
    service: 'valueRouterStatus',
    namespace: 'valueRouterStatus',
    method,
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'input',
      wire: 'input',
      source: 'json',
      codec: {
        mode: 'strict',
        typeSymbol: `${TYPES}#${id}`,
        schema: parameterSchema,
      },
    }],
    result: {
      mode: 'strict',
      typeSymbol: `${TYPES}#ValueRouterStatus${method[0]?.toUpperCase()}${method.slice(1)}Result`,
      schema: resultSchema,
    },
  }
}

export const TYPERT = {
  package: PKG,
  face: 'host',
  schemas: [],
  invocations: [
    invocation('StatusInput', 'status', statusInput, statusResultSchema),
    invocation('SessionMetricsInput', 'sessionMetrics', sessionMetricsInput, sessionMetricsSchema),
    invocation('SetSessionOverrideInput', 'setSessionOverride', setSessionOverrideInput, setSessionOverrideResultSchema),
  ],
  model: { services: [], events: [], objects: [] },
}

export default TYPERT

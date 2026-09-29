/**
 * Typert 宿主侧类型声明（valueRouterStatus 命名空间）。
 *
 * DSH 的 api-gateway 只在 dsh-typert-loader 注册了 strict typeSymbol 之后
 * 才能调度 Remote 服务。本文件是唯一的事实源：客户端 descriptor 的
 * typeSymbol 必须与这里定义的字符串逐字一致。
 *
 * loader 校验：strict codec 必须暴露 create()，且 create() 返回真 Zod v4 实例（带 _zod 标记）。
 *
 * 方法（declaration order = wire order，需与 status-controller.ts 的
 * markRemote 顺序一致）：
 * - status：只读快照（路由配置 + executor 健康 + executor 调用计数）；
 * - sessionMetrics：某会话的 executor 调用次数 + 该会话的覆写；
 * - setSessionOverride：写入/清除会话级覆写（顶栏气泡用，不污染全局配置）。
 *
 * 桥接通道退役后，桥健康 / token / 批次相关 schema 一并删除。
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

const statusResultSchema = z.object({
  enabled: z.boolean(),
  strategy: z.enum(['saver', 'balanced', 'powerful']),
  pool: z.array(z.object({
    provider: z.string(),
    model: z.string(),
    reasoningEffort: z.string(),
    tier: z.enum(['cheap', 'mid', 'strong']),
  }).strict()),
  executor: routeSelectionSchema,
  executorStatus: z.enum(['active', 'disabled', 'unconfigured', 'degraded']),
  executorReason: z.string().optional(),
  executorCallsTotal: z.number().int().nonnegative(),
}).strict()

const sessionMetricsSchema = z.object({
  executorCalls: z.number().int().nonnegative(),
  override: overrideSchema.nullable(),
}).strict()

const setSessionOverrideResultSchema = z.object({
  ok: z.boolean(),
}).strict()

// —— descriptor 构造 ——

/**
 * strict codec 的 `create` 要求「按需物化」schema：这里包一层惰性工厂，
 * 首次过边界时才真正构建，避免模块加载期就实例化全部 schema。
 */
function memoizeSchema(build: () => z.ZodTypeAny): () => z.ZodTypeAny {
  let cached: z.ZodTypeAny | undefined
  return () => (cached ??= build())
}

function invocation(id: string, method: string, parameterSchema: () => z.ZodTypeAny, resultSchema: () => z.ZodTypeAny) {
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
        create: parameterSchema,
      },
    }],
    result: {
      mode: 'strict',
      typeSymbol: `${TYPES}#ValueRouterStatus${method[0]?.toUpperCase()}${method.slice(1)}Result`,
      create: resultSchema,
    },
  }
}

export const TYPERT = {
  package: PKG,
  face: 'host',
  schemas: [],
  invocations: [
    invocation('StatusInput', 'status', memoizeSchema(() => statusInput), memoizeSchema(() => statusResultSchema)),
    invocation('SessionMetricsInput', 'sessionMetrics', memoizeSchema(() => sessionMetricsInput), memoizeSchema(() => sessionMetricsSchema)),
    invocation('SetSessionOverrideInput', 'setSessionOverride', memoizeSchema(() => setSessionOverrideInput), memoizeSchema(() => setSessionOverrideResultSchema)),
  ],
  model: { services: [], events: [], objects: [] },
}

export default TYPERT

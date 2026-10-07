/**
 * Typert 宿主侧类型声明（valueRouterStatus 命名空间）。
 *
 * DSH 的 api-gateway 只在 dsh-typert-loader 注册了 strict typeSymbol 之后
 * 才能调度 Remote 服务。本文件是唯一的事实源：客户端 descriptor 的
 * typeSymbol 必须与这里定义的字符串逐字一致。
 *
 * loader 校验：strict codec 必须暴露 create()，且 create() 返回真 Zod v4 实例（带 _zod 标记）。
 *
 * 方法（declaration order = wire order，需与 status-controller.ts 的 markRemote 顺序一致）：
 * - `status`：只读快照（四档配置 + 可用性 + 派发记录 + 运行事件）；
 * - `sessionMetrics`：某会话（含后代子代理）的改写次数与派发记录。
 *
 * 0.10.0 删除：`setSessionOverride`（会话级覆写所依赖的 strategy/executor 已退役）
 * 以及全部旧池/档位 schema。
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

// —— 结果 schema ——

const lineStatusSchema = z.enum(['available', 'missing', 'blocked'])
const difficultySchema = z.enum(['low', 'medium', 'high', 'max'])
const routeSourceSchema = z.enum(['user', 'captain', 'difficulty', 'fallback', 'none'])
const routeStatusSchema = z.enum(['resolved', 'pending', 'blocked'])

const lineSchema = z.object({
  provider: z.string(),
  model: z.string(),
  reasoning_effort: z.string(),
  status: lineStatusSchema,
  statusDetail: z.string().optional(),
}).strict()

const tierSchema = z.object({
  id: difficultySchema,
  lines: z.array(lineSchema),
}).strict()

const dispatchSchema = z.object({
  provider: z.string(),
  model: z.string(),
  difficulty: difficultySchema,
  routeSource: routeSourceSchema,
  fallback: z.boolean(),
  degraded: z.boolean(),
  at: z.number(),
}).strict()

const routeEventSchema = z.object({
  type: z.string(),
  at: z.number(),
  teamId: z.string().optional(),
  taskId: z.string().optional(),
  member: z.string().optional(),
  sessionId: z.string().optional(),
  difficulty: z.string().optional(),
  role: z.string().optional(),
  route: z.object({
    provider: z.string(),
    model: z.string(),
    reasoning_effort: z.string().optional(),
  }).strict().optional(),
  routeSource: routeSourceSchema.optional(),
  routeStatus: routeStatusSchema.optional(),
  detail: z.string().optional(),
  queueReason: z.string().optional(),
}).strict()

const statusResultSchema = z.object({
  enabled: z.boolean(),
  tiers: z.array(tierSchema),
  fallback: lineSchema,
  availableLines: z.number().int().nonnegative(),
  missingLines: z.number().int().nonnegative(),
  blockedLines: z.number().int().nonnegative(),
  allowlistKnown: z.boolean(),
  routedCallsTotal: z.number().int().nonnegative(),
  recentDispatches: z.array(dispatchSchema),
  recentEvents: z.array(routeEventSchema),
}).strict()

const sessionMetricsSchema = z.object({
  routedCalls: z.number().int().nonnegative(),
  // 本会话（含后代子代理）的派发记录——徽章按会话展示，不能用全局流水
  recentDispatches: z.array(dispatchSchema),
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
  ],
  model: { services: [], events: [], objects: [] },
}

export default TYPERT

/**
 * 设置页 schema（schemastery）。宿主从 Loader runtime 读这个导出来生成设置文档。
 *
 * ## 2026-09-29 关键修复：所有字段必须是 `.volatile()`
 *
 * 宿主 `dsh-settings/lib/index.js:122-131` 的 `volatileForm()` **只保留标记为 volatile
 * 的字段**：普通 `.default()` 字段会被逐个丢弃，`Object.keys(dict).length === 0` 时整个
 * 条目在 `describe()` 的 `:419` 被跳过——**命名空间根本不会被服务**。
 * 后果是客户端 `configForms.get(ns)` 的快照恒为 `status: 'unavailable'` / `writable: false`，
 * 表现为「设置里没有价值路由卡片」+「当前配置不可写，请等待运行时连接恢复后重试」。
 *
 * 参照宿主自己的写法（`dsh-tool-subagent/lib/model-selection-settings.js:44-45`）：
 * `z.boolean().default(x).volatile()`，产出 `"volatile-defined"` 模式。
 *
 * 因此这里**刻意不加** `z<ValueRouterConfig>` 类型标注：volatile 字段的输出类型是
 * `Volatile<T>`，与手写的普通类型冲突（tsc 报 TS2322）。宿主自身也不加标注。
 * 客户端读值时用 `configForms.get<ValueRouterConfig>(ns)` 显式指定，与本模块解耦。
 *
 * 版本依赖：schemastery 必须与宿主对齐到 **3.18.4**。3.18.2 的类型里没有
 * `SchemaOutput` / `Volatile`，会与 dsh-settings 的传递依赖形成两份 `Schema` 类型身份。
 */

import z from '@deepseek-ai/schemastery'
import { DEFAULT_AMBIGUOUS_POLICY, DEFAULT_CONFIG, DEFAULT_STRATEGY, DEFAULT_TIER_ROUTING } from './config.ts'

/** 兜底线路 schema。 */
const ModelRouteSchema = z.object({
  provider: z.string().default('').volatile(),
  model: z.string().default('').volatile(),
  reasoningEffort: z.string().default('').volatile(),
})

/**
 * 轮转池内单条线路 schema。
 *
 * **这里刻意不加 `.volatile()`**：volatile 只能落在「固定对象路径且没有外层 volatile」的
 * 位置上（cordis 的 `resolveConfig` 会拒绝嵌套 volatile）。线路位于 `tiers.*` 之下，
 * 而 `tiers` 整体已经是 volatile——给内层再标 volatile 会让 Loader **拒绝整份配置**：
 *
 *     ValidationError: invalid config:
 *       - $.tiers.*.id volatile fields require a fixed object path
 *         without an enclosing volatile field (at tiers.*.id)
 *     dsh: warning: 1 entry did not activate
 *
 * 条目不激活 → fiber 不存在 → `describe()` 跳过它 → 客户端 `status=unavailable` →
 * 「设置里没有卡片」+「当前配置不可写」。宿主侧 `volatileForm()` 本来就是按
 * 「volatile 字段整体作为一片子树」处理的，所以外层 volatile 已经覆盖了整棵 tiers。
 *
 * 同一个错误在 0.2.x 的扁平 `pool`（volatile 数组 + volatile 元素）上就存在过——
 * 也就是说「设置不可写」从头到尾是**同一个根因**，前几轮改的都是表层。
 */
const PoolLineSchema = z.object({
  provider: z.string().default(''),
  model: z.string().default(''),
  reasoningEffort: z.string().default(''),
})

/** 档位 schema。id/label 由 resolveTier 补齐，池内无上限。内部同样不能标 volatile。 */
const TierSchema = z.object({
  id: z.string().default(''),
  label: z.string().default(''),
  pool: z.array(PoolLineSchema).default([]),
})

export const Config = z.object({
  enabled: z.boolean().default(DEFAULT_CONFIG.enabled).volatile(),
  strategy: z.union(['saver', 'balanced', 'powerful']).default(DEFAULT_STRATEGY).volatile(),
  tiers: z.array(TierSchema).default([]).volatile(),
  executor: ModelRouteSchema,
  ambiguousPolicy: z.union(['rotate', 'respect']).default(DEFAULT_AMBIGUOUS_POLICY).volatile(),
  tierRouting: z.union(['tier-rotate', 'controller']).default(DEFAULT_TIER_ROUTING).volatile(),
})

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
import { DEFAULT_AMBIGUOUS_POLICY, DEFAULT_CONFIG, DEFAULT_STRATEGY } from './config.ts'

/** 兜底线路 schema。 */
const ModelRouteSchema = z.object({
  provider: z.string().default('').volatile(),
  model: z.string().default('').volatile(),
  reasoningEffort: z.string().default('').volatile(),
})

/** 轮转池内单条线路 schema。**不设条数上限**——订阅分散在多家 provider 是常态。 */
const PoolLineSchema = z.object({
  provider: z.string().default('').volatile(),
  model: z.string().default('').volatile(),
  reasoningEffort: z.string().default('').volatile(),
  tier: z.union(['cheap', 'mid', 'strong']).default('mid').volatile(),
})

export const Config = z.object({
  enabled: z.boolean().default(DEFAULT_CONFIG.enabled).volatile(),
  strategy: z.union(['saver', 'balanced', 'powerful']).default(DEFAULT_STRATEGY).volatile(),
  pool: z.array(PoolLineSchema).default([]).volatile(),
  executor: ModelRouteSchema,
  ambiguousPolicy: z.union(['rotate', 'respect']).default(DEFAULT_AMBIGUOUS_POLICY).volatile(),
})

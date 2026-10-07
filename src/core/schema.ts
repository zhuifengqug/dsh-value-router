/**
 * 设置页 schema（schemastery）。宿主从 Loader runtime 读这个导出来生成设置文档。
 *
 * ## 形状（0.10.0）
 *
 * ```
 * enabled   : boolean
 * tiers     : { low|medium|high|max : { lines: [{provider, model, reasoning_effort}] } }
 * fallback  : { provider, model, reasoning_effort }
 * ```
 *
 * ## `.volatile()` 的两条硬规则（历史两次栽跟头，别再犯）
 *
 * 1. **普通 `.default()` 字段会被宿主丢掉**：`dsh-settings` 的 `volatileForm()` 只保留标记
 *    volatile 的字段，`Object.keys(dict).length === 0` 时整个条目被 `describe()` 跳过——
 *    命名空间根本不被服务，表现为「设置里没有卡片」+「当前配置不可写」。
 * 2. **volatile 只能落在固定对象路径、且不能被外层 volatile 包住**：给 `tiers.*.lines.*`
 *    这种内层再标 volatile，Loader 会以
 *    `volatile fields require a fixed object path without an enclosing volatile field`
 *    拒绝**整份配置**，条目不激活 → fiber 不存在 → 又回到第 1 条的同一个症状。
 *
 * 因此：`enabled` / `tiers` / `fallback` 三个顶层字段各标一次 volatile，内层一律不标。
 * 四档是**定长对象**（不是数组），每个档位的路径因此是固定的，满足第 2 条。
 *
 * ## 为什么不加 `z<ValueRouterConfig>` 类型标注
 *
 * volatile 字段的输出类型是 `Volatile<T>`，与手写的普通类型冲突（tsc 报 TS2322）。
 * 客户端读值时用 `configForms.get<ResolvedValueRouterConfig>(ns)` 显式指定，与本模块解耦。
 *
 * 依赖：schemastery 必须与宿主对齐到 **3.18.4**（3.18.2 缺 `SchemaOutput` / `Volatile` 类型，
 * 会与 dsh-settings 的传递依赖形成两份 `Schema` 类型身份）。
 */

import z from '@deepseek-ai/schemastery'

/** 一条线路。`reasoning_effort` 空串 = 用目标模型自己的默认等级。 */
const LineSchema = z.object({
  provider: z.string().default(''),
  model: z.string().default(''),
  reasoning_effort: z.string().default(''),
})

/** 一个档位：只含线路列表，档位身份由它在 `tiers` 里的键决定（low/medium/high/max）。 */
const TierSchema = z.object({
  lines: z.array(LineSchema).default([]),
})

/** 空线路的空档位。 */
const EMPTY_TIER = { lines: [] as { provider: string; model: string; reasoning_effort: string }[] }

export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  tiers: z.object({
    low: TierSchema.default(EMPTY_TIER),
    medium: TierSchema.default(EMPTY_TIER),
    high: TierSchema.default(EMPTY_TIER),
    max: TierSchema.default(EMPTY_TIER),
  }).volatile(),
  fallback: LineSchema.volatile(),
})

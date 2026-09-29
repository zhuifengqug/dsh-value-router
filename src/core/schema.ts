/**
 * 设置页 schema（schemastery）。注册到 ctx.settings 后，DSH GUI 会自动生成
 * 对应开关/输入项。本模块仅在运行时被引用，不参与离线核心单测。
 *
 * 注意：嵌套对象（executor / pool 内每条线路）使用各字段独立 .default()——
 * schemastery 不支持 z.object({...}).default({...}) 的嵌套默认值。
 *
 * 2026-09-29（0.2.0）：字段面与 core/config.ts 的 ValueRouterConfig 一一对应，
 * 删掉 scope / excludePresets（专属预设已摘除），新增 pool / ambiguousPolicy。
 *
 * 版本依赖：schemastery 必须与宿主对齐到 **3.18.4**。3.18.2 的类型里没有
 * `SchemaOutput` / `Volatile`，与 0.1.7-rc.2 的 dsh-settings 传递依赖形成两份
 * `Schema` 类型身份，tsc 会报 TS2322（`boolean | Volatile<boolean>` 不可赋给 `boolean`）。
 */

import z from '@deepseek-ai/schemastery'
import type { PoolLine, ValueRouterConfig } from './config.ts'
import { DEFAULT_AMBIGUOUS_POLICY, DEFAULT_CONFIG, DEFAULT_STRATEGY, POOL_MAX_LINES } from './config.ts'

/** 兜底线路 schema。 */
const ModelRouteSchema = z.object({
  provider: z.string().default(''),
  model: z.string().default(''),
  reasoningEffort: z.string().default(''),
})

/** 轮转池内单条线路 schema。 */
const PoolLineSchema = z.object({
  provider: z.string().default(''),
  model: z.string().default(''),
  reasoningEffort: z.string().default(''),
  tier: z.union(['cheap', 'mid', 'strong']).default('mid'),
})

export const Config: z<ValueRouterConfig> = z.object({
  enabled: z.boolean().default(DEFAULT_CONFIG.enabled),
  strategy: z.union(['saver', 'balanced', 'powerful']).default(DEFAULT_STRATEGY),
  // 上限在 resolvePool 里再兜一次（手改 settings 文件也能生效），这里只是给 GUI 一个提示。
  pool: z.array(PoolLineSchema).default([] as PoolLine[]).max(POOL_MAX_LINES),
  executor: ModelRouteSchema,
  ambiguousPolicy: z.union(['rotate', 'respect']).default(DEFAULT_AMBIGUOUS_POLICY),
})

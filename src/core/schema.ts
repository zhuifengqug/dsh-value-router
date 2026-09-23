/**
 * 设置页 schema（schemastery）。注册到 ctx.settings 后，DSH GUI 会自动生成
 * 对应开关/输入项。本模块仅在运行时被引用，不参与离线核心单测。
 *
 * 注意：嵌套对象（executor）使用各字段独立 .default()——
 * schemastery 不支持 z.object({...}).default({...}) 的嵌套默认值。
 *
 * 字段面与 core/config.ts 的 ValueRouterConfig 一一对应；桥接通道退役后
 * 只剩 5 个字段（enabled / scope / excludePresets / strategy / executor）。
 */

import z from '@deepseek-ai/schemastery'
import type { ValueRouterConfig } from './config.ts'
import { DEFAULT_CONFIG, DEFAULT_SCOPE, DEFAULT_STRATEGY } from './config.ts'

/** executor 模型路由 schema。 */
const ModelRouteSchema = z.object({
  provider: z.string().default(''),
  model: z.string().default(''),
  reasoningEffort: z.string().default(''),
})

export const Config: z<ValueRouterConfig> = z.object({
  enabled: z.boolean().default(DEFAULT_CONFIG.enabled),
  scope: z.union(['preset', 'global']).default(DEFAULT_SCOPE),
  excludePresets: z.array(z.string()).default([]),
  strategy: z.union(['saver', 'balanced', 'powerful']).default(DEFAULT_STRATEGY),
  executor: ModelRouteSchema,
})

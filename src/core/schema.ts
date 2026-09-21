/**
 * 设置页 schema（schemastery）。注册到 ctx.settings 后，DSH GUI 会自动生成
 * 对应开关/输入项。本模块仅在运行时被引用，不参与离线核心单测。
 *
 * 注意：嵌套对象（executor / tuning / bridge）使用各字段独立 .default()——
 * schemastery 不支持 z.object({...}).default({...}) 的嵌套默认值。
 */

import z from '@deepseek-ai/schemastery'
import type { ValueRouterConfig } from './config.ts'
import {
  DEFAULT_ALLOWED_TASK_TYPES,
  DEFAULT_BLOCKED_TASK_TYPES,
  DEFAULT_BRIDGE_CONFIG,
  DEFAULT_CONFIG,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MODEL_MAP,
  DEFAULT_SCOPE,
  DEFAULT_STRATEGY,
  DEFAULT_TUNING,
} from './config.ts'

/** executor 模型路由 schema。 */
const ModelRouteSchema = z.object({
  provider: z.string().default(''),
  model: z.string().default(''),
  reasoningEffort: z.string().default(''),
})

/** 显式调参 schema（覆盖策略推导值）。 */
const TuningSchema = z.object({
  minEstimatedSavedTokens: z.number().default(DEFAULT_TUNING.minEstimatedSavedTokens),
  maxDelegationsPerTask: z.number().default(DEFAULT_TUNING.maxDelegationsPerTask),
  maxDelegationsPerHour: z.number().default(DEFAULT_TUNING.maxDelegationsPerHour),
  maxConcurrentDelegations: z.number().default(DEFAULT_TUNING.maxConcurrentDelegations),
  maxRetriesPerRequest: z.number().default(DEFAULT_TUNING.maxRetriesPerRequest),
  requestTimeoutMs: z.number().default(DEFAULT_TUNING.requestTimeoutMs),
  maxInputCharacters: z.number().default(DEFAULT_TUNING.maxInputCharacters),
  maxResultCharacters: z.number().default(DEFAULT_TUNING.maxResultCharacters),
})

/** 桥接模型映射 schema。 */
const BridgeModelMapSchema = z.object({
  plain: z.string().default(DEFAULT_MODEL_MAP.plain),
  thinking: z.string().default(DEFAULT_MODEL_MAP.thinking),
  thinkingSearch: z.string().default(DEFAULT_MODEL_MAP.thinkingSearch),
  search: z.string().default(DEFAULT_MODEL_MAP.search),
})

/** 桥接配置 schema（各字段独立 .default()）。 */
const BridgeConfigSchema = z.object({
  enabled: z.boolean().default(DEFAULT_BRIDGE_CONFIG.enabled),
  baseUrl: z.string().default(DEFAULT_BRIDGE_CONFIG.baseUrl),
  apiKey: z.string().default(DEFAULT_BRIDGE_CONFIG.apiKey),
  modelMap: BridgeModelMapSchema,
  extraHeaders: z.dict(z.string()).default(DEFAULT_BRIDGE_CONFIG.extraHeaders),
  thinkingBody: z.dict(z.any()).default(DEFAULT_BRIDGE_CONFIG.thinkingBody),
  searchBody: z.dict(z.any()).default(DEFAULT_BRIDGE_CONFIG.searchBody),
  reasoningField: z.string().default(DEFAULT_BRIDGE_CONFIG.reasoningField),
  trustUsage: z.union(['auto', 'always', 'never']).default(DEFAULT_BRIDGE_CONFIG.trustUsage),
  timeoutMs: z.number().default(DEFAULT_BRIDGE_CONFIG.timeoutMs),
  healthCacheTtlMs: z.number().default(DEFAULT_BRIDGE_CONFIG.healthCacheTtlMs),
  concurrency: z.number().default(DEFAULT_BRIDGE_CONFIG.concurrency),
  maxBatchItems: z.number().default(DEFAULT_BRIDGE_CONFIG.maxBatchItems),
})

export const Config: z<ValueRouterConfig> = z.object({
  enabled: z.boolean().default(DEFAULT_CONFIG.enabled),
  scope: z.union(['preset', 'global']).default(DEFAULT_SCOPE),
  excludePresets: z.array(z.string()).default([]),
  strategy: z.union(['saver', 'balanced', 'powerful']).default(DEFAULT_STRATEGY),
  executor: ModelRouteSchema,
  maxDepth: z.number().default(DEFAULT_MAX_DEPTH),
  autoDelegate: z.boolean().default(DEFAULT_CONFIG.autoDelegate),
  allowedTaskTypes: z.array(z.string()).default(DEFAULT_ALLOWED_TASK_TYPES),
  blockedTaskTypes: z.array(z.string()).default(DEFAULT_BLOCKED_TASK_TYPES),
  allowCodeSnippet: z.boolean().default(DEFAULT_CONFIG.allowCodeSnippet),
  allowLocalFileContent: z.boolean().default(DEFAULT_CONFIG.allowLocalFileContent),
  requireConfirmationForCommands: z.boolean().default(DEFAULT_CONFIG.requireConfirmationForCommands),
  defaultThinking: z.union(['off', 'on', 'silent']).default(DEFAULT_CONFIG.defaultThinking),
  fallbackMode: z.union(['continue-with-primary', 'skip-delegation', 'ask-user']).default(DEFAULT_CONFIG.fallbackMode),
  tuning: TuningSchema,
  bridge: BridgeConfigSchema,
})

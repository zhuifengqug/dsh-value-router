/**
 * 浏览器可读的状态快照（typert remote `valueRouterStatus` 的载荷形状）。
 *
 * 两个来源合并：
 * - 路由侧（本插件的配置与 executor 健康）；
 * - 桥侧（沿用桥插件的 StatusTracker：桥健康、委派计数、token 估算、批次进度）。
 *
 * 只暴露脱敏后的最小必要状态，不含提示词、请求内容或凭据。
 */

import type { ModelRouteSelection, ValueRouterScope, ValueRouterStrategy } from './config.ts'

/**
 * 桥侧快照的结构（与 src/bridge/status.ts 的 `DelegationStatusSnapshot` 同形）。
 *
 * 刻意结构化声明而不 `import type`：`src/core/**` 同时被浏览器侧 project
 * （tsconfig.client.json，只收录 src/client 与 src/core）编译，一旦这里 import
 * `bridge/`，composite 的 root-files 约束会报 TS6307，或被迫把整个桥实现拉进
 * 浏览器侧 program。两者是否漂移由 `src/index.ts` 组装快照处编译期保证。
 */
export interface BridgeStatusSnapshotShape {
  enabled: boolean
  autoDelegate: boolean
  bridgeStatus: 'up' | 'down' | 'unknown'
  bridgeCheckedAt?: number
  bridgeDetail?: string
  delegating: boolean
  lastTaskDelegations: number
  maxDelegationsPerTask: number
  delegationsTotal: number
  bridgeTokensTotal: { promptTokens: number; completionTokens: number; total: number }
  savedTokensTotal: number
  estimateOnlyCount: number
  batch?: { batchId: string; done: number; total: number; running: boolean }
  lastOutcome: 'ok' | 'fail' | 'none'
  lastMessage?: string
  lastError?: string
  availableModels?: string[]
}

export interface ValueRouterStatusSnapshot {
  // —— 路由侧 ——
  /** 价值路由总开关。 */
  enabled: boolean
  scope: ValueRouterScope
  strategy: ValueRouterStrategy
  /** 子代理路由目标。 */
  executor: ModelRouteSelection
  /** executor 通道健康度。 */
  executorStatus: 'active' | 'disabled' | 'unconfigured' | 'degraded'
  executorReason?: string
  /** 已观测到的 executor 路由调用次数（宿主累计）。 */
  executorCallsTotal: number
  /** 已观测到的桥委派次数（宿主累计）。 */
  bridgeDelegationsTotal: number

  // —— 桥侧（沿用桥插件字段） ——
  /** 桥接通道是否在设置里启用。 */
  bridgeEnabled: boolean
  autoDelegate: boolean
  bridgeStatus: 'up' | 'down' | 'unknown'
  bridgeCheckedAt?: number
  bridgeDetail?: string
  delegating: boolean
  lastTaskDelegations: number
  maxDelegationsPerTask: number
  delegationsTotal: number
  bridgeTokensTotal: { promptTokens: number; completionTokens: number; total: number }
  savedTokensTotal: number
  estimateOnlyCount: number
  batch?: { batchId: string; done: number; total: number; running: boolean }
  lastOutcome: 'ok' | 'fail' | 'none'
  lastMessage?: string
  lastError?: string
  availableModels?: string[]
}

/** 桥侧状态为空时的安全默认值（服务尚未挂载时使用）。 */
export const EMPTY_BRIDGE_SNAPSHOT: BridgeStatusSnapshotShape = {
  enabled: false,
  autoDelegate: false,
  bridgeStatus: 'unknown',
  delegating: false,
  lastTaskDelegations: 0,
  maxDelegationsPerTask: 0,
  delegationsTotal: 0,
  bridgeTokensTotal: { promptTokens: 0, completionTokens: 0, total: 0 },
  savedTokensTotal: 0,
  estimateOnlyCount: 0,
  lastOutcome: 'none',
}

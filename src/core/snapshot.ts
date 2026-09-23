/**
 * 浏览器可读的状态快照（typert remote `valueRouterStatus` 的载荷形状）。
 *
 * 只描述**子代理路由**这一个通道：配置 + executor 健康 + 路由调用计数。
 * 桥接通道退役后，桥健康 / 委派计数 / token 估算 / 批次进度全部随之删除。
 *
 * 只暴露脱敏后的最小必要状态，不含提示词、请求内容或凭据。
 */

import type { ModelRouteSelection, ValueRouterScope, ValueRouterStrategy } from './config.ts'

export interface ValueRouterStatusSnapshot {
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
}

/** 服务尚未挂载时的安全默认值（浏览器侧读到它时表示插件未加载）。 */
export const EMPTY_STATUS_SNAPSHOT: ValueRouterStatusSnapshot = {
  enabled: false,
  scope: 'preset',
  strategy: 'balanced',
  executor: { provider: '', model: '', reasoningEffort: '' },
  executorStatus: 'disabled',
  executorCallsTotal: 0,
}

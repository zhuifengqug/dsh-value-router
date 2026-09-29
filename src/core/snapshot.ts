/**
 * 浏览器可读的状态快照（typert remote `valueRouterStatus` 的载荷形状）。
 *
 * 只描述**子代理路由**这一个通道：配置 + executor 健康 + 路由调用计数。
 * 桥接通道退役后，桥健康 / 委派计数 / token 估算 / 批次进度全部随之删除。
 *
 * 只暴露脱敏后的最小必要状态，不含提示词、请求内容或凭据。
 */

import type { ModelRouteSelection, PoolLine, ValueRouterStrategy } from './config.ts'

export interface ValueRouterStatusSnapshot {
  /** 价值路由总开关。 */
  enabled: boolean
  strategy: ValueRouterStrategy
  /** 轮转线路池（子代理可用线路）。 */
  pool: PoolLine[]
  /** 兜底线路：池为空或目标 provider 不可用时使用。 */
  executor: ModelRouteSelection
  /** 兜底线路通道健康度。 */
  executorStatus: 'active' | 'disabled' | 'unconfigured' | 'degraded'
  executorReason?: string
  /** 已观测到的路由改写次数（宿主累计）。 */
  executorCallsTotal: number
}

/** 服务尚未挂载时的安全默认值（浏览器侧读到它时表示插件未加载）。 */
export const EMPTY_STATUS_SNAPSHOT: ValueRouterStatusSnapshot = {
  enabled: false,
  strategy: 'balanced',
  pool: [],
  executor: { provider: '', model: '', reasoningEffort: '' },
  executorStatus: 'disabled',
  executorCallsTotal: 0,
}

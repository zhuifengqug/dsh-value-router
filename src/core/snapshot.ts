/**
 * 浏览器可读的状态快照（typert remote `valueRouterStatus` 的载荷形状）。
 *
 * 只描述**子代理路由**这一个通道：配置 + executor 健康 + 路由调用计数。
 * 桥接通道退役后，桥健康 / 委派计数 / token 估算 / 批次进度全部随之删除。
 *
 * 只暴露脱敏后的最小必要状态，不含提示词、请求内容或凭据。
 */

import type { ModelRouteSelection, ResolvedTier, TierRouting, ValueRouterStrategy } from './config.ts'

export interface ValueRouterStatusSnapshot {
  /** 价值路由总开关。 */
  enabled: boolean
  strategy: ValueRouterStrategy
  /**
   * 档位列表，顺序即优先级。`tiers[0]` 是最低档 = 兜底轮转池。
   * 每条线路的 `allowed=false` 表示它不在宿主白名单里，**不会参与轮转**，
   * 客户端据此把它标出来提示用户去补白名单。
   */
  tiers: ResolvedTier[]
  /** 兜底线路：所有档位都不可路由时使用。 */
  executor: ModelRouteSelection
  /** 兜底线路通道健康度。 */
  executorStatus: 'active' | 'disabled' | 'unconfigured' | 'degraded'
  executorReason?: string
  /** 已观测到的路由改写次数（宿主累计）。 */
  executorCallsTotal: number
  /** 主控指定线路时的处置模式。 */
  tierRouting: TierRouting
  /**
   * 最近的实际派发记录，最新的在前。
   *
   * 这是「插件到底干了什么」的唯一可观测出口：子代理会话头不带模型信息，
   * `subagent` 工具的返回也不带，主控与用户在对话里无法验证轮转是否真的生效。
   */
  recentDispatches: DispatchView[]
  /** 是否成功读到宿主白名单。false = 读不到，所有线路都被放行（宁可多派不静默清空）。 */
  allowlistKnown: boolean
}

/** 一条派发记录的对外形状（与 core/state.ts 的 DispatchRecord 对应）。 */
export interface DispatchView {
  provider: string
  model: string
  /** 实际派发的档位下标；落在兜底线路时为 null。 */
  tierIndex: number | null
  origin: 'pool' | 'explicit' | 'fallback'
  at: number
}

/** 服务尚未挂载时的安全默认值（浏览器侧读到它时表示插件未加载）。 */
export const EMPTY_STATUS_SNAPSHOT: ValueRouterStatusSnapshot = {
  enabled: false,
  strategy: 'balanced',
  tiers: [],
  executor: { provider: '', model: '', reasoningEffort: '' },
  executorStatus: 'disabled',
  executorCallsTotal: 0,
  tierRouting: 'tier-rotate',
  recentDispatches: [],
  allowlistKnown: false,
}

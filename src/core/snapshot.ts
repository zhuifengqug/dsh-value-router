/**
 * 状态快照：只读投影，客户端设置卡与顶栏徽章共用。
 *
 * 只描述**模型路由**这一个通道：四档线路配置 + 可用性判定 + 派发记录 + 运行事件。
 * 快照里**不含凭据**、不含提示词、不含请求内容——只有线路三元组与判定结果。
 */

import type { Difficulty, LineStatus, ResolvedValueRouterConfig } from './config.ts'
import type { RouteSource, RouteStatus } from './intent.ts'
import type { RecordedRouteEvent } from './audit.ts'

/** 系统提示段角色。 */
export type ValueRouterRole = 'controller' | 'subagent'

/** 快照里的一条线路。 */
export interface SnapshotLine {
  provider: string
  model: string
  reasoning_effort: string
  /** 目录 / 白名单判定。 */
  status: LineStatus
  /** 判定依据的人读说明。 */
  statusDetail?: string
}

/** 快照里的一个档位。 */
export interface SnapshotTier {
  id: Difficulty
  lines: SnapshotLine[]
}

/** 快照里的一条派发记录。 */
export interface SnapshotDispatch {
  provider: string
  model: string
  difficulty: Difficulty
  routeSource: RouteSource
  fallback: boolean
  degraded: boolean
  at: number
}

/** 一次路由解析的对外摘要。 */
export interface SnapshotResolution {
  provider: string
  model: string
  reasoning_effort: string
  routeSource: RouteSource
  routeStatus: RouteStatus
  fallback: boolean
  degraded: boolean
  /** 仅 true 时可派发；false 时调用方必须保持任务待定。 */
  dispatchable: boolean
  reason?: string
  audit: readonly {
    at: number
    step: string
    outcome: string
    detail: string
    tier?: Difficulty
  }[]
}

/** 完整状态快照。 */
export interface ValueRouterStatusSnapshot {
  enabled: boolean
  /** 固定四档，顺序 low → max。 */
  tiers: SnapshotTier[]
  /** 单一全局兜底线路（不是任何档位的轮转成员）。 */
  fallback: SnapshotLine
  /** 四档里可用线路总数（不含 fallback）。 */
  availableLines: number
  /** 已分档但目录中消失的线路数（保留配置，不派发）。 */
  missingLines: number
  /** 被宿主白名单挡住的线路数。 */
  blockedLines: number
  /** 是否成功读到宿主白名单。false = 读不到 → 不做白名单拦截。 */
  allowlistKnown: boolean
  /** 进程内累计改写次数。 */
  routedCallsTotal: number
  /** 最近的实际派发记录，最新在前。 */
  recentDispatches: SnapshotDispatch[]
  /** 最近的运行事件（派发/复用/排队/兜底/降级/线路被拒），最新在前。 */
  recentEvents: RecordedRouteEvent[]
}

/** 服务尚未挂载时的安全默认值（浏览器侧读到它时表示插件未加载）。 */
export const EMPTY_STATUS_SNAPSHOT: ValueRouterStatusSnapshot = {
  enabled: false,
  tiers: [],
  fallback: { provider: '', model: '', reasoning_effort: '', status: 'missing' },
  availableLines: 0,
  missingLines: 0,
  blockedLines: 0,
  allowlistKnown: false,
  routedCallsTotal: 0,
  recentDispatches: [],
  recentEvents: [],
}

/** 从归一化配置投影出线路。 */
function projectLine(line: {
  provider: string
  model: string
  reasoning_effort: string
  status: LineStatus
  statusDetail?: string
}): SnapshotLine {
  return {
    provider: line.provider,
    model: line.model,
    reasoning_effort: line.reasoning_effort,
    status: line.status,
    ...(line.statusDetail === undefined ? {} : { statusDetail: line.statusDetail }),
  }
}

/** 组装快照。 */
export function buildStatusSnapshot(input: {
  config: ResolvedValueRouterConfig
  allowlistKnown: boolean
  routedCallsTotal: number
  recentDispatches: readonly SnapshotDispatch[]
  recentEvents?: readonly RecordedRouteEvent[]
}): ValueRouterStatusSnapshot {
  const tiers: SnapshotTier[] = input.config.tiers.map(tier => ({
    id: tier.id,
    lines: tier.lines.map(projectLine),
  }))
  const tierLines = tiers.flatMap(tier => tier.lines)
  return {
    enabled: input.config.enabled,
    tiers,
    fallback: projectLine(input.config.fallback),
    availableLines: tierLines.filter(line => line.status === 'available' && line.model !== '').length,
    missingLines: tierLines.filter(line => line.status === 'missing' && line.model !== '').length,
    blockedLines: tierLines.filter(line => line.status === 'blocked' && line.model !== '').length,
    allowlistKnown: input.allowlistKnown,
    routedCallsTotal: input.routedCallsTotal,
    recentDispatches: [...input.recentDispatches],
    recentEvents: [...(input.recentEvents ?? [])],
  }
}

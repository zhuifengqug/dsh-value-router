/**
 * executor 路由可用性检查（从 value-mode 的 model-selection 移植，删除 expert 部分）。
 *
 * 只在「要改写路由之前」调用：provider 不存在 → 返回 unavailable，调用方放行普通路由
 * （安全降级，绝不让会话因为插件而失败）。
 */

import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { ModelRouteSelection, ResolvedValueRouterConfig } from './config.ts'
import { isCompleteModelRoute } from './config.ts'

export type ModelHealthStatus = 'ready' | 'unconfigured' | 'unavailable'

export interface ExecutorHealth {
  status: 'active' | 'disabled' | 'unconfigured' | 'degraded'
  executorHealth: ModelHealthStatus
  reason?: string
}

export function isRouteConfigured(route?: ModelRouteSelection): boolean {
  return isCompleteModelRoute(route)
}

/** 检查单个路由的可用性：未配置 → unconfigured；provider 不存在 → unavailable。 */
export async function checkRouteAvailability(
  llm: LlmRuntime | undefined,
  route?: ModelRouteSelection,
): Promise<ModelHealthStatus> {
  if (!isRouteConfigured(route)) return 'unconfigured'
  if (!llm) {
    // LLM 运行时尚未就绪时，配置完整即视为可用（路由改写是纯数据操作）。
    return 'ready'
  }
  try {
    const providers = llm.listProviders()
    return providers.some((p) => p.id === route!.provider) ? 'ready' : 'unavailable'
  } catch {
    return 'unavailable'
  }
}

/** executor 通道整体健康度（供状态快照 / 顶栏徽章使用）。 */
export async function assessExecutorHealth(
  config: ResolvedValueRouterConfig | undefined,
  llm: LlmRuntime | undefined,
): Promise<ExecutorHealth> {
  if (!config || !config.enabled) {
    return {
      status: 'disabled',
      executorHealth: isRouteConfigured(config?.executor) ? 'ready' : 'unconfigured',
    }
  }
  const executorHealth = await checkRouteAvailability(llm, config.executor)
  if (executorHealth === 'unconfigured') {
    return { status: 'unconfigured', executorHealth, reason: 'executor 未配置完整' }
  }
  if (executorHealth === 'unavailable') {
    return { status: 'degraded', executorHealth, reason: 'executor provider 不可用' }
  }
  return { status: 'active', executorHealth: 'ready' }
}

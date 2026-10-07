/**
 * 路由遥测。
 *
 * 事件名 `value_router_route`：只发固定、隐私安全的字段（难度档、模型 id 与错误类别），
 * 不含会话 id、提示词、凭据或上游错误文本。
 *
 * 0.10.0：`strategy`（saver/balanced/powerful）随同配置退役，改为上报 `difficulty`
 * （low/medium/high/max，或 `fallback` 表示走了全局兜底，`unknown` 表示未定档）。
 */

export const VALUE_ROUTER_RUNTIME_TELEMETRY_PREFIX = 'DSH_VALUE_ROUTER_METRIC '

/** 上报用的难度标签。 */
export type TelemetryDifficulty = 'low' | 'medium' | 'high' | 'max' | 'fallback' | 'unknown'

export type RouteParameters = {
  role: 'main' | 'subagent'
  result: 'started' | 'success' | 'failure' | 'cancelled'
  difficulty: TelemetryDifficulty
  model: string
  error_type: 'none' | 'auth' | 'rate_limit' | 'timeout' | 'network' | 'provider' | 'invalid_request' | 'cancelled' | 'unknown'
}

export type ValueRouterRuntimeTelemetry =
  | { event: 'value_router_route'; params: RouteParameters; timestamp: string }

export function routeErrorType(failure: unknown): RouteParameters['error_type'] {
  const value = failure as { status?: number; code?: string } | undefined
  if ([401, 403].includes(value?.status ?? 0)) return 'auth'
  if (value?.status === 429) return 'rate_limit'
  if (/timeout|timed.?out/i.test(value?.code ?? '')) return 'timeout'
  if (/network|connection|fetch|ECONN/i.test(value?.code ?? '')) return 'network'
  if ((value?.status ?? 0) >= 500) return 'provider'
  if ((value?.status ?? 0) >= 400) return 'invalid_request'
  return 'unknown'
}

/** 把任意来源标签收敛成受控的上报值（未知值一律 `unknown`，不回传原文）。 */
export function telemetryDifficulty(value: string): TelemetryDifficulty {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'max' || value === 'fallback'
    ? value
    : 'unknown'
}

export function routeParameters(
  role: 'main' | 'subagent',
  difficulty: string,
  model: string,
): RouteParameters {
  return {
    role,
    result: 'started',
    difficulty: telemetryDifficulty(difficulty),
    model: /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,95}$/u.test(model) ? model : 'unknown',
    error_type: 'none',
  }
}

type RuntimeProcess = {
  env?: Record<string, string | undefined>
  stdout?: { write: (value: string) => unknown }
}

/**
 * 只向 Desktop 主进程发送固定、隐私安全的路由标记。
 * 传输由 Electron 拥有，本插件自身不发任何网络请求。
 */
export function emitValueRouterRuntimeTelemetry(payload: ValueRouterRuntimeTelemetry): void {
  const runtimeProcess = (globalThis as unknown as { process?: RuntimeProcess }).process
  if (runtimeProcess?.env?.DSH_DESKTOP_PRODUCT_METRICS_BRIDGE !== '1' || typeof runtimeProcess.stdout?.write !== 'function') return
  try {
    runtimeProcess.stdout.write(`${VALUE_ROUTER_RUNTIME_TELEMETRY_PREFIX}${JSON.stringify(payload)}\n`)
  } catch {
    // 遥测绝不改变路由行为。
  }
}

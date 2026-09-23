/**
 * 价值路由产品遥测（best-effort）。
 *
 * 隐私口径与来源插件一致：渲染进程只能构造下面这个封闭的枚举词表，
 * Electron 主进程在转发给 ProductMetricsRecorder 之前会再做一次运行时校验。
 * 因此事件里永远不包含 sessionId、提示词、模型名、路径或任何用户内容。
 */

export type ValueRouterProductTelemetryEvent =
  | { kind: 'entry'; configured: boolean; source?: 'hero' | 'header' | 'settings' }
  | { kind: 'onboarding'; outcome: 'shown' | 'completed' | 'dismissed' | 'failed'; surface: 'hero' | 'header' | 'settings' }
  | { kind: 'state'; state: 'enabled' | 'disabled' | 'failed'; source: 'onboarding' | 'manual' | 'auto' | 'settings' | 'session' }
  | { kind: 'strategy'; strategy: 'saver' | 'balanced' | 'powerful' }
  | { kind: 'scope'; scope: 'preset' | 'global' }
  | { kind: 'session-override'; action: 'set' | 'reset' }

type DesktopTelemetryApi = {
  recordValueRouterEvent?: (event: ValueRouterProductTelemetryEvent) => Promise<unknown> | unknown
}

const emittedDedupeKeys = new Set<string>()

/**
 * 渲染进程 → 主进程的 best-effort 上报通道。没有桌面宿主（纯浏览器）时静默跳过。
 */
export function reportValueRouterTelemetry(
  event: ValueRouterProductTelemetryEvent,
  dedupeKey?: string,
): void {
  const desktop = typeof window === 'undefined'
    ? undefined
    : (window as unknown as { dshDesktop?: DesktopTelemetryApi }).dshDesktop
  if (typeof desktop?.recordValueRouterEvent !== 'function') return
  if (dedupeKey !== undefined && emittedDedupeKeys.has(dedupeKey)) return
  if (dedupeKey !== undefined) {
    emittedDedupeKeys.add(dedupeKey)
    // Hero 与 header 观察者会在相邻渲染帧看到同一次预设切换。抑制窗口保持很短，
    // 这样用户稍后主动再选一次仍然会被计数。
    setTimeout(() => emittedDedupeKeys.delete(dedupeKey), 1_000)
  }
  try {
    void Promise.resolve(desktop.recordValueRouterEvent(event)).catch(() => {})
  } catch {
    // 产品遥测永远不能影响设置或会话 UI。
  }
}

export function resetValueRouterTelemetryDedupeForTests(): void {
  emittedDedupeKeys.clear()
}

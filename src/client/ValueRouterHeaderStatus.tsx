/**
 * 顶栏「价值路由」徽章 + 快捷设置气泡。
 *
 * 三件事：
 * - 徽章显示当前档位与轮转池规模；
 * - 气泡展示轮转池、兜底线路与健康、本会话/累计改写次数；
 * - 「全局默认 / 仅本会话」切换：仅本会话时经 Remote `setSessionOverride` 写宿主
 *   （只进宿主内存，不污染全局设置），并提供重置。
 *
 * 0.2.0：删除了「生效范围（专属预设 / 所有预设）」相关的全部 UI 与遥测——
 * 插件对全部预设生效，没有可切换的范围。同理删掉了「进入专属预设时自动开启 +
 * 自动弹引导」这条链路，它的前提（专属预设存在）已经不存在了。
 */

import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Context } from '@deepseek-ai/cordis'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type {
  ModelRouteSelection,
  SessionOverrideConfig,
  ValueRouterConfig,
  ValueRouterStrategy,
} from '../core/config.ts'
import { isCompleteModelRoute, resolveEffectiveConfig, strategyLabel } from '../core/config.ts'
import { ModelPicker, type ValueRouterModelCatalog } from './ModelPicker.tsx'
import { useValueRouterConfig } from './useValueRouterConfig.ts'
import { useLiveSessionMetrics, useLiveStatus, writeSessionOverride } from './use-live-status.ts'
import styles from './value-router.module.css'
import headerStyles from './value-router-header.module.css'
import { reportValueRouterTelemetry } from './telemetry.ts'

export interface ValueRouterHeaderStatusProps {
  config: ValueRouterConfig
  sessionId: string
  useSessions?: <T>(selector: (state: { byId: Record<string, unknown> }) => T) => T
  configForm?: ConfigForm<ValueRouterConfig>
  onChange: (patch: Partial<ValueRouterConfig>) => Promise<void> | void
  fetchModels?: () => Promise<ValueRouterModelCatalog>
  /** 宿主 client context：传入后经 Remote 直连读宿主侧真实状态与会话计量。 */
  clientCtx?: Context
}

/** 写入落点：全局设置，还是只覆盖本会话。 */
type WriteMode = 'global' | 'session'

interface SetupDraft {
  executor: ModelRouteSelection
  strategy: ValueRouterStrategy
}

function formatModel(route?: ModelRouteSelection): string {
  if (!isCompleteModelRoute(route)) return '未配置'
  return `${route.provider} / ${route.model}`
}

function renderPortal(node: React.ReactNode): React.ReactNode {
  return typeof document === 'undefined' ? node : createPortal(node, document.body)
}

function executorStatusText(status: 'active' | 'disabled' | 'unconfigured' | 'degraded'): string {
  return status === 'active' ? '正常' : status === 'unconfigured' ? '未配置' : status === 'degraded' ? '部分模型不可用' : '已关闭'
}

export const ValueRouterHeaderStatus: React.FC<ValueRouterHeaderStatusProps> = ({
  config,
  sessionId,
  configForm,
  onChange,
  fetchModels,
  clientCtx,
}) => {
  const [open, setOpen] = useState(false)
  const [onboarding, setOnboarding] = useState(false)
  const [pickingExecutor, setPickingExecutor] = useState(false)
  const [writeMode, setWriteMode] = useState<WriteMode>('global')
  const [setupDraft, setSetupDraft] = useState<SetupDraft>({ executor: {}, strategy: 'balanced' })
  const [setupError, setSetupError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [metricsToken, setMetricsToken] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const overrideRef = useRef<SessionOverrideConfig | null>(null)

  const liveConfig = useValueRouterConfig(configForm, config)
  const liveStatus = useLiveStatus(clientCtx, open)
  const liveMetrics = useLiveSessionMetrics(clientCtx, sessionId, open, metricsToken)
  const sessionOverride = liveMetrics?.override ?? null
  const resolved = resolveEffectiveConfig(liveConfig, sessionOverride ?? undefined)
  const fallbackComplete = isCompleteModelRoute(resolved.executor)
  const poolSize = resolved.pool.length
  const configured = poolSize > 0 || fallbackComplete

  useEffect(() => {
    overrideRef.current = sessionOverride
    // 宿主存在覆写就显示「仅本会话」，否则回到「全局默认」。用户点「仅本会话」但尚未
    // 写入任何字段时不会被这条同步覆盖（sessionOverride 引用未变，effect 不重跑）。
    setWriteMode(sessionOverride ? 'session' : 'global')
  }, [sessionOverride])

  const startOnboarding = (): void => {
    setSetupDraft({ executor: { ...resolved.executor }, strategy: resolved.strategy })
    setSetupError(null)
    setOnboarding(true)
    setOpen(true)
    reportValueRouterTelemetry({ kind: 'onboarding', outcome: 'shown', surface: 'header' }, `value-router-onboarding-shown:header:${sessionId}`)
  }

  const dismissOnboarding = (): void => {
    if (onboarding) reportValueRouterTelemetry({ kind: 'onboarding', outcome: 'dismissed', surface: 'header' })
    setOpen(false)
    setOnboarding(false)
  }

  const reportError = (reason: unknown, fallback: string): void => {
    setSetupError(reason instanceof Error && reason.message.trim() ? reason.message : fallback)
    setOpen(true)
  }

  const persistGlobalPatch = async (patch: Partial<ValueRouterConfig>, fallback: string): Promise<boolean> => {
    setSetupError(null)
    try {
      await onChange(patch)
      return true
    } catch (reason) {
      reportError(reason, fallback)
      return false
    }
  }

  const persistOverride = async (next: SessionOverrideConfig | null, fallback: string): Promise<boolean> => {
    setSetupError(null)
    const ok = await writeSessionOverride(clientCtx, sessionId, next)
    if (!ok) {
      reportError(null, fallback)
      return false
    }
    setMetricsToken((value) => value + 1)
    return true
  }

  /** 会话档：把 patch 合并进已有覆写；全局档：写全局设置。 */
  const applyScoped = async (patch: SessionOverrideConfig, fallback: string): Promise<void> => {
    if (writeMode === 'session') {
      await persistOverride({ ...(overrideRef.current ?? {}), ...patch }, fallback)
      return
    }
    const globalPatch: Partial<ValueRouterConfig> = {}
    if (patch.enabled !== undefined) globalPatch.enabled = patch.enabled
    if (patch.strategy !== undefined) globalPatch.strategy = patch.strategy
    if (patch.executor !== undefined) globalPatch.executor = patch.executor
    await persistGlobalPatch(globalPatch, fallback)
  }

  useEffect(() => {
    if (!open) return
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node
      if (rootRef.current?.contains(target) || panelRef.current?.contains(target)) return
      // 模型选择器单独 portal 到 body：它打开时由自己的遮罩处理外部点击。
      if (pickingExecutor) return
      dismissOnboarding()
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (pickingExecutor) {
        setPickingExecutor(false)
        return
      }
      dismissOnboarding()
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open, onboarding, pickingExecutor])

  useEffect(() => {
    if (!open) {
      triggerRef.current?.focus()
      return
    }
    const dialog = pickingExecutor
      ? document.querySelector<HTMLElement>('[data-value-router-model-picker="true"] [role="dialog"]')
      : panelRef.current
    dialog?.querySelector<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')?.focus()
  }, [open, onboarding, pickingExecutor])

  const handleToggle = async (): Promise<void> => {
    const nextEnabled = !resolved.enabled
    await applyScoped(
      { enabled: nextEnabled },
      nextEnabled ? '价值路由开启失败，请重试。' : '价值路由关闭失败，请重试。',
    )
    reportValueRouterTelemetry({
      kind: 'state',
      state: nextEnabled ? 'enabled' : 'disabled',
      source: writeMode === 'session' ? 'session' : 'manual',
    })
  }

  const handleStrategyChange = async (nextStrategy: ValueRouterStrategy): Promise<void> => {
    if (onboarding) {
      setSetupDraft((draft) => ({ ...draft, strategy: nextStrategy }))
    } else {
      await applyScoped({ strategy: nextStrategy }, '策略保存失败，请重试。')
    }
    reportValueRouterTelemetry({ kind: 'strategy', strategy: nextStrategy })
  }

  const handleModelSelect = (selection: ModelRouteSelection): void => {
    if (onboarding) {
      setSetupDraft((draft) => ({ ...draft, executor: selection }))
    } else {
      void applyScoped({ executor: selection }, '兜底线路保存失败，请重试。')
    }
    setPickingExecutor(false)
  }

  const handleResetOverride = async (): Promise<void> => {
    const ok = await persistOverride(null, '会话覆写重置失败，请重试。')
    if (ok) {
      setWriteMode('global')
      reportValueRouterTelemetry({ kind: 'session-override', action: 'reset' })
    }
  }

  const handleCompleteSetup = async (): Promise<void> => {
    if (!isCompleteModelRoute(setupDraft.executor)) {
      setSetupError('请先选择兜底线路。完整的多模型配置（轮转池）请到「设置 → 插件」里添加。')
      return
    }
    setSaving(true)
    setSetupError(null)
    try {
      // enabled 单独最后写，避免「部分配置」被提前激活。
      await onChange({ executor: setupDraft.executor })
      await onChange({ strategy: setupDraft.strategy })
      await onChange({ enabled: true })
      setOnboarding(false)
      setOpen(false)
      reportValueRouterTelemetry({ kind: 'onboarding', outcome: 'completed', surface: 'header' })
      reportValueRouterTelemetry({ kind: 'state', state: 'enabled', source: 'onboarding' })
    } catch (reason) {
      reportValueRouterTelemetry({ kind: 'onboarding', outcome: 'failed', surface: 'header' })
      setSetupError(reason instanceof Error && reason.message.trim() ? reason.message : '配置写入失败，请重试。')
    } finally {
      setSaving(false)
    }
  }

  const label = !configured
    ? '价值路由 · 待配置'
    : !resolved.enabled
      ? '价值路由 · 已关闭'
      : `价值路由 · ${strategyLabel(resolved.strategy)}`
  const statusClass = !configured
    ? styles.badgeDegraded
    : resolved.enabled
      ? styles.badgeActive
      : styles.badgeInactive

  const quickPopover = (
    <>
      <div className={headerStyles.popoverHeader}>
        <span className={styles.title}>价值路由</span>
        <span className={`${styles.badge} ${statusClass}`}>
          {resolved.enabled ? (configured ? '已开启' : '配置不完整') : (configured ? '已关闭' : '待配置')}
        </span>
      </div>

      {setupError && <div className={headerStyles.setupError} role="alert">{setupError}</div>}

      <div className={styles.scopeSwitcher} role="group" aria-label="写入范围">
        <button
          type="button"
          className={`${styles.scopeButton} ${writeMode === 'global' ? styles.scopeButtonActive : ''}`}
          aria-pressed={writeMode === 'global'}
          onClick={() => setWriteMode('global')}
        >
          全局默认
        </button>
        <button
          type="button"
          className={`${styles.scopeButton} ${writeMode === 'session' ? styles.scopeButtonActive : ''}`}
          aria-pressed={writeMode === 'session'}
          onClick={() => {
            setWriteMode('session')
            reportValueRouterTelemetry({ kind: 'session-override', action: 'set' })
          }}
        >
          仅本会话{sessionOverride ? '（已覆写）' : ''}
        </button>
      </div>
      <div className={headerStyles.setupHint}>会话覆写只写宿主内存，不改动全局设置；轮转池只能全局配置。</div>

      <div className={styles.roleSummary}>
        <div className={styles.popoverItem}>
          <span className={styles.popoverItemLabel}>轮转池:</span>
          <span className={styles.popoverItemValue}>
            {poolSize > 0 ? resolved.pool.map((line) => line.model).join(' → ') : '未配置（子代理将继承主模型）'}
          </span>
        </div>
        <div className={styles.popoverItem}>
          <span className={styles.popoverItemLabel}>兜底线路:</span>
          <span className={styles.popoverItemValue}>{formatModel(resolved.executor)}</span>
        </div>
        {liveStatus && (
          <div className={styles.popoverItem}>
            <span className={styles.popoverItemLabel}>兜底线路状态:</span>
            <span className={styles.popoverItemValue}>
              {executorStatusText(liveStatus.executorStatus)}
              {liveStatus.executorReason ? ` · ${liveStatus.executorReason}` : ''}
            </span>
          </div>
        )}
        <div className={styles.popoverItem}>
          <span className={styles.popoverItemLabel}>派发倾向:</span>
          <span className={styles.popoverItemValue}>{strategyLabel(resolved.strategy)}</span>
        </div>
      </div>

      <div className={styles.statsCard}>
        <div className={styles.statItem}>
          <span className={styles.statItemLabel}>本会话改写</span>
          <span className={styles.statItemValue}>{liveMetrics?.executorCalls ?? 0} 次</span>
        </div>
        <div className={styles.statItem}>
          <span className={styles.statItemLabel}>累计改写</span>
          <span className={styles.statItemValue}>{liveStatus?.executorCallsTotal ?? 0} 次</span>
        </div>
      </div>

      <div className={headerStyles.actionStack}>
        <div className={headerStyles.actionRow}>
          <button type="button" className={`${styles.button} ${headerStyles.actionButton}`} onClick={() => setPickingExecutor(true)}>换兜底线路</button>
          <button
            type="button"
            className={`${styles.button} ${headerStyles.actionButton}`}
            onClick={() => {
              const next: ValueRouterStrategy = resolved.strategy === 'saver' ? 'balanced' : resolved.strategy === 'balanced' ? 'powerful' : 'saver'
              void handleStrategyChange(next)
            }}
          >
            切档位
          </button>
        </div>
        <div className={headerStyles.actionRow}>
          <button
            type="button"
            className={`${styles.button} ${headerStyles.actionButton} ${resolved.enabled ? '' : styles.buttonPrimary}`}
            disabled={!configured && !resolved.enabled}
            onClick={() => void handleToggle()}
          >
            {resolved.enabled ? '关闭路由' : '开启路由'}
          </button>
          {writeMode === 'session' && sessionOverride && (
            <button type="button" className={`${styles.button} ${headerStyles.actionButton}`} onClick={() => void handleResetOverride()}>
              重置会话覆写
            </button>
          )}
        </div>
      </div>
    </>
  )

  const onboardingPopover = (
    <>
      <div className={headerStyles.setupHeader}>
        <div>
          <div className={headerStyles.setupEyebrow}>首次设置 · 约 30 秒</div>
          <h2 className={headerStyles.setupTitle}>价值路由</h2>
        </div>
        <button type="button" className={headerStyles.setupClose} aria-label="关闭价值路由引导" onClick={dismissOnboarding}>×</button>
      </div>
      <p className={headerStyles.setupLead}>
        主模型负责理解与最终交付，子代理负责并行执行。先给一条兜底线路——完整的多模型轮转池请到「设置 → 插件」里配置。
      </p>

      <div className={headerStyles.setupSteps}>
        <div className={`${headerStyles.setupStep} ${isCompleteModelRoute(setupDraft.executor) ? headerStyles.setupStepReady : ''}`}>
          <span className={headerStyles.setupStepNumber}>01</span>
          <div className={headerStyles.setupStepBody}>
            <div className={headerStyles.setupStepHeading}>兜底线路</div>
            <div className={headerStyles.setupStepValue}>{formatModel(setupDraft.executor)}</div>
            <div className={headerStyles.setupDefaultNote}>池为空或目标 provider 不可用时使用</div>
          </div>
          <button type="button" className={`${styles.button} ${headerStyles.setupModelButton}`} onClick={() => setPickingExecutor(true)}>
            {isCompleteModelRoute(setupDraft.executor) ? '更换' : '选择'}
          </button>
        </div>
      </div>

      <div className={headerStyles.setupStrategy}>
        <div className={headerStyles.setupStrategyLabel}>02 · 派发倾向</div>
        <div className={styles.strategyGroup}>
          {(['saver', 'balanced', 'powerful'] as const).map((strategy) => (
            <button
              type="button"
              key={strategy}
              aria-pressed={setupDraft.strategy === strategy}
              className={`${styles.strategyItem} ${setupDraft.strategy === strategy ? styles.strategyItemSelected : ''}`}
              onClick={() => void handleStrategyChange(strategy)}
            >
              <span className={styles.strategyTitle}>{strategyLabel(strategy)}</span>
              <span className={styles.strategyDesc}>
                {strategy === 'saver' ? '少派发，控制调用量' : strategy === 'powerful' ? '积极并行，优先质量' : '按任务复杂度派发'}
              </span>
            </button>
          ))}
        </div>
      </div>

      {setupError && <div className={headerStyles.setupError} role="alert">{setupError}</div>}

      <div className={headerStyles.setupFooter}>
        <span className={headerStyles.setupHint}>配置保存在全局设置中，可在完整设置里调整</span>
        <button
          type="button"
          className={`${styles.button} ${styles.buttonPrimary} ${headerStyles.setupSubmit}`}
          disabled={saving || !isCompleteModelRoute(setupDraft.executor)}
          onClick={() => void handleCompleteSetup()}
        >
          {saving ? '保存并开启中…' : '完成配置并开启'}
        </button>
      </div>
    </>
  )

  const popover = (
    <div
      ref={panelRef}
      className={`${styles.popover} ${headerStyles.popover} ${onboarding ? headerStyles.onboardingPopover : ''}`}
      role="dialog"
      aria-modal="false"
      aria-label={onboarding ? '价值路由配置引导' : '价值路由快捷设置'}
      data-value-router-onboarding={onboarding ? 'true' : 'false'}
    >
      {onboarding ? onboardingPopover : quickPopover}
    </div>
  )

  return (
    <div className={headerStyles.root} ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className={`${styles.headerChip} ${!resolved.enabled ? styles.headerChipDisabled : ''}`}
        aria-expanded={open}
        aria-label="价值路由状态"
        onClick={() => {
          if (!open && !configured) startOnboarding()
          else setOpen((value) => !value)
        }}
        title="价值路由状态与快捷设置"
      >
        <span aria-hidden="true">VR</span>
        <span>{label}</span>
        <span className={styles.scopeTag}>{poolSize > 0 ? `池 ${poolSize}` : '无池'}</span>
      </button>

      {open && renderPortal(popover)}

      {pickingExecutor && (
        <ModelPicker
          title="选择兜底线路"
          current={onboarding ? setupDraft.executor : resolved.executor}
          onSelect={handleModelSelect}
          onClose={() => setPickingExecutor(false)}
          fetchModels={fetchModels}
        />
      )}
    </div>
  )
}

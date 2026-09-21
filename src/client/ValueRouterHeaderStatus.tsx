/**
 * 顶栏「价值路由」徽章 + 快捷设置气泡。
 *
 * 三件事：
 * - 徽章文案含策略与 scope 标记（预设 / 全局）；
 * - 气泡展示策略、executor（provider/model）、scope、executor 调用占比、桥健康点、
 *   累计节省 Token（估算口径）、桥委派次数、批次进度、桥最近错误/提示；
 * - 「全局默认 / 仅本会话」切换：仅本会话时经 Remote `setSessionOverride` 写宿主
 *   （只进宿主内存，不污染全局设置），并提供重置。
 *
 * 首次引导（executor + 策略 + scope）也在这里就地展开，与 Hero 引导同一套数据流。
 */

import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type {
  ModelRouteSelection,
  SessionOverrideConfig,
  ValueRouterConfig,
  ValueRouterScope,
  ValueRouterStrategy,
} from '../core/config.ts'
import {
  VALUE_ROUTER_PRESET_ID,
  isCompleteModelRoute,
  resolveEffectiveConfig,
  strategyLabel,
} from '../core/config.ts'
import { ModelPicker, type ValueRouterModelCatalog } from './ModelPicker.tsx'
import { useSettingsValue, useValueRouterConfig } from './useValueRouterConfig.ts'
import { useLiveSessionMetrics, useLiveStatus, writeSessionOverride } from './use-live-status.ts'
import styles from './value-router.module.css'
import headerStyles from './value-router-header.module.css'
import { reportValueRouterTelemetry } from './telemetry.ts'

export interface SessionPresetEntry {
  agentPreset?: string
  projectionValues?: { agentPreset?: string }
}

export interface ValueRouterHeaderStatusProps {
  config: ValueRouterConfig
  sessionId: string
  useSessions: <T>(selector: (state: { byId: Record<string, SessionPresetEntry> }) => T) => T
  settingsScope?: SettingsScope<ValueRouterConfig>
  onChange: (patch: Partial<ValueRouterConfig>) => Promise<void> | void
  fetchModels?: () => Promise<ValueRouterModelCatalog>
  /** 宿主 client context：传入后经 Remote 直连读宿主侧真实状态与会话计量。 */
  clientCtx?: Context
}

type ScopeMode = 'global' | 'session'

interface SetupDraft {
  executor: ModelRouteSelection
  strategy: ValueRouterStrategy
  scope: ValueRouterScope
}

function formatModel(route?: ModelRouteSelection): string {
  if (!isCompleteModelRoute(route)) return '未配置'
  return `${route.provider} / ${route.model}`
}

function renderPortal(node: React.ReactNode): React.ReactNode {
  return typeof document === 'undefined' ? node : createPortal(node, document.body)
}

function bridgeHealthText(status: 'up' | 'down' | 'unknown'): string {
  return status === 'up' ? '正常' : status === 'down' ? '断开' : '未知'
}

export const ValueRouterHeaderStatus: React.FC<ValueRouterHeaderStatusProps> = ({
  config,
  sessionId,
  useSessions,
  settingsScope,
  onChange,
  fetchModels,
  clientCtx,
}) => {
  const [open, setOpen] = useState(false)
  const [onboarding, setOnboarding] = useState(false)
  const [pickingExecutor, setPickingExecutor] = useState(false)
  const [scopeMode, setScopeMode] = useState<ScopeMode>('global')
  const [setupDraft, setSetupDraft] = useState<SetupDraft>({ executor: {}, strategy: 'balanced', scope: 'preset' })
  const [setupError, setSetupError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [metricsToken, setMetricsToken] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const handledEntryRef = useRef<string | null>(null)
  const overrideRef = useRef<SessionOverrideConfig | null>(null)

  // 官方 AgentPresetLabel 从 state.byId[sessionId]?.projectionValues?.agentPreset 读预设，
  // 这里读同一条路径，保证徽章的显示条件与官方标签一致。
  const activePreset = useSessions((state) => {
    const entry = state.byId[sessionId]
    const projected = entry?.projectionValues?.agentPreset
    if (typeof projected === 'string') return projected
    return entry?.agentPreset
  })

  const liveConfig = useValueRouterConfig(settingsScope, config)
  const liveStatus = useLiveStatus(clientCtx, open)
  const liveMetrics = useLiveSessionMetrics(clientCtx, sessionId, open, metricsToken)
  const sessionOverride = liveMetrics?.override ?? null
  const resolved = resolveEffectiveConfig(liveConfig, sessionOverride ?? undefined)
  const configured = isCompleteModelRoute(resolved.executor)
  const inScope = resolved.scope === 'global' || activePreset === VALUE_ROUTER_PRESET_ID

  useEffect(() => {
    overrideRef.current = sessionOverride
    // 宿主存在覆写就显示「仅本会话」，否则回到「全局默认」。用户点「仅本会话」但尚未
    // 写入任何字段时不会被这条同步覆盖（sessionOverride 引用未变，effect 不重跑）。
    setScopeMode(sessionOverride ? 'session' : 'global')
  }, [sessionOverride])

  const startOnboarding = () => {
    setSetupDraft({ executor: { ...resolved.executor }, strategy: resolved.strategy, scope: resolved.scope })
    setSetupError(null)
    setOnboarding(true)
    setOpen(true)
    reportValueRouterTelemetry({ kind: 'onboarding', outcome: 'shown', surface: 'header' }, `value-router-onboarding-shown:header:${sessionId}`)
  }

  const dismissOnboarding = () => {
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
  const applySessionScoped = async (patch: SessionOverrideConfig, fallback: string): Promise<void> => {
    if (scopeMode === 'session') {
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
    if (activePreset !== VALUE_ROUTER_PRESET_ID) {
      handledEntryRef.current = null
      return
    }
    const entryKey = `${sessionId}:${VALUE_ROUTER_PRESET_ID}`
    if (handledEntryRef.current === entryKey) return
    handledEntryRef.current = entryKey
    reportValueRouterTelemetry({ kind: 'entry', configured, source: 'header' }, 'value-router-entry')

    if (configured) {
      if (!resolved.enabled) {
        void Promise.resolve()
          .then(() => onChange({ enabled: true }))
          .then(() => reportValueRouterTelemetry({ kind: 'state', state: 'enabled', source: 'auto' }))
          .catch(() => reportValueRouterTelemetry({ kind: 'state', state: 'failed', source: 'auto' }))
      }
    } else {
      startOnboarding()
    }
  }, [activePreset, sessionId, configured])

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
    await applySessionScoped(
      { enabled: nextEnabled },
      nextEnabled ? '价值路由开启失败，请重试。' : '价值路由关闭失败，请重试。',
    )
    reportValueRouterTelemetry({
      kind: 'state',
      state: nextEnabled ? 'enabled' : 'disabled',
      source: scopeMode === 'session' ? 'session' : 'manual',
    })
  }

  const handleStrategyChange = async (nextStrategy: ValueRouterStrategy): Promise<void> => {
    if (onboarding) {
      setSetupDraft((draft) => ({ ...draft, strategy: nextStrategy }))
    } else {
      await applySessionScoped({ strategy: nextStrategy }, '策略保存失败，请重试。')
    }
    reportValueRouterTelemetry({ kind: 'strategy', strategy: nextStrategy })
  }

  const handleScopeChange = async (nextScope: ValueRouterScope): Promise<void> => {
    if (onboarding) {
      setSetupDraft((draft) => ({ ...draft, scope: nextScope }))
    } else {
      await persistGlobalPatch({ scope: nextScope }, '生效范围保存失败，请重试。')
    }
    reportValueRouterTelemetry({ kind: 'scope', scope: nextScope })
  }

  const handleModelSelect = (selection: ModelRouteSelection): void => {
    if (onboarding) {
      setSetupDraft((draft) => ({ ...draft, executor: selection }))
    } else {
      void applySessionScoped({ executor: selection }, 'executor 保存失败，请重试。')
    }
    setPickingExecutor(false)
  }

  const handleResetOverride = async (): Promise<void> => {
    const ok = await persistOverride(null, '会话覆写重置失败，请重试。')
    if (ok) {
      setScopeMode('global')
      reportValueRouterTelemetry({ kind: 'session-override', action: 'reset' })
    }
  }

  const handleSwitchToSession = (): void => {
    setScopeMode('session')
    reportValueRouterTelemetry({ kind: 'session-override', action: 'set' })
  }

  const handleCompleteSetup = async (): Promise<void> => {
    if (!isCompleteModelRoute(setupDraft.executor)) {
      setSetupError('请先选择 executor 子代理执行模型。')
      return
    }
    setSaving(true)
    setSetupError(null)
    try {
      // enabled 单独最后写，避免「部分配置」被提前激活。
      await onChange({ executor: setupDraft.executor })
      await onChange({ strategy: setupDraft.strategy })
      await onChange({ scope: setupDraft.scope })
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

  if (!inScope) return null

  const scopeTag = resolved.scope === 'global' ? '全局' : '预设'
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
  const healthClass = liveStatus?.bridgeStatus === 'up'
    ? styles.bridgeDotUp
    : liveStatus?.bridgeStatus === 'down'
      ? styles.bridgeDotDown
      : styles.bridgeDotUnknown

  const quickPopover = (
    <>
      <div className={headerStyles.popoverHeader}>
        <span className={styles.title}>价值路由</span>
        <span className={`${styles.badge} ${statusClass}`}>
          {resolved.enabled ? configured ? '已开启' : '配置不完整' : configured ? '已关闭' : '待配置'}
        </span>
      </div>

      {setupError && <div className={headerStyles.setupError} role="alert">{setupError}</div>}

      <div className={styles.scopeSwitcher} role="group" aria-label="生效范围">
        <button
          type="button"
          className={`${styles.scopeButton} ${scopeMode === 'global' ? styles.scopeButtonActive : ''}`}
          aria-pressed={scopeMode === 'global'}
          onClick={() => setScopeMode('global')}
        >
          全局默认
        </button>
        <button
          type="button"
          className={`${styles.scopeButton} ${scopeMode === 'session' ? styles.scopeButtonActive : ''}`}
          aria-pressed={scopeMode === 'session'}
          onClick={handleSwitchToSession}
        >
          仅本会话{sessionOverride ? '（已覆写）' : ''}
        </button>
      </div>
      <div className={headerStyles.setupHint}>会话覆写只写宿主内存，不改动全局设置。</div>

      <div className={styles.roleSummary}>
        <div className={styles.popoverItem}>
          <span className={styles.popoverItemLabel}>executor:</span>
          <span className={styles.popoverItemValue}>{formatModel(resolved.executor)}</span>
        </div>
        <div className={styles.popoverItem}>
          <span className={styles.popoverItemLabel}>当前策略:</span>
          <span className={styles.popoverItemValue}>{strategyLabel(resolved.strategy)}</span>
        </div>
        <div className={styles.popoverItem}>
          <span className={styles.popoverItemLabel}>生效范围:</span>
          <span className={styles.popoverItemValue}>{resolved.scope === 'global' ? '所有预设' : '仅专属预设'}</span>
        </div>
      </div>

      <div className={styles.statsCard}>
        <div className={styles.statItem}>
          <span className={styles.statItemLabel}>本会话 executor 调用</span>
          <span className={styles.statItemValue}>{liveMetrics?.executorCalls ?? 0} 次</span>
        </div>
        <div className={styles.statItem}>
          <span className={styles.statItemLabel}>本会话桥委派</span>
          <span className={styles.statItemValue}>{liveMetrics?.bridgeDelegations ?? 0} 次</span>
        </div>
        <div className={styles.statSavingsHighlight}>
          <span>executor 调用占比</span>
          <span className={headerStyles.savingsValue}>{liveMetrics?.executorSharePercent ?? 0}%</span>
        </div>
      </div>

      <div className={styles.bridgeHealthRow}>
        <span className={`${styles.bridgeDot} ${healthClass}`} aria-hidden="true" />
        <span>桥健康：{bridgeHealthText(liveStatus?.bridgeStatus ?? 'unknown')}</span>
        {liveStatus?.bridgeCheckedAt !== undefined && (
          <span className={headerStyles.savingsValue}>{new Date(liveStatus.bridgeCheckedAt).toLocaleTimeString()}</span>
        )}
      </div>

      <div className={styles.popoverItem}>
        <span className={styles.popoverItemLabel}>累计桥委派:</span>
        <span className={styles.popoverItemValue}>{liveStatus?.bridgeDelegationsTotal ?? 0} 次</span>
      </div>
      <div className={styles.popoverItem}>
        <span className={styles.popoverItemLabel}>累计节省 Token:</span>
        <span className={styles.popoverItemValue}>
          {(liveStatus?.savedTokensTotal ?? 0).toLocaleString()}
          {(liveStatus?.estimateOnlyCount ?? 0) > 0 ? '（估算）' : ''}
        </span>
      </div>
      {liveStatus?.batch && (
        <div className={styles.popoverItem}>
          <span className={styles.popoverItemLabel}>批次进度:</span>
          <span className={styles.popoverItemValue}>
            {liveStatus.batch.done}/{liveStatus.batch.total}{liveStatus.batch.running ? '（执行中）' : ''}
          </span>
        </div>
      )}
      {liveStatus?.lastError && <div className={headerStyles.setupError} role="alert">{liveStatus.lastError}</div>}
      {liveStatus?.lastMessage && <div className={headerStyles.setupHint}>{liveStatus.lastMessage}</div>}

      <div className={headerStyles.actionStack}>
        <div className={headerStyles.actionRow}>
          <button type="button" className={`${styles.button} ${headerStyles.actionButton}`} onClick={() => setPickingExecutor(true)}>换 executor</button>
          <button
            type="button"
            className={`${styles.button} ${headerStyles.actionButton}`}
            onClick={() => {
              const next: ValueRouterStrategy = resolved.strategy === 'saver' ? 'balanced' : resolved.strategy === 'balanced' ? 'powerful' : 'saver'
              void handleStrategyChange(next)
            }}
          >
            切策略
          </button>
          <button
            type="button"
            className={`${styles.button} ${headerStyles.actionButton}`}
            onClick={() => void handleScopeChange(resolved.scope === 'global' ? 'preset' : 'global')}
          >
            切范围
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
          {scopeMode === 'session' && sessionOverride && (
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
        主模型负责理解与最终交付，executor 只执行下沉的子任务。先确认执行模型，完成后即可开启。
      </p>

      <div className={headerStyles.setupSteps}>
        <div className={`${headerStyles.setupStep} ${isCompleteModelRoute(setupDraft.executor) ? headerStyles.setupStepReady : ''}`}>
          <span className={headerStyles.setupStepNumber}>01</span>
          <div className={headerStyles.setupStepBody}>
            <div className={headerStyles.setupStepHeading}>executor 子代理执行模型</div>
            <div className={headerStyles.setupStepValue}>{formatModel(setupDraft.executor)}</div>
            <div className={headerStyles.setupDefaultNote}>用于并行调查、局部实现和重复性工作</div>
          </div>
          <button type="button" className={`${styles.button} ${headerStyles.setupModelButton}`} onClick={() => setPickingExecutor(true)}>
            {isCompleteModelRoute(setupDraft.executor) ? '更换' : '选择'}
          </button>
        </div>
      </div>

      <div className={headerStyles.setupStrategy}>
        <div className={headerStyles.setupStrategyLabel}>02 · 运行策略</div>
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
              <span className={styles.strategyDesc}>{strategy === 'saver' ? '少派发，控制调用量' : strategy === 'powerful' ? '积极并行，优先质量' : '按任务复杂度派发'}</span>
            </button>
          ))}
        </div>
      </div>

      <div className={headerStyles.setupStrategy}>
        <div className={headerStyles.setupStrategyLabel}>03 · 生效范围</div>
        <div className={styles.scopeSwitcher} role="group" aria-label="生效范围">
          <button
            type="button"
            className={`${styles.scopeButton} ${setupDraft.scope === 'preset' ? styles.scopeButtonActive : ''}`}
            aria-pressed={setupDraft.scope === 'preset'}
            onClick={() => void handleScopeChange('preset')}
          >
            仅专属预设
          </button>
          <button
            type="button"
            className={`${styles.scopeButton} ${setupDraft.scope === 'global' ? styles.scopeButtonActive : ''}`}
            aria-pressed={setupDraft.scope === 'global'}
            onClick={() => void handleScopeChange('global')}
          >
            所有预设
          </button>
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
        <span className={styles.scopeTag}>{scopeTag}</span>
      </button>

      {open && renderPortal(popover)}

      {pickingExecutor && (
        <ModelPicker
          title="选择 executor 子代理执行模型"
          current={onboarding ? setupDraft.executor : resolved.executor}
          onSelect={handleModelSelect}
          onClose={() => setPickingExecutor(false)}
          fetchModels={fetchModels}
        />
      )}
    </div>
  )
}

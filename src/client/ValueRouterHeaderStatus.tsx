/**
 * 顶栏「价值路由」徽章 + 只读状态气泡。
 *
 * 0.10.0 的契约：**状态面只读**。
 * - 删除了「全局默认 / 仅本会话」写入范围切换、会话覆写写入与重置、
 *   以及 `setSessionOverride` Remote 调用——会话级覆写所依赖的
 *   strategy/executor 契约已退役（配置只有四档线路 + 一条全局兜底）；
 * - 气泡展示：四档线路与可用性、兜底线路、可用/缺失/拦截计数、
 *   本会话派发记录与运行事件；所有写入都在「设置 → 插件」里完成；
 * - 唯一仍会写入的是**首次使用引导**（仅当配置为空时进入）：它写的是全局
 *   设置的兜底线路与总开关，等价于用户自己在设置卡里操作。
 *
 * 0.2.0：删除了「生效范围（专属预设 / 所有预设）」相关的全部 UI 与遥测——
 * 插件对全部预设生效，没有可切换的范围。
 */

import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Context } from '@deepseek-ai/cordis'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { Difficulty, RouteLine, ValueRouterConfig } from '../core/config.ts'
import { DIFFICULTIES, isEmptyConfig, isCompleteLine, resolveConfig } from '../core/config.ts'
import { ModelPicker, type ValueRouterModelCatalog } from './ModelPicker.tsx'
import { useValueRouterConfig } from './useValueRouterConfig.ts'
import {
  useLiveSessionMetrics,
  useLiveStatus,
  type ValueRouterDispatchView,
  type ValueRouterLineView,
  type ValueRouterRouteEventView,
  type ValueRouterRouteSource,
  type ValueRouterStatusView,
} from './use-live-status.ts'
import { en, zh, type ValueRouterLocaleKey } from './locales.ts'
import styles from './value-router.module.css'
import headerStyles from './value-router-header.module.css'
import { reportValueRouterTelemetry } from './telemetry.ts'

export interface ValueRouterHeaderStatusProps {
  config: ValueRouterConfig
  sessionId: string
  configForm?: ConfigForm<ValueRouterConfig>
  onChange: (patch: Partial<ValueRouterConfig>) => Promise<void> | void
  fetchModels?: () => Promise<ValueRouterModelCatalog>
  /** 宿主 client context：传入后经 Remote 直连读宿主侧真实状态与会话计量。 */
  clientCtx?: Context
}

/** 与 ModelPicker 一致的客户端文案取用方式（宿主 locale 注册表在浏览器侧没有 hook）。 */
function t(key: ValueRouterLocaleKey): string {
  return (typeof document !== 'undefined' && document.documentElement.lang.startsWith('en') ? en : zh)[key]
}

const TIER_LABEL: Record<Difficulty, ValueRouterLocaleKey> = {
  low: 'tierLow',
  medium: 'tierMedium',
  high: 'tierHigh',
  max: 'tierMax',
}

function tierText(id: string): string {
  if (id === 'low' || id === 'medium' || id === 'high' || id === 'max') return t(TIER_LABEL[id])
  return id
}

function routeSourceText(source: ValueRouterRouteSource): string | undefined {
  if (source === 'user') return t('routeSourceUser')
  if (source === 'captain') return t('routeSourceCaptain')
  if (source === 'difficulty') return t('routeSourceDifficulty')
  if (source === 'fallback') return t('routeSourceFallback')
  return undefined
}

/** 派发记录的来源列：兜底/降级优先说明，其次线路来源，最后是命中的档位。 */
function dispatchOrigin(record: ValueRouterDispatchView): string {
  if (record.fallback) return t('fallbackUsed')
  if (record.degraded) return t('degradedRoute')
  return routeSourceText(record.routeSource) ?? tierText(record.difficulty)
}

/** 线路的问题标记；`available` 但有 statusDetail 时按「推理强度未校验」提示。 */
function lineMarker(line: ValueRouterLineView): { text: string; detail?: string } | undefined {
  if (line.status === 'missing') return { text: t('lineMissing'), ...(line.statusDetail !== undefined ? { detail: line.statusDetail } : {}) }
  if (line.status === 'blocked') return { text: t('lineBlocked'), ...(line.statusDetail !== undefined ? { detail: line.statusDetail } : {}) }
  if (line.statusDetail !== undefined) return { text: t('lineEffortUnverified'), detail: line.statusDetail }
  return undefined
}

/** 已知事件类型走文案表；未知类型原样显示（不猜含义）。 */
function eventText(event: ValueRouterRouteEventView): string {
  if (event.type === 'route-rejected') return t('routeRejected')
  if (event.type === 'fallback') return t('fallbackUsed')
  if (event.type === 'degrade') return t('degradedRoute')
  if (event.type === 'queue') return t('queued')
  return event.type
}

function lineText(line: { provider: string; model: string }): string {
  return `${line.provider}/${line.model}`
}

function formatLine(line: Partial<RouteLine> | undefined): string {
  return isCompleteLine(line) ? `${line?.provider} / ${line?.model}` : t('notSelected')
}

function renderPortal(node: React.ReactNode): React.ReactNode {
  return typeof document === 'undefined' ? node : createPortal(node, document.body)
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
  const [pickingFallback, setPickingFallback] = useState(false)
  const [setupDraft, setSetupDraft] = useState<Partial<RouteLine>>({})
  const [setupError, setSetupError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const liveConfig = useValueRouterConfig(configForm, config)
  const resolved = resolveConfig(liveConfig)
  const liveStatusResult = useLiveStatus(clientCtx, open)
  const liveStatus = liveStatusResult.data
  const liveStatusError = liveStatusResult.error
  const liveMetrics = useLiveSessionMetrics(clientCtx, sessionId, open)
  // 徽章按会话挂，所以派发记录也按会话取：本会话（含后代子代理）实际跑过哪些模型。
  const sessionDispatches = liveMetrics?.recentDispatches ?? []
  const configured = !isEmptyConfig(resolved)
  const totalLines = resolved.tiers.reduce((sum, tier) => sum + tier.lines.length, 0)
  const unhealthy = liveStatus !== undefined && liveStatus.missingLines + liveStatus.blockedLines > 0
  const stateText = !configured
    ? t('unconfigured')
    : !resolved.enabled
      ? t('disabled')
      : unhealthy
        ? t('degraded')
        : t('enabled')
  const badgeClass = !configured ? styles.badgeDegraded : resolved.enabled ? styles.badgeActive : styles.badgeInactive

  const startOnboarding = (): void => {
    setSetupDraft(isCompleteLine(resolved.fallback) ? { ...resolved.fallback } : {})
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

  const handleCompleteSetup = async (): Promise<void> => {
    if (!isCompleteLine(setupDraft)) {
      setSetupError('请先选择全局兜底线路。四档线路可以稍后到「设置 → 插件」里添加。')
      return
    }
    setSaving(true)
    setSetupError(null)
    try {
      // enabled 单独最后写，避免「部分配置」被提前激活。
      await onChange({ fallback: { provider: setupDraft.provider ?? '', model: setupDraft.model ?? '', reasoning_effort: setupDraft.reasoning_effort ?? '' } })
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

  useEffect(() => {
    if (!open) return
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node
      if (rootRef.current?.contains(target) || panelRef.current?.contains(target)) return
      // 模型选择器单独 portal 到 body：它打开时由自己的遮罩处理外部点击。
      if (pickingFallback) return
      dismissOnboarding()
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (pickingFallback) {
        setPickingFallback(false)
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
  }, [open, onboarding, pickingFallback])

  useEffect(() => {
    if (!open) {
      triggerRef.current?.focus()
      return
    }
    const dialog = pickingFallback
      ? document.querySelector<HTMLElement>('[data-value-router-model-picker="true"] [role="dialog"]')
      : panelRef.current
    dialog?.querySelector<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')?.focus()
  }, [open, onboarding, pickingFallback])

  const renderStatusBody = (status: ValueRouterStatusView): React.ReactElement => (
    <>
      {/* 四档 + 兜底：主线一行一条，问题线路（目录缺失 / 白名单外 / 强度未校验）
          紧跟在该档下面单独成行——整档挤在一行会看不出是哪条线路出了问题。 */}
      <div className={styles.roleSummary}>
        {DIFFICULTIES.map((id) => {
          const tier = status.tiers.find((entry) => entry.id === id)
          const lines = tier?.lines ?? []
          return (
            <React.Fragment key={id}>
              <div className={styles.popoverItem}>
                <span className={styles.popoverItemLabel}>{`${tierText(id)}:`}</span>
                <span className={styles.popoverItemValue}>
                  {lines.length === 0 ? t('tierEmpty') : lines.map((line) => lineText(line)).join(' → ')}
                </span>
              </div>
              {lines.map((line, index) => {
                const marker = lineMarker(line)
                if (marker === undefined) return null
                return (
                  <div className={styles.popoverItem} key={`${id}-${index}`}>
                    <span className={styles.popoverItemLabel}>{lineText(line)}</span>
                    <span className={styles.popoverItemValue} title={marker.detail}>{marker.text}</span>
                  </div>
                )
              })}
            </React.Fragment>
          )
        })}
        <div className={styles.popoverItem}>
          <span className={styles.popoverItemLabel}>{`${t('fallback')}:`}</span>
          <span className={styles.popoverItemValue}>
            {status.fallback.provider !== '' ? lineText(status.fallback) : formatLine(resolved.fallback)}
          </span>
        </div>
        {(() => {
          const marker = lineMarker(status.fallback)
          if (marker === undefined) return null
          return (
            <div className={styles.popoverItem}>
              <span className={styles.popoverItemLabel}>{lineText(status.fallback)}</span>
              <span className={styles.popoverItemValue} title={marker.detail}>{marker.text}</span>
            </div>
          )
        })()}
      </div>

      <div className={styles.statsCard}>
        <div className={styles.statItem}>
          <span className={styles.statItemLabel}>{t('sessionRoutedCalls')}</span>
          <span className={styles.statItemValue}>{`${liveMetrics?.routedCalls ?? 0} ${t('times')}`}</span>
        </div>
        <div className={styles.statItem}>
          <span className={styles.statItemLabel}>{t('totalRoutedCalls')}</span>
          <span className={styles.statItemValue}>{`${status.routedCallsTotal} ${t('times')}`}</span>
        </div>
        <div className={styles.statItem}>
          <span className={styles.statItemLabel}>{t('availableLines')}</span>
          <span className={styles.statItemValue}>{status.availableLines}</span>
        </div>
        <div className={styles.statItem}>
          <span className={styles.statItemLabel}>{t('missingLines')}</span>
          <span className={styles.statItemValue}>{status.missingLines}</span>
        </div>
        <div className={styles.statItem}>
          <span className={styles.statItemLabel}>{t('blockedLines')}</span>
          <span className={styles.statItemValue}>{status.blockedLines}</span>
        </div>
      </div>

      {status.allowlistKnown === false && (
        <div className={styles.fieldHint} role="status">{t('allowlistUnknown')}</div>
      )}
    </>
  )

  const quickPopover = (
    <>
      <div className={headerStyles.popoverHeader}>
        <span className={styles.title}>{t('title')}</span>
        <span className={`${styles.badge} ${badgeClass}`}>{stateText}</span>
      </div>

      {setupError && <div className={headerStyles.setupError} role="alert">{setupError}</div>}

      {liveStatusError !== undefined ? (
        <div className={styles.dispatchEmpty}>状态通道没连上：{liveStatusError}</div>
      ) : liveStatus === undefined ? (
        <div className={styles.dispatchEmpty}>正在连接宿主状态通道…</div>
      ) : renderStatusBody(liveStatus)}

      {/*
        派发记录——「插件到底干了什么」的唯一可观测出口。
        子代理会话头和 subagent 工具的返回都不带模型信息，所以主控和用户在对话里
        无法验证路由是否真的生效；这张表就是验收依据。显示 provider + model 全名，
        否则「同一个模型挂在两家 provider」会看起来像重复。

        **永远渲染**：曾经用 `length > 0` 才渲染，结果「还没派发」和「功能不存在」
        在界面上完全一样；后来又用 `liveStatus &&` 包了一层，于是**状态通道一断，
        整块连同原因一起消失**——用户只会说「哪有」。两种情况都要说出来。
      */}
      <div className={styles.dispatchLog}>
        <div className={styles.dispatchLogHead}>
          {t('recentDispatches')}
          {liveStatus !== undefined && sessionDispatches.length > 0 && `（${sessionDispatches.length}）`}
        </div>
        {liveStatusError !== undefined ? (
          <div className={styles.dispatchEmpty}>状态通道没连上：{liveStatusError}</div>
        ) : liveStatus === undefined ? (
          <div className={styles.dispatchEmpty}>正在连接宿主状态通道…</div>
        ) : sessionDispatches.length === 0 ? (
          <div className={styles.dispatchEmpty}>{t('noDispatches')}</div>
        ) : (
          sessionDispatches.map((record, index) => (
            <div key={index} className={styles.dispatchRow}>
              <span className={styles.dispatchRoute} title={`${record.provider} / ${record.model}`}>
                {record.model}
              </span>
              <span className={styles.dispatchProvider}>{record.provider}</span>
              <span className={styles.dispatchOrigin}>{dispatchOrigin(record)}</span>
            </div>
          ))
        )}
      </div>

      {liveStatus !== undefined && liveStatus.recentEvents.length > 0 && (
        <div className={styles.dispatchLog}>
          <div className={styles.dispatchLogHead}>
            {t('recentEvents')}
            {`（${liveStatus.recentEvents.length}）`}
          </div>
          {liveStatus.recentEvents.map((event, index) => (
            <div className={styles.dispatchRow} key={index}>
              <span className={styles.dispatchRoute} title={event.route !== undefined ? lineText(event.route) : undefined}>
                {event.route !== undefined ? event.route.model : event.member ?? event.taskId ?? t('title')}
              </span>
              <span className={styles.dispatchProvider}>{event.route !== undefined ? event.route.provider : ''}</span>
              <span
                className={styles.dispatchOrigin}
                title={event.type === 'queue' ? `${t('queueReason')}: ${event.queueReason ?? event.detail ?? ''}` : event.detail}
              >
                {eventText(event)}
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  )

  const onboardingPopover = (
    <>
      <div className={headerStyles.setupHeader}>
        <div>
          <div className={headerStyles.setupEyebrow}>{t('onboardingTitle')}</div>
          <h2 className={headerStyles.setupTitle}>{t('title')}</h2>
        </div>
        <button type="button" className={headerStyles.setupClose} aria-label={t('close')} onClick={dismissOnboarding}>×</button>
      </div>
      <p className={headerStyles.setupLead}>{t('onboardingLead')}</p>

      <div className={headerStyles.setupSteps}>
        <div className={`${headerStyles.setupStep} ${isCompleteLine(setupDraft) ? headerStyles.setupStepReady : ''}`}>
          <span className={headerStyles.setupStepNumber}>01</span>
          <div className={headerStyles.setupStepBody}>
            <div className={headerStyles.setupStepHeading}>{t('onboardingStep1')}</div>
            <div className={headerStyles.setupStepValue}>{formatLine(setupDraft)}</div>
            <div className={headerStyles.setupDefaultNote}>{t('fallbackDesc')}</div>
          </div>
          <button type="button" className={`${styles.button} ${headerStyles.setupModelButton}`} onClick={() => setPickingFallback(true)}>
            {isCompleteLine(setupDraft) ? t('change') : t('selectModel')}
          </button>
        </div>
      </div>

      <div className={headerStyles.setupStrategy}>
        <div className={headerStyles.setupStrategyLabel}>{t('onboardingStep2')}</div>
        <p className={headerStyles.setupHint}>{t('tierHint')}</p>
      </div>

      {setupError && <div className={headerStyles.setupError} role="alert">{setupError}</div>}

      <div className={headerStyles.setupFooter}>
        <span className={headerStyles.setupHint}>{t('descSupplement')}</span>
        <button
          type="button"
          className={`${styles.button} ${styles.buttonPrimary} ${headerStyles.setupSubmit}`}
          disabled={saving || !isCompleteLine(setupDraft)}
          onClick={() => void handleCompleteSetup()}
        >
          {saving ? t('onboardingSaving') : t('onboardingComplete')}
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
      aria-label={onboarding ? t('onboardingTitle') : t('quickSettings')}
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
        aria-label={t('quickSettings')}
        onClick={() => {
          if (!open && !configured) startOnboarding()
          else setOpen((value) => !value)
        }}
        title={`${t('headerStatusPrefix')} · ${stateText}`}
      >
        <span aria-hidden="true">VR</span>
        <span className={styles.chipLabel}>{`${t('headerStatusPrefix')} · ${stateText}`}</span>
        {sessionDispatches.length > 0 && (
          // 本会话派发次数：徽章上就能看出"这个会话派过几个子代理"，
          // 不必点开才知道值不值得点。
          <span className={styles.chipCount} title={`${t('recentDispatches')} ${sessionDispatches.length}`}>
            {sessionDispatches.length}
          </span>
        )}
        <span className={styles.chipTag}>
          {liveStatus !== undefined
            ? `${t('availableLines')} ${liveStatus.availableLines}`
            : `${totalLines}`}
        </span>
      </button>

      {open && renderPortal(popover)}

      {pickingFallback && (
        <ModelPicker
          title={onboarding ? t('onboardingStep1') : t('fallback')}
          current={setupDraft}
          selectHighestEffort
          onSelect={(selection) => {
            setSetupDraft(selection)
            setPickingFallback(false)
          }}
          onClose={() => setPickingFallback(false)}
          fetchModels={fetchModels}
        />
      )}
    </div>
  )
}

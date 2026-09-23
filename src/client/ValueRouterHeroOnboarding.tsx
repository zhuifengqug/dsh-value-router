/**
 * 空白会话 Hero 上的「价值路由」配置引导。
 *
 * 官方预设选择器是单一 root slot，因此这份引导以文档级附加面挂载（不替换宿主选择器）：
 * 选 executor → 选策略 → 选生效范围，完成后写全局设置并开启。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ModelRouteSelection, ValueRouterConfig, ValueRouterScope, ValueRouterStrategy } from '../core/config.ts'
import { isCompleteModelRoute, resolveEffectiveConfig, strategyLabel } from '../core/config.ts'
import { ModelPicker, type ValueRouterModelCatalog } from './ModelPicker.tsx'
import { useValueRouterConfig } from './useValueRouterConfig.ts'
import styles from './value-router.module.css'
import headerStyles from './value-router-header.module.css'
import { reportValueRouterTelemetry } from './telemetry.ts'

export interface ValueRouterHeroOnboardingProps {
  config: ValueRouterConfig
  settingsScope: SettingsScope<ValueRouterConfig>
  onChange: (patch: Partial<ValueRouterConfig>) => Promise<void> | void
  fetchModels: () => Promise<ValueRouterModelCatalog>
  onClose: () => void
  initialError?: string | null
}

interface SetupDraft {
  executor: ModelRouteSelection
  strategy: ValueRouterStrategy
  scope: ValueRouterScope
}

function formatModel(route?: ModelRouteSelection): string {
  if (!isCompleteModelRoute(route)) return '未配置'
  return `${route.provider} / ${route.model}`
}

function errorText(reason: unknown, fallback: string): string {
  if (reason instanceof Error && reason.message.trim()) return reason.message.trim()
  if (typeof reason === 'string' && reason.trim()) return reason.trim()
  return fallback
}

export const ValueRouterHeroOnboarding: React.FC<ValueRouterHeroOnboardingProps> = ({
  config,
  settingsScope,
  onChange,
  fetchModels,
  onClose,
  initialError = null,
}) => {
  const liveConfig = useValueRouterConfig(settingsScope, config)
  const resolved = resolveEffectiveConfig(liveConfig)
  const [draft, setDraft] = useState<SetupDraft>(() => ({
    executor: { ...resolved.executor },
    strategy: resolved.strategy,
    scope: resolved.scope,
  }))
  const [pickingExecutor, setPickingExecutor] = useState(false)
  const [error, setError] = useState<string | null>(initialError)
  const [saving, setSaving] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  const completedRef = useRef(false)

  const closeWithDismiss = () => {
    if (!completedRef.current) reportValueRouterTelemetry({ kind: 'onboarding', outcome: 'dismissed', surface: 'hero' })
    onClose()
  }

  useEffect(() => {
    setError(initialError ?? null)
  }, [initialError])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeWithDismiss()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  // 引导可见期间只保留「已有 executor」这一条约束：executor 缺省时保持空，由用户显式选择。
  useEffect(() => {
    setDraft((current) => ({
      ...current,
      executor: isCompleteModelRoute(current.executor) ? current.executor : { ...resolved.executor },
    }))
  }, [resolved.executor.provider, resolved.executor.model, resolved.executor.reasoningEffort])

  const loadModels = useCallback(async (): Promise<ValueRouterModelCatalog> => {
    const catalog = await fetchModels()
    if (isCompleteModelRoute(draft.executor)) {
      const exists = catalog.groups.some((group) => (
        group.id === draft.executor.provider && group.models.some((model) => model.id === draft.executor.model)
      ))
      if (!exists) {
        setError('当前选择的 executor 已不在运行时模型目录中，请重新选择。')
      }
    }
    return catalog
  }, [draft.executor, fetchModels])

  const handleComplete = async (): Promise<void> => {
    if (!isCompleteModelRoute(draft.executor)) {
      setError('请先选择 executor 子代理执行模型。')
      return
    }
    setSaving(true)
    setError(null)
    try {
      // enabled 单独最后写，避免「部分配置」被提前激活。
      await onChange({ executor: draft.executor })
      await onChange({ strategy: draft.strategy })
      await onChange({ scope: draft.scope })
      await onChange({ enabled: true })
      completedRef.current = true
      reportValueRouterTelemetry({ kind: 'onboarding', outcome: 'completed', surface: 'hero' })
      reportValueRouterTelemetry({ kind: 'state', state: 'enabled', source: 'onboarding' })
      onClose()
    } catch (reason) {
      reportValueRouterTelemetry({ kind: 'onboarding', outcome: 'failed', surface: 'hero' })
      setError(errorText(reason, '配置写入失败，请重试。'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div
        ref={dialogRef}
        className={`${styles.popover} ${headerStyles.popover} ${headerStyles.onboardingPopover} ${headerStyles.heroOnboardingPopover}`}
        role="dialog"
        aria-modal="false"
        aria-label="价值路由配置引导"
        data-value-router-hero-onboarding="true"
      >
        <div className={headerStyles.setupHeader}>
          <div>
            <div className={headerStyles.setupEyebrow}>首次设置 · 约 30 秒</div>
            <h2 className={headerStyles.setupTitle}>价值路由</h2>
          </div>
          <button type="button" className={headerStyles.setupClose} aria-label="关闭价值路由引导" onClick={closeWithDismiss}>×</button>
        </div>

        <p className={headerStyles.setupLead}>
          主模型负责理解、拆解与最终交付，executor 只执行下沉的子任务；派发的积极程度由运行策略决定。
        </p>

        <div className={headerStyles.setupSteps}>
          <div className={`${headerStyles.setupStep} ${isCompleteModelRoute(draft.executor) ? headerStyles.setupStepReady : ''}`}>
            <span className={headerStyles.setupStepNumber}>01</span>
            <div className={headerStyles.setupStepBody}>
              <div className={headerStyles.setupStepHeading}>executor 子代理执行模型</div>
              <div className={headerStyles.setupStepValue}>{formatModel(draft.executor)}</div>
              <div className={headerStyles.setupDefaultNote}>模型直接从已配置供应商中选择，无需重新填写 API Key</div>
            </div>
            <button type="button" className={`${styles.button} ${headerStyles.setupModelButton}`} onClick={() => setPickingExecutor(true)}>
              {isCompleteModelRoute(draft.executor) ? '更换' : '选择'}
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
                aria-pressed={draft.strategy === strategy}
                className={`${styles.strategyItem} ${draft.strategy === strategy ? styles.strategyItemSelected : ''}`}
                onClick={() => setDraft((current) => ({ ...current, strategy }))}
              >
                <span className={styles.strategyTitle}>{strategyLabel(strategy)}</span>
                <span className={styles.strategyDesc}>
                  {strategy === 'saver' ? '少派发，控制调用量' : strategy === 'powerful' ? '积极并行，优先质量' : '按任务复杂度派发'}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className={headerStyles.setupStrategy}>
          <div className={headerStyles.setupStrategyLabel}>03 · 生效范围</div>
          <div className={styles.scopeSwitcher} role="group" aria-label="生效范围">
            <button
              type="button"
              className={`${styles.scopeButton} ${draft.scope === 'preset' ? styles.scopeButtonActive : ''}`}
              aria-pressed={draft.scope === 'preset'}
              onClick={() => setDraft((current) => ({ ...current, scope: 'preset' }))}
            >
              仅专属预设
            </button>
            <button
              type="button"
              className={`${styles.scopeButton} ${draft.scope === 'global' ? styles.scopeButtonActive : ''}`}
              aria-pressed={draft.scope === 'global'}
              onClick={() => setDraft((current) => ({ ...current, scope: 'global' }))}
            >
              所有预设
            </button>
          </div>
        </div>

        {error && <div className={headerStyles.setupError} role="alert">{error}</div>}

        <div className={headerStyles.setupFooter}>
          <span className={headerStyles.setupHint}>配置保存在全局设置中，可在完整设置里调整</span>
          <button
            type="button"
            className={`${styles.button} ${styles.buttonPrimary} ${headerStyles.setupSubmit}`}
            disabled={saving || !isCompleteModelRoute(draft.executor)}
            onClick={() => void handleComplete()}
          >
            {saving ? '保存并开启中…' : '完成配置并开启'}
          </button>
        </div>
      </div>

      {pickingExecutor && (
        <ModelPicker
          title="选择 executor 子代理执行模型"
          current={draft.executor}
          onSelect={(selection) => setDraft((current) => ({ ...current, executor: selection }))}
          onClose={() => setPickingExecutor(false)}
          fetchModels={loadModels}
        />
      )}
    </>
  )
}

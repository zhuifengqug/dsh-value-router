/**
 * 「价值路由」完整设置卡（settings.plugin.item 的展开体）。
 *
 * 一个区：enabled / scope / excludePresets / strategy / executor picker /
 * executor 健康提示。executor 健康与累计调用次数走宿主 Remote。
 */

import React, { useCallback, useEffect, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type {
  ModelRouteSelection,
  ValueRouterConfig,
  ValueRouterScope,
  ValueRouterStrategy,
} from '../core/config.ts'
import { isCompleteModelRoute, resolveEffectiveConfig, strategyLabel } from '../core/config.ts'
import { ModelPicker, type ValueRouterModelCatalog } from './ModelPicker.tsx'
import { useValueRouterConfig } from './useValueRouterConfig.ts'
import { useLiveStatus } from './use-live-status.ts'
import styles from './value-router.module.css'
import layout from './value-router-polish.module.css'
import a11y from './value-router-a11y.module.css'
import dockStyles from './value-router-dock.module.css'
import { reportValueRouterTelemetry } from './telemetry.ts'

export interface ValueRouterSettingsCardProps {
  config: ValueRouterConfig
  settingsScope?: SettingsScope<ValueRouterConfig>
  onChange: (patch: Partial<ValueRouterConfig>) => Promise<void> | void
  fetchModels?: () => Promise<ValueRouterModelCatalog>
  /** 宿主 client context：传入后读取 executor 健康 / 累计统计。 */
  clientCtx?: Context
}

const STRATEGIES: readonly ValueRouterStrategy[] = ['saver', 'balanced', 'powerful']

function errorText(reason: unknown, fallback: string): string {
  if (reason instanceof Error && reason.message.trim()) return reason.message.trim()
  if (typeof reason === 'string' && reason.trim()) return reason.trim()
  return fallback
}

function executorStatusText(status: 'active' | 'disabled' | 'unconfigured' | 'degraded'): string {
  return status === 'active' ? '正常' : status === 'unconfigured' ? '未配置' : status === 'degraded' ? '部分模型不可用' : '已关闭'
}

interface SelectFieldProps {
  label: string
  value: string
  options: readonly { value: string; label: string }[]
  onCommit: (value: string) => void
}

const SelectField: React.FC<SelectFieldProps> = ({ label, value, options, onCommit }) => (
  <div className={styles.fieldRow}>
    <span className={styles.fieldLabel}>{label}</span>
    <select
      className={styles.selectInput}
      value={value}
      aria-label={label}
      onChange={(event) => onCommit(event.target.value)}
    >
      {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  </div>
)

export const ValueRouterSettingsCard: React.FC<ValueRouterSettingsCardProps> = ({
  config,
  settingsScope,
  onChange,
  fetchModels,
  clientCtx,
}) => {
  const dock = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('desktop-dock-setting')
  const liveConfig = useValueRouterConfig(settingsScope, config)
  const resolved = resolveEffectiveConfig(liveConfig)
  const configured = isCompleteModelRoute(resolved.executor)
  const [pickingExecutor, setPickingExecutor] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [executorEfforts, setExecutorEfforts] = useState<readonly { readonly id: string; readonly name: string }[]>([])
  const [excludeText, setExcludeText] = useState(resolved.excludePresets.join(', '))
  const liveStatus = useLiveStatus(clientCtx, true)

  const executorComplete = isCompleteModelRoute(resolved.executor)
  const executorProvider = resolved.executor?.provider
  const executorModel = resolved.executor?.model
  const excludeKey = resolved.excludePresets.join(',')

  useEffect(() => { setExcludeText(excludeKey.split(',').filter(Boolean).join(', ')) }, [excludeKey])

  // 推理档位来自运行时目录，因此选择器只能提供 adapter 真正接受的档位。
  useEffect(() => {
    if (!fetchModels || !executorComplete) {
      setExecutorEfforts([])
      return
    }
    let active = true
    void Promise.resolve().then(() => fetchModels()).then((catalog) => {
      if (!active) return
      const model = catalog.groups
        .find((group) => group.id === executorProvider)
        ?.models.find((entry) => entry.id === executorModel)
      setExecutorEfforts(model?.reasoning?.efforts ?? [])
    }).catch(() => { if (active) setExecutorEfforts([]) })
    return () => { active = false }
  }, [executorComplete, executorModel, executorProvider, fetchModels])

  // —— 写入 ——

  const persist = useCallback((patch: Partial<ValueRouterConfig>): void => {
    setSaveError(null)
    void Promise.resolve()
      .then(() => onChange(patch))
      .then(() => {
        if (typeof patch.enabled === 'boolean') {
          reportValueRouterTelemetry({ kind: 'state', state: patch.enabled ? 'enabled' : 'disabled', source: 'settings' })
        }
        if (patch.strategy !== undefined) reportValueRouterTelemetry({ kind: 'strategy', strategy: patch.strategy })
        if (patch.scope !== undefined) reportValueRouterTelemetry({ kind: 'scope', scope: patch.scope })
      })
      .catch((reason) => {
        setSaveError(errorText(reason, '配置写入失败，请重试。'))
        if (typeof patch.enabled === 'boolean') reportValueRouterTelemetry({ kind: 'state', state: 'failed', source: 'settings' })
      })
  }, [onChange])

  const handleToggleEnable = (): void => {
    if (!configured && !resolved.enabled) return
    persist({ enabled: !resolved.enabled })
  }

  const handleModelSelected = (selection: ModelRouteSelection): void => {
    persist({ executor: selection })
  }

  const handleExcludeCommit = (): void => {
    const next = excludeText.split(',').map((item) => item.trim()).filter(Boolean)
    if (next.join(',') === excludeKey) return
    persist({ excludePresets: next })
  }

  return (
    <div className={`${styles.card} ${layout.card}`} data-value-router-card="true">
      <div className={`${styles.header} ${layout.header}`}>
        <div className={`${styles.titleArea} ${layout.titleArea}`}>
          <div className={`${styles.titleRow} ${layout.titleRow}`}>
            <span className={`${styles.title} ${layout.title}`}>价值路由</span>
            <span className={`${styles.badge} ${!configured ? styles.badgeDegraded : resolved.enabled ? styles.badgeActive : styles.badgeInactive}`}>
              {!configured ? '配置不完整' : resolved.enabled ? '已开启' : '已关闭'}
            </span>
          </div>
          <span className={styles.desc}>
            主模型永不被接管：带工具的子任务下沉给 executor 子代理执行，派发的积极程度由运行策略决定。
          </span>
        </div>
        <div className={`${styles.switchArea} ${layout.switchArea}`}>
          <span className={styles.fieldLabel}>{resolved.enabled ? '已开启' : '已关闭'}</span>
          <div
            className={`${styles.toggleSwitch} ${resolved.enabled ? styles.toggleSwitchChecked : ''}`}
            role="switch"
            aria-checked={resolved.enabled}
            aria-label="价值路由开关"
            aria-disabled={!configured && !resolved.enabled}
            tabIndex={0}
            onClick={handleToggleEnable}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); handleToggleEnable() }
            }}
          >
            <div className={styles.toggleKnob} />
          </div>
        </div>
      </div>

      {saveError && <div className={a11y.error} role="alert">{saveError}</div>}

      {dock && !configured && (
        <div className={dockStyles.setupHint}>
          <span>先选择 executor 子代理执行模型，再开启路由。</span>
          <button type="button" className={`${styles.button} ${styles.buttonPrimary}`} onClick={() => setPickingExecutor(true)}>选择执行模型</button>
        </div>
      )}

      {/* —— 路由区 —— */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>路由</div>

        <div className={styles.fieldRow}>
          <span className={styles.fieldLabel}>生效范围</span>
        </div>
        <div className={styles.strategyGroup}>
          {(['preset', 'global'] as ValueRouterScope[]).map((scope) => (
            <button
              type="button"
              key={scope}
              aria-pressed={resolved.scope === scope}
              className={`${styles.strategyItem} ${resolved.scope === scope ? styles.strategyItemSelected : ''}`}
              onClick={() => persist({ scope })}
            >
              <span className={styles.strategyTitle}>{scope === 'preset' ? '仅专属预设' : '所有预设'}</span>
              <span className={styles.strategyDesc}>
                {scope === 'preset' ? '只在「价值路由」预设的会话内生效' : '在所有预设中生效，可用排除清单跳过'}
              </span>
            </button>
          ))}
        </div>

        {resolved.scope === 'global' && (
          <div className={styles.fieldRow}>
            <span className={styles.fieldLabel}>
              排除预设
              <span className={styles.fieldHint}>逗号分隔的预设 id</span>
            </span>
            <input
              className={styles.textInput}
              type="text"
              value={excludeText}
              placeholder="例如：default, writer"
              aria-label="排除预设"
              spellCheck={false}
              onChange={(event) => setExcludeText(event.target.value)}
              onBlur={handleExcludeCommit}
              onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); handleExcludeCommit() } }}
            />
          </div>
        )}

        <div className={`${styles.modelRow} ${layout.modelRow}`}>
          <div className={`${styles.modelInfo} ${layout.modelInfo}`}>
            <div className={styles.modelRole}>executor 子代理执行模型</div>
            <div className={`${styles.modelValue} ${layout.modelValue}`}>
              {isCompleteModelRoute(resolved.executor) ? `${resolved.executor.provider} / ${resolved.executor.model}` : '未配置'}
            </div>
            <div className={`${styles.modelDesc} ${layout.modelDesc}`}>
              只执行主模型派发的单项任务；模型直接从已配置供应商中选择，无需重新填写 API Key。
            </div>
          </div>
          <button
            type="button"
            className={`${styles.button} ${layout.modelAction} ${layout.interactiveButton}`}
            onClick={() => setPickingExecutor(true)}
          >
            {isCompleteModelRoute(resolved.executor) ? '更换' : '选择模型'}
          </button>
        </div>

        {liveStatus && (
          <div className={styles.fieldHint} role="status">
            executor 状态：{executorStatusText(liveStatus.executorStatus)}
            {liveStatus.executorReason ? ` · ${liveStatus.executorReason}` : ''}
            {' · '}累计调用 {liveStatus.executorCallsTotal} 次
          </div>
        )}

        {executorComplete && executorEfforts.length > 0 && (
          <SelectField
            label="executor 推理强度"
            value={resolved.executor.reasoningEffort ?? ''}
            options={[
              { value: '', label: '跟随模型默认' },
              ...executorEfforts.map((effort) => ({ value: effort.id, label: effort.name || effort.id })),
            ]}
            onCommit={(value) => persist({ executor: { ...resolved.executor, reasoningEffort: value } })}
          />
        )}

        <div className={styles.fieldRow}><span className={styles.fieldLabel}>运行策略</span></div>
        <div className={styles.strategyGroup}>
          {STRATEGIES.map((strategy) => (
            <button
              type="button"
              key={strategy}
              aria-pressed={resolved.strategy === strategy}
              className={`${styles.strategyItem} ${resolved.strategy === strategy ? styles.strategyItemSelected : ''}`}
              onClick={() => persist({ strategy })}
            >
              <span className={styles.strategyTitle}>{strategyLabel(strategy)}</span>
              <span className={styles.strategyDesc}>
                {strategy === 'saver' ? '少派发，控制子代理调用量' : strategy === 'powerful' ? '积极并行并要求证据，优先交付质量' : '按任务复杂度派发，重要结果由主模型复核'}
              </span>
            </button>
          ))}
        </div>
      </div>

      {pickingExecutor && (
        <ModelPicker
          title="选择 executor 子代理执行模型"
          current={resolved.executor}
          selectHighestEffort
          onSelect={handleModelSelected}
          onClose={() => setPickingExecutor(false)}
          fetchModels={fetchModels}
        />
      )}
    </div>
  )
}

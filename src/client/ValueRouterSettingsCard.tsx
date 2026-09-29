/**
 * 「价值路由」设置卡（settings.plugin.item）。
 *
 * 0.2.0 的版面变化：
 * - 删掉「生效范围 / 排除预设」——专属预设已摘除，插件对全部预设生效；
 * - 新增**轮转线路池编辑器**：最多 4 条线路，每条带 cheap/mid/strong 档位标注，
 *   并给出「池 2 条 + 3 个子会话 → 线路序列 A,B,A」的实时预览；
 * - `executor` 改称**兜底线路**：只在池为空、或池中目标 provider 不可用时使用。
 */

import React, { useCallback, useMemo, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type {
  ModelRouteSelection,
  PoolLine,
  ValueRouterConfig,
  ValueRouterStrategy,
  ValueRouterTier,
} from '../core/config.ts'
import {
  POOL_MAX_LINES,
  isCompleteModelRoute,
  resolveEffectiveConfig,
  strategyLabel,
  tierLabel,
} from '../core/config.ts'
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
  configForm?: ConfigForm<ValueRouterConfig>
  onChange: (patch: Partial<ValueRouterConfig>) => Promise<void> | void
  fetchModels?: () => Promise<ValueRouterModelCatalog>
  /** 宿主 client context：传入后读取兜底线路健康 / 累计统计。 */
  clientCtx?: Context
}

const STRATEGIES: readonly ValueRouterStrategy[] = ['saver', 'balanced', 'powerful']
const TIERS: readonly ValueRouterTier[] = ['cheap', 'mid', 'strong']

const STRATEGY_DESC: Record<ValueRouterStrategy, string> = {
  saver: '少派发，能自己做的就自己做，控制子代理调用量',
  balanced: '按任务复杂度派发，重要结果由主模型复核',
  powerful: '积极并行并要求返回证据，优先交付质量',
}

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

/** 把会话内即将出现的线路顺序摊开给用户看——轮转是可预测的，值得明示。 */
function rotationPreview(pool: readonly PoolLine[], samples = 4): string {
  if (pool.length === 0) return ''
  return Array.from({ length: samples }, (_, index) => {
    const line = pool[index % pool.length]!
    return `${index + 1}→${line.model}`
  }).join('  ')
}

export const ValueRouterSettingsCard: React.FC<ValueRouterSettingsCardProps> = ({
  config,
  configForm,
  onChange,
  fetchModels,
  clientCtx,
}) => {
  const dock = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('desktop-dock-setting')
  const liveConfig = useValueRouterConfig(configForm, config)
  const resolved = resolveEffectiveConfig(liveConfig)
  const pool = resolved.pool
  const fallbackComplete = isCompleteModelRoute(resolved.executor)
  const usable = pool.length > 0 || fallbackComplete
  const [pickingFallback, setPickingFallback] = useState(false)
  const [pickingFor, setPickingFor] = useState<number | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const liveStatus = useLiveStatus(clientCtx, true)

  const preview = useMemo(() => rotationPreview(pool), [pool])

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
        if (patch.pool !== undefined) reportValueRouterTelemetry({ kind: 'pool', size: patch.pool.length })
      })
      .catch((reason) => {
        setSaveError(errorText(reason, '配置写入失败，请重试。'))
        if (typeof patch.enabled === 'boolean') reportValueRouterTelemetry({ kind: 'state', state: 'failed', source: 'settings' })
      })
  }, [onChange])

  const handleToggleEnable = (): void => {
    if (!usable && !resolved.enabled) return
    persist({ enabled: !resolved.enabled })
  }

  const commitPool = (next: PoolLine[]): void => persist({ pool: next })

  const handleAddLine = (): void => {
    if (pool.length >= POOL_MAX_LINES) return
    commitPool([...pool, { provider: '', model: '', reasoningEffort: '', tier: 'mid' }])
  }

  const handleRemoveLine = (index: number): void => {
    commitPool(pool.filter((_, i) => i !== index))
  }

  const handleMoveLine = (index: number, delta: number): void => {
    const target = index + delta
    if (target < 0 || target >= pool.length) return
    const next = [...pool]
    const [moved] = next.splice(index, 1)
    next.splice(target, 0, moved!)
    commitPool(next)
  }

  const patchLine = (index: number, patch: Partial<PoolLine>): void => {
    commitPool(pool.map((line, i) => (i === index ? { ...line, ...patch } : line)))
  }

  const handleFallbackSelected = (selection: ModelRouteSelection): void => {
    persist({ executor: selection })
  }

  return (
    <div className={`${styles.card} ${layout.card}`} data-value-router-card="true">
      <div className={`${styles.header} ${layout.header}`}>
        <div className={`${styles.titleArea} ${layout.titleArea}`}>
          <div className={`${styles.titleRow} ${layout.titleRow}`}>
            <span className={`${styles.title} ${layout.title}`}>价值路由</span>
            <span className={`${styles.badge} ${!usable ? styles.badgeDegraded : resolved.enabled ? styles.badgeActive : styles.badgeInactive}`}>
              {!usable ? '配置不完整' : resolved.enabled ? '已开启' : '已关闭'}
            </span>
          </div>
          <span className={styles.desc}>
            主模型永不被接管。主控没显式指定线路时，子代理按轮转池依次分配——并行的子代理会落在不同模型上，既补上思考盲区，也避开单条线路的并发瓶颈。对所有预设生效。
          </span>
        </div>
        <div className={`${styles.switchArea} ${layout.switchArea}`}>
          <span className={styles.fieldLabel}>{resolved.enabled ? '已开启' : '已关闭'}</span>
          <div
            className={`${styles.toggleSwitch} ${resolved.enabled ? styles.toggleSwitchChecked : ''}`}
            role="switch"
            aria-checked={resolved.enabled}
            aria-label="价值路由开关"
            aria-disabled={!usable && !resolved.enabled}
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

      {dock && !usable && (
        <div className={dockStyles.setupHint}>
          <span>先添加至少一条轮转线路（或配置兜底线路），再开启路由。</span>
          <button type="button" className={`${styles.button} ${styles.buttonPrimary}`} onClick={handleAddLine}>添加线路</button>
        </div>
      )}

      {/* —— 轮转线路池 —— */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>轮转线路池</div>

        {pool.length === 0 ? (
          <div className={styles.fieldHint}>尚未添加线路。没有池时子代理会继承主模型——那是最贵的一条。</div>
        ) : (
          pool.map((line, index) => {
            const complete = isCompleteModelRoute(line)
            return (
              <div key={index} className={styles.fieldRow} data-value-router-pool-line={String(index)}>
                <span className={styles.fieldLabel}>
                  线路 {index + 1}
                  <span className={styles.fieldHint}>{line.provider ? `${line.provider} / ` : ''}{line.model || '未选择模型'}</span>
                </span>
                <div className={styles.strategyGroup}>
                  <button
                    type="button"
                    className={styles.button}
                    onClick={() => { setPickingFor(index); setPickingFallback(false) }}
                  >
                    {complete ? '更换模型' : '选择模型'}
                  </button>
                  <select
                    className={styles.selectInput}
                    value={line.tier}
                    aria-label={`线路 ${index + 1} 档位`}
                    onChange={(event) => patchLine(index, { tier: event.target.value as ValueRouterTier })}
                  >
                    {TIERS.map((tier) => (
                      <option key={tier} value={tier}>{tierLabel(tier)}档</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className={styles.button}
                    aria-label={`上移线路 ${index + 1}`}
                    disabled={index === 0}
                    onClick={() => handleMoveLine(index, -1)}
                  >↑</button>
                  <button
                    type="button"
                    className={styles.button}
                    aria-label={`下移线路 ${index + 1}`}
                    disabled={index === pool.length - 1}
                    onClick={() => handleMoveLine(index, 1)}
                  >↓</button>
                  <button
                    type="button"
                    className={styles.button}
                    aria-label={`删除线路 ${index + 1}`}
                    onClick={() => handleRemoveLine(index)}
                  >删除</button>
                </div>
              </div>
            )
          })
        )}

        <div className={styles.fieldRow}>
          <button
            type="button"
            className={`${styles.button} ${styles.buttonPrimary}`}
            disabled={pool.length >= POOL_MAX_LINES}
            onClick={handleAddLine}
          >
            {pool.length >= POOL_MAX_LINES ? `已达上限（${POOL_MAX_LINES} 条）` : '添加线路'}
          </button>
          <span className={styles.fieldHint}>
            最多 {POOL_MAX_LINES} 条；多样性收益在 3-4 条饱和。档位只影响给主控的提示文案与这里的排序，不参与路由判据。
          </span>
        </div>

        {preview && (
          <div className={styles.fieldHint} role="status">
            轮转顺序（前 4 个子代理）：{preview}
          </div>
        )}
      </div>

      {/* —— 兜底线路 —— */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>兜底线路</div>

        <div className={`${styles.modelRow} ${layout.modelRow}`}>
          <div className={`${styles.modelInfo} ${layout.modelInfo}`}>
            <div className={styles.modelRole}>兜底线路</div>
            <div className={`${styles.modelValue} ${layout.modelValue}`}>
              {fallbackComplete ? `${resolved.executor.provider} / ${resolved.executor.model}` : '未配置'}
            </div>
            <div className={`${styles.modelDesc} ${layout.modelDesc}`}>
              只在轮转池为空、或池中目标线路的 provider 不可用时才用。宿主本身不提供任何默认线路——没有它，子代理会直接继承主模型。
            </div>
          </div>
          <button
            type="button"
            className={`${styles.button} ${layout.modelAction} ${layout.interactiveButton}`}
            onClick={() => { setPickingFallback(true); setPickingFor(null) }}
          >
            {fallbackComplete ? '更换' : '选择模型'}
          </button>
        </div>

        {liveStatus && (
          <div className={styles.fieldHint} role="status">
            兜底线路状态：{executorStatusText(liveStatus.executorStatus)}
            {liveStatus.executorReason ? ` · ${liveStatus.executorReason}` : ''}
            {' · '}累计改写 {liveStatus.executorCallsTotal} 次
          </div>
        )}
      </div>

      {/* —— 派发倾向 —— */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>派发倾向</div>
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
              <span className={styles.strategyDesc}>{STRATEGY_DESC[strategy]}</span>
            </button>
          ))}
        </div>
        <div className={styles.fieldHint}>
          档位只改写给主控的提示词：让它更激进或更克制地派发子代理，不改变实际线路。
        </div>
      </div>

      {(pickingFallback || pickingFor !== null) && (
        <ModelPicker
          title={pickingFor !== null ? `选择线路 ${pickingFor + 1} 的模型` : '选择兜底线路'}
          current={pickingFor !== null ? pool[pickingFor] : resolved.executor}
          selectHighestEffort
          onSelect={(selection) => {
            if (pickingFor !== null) {
              patchLine(pickingFor, {
                provider: selection.provider ?? '',
                model: selection.model ?? '',
                reasoningEffort: selection.reasoningEffort ?? '',
              })
              setPickingFor(null)
            } else {
              handleFallbackSelected(selection)
              setPickingFallback(false)
            }
          }}
          onClose={() => { setPickingFallback(false); setPickingFor(null) }}
          fetchModels={fetchModels}
        />
      )}
    </div>
  )
}

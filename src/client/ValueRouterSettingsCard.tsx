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
  ResolvedPoolLine,
  Tier,
  TierRouting,
  ValueRouterConfig,
  ValueRouterStrategy,
} from '../core/config.ts'
import {
  isCompleteModelRoute,
  resolveEffectiveConfig,
  routableLines,
  strategyLabel,
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
const TIER_ROUTINGS: readonly TierRouting[] = ['tier-rotate', 'controller']

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

/**
 * 把会话内即将出现的线路顺序摊开给用户看——轮转是可预测的，值得明示。
 * **只显示最低档**：那才是主控不指定时的实际轮转池。
 */
function rotationPreview(pool: readonly ResolvedPoolLine[], samples = 6): string {
  const usable = routableLines(pool)
  if (usable.length === 0) return ''
  return Array.from({ length: samples }, (_, index) => {
    const line = usable[index % usable.length]!
    return `${index + 1}→${line.provider}/${line.model}`
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
  const tierList = resolved.tiers
  const totalLines = tierList.reduce((sum, tier) => sum + tier.pool.length, 0)
  const fallbackComplete = isCompleteModelRoute(resolved.executor)
  const usable = totalLines > 0 || fallbackComplete
  const [pickingFallback, setPickingFallback] = useState(false)
  const [pickingFor, setPickingFor] = useState<{ tier: number; line: number } | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const liveStatus = useLiveStatus(clientCtx, true)

  const liveTiers = liveStatus?.tiers ?? tierList
  const preview = useMemo(
    () => rotationPreview(liveTiers[0]?.pool ?? []),
    [liveTiers],
  )

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
        if (patch.tiers !== undefined) {
          reportValueRouterTelemetry({
            kind: 'pool',
            size: patch.tiers.reduce((sum, tier) => sum + tier.pool.length, 0),
          })
        }
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

  const commitTiers = (next: Tier[]): void => persist({ tiers: next })

  const handleAddTier = (): void => {
    const id = `tier-${tierList.length + 1}`
    commitTiers([...tierList, { id, label: `档${tierList.length + 1}`, pool: [] }])
  }

  const handleRemoveTier = (index: number): void => {
    commitTiers(tierList.filter((_, i) => i !== index))
  }

  const handleMoveTier = (index: number, delta: number): void => {
    const target = index + delta
    if (target < 0 || target >= tierList.length) return
    const next = [...tierList]
    const [moved] = next.splice(index, 1)
    next.splice(target, 0, moved!)
    commitTiers(next)
  }

  const patchTier = (index: number, patch: Partial<Tier>): void => {
    commitTiers(tierList.map((tier, i) => (i === index ? { ...tier, ...patch } : tier)))
  }

  const handleAddLine = (tierIndex: number): void => {
    const tier = tierList[tierIndex]
    if (tier === undefined) return
    patchTier(tierIndex, { pool: [...tier.pool, { provider: '', model: '', reasoningEffort: '' }] })
  }

  const handleRemoveLine = (tierIndex: number, lineIndex: number): void => {
    const tier = tierList[tierIndex]
    if (tier === undefined) return
    patchTier(tierIndex, { pool: tier.pool.filter((_, i) => i !== lineIndex) })
  }

  const handleMoveLine = (tierIndex: number, lineIndex: number, delta: number): void => {
    const tier = tierList[tierIndex]
    if (tier === undefined) return
    const target = lineIndex + delta
    if (target < 0 || target >= tier.pool.length) return
    const pool = [...tier.pool]
    const [moved] = pool.splice(lineIndex, 1)
    pool.splice(target, 0, moved!)
    patchTier(tierIndex, { pool })
  }

  const patchLine = (tierIndex: number, lineIndex: number, patch: Partial<PoolLine>): void => {
    const tier = tierList[tierIndex]
    if (tier === undefined) return
    patchTier(tierIndex, { pool: tier.pool.map((line, i) => (i === lineIndex ? { ...line, ...patch } : line)) })
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
          <span>先添加至少一个档位并放入线路（或配置兜底线路），再开启路由。</span>
          <button type="button" className={`${styles.button} ${styles.buttonPrimary}`} onClick={handleAddTier}>添加档位</button>
        </div>
      )}

      {/* —— 档位线路池：顺序即优先级，第一个 = 最低档 = 兜底轮转池 —— */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>子代理档位与线路池</div>

        {tierList.length === 0 ? (
          <div className={styles.fieldHint}>
            尚未添加档位。没有档位时子代理会继承主模型——那是最贵的一条。
          </div>
        ) : (
          tierList.map((tier, tierIndex) => {
            const isLowest = tierIndex === 0
            const liveTier = liveTiers[tierIndex]
            return (
              <div key={tier.id} className={styles.fieldRow} data-value-router-tier={tier.id}>
                <span className={styles.fieldLabel}>
                  第 {tierIndex + 1} 档
                  <span className={styles.fieldHint}>
                    {isLowest ? '最低档 —— 主控未指定线路时在这里轮转' : '仅在主控显式指定时命中'}
                  </span>
                </span>
                <div className={styles.strategyGroup}>
                  <input
                    className={styles.textInput}
                    type="text"
                    value={tier.label}
                    aria-label={`第 ${tierIndex + 1} 档名称`}
                    spellCheck={false}
                    onChange={(event) => patchTier(tierIndex, { label: event.target.value })}
                  />
                  <button
                    type="button"
                    className={styles.button}
                    aria-label={`上移第 ${tierIndex + 1} 档`}
                    disabled={tierIndex === 0}
                    onClick={() => handleMoveTier(tierIndex, -1)}
                  >↑</button>
                  <button
                    type="button"
                    className={styles.button}
                    aria-label={`下移第 ${tierIndex + 1} 档`}
                    disabled={tierIndex === tierList.length - 1}
                    onClick={() => handleMoveTier(tierIndex, 1)}
                  >↓</button>
                  <button
                    type="button"
                    className={styles.button}
                    aria-label={`删除第 ${tierIndex + 1} 档`}
                    onClick={() => handleRemoveTier(tierIndex)}
                  >删除档位</button>
                </div>

                {tier.pool.length === 0 ? (
                  <div className={styles.fieldHint}>该档还没有线路。</div>
                ) : (
                  tier.pool.map((line, lineIndex) => {
                    const complete = isCompleteModelRoute(line)
                    // allowed 由宿主白名单在 host 侧推导；读不到白名单时全为 true。
                    const allowed = liveTier?.pool[lineIndex]?.allowed ?? line.allowed ?? true
                    return (
                      <div key={lineIndex} className={styles.fieldRow} data-value-router-pool-line={`${tierIndex}-${lineIndex}`}>
                        <span className={styles.fieldLabel}>
                          线路 {lineIndex + 1}
                          <span className={styles.fieldHint}>
                            {line.provider ? `${line.provider} / ` : ''}{line.model || '未选择模型'}
                            {allowed ? '' : ' · 不在宿主白名单，不会被派发'}
                          </span>
                        </span>
                        <div className={styles.strategyGroup}>
                          <button
                            type="button"
                            className={styles.button}
                            onClick={() => { setPickingFor({ tier: tierIndex, line: lineIndex }); setPickingFallback(false) }}
                          >
                            {complete ? '更换模型' : '选择模型'}
                          </button>
                          <button
                            type="button"
                            className={styles.button}
                            aria-label={`上移线路 ${lineIndex + 1}`}
                            disabled={lineIndex === 0}
                            onClick={() => handleMoveLine(tierIndex, lineIndex, -1)}
                          >↑</button>
                          <button
                            type="button"
                            className={styles.button}
                            aria-label={`下移线路 ${lineIndex + 1}`}
                            disabled={lineIndex === tier.pool.length - 1}
                            onClick={() => handleMoveLine(tierIndex, lineIndex, 1)}
                          >↓</button>
                          <button
                            type="button"
                            className={styles.button}
                            aria-label={`删除线路 ${lineIndex + 1}`}
                            onClick={() => handleRemoveLine(tierIndex, lineIndex)}
                          >删除</button>
                        </div>
                      </div>
                    )
                  })
                )}

                <div className={styles.fieldRow}>
                  <button
                    type="button"
                    className={styles.button}
                    onClick={() => handleAddLine(tierIndex)}
                  >
                    添加线路到第 {tierIndex + 1} 档
                  </button>
                </div>
              </div>
            )
          })
        )}

        <div className={styles.fieldRow}>
          <button
            type="button"
            className={`${styles.button} ${styles.buttonPrimary}`}
            onClick={handleAddTier}
          >
            添加档位
          </button>
          <span className={styles.fieldHint}>
            档位数量与名称都不限，<strong>顺序即优先级</strong>：第一个是最低档，也是主控没指定线路时的默认轮转池；
            越靠后的档位只有主控显式指定才会命中。档内顺序同样是轮转顺序（第 N 个子代理拿第 N 条，取模循环）。
            同一个模型可以在多家 provider 各放一条，用来把订阅额度摊开。
          </span>
        </div>

        {preview && (
          <div className={styles.fieldHint} role="status">
            轮转顺序（前 6 个子代理）：{preview}
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
              只在所有档位都没有可派线路、或目标线路的 provider 不可用时才用。宿主本身不提供任何默认线路——没有它，子代理会直接继承主模型。
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

      {/* —— 主控指定线路时的处置 —— */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>主控选档的处理</div>
        <div className={styles.strategyGroup}>
          {TIER_ROUTINGS.map((mode) => (
            <button
              type="button"
              key={mode}
              aria-pressed={resolved.tierRouting === mode}
              className={`${styles.strategyItem} ${resolved.tierRouting === mode ? styles.strategyItemSelected : ''}`}
              onClick={() => persist({ tierRouting: mode })}
            >
              <span className={styles.strategyTitle}>{mode === 'tier-rotate' ? '按档位轮转' : '完全尊重主控'}</span>
              <span className={styles.strategyDesc}>
                {mode === 'tier-rotate'
                  ? '主控判断难度后点名该档的任意一条线路，系统认出它属于哪一档，并在那一档内轮转派发'
                  : '主控点名哪条就用哪条，档内不再轮转'}
              </span>
            </button>
          ))}
        </div>
        <div className={styles.fieldHint}>
          两种模式下，主控<strong>不指定</strong>线路时都落最低档轮转。子代理工具没有「档位」参数，
          主控只能点名具体线路，插件靠查表把线路映射回档位——点名的线路不在任何档里时会直接放行。
        </div>
      </div>

      {(pickingFallback || pickingFor !== null) && (
        <ModelPicker
          title={pickingFor !== null ? `选择第 ${pickingFor.tier + 1} 档 第 ${pickingFor.line + 1} 条线路的模型` : '选择兜底线路'}
          current={pickingFor !== null ? tierList[pickingFor.tier]?.pool[pickingFor.line] : resolved.executor}
          selectHighestEffort
          onSelect={(selection) => {
            if (pickingFor !== null) {
              patchLine(pickingFor.tier, pickingFor.line, {
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

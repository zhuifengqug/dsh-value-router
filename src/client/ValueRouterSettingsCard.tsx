/**
 * 「价值路由」设置卡（settings.plugin.item）。
 *
 * 0.2.0 的版面变化：
 * - 删掉「生效范围 / 排除预设」——专属预设已摘除，插件对全部预设生效；
 * - 新增**轮转线路池编辑器**：最多 4 条线路，每条带 cheap/mid/strong 档位标注，
 *   并给出「池 2 条 + 3 个子会话 → 线路序列 A,B,A」的实时预览；
 * - `executor` 改称**兜底线路**：只在池为空、或池中目标 provider 不可用时使用。
 */

import React, { useCallback, useState } from 'react'
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
import { describeFormState } from './settings-write.ts'
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
 * 轮转序列条——这块面板唯一刻意用力气的地方。
 *
 * 这块面板存在的理由是「子代理会被怎么派出去」，而轮转是个抽象的取模循环；
 * 把它画成一条看得见的编号序列，用户不必读代码就知道并行批次会落在哪几条线上。
 * 只画最低档：那是主控不指定线路时的实际轮转池。
 */
function RotationStrip({ pool }: { pool: readonly ResolvedPoolLine[] }): React.ReactElement | null {
  const usable = routableLines(pool)
  if (usable.length === 0) return null
  return (
    <div className={styles.rotationStrip} role="status">
      <span className={styles.rotationCaption}>派发顺序（第 1 档轮转）</span>
      {Array.from({ length: 6 }, (_, index) => {
        const line = usable[index % usable.length]!
        return (
          <span key={index} className={styles.rotationChip}>
            <span className={styles.rotationChipIndex}>{index + 1}</span>
            <span className={styles.rotationChipModel} title={`${line.provider} / ${line.model}`}>
              {line.provider}/{line.model}
            </span>
          </span>
        )
      })}
    </div>
  )
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
  /**
   * 收起的档位 id 集合。默认只展开第 1 档（真正会被轮转的那档），
   * 其余折叠成一行摘要——档位多起来时全展开会淹没设置面板。
   */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const liveStatusResult = useLiveStatus(clientCtx, true)
  const liveStatus = liveStatusResult.data
  const liveStatusError = liveStatusResult.error

  const liveTiers = liveStatus?.tiers ?? tierList
  const isCollapsed = (id: string, index: number): boolean =>
    collapsed.size === 0 && index > 0 ? true : collapsed.has(id)
  const toggleCollapsed = (id: string): void => {
    setCollapsed((previous) => {
      // 首次交互前用「index>0 即折叠」的隐式默认，显式切换后以用户选择为准。
      const base = previous.size === 0
        ? new Set(tierList.filter((_, index) => index > 0).map(tier => tier.id))
        : new Set(previous)
      if (base.has(id)) base.delete(id)
      else base.add(id)
      return base
    })
  }

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

  /**
   * 「添加线路」直接打开模型选择器——用户不该被要求手打 provider/model。
   * 选定后才把这条线路写进池子；取消则不留下空行。
   * `pendingTier` 为该档下标；`pendingLine` 为已有行时是行号，为 null 表示「新增」。
   */
  const startAddLine = (tierIndex: number): void => {
    setPickingFor({ tier: tierIndex, line: -1 })
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

      {/* 诊断：宿主把「设置文档没送到客户端」和「value-router 命名空间没被服务」
          压成同一句错误文案，这里常驻显示真实状态，省得靠猜。status=ready 后自动消失。 */}
      {configForm && configForm.getSnapshot().status !== 'ready' && (
        <div className={styles.fieldHint} role="status" data-value-router-form-state="true">
          宿主设置文档状态：{describeFormState(configForm.getSnapshot())}
        </div>
      )}

      {dock && !usable && (
        <div className={dockStyles.setupHint}>
          <span>先添加至少一个档位并放入线路（或配置兜底线路），再开启路由。</span>
          <button type="button" className={`${styles.button} ${styles.buttonPrimary}`} onClick={handleAddTier}>添加档位</button>
        </div>
      )}

      {/* —— 档位线路池：顺序即优先级，第一个 = 最低档 = 兜底轮转池 —— */}
      <div className={styles.section}>
        <div className={styles.sectionHead}>
          <span className={styles.sectionTitle}>子代理档位与线路池</span>
          <span className={styles.sectionMeta}>{tierList.length} 档 · {totalLines} 模型</span>
        </div>
        {tierList.length === 0 ? (
          <div className={styles.emptyHint}>
            还没有档位。点下面的「添加档位」，给每档放上你想用的模型。
          </div>
        ) : (
          tierList.map((tier, tierIndex) => {
            const isLowest = tierIndex === 0
            const liveTier = liveTiers[tierIndex]
            const folded = isCollapsed(tier.id, tierIndex)
            const blockedCount = liveTier?.pool.filter(line => !line.allowed).length ?? 0
            return (
              <div
                key={tier.id}
                className={`${styles.tierCard} ${isLowest ? styles.tierCardPrimary : ''}`}
                data-value-router-tier={tier.id}
              >
                <div className={styles.tierHead}>
                  <button
                    type="button"
                    className={styles.tierToggle}
                    aria-expanded={!folded}
                    aria-label={`${folded ? '展开' : '收起'}第 ${tierIndex + 1} 档`}
                    onClick={() => toggleCollapsed(tier.id)}
                  >
                    <span className={`${styles.chevron} ${folded ? '' : styles.chevronOpen}`} aria-hidden="true">›</span>
                  </button>
                  <span className={styles.tierIndex} aria-hidden="true">{tierIndex + 1}</span>
                  <input
                    className={styles.tierNameInput}
                    type="text"
                    value={tier.label}
                    aria-label={`第 ${tierIndex + 1} 档名称`}
                    spellCheck={false}
                    onChange={(event) => patchTier(tierIndex, { label: event.target.value })}
                  />
                  {folded ? (
                    <span className={styles.tierSummary}>
                      {tier.pool.length === 0 ? '空' : tier.pool.map(line => line.model).join(' · ')}
                    </span>
                  ) : (
                    <span className={styles.tierTag}>{isLowest ? '默认轮转' : '按需命中'}</span>
                  )}
                  <div className={styles.tierActions}>
                    <button
                      type="button"
                      className={styles.iconBtn}
                      aria-label={`上移第 ${tierIndex + 1} 档`}
                      disabled={tierIndex === 0}
                      onClick={() => handleMoveTier(tierIndex, -1)}
                    >↑</button>
                    <button
                      type="button"
                      className={styles.iconBtn}
                      aria-label={`下移第 ${tierIndex + 1} 档`}
                      disabled={tierIndex === tierList.length - 1}
                      onClick={() => handleMoveTier(tierIndex, 1)}
                    >↓</button>
                    <button
                      type="button"
                      className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                      aria-label={`删除第 ${tierIndex + 1} 档`}
                      onClick={() => handleRemoveTier(tierIndex)}
                    >✕</button>
                  </div>
                </div>

                {folded ? null : (
                  <>
                {blockedCount > 0 && (
                  <div className={styles.tierWarn}>
                    有 {blockedCount} 条线路不在宿主白名单里，不会被派发。
                  </div>
                )}

                {tier.pool.length === 0 ? (
                  <div className={styles.tierEmpty}>这一档还没有模型</div>
                ) : (
                  <ul className={styles.lineList}>
                    {tier.pool.map((line, lineIndex) => {
                      // allowed 由宿主白名单在 host 侧推导；读不到白名单时全为 true。
                      const allowed = liveTier?.pool[lineIndex]?.allowed ?? line.allowed ?? true
                      return (
                        <li
                          key={lineIndex}
                          className={`${styles.lineRow} ${allowed ? '' : styles.lineRowBlocked}`}
                          data-value-router-pool-line={`${tierIndex}-${lineIndex}`}
                        >
                          <span className={styles.lineName} title={`${line.provider} / ${line.model}`}>
                            {line.model || '未选择模型'}
                            <span className={styles.lineProvider}>{line.provider}</span>
                            {allowed ? '' : <span className={styles.lineBlocked}>不在白名单</span>}
                          </span>
                          <div className={styles.lineActions}>
                            <button
                              type="button"
                              className={styles.linkBtn}
                              onClick={() => { setPickingFor({ tier: tierIndex, line: lineIndex }); setPickingFallback(false) }}
                            >
                              更换
                            </button>
                            <button
                              type="button"
                              className={styles.iconBtn}
                              aria-label={`上移线路 ${lineIndex + 1}`}
                              disabled={lineIndex === 0}
                              onClick={() => handleMoveLine(tierIndex, lineIndex, -1)}
                            >↑</button>
                            <button
                              type="button"
                              className={styles.iconBtn}
                              aria-label={`下移线路 ${lineIndex + 1}`}
                              disabled={lineIndex === tier.pool.length - 1}
                              onClick={() => handleMoveLine(tierIndex, lineIndex, 1)}
                            >↓</button>
                            <button
                              type="button"
                              className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                              aria-label={`删除线路 ${lineIndex + 1}`}
                              onClick={() => handleRemoveLine(tierIndex, lineIndex)}
                            >✕</button>
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                )}

                <button
                  type="button"
                  className={styles.addLineBtn}
                  onClick={() => startAddLine(tierIndex)}
                >
                  + 添加模型
                </button>
                  </>
                )}
              </div>
            )
          })
        )}

        <button
          type="button"
          className={styles.addTierBtn}
          onClick={handleAddTier}
        >
          + 添加档位
        </button>
        <p className={styles.sectionNote}>
          <strong>第 1 档是默认轮转池</strong>：主控没指定线路时，子代理在这里轮流取。
          越靠后的档位只有主控明确点名才会命中。同一个模型可以在多家 provider 各放一条，用来把订阅额度摊开。
        </p>

        <RotationStrip pool={liveTiers[0]?.pool ?? []} />

        {/* 派发记录也放在设置卡里：验收时不必只盯着顶栏气泡。空态/断线都写出来。 */}
        <div className={styles.dispatchLog}>
          <div className={styles.dispatchLogHead}>
            最近派发（全部会话）
            {liveStatus && liveStatus.recentDispatches.length > 0 && `（${liveStatus.recentDispatches.length}）`}
          </div>
          {liveStatusError !== undefined ? (
            <div className={styles.dispatchEmpty}>状态通道没连上：{liveStatusError}</div>
          ) : liveStatus === undefined ? (
            <div className={styles.dispatchEmpty}>正在连接宿主状态通道…</div>
          ) : liveStatus.recentDispatches.length === 0 ? (
            <div className={styles.dispatchEmpty}>
              还没有派发记录。派发子代理后，这里会逐条显示它实际跑在哪个模型上。
            </div>
          ) : (
            liveStatus.recentDispatches.map((record, index) => (
              <div key={index} className={styles.dispatchRow}>
                <span className={styles.dispatchRoute} title={`${record.provider} / ${record.model}`}>
                  {record.model}
                </span>
                <span className={styles.dispatchProvider}>{record.provider}</span>
                <span className={styles.dispatchOrigin}>
                  {record.tierIndex === null ? '兜底' : `第 ${record.tierIndex + 1} 档`}
                </span>
              </div>
            ))
          )}
        </div>
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
              所有档位都没有可用线路时才用。没有它，子代理会直接继承主模型。
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
        <p className={styles.sectionNote}>
          只影响给主控的提示词：让它更激进或更克制地派发，不改变实际线路。
        </p>
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
                  ? '主控点名哪一档里的任意一条线路，就在那档内轮转派发'
                  : '主控点名哪条就用哪条，档内不再轮转'}
              </span>
            </button>
          ))}
        </div>
        <p className={styles.sectionNote}>
          两种模式下，主控<strong>不指定</strong>时都落第 1 档轮转。
        </p>
      </div>

      {(pickingFallback || pickingFor !== null) && (
        <ModelPicker
          title={
            pickingFor === null
              ? '选择兜底线路'
              : pickingFor.line < 0
                ? `为第 ${pickingFor.tier + 1} 档添加线路`
                : `更换第 ${pickingFor.tier + 1} 档 第 ${pickingFor.line + 1} 条线路`
          }
          current={
            pickingFor === null
              ? resolved.executor
              : pickingFor.line < 0
                ? undefined
                : tierList[pickingFor.tier]?.pool[pickingFor.line]
          }
          selectHighestEffort
          onSelect={(selection) => {
            if (pickingFor !== null) {
              const next = {
                provider: selection.provider ?? '',
                model: selection.model ?? '',
                reasoningEffort: selection.reasoningEffort ?? '',
              }
              if (pickingFor.line < 0) {
                // 新增：选完才落盘，取消不留空行
                const tier = tierList[pickingFor.tier]
                if (tier !== undefined) patchTier(pickingFor.tier, { pool: [...tier.pool, next] })
              } else {
                patchLine(pickingFor.tier, pickingFor.line, next)
              }
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

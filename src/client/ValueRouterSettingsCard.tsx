/**
 * 「价值路由」设置卡（settings.plugin.item / settings.section）。
 *
 * 0.10.0 的契约：**四档固定**（low / medium / high / max）+ **一条全局兜底线路**。
 * - 每档是一个有序线路列表，每条线路 = provider + model + reasoning_effort；
 * - 写入是**整对象写入**：`onChange({ tiers })` 永远提交四档的完整新对象，
 *   绝不写索引路径（宿主侧把整份 tiers 当作一个值来处理）；
 * - 线路状态（available / missing / blocked 与 statusDetail）来自宿主只读快照，
 *   按 `provider/model#reasoning_effort` 与本地配置行对齐后展示；
 * - 删除了 0.2.x 的「轮转池 / 档位增删 / 派发倾向 / 主控选档处理」——那些契约已退役。
 */

import React, { useCallback, useEffect, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { Difficulty, RouteLine, ValueRouterConfig } from '../core/config.ts'
import {
  DIFFICULTIES,
  isEmptyConfig,
  isCompleteLine,
  lineKey,
  resolveConfig,
} from '../core/config.ts'
import { ModelPicker, type ValueRouterModelCatalog } from './ModelPicker.tsx'
import { describeFormState } from './settings-write.ts'
import { useValueRouterConfig } from './useValueRouterConfig.ts'
import {
  useLiveStatus,
  type ValueRouterDispatchView,
  type ValueRouterLineStatus,
  type ValueRouterRouteSource,
  type ValueRouterStatusView,
} from './use-live-status.ts'
import { en, zh, type ValueRouterLocaleKey } from './locales.ts'
import styles from './value-router.module.css'
import layout from './value-router-polish.module.css'
import a11y from './value-router-a11y.module.css'
import dockStyles from './value-router-dock.module.css'
import { reportValueRouterTelemetry } from './telemetry.ts'

export interface ValueRouterSettingsCardProps {
  config: ValueRouterConfig
  configForm?: ConfigForm<ValueRouterConfig>
  /** 整对象写入。**不要**用它写索引路径。 */
  onChange: (patch: Partial<ValueRouterConfig>) => Promise<void> | void
  fetchModels?: () => Promise<ValueRouterModelCatalog>
  /** 宿主 client context：传入后读取线路可用性与派发记录。 */
  clientCtx?: Context
}

/** 与 ModelPicker 一致的客户端文案取用方式（宿主 locale 注册表在浏览器侧没有 hook）。 */
function t(key: ValueRouterLocaleKey): string {
  return (typeof document !== 'undefined' && document.documentElement.lang.startsWith('en') ? en : zh)[key]
}

const TIER_TEXT: Record<Difficulty, { label: ValueRouterLocaleKey; desc: ValueRouterLocaleKey }> = {
  low: { label: 'tierLow', desc: 'tierLowDesc' },
  medium: { label: 'tierMedium', desc: 'tierMediumDesc' },
  high: { label: 'tierHigh', desc: 'tierHighDesc' },
  max: { label: 'tierMax', desc: 'tierMaxDesc' },
}

function tierText(id: Difficulty): string {
  return t(TIER_TEXT[id].label)
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

function errorText(reason: unknown, fallback: string): string {
  if (reason instanceof Error && reason.message.trim()) return reason.message.trim()
  if (typeof reason === 'string' && reason.trim()) return reason.trim()
  return fallback
}

function toRouteLine(line: { provider: string; model: string; reasoning_effort: string }): RouteLine {
  return { provider: line.provider, model: line.model, reasoning_effort: line.reasoning_effort }
}

interface LineStatusView {
  status: ValueRouterLineStatus
  detail?: string
}

/** 本地配置行 ↔ 宿主快照行的对齐：按完整线路键匹配，匹配不到就当作可用。 */
function statusOf(live: ValueRouterStatusView | undefined, tierId: Difficulty, line: RouteLine): LineStatusView {
  const tier = live?.tiers.find((entry) => entry.id === tierId)
  const key = lineKey(line)
  const match = tier?.lines.find((entry) => lineKey(entry) === key)
  if (match === undefined) return { status: 'available' }
  return match.statusDetail !== undefined
    ? { status: match.status, detail: match.statusDetail }
    : { status: match.status }
}

interface EffortInputProps {
  value: string
  label: string
  onCommit: (value: string) => void
}

/**
 * 推理强度输入：本地草稿 + 失焦/回车才提交。
 *
 * 每个按键就写一次设置会让整份 tiers 反复落盘，宿主侧的写入是异步的，容易互相踩；
 * 收起键也不是编辑器语义该有的行为。
 */
const EffortInput: React.FC<EffortInputProps> = ({ value, label, onCommit }) => {
  const [draft, setDraft] = useState(value)
  useEffect(() => { setDraft(value) }, [value])
  const commit = (): void => {
    if (draft === value) return
    onCommit(draft.trim())
  }
  return (
    <input
      className={styles.textInput}
      type="text"
      value={draft}
      aria-label={label}
      title={t('reasoningEffortHint')}
      placeholder={t('reasoningEffortDefault')}
      spellCheck={false}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key !== 'Enter') return
        event.preventDefault()
        commit()
      }}
    />
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
  const resolved = resolveConfig(liveConfig)
  const configured = !isEmptyConfig(resolved)
  const totalLines = resolved.tiers.reduce((sum, tier) => sum + tier.lines.length, 0)
  const [pickingFallback, setPickingFallback] = useState(false)
  /** `line < 0` 表示「往这一档新增一条线路」，否则是替换该下标的线路。 */
  const [pending, setPending] = useState<{ tier: Difficulty; line: number } | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  /**
   * 收起的档位集合。缺省只展开第一档，其余折叠成一行摘要——
   * 四档全展开时线路多起来会淹没设置面板。
   */
  const [collapsed, setCollapsed] = useState<ReadonlySet<Difficulty>>(() => new Set<Difficulty>())
  const liveStatusResult = useLiveStatus(clientCtx, true)
  const liveStatus = liveStatusResult.data
  const liveStatusError = liveStatusResult.error

  const isCollapsed = (id: Difficulty, index: number): boolean =>
    collapsed.size === 0 && index > 0 ? true : collapsed.has(id)
  const toggleCollapsed = (id: Difficulty): void => {
    setCollapsed((previous) => {
      // 首次交互前用「index>0 即折叠」的隐式默认，显式切换后以用户选择为准。
      const base = new Set<Difficulty>(
        previous.size === 0 ? DIFFICULTIES.filter((_, index) => index > 0) : previous,
      )
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
        if (patch.tiers !== undefined || patch.fallback !== undefined) {
          const next = resolveConfig({ ...liveConfig, ...patch })
          reportValueRouterTelemetry({
            kind: 'pool',
            size: next.tiers.reduce((sum, tier) => sum + tier.lines.length, 0) + (isCompleteLine(next.fallback) ? 1 : 0),
          })
        }
      })
      .catch((reason) => {
        setSaveError(errorText(reason, t('settingsSaveFailed')))
        if (typeof patch.enabled === 'boolean') reportValueRouterTelemetry({ kind: 'state', state: 'failed', source: 'settings' })
      })
  }, [onChange, liveConfig])

  const readLines = (id: Difficulty): RouteLine[] =>
    resolved.tiers.find((tier) => tier.id === id)?.lines.map(toRouteLine) ?? []

  /**
   * 整对象写入四档：把变更应用到目标档，其余三档按当前配置原样带回。
   * 索引路径写入会产生「半份 tiers」，宿主侧无法区分「未改」与「改空」。
   */
  const commitTierLines = (id: Difficulty, mutate: (lines: RouteLine[]) => RouteLine[]): void => {
    const tiers: NonNullable<ValueRouterConfig['tiers']> = {}
    for (const difficulty of DIFFICULTIES) {
      const lines = readLines(difficulty)
      tiers[difficulty] = { lines: difficulty === id ? mutate(lines) : lines }
    }
    persist({ tiers })
  }

  const handleToggleEnable = (): void => {
    if (!configured && !resolved.enabled) return
    persist({ enabled: !resolved.enabled })
  }

  const moveLine = (id: Difficulty, lineIndex: number, delta: number): void => {
    commitTierLines(id, (lines) => {
      const target = lineIndex + delta
      if (target < 0 || target >= lines.length) return lines
      const next = [...lines]
      const moved = next.splice(lineIndex, 1)[0]
      if (moved === undefined) return lines
      next.splice(target, 0, moved)
      return next
    })
  }

  const removeLine = (id: Difficulty, lineIndex: number): void => {
    commitTierLines(id, (lines) => lines.filter((_, index) => index !== lineIndex))
  }

  const commitEffort = (id: Difficulty, lineIndex: number, reasoningEffort: string): void => {
    commitTierLines(id, (lines) => lines.map((line, index) => (
      index === lineIndex ? { ...line, reasoning_effort: reasoningEffort } : line
    )))
  }

  const handleFallbackSelected = (selection: RouteLine): void => {
    persist({ fallback: toRouteLine(selection) })
  }

  const handleLineSelected = (selection: RouteLine): void => {
    if (pending === null) return
    const next = toRouteLine(selection)
    if (pending.line < 0) {
      // 新增：选完才落盘，取消不留空行
      commitTierLines(pending.tier, (lines) => [...lines, next])
    } else {
      const at = pending.line
      commitTierLines(pending.tier, (lines) => lines.map((line, index) => (index === at ? next : line)))
    }
    setPending(null)
  }

  const fallbackComplete = isCompleteLine(resolved.fallback)

  return (
    <div className={`${styles.card} ${layout.card}`} data-value-router-card="true">
      <div className={`${styles.header} ${layout.header}`}>
        <div className={`${styles.titleArea} ${layout.titleArea}`}>
          <div className={`${styles.titleRow} ${layout.titleRow}`}>
            <span className={`${styles.title} ${layout.title}`}>{t('title')}</span>
            <span className={`${styles.badge} ${!configured ? styles.badgeDegraded : resolved.enabled ? styles.badgeActive : styles.badgeInactive}`}>
              {!configured ? t('unconfigured') : resolved.enabled ? t('enabled') : t('disabled')}
            </span>
          </div>
          <span className={styles.desc}>
            {t('description')}
            {' '}
            {t('descSupplement')}
          </span>
        </div>
        <div className={`${styles.switchArea} ${layout.switchArea}`}>
          <span className={styles.fieldLabel}>{resolved.enabled ? t('enabled') : t('disabled')}</span>
          <div
            className={`${styles.toggleSwitch} ${resolved.enabled ? styles.toggleSwitchChecked : ''}`}
            role="switch"
            aria-checked={resolved.enabled}
            aria-label={t('sectionLabel')}
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

      {/* 诊断：宿主把「设置文档没送到客户端」和「value-router 命名空间没被服务」
          压成同一句错误文案，这里常驻显示真实状态，省得靠猜。status=ready 后自动消失。 */}
      {configForm && configForm.getSnapshot().status !== 'ready' && (
        <div className={styles.fieldHint} role="status" data-value-router-form-state="true">
          宿主设置文档状态：{describeFormState(configForm.getSnapshot())}
        </div>
      )}

      {dock && !configured && (
        <div className={dockStyles.setupHint}>
          <span>先给某一档添加线路，或配置全局兜底线路，再开启路由。</span>
          <button
            type="button"
            className={`${styles.button} ${styles.buttonPrimary}`}
            onClick={() => setPending({ tier: 'low', line: -1 })}
          >
            {t('lineAdd')}
          </button>
        </div>
      )}

      {/* —— 四档线路：档位固定，顺序即优先级 —— */}
      <div className={styles.section}>
        <div className={styles.sectionHead}>
          <span className={styles.sectionTitle}>{t('tiers')}</span>
          {/* 可用线路数是四档配置里最需要一眼看到的一个数，其余（缺失/拦截）在下面单独列。 */}
          <span className={styles.sectionMeta}>
            {liveStatus !== undefined
              ? `${t('availableLines')} ${liveStatus.availableLines}/${totalLines}`
              : `${totalLines}`}
          </span>
        </div>

        {DIFFICULTIES.map((id, tierIndex) => {
          const lines = readLines(id)
          const folded = isCollapsed(id, tierIndex)
          return (
            <div
              key={id}
              className={`${styles.tierCard} ${tierIndex === 0 ? styles.tierCardPrimary : ''}`}
              data-value-router-tier={id}
            >
              <div className={styles.tierHead}>
                <button
                  type="button"
                  className={styles.tierToggle}
                  aria-expanded={!folded}
                  aria-label={tierText(id)}
                  onClick={() => toggleCollapsed(id)}
                >
                  <span className={`${styles.chevron} ${folded ? '' : styles.chevronOpen}`} aria-hidden="true">›</span>
                </button>
                <span className={styles.tierIndex} aria-hidden="true">{tierIndex + 1}</span>
                <span className={styles.tierTag}>{tierText(id)}</span>
                <span className={styles.tierSummary}>
                  {folded
                    ? (lines.length === 0 ? t('tierEmpty') : lines.map((line) => line.model).join(' · '))
                    : t(TIER_TEXT[id].desc)}
                </span>
              </div>

              {folded ? null : (
                <>
                  {lines.length === 0 ? (
                    <div className={styles.tierEmpty}>{t('tierEmpty')}</div>
                  ) : (
                    <ul className={styles.lineList}>
                      {lines.map((line, lineIndex) => {
                        const view = statusOf(liveStatus, id, line)
                        const marker = view.status === 'missing'
                          ? t('lineMissing')
                          : view.status === 'blocked'
                            ? t('lineBlocked')
                            : undefined
                        return (
                          <li
                            key={lineKey(line)}
                            className={`${styles.lineRow} ${view.status === 'available' ? '' : styles.lineRowBlocked}`}
                            data-value-router-line={`${id}-${lineIndex}`}
                          >
                            <span className={styles.lineName} title={`${line.provider} / ${line.model}`}>
                              {line.model || t('notSelected')}
                              <span className={styles.lineProvider}>{line.provider}</span>
                              {marker !== undefined && (
                                <span className={styles.lineBlocked} title={view.detail}>{marker}</span>
                              )}
                              {marker === undefined && view.detail !== undefined && (
                                <span className={styles.lineBlocked} title={view.detail}>{t('lineEffortUnverified')}</span>
                              )}
                            </span>
                            <EffortInput
                              value={line.reasoning_effort}
                              label={`${t('reasoningEffort')} · ${line.provider}/${line.model}`}
                              onCommit={(value) => commitEffort(id, lineIndex, value)}
                            />
                            <div className={styles.lineActions}>
                              <button
                                type="button"
                                className={styles.linkBtn}
                                onClick={() => { setPending({ tier: id, line: lineIndex }); setPickingFallback(false) }}
                              >
                                {t('change')}
                              </button>
                              <button
                                type="button"
                                className={styles.iconBtn}
                                aria-label={t('lineMoveUp')}
                                disabled={lineIndex === 0}
                                onClick={() => moveLine(id, lineIndex, -1)}
                              >↑</button>
                              <button
                                type="button"
                                className={styles.iconBtn}
                                aria-label={t('lineMoveDown')}
                                disabled={lineIndex === lines.length - 1}
                                onClick={() => moveLine(id, lineIndex, 1)}
                              >↓</button>
                              <button
                                type="button"
                                className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                                aria-label={t('lineRemove')}
                                onClick={() => removeLine(id, lineIndex)}
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
                    onClick={() => { setPending({ tier: id, line: -1 }); setPickingFallback(false) }}
                  >
                    + {t('lineAdd')}
                  </button>
                </>
              )}
            </div>
          )
        })}

        <p className={styles.sectionNote}>{t('tierHint')}</p>
        <p className={styles.sectionNote}>{t('reasoningEffortHint')}</p>

        {/* 线路健康：只在有话说的时候渲染——通道断/白名单读不到。
            正常态不占位；「正在连接」与空态由下面的派发记录统一说明。 */}
        {liveStatusError !== undefined ? (
          <div className={styles.fieldHint} role="status">状态通道没连上：{liveStatusError}</div>
        ) : liveStatus !== undefined && liveStatus.allowlistKnown === false ? (
          <div className={styles.fieldHint} role="status">{t('allowlistUnknown')}</div>
        ) : null}

        {/* 派发记录也放在设置卡里：验收时不必只盯着顶栏气泡。空态/断线都写出来。 */}
        <div className={styles.dispatchLog}>
          <div className={styles.dispatchLogHead}>
            {t('recentDispatches')}
            {liveStatus !== undefined && liveStatus.recentDispatches.length > 0 && `（${liveStatus.recentDispatches.length}）`}
          </div>
          {liveStatusError !== undefined ? (
            <div className={styles.dispatchEmpty}>状态通道没连上：{liveStatusError}</div>
          ) : liveStatus === undefined ? (
            <div className={styles.dispatchEmpty}>正在连接宿主状态通道…</div>
          ) : liveStatus.recentDispatches.length === 0 ? (
            <div className={styles.dispatchEmpty}>{t('noDispatches')}</div>
          ) : (
            liveStatus.recentDispatches.map((record, index) => (
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
      </div>

      {/* —— 全局兜底线路 —— */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>{t('fallback')}</div>

        <div className={`${styles.modelRow} ${layout.modelRow}`}>
          <div className={`${styles.modelInfo} ${layout.modelInfo}`}>
            <div className={styles.modelRole}>{t('fallback')}</div>
            <div className={`${styles.modelValue} ${layout.modelValue}`}>
              {fallbackComplete ? `${resolved.fallback.provider} / ${resolved.fallback.model}` : t('notSelected')}
            </div>
            <div className={`${styles.modelDesc} ${layout.modelDesc}`}>{t('fallbackDesc')}</div>
          </div>
          <button
            type="button"
            className={`${styles.button} ${layout.modelAction} ${layout.interactiveButton}`}
            onClick={() => { setPickingFallback(true); setPending(null) }}
          >
            {fallbackComplete ? t('change') : t('selectModel')}
          </button>
        </div>

        <div className={styles.fieldHint} role="status">
          {fallbackComplete
            ? `${t('reasoningEffort')}：${resolved.fallback.reasoning_effort || t('reasoningEffortDefault')}`
            : t('reasoningEffortHint')}
        </div>
      </div>

      {(pickingFallback || pending !== null) && (
        <ModelPicker
          title={
            pickingFallback
              ? t('fallback')
              : pending === null
                ? t('lineAdd')
                : pending.line < 0
                  ? `${t('lineAdd')} · ${tierText(pending.tier)}`
                  : `${t('change')} · ${tierText(pending.tier)}`
          }
          current={
            pickingFallback
              ? (fallbackComplete ? toRouteLine(resolved.fallback) : undefined)
              : pending === null
                ? undefined
                : readLines(pending.tier)[pending.line]
          }
          selectHighestEffort
          onSelect={(selection) => {
            if (pending !== null) {
              handleLineSelected(selection)
              return
            }
            handleFallbackSelected(selection)
            setPickingFallback(false)
          }}
          onClose={() => { setPickingFallback(false); setPending(null) }}
          fetchModels={fetchModels}
        />
      )}
    </div>
  )
}

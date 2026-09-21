/**
 * 「价值路由」完整设置卡（settings.plugin.item 的展开体）。
 *
 * 两个区：
 * - 路由区：enabled / scope / excludePresets / strategy / executor picker / 高级护栏与调参；
 * - 桥配置区：enabled / baseUrl / apiKey / 四槽 modelMap / trustUsage / timeoutMs /
 *   healthCacheTtlMs / maxBatchItems + 桥健康与可用模型列表。
 *
 * 桥模型列表由浏览器直连 `baseUrl + '/models'` 读取；桥健康与累计统计走宿主 Remote。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type {
  BridgeConfig,
  BridgeModelMap,
  FallbackMode,
  ModelRouteSelection,
  ThinkingMode,
  ValueRouterConfig,
  ValueRouterScope,
  ValueRouterStrategy,
  ValueRouterTuning,
} from '../core/config.ts'
import { isCompleteModelRoute, resolveEffectiveConfig, strategyLabel } from '../core/config.ts'
import { ModelPicker, type ValueRouterModelCatalog } from './ModelPicker.tsx'
import { useValueRouterConfig } from './useValueRouterConfig.ts'
import { useLiveStatus } from './use-live-status.ts'
import { fetchBridgeModels, resolveApiKey, resolveBaseUrl } from './bridge-models.ts'
import { readUserLayer } from './settings-write.ts'
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
  /** 宿主 client context：传入后读取桥健康 / 累计统计。 */
  clientCtx?: Context
}

const STRATEGIES: readonly ValueRouterStrategy[] = ['saver', 'balanced', 'powerful']
const THINKING_MODES: readonly ThinkingMode[] = ['off', 'on', 'silent']
const FALLBACK_MODES: readonly FallbackMode[] = ['continue-with-primary', 'skip-delegation', 'ask-user']
const TRUST_USAGE: readonly BridgeConfig['trustUsage'][] = ['auto', 'always', 'never']
const MODEL_MAP_SLOTS: readonly { key: keyof BridgeModelMap; label: string }[] = [
  { key: 'plain', label: '普通问答' },
  { key: 'thinking', label: '深度思考' },
  { key: 'thinkingSearch', label: '思考+联网' },
  { key: 'search', label: '联网搜索' },
]

function errorText(reason: unknown, fallback: string): string {
  if (reason instanceof Error && reason.message.trim()) return reason.message.trim()
  if (typeof reason === 'string' && reason.trim()) return reason.trim()
  return fallback
}

interface NumberFieldProps {
  label: string
  value: number
  min?: number
  hint?: string
  onCommit: (value: number) => void
}

const NumberField: React.FC<NumberFieldProps> = ({ label, value, min = 0, hint, onCommit }) => {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => { setDraft(String(value)) }, [value])
  const commit = (): void => {
    const parsed = Number(draft)
    if (!Number.isFinite(parsed) || parsed < min) { setDraft(String(value)); return }
    const next = Math.floor(parsed)
    if (next !== value) onCommit(next)
  }
  return (
    <div className={styles.fieldRow}>
      <span className={styles.fieldLabel}>
        {label}
        {hint && <span className={styles.fieldHint}>{hint}</span>}
      </span>
      <input
        className={styles.inputNumber}
        type="number"
        min={min}
        value={draft}
        aria-label={label}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commit() } }}
      />
    </div>
  )
}

interface TextFieldProps {
  label: string
  value: string
  hint?: string
  placeholder?: string
  type?: 'text' | 'password'
  onCommit: (value: string) => void
}

const TextField: React.FC<TextFieldProps> = ({ label, value, hint, placeholder, type = 'text', onCommit }) => {
  const [draft, setDraft] = useState(value)
  useEffect(() => { setDraft(value) }, [value])
  const commit = (): void => { if (draft !== value) onCommit(draft.trim()) }
  return (
    <div className={styles.fieldRow}>
      <span className={styles.fieldLabel}>
        {label}
        {hint && <span className={styles.fieldHint}>{hint}</span>}
      </span>
      <input
        className={styles.textInput}
        type={type}
        value={draft}
        placeholder={placeholder}
        aria-label={label}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commit() } }}
      />
    </div>
  )
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

interface CheckFieldProps {
  label: string
  checked: boolean
  hint?: string
  onChange: (checked: boolean) => void
}

const CheckField: React.FC<CheckFieldProps> = ({ label, checked, hint, onChange }) => (
  <label className={styles.checkboxRow}>
    <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    <span>
      {label}
      {hint && <span className={styles.fieldHint}>{hint}</span>}
    </span>
  </label>
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
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [executorEfforts, setExecutorEfforts] = useState<readonly { readonly id: string; readonly name: string }[]>([])
  const [excludeText, setExcludeText] = useState(resolved.excludePresets.join(', '))
  const [bridgeModels, setBridgeModels] = useState<string[]>([])
  const [bridgeError, setBridgeError] = useState<string | null>(null)
  const [bridgeLoading, setBridgeLoading] = useState(false)
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

  /**
   * 桥配置整体写入（宿主 schema 是嵌套对象，逐字段写会互相覆盖）。
   *
   * apiKey 是机密：环境变量兜底进来的值绝不落盘，除非用户在本卡里显式写过。
   */
  const writeBridge = (patch: Partial<BridgeConfig>): void => {
    const userBridge = settingsScope ? readUserLayer(settingsScope, 'bridge') : undefined
    const merged: Record<string, unknown> = { ...resolved.bridge, ...patch }
    if (patch.modelMap) merged.modelMap = { ...resolved.bridge.modelMap, ...patch.modelMap }
    const payload: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(merged)) {
      if (value !== undefined) payload[key] = value
    }
    if (patch.apiKey !== undefined) payload.apiKey = patch.apiKey
    else if (typeof userBridge?.apiKey === 'string' && userBridge.apiKey) payload.apiKey = userBridge.apiKey
    else delete payload.apiKey
    persist({ bridge: payload as unknown as BridgeConfig })
  }

  const currentTuning: Required<ValueRouterTuning> = {
    minEstimatedSavedTokens: resolved.minEstimatedSavedTokens,
    maxDelegationsPerTask: resolved.maxDelegationsPerTask,
    maxDelegationsPerHour: resolved.maxDelegationsPerHour,
    maxConcurrentDelegations: resolved.maxConcurrentDelegations,
    maxRetriesPerRequest: resolved.maxRetriesPerRequest,
    requestTimeoutMs: resolved.requestTimeoutMs,
    maxInputCharacters: resolved.maxInputCharacters,
    maxResultCharacters: resolved.maxResultCharacters,
  }

  const writeTuning = (key: keyof ValueRouterTuning, value: number): void => {
    persist({ tuning: { ...currentTuning, [key]: value } })
  }

  // —— 桥模型列表（浏览器直连） ——

  const loadBridgeModels = useCallback(async (): Promise<void> => {
    setBridgeLoading(true)
    setBridgeError(null)
    const result = await fetchBridgeModels(resolveBaseUrl(liveConfig), resolveApiKey(liveConfig))
    setBridgeModels(result.models)
    setBridgeError(result.error ?? null)
    setBridgeLoading(false)
  }, [liveConfig])

  const loadBridgeModelsRef = useRef(loadBridgeModels)
  loadBridgeModelsRef.current = loadBridgeModels
  useEffect(() => { void loadBridgeModelsRef.current() }, [])

  const bridgeModelOptions = (current: string): readonly { value: string; label: string }[] => {
    const options = [{ value: '', label: '（不单独指定，自动回落）' }]
    for (const id of bridgeModels) options.push({ value: id, label: id })
    if (current && !bridgeModels.includes(current)) options.push({ value: current, label: `${current}（当前值）` })
    return options
  }

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

  const bridgeHealthClass = liveStatus?.bridgeStatus === 'up'
    ? styles.bridgeDotUp
    : liveStatus?.bridgeStatus === 'down'
      ? styles.bridgeDotDown
      : styles.bridgeDotUnknown
  const bridgeHealthLabel = liveStatus?.bridgeStatus === 'up' ? '正常' : liveStatus?.bridgeStatus === 'down' ? '断开' : '未知'

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
            主模型永不被接管：带工具的子任务下沉给 executor 子代理，无工具的单轮问答经本地 Chat2API 桥外发。
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
                {strategy === 'saver' ? '少派发，控制桥与子代理调用量' : strategy === 'powerful' ? '积极并行，优先交付质量' : '按任务复杂度派发，重要结果由主模型复核'}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* —— 桥配置区 —— */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>桥接配置（Chat2API）</div>

        <CheckField
          label="启用桥通道"
          checked={resolved.bridge.enabled}
          hint="关闭后 bridge_* 工具返回 degraded，executor 路由不受影响"
          onChange={(checked) => writeBridge({ enabled: checked })}
        />

        <div className={styles.bridgeHealthRow}>
          <span className={`${styles.bridgeDot} ${bridgeHealthClass}`} aria-hidden="true" />
          <span>桥健康：{bridgeHealthLabel}</span>
          {liveStatus?.bridgeCheckedAt !== undefined && (
            <span className={styles.fieldHint}>{new Date(liveStatus.bridgeCheckedAt).toLocaleTimeString()}</span>
          )}
          {liveStatus?.delegating && <span className={styles.fieldHint}>委派中</span>}
        </div>
        {liveStatus?.bridgeDetail && <div className={styles.fieldHint}>{liveStatus.bridgeDetail}</div>}
        {liveStatus?.lastError && <div className={a11y.error} role="alert">{liveStatus.lastError}</div>}

        <TextField
          label="桥地址"
          value={resolved.bridge.baseUrl}
          placeholder="http://127.0.0.1:8080/v1"
          onCommit={(value) => { if (value) writeBridge({ baseUrl: value }) }}
        />
        <TextField
          label="API Key"
          type="password"
          value={resolved.bridge.apiKey}
          hint="机密字段；环境变量优先，留空表示桥不需要鉴权"
          placeholder="留空表示不需要鉴权"
          onCommit={(value) => writeBridge({ apiKey: value })}
        />

        <div className={styles.fieldRow}><span className={styles.fieldLabel}>模型映射（四槽）</span></div>
        {MODEL_MAP_SLOTS.map((slot) => (
          <SelectField
            key={slot.key}
            label={slot.label}
            value={resolved.bridge.modelMap[slot.key] ?? ''}
            options={bridgeModelOptions(resolved.bridge.modelMap[slot.key] ?? '')}
            onCommit={(value) => writeBridge({ modelMap: { ...resolved.bridge.modelMap, [slot.key]: value } })}
          />
        ))}

        <SelectField
          label="采信桥 usage"
          value={resolved.bridge.trustUsage}
          options={TRUST_USAGE.map((value) => ({
            value,
            label: value === 'auto' ? '自动校验（推荐）' : value === 'always' ? '总是采信' : '一律估算',
          }))}
          onCommit={(value) => writeBridge({ trustUsage: value as BridgeConfig['trustUsage'] })}
        />

        <NumberField label="请求超时（毫秒）" value={resolved.bridge.timeoutMs} min={1000} onCommit={(value) => writeBridge({ timeoutMs: value })} />
        <NumberField label="健康探测缓存（毫秒）" value={resolved.bridge.healthCacheTtlMs} min={1000} onCommit={(value) => writeBridge({ healthCacheTtlMs: value })} />
        <NumberField label="批次最大条目数" value={resolved.bridge.maxBatchItems} min={1} onCommit={(value) => writeBridge({ maxBatchItems: value })} />
        <div className={styles.fieldRow}>
          <span className={styles.fieldLabel}>
            并发数
            <span className={styles.fieldHint}>网页版同账号单路输出，为保证账号安全固定为 1</span>
          </span>
          <span className={a11y.fieldValue}>{resolved.bridge.concurrency}</span>
        </div>

        <div className={styles.fieldRow}>
          <span className={styles.fieldLabel}>
            桥可用模型
            <span className={styles.fieldHint}>{bridgeLoading ? '正在读取…' : `${bridgeModels.length} 个可用模型`}</span>
          </span>
          <button type="button" className={styles.button} disabled={bridgeLoading} onClick={() => void loadBridgeModels()}>刷新</button>
        </div>
        {bridgeError && <div className={styles.fieldHint} role="status">{bridgeError}</div>}
        {!bridgeError && bridgeModels.length === 0 && !bridgeLoading && (
          <div className={styles.fieldHint}>桥未连接或尚未探测到模型；启动 Chat2API 后点击刷新。</div>
        )}
        {bridgeModels.length > 0 && (
          <div className={styles.bridgeModelList}>
            {bridgeModels.map((id) => <span key={id} className={styles.bridgeModelItem}>{id}</span>)}
          </div>
        )}
      </div>

      {/* —— 高级护栏与调参 —— */}
      <div className={styles.accordion}>
        <button
          type="button"
          className={`${styles.accordionHeader} ${a11y.accordionToggle}`}
          aria-expanded={showAdvanced}
          onClick={() => setShowAdvanced((value) => !value)}
        >
          <span>高级护栏与调参</span>
          <span aria-hidden="true">{showAdvanced ? '收起' : '展开'}</span>
        </button>

        {showAdvanced && (
          <div className={styles.accordionBody}>
            <CheckField
              label="自动委派独立问题"
              checked={resolved.autoDelegate}
              hint="关闭后仅在明确要求时调用桥工具"
              onChange={(checked) => persist({ autoDelegate: checked })}
            />
            <CheckField
              label="允许发送脱敏代码片段"
              checked={resolved.allowCodeSnippet}
              hint="默认关闭；仅发送截断 + 脱敏片段"
              onChange={(checked) => persist({ allowCodeSnippet: checked })}
            />
            <CheckField
              label="允许发送本地文件内容"
              checked={resolved.allowLocalFileContent}
              hint="默认关闭；仅发送截断后的片段"
              onChange={(checked) => persist({ allowLocalFileContent: checked })}
            />
            <CheckField
              label="执行命令前需要确认"
              checked={resolved.requireConfirmationForCommands}
              onChange={(checked) => persist({ requireConfirmationForCommands: checked })}
            />

            <SelectField
              label="默认思考模式"
              value={resolved.defaultThinking}
              options={THINKING_MODES.map((value) => ({
                value,
                label: value === 'off' ? '关闭' : value === 'on' ? '开启' : '静默',
              }))}
              onCommit={(value) => persist({ defaultThinking: value as ThinkingMode })}
            />
            <SelectField
              label="回退模式"
              value={resolved.fallbackMode}
              options={FALLBACK_MODES.map((value) => ({
                value,
                label: value === 'continue-with-primary' ? '不可用时回退主模型' : value === 'skip-delegation' ? '跳过委派' : '询问用户',
              }))}
              onCommit={(value) => persist({ fallbackMode: value as FallbackMode })}
            />

            <NumberField label="子代理最大深度" value={resolved.maxDepth} min={0} onCommit={(value) => persist({ maxDepth: value })} />

            <div className={styles.fieldRow}>
              <span className={styles.fieldLabel}>
                策略推导值
                <span className={styles.fieldHint}>下列字段显式覆盖策略推导值</span>
              </span>
            </div>
            <NumberField label="最小预估节省 Token" value={resolved.minEstimatedSavedTokens} onCommit={(value) => writeTuning('minEstimatedSavedTokens', value)} />
            <NumberField label="单任务最大委派次数" value={resolved.maxDelegationsPerTask} min={1} onCommit={(value) => writeTuning('maxDelegationsPerTask', value)} />
            <NumberField label="每小时最大委派次数" value={resolved.maxDelegationsPerHour} min={1} onCommit={(value) => writeTuning('maxDelegationsPerHour', value)} />
            <NumberField label="单请求最大重试" value={resolved.maxRetriesPerRequest} onCommit={(value) => writeTuning('maxRetriesPerRequest', value)} />
            <NumberField label="护栏请求超时（毫秒）" value={resolved.requestTimeoutMs} min={1000} onCommit={(value) => writeTuning('requestTimeoutMs', value)} />
            <NumberField label="最大输入字符数" value={resolved.maxInputCharacters} min={1} onCommit={(value) => writeTuning('maxInputCharacters', value)} />
            <NumberField label="最大结果字符数" value={resolved.maxResultCharacters} min={1} onCommit={(value) => writeTuning('maxResultCharacters', value)} />
            <div className={styles.fieldRow}>
              <span className={styles.fieldLabel}>
                最大并发委派
                <span className={styles.fieldHint}>固定为 1（网页版同账号单路输出）</span>
              </span>
              <span className={a11y.fieldValue}>{resolved.maxConcurrentDelegations}</span>
            </div>
          </div>
        )}
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

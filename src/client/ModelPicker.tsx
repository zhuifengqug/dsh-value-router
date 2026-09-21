/**
 * 模型选择器（executor 选择用）。
 *
 * 保留来源插件的键盘行为：Esc 关闭、Tab 在对话框内循环、关闭后把焦点还给
 * 触发元素；模型与推理档位只来自运行时目录，客户端不猜任何模型 id。
 */

import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ModelRouteSelection } from '../core/config.ts'
import { en, zh, type ValueRouterLocaleKey } from './locales.ts'
import styles from './value-router.module.css'
import layout from './value-router-polish.module.css'
import picker from './value-router-picker.module.css'

/** 宿主模型目录线上形状的结构镜像（dsh-api-session-controller）。 */
export interface ValueRouterModelEffort {
  readonly id: string
  readonly name: string
  readonly description?: string
}
export interface ValueRouterModelEntry {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly reasoning?: {
    readonly efforts: readonly ValueRouterModelEffort[]
    readonly defaultEffort?: string
  }
}
export interface ValueRouterModelGroup {
  readonly id: string
  readonly name: string
  readonly models: readonly ValueRouterModelEntry[]
}
export interface ValueRouterModelCatalogFailure {
  readonly id: string
  readonly name: string
  readonly message: string
}

export interface ValueRouterModelCatalog {
  /** 当前已注册 provider 路由暴露的模型。 */
  groups: readonly ValueRouterModelGroup[]
  /** provider 局部读取失败；成功的分组仍可选择。 */
  failures?: readonly ValueRouterModelCatalogFailure[]
}

export interface ModelPickerProps {
  title: string
  current?: ModelRouteSelection
  onSelect: (selection: ModelRouteSelection) => void
  onClose: () => void
  fetchModels?: () => Promise<ValueRouterModelCatalog>
  /** 选中模型支持的最强档位，而不是目录默认档位。 */
  selectHighestEffort?: boolean
}

/** 已知档位 id 的强度排序；未知 id 回落到 adapter 的展示顺序。 */
const EFFORT_RANK: Readonly<Record<string, number>> = { minimal: 1, min: 1, low: 2, medium: 3, mid: 3, high: 4, max: 5 }

/** 目录模型支持的最强档位；只有未知 id 时按展示顺序（升序）取最后一个。 */
export function highestEffortId(reasoning: { readonly efforts?: readonly { readonly id: string }[] } | undefined): string | undefined {
  const efforts = reasoning?.efforts ?? []
  if (efforts.length === 0) return undefined
  const ranked = efforts.filter((effort) => EFFORT_RANK[effort.id.toLowerCase()] !== undefined)
  if (ranked.length === 0) return efforts[efforts.length - 1]?.id
  let best = ranked[0]
  for (const effort of ranked) {
    if ((EFFORT_RANK[effort.id.toLowerCase()] ?? 0) >= (EFFORT_RANK[best.id.toLowerCase()] ?? 0)) best = effort
  }
  return best?.id
}

function catalogText(key: ValueRouterLocaleKey): string {
  return (typeof document !== 'undefined' && document.documentElement.lang.startsWith('en') ? en : zh)[key]
}

function errorText(reason: unknown): string {
  if (reason instanceof Error && reason.message.trim()) return reason.message.trim()
  if (typeof reason === 'string' && reason.trim()) return reason.trim()
  return catalogText('catalogLoadFailed')
}

export const ModelPicker: React.FC<ModelPickerProps> = ({ title, current, onSelect, onClose, fetchModels, selectHighestEffort = false }) => {
  const [groups, setGroups] = useState<readonly ValueRouterModelGroup[]>([])
  const [failures, setFailures] = useState<readonly ValueRouterModelCatalogFailure[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    dialogRef.current?.querySelector<HTMLElement>('button:not([disabled]), [tabindex]:not([tabindex="-1"])')?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }
      if (event.key !== 'Tab') return
      const controls = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex="0"]') ?? [])]
      const first = controls[0]
      const last = controls[controls.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      if (previous?.isConnected) previous.focus()
    }
  }, [onClose])

  useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)
    setGroups([])
    setFailures([])

    if (!fetchModels) {
      setError(catalogText('catalogUnavailable'))
      setLoading(false)
      return () => { active = false }
    }

    // 同时为通过这个公开组件 API 传入的第三方 loader 加上时限。
    const timer = setTimeout(() => {
      if (!active) return
      active = false
      setError(catalogText('catalogTimeout'))
      setLoading(false)
    }, 12_000)
    void Promise.resolve().then(() => fetchModels()).then((result) => {
      if (!active) return
      setGroups(result.groups ?? [])
      setFailures(result.failures ?? [])
      setLoading(false)
    }).catch((reason) => {
      if (!active) return
      setError(errorText(reason))
      setLoading(false)
    }).finally(() => clearTimeout(timer))
    return () => { active = false; clearTimeout(timer) }
  }, [fetchModels, reloadToken])

  const choiceCount = groups.reduce((count, group) => count + group.models.length, 0)
  const hasFailures = failures.length > 0

  const pickerContent = (
    <div className={`${styles.modalBackdrop} ${layout.modalBackdrop}`} role="presentation" data-value-router-model-picker="true" onClick={onClose}>
      <div
        ref={dialogRef}
        className={`${styles.modalContent} ${layout.modalContent}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <div className={styles.header}>
          <div className={styles.titleArea}>
            <div className={styles.title}>{title}</div>
            <div className={`${styles.desc} ${picker.subtitle}`}>仅显示已配置并可访问的供应商模型，不会读取或填写 API Key。</div>
          </div>
          <button type="button" className={styles.button} aria-label="关闭模型选择器" onClick={onClose}>×</button>
        </div>

        {loading && <div className={styles.desc} role="status">加载已配置模型列表中...</div>}

        {error && (
          <div className={picker.errorPanel} role="alert">
            <div className={picker.errorMessage}>{error}</div>
            <button type="button" className={styles.button} onClick={() => setReloadToken((value) => value + 1)}>重试</button>
          </div>
        )}

        {!loading && hasFailures && (
          <div className={picker.failurePanel} role="status">
            <div className={picker.failureTitle}>
              {choiceCount > 0 ? '部分供应商暂时无法读取模型，已成功加载的模型仍可选择。' : '已配置供应商暂时无法读取模型。'}
            </div>
            {failures.map((failure) => (
              <div className={picker.failureItem} key={`${failure.id}:${failure.message}`}>
                <span className={picker.failureProvider}>{failure.name || failure.id}</span>
                <span>{failure.message.trim() || '模型列表读取失败。'}</span>
              </div>
            ))}
          </div>
        )}

        {!loading && groups.length === 0 && !error && !hasFailures && (
          <div className={styles.desc} role="status">暂无已配置的模型。请先在 DeepSeek Harness 设置中添加并启用供应商。</div>
        )}

        <div className={`${styles.modelList} ${layout.modelList}`}>
          {groups.map((group) => (
            <div key={group.id}>
              <div className={`${styles.providerGroup} ${picker.providerLabel}`}>
                <span>{group.name || group.id}</span>
                <span className={picker.providerCount}>{group.models.length} 个模型</span>
              </div>
              {group.models.map((model) => {
                const selected = current?.provider === group.id && current?.model === model.id
                const reasoningDefault = model.reasoning?.defaultEffort
                return (
                  <button
                    type="button"
                    key={`${group.id}:${model.id}`}
                    className={`${styles.modelOption} ${picker.optionButton} ${selected ? styles.modelOptionSelected : ''}`}
                    aria-pressed={selected}
                    data-model-provider={group.id}
                    data-model-id={model.id}
                    data-testid={`value-router-model-${model.id}`}
                    onClick={() => {
                      const effort = selectHighestEffort ? highestEffortId(model.reasoning) : reasoningDefault
                      onSelect({
                        provider: group.id,
                        model: model.id,
                        ...(effort ? { reasoningEffort: effort } : {}),
                      })
                      onClose()
                    }}
                  >
                    <span className={picker.modelLine}>
                      <span className={picker.modelName}>{model.name || model.id}</span>
                      {selected && <span className={picker.selectedBadge}>当前</span>}
                    </span>
                    <span className={picker.modelId}>{group.id} / {model.id}</span>
                    {model.description && <span className={picker.modelDescription}>{model.description}</span>}
                  </button>
                )
              })}
            </div>
          ))}
        </div>

        <div className={picker.footer}>
          <span className={picker.footerHint}>{choiceCount > 0 ? `${choiceCount} 个可用模型` : '模型来自当前运行时目录'}</span>
          <button type="button" className={styles.button} onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  )

  // Dock 拥有独立的滚动/层叠上下文；把选择器留在表单内以便继承主题变量。
  return typeof document === 'undefined' || document.querySelector('[data-dsh-dock-settings]')
    ? pickerContent
    : createPortal(pickerContent, document.body)
}

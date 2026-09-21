/**
 * @module @gjs27/dsh-value-router/client
 * 价值路由（Value Router）浏览器侧。
 *
 * 三个注册面：
 * - settings.plugin.item → 「插件」设置区的卡片（路由区 + 桥配置区）；
 * - conversation.session.header.actions → 顶栏徽章 + 快捷设置气泡（含会话级覆写）；
 * - 文档级附加面 → 空白会话 Hero 上的首次引导（不替换官方预设选择器）。
 *
 * 本文件用 React.createElement（不写 JSX）：入口是 loader 直接执行的经典脚本，
 * 保持零 jsx 变换假设。.tsx 组件照常使用 JSX。
 */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SettingsScope, SettingsScopeSpec } from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'

import type { ValueRouterConfig } from '../core/config.ts'
import { VALUE_ROUTER_SETTINGS_NAMESPACE, isCompleteModelRoute } from '../core/config.ts'
import { zh, en, type ValueRouterLocaleKey } from './locales.ts'
import { ValueRouterSettingsCard } from './ValueRouterSettingsCard.tsx'
import { ValueRouterPluginSettingsCard } from './ValueRouterPluginSettingsCard.tsx'
import { ValueRouterHeaderStatus } from './ValueRouterHeaderStatus.tsx'
import { ValueRouterHeroOnboarding } from './ValueRouterHeroOnboarding.tsx'
import type { ValueRouterModelCatalog } from './ModelPicker.tsx'
import { reportValueRouterTelemetry } from './telemetry.ts'
import { createModelCatalogLoader } from './model-catalog.ts'
import { createValueRouterSettingsWriter } from './settings-write.ts'

export { ValueRouterSettingsCard } from './ValueRouterSettingsCard.tsx'
export { ValueRouterPluginSettingsCard } from './ValueRouterPluginSettingsCard.tsx'
export { ValueRouterHeaderStatus } from './ValueRouterHeaderStatus.tsx'
export { ValueRouterHeroOnboarding } from './ValueRouterHeroOnboarding.tsx'
export { ModelPicker } from './ModelPicker.tsx'
export * from './locales.ts'
export * from './use-live-status.ts'
export * from './bridge-models.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'value-router': ValueRouterLocaleKey
  }

  interface SlotMap {
    'settings.plugin.item': { kind: 'keyed'; scope: 'root'; owner: SettingsPluginItemOwnerProps }
  }
}

export interface SettingsPluginItemOwnerProps {
  children?: never
}

interface SettingsBinderFace {
  bind<S>(spec: SettingsScopeSpec<S>): SettingsScope<S>
}

function isSettingsBinderFace(value: unknown): value is SettingsBinderFace {
  return typeof value === 'object' && value !== null && typeof (value as { bind?: unknown }).bind === 'function'
}

export const inject = ['slots', 'locale', 'connection', 'settingsScope', 'remote', 'remote.session']

interface HeroOnboardingMountOptions {
  scope: SettingsScope<ValueRouterConfig>
  onChange: (patch: Partial<ValueRouterConfig>) => Promise<void>
  fetchModels: () => Promise<ValueRouterModelCatalog>
}

const PRESET_MATCH = /价值路由|value\s*router|value-router/i

function heroPresetButton(): HTMLButtonElement | undefined {
  const candidates = [...document.querySelectorAll<HTMLButtonElement>('button')]
  return candidates.find((button) => {
    const metadata = `${button.getAttribute('title') ?? ''} ${button.getAttribute('aria-label') ?? ''} ${button.dataset.testid ?? ''}`
    return /agent\s*(preset|预设)|agent\s*预设|预设/i.test(metadata)
  })
}

function isValueRouterHeroButton(button: HTMLButtonElement): boolean {
  const label = `${button.textContent ?? ''} ${button.getAttribute('aria-label') ?? ''}`
  return PRESET_MATCH.test(label)
}

function errorText(reason: unknown): string {
  if (reason instanceof Error && reason.message.trim()) return reason.message.trim()
  if (typeof reason === 'string' && reason.trim()) return reason.trim()
  return '价值路由自动开启失败，请打开设置重试。'
}

/**
 * 官方空白会话预设座位是官方 UI 独占的 single root slot。保留该选择器不动，
 * 把配置引导作为跟随其渲染状态的文档级附加面挂载。
 */
function mountHeroOnboarding({ scope, onChange, fetchModels }: HeroOnboardingMountOptions): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined' || !document.body) return () => {}

  const container = document.createElement('div')
  container.dataset.dshValueRouterHeroOnboardingRoot = ''
  document.body.appendChild(container)
  let root: Root | undefined = createRoot(container)
  let preset: 'value-router' | 'other' | undefined
  let open = false
  let dismissed = false
  let enableRequested = false
  let setupError: string | null = null
  let scanQueued = false

  const configuredNow = (): boolean => isCompleteModelRoute((scope.getSnapshot().value ?? {}).executor)

  const render = (): void => {
    root?.render(open ? createElement(ValueRouterHeroOnboarding, {
      config: scope.getSnapshot().value ?? {},
      settingsScope: scope,
      onChange,
      fetchModels,
      initialError: setupError,
      onClose: () => {
        open = false
        dismissed = true
        root?.render(null)
      },
    }) : null)
  }

  const enableConfiguredMode = (): void => {
    if (enableRequested) return
    enableRequested = true
    void Promise.resolve()
      .then(() => onChange({ enabled: true }))
      .then(() => reportValueRouterTelemetry({ kind: 'state', state: 'enabled', source: 'auto' }))
      .catch((reason) => {
        enableRequested = false
        setupError = errorText(reason)
        reportValueRouterTelemetry({ kind: 'state', state: 'failed', source: 'auto' })
        open = true
        dismissed = false
        render()
      })
  }

  const syncPreset = (next: 'value-router' | 'other'): void => {
    const entered = preset !== 'value-router' && next === 'value-router'
    if (next !== 'value-router') {
      preset = next
      open = false
      dismissed = false
      enableRequested = false
      setupError = null
      render()
      return
    }

    preset = next
    if (entered) {
      dismissed = false
      setupError = null
      enableRequested = false
      reportValueRouterTelemetry({
        kind: 'entry',
        source: 'hero',
        configured: configuredNow(),
      }, 'value-router-entry')
    }
    if (dismissed || open) return

    const config = scope.getSnapshot().value ?? {}
    if (isCompleteModelRoute(config.executor)) {
      if (config.enabled !== true) enableConfiguredMode()
      return
    }

    open = true
    reportValueRouterTelemetry({ kind: 'onboarding', outcome: 'shown', surface: 'hero' }, 'value-router-onboarding-shown:hero')
    render()
  }

  const scan = (): void => {
    scanQueued = false
    const button = heroPresetButton()
    if (!button) return
    syncPreset(isValueRouterHeroButton(button) ? 'value-router' : 'other')
  }

  const onPresetMenuClick = (event: MouseEvent): void => {
    const target = event.target as HTMLElement | null
    const item = target?.closest<HTMLElement>('[role="menuitem"]')
    if (!item || !PRESET_MATCH.test(item.textContent ?? '')) return
    // 再次选择已经选中的预设，本身就是「我关掉引导后仍要继续配置」的明确意图。
    dismissed = false
    setupError = null
    syncPreset('value-router')
  }

  const observer = new MutationObserver(() => {
    if (scanQueued) return
    scanQueued = true
    queueMicrotask(scan)
  })
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['title', 'aria-label'],
  })
  document.addEventListener('click', onPresetMenuClick)
  scan()

  return () => {
    observer.disconnect()
    document.removeEventListener('click', onPresetMenuClick)
    root?.unmount()
    root = undefined
    container.remove()
  }
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register('value-router', { zh, en }), 'value-router: locales')

  const compatibilityBinder = (ctx.get as (name: string) => unknown)('webUiSettings')
  const binder = isSettingsBinderFace(compatibilityBinder) ? compatibilityBinder : ctx.settingsScope
  const scope = binder.bind<ValueRouterConfig>({ namespace: VALUE_ROUTER_SETTINGS_NAMESPACE as string })

  const fetchModels = createModelCatalogLoader(ctx, ctx.locale.bind('value-router'))
  const onChange = createValueRouterSettingsWriter(scope, ctx.locale.bind('value-router'))

  ctx.effect(
    () => mountHeroOnboarding({ scope, onChange, fetchModels }),
    'value-router: blank-session onboarding',
  )

  // 「设置 → 插件 → 插件配置」按设置 namespace 派发卡片：只有 `key` 命中宿主已服务
  // namespace 的 settings.plugin.item 条目才会渲染，与宿主 installSection 注册的
  // `value-router` 段配对。
  ctx.slots.inject('settings.plugin.item', () =>
    ctx.slots.register(
      {
        name: 'settings.plugin.item',
        key: VALUE_ROUTER_SETTINGS_NAMESPACE,
        locale: 'value-router',
        inject: () => ({
          config: scope.getSnapshot().value ?? {} as ValueRouterConfig,
          settingsScope: scope,
          onChange,
          fetchModels,
          clientCtx: ctx,
        }),
      },
      ValueRouterPluginSettingsCard,
    ),
  )

  ctx.slots.inject('conversation.session.header.actions', () =>
    ctx.slots.register(
      {
        name: 'conversation.session.header.actions',
        id: 'value-router-status',
        order: -8,
        inject: () => ({
          config: scope.getSnapshot().value ?? {} as ValueRouterConfig,
          settingsScope: scope,
          onChange,
          fetchModels,
          clientCtx: ctx,
        }),
      },
      ValueRouterHeaderStatus,
    ),
  )
}

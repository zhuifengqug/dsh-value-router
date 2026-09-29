/**
 * @module @gjs27/dsh-value-router/client
 * 价值路由（Value Router）浏览器侧。
 *
 * 两个注册面：
 * - settings.plugin.item → 「插件」设置区的卡片（轮转池 + 档位 + 兜底线路）；
 * - conversation.session.header.actions → 顶栏徽章 + 快捷设置气泡（含会话级覆写）。
 *
 * 0.2.0 的两处宿主适配：
 * - `ctx.settingsScope` 服务在 DSH 0.1.7-rc.2 里改名为 `ctx.configForms`，
 *   `SettingsScope<T>` 改名为 `ConfigForm<T>`（入口是 `configForms.get(entryId)`）。
 * - **删除了空白会话 Hero 上的首次引导整条链路**。它靠 DOM 文本匹配
 *   （`/价值路由|value\s*router|value-router/i`）去认官方预设选择器里的「价值路由」
 *   按钮；专属预设摘除后那个按钮永远不会出现，整块引导是死代码。
 *
 * 本文件用 React.createElement（不写 JSX）：入口是 loader 直接执行的经典脚本，
 * 保持零 jsx 变换假设。.tsx 组件照常使用 JSX。
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'

import type { ValueRouterConfig } from '../core/config.ts'
import { VALUE_ROUTER_SETTINGS_NAMESPACE } from '../core/config.ts'
import { zh, en, type ValueRouterLocaleKey } from './locales.ts'
import { ValueRouterSettingsCard } from './ValueRouterSettingsCard.tsx'
import { ValueRouterHeaderStatus } from './ValueRouterHeaderStatus.tsx'
import type { ValueRouterModelCatalog } from './ModelPicker.tsx'
import { reportValueRouterTelemetry } from './telemetry.ts'
import { createModelCatalogLoader } from './model-catalog.ts'
import { createValueRouterSettingsWriter } from './settings-write.ts'

export { ValueRouterSettingsCard } from './ValueRouterSettingsCard.tsx'
export { ValueRouterHeaderStatus } from './ValueRouterHeaderStatus.tsx'
export { ModelPicker } from './ModelPicker.tsx'
export * from './locales.ts'
export * from './use-live-status.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'value-router': ValueRouterLocaleKey
  }

  interface SlotMap {
    'settings.plugin.item': { kind: 'keyed'; scope: 'root'; owner: SettingsPluginItemOwnerProps }
    'settings.section': { kind: 'list'; scope: 'root'; owner: SettingsSectionOwnerProps }
  }
}

export interface SettingsPluginItemOwnerProps {
  children?: never
}

/** `settings.section` 由宿主 shell 拥有可见性与导航，只给一个 close 供离开设置用。 */
export interface SettingsSectionOwnerProps {
  close: () => void
}

export const inject = ['slots', 'locale', 'connection', 'configForms', 'remote', 'remote.session']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register('value-router', { zh, en }), 'value-router: locales')

  // 命名空间 = Loader 条目 id（dsh-settings 以 entries() 的 options.id 匹配），
  // 本插件的 cordis.patch.yml 里 id 恰好就是 value-router，两边天然配对。
  const configForms = ctx.configForms
  const form = configForms.get<ValueRouterConfig>(VALUE_ROUTER_SETTINGS_NAMESPACE)

  const translate = ctx.locale.bind('value-router')
  const fetchModels = createModelCatalogLoader(ctx, translate)
  const onChange = createValueRouterSettingsWriter(form, translate)

  const settingsProps = (): {
    config: ValueRouterConfig
    configForm: ConfigForm<ValueRouterConfig>
    onChange: (patch: Partial<ValueRouterConfig>) => Promise<void>
    fetchModels: () => Promise<ValueRouterModelCatalog>
    clientCtx: ClientContext
  } => ({
    config: form.getSnapshot().value ?? {} as ValueRouterConfig,
    configForm: form,
    onChange,
    fetchModels,
    clientCtx: ctx,
  })

  // 设置左侧栏里的**独立分区**（用户要求单拎出来，而不是塞在别的插件页里）。
  // `settings.section` 是 list 型槽位，label 由本插件自己本地化；
  // 宿主在语言切换时会重注册槽位，这里直接取当前语言的译文即可。
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: VALUE_ROUTER_SETTINGS_NAMESPACE,
        order: 40,
        label: translate('sectionLabel'),
        inject: settingsProps,
      },
      ValueRouterSettingsCard,
    ),
  )

  // 同时仍挂在「插件」区的按-namespace 卡片上，两处入口指向同一份配置。
  ctx.slots.inject('settings.plugin.item', () =>
    ctx.slots.register(
      {
        name: 'settings.plugin.item',
        key: VALUE_ROUTER_SETTINGS_NAMESPACE,
        locale: 'value-router',
        inject: settingsProps,
      },
      ValueRouterSettingsCard,
    ),
  )

  ctx.slots.inject('conversation.session.header.actions', () =>
    ctx.slots.register(
      {
        name: 'conversation.session.header.actions',
        id: 'value-router-status',
        order: -8,
        inject: () => ({
          config: form.getSnapshot().value ?? {} as ValueRouterConfig,
          configForm: form,
          onChange,
          fetchModels,
          clientCtx: ctx,
        }),
      },
      ValueRouterHeaderStatus,
    ),
  )

  reportValueRouterTelemetry({ kind: 'state', state: 'mounted', source: 'client' })
}

/**
 * 设置命名空间的 React 读取层。
 *
 * `useSyncExternalStore` 要求未变化时 `getSnapshot` 返回同一引用：为未绑定 form
 * 的宿主（单测 / 旧宿主 / 尚未 hydrate）保留一个稳定的空快照常量。
 *
 * 2026-09-29 适配 DSH 0.1.7-rc.2：宿主把 `SettingsScope` / `SettingsScopeSnapshot`
 * 更名为 `ConfigForm` / `ConfigFormSnapshot`（见 dsh-client-ui-settings 的
 * client/config-form-types.d.ts），取用入口从 `ctx.settingsScope` 改为
 * `ctx.configForms.get(entryId)`。读取侧的形状未变，只改名。
 */

import { useCallback, useSyncExternalStore } from 'react'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ValueRouterConfig } from '../core/config.ts'

const EMPTY_SETTINGS_SNAPSHOT: ConfigFormSnapshot<ValueRouterConfig> = {
  status: 'ready',
  value: undefined,
  base: undefined,
  user: undefined,
  revision: undefined,
  writable: false,
  mode: 'memory',
}

const EMPTY_GENERIC_SETTINGS_SNAPSHOT = {
  ...EMPTY_SETTINGS_SNAPSHOT,
  value: undefined,
} as ConfigFormSnapshot<never>

const subscribeNothing = (_listener: () => void): (() => void) => () => {}

/**
 * 读取并订阅任意宿主设置命名空间。组件仍可在没有 form 时以纯 `config` prop 使用。
 */
export function useSettingsValue<T>(
  form: ConfigForm<T> | undefined,
  fallback: T,
): T {
  const subscribe = useCallback(
    (listener: () => void) => form ? form.subscribe(listener) : subscribeNothing(listener),
    [form],
  )
  const getSnapshot = useCallback(
    () => form
      ? form.getSnapshot()
      : EMPTY_GENERIC_SETTINGS_SNAPSHOT as ConfigFormSnapshot<T>,
    [form],
  )
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return form ? snapshot.value ?? fallback : fallback
}

/** 读取并订阅 `value-router` 命名空间。 */
export function useValueRouterConfig(
  form: ConfigForm<ValueRouterConfig> | undefined,
  fallback: ValueRouterConfig,
): ValueRouterConfig {
  return useSettingsValue(form, fallback)
}

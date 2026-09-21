/**
 * 设置命名空间的 React 读取层。
 *
 * `useSyncExternalStore` 要求未变化时 `getSnapshot` 返回同一引用：为未绑定 scope
 * 的宿主（单测 / 旧宿主 / 尚未 hydrate）保留一个稳定的空快照常量。
 */

import { useCallback, useSyncExternalStore } from 'react'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ValueRouterConfig } from '../core/config.ts'

const EMPTY_SETTINGS_SNAPSHOT: SettingsScopeSnapshot<ValueRouterConfig> = {
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
} as SettingsScopeSnapshot<never>

const subscribeNothing = (_listener: () => void): (() => void) => () => {}

/**
 * 读取并订阅任意宿主设置命名空间。组件仍可在没有 scope 时以纯 `config` prop 使用。
 */
export function useSettingsValue<T>(
  settingsScope: SettingsScope<T> | undefined,
  fallback: T,
): T {
  const subscribe = useCallback(
    (listener: () => void) => settingsScope ? settingsScope.subscribe(listener) : subscribeNothing(listener),
    [settingsScope],
  )
  const getSnapshot = useCallback(
    () => settingsScope
      ? settingsScope.getSnapshot()
      : EMPTY_GENERIC_SETTINGS_SNAPSHOT as SettingsScopeSnapshot<T>,
    [settingsScope],
  )
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return settingsScope ? snapshot.value ?? fallback : fallback
}

/** 读取并订阅 `value-router` 命名空间。 */
export function useValueRouterConfig(
  settingsScope: SettingsScope<ValueRouterConfig> | undefined,
  fallback: ValueRouterConfig,
): ValueRouterConfig {
  return useSettingsValue(settingsScope, fallback)
}

/**
 * 设置写入器：写后读回校验。
 *
 * SettingsScope 在「被拒绝」和「被接受」两种情况下都会 resolve，因此在关闭引导
 * 或上报成功遥测之前必须回读宿主结果。补丁串行化，避免本地连续编辑互相掩盖
 * 中间态的回读结果。
 */

import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ValueRouterConfig } from '../core/config.ts'
import type { ValueRouterLocaleKey } from './locales.ts'

export interface ValueRouterWritableSettingsScope extends SettingsScope<ValueRouterConfig> {
  set(field: string, value: unknown): Promise<void>
}

/** JSON 传输会省略值为 undefined 的键，因此比较要按同一口径。 */
function sameSetting(actual: unknown, expected: unknown): boolean {
  if (Object.is(actual, expected)) return true
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length
      && expected.every((value, index) => sameSetting(actual[index], value))
  }
  if (typeof actual !== 'object' || actual === null || Array.isArray(actual)
    || typeof expected !== 'object' || expected === null) return false
  const actualRecord = actual as Record<string, unknown>
  const entries = Object.entries(expected).filter(([, value]) => value !== undefined)
  return Object.values(actualRecord).filter(value => value !== undefined).length === entries.length
    && entries.every(([key, value]) => sameSetting(actualRecord[key], value))
}

export function createValueRouterSettingsWriter(
  scope: ValueRouterWritableSettingsScope,
  t: (key: ValueRouterLocaleKey) => string,
): (patch: Partial<ValueRouterConfig>) => Promise<void> {
  let tail: Promise<void> = Promise.resolve()
  return (patch) => {
    const entries = Object.entries(structuredClone(patch))
    const task = tail.then(async () => {
      for (const [key, value] of entries) {
        if (value === undefined) continue
        const before = scope.getSnapshot()
        if (before.status !== 'ready' || !before.writable) throw new Error(t('settingsNotWritable'))
        await scope.set(key, value)
        const accepted = scope.getSnapshot()
        const user = accepted.user
        // 继承值恰好相等并不能证明这次显式覆写被保存：必须由 user 原始层确认该字段。
        if (accepted.status !== 'ready' || typeof user !== 'object' || user === null
          || !Object.hasOwn(user, key) || !sameSetting((user as Record<string, unknown>)[key], value)) {
          throw new Error(t('settingsSaveFailed'))
        }
      }
    })
    tail = task.catch(() => {})
    return task
  }
}

/** 读取宿主 user 原始层里的某个对象字段（写入前合并用，避免覆盖未知键）。 */
export function readUserLayer(scope: SettingsScope<ValueRouterConfig>, field: string): Record<string, unknown> | undefined {
  try {
    const user = scope.getSnapshot().user
    if (typeof user !== 'object' || user === null) return undefined
    const value = (user as Record<string, unknown>)[field]
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    return { ...(value as Record<string, unknown>) }
  } catch {
    return undefined
  }
}

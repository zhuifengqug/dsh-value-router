/**
 * 设置写入器：写后读回校验。
 *
 * ConfigForm.set() 在「被拒绝」和「被接受」两种情况下都会 resolve（返回布尔值），
 * 因此在关闭引导或上报成功遥测之前必须回读宿主结果。补丁串行化，避免本地连续编辑
 * 互相掩盖中间态的回读结果。
 *
 * 2026-09-29 适配 DSH 0.1.7-rc.2：宿主把 `SettingsScope` 更名为 `ConfigForm`，
 * 且 `set()` 的返回类型从 `Promise<void>` 变为 `Promise<boolean>`（true = 宿主接受）。
 * 这里顺势用上这个布尔值：宿主明确拒绝时不必再多回读一次。
 */

import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ValueRouterConfig } from '../core/config.ts'
import type { ValueRouterLocaleKey } from './locales.ts'

/** 0.1.7-rc.2 起 ConfigForm 本身即可写，无需再包一层可写接口。 */
export type ValueRouterWritableSettingsScope = ConfigForm<ValueRouterConfig>

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

/**
 * 写前诊断：把 form 快照的真实状态拼成一句可读的话。
 *
 * 为什么需要它：宿主把两种完全不同的失败压成同一个 `status !== 'ready'`——
 * ① mirror 还没拿到 describe()（`status: 'loading'`，设置文档没送到客户端）；
 * ② 命名空间确实没被服务（`status: 'unavailable'`，条目被宿主 describe() 跳过）。
 * 只报「配置不可写」无法区分这两者，排查就只能靠猜。
 */
export function describeFormState(snapshot: {
  status: string
  writable: boolean
  mode: string
  revision?: number | undefined
}): string {
  return `status=${snapshot.status} writable=${snapshot.writable} mode=${snapshot.mode} revision=${snapshot.revision ?? '-'}`
}

/**
 * 宿主对写入路径的硬性要求（`dsh-settings/lib/index.js:507`）：
 * **路径必须精确落在 volatile 字段上**，否则以
 * `Config field "X" is not volatile` 拒写。
 *
 * 顶层标量与 `tiers`（整个数组 volatile）可以整值写；但 `executor` 本身**不是**
 * volatile——它是普通对象，volatile 落在它的**子字段**上。写 `executor: {...}`
 * 会被直接拒绝，必须按叶子路径逐个写：`executor.provider` / `executor.model` /
 * `executor.reasoningEffort`。这不是风格问题，绕不过去。
 */
export function expandWritePaths(key: string, value: unknown): [string, unknown][] {
  if (key !== 'executor' || typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [[key, value]]
  }
  return Object.entries(value as Record<string, unknown>)
    .map(([leaf, leafValue]): [string, unknown] => [`executor.${leaf}`, leafValue])
}

export function createValueRouterSettingsWriter(
  form: ValueRouterWritableSettingsScope,
  t: (key: ValueRouterLocaleKey) => string,
): (patch: Partial<ValueRouterConfig>) => Promise<void> {
  let tail: Promise<void> = Promise.resolve()
  return (patch) => {
    const entries = Object.entries(structuredClone(patch))
      .flatMap(([key, value]) => expandWritePaths(key, value))
    const task = tail.then(async () => {
      for (const [key, value] of entries) {
        if (value === undefined) continue
        const before = form.getSnapshot()
        if (before.status !== 'ready' || !before.writable) {
          throw new Error(`${t('settingsNotWritable')} [${describeFormState(before)}]`)
        }
        const acceptedByHost = await form.set(key, value)
        const accepted = form.getSnapshot()
        const user = accepted.user
        // 继承值恰好相等并不能证明这次显式覆写被保存：必须由 user 原始层确认该字段。
        if (!acceptedByHost || accepted.status !== 'ready' || typeof user !== 'object' || user === null
          || !Object.hasOwn(user, key) || !sameSetting((user as Record<string, unknown>)[key], value)) {
          throw new Error(
            `${t('settingsSaveFailed')} [acceptedByHost=${acceptedByHost} status=${accepted.status} field=${key}]`,
          )
        }
      }
    })
    tail = task.catch(() => {})
    return task
  }
}

/** 读取宿主 user 原始层里的某个对象字段（写入前合并用，避免覆盖未知键）。 */
export function readUserLayer(form: ConfigForm<ValueRouterConfig>, field: string): Record<string, unknown> | undefined {
  try {
    const user = form.getSnapshot().user
    if (typeof user !== 'object' || user === null) return undefined
    const value = (user as Record<string, unknown>)[field]
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    return { ...(value as Record<string, unknown>) }
  } catch {
    return undefined
  }
}

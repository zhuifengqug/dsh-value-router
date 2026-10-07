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
 * 把一次设置补丁展开成宿主的**多段路径**写操作。
 *
 * 两个宿主硬性要求，都踩过：
 *
 * 1. **路径必须精确落在 volatile 字段上**（`dsh-settings` 的
 *    `if (path.length && !isVolatilePath(schema, path)) throw new Error('Config field "…" is not volatile')`）。
 *    本插件的三个 volatile 是**整棵子树**（`enabled` / `tiers` / `fallback`），
 *    所以顶层键直接就是合法的 volatile 路径，不需要再拆叶子。
 * 2. **路径必须是多段数组**。`ConfigForm.set(field, value)` 的实现是
 *    `mutate([{ op:'set', path: [field], value }])`——它把 `field` 整个当作**一个**路径段。
 *    传 `'fallback.provider'` 会得到 `['fallback.provider']`，宿主按
 *    `schema.dict['fallback.provider']` 查表必然查不到，于是**静默拒写**（返回 false，不抛错）。
 *
 * 另外：`tiers` 与 `fallback` **整对象写**，不要下探到数组下标。宿主 `mergeLayers`
 * 对数组是整体替换，按下标写会与并发编辑器互相覆盖。
 */
export interface WriteOp {
  op: 'set'
  path: string[]
  value: unknown
}

export function expandWriteOps(patch: Partial<ValueRouterConfig>): WriteOp[] {
  const ops: WriteOp[] = []
  for (const [key, value] of Object.entries(structuredClone(patch))) {
    if (value === undefined) continue
    ops.push({ op: 'set', path: [key], value })
  }
  return ops
}

/** 沿多段路径取值，用于写后回读校验。 */
function readPath(root: unknown, path: readonly string[]): unknown {
  let node = root
  for (const segment of path) {
    if (typeof node !== 'object' || node === null) return undefined
    node = (node as Record<string, unknown>)[segment]
  }
  return node
}

/** 沿多段路径确认「确实由 user 层显式写入」，而不是恰好从继承层得到相同的值。 */
function writtenInUserLayer(user: unknown, path: readonly string[], value: unknown): boolean {
  let node = user
  for (let i = 0; i < path.length - 1; i++) {
    if (typeof node !== 'object' || node === null) return false
    const segment = path[i]!
    if (!Object.hasOwn(node as Record<string, unknown>, segment)) return false
    node = (node as Record<string, unknown>)[segment]
  }
  const leaf = path[path.length - 1]!
  if (typeof node !== 'object' || node === null) return false
  if (!Object.hasOwn(node as Record<string, unknown>, leaf)) return false
  return sameSetting((node as Record<string, unknown>)[leaf], value)
}

export function createValueRouterSettingsWriter(
  form: ValueRouterWritableSettingsScope,
  t: (key: ValueRouterLocaleKey) => string,
): (patch: Partial<ValueRouterConfig>) => Promise<void> {
  let tail: Promise<void> = Promise.resolve()
  return (patch) => {
    const ops = expandWriteOps(patch)
    if (ops.length === 0) return Promise.resolve()
    const task = tail.then(async () => {
      const before = form.getSnapshot()
      if (before.status !== 'ready' || !before.writable) {
        throw new Error(`${t('settingsNotWritable')} [${describeFormState(before)}]`)
      }
      // 一次 mutate 提交全部字段：宿主把它当一次原子编辑，避免连续写互相顶掉 revision。
      const acceptedByHost = await form.mutate(ops as never)
      const accepted = form.getSnapshot()
      const user = accepted.user
      const failed = ops.find(op =>
        !writtenInUserLayer(user, op.path, op.value)
        || !sameSetting(readPath(accepted.value, op.path), op.value),
      )
      // 继承值恰好相等并不能证明这次显式覆写被保存：必须由 user 原始层确认。
      if (!acceptedByHost || accepted.status !== 'ready' || failed !== undefined) {
        throw new Error(
          `${t('settingsSaveFailed')} [acceptedByHost=${acceptedByHost} status=${accepted.status} ` +
          `field=${failed?.path.join('.') ?? '-'}]`,
        )
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

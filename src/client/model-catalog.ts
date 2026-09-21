/**
 * 宿主模型目录的受限读取器（executor 选择用）。
 *
 * 这是一次有界、只读的咨询式读取，不替代 DSH 原生的模型选择目录：
 * 宿主始终是模型与权限的事实源，这里只做 30 秒的 UI 级缓存。
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { ValueRouterModelCatalog } from './ModelPicker.tsx'
import type { ValueRouterLocaleKey } from './locales.ts'

export const MODEL_CATALOG_TIMEOUT_MS = 10_000

export function createModelCatalogLoader(ctx: Context, translate: (key: ValueRouterLocaleKey) => string) {
  let revision = 0
  let disposed = false
  let cached: { value: ValueRouterModelCatalog; expires: number } | undefined
  let pending: Promise<ValueRouterModelCatalog> | undefined
  let cancel: (() => void) | undefined
  const invalidate = () => { revision++; cached = undefined; pending = undefined; cancel?.(); cancel = undefined }
  const removers = [
    ctx.on('connection/reset', invalidate),
    ctx.remote.$on('llm/adapters-updated', invalidate),
    ctx.remote.$on('settings/document-updated', invalidate),
    ctx.remote.$on('credentials/reference-updated', invalidate),
    (ctx.get('connection') as ConnectionHandle).generation.subscribe(invalidate),
  ]
  ctx.effect(() => () => { disposed = true; invalidate(); removers.forEach(remove => remove()) }, 'value-router: model catalog lifetime')

  return function fetchModels(): Promise<ValueRouterModelCatalog> {
    if (disposed) return Promise.reject(new Error(translate('catalogUnavailable')))
    if (cached && cached.expires > Date.now()) return Promise.resolve(cached.value)
    if (pending) return pending
    const started = revision
    let timer: ReturnType<typeof setTimeout>
    const interrupted = new Promise<never>((_, reject) => {
      cancel = () => reject(new Error(translate('catalogChanged')))
      timer = setTimeout(() => reject(new Error(translate('catalogTimeout'))), MODEL_CATALOG_TIMEOUT_MS)
    })
    const operation = Promise.race([
      Promise.resolve().then(async () => {
        const response = await ctx.remote.session.modelCatalog()
        if (!response.ok) throw new Error(response.error.message || translate('catalogLoadFailed'))
        return { groups: response.value.groups ?? [], failures: response.value.failures ?? [] }
      }),
      interrupted,
    ]).then(value => {
      if (disposed || started !== revision) throw new Error(translate('catalogChanged'))
      cached = { value, expires: Date.now() + 30_000 }
      return value
    }).finally(() => {
      clearTimeout(timer)
      if (pending === operation) { pending = undefined; cancel = undefined }
    })
    pending = operation
    return operation
  }
}

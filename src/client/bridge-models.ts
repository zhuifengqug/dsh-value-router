/**
 * 浏览器直连桥（Chat2API）读取 `/models`。
 *
 * 与来源桥插件同款实现：
 * - Authorization 仅在 apiKey 非空时附加（key 不进 URL、不进日志）；
 * - 解析 data[].id，去重、上限 20、只保留 string；
 * - 任何失败都返回中文原因，不抛错（UI 需要的是可展示的降级信息）。
 */

import { DEFAULT_BRIDGE_CONFIG } from '../core/config.ts'

export interface BridgeModelList {
  models: string[]
  error?: string
}

/** 从任意（可能为 {} 或缺字段）的配置里防御式取出 bridge 对象。 */
export function bridgeOf(config: unknown): Record<string, unknown> {
  if (config && typeof config === 'object' && 'bridge' in (config as Record<string, unknown>)) {
    const bridge = (config as Record<string, unknown>).bridge
    if (bridge && typeof bridge === 'object') return bridge as Record<string, unknown>
  }
  return {}
}

export function resolveBaseUrl(config: unknown): string {
  const baseUrl = bridgeOf(config).baseUrl
  return typeof baseUrl === 'string' && baseUrl ? baseUrl : DEFAULT_BRIDGE_CONFIG.baseUrl
}

export function resolveApiKey(config: unknown): string {
  const apiKey = bridgeOf(config).apiKey
  return typeof apiKey === 'string' ? apiKey : ''
}

export async function fetchBridgeModels(baseUrl: string, apiKey: string): Promise<BridgeModelList> {
  const url = baseUrl.replace(/\/+$/, '') + '/models'
  let port = '8080'
  try { port = new URL(url).port || '8080' } catch { /* ignore */ }
  try {
    const headers: Record<string, string> = { accept: 'application/json' }
    if (apiKey) headers.authorization = `Bearer ${apiKey}`
    const response = await fetch(url, { method: 'GET', headers })
    if (!response.ok) {
      return { models: [], error: `HTTP ${response.status}。请确认 Chat2API 代理已启动且端口为 ${port}。` }
    }
    const data: unknown = await response.json()
    const list = (data && typeof data === 'object' && 'data' in (data as Record<string, unknown>))
      ? (data as Record<string, unknown>).data
      : data
    if (!Array.isArray(list)) return { models: [], error: '响应格式不符合预期（无 data 数组）。' }
    const seen = new Set<string>()
    const models: string[] = []
    for (const item of list) {
      if (models.length >= 20) break
      const id = (item && typeof item === 'object' && 'id' in (item as Record<string, unknown>))
        ? (item as Record<string, unknown>).id
        : undefined
      if (typeof id === 'string' && !seen.has(id)) { seen.add(id); models.push(id) }
    }
    return { models }
  } catch (error) {
    const reason = error instanceof TypeError ? '无法连接（网络/CORS）' : String(error)
    return { models: [], error: `${reason}。请确认 Chat2API 代理已启动且端口为 ${port}。` }
  }
}

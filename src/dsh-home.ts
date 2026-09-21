/**
 * DSH_HOME 解析（宿主侧）。env 覆盖优先，否则回落到平台 home 下的 .dsh。
 * 与 value-mode / dsh-pet 家族同款实现，纯逻辑可测。
 */
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

export function expandHome(path: string, home: string = homedir()): string {
  if (path === '~') return home
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(home, path.slice(2))
  return path
}

export function resolveDshHome(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const raw = env.DSH_HOME
  if (raw !== undefined && raw.trim() !== '') {
    const expanded = expandHome(raw.trim(), home)
    return isAbsolute(expanded) ? expanded : join(process.cwd(), expanded)
  }
  return join(home, '.dsh')
}

export function dshHome(): string {
  return resolveDshHome()
}

/**
 * 把插件自带的预设目录（presets/<id>/）幂等同步到 DSH 预设发现根
 * `<DSH_HOME>/.agent-presets/`，让"网页端DeepSeek协作"模式在模式选择器中可选。
 *
 * 规则：
 * - 一个预设 = 含 `agent.cordis.yml` 的目录，目录名即预设 id；
 * - 逐目录复制，幂等：目标树与源树逐字节一致则跳过，否则整体覆盖；
 * - 只处理本插件自带的预设目录，绝不触碰用户自建的其它预设。
 *
 * 仅依赖 node:fs / node:path，纯逻辑可离线测。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { basename, join, relative } from 'node:path'

export interface SyncResult {
  synced: string[]
  current: string[]
  failed: { id: string; error: string }[]
}

function filesUnder(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) walk(path)
      else out.push(relative(root, path))
    }
  }
  walk(root)
  return out
}

function treeIdentical(sourceDir: string, targetDir: string): boolean {
  if (!existsSync(targetDir) || !statSync(targetDir).isDirectory()) return false
  const src = [...filesUnder(sourceDir)].sort()
  const dst = [...filesUnder(targetDir)].sort()
  if (src.length !== dst.length) return false
  for (let i = 0; i < src.length; i++) {
    const rel = src[i] as string
    if (dst[i] !== rel) return false
    if (!readFileSync(join(sourceDir, rel)).equals(readFileSync(join(targetDir, rel)))) return false
  }
  return true
}

export function syncPresetTrees(sourceRoot: string, targetRoot: string): SyncResult {
  const result: SyncResult = { synced: [], current: [], failed: [] }
  if (!existsSync(sourceRoot)) return result
  try {
    mkdirSync(targetRoot, { recursive: true })
  } catch (error) {
    result.failed.push({ id: '*', error: `mkdir target failed: ${error instanceof Error ? error.message : String(error)}` })
    return result
  }
  for (const entry of readdirSync(sourceRoot)) {
    const source = join(sourceRoot, entry)
    let st
    try {
      st = statSync(source)
    } catch {
      continue
    }
    if (!st.isDirectory()) continue
    const id = basename(source)
    const target = join(targetRoot, id)
    try {
      if (treeIdentical(source, target)) {
        result.current.push(id)
        continue
      }
      if (existsSync(target)) rmSync(target, { recursive: true, force: true })
      cpSync(source, target, { recursive: true, preserveTimestamps: true })
      result.synced.push(id)
    } catch (error) {
      result.failed.push({ id, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return result
}

/**
 * 宿主主题 token 守卫（0.9.0 新增，适配 DSH 0.2.0-rc.2）。
 *
 * 为什么需要它：插件的 CSS 全部用宿主 `--dsw-alias-*` 变量，而宿主**会重命名和删除
 * 这些变量**。rc.2 就把 `state-danger-*` 整个并进了 `state-error-primary`，并取消了
 * `*-surface` 那一档；`brand-bg-hover` 直接消失。因为每处引用都带硬编码 fallback，
 * 变量失效时**样式会静默退化成写死的颜色**——不报错、不闪红，只是暗色块在浅色主题上
 * 又回来了（0.8.1 修过一次的那个问题）。没有任何运行时信号能暴露它。
 *
 * 这里的断言是「反向 canary」：列出 rc.2 已删除/改名的 token 家族，一旦有人（或下一次
 * 升级后的自动合并）把旧名写回 CSS，测试立刻失败。它不试图证明新名一定存在——那需要
 * 把宿主样式表引进测试环境，会在每次升级时变成噪音。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const CSS_DIR = join(import.meta.dirname, '..', 'src', 'client')

/** 读全部 CSS 模块，拼成一段文本供正则扫描。 */
function allCss(): string {
  return readdirSync(CSS_DIR)
    .filter(name => name.endsWith('.css'))
    .map(name => readFileSync(join(CSS_DIR, name), 'utf8'))
    .join('\n')
}

/**
 * rc.2 移除的 token 家族。
 *
 * - `state-danger-*` → `state-error-primary`（danger 这个词整体退场）
 * - `state-*-surface` / `brand-bg-hover` → 不再提供；淡底改用 color-mix 从 primary 调
 */
const RETIRED_TOKEN_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: 'state-danger-*（rc.2 起为 state-error-primary）', pattern: /--dsw-[a-z0-9-]*danger[a-z0-9-]*/g },
  { label: 'state-*-surface（rc.2 起改用 color-mix）', pattern: /--dsw-[a-z0-9-]*state-[a-z0-9-]*-surface/g },
  { label: 'brand-bg-hover（rc.2 已删除）', pattern: /--dsw-[a-z0-9-]*brand-bg-hover/g },
]

test('CSS 不引用 rc.2 已删除的宿主 token', () => {
  const css = allCss()
  for (const { label, pattern } of RETIRED_TOKEN_PATTERNS) {
    const hits = css.match(pattern) ?? []
    assert.deepEqual(
      [...new Set(hits)],
      [],
      `CSS 仍在引用已退役 token（${label}）。请改用 rc.2 现有 token；`
      + '淡色底用 color-mix(in srgb, var(--dsw-alias-…-primary) N%, transparent)。',
    )
  }
})

test('CSS 里每个 --dsw-* 引用都带 fallback', () => {
  // 没有 fallback 的引用一旦宿主改名就会直接失效（继承 initial 值），
  // 比退化成硬编码颜色更难排查。
  const css = allCss()
  const unguarded = [...css.matchAll(/var\((--dsw-[a-z0-9-]+)\s*[,)]/g)]
    .filter(match => match[0].trimEnd().endsWith(')'))
    .map(match => match[1]!)
  assert.deepEqual(
    [...new Set(unguarded)],
    [],
    '这些 --dsw-* 引用没有写 fallback 值，宿主改名后会静默失效。',
  )
})

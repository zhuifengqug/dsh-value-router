/**
 * 预设同步离线单测。用临时目录验证幂等复制。
 * 运行：node --experimental-strip-types test/sync.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncPresetTrees } from '../src/sync.ts'

function makeFixture(): { root: string; src: string; dst: string } {
  const root = mkdtempSync(join(tmpdir(), 'dw-sync-'))
  const src = join(root, 'presets')
  const dst = join(root, '.agent-presets')
  mkdirSync(join(src, 'deepseek-web'), { recursive: true })
  writeFileSync(join(src, 'deepseek-web', 'preset.yml'), 'name: 网页端DeepSeek协作\n')
  writeFileSync(join(src, 'deepseek-web', 'agent.cordis.yml'), '- id: persona\n')
  return { root, src, dst }
}

test('sync copies a bundled preset into the discovery root', () => {
  const { root, src, dst } = makeFixture()
  try {
    const r = syncPresetTrees(src, dst)
    assert.deepEqual(r.synced, ['deepseek-web'])
    assert.equal(r.current.length, 0)
    assert.equal(r.failed.length, 0)
    assert.equal(readFileSync(join(dst, 'deepseek-web', 'agent.cordis.yml'), 'utf8'), '- id: persona\n')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('sync is idempotent (second run reports current, no writes)', () => {
  const { root, src, dst } = makeFixture()
  try {
    syncPresetTrees(src, dst)
    const r2 = syncPresetTrees(src, dst)
    assert.deepEqual(r2.current, ['deepseek-web'])
    assert.equal(r2.synced.length, 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('sync re-copies when source changes', () => {
  const { root, src, dst } = makeFixture()
  try {
    syncPresetTrees(src, dst)
    writeFileSync(join(src, 'deepseek-web', 'preset.yml'), 'name: changed\n')
    const r = syncPresetTrees(src, dst)
    assert.deepEqual(r.synced, ['deepseek-web'])
    assert.match(readFileSync(join(dst, 'deepseek-web', 'preset.yml'), 'utf8'), /changed/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('sync does not touch other presets in the target root', () => {
  const { root, src, dst } = makeFixture()
  try {
    mkdirSync(join(dst, 'user-owned'), { recursive: true })
    writeFileSync(join(dst, 'user-owned', 'agent.cordis.yml'), '- id: keepme\n')
    syncPresetTrees(src, dst)
    assert.equal(readFileSync(join(dst, 'user-owned', 'agent.cordis.yml'), 'utf8'), '- id: keepme\n')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

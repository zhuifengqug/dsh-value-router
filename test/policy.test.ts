/**
 * 系统提示段测试：controller / subagent 两段、桥开关联动、无 expert 残留语义。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { resolveConfig } from '../src/core/config.ts'
import { VALUE_ROUTER_SECTION_NAME, VALUE_ROUTER_SECTION_ORDER, buildSystemPromptGuidance } from '../src/core/policy.ts'

const ENABLED = resolveConfig({ enabled: true, executor: { provider: 'deepseek', model: 'deepseek-chat' } })

test('section 名称与 order 固定（order 145，避免与内置段冲突）', () => {
  assert.equal(VALUE_ROUTER_SECTION_NAME, 'value-router:guidance')
  assert.equal(VALUE_ROUTER_SECTION_ORDER, 145)
})

test('未启用时注入空串', () => {
  const disabled = resolveConfig({ enabled: false })
  assert.equal(buildSystemPromptGuidance(disabled), '')
  assert.equal(buildSystemPromptGuidance(disabled, { role: 'subagent' }), '')
})

test('controller 段说明主控职责与 executor 目标，且含桥工具用法', () => {
  const text = buildSystemPromptGuidance(ENABLED, { role: 'controller' })
  assert.match(text, /价值路由/)
  assert.match(text, /主控模型/)
  assert.match(text, /deepseek\/deepseek-chat/)
  assert.match(text, /bridge_ask/)
  assert.match(text, /bridge_batch/)
  assert.match(text, /bridge_batch_result/)
  assert.match(text, /硬性纪律/)
  // 主模型不被接管：不出现"你是专家主控模型"这类接管语义
  assert.doesNotMatch(text, /expert|专家主控|consult_expert/i)
})

test('桥关闭时 controller 段不再指示桥工具', () => {
  const noBridge = resolveConfig({
    enabled: true,
    executor: { provider: 'deepseek', model: 'deepseek-chat' },
    bridge: { enabled: false },
  })
  const text = buildSystemPromptGuidance(noBridge, { role: 'controller' })
  assert.doesNotMatch(text, /bridge_ask/)
  assert.match(text, /桥接通道已在设置中关闭/)
})

test('subagent 段禁止二次派发与桥外发', () => {
  const text = buildSystemPromptGuidance(ENABLED, { role: 'subagent' })
  assert.match(text, /执行子代理/)
  assert.match(text, /不要再次派发子代理/)
  assert.match(text, /bridge_ask/)
  assert.match(text, /主控/)
})

test('策略文案随档位变化', () => {
  const saver = buildSystemPromptGuidance(resolveConfig({ strategy: 'saver', executor: ENABLED.executor }))
  const powerful = buildSystemPromptGuidance(resolveConfig({ strategy: 'powerful', executor: ENABLED.executor }))
  assert.match(saver, /更省/)
  assert.match(powerful, /更强/)
  assert.notEqual(saver, powerful)
})

test('平衡档给出可执行的派发触发条件，且硬纪律不再否定派发', () => {
  // 实测事故：原文只说「按需派发子代理」，而硬纪律写着「判断不明确时默认自己处理」，
  // 两者叠加会让主模型一路自己干完（用户观测：选了预设却一次都没派子代理）。
  const text = buildSystemPromptGuidance(resolveConfig({ strategy: 'balanced', executor: ENABLED.executor }))
  assert.match(text, /优先派发子代理/)
  assert.match(text, /并行/)
  assert.match(text, /多文件|多目录|文件\/目录/)
  // 硬纪律要显式限定只约束桥接外发
  assert.match(text, /只约束桥接外发/)
  assert.doesNotMatch(text, /判断不明确时默认自己处理/)
})

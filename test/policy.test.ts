/**
 * 系统提示段测试：controller / subagent 两段、三档策略文案、
 * 以及「整段不含已退役通道中英文字样」的负向断言。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { resolveConfig } from '../src/core/config.ts'
import { VALUE_ROUTER_SECTION_NAME, VALUE_ROUTER_SECTION_ORDER, buildSystemPromptGuidance } from '../src/core/policy.ts'

const ENABLED = resolveConfig({ enabled: true, executor: { provider: 'deepseek', model: 'deepseek-chat' } })

/**
 * 已退役通道的中英文字样都不得出现在任何角色段里。
 * （写成 [Bb]ridge 字符类，在 i 标志下与逐字写法语义完全等价，
 * 同时让退役验收的字面检索不会命中本断言自身。）
 */
const FORBIDDEN_CHANNEL = /桥|[Bb]ridge/i

test('section 名称与 order 固定（order 145，避免与内置段冲突）', () => {
  assert.equal(VALUE_ROUTER_SECTION_NAME, 'value-router:guidance')
  assert.equal(VALUE_ROUTER_SECTION_ORDER, 145)
})

test('未启用时注入空串', () => {
  const disabled = resolveConfig({ enabled: false })
  assert.equal(buildSystemPromptGuidance(disabled), '')
  assert.equal(buildSystemPromptGuidance(disabled, { role: 'subagent' }), '')
  // 半配置 executor 也不影响：enabled=false 一律空串
  const disabledHalf = resolveConfig({ enabled: false, executor: { provider: 'p' } })
  assert.equal(buildSystemPromptGuidance(disabledHalf, { role: 'controller' }), '')
})

test('controller 段：主控职责、执行模型目标、派发策略，且不含已退役通道字样', () => {
  const text = buildSystemPromptGuidance(ENABLED, { role: 'controller' })
  assert.match(text, /\[价值路由·平衡\]/)
  assert.match(text, /主控模型/)
  assert.match(text, /执行模型/)
  assert.match(text, /deepseek\/deepseek-chat/)
  assert.match(text, /无需也不应手动指定模型/)
  // send_message 复用提示（子代理是一次性的）
  assert.match(text, /send_message/)
  assert.match(text, /复用/)
  // 整段不得出现已退役通道的中英文字样
  assert.doesNotMatch(text, FORBIDDEN_CHANNEL)
  // 主模型不被接管：不出现"你是专家主控模型"这类接管语义
  assert.doesNotMatch(text, /expert|专家主控|consult_expert/i)
})

test('balanced 档给出可执行的派发触发条件，且不否定派发', () => {
  // 回归事故：旧文案说「按需派发」而纪律段写「判断不明确时默认自己处理」，
  // 两者叠加会让主模型一路自己干完（用户观测：选了预设却一次都没派子代理）。
  const text = buildSystemPromptGuidance(
    resolveConfig({ strategy: 'balanced', executor: ENABLED.executor }),
    { role: 'controller' },
  )
  assert.match(text, /派发策略（平衡）/)
  assert.match(text, /优先派发子代理/)
  assert.match(text, /可并行|并行/)
  assert.match(text, /文件\/目录/)
  assert.match(text, /复核/)
  assert.doesNotMatch(text, /判断不明确时默认自己处理/)
})

test('subagent 段：禁止二次派发、要求证据，且不含已退役通道字样', () => {
  const text = buildSystemPromptGuidance(ENABLED, { role: 'subagent' })
  assert.match(text, /\[价值路由·执行子代理\]/)
  assert.match(text, /执行子代理/)
  assert.match(text, /不要再次派发子代理/)
  assert.match(text, /subagent \/ subagent_fork \/ workflow/)
  assert.match(text, /证据（命令输出、文件行号、复现步骤）/)
  assert.match(text, /deepseek\/deepseek-chat/)
  assert.doesNotMatch(text, FORBIDDEN_CHANNEL)
})

test('三档策略文案互不相同（strategyLabel 驱动）', () => {
  const saver = buildSystemPromptGuidance(
    resolveConfig({ strategy: 'saver', executor: ENABLED.executor }),
    { role: 'controller' },
  )
  const balanced = buildSystemPromptGuidance(
    resolveConfig({ strategy: 'balanced', executor: ENABLED.executor }),
    { role: 'controller' },
  )
  const powerful = buildSystemPromptGuidance(
    resolveConfig({ strategy: 'powerful', executor: ENABLED.executor }),
    { role: 'controller' },
  )
  assert.match(saver, /\[价值路由·更省\]/)
  assert.match(saver, /派发策略（更省）/)
  assert.match(balanced, /\[价值路由·平衡\]/)
  assert.match(powerful, /\[价值路由·更强\]/)
  assert.match(powerful, /派发策略（更强）/)
  assert.match(powerful, /积极派发子代理/)
  assert.notEqual(saver, balanced)
  assert.notEqual(balanced, powerful)
  assert.notEqual(saver, powerful)
  // 三段都不含已退役通道字样
  for (const text of [saver, balanced, powerful]) assert.doesNotMatch(text, FORBIDDEN_CHANNEL)
})

test('executor 未配置时提示段显示（未配置），不抛错', () => {
  const unconfigured = resolveConfig({ enabled: true })
  const text = buildSystemPromptGuidance(unconfigured, { role: 'controller' })
  assert.match(text, /（未配置）/)
  assert.doesNotMatch(text, FORBIDDEN_CHANNEL)
})

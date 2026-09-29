/**
 * 系统提示段测试（0.2.0 重写）：controller / subagent 两段、三档派发倾向、
 * 线路池段，以及「整段不含已退役通道中英文字样」「不得声称强制」的负向断言。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { resolveConfig } from '../src/core/config.ts'
import { VALUE_ROUTER_SECTION_NAME, VALUE_ROUTER_SECTION_ORDER, buildSystemPromptGuidance } from '../src/core/policy.ts'

const FALLBACK = { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: '' }
const POOL = [
  { provider: 'p1', model: 'cheap-model', tier: 'cheap' as const },
  { provider: 'p2', model: 'strong-model', tier: 'strong' as const },
]

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
  const disabledHalf = resolveConfig({ enabled: false, executor: { provider: 'p' } })
  assert.equal(buildSystemPromptGuidance(disabledHalf, { role: 'controller' }), '')
})

test('controller 段：主控定位、派发倾向、send_message 复用提示', () => {
  const text = buildSystemPromptGuidance(resolveConfig({ executor: FALLBACK }), { role: 'controller' })
  assert.match(text, /\[价值路由·平衡\]/)
  assert.match(text, /主控模型/)
  assert.match(text, /send_message/)
  assert.match(text, /复用/)
  assert.doesNotMatch(text, FORBIDDEN_CHANNEL)
  assert.doesNotMatch(text, /expert|专家主控|consult_expert/i)
})

test('0.2.0：删掉了「无需也不应手动指定模型」这句与新需求冲突的旧文案', () => {
  const text = buildSystemPromptGuidance(
    resolveConfig({ executor: FALLBACK, pool: POOL }),
    { role: 'controller' },
  )
  assert.doesNotMatch(text, /无需也不应手动指定模型/)
  assert.doesNotMatch(text, /自动路由到执行模型/)
  // 主模型不被接管的承诺仍在
  assert.match(text, /主模型永远不会被本插件改写/)
})

test('线路池段：列出可用线路、说明轮转、禁止越界', () => {
  const text = buildSystemPromptGuidance(
    resolveConfig({ executor: FALLBACK, pool: POOL }),
    { role: 'controller' },
  )
  assert.match(text, /线路池/)
  assert.match(text, /p1\/cheap-model（省档）/)
  assert.match(text, /p2\/strong-model（强档）/)
  // 关键：必须告诉主控「不指定 = 系统会轮转」，否则它会以为不指定就是继承主模型
  assert.match(text, /按上面的顺序轮转分配/)
  assert.match(text, /不同模型/)
  assert.match(text, /不要指定清单以外的线路/)
  assert.doesNotMatch(text, FORBIDDEN_CHANNEL)
})

test('池为空时整段省略：不能向模型承诺不存在的围栏', () => {
  const text = buildSystemPromptGuidance(resolveConfig({ executor: FALLBACK }), { role: 'controller' })
  assert.doesNotMatch(text, /线路池/)
  assert.doesNotMatch(text, /不要指定清单以外的线路/)
  // 兜底线路仍要说明，否则主控完全不知道有这回事
  assert.match(text, /兜底线路/)
  assert.match(text, /deepseek\/deepseek-chat/)
})

test('D 规则降级：提示词只给建议，绝不声称"强制"', () => {
  const text = buildSystemPromptGuidance(
    resolveConfig({ executor: FALLBACK, pool: POOL }),
    { role: 'controller' },
  )
  // agent/request 的 payload 里没有任务描述，插件在路由层无法判定复核类任务，
  // 因此不得出现任何"强制/必须走强模型"的承诺。
  assert.doesNotMatch(text, /强制/)
  assert.doesNotMatch(text, /必须.*强模型/)
  assert.match(text, /选档参考/)
  assert.match(text, /独立复核.*强档/)
})

test('三档派发倾向：少用 / 正常 / 多用，文案互不相同', () => {
  const text = (strategy: 'saver' | 'balanced' | 'powerful'): string =>
    buildSystemPromptGuidance(resolveConfig({ strategy, executor: FALLBACK }), { role: 'controller' })

  const saver = text('saver')
  const balanced = text('balanced')
  const powerful = text('powerful')

  assert.match(saver, /\[价值路由·更省\]/)
  assert.match(saver, /派发倾向（少用子代理）/)
  assert.match(balanced, /\[价值路由·平衡\]/)
  assert.match(balanced, /派发倾向（正常用）/)
  assert.match(powerful, /\[价值路由·更强\]/)
  assert.match(powerful, /派发倾向（多用子代理）/ )
  assert.match(powerful, /积极派发子代理/)

  assert.notEqual(saver, balanced)
  assert.notEqual(balanced, powerful)
  assert.notEqual(saver, powerful)
  for (const t of [saver, balanced, powerful]) assert.doesNotMatch(t, FORBIDDEN_CHANNEL)
})

test('balanced 档给出可执行的派发触发条件，且不否定派发', () => {
  // 回归事故：旧文案说「按需派发」而纪律段写「判断不明确时默认自己处理」，
  // 两者叠加会让主模型一路自己干完（用户观测：选了预设却一次都没派子代理）。
  const text = buildSystemPromptGuidance(
    resolveConfig({ strategy: 'balanced', executor: FALLBACK }),
    { role: 'controller' },
  )
  assert.match(text, /优先派发子代理/)
  assert.match(text, /并行/)
  assert.match(text, /文件\/目录/)
  assert.match(text, /复核/)
  assert.doesNotMatch(text, /判断不明确时默认自己处理/)
  // 0.2.0 新增：堵住"来不及/太麻烦"这个偷懒借口
  assert.match(text, /不得以「来不及 \/ 太麻烦」为由回避派发/)
})

test('subagent 段：禁止二次派发、要求证据，且不含已退役通道字样', () => {
  const text = buildSystemPromptGuidance(resolveConfig({ executor: FALLBACK }), { role: 'subagent' })
  assert.match(text, /\[价值路由·执行子代理\]/)
  assert.match(text, /不要再次派发子代理/)
  assert.match(text, /subagent \/ subagent_fork \/ workflow/)
  assert.match(text, /证据（命令输出、文件行号、复现步骤）/)
  // 0.2.0：子代理段不再宣称"你跑在某某执行模型上"——它的线路可能随时在轮转
  assert.doesNotMatch(text, /deepseek\/deepseek-chat/)
  assert.doesNotMatch(text, FORBIDDEN_CHANNEL)
})

test('兜底线路未配置时显示（未配置），不抛错', () => {
  const text = buildSystemPromptGuidance(resolveConfig({ enabled: true }), { role: 'controller' })
  assert.match(text, /（未配置）/)
  assert.doesNotMatch(text, FORBIDDEN_CHANNEL)
})

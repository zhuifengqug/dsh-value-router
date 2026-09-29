/**
 * 注入主模型的系统提示段（order 145）。
 *
 * 两个角色段：
 * - controller：主控模型（即用户所选模型）——拆解、派发、审查、交付；
 * - subagent：被派发的执行子代理——只做当前单项任务，不再递归派发。
 *
 * 纯函数，不依赖运行时。
 *
 * 2026-09-29（0.2.0）重写要点：
 * - **删掉**旧文案里那句「subagent/subagent_fork/workflow 会被插件自动路由到执行模型，
 *   无需也不应手动指定模型」——它与新需求直接冲突（用户要的就是不同子任务能用不同模型）。
 * - 新增「线路池」段：把可用的线路清单告诉主控，并规定「不指定时系统会按序轮转分配」，
 *   否则主控会以为不指定就是继承主模型（事实确实如此，插件随后才会改写）。
 * - 「独立复核走强模型」**降级为提示词建议，不是强制**。原因：`agent/request` 的
 *   payload 只有 `{agent, turn, step, signal}`，没有任务描述，插件在路由层无法判定
 *   「这是不是复核类任务」。任何声称"强制"的文案都是虚假承诺。
 */

import type { ResolvedValueRouterConfig, ValueRouterRole, ValueRouterStrategy } from './config.ts'
import { formatModelRoute, strategyLabel, tierLabel } from './config.ts'

export const VALUE_ROUTER_SECTION_NAME = 'value-router:guidance'
export const VALUE_ROUTER_SECTION_ORDER = 145

/** 派发倾向（按档位）。 */
function dispatchGuidance(strategy: ValueRouterStrategy): string {
  if (strategy === 'saver') {
    return [
      '派发倾向（少用子代理）：优先自己直接处理；只有任务能明确拆成互不依赖的部分、需要并行调查，',
      '或确实高耗时，才派发子代理。不要为了「显得在并行」而拆任务。',
    ].join('')
  }
  if (strategy === 'powerful') {
    return [
      '派发倾向（多用子代理）：复杂架构、疑难根因、安全关键逻辑、大型重构或可并行拆分的调查，积极派发子代理，',
      '并要求其返回证据（命令输出、文件行号、复现步骤）。',
    ].join('')
  }
  return [
    '派发倾向（正常用）：命中任一条即**优先派发子代理**，而不是自己一路做到底——',
    '① 需要在多个文件/目录间调查或检索；② 能拆成 2 个以上互不依赖的调查或实现片段（可并行）；',
    '③ 大范围重构、批量改动或机械性重复工作；④ 需要独立复核（让子代理给证据，你来裁决）。',
    '单文件小改动、单轮问答、需要你亲自拍板的部分自己处理。',
  ].join('')
}

/**
 * 线路池段。池为空时**整段省略**——不能向模型承诺一个不存在的围栏。
 */
function poolSegment(config: ResolvedValueRouterConfig): string {
  if (config.pool.length === 0) return ''
  const lines = config.pool
    .map((line) => `    - ${line.provider}/${line.model}（${tierLabel(line.tier)}档）`)
    .join('\n')
  return [
    '',
    '线路池（子代理可用线路）：',
    lines,
    '规则：',
    '· 你可以显式指定其中任意一条（subagent 的 provider / model / reasoning_effort 参数），',
    '  也可以什么都不指定——什么都不指定时，系统会按上面的顺序轮转分配一条线路给你，',
    '  这样并行的子代理会落在**不同模型**上，既避免思考盲区，也避免单条线路的并发瓶颈。',
    '· 不要指定清单以外的线路：指定了会被宿主直接拒绝，该次工具调用失败。',
    '· 选档参考：机械检索、批量改动 → 省档；需要设计判断或跨文件推理 → 中档；',
    '  独立复核、安全关键结论、疑难根因 → 强档。',
  ].join('\n')
}

/** 执行子代理段。 */
function subagentSegment(config: ResolvedValueRouterConfig): string {
  return [
    '[价值路由·执行子代理] ',
    '你是主控模型派发的执行子代理，只完成当前明确的单项任务。',
    '不要再次派发子代理，不要调用 subagent / subagent_fork / workflow（防止递归下沉）。',
    '不要越界修改无关内容；给出可验证的结果、证据（命令输出、文件行号、复现步骤）、风险与下一步建议，由主控负责最终汇总与交付。',
  ].join('')
}

/** 主控模型段。 */
function controllerSegment(config: ResolvedValueRouterConfig): string {
  return [
    `[价值路由·${strategyLabel(config.strategy)}] `,
    '你是本次会话的主控模型（即用户所选模型），负责理解任务、拆解工作、决定是否派发、审查结果并对最终交付负责。',
    '主模型永远不会被本插件改写；被改写的只有子代理。',
    dispatchGuidance(config.strategy),
    '不得以「来不及 / 太麻烦」为由回避派发：能用子代理做的大块工作，不要自己一条龙跑完。',
    poolSegment(config),
    `兜底线路（仅当轮转池为空、或你指定的线路 provider 不可用时才用）：${formatModelRoute(config.executor)}。`,
    '子代理是「一次性」的：每次 subagent 调用都会新建独立子会话并继承上下文，开销很高；相同后续工作优先用 send_message 复用已有子代理。',
  ].filter(line => line !== '').join('\n')
}

export function buildSystemPromptGuidance(
  config: ResolvedValueRouterConfig,
  options: { role?: ValueRouterRole } = {},
): string {
  if (!config.enabled) return ''
  return options.role === 'subagent' ? subagentSegment(config) : controllerSegment(config)
}

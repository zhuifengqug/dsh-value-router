/**
 * 注入主模型的系统提示段（规格 §3.3，order 145）。
 *
 * 两个角色段：
 * - controller：主控模型（即用户所选模型）——拆解、派发、审查、交付；
 * - subagent：被路由到 executor 的执行子代理——只做当前单项任务，不再递归派发。
 *
 * 纯函数，不依赖运行时。桥接通道退役后，本段只描述**子代理派发**这一件事，
 * 不再有桥工具用法与桥外发纪律。
 */

import type { ResolvedValueRouterConfig, ValueRouterRole, ValueRouterStrategy } from './config.ts'
import { formatModelRoute, strategyLabel } from './config.ts'

export const VALUE_ROUTER_SECTION_NAME = 'value-router:guidance'
export const VALUE_ROUTER_SECTION_ORDER = 145

/** 派发指导（按档位）。 */
function dispatchGuidance(strategy: ValueRouterStrategy): string {
  if (strategy === 'saver') {
    return '派发策略（更省）：优先自己直接处理；只有任务能明确拆分、需要并行调查或确实高耗时，才派发子代理。'
  }
  if (strategy === 'powerful') {
    return '派发策略（更强）：复杂架构、疑难根因、安全关键逻辑、大型重构或可并行拆分的调查，积极派发子代理，并要求其返回证据（命令输出、文件行号、复现步骤）。'
  }
  return [
    '派发策略（平衡）：命中任一条即**优先派发子代理**，而不是自己一路做到底——',
    '① 需要在多个文件/目录间调查或检索；② 能拆成 2 个以上互不依赖的调查或实现片段（可并行）；',
    '③ 大范围重构、批量改动或机械性重复工作；④ 需要独立复核（让子代理给证据，你来裁决）。',
    '单文件小改动、单轮问答、需要你亲自拍板的部分自己处理。',
  ].join('')
}

/** 执行子代理段。 */
function subagentSegment(config: ResolvedValueRouterConfig): string {
  return [
    '[价值路由·执行子代理] ',
    `你是主控模型派发的执行子代理（执行模型 ${formatModelRoute(config.executor)}），只完成当前明确的单项任务。`,
    '不要再次派发子代理，不要调用 subagent / subagent_fork / workflow（防止递归下沉）。',
    '不要越界修改无关内容；给出可验证的结果、证据（命令输出、文件行号、复现步骤）、风险与下一步建议，由主控负责最终汇总与交付。',
  ].join('')
}

/** 主控模型段。 */
function controllerSegment(config: ResolvedValueRouterConfig): string {
  return [
    `[价值路由·${strategyLabel(config.strategy)}] `,
    '你是本次会话的主控模型（即用户所选模型），负责理解任务、拆解工作、决定是否派发、审查结果并对最终交付负责。',
    `subagent / subagent_fork / workflow 子代理会被插件自动路由到执行模型 ${formatModelRoute(config.executor)}，无需也不应手动指定模型。`,
    dispatchGuidance(config.strategy),
    '子代理是「一次性」的：每次 subagent 调用都会新建独立子会话并继承上下文，开销很高；相同后续工作优先用 send_message 复用已有子代理。',
  ].join('\n')
}

export function buildSystemPromptGuidance(
  config: ResolvedValueRouterConfig,
  options: { role?: ValueRouterRole } = {},
): string {
  if (!config.enabled) return ''
  return options.role === 'subagent' ? subagentSegment(config) : controllerSegment(config)
}

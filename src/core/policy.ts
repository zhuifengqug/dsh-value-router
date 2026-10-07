/**
 * 注入主模型的系统提示段（order 145）。
 *
 * 两个角色段：
 * - controller：主控模型（即用户所选模型）——拆解、判难度、派发、审查、交付；
 * - subagent：被派发的执行子代理——只做当前单项任务，不再递归派发。
 *
 * 纯函数，不依赖运行时。
 *
 * 0.10.0 重写要点：
 * - 删掉 0.2.x 的「轮转池」文案：池的概念已退役，档位固定四档。
 * - 删掉「主控点名某条线路 → 插件在该档内轮转」的旧语义：现在主控给的 route 是**偏好**，
 *   合法就直接用，不合法只记录 `route-rejected` 再自动重选。
 * - 难度语义写清楚：四档是**成本档**，档内轮转用于摊开额度，降级只朝更低档走。
 */

import type { ResolvedValueRouterConfig } from './config.ts'
import { DIFFICULTIES, isCompleteLine, tierLabel } from './config.ts'
import type { ValueRouterRole } from './snapshot.ts'

export const VALUE_ROUTER_SECTION_NAME = 'value-router:guidance'
export const VALUE_ROUTER_SECTION_ORDER = 145

/** 四档语义（主控判难度时照这个分）。 */
const DIFFICULTY_GUIDE: Record<string, string> = {
  low: '机械检索、批量改动、格式清理、单点重命名',
  medium: '常规实现与调查、单模块改动、写测试',
  high: '需要设计判断或跨文件推理、接口与契约变更、较大重构',
  max: '疑难根因、安全关键结论、独立复核、跨模块架构决策',
}

/** 列档段：只列**目录里可用**的线路。没有任何可用线路时整段省略——不承诺不存在的围栏。 */
function tierSegment(config: ResolvedValueRouterConfig): string {
  const usable = config.tiers
    .map(tier => ({ tier, lines: tier.lines.filter(line => line.status === 'available') }))
    .filter(item => item.lines.length > 0)
  if (usable.length === 0) return ''

  const missing = config.tiers.reduce(
    (sum, tier) => sum + tier.lines.filter(line => line.status !== 'available').length,
    0,
  )
  const groups = usable
    .map(({ tier, lines }) => [
      `  ${tierLabel(tier.id)}档（difficulty=${tier.id}）——${DIFFICULTY_GUIDE[tier.id] ?? ''}：`,
      ...lines.map(line => `    - ${line.provider}/${line.model}${line.reasoning_effort === '' ? '' : ` @${line.reasoning_effort}`}`),
    ].join('\n'))
    .join('\n')

  return [
    '',
    '子代理线路池（四档，difficulty 从低到高 = 成本从低到高）：',
    groups,
    '规则：',
    '· **你负责判难度**：派发时用 difficulty 表达任务难度（low/medium/high/max），不要靠"猜一个模型名"来定档。',
    '· 不指定难度时按 medium 处理；不指定角色时按 general 处理。',
    '· 你也可以给出 route（provider / model / reasoning_effort）作为**偏好**：合法就直接用；',
    '  不合法的偏好只会被记成 route-rejected，然后系统按 difficulty/role 自动重选——不会让你的任务失败。',
    '· **用户显式指定的线路优先于你**，且用户线路不可用时任务会保持待定而不是换线路。',
    '· 系统自动选择时**只会降级到更低档，绝不升档**；降级与兜底都会记进审计。',
    '· 不要指定清单以外的线路：宿主白名单会直接拒绝该次调用。',
    config.fallback.status === 'available' && isCompleteLine(config.fallback)
      ? `· 全局兜底线路（只在四档都无可用线路时使用，不是轮转成员）：${config.fallback.provider}/${config.fallback.model}。`
      : '',
    missing > 0
      ? `· 另有 ${missing} 条已分档线路当前不在宿主模型目录中（标记 missing），系统不会派发它们；它们在目录恢复后自动可用。`
      : '',
  ].filter(line => line !== '').join('\n')
}

/** 执行子代理段。 */
function subagentSegment(): string {
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
    '[价值路由] ',
    '你是本次会话的主控模型（即用户所选模型），负责理解任务、拆解工作、判断难度、决定是否派发、审查结果并对最终交付负责。',
    '主模型永远不会被本插件改写；被改写的只有子代理与团队成员的模型线路。',
    `难度四档：${DIFFICULTIES.map(id => `${id}=${DIFFICULTY_GUIDE[id] ?? ''}`).join('；')}。`,
    '不得以「来不及 / 太麻烦」为由回避派发：能用子代理做的大块工作，不要自己一条龙跑完。',
    tierSegment(config),
    '子代理是「一次性」的：每次 subagent 调用都会新建独立子会话并继承上下文，开销很高；相同后续工作优先用 send_message 复用已有子代理。',
  ].filter(line => line !== '').join('\n')
}

export function buildSystemPromptGuidance(
  config: ResolvedValueRouterConfig,
  options: { role?: ValueRouterRole } = {},
): string {
  if (!config.enabled) return ''
  return options.role === 'subagent' ? subagentSegment() : controllerSegment(config)
}

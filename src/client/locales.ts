/**
 * 价值路由（Value Router）浏览器侧文案。
 *
 * 命名空间 'value-router' 与宿主设置 namespace 同名。中文为主、英文为兜底。
 *
 * 0.10.0：四档固定（low/medium/high/max）+ 单一全局 fallback；
 * 已退役的概念（strategy / 动态档位与线路池 / executor / 会话覆写）不再有文案。
 */

export const zh = {
  // —— 通用状态与错误 ——
  settingsNotWritable: '当前配置不可写，请等待运行时连接恢复后重试。',
  settingsSaveFailed: '配置未保存成功，请重试。',
  catalogUnavailable: '模型目录尚未连接，请稍后重试。',
  catalogTimeout: '模型目录查询超时，请检查运行时连接后重试。',
  catalogChanged: '模型配置或运行时已变化，请重试以读取最新目录。',
  catalogLoadFailed: '模型目录加载失败，请稍后重试。',

  // —— 插件身份 ——
  title: '价值路由',
  /** 设置左侧栏里的独立分区标题。 */
  sectionLabel: '价值路由',
  description:
    '统一的模型路由 owner：主模型永不被接管，子代理与团队成员按任务难度落到不同档位的线路上。四档顺序即成本顺序，档内轮转用于摊开额度，降级只朝更低档走。',
  descSupplement: '线路从你已经配置好的供应商中选择，不需要重新填写 API Key。',

  // —— 运行状态 ——
  status: '运行状态',
  enabled: '已开启',
  disabled: '已关闭',
  unconfigured: '配置不完整',
  degraded: '部分模型不可用',

  // —— 四档 ——
  tiers: '四档线路',
  tierLow: '低（low）',
  tierLowDesc: '机械检索、批量改动、格式清理、单点重命名',
  tierMedium: '中（medium）',
  tierMediumDesc: '常规实现与调查、单模块改动、写测试（缺省档）',
  tierHigh: '高（high）',
  tierHighDesc: '需要设计判断或跨文件推理、接口与契约变更、较大重构',
  tierMax: '最高（max）',
  tierMaxDesc: '疑难根因、安全关键结论、独立复核、跨模块架构决策',
  tierEmpty: '该档暂无线路；请求落到这一档时会向下降级，绝不自动升档。',
  tierHint:
    '档内顺序即轮转顺序（第 N 个任务拿第 N 条，取模循环）。同一个 provider/model 可以跨档各配一条（例如同一模型配不同 reasoning_effort）。没有分档的模型不会被自动派发。',

  // —— 线路编辑 ——
  lineAdd: '添加线路',
  lineRemove: '删除',
  lineMoveUp: '上移',
  lineMoveDown: '下移',
  lineMissing: '已从宿主模型目录消失，保留配置但不会派发',
  lineBlocked: '不在宿主白名单，不会被派发',
  lineEffortUnverified: '该模型未声明 reasoning_effort 能力，按原值保留未做校验',
  reasoningEffort: '推理强度',
  reasoningEffortDefault: '跟随模型默认',
  reasoningEffortHint: '留空即不指定，由目标模型使用自己的默认档位。',
  notSelected: '未配置',
  change: '更换',
  selectModel: '选择模型',
  noAvailableModels: '暂无可用的已配置模型，请先在模型设置中添加供应商。',

  // —— 兜底 ——
  fallback: '全局兜底线路',
  fallbackDesc:
    '它不是任何档位的轮转成员：只有四档全部无可用线路时才使用。没有它，四档全空时任务会保持待定而不是继承主模型。',

  // —— 顶栏徽章与气泡 ——
  headerStatusPrefix: '价值路由',
  quickSettings: '价值路由状态',
  openFullSettings: '完整设置',
  sessionRoutedCalls: '本会话改写',
  totalRoutedCalls: '累计改写',
  availableLines: '可用线路',
  missingLines: '目录缺失',
  blockedLines: '白名单外',
  allowlistUnknown: '读不到宿主白名单，暂不做拦截',
  recentDispatches: '最近派发',
  recentEvents: '运行事件',
  noDispatches: '本会话还没有改写过子代理线路。',
  routeRejected: '主模型线路被拒，已自动重选',
  fallbackUsed: '使用了全局兜底',
  degradedRoute: '已降级到更低档',
  queued: '排队中',
  queueReason: '排队原因',
  routeSourceUser: '用户指定',
  routeSourceCaptain: '主模型偏好',
  routeSourceDifficulty: '难度档位',
  routeSourceFallback: '全局兜底',

  // —— 首次引导 ——
  onboardingTitle: '首次使用指引',
  onboardingStep1: '第一步：选择全局兜底线路',
  onboardingStep2: '第二步：给需要的档位补线路（可稍后配置）',
  onboardingComplete: '确认并开启价值路由',
  onboardingLead:
    '主模型负责理解与最终交付，子代理按难度落到不同档位。先给一条全局兜底线路保证「四档全空」时有路可走，完整的分档请到「设置 → 插件」里配置。',
  onboardingSaving: '保存并开启中…',

  // —— 收尾 ——
  times: '次',
  active: '生效中',
  inactive: '未生效',
  cancel: '取消',
  save: '保存',
  close: '关闭',
  retry: '重试',
} as const

export type ValueRouterLocaleKey = keyof typeof zh

export const en: Record<ValueRouterLocaleKey, string> = {
  settingsNotWritable: 'Settings are not writable. Wait for the runtime connection and try again.',
  settingsSaveFailed: 'Settings were not saved. Please try again.',
  catalogUnavailable: 'The model catalog is not connected yet. Please retry shortly.',
  catalogTimeout: 'The model catalog request timed out. Check the runtime connection and retry.',
  catalogChanged: 'The model configuration or runtime changed. Retry to load the current catalog.',
  catalogLoadFailed: 'The model catalog could not be loaded. Please retry.',

  title: 'Value Router',
  sectionLabel: 'Value Router',
  description:
    'The single model-routing owner: the primary model is never taken over, while subagents and team members land on routes of different tiers by task difficulty. Tier order is cost order; rotation spreads quota within a tier and degradation only ever moves downwards.',
  descSupplement: 'Routes are chosen from providers already configured in DeepSeek Harness without re-entering API keys.',

  status: 'Status',
  enabled: 'Enabled',
  disabled: 'Disabled',
  unconfigured: 'Incomplete Configuration',
  degraded: 'Partially Unavailable',

  tiers: 'Four Tiers',
  tierLow: 'Low',
  tierLowDesc: 'Mechanical search, bulk edits, formatting, single renames',
  tierMedium: 'Medium',
  tierMediumDesc: 'Routine implementation and investigation, single-module change, tests (default tier)',
  tierHigh: 'High',
  tierHighDesc: 'Design judgement or cross-file reasoning, interface and contract changes, larger refactors',
  tierMax: 'Max',
  tierMaxDesc: 'Hard root-cause work, security-critical conclusions, independent review, cross-module architecture',
  tierEmpty: 'No routes in this tier; a request landing here degrades downwards and never upgrades automatically.',
  tierHint:
    'Route order within a tier is the rotation order (subagent N takes route N, wrapping around). The same provider/model may appear in several tiers (for example with different reasoning_effort). A model that is not classified into a tier is never dispatched automatically.',

  lineAdd: 'Add Route',
  lineRemove: 'Remove',
  lineMoveUp: 'Move Up',
  lineMoveDown: 'Move Down',
  lineMissing: 'Gone from the host model catalog; kept but never dispatched',
  lineBlocked: 'Not in the host allowlist; never dispatched',
  lineEffortUnverified: 'This model declares no reasoning_effort capability; the value is kept unverified',
  reasoningEffort: 'Reasoning Effort',
  reasoningEffortDefault: 'Model default',
  reasoningEffortHint: 'Leave empty to specify nothing and let the target model use its own default.',
  notSelected: 'Not Configured',
  change: 'Change',
  selectModel: 'Select Model',
  noAvailableModels: 'No configured models available. Please add a provider in Settings first.',

  fallback: 'Global Fallback Route',
  fallbackDesc:
    'Not a rotation member of any tier: used only when all four tiers have no available route. Without it, a task stays pending instead of inheriting the primary model.',

  headerStatusPrefix: 'Value Router',
  quickSettings: 'Value Router status',
  openFullSettings: 'Full settings',
  sessionRoutedCalls: 'Session rewrites',
  totalRoutedCalls: 'Total rewrites',
  availableLines: 'Available',
  missingLines: 'Missing',
  blockedLines: 'Blocked',
  allowlistUnknown: 'Host allowlist unreadable; no gating applied',
  recentDispatches: 'Recent dispatches',
  recentEvents: 'Runtime events',
  noDispatches: 'No subagent route has been rewritten in this session yet.',
  routeRejected: 'Captain route rejected, auto-reselected',
  fallbackUsed: 'Global fallback used',
  degradedRoute: 'Degraded to a lower tier',
  queued: 'Queued',
  queueReason: 'Queue reason',
  routeSourceUser: 'User-specified',
  routeSourceCaptain: 'Captain preference',
  routeSourceDifficulty: 'Difficulty tier',
  routeSourceFallback: 'Global fallback',

  onboardingTitle: 'Getting Started',
  onboardingStep1: 'Step 1: Select a global fallback route',
  onboardingStep2: 'Step 2: Add routes to the tiers you need (can be done later)',
  onboardingComplete: 'Confirm and enable Value Router',
  onboardingLead:
    'The primary model owns understanding and final delivery; subagents land on tiers by difficulty. Start with one global fallback route so an all-tiers-empty situation still has a path — the full tier layout lives in Settings → Plugins.',
  onboardingSaving: 'Saving and enabling…',

  times: 'calls',
  active: 'Active',
  inactive: 'Inactive',
  cancel: 'Cancel',
  save: 'Save',
  close: 'Close',
  retry: 'Retry',
}

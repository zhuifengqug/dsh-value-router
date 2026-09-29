/**
 * 价值路由（Value Router）浏览器侧文案。
 *
 * 命名空间 'value-router' 与宿主设置 namespace 同名。中文为主、英文为兜底；
 * 主模型永不被插件接管，因此不存在任何「主控模型」相关文案。
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
  description:
    '主模型永不被接管。主控没显式指定线路时，子代理按轮转池依次分配——并行的子代理落在不同模型上，既补上思考盲区，也避开单条线路的并发瓶颈。对所有预设生效。',
  descSupplement: '线路从你已经配置好的供应商中选择，不需要重新填写 API Key。',

  // —— 运行状态 ——
  status: '运行状态',
  enabled: '已开启',
  disabled: '已关闭',
  unconfigured: '配置不完整',
  degraded: '部分模型不可用',

  // —— 路由区 ——
  executorModel: 'executor 子代理执行模型',
  executorDesc: '只执行主模型派发的单项任务，适合并行调查、局部实现和重复性工作。',
  change: '更换',
  selectModel: '选择模型',
  notSelected: '未配置',
  noAvailableModels: '暂无可用的已配置模型，请先在模型设置中添加供应商。',
  reasoningEffort: 'executor 推理强度',
  reasoningEffortDefault: '跟随模型默认',
  reasoningEffortHint: '子代理请求使用该档位；跟随模型默认时不强制指定。',

  strategy: '运行策略',
  strategySaver: '更省',
  strategySaverDesc: '少派发：控制子代理调用次数，把调用留给真正必要的任务。',
  strategyBalanced: '平衡',
  strategyBalancedDesc: '按任务复杂度派发，重要结果由主模型复核。',
  strategyPowerful: '更强',
  strategyPowerfulDesc: '积极派发并行子任务，要求执行结果附带证据，优先交付质量。',

  // —— 档位与线路池（0.4.0）——
  tiers: '子代理档位与线路池',
  tiersEmpty: '尚未添加档位。没有档位时子代理会继承主模型——那是最贵的一条。',
  tierAdd: '添加档位',
  tierRemove: '删除档位',
  tierLowest: '最低档 —— 主控未指定线路时在这里轮转',
  tierExplicitOnly: '仅在主控显式指定时命中',
  poolAddTo: '添加线路到该档',
  poolRemove: '删除',
  poolMoveUp: '上移',
  poolMoveDown: '下移',
  poolBlocked: '不在宿主白名单，不会被派发',
  poolHint: '档位数量与名称都不限，顺序即优先级：第一个是最低档，也是主控没指定线路时的默认轮转池；越靠后的档位只有主控显式指定才会命中。档内顺序同样是轮转顺序（第 N 个子代理拿第 N 条，取模循环）。同一个模型可以在多家 provider 各放一条，用来把订阅额度摊开。',
  poolPreview: '最低档轮转顺序（前 6 个子代理）',
  fallback: '兜底线路',
  fallbackDesc: '只在所有档位都没有可派线路、或目标线路的 provider 不可用时才用。宿主本身不提供默认线路——没有它，子代理会直接继承主模型。',

  // —— 顶栏徽章与气泡 ——
  headerStatusPrefix: '价值路由',
  quickSettings: '价值路由快捷设置',
  openFullSettings: '完整设置',
  thisSessionOnly: '仅本会话',
  globalDefault: '全局默认',
  sessionOverrideActive: '已覆写',
  resetSessionOverride: '重置会话覆写',
  sessionOverrideHint: '会话覆写只写宿主内存，不改动全局设置。',
  sessionExecutorCalls: '本会话改写',
  totalExecutorCalls: '累计改写',

  // —— 首次引导 ——
  onboardingTitle: '首次使用指引',
  onboardingStep1: '第一步：选择兜底线路',
  onboardingStep2: '第二步：选择派发倾向（默认平衡）',
  onboardingComplete: '确认并开启价值路由',
  onboardingLead: '主模型负责理解与最终交付，子代理负责并行执行。先给一条兜底线路，完整的多模型轮转池请到「设置 → 插件」里配置。',
  onboardingSaving: '保存并开启中…',
  onboardingScopeHint: '配置保存在全局设置中，可在完整设置里调整。',

  // —— 收尾 ——
  times: '次',
  active: '生效中',
  inactive: '未生效',
  cancel: '取消',
  save: '保存',
  close: '关闭',
  estimated: '估算',
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
  description:
    'The primary model is never taken over. When the controller does not name a route, subagents are assigned by rotating through the pool — parallel subagents land on different models, which covers more thinking blind spots and avoids a single-route concurrency bottleneck. Applies to every preset.',
  descSupplement: 'Routes are chosen from providers already configured in DeepSeek Harness without re-entering API keys.',

  status: 'Status',
  enabled: 'Enabled',
  disabled: 'Disabled',
  unconfigured: 'Incomplete Configuration',
  degraded: 'Partially Unavailable',

  executorModel: 'Executor Subagent Model',
  executorDesc: 'Runs only bounded tasks delegated by the primary model, such as investigation and local implementation.',
  change: 'Change',
  selectModel: 'Select Model',
  notSelected: 'Not Configured',
  noAvailableModels: 'No configured models available. Please add a provider in Settings first.',
  reasoningEffort: 'Executor Reasoning Effort',
  reasoningEffortDefault: 'Model default',
  reasoningEffortHint: 'Delegated requests use this effort; the model default is not forced.',

  strategy: 'Strategy',
  strategySaver: 'Saver',
  strategySaverDesc: 'Dispatch less: cap subagent calls and reserve them for tasks that truly need them.',
  strategyBalanced: 'Balanced',
  strategyBalancedDesc: 'Delegate by task complexity, with the primary model reviewing important results.',
  strategyPowerful: 'Powerful',
  strategyPowerfulDesc: 'Dispatch subagents eagerly in parallel and require evidence in results, favouring delivery quality.',

  // —— rotation tiers (0.4.0) ——
  tiers: 'Subagent Tiers & Pools',
  tiersEmpty: 'No tiers yet. Without one, subagents inherit the primary model — the most expensive route.',
  tierAdd: 'Add Tier',
  tierRemove: 'Remove Tier',
  tierLowest: 'lowest — rotation lands here when the controller names no route',
  tierExplicitOnly: 'only reached when the controller names a route explicitly',
  poolAddTo: 'Add Route to Tier',
  poolRemove: 'Remove',
  poolMoveUp: 'Move Up',
  poolMoveDown: 'Move Down',
  poolBlocked: 'Not in the host allowlist; never dispatched',
  poolHint: 'Any number of tiers, any names. List order is priority: the first tier is the lowest and is the default rotation pool; later tiers are only reached by an explicit controller choice. Route order within a tier is the rotation order (subagent N takes route N, wrapping around). The same model can appear under several providers to spread subscription quota.',
  poolPreview: 'Rotation order in the lowest tier (first 6 subagents)',
  fallback: 'Fallback Route',
  fallbackDesc: 'Used only when no tier has a dispatchable route, or the selected route provider is unavailable. The host provides no default route — without one, subagents inherit the primary model directly.',

  headerStatusPrefix: 'Value Router',
  quickSettings: 'Value Router quick settings',
  openFullSettings: 'Full settings',
  thisSessionOnly: 'This session',
  globalDefault: 'Global default',
  sessionOverrideActive: 'overridden',
  resetSessionOverride: 'Reset session override',
  sessionOverrideHint: 'A session override is kept in host memory and never changes global settings. The pool is global-only.',
  sessionExecutorCalls: 'Session rewrites',
  totalExecutorCalls: 'Total rewrites',

  onboardingTitle: 'Getting Started',
  onboardingStep1: 'Step 1: Select a fallback route',
  onboardingStep2: 'Step 2: Select a dispatch tendency (Balanced by default)',
  onboardingComplete: 'Confirm and enable Value Router',
  onboardingLead: 'The primary model owns understanding and final delivery; subagents run in parallel. Start with a fallback route — the full multi-model pool lives in Settings → Plugins.',
  onboardingSaving: 'Saving and enabling…',
  onboardingScopeHint: 'Configuration is saved to global settings and can be tuned in the full settings card.',

  times: 'calls',
  active: 'Active',
  inactive: 'Inactive',
  cancel: 'Cancel',
  save: 'Save',
  close: 'Close',
  estimated: 'estimated',
  retry: 'Retry',
}

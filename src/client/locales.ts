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
    '主模型永不被接管：带工具的子任务下沉给更便宜的 executor 子代理执行，派发的积极程度由运行策略决定。',
  descSupplement: 'executor 从你已经配置好的供应商中选择，不需要重新填写 API Key。',

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

  scope: '生效范围',
  scopePreset: '仅专属预设',
  scopePresetDesc: '只在「价值路由」预设的会话内生效。',
  scopeGlobal: '所有预设',
  scopeGlobalDesc: '在所有预设中生效，可用排除清单跳过指定预设。',
  excludePresets: '排除预设',
  excludePresetsHint: '逗号分隔的预设 id；仅在「所有预设」范围下生效。',

  // —— 顶栏徽章与气泡 ——
  headerStatusPrefix: '价值路由',
  quickSettings: '价值路由快捷设置',
  openFullSettings: '完整设置',
  thisSessionOnly: '仅本会话',
  globalDefault: '全局默认',
  sessionOverrideActive: '已覆写',
  resetSessionOverride: '重置会话覆写',
  sessionOverrideHint: '会话覆写只写宿主内存，不改动全局设置。',
  sessionExecutorCalls: '本会话 executor 调用',
  totalExecutorCalls: '累计 executor 调用',

  // —— 首次引导 ——
  onboardingTitle: '首次使用指引',
  onboardingStep1: '第一步：选择 executor 子代理执行模型（接收下沉的子任务）',
  onboardingStep2: '第二步：选择运行策略（默认平衡）',
  onboardingStep3: '第三步：选择生效范围（专属预设 / 所有预设）',
  onboardingComplete: '确认并开启价值路由',
  onboardingLead: '主模型负责理解与最终交付，executor 只执行下沉的子任务。完成三步即可开启。',
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
    'The primary model is never taken over: tool-using subtasks sink to a cheaper executor subagent, and how eagerly they are dispatched is decided by the strategy.',
  descSupplement: 'The executor is chosen from providers already configured in DeepSeek Harness without re-entering API keys.',

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

  scope: 'Scope',
  scopePreset: 'Dedicated preset only',
  scopePresetDesc: 'Only sessions running the Value Router preset.',
  scopeGlobal: 'All presets',
  scopeGlobalDesc: 'Every preset, minus the exclusion list.',
  excludePresets: 'Excluded presets',
  excludePresetsHint: 'Comma-separated preset ids; applies to the all-presets scope only.',

  headerStatusPrefix: 'Value Router',
  quickSettings: 'Value Router quick settings',
  openFullSettings: 'Full settings',
  thisSessionOnly: 'This session',
  globalDefault: 'Global default',
  sessionOverrideActive: 'overridden',
  resetSessionOverride: 'Reset session override',
  sessionOverrideHint: 'A session override is kept in host memory and never changes global settings.',
  sessionExecutorCalls: 'Session executor calls',
  totalExecutorCalls: 'Total executor calls',

  onboardingTitle: 'Getting Started',
  onboardingStep1: 'Step 1: Select the executor subagent model (receives delegated subtasks)',
  onboardingStep2: 'Step 2: Select a strategy (Balanced by default)',
  onboardingStep3: 'Step 3: Select the scope (dedicated preset or all presets)',
  onboardingComplete: 'Confirm and enable Value Router',
  onboardingLead: 'The primary model owns understanding and final delivery; the executor only runs delegated subtasks. Three steps and you are done.',
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

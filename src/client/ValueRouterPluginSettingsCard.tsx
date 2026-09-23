/**
 * 「插件」设置区里的独立卡片（settings.plugin.item）。
 *
 * 与官方 PluginCard 同一契约：一个 <li>，头部按钮（名称 + 描述）就地展开本插件的
 * 控件。卡内 open 状态只是阅读手势。展开箭头用文本字形，不引入图标依赖。
 */

import React, { useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ValueRouterConfig } from '../core/config.ts'
import { isCompleteModelRoute, resolveEffectiveConfig } from '../core/config.ts'
import type { ValueRouterModelCatalog } from './ModelPicker.tsx'
import { ValueRouterSettingsCard } from './ValueRouterSettingsCard.tsx'
import { useValueRouterConfig } from './useValueRouterConfig.ts'
import pluginItemStyles from './value-router-plugin-item.module.css'

export interface ValueRouterPluginSettingsCardProps {
  config: ValueRouterConfig
  settingsScope?: SettingsScope<ValueRouterConfig>
  onChange: (patch: Partial<ValueRouterConfig>) => Promise<void> | void
  fetchModels?: () => Promise<ValueRouterModelCatalog>
  clientCtx?: Context
}

export const ValueRouterPluginSettingsCard: React.FC<ValueRouterPluginSettingsCardProps> = ({
  config,
  settingsScope,
  onChange,
  fetchModels,
  clientCtx,
}) => {
  const [open, setOpen] = useState(false)
  // 折叠态也要显示状态胶囊，因此必须无条件调用 hooks（props 作为兜底）。
  const liveConfig = useValueRouterConfig(settingsScope, config)
  const resolved = resolveEffectiveConfig(liveConfig)
  const configured = isCompleteModelRoute(resolved.executor)
  const statusText = !configured ? '待配置' : resolved.enabled ? '已开启' : '已关闭'
  const statusClass = resolved.enabled && configured
    ? `${pluginItemStyles.statusDot} ${pluginItemStyles.statusOn}`
    : pluginItemStyles.statusDot
  return (
    <li
      className={`${pluginItemStyles.card}${open ? ` ${pluginItemStyles.cardOpen}` : ''}`}
      data-value-router-plugin-item="true"
    >
      <button
        type="button"
        className={pluginItemStyles.header}
        aria-expanded={open}
        aria-label={`${open ? '收起' : '展开'}：价值路由（${statusText}）`}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={pluginItemStyles.headText}>
          <span className={pluginItemStyles.name}>价值路由</span>
          <span className={pluginItemStyles.description}>
            主模型不被接管：带工具的子任务下沉给 executor 子代理执行。
          </span>
        </span>
        <span className={statusClass} aria-hidden="true">
          {statusText}
        </span>
        <span className={`${pluginItemStyles.chevron}${open ? ` ${pluginItemStyles.chevronOpen}` : ''}`} aria-hidden="true">
          ∨
        </span>
      </button>
      {open && (
        <div className={pluginItemStyles.body}>
          <ValueRouterSettingsCard
            config={config}
            settingsScope={settingsScope}
            onChange={onChange}
            fetchModels={fetchModels}
            clientCtx={clientCtx}
          />
        </div>
      )}
    </li>
  )
}

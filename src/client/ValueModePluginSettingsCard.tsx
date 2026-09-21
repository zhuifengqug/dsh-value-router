import React, { useState } from 'react'
import type { ModelRouteSelection, ValueModeConfig, ValueModeSettingsScope } from '../core/config.ts'
import { isConfigured, resolveResolvedConfig } from '../core/config.ts'
import type { ValueModeModelCatalog } from './ModelPicker.tsx'
import { ValueModeSettingsCard } from './ValueModeSettingsCard.tsx'
import { useSettingsValue, useValueModeConfig } from './useValueModeConfig.ts'
import pluginItemStyles from './value-mode-plugin-item.module.css'

/**
 * Standalone card for the official Plugins settings section.
 *
 * Follows the same contract as the official `PluginCard`: an `<li>` with a
 * header button (name over description) that discloses this plugin's
 * controls in place. Card-local `open` state is a reading gesture only.
 * Disclosure chevron is a text glyph so no icon dependency is introduced.
 */
export interface ValueModePluginSettingsCardProps {
  config: ValueModeConfig
  settingsScope?: ValueModeSettingsScope<ValueModeConfig>
  defaultModelScope?: ValueModeSettingsScope<ModelRouteSelection>
  onChange: (patch: Partial<ValueModeConfig>) => Promise<void> | void
  fetchModels?: () => Promise<ValueModeModelCatalog>
}

export const ValueModePluginSettingsCard: React.FC<ValueModePluginSettingsCardProps> = ({
  config,
  settingsScope,
  defaultModelScope,
  onChange,
  fetchModels,
}) => {
  const [open, setOpen] = useState(false)
  // Live status for the collapsed header pill. Hooks must run unconditionally,
  // so read the same scopes the inner card reads (props are the fallback).
  const liveConfig = useValueModeConfig(settingsScope, config)
  const defaultExpert = useSettingsValue<ModelRouteSelection | undefined>(defaultModelScope, undefined)
  const resolved = resolveResolvedConfig(liveConfig, defaultExpert)
  const configured = isConfigured(liveConfig, defaultExpert)
  const statusText = !configured ? '待配置' : resolved.enabled ? '已开启' : '已关闭'
  const statusClass = resolved.enabled && configured
    ? `${pluginItemStyles.statusDot} ${pluginItemStyles.statusOn}`
    : pluginItemStyles.statusDot
  return (
    <li
      className={`${pluginItemStyles.card}${open ? ` ${pluginItemStyles.cardOpen}` : ''}`}
      data-value-mode-plugin-item="true"
    >
      <button
        type="button"
        className={pluginItemStyles.header}
        aria-expanded={open}
        aria-label={`${open ? '收起' : '展开'}：性价比模式（${statusText}）`}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={pluginItemStyles.headText}>
          <span className={pluginItemStyles.name}>性价比模式</span>
          <span className={pluginItemStyles.description}>
            专家主控理解拆解，副模型按需协作，平衡质量与成本。
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
          <ValueModeSettingsCard
            config={config}
            settingsScope={settingsScope}
            defaultModelScope={defaultModelScope}
            onChange={onChange}
            fetchModels={fetchModels}
          />
        </div>
      )}
    </li>
  )
}

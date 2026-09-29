# Changelog

本文件记录 `@gjs27/dsh-value-router` 的版本变更。
[English](#changelog-english) · [中文](#changelog)

---

## 0.2.0 — 2026-09-29

本版本是**破坏性配置面重构 + 宿主大版本适配**。适配前插件仅在专属预设 `value-router` 内生效，
本版本起改为设置里的全局开关，对**全部预设**生效。

### Breaking

- **移除专属预设** `presets/value-router/`（`preset.yml` + `agent.cordis.yml`）。
  插件不再向 `<DSH_HOME>/.agent-presets/` 同步任何预设树，也不再注册任何工具行。
  / **Removed the dedicated `value-router` agent preset.** The plugin is now a global
  switch that applies to every preset.
- **配置面收缩并重构**：`scope` 与 `excludePresets` 两个字段被**删除**（不是废弃）。
  旧配置里的这些键会变成无害的未知键——schemastery 在非 strict 模式下会 merge 保留它们，
  插件读取时逐字段兜底，**不需要任何迁移代码，也不会让插件加载失败**。
  / **`scope` and `excludePresets` were removed**, not deprecated. Legacy values become
  harmless unknown keys; no migration code is required.
- **最低宿主提升到 DSH 0.1.7-rc.2**：`peerDependencies` 由
  `^0.1.5-rc.1 || ^0.1.6-alpha.1 || ^0.1.7-alpha.1 || ^0.1.7-rc.1`
  收窄为 `^0.1.7-rc.2`；`@deepseek-ai/schemastery` 同步收窄为 `^3.18.4`。
  在更早的宿主上安装会被拒绝（`incompatible-version`），或该插件行在启动时被静默禁用。
  / **Minimum host is now DSH 0.1.7-rc.2.** Older hosts reject the install or disable
  the plugin row at startup.
- **重写注入的系统提示段**：不再声明「子代理会被自动路由到执行模型，无需也不应手动指定模型」。
  新文案改为：主控可在线路池内显式选档；不指定时由系统按序轮转分配。
  / **Rewrote the injected system-prompt section.** The plugin no longer claims
  subagents are auto-routed and must not name a model.

### Added

- **轮转线路池**（`pool`，最多 4 条）：主控没显式指定线路时，子代理按
  `pool[N % 池长]` 分配。并行的子代理——**以及 Agent Team 的队友**——会自然落在
  不同模型上。设置卡给出实时轮转顺序预览。
  / **Rotation pool** (up to 4 routes). When the controller does not name a route,
  subagents are assigned by rotating through the pool, so parallel subagents — and
  Agent Team teammates — land on different models.
- **档位标注**（`cheap` / `mid` / `strong`）：只用于生成提示词文案与 UI 分组，
  **不参与路由判据**。
  / **Tier labels**: prompt text and UI grouping only, never a routing criterion.
- **`ambiguousPolicy`**（`rotate` | `respect`，默认 `rotate`）：处置「主控显式指定了
  与父模型相同的线路」这一宿主层无法区分的固有歧义。
  / **`ambiguousPolicy`**: how to treat the inherent ambiguity between "not
  specified, inherited" and "explicitly specified the same route as the parent".

### Changed

- `executor` 的语义从「子代理执行模型（唯一目标）」改为**兜底线路**：只在轮转池为空、
  或池中目标线路的 provider 不可用时使用。**该字段不能删除**——宿主不提供任何默认
  executor，主控未显式指定模型时子代理会继承主模型（最贵的一条）。
  / `executor` is now a **fallback route** rather than the single target. It cannot be
  removed: the host provides no default executor, so an unspecified subagent
  inherits the primary model.
- 路由不再**无条件改写**子代理线路：主控显式指定且与父线路不同 → 放行（`explicit-route`）。
  / Routing no longer overwrites unconditionally: an explicit controller selection is honoured.
- 提示段新增「不得以『来不及 / 太麻烦』为由回避派发」的硬约束句。
  / The prompt gains an explicit rule against skipping delegation out of laziness.
- 设置卡与顶栏气泡移除「生效范围 / 排除预设」与基于专属预设的首次引导链路，
  「executor」文案统一改为「兜底线路」。
- 产品遥测的 `scope` 事件退役，改为 `pool` 事件（只上报条数，不含模型名）。

### Fixed

- **修复过期的 typert 契约测试**：`test/typert.test.ts` 仍在断言 `codec.schema`，
  而 DSH 0.1.7-rc.2 的 `dsh-typert-loader` 要求的是 `create()` 惰性工厂。
  `src/typert.ts` 本身合规，**不是插件缺陷**。修测试前仓库处于红基线
  （60 个用例 4 个失败、`tsc` 退出码 2）。
  / **Fixed the outdated typert contract test.** `src/typert.ts` was already compliant;
  the assertions were stale against the 0.1.7-rc.2 loader.
- **修复半配置兜底线路的静默行为**：`assertConfigValid` 在 0.1.0 里是**死导入**
  （`src/index.ts` 导入但全项目无调用点），半配置校验从未执行。0.2.0 把处理下沉到
  `resolveConfig` 的 sanitize：半配置归一化为「未配置」并记 warn，**永不抛错**
  （0.1.7-rc.2 已移除插件可注册的 settings validate 回调，抛错会让整个插件树加载失败）。
  / **Fixed silent half-configured fallbacks.** The old validator was dead code and
  never ran; validation now sanitizes instead of throwing.
- 客户端迁移到 0.1.7-rc.2 的设置 API：`ctx.settingsScope` → `ctx.configForms`，
  `SettingsScope<T>` → `ConfigForm<T>`（入口 `configForms.get(entryId)`）。
  `ConfigForm.set()` 现返回 `Promise<boolean>`，写入器已用上该返回值。
  / Migrated the client to the 0.1.7-rc.2 settings API.

### Known limitations

- **Agent Team 成员无法逐个指定模型**。`spawn_teammate` 的工具参数只有
  `name` / `description` / `prompt` / `context`，没有模型字段；队友的 provider 来自插件的
  静态配置 `freshProvider` / `forkProvider`，且队友会话的 `header.origin` 在类型与运行时上
  只允许 `'subagent'`，插件**无法区分队友与普通子代理**。本版本通过轮转让队友自然分散到
  不同模型；若将来需要按角色精确分配，需等宿主给 `spawn_teammate` 增加模型入口。
  / **Per-member model selection for Agent Teams is not available.** Teammates still get
  different models through rotation, but exact per-role assignment needs host support.
- **「独立复核走强模型」是提示词建议，不是强制**。`agent/request` 的 payload 只有
  `{agent, turn, step, signal}`，没有任务描述，插件在路由层无法判定任务类型。
  任何声称"强制"的文案都是虚假承诺。
  / **"Review tasks must use the strong route" is a prompt suggestion, not enforced** —
  the routing payload carries no task description.
- 「显式指定 == 父模型」与「未指定、继承父模型」在宿主层不可区分，由 `ambiguousPolicy`
  近似处理（默认 `rotate`）。
  / The host cannot distinguish an explicit selection equal to the parent route from
  inheritance; `ambiguousPolicy` approximates it.
- 插件的线路池与宿主的 `subagent-model-selection-settings.allowedModels` 是**两份独立配置**，
  不会自动同步。二者时序不同（宿主在子代理创建前校验工具参数，插件在创建后改写），
  因此不会打架；最坏情况是主控选了宿主不认的线路 → 宿主抛 `gateway/bad-request`，
  该次工具调用失败。
- 已在 `<DSH_HOME>/.agent-presets/` 留下旧 `value-router` 目录的安装**需要手动删除**
  （插件不会自动删，避免误删用户自建的同名预设）。

### Supply chain

- 新增 `prepublishOnly` 校验链（`typecheck && test && build`）。安装期仍不执行任何代码
  （无 `postinstall` / `prepare`）。

---

<a id="changelog-english"></a>
# Changelog (English)

## 0.2.0 — 2026-09-29

Breaking configuration rework plus host major-version adaptation. See the Chinese
section above for the full, authoritative entry — the two sections are kept in sync
and the Chinese one is the reference.

**Breaking:** dedicated preset removed (global switch applies to every preset);
`scope` / `excludePresets` deleted (legacy values become harmless unknown keys, no
migration needed); minimum host raised to DSH 0.1.7-rc.2 with peer ranges narrowed;
injected system prompt rewritten.

**Added:** rotation pool (up to 4 routes, `N % pool.length`), tier labels
(prompt/UI only), `ambiguousPolicy`.

**Changed:** `executor` is now a fallback route, not the single target; explicit
controller selections are honoured instead of overwritten; settings UI drops the scope
selector and the preset-based onboarding chain.

**Fixed:** outdated typert contract test (the source was already compliant — this is
not a plugin defect); silently-dead half-config validation; client migration to the
0.1.7-rc.2 settings API.

**Known limitations:** per-member Agent Team model selection is not available;
"review tasks use the strong route" is a prompt suggestion rather than an enforcement.

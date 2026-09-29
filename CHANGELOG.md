# Changelog

本文件记录 `@gjs27/dsh-value-router` 的版本变更。
[English](#changelog-english) · [中文](#changelog)

---

## 0.5.1 — 2026-09-29

**修真正的根因**（0.4.0 / 0.5.0 的同类症状此前只修到一半），并按用户要求把设置面板
**提到设置左侧栏的独立分区**。

### Fixed（阻断性）

- **`src/index.ts` 从未 re-export `Config`——这才是「设置里没有卡片 + 配置不可写」的真根因。**
  宿主 `dsh-settings/lib/index.js:538-541` 读的是 `entry.fiber?.runtime?.Config`，
  而 `entry.fiber.runtime` 就是本包**主入口模块**的导出对象。少这一行 → 宿主拿到
  `undefined` → `describe()` 在 `:417` 跳过整个条目 → 命名空间不被服务。
  / **The entry module never re-exported `Config`.** The host reads
  `entry.fiber.runtime.Config` — the *entry module's* exports — so the whole settings
  module was invisible to it.
  修法：`export { Config } from './core/schema.ts'`。
  `test/schema.test.ts` 现在**从 entry 模块**断言，不再直接 import `core/schema.ts`
  ——上一版测对了规则、测错了位置，等于没测。
- 补 `@deepseek-ai/cosmokit` 为 peer + dev 依赖：移除 `z<ValueRouterConfig>` 标注后，
  `Config` 的推断类型含 `Volatile<T>`，缺这个依赖时生成 `.d.ts` 会报 TS2742
  （`rolldown-plugin-dts`），**构建直接失败**。

### Added

- **设置左侧栏独立分区**（`settings.section`，`id: value-router`，`order: 40`，
  标题随 locale 本地化）。此前只挂在「插件」区的按-namespace 卡片上，用户找不到。
  两处入口现在指向同一份配置。
  / **A dedicated Settings sidebar section**, as the user asked, alongside the
  existing per-namespace card. Both entries read and write the same configuration.

---

## 0.5.0 — 2026-09-29

**主控判难度 → 定档 → 档内轮转。** 这是用户想要的最终形态。

### Added

- **`tierRouting` 设置（默认 `tier-rotate`）**，决定主控显式指定线路时插件怎么处置：
  - `tier-rotate`：主控点名的线路**只用来确定档位**，插件在该档内按序号轮转派发；
  - `controller`：主控指定哪条就用哪条，完全不改（0.4.x 的行为）。
  / **`tierRouting` (default `tier-rotate`)**: how an explicit controller selection is
  handled — rotate within the tier it names, or honour the exact route.
- **`tierIndexOfRoute()`**：把一条线路反查回它所属的档位。
  子代理工具**没有「档位」参数**（只有 `provider` / `model` / `reasoning_effort`），
  所以「主控定档」只能靠查表实现——**不需要解析任何模型自由文本**。
  同一条线路出现在多个档位时取**最靠前（成本最低）**的：主控点名它通常是在表达
  「这条够用」，派到更贵的档位是反直觉的。
  / **Reverse lookup from a route to its tier.** No free-text parsing is involved.
- 提示词改为直接教主控：**你负责判断任务难度并选档；点名该档里的任意一条线路即可**，
  系统会认出它属于哪一档并在该档内轮转。
- 设置卡新增「主控选档的处理」区（按档位轮转 / 完全尊重主控）。
- 状态快照与 typert 契约新增 `tierRouting`；路由决策返回 `tierIndex`（实际派发的档位）。

### Changed

- **兜底轮转的起点从固定的最低档变成「轮转作用域」**：
  主控点名了池内线路 → 从那一档开始轮转；没点名 → 从最低档开始。
  作用域档位无可路由线路时依次向上尝试更高档，最后才用兜底线路。
  / **The rotation scope is now dynamic**: the tier the controller named, else the lowest.
- 0.4.0 的「只轮转最低档」在 `tier-rotate` 模式下不再是无条件限制——**它只作用于
  主控没指定线路的情形**。

---

## 0.4.0 — 2026-09-29

扁平轮转池 → **用户自定义的档位列表**。本版本同时修掉了 0.3.0 遗留的一个阻断性缺陷。

### Fixed（阻断性，0.3.0 未发现）

- **设置里不出现「价值路由」卡片 + 写入报「当前配置不可写」**。
  根因：宿主 `dsh-settings/lib/index.js:122-131` 的 `volatileForm()` **只保留标记为
  `volatile` 的字段**；旧 `Config` 全用普通 `.default()`，每个叶子被丢弃，
  `Object.keys(dict).length === 0` 时整个条目在 `describe():419` 被跳过——命名空间
  根本不被服务。`tsc` 与原有 92 个测试**全绿也测不出来**。
  修法：所有叶子加 `.volatile()`，并移除 `z<ValueRouterConfig>` 标注（volatile 输出
  类型是 `Volatile<T>`；宿主自身也不加该标注）。新增 `test/schema.test.ts`
  **复刻宿主的过滤规则**做契约断言，防止该 bug 类复发。
  / **Fixed (blocking):** the settings card never appeared and writes reported
  "configuration not writable". The host's `volatileForm()` keeps only
  volatile-marked fields; the old `Config` used plain `.default()` everywhere, so
  every leaf was dropped and the entry was skipped in `describe()`. Neither `tsc`
  nor the 92 existing tests could catch it. A new `test/schema.test.ts` replicates
  the host's filter rule so the class cannot regress.

### Breaking

- **配置面：`pool: PoolLine[]`（扁平，线路自带 tier 标签）→ `tiers: Tier[]`（档位列表）**。
  旧 `pool` 字段保留为**只读**，仅用于自动迁移。
  / **Configuration: flat `pool` → user-defined `tiers` list.** The legacy `pool`
  field is kept read-only, for migration only.

### Added

- **档位列表**：数量与名称都不限，**顺序即优先级**，`tiers[0]` 是最低档。
  设置卡支持新增/删除/重命名档位，档内可增删与重排线路。
  / **User-defined tiers**: any count, any names, list order is priority.
- **自动迁移**：旧扁平 `pool` 按线路原有的 `tier` 标签归位（省 → 中 → 强），
  标签缺失或非法的归入「中」档，**只创建实际有线路的档位**。用户无需手工搬数据。
  / **Automatic migration** from the legacy flat pool, grouped by each route's tier label.

### Changed

- **兜底轮转只发生在最低档**（`tiers[0]`）。这是用户拍板的语义：主控没指定线路时默认
  落最便宜的档；更高档位只被主控显式指定命中。
  **后果要知道**：这样拿到的是**同档内的供应商多样性**，不是跨档多样性。
  最低档自身无可路由线路时（例如全被白名单挡掉）依次尝试更高档，最后才用兜底线路。
  / **Fallback rotation happens in the lowest tier only.** Higher tiers are reached
  only by an explicit controller selection; the lowest tier is skipped upward when it
  has no dispatchable route.
- 提示词按档位分组呈现，并显式告知主控「不指定 = 从最低档轮转」。
- 设置卡与顶栏气泡改为按档位分组展示；轮转预览只显示最低档的实际顺序。

---

## 0.3.0 — 2026-09-29

宿主从 **DSH 0.1.7-rc.2 升到 0.2.0-rc.1**（跨大版本）。本版本只做适配与验证，
**没有源码改动**——插件依赖的运行时契约全部保持原样。

### Breaking

- **最低宿主再次提升到 DSH 0.2.0-rc.1**：`peerDependencies` 的 `@deepseek-ai/dsh-*`
  由 `^0.1.7-rc.2` 改为 `^0.2.0-rc.1`，`@deepseek-ai/cordis` 由 `^4.0.2` 改为 `^4.0.4`。
  0.2.x 需要 0.1.7-rc.2 或更新；0.3.0 需要 0.2.0-rc.1 或更新。
  / **Minimum host is now DSH 0.2.0-rc.1** with `@deepseek-ai/cordis` at `^4.0.4`.

### 逐条核对（对照 0.2.0-rc.1 产物，不是假设）

| 插件依赖的契约 | 0.2.0-rc.1 状态 | 依据 |
| --- | --- | --- |
| `agent/request` waterfall 签名与 "首次 = agent options、之后 = logged header" 语义 | **未变** | `dsh-agent/lib/types/runtime-types.d.ts:312-332` |
| `subagentModelSelection` 服务 + `current().allowedModels` | **未变** | `dsh-tool-subagent/lib/types/model-selection-settings.d.ts:9,17,41` |
| typert strict codec 要求 `create()` 工厂 | **未变** | `dsh-typert-loader/lib/index.js:211` |
| 六个 `client.inject` 目标包存在且同版本 | **未变**（均 0.2.0-rc.1） | 宿主 `node_modules/@deepseek-ai/` |
| 宿主 `settings` 命名空间 = Loader 条目 id | 未变 | 沿用 0.2.0 的设计前提 |

### Changed

- 版本号 0.2.0 → 0.3.0（peer 约束再次收窄属破坏性变更）。
- README 的最低宿主版本与安装说明同步更新。

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

- **轮转线路池**（`pool`，**不限条数**）：主控没显式指定线路时，子代理按
  `pool[N % 池长]` 分配。列表顺序即轮转顺序；同一个模型可以在多家 provider 各放一条，
  用来把订阅额度摊开。设置卡给出实时轮转顺序预览。
  / **Rotation pool** (no size limit). When the controller does not name a route,
  subagents are assigned by rotating through the pool. List order is the rotation
  order, and the same model may appear under several providers to spread quota.
- **宿主白名单成为唯一真源**：插件在 host 侧读 `ctx.subagentModelSelection.current()`
  的 `allowedModels`，不在白名单里的池条目标记 `allowed=false` 并**同时**从轮转与
  提示词清单中排除。这堵死了唯一的真实冲突路径——主控指定一条宿主拒绝的线路导致
  工具调用失败。读不到白名单时（服务未挂载 / 旧宿主）全部放行，不静默清空通道。
  / **The host allowlist is the single source of truth.** Routes outside it are
  excluded from both rotation and the prompt listing. When the allowlist cannot be
  read, everything is allowed rather than silently emptying the channel.
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
- **插件的线路池与宿主的 `subagent-model-selection-settings.allowedModels` 曾是两份
  会漂移的配置**。0.2.0 已改为：白名单是唯一真源，插件主动读取并据此闸门，
  不在白名单内的池条目不会参与轮转、也不会出现在给主控的清单里。
- 已在 `<DSH_HOME>/.agent-presets/` 留下旧 `value-router` 目录的安装**需要手动删除**
  （插件不会自动删，避免误删用户自建的同名预设）。

### Supply chain

- 新增 `prepublishOnly` 校验链（`typecheck && test && build`）。安装期仍不执行任何代码
  （无 `postinstall` / `prepare`）。

---

<a id="changelog-english"></a>
# Changelog (English)

## 0.5.1 — 2026-09-29

**Fixed (blocking, the real root cause):** `src/index.ts` never re-exported `Config`.
The host reads `entry.fiber.runtime.Config` — the *entry module's* exports — so the
whole settings module was invisible and the namespace was never served. The previous
fix (adding `.volatile()`) was real but incomplete; both produce the identical symptom.
`test/schema.test.ts` now asserts from the entry module rather than importing
`core/schema.ts` directly. Also added `@deepseek-ai/cosmokit` as a peer + dev
dependency, without which `.d.ts` generation fails with TS2742.

**Added:** a dedicated Settings sidebar section (`settings.section`), as requested.

## 0.5.0 — 2026-09-29

**Controller judges difficulty → picks a tier → rotation happens inside that tier.**

**Added:** `tierRouting` (default `tier-rotate`) and `tierIndexOfRoute()`. The subagent
tool has no "tier" parameter — only `provider` / `model` / `reasoning_effort` — so the
tier is derived by looking the named route up in the tier tables. No free-text parsing
is involved. A route present in several tiers resolves to the cheapest one. The prompt
now tells the controller directly: judge the difficulty, name any route in that tier.

**Changed:** the rotation scope is dynamic — the tier the controller named, else the
lowest tier — instead of always the lowest tier.

## 0.4.0 — 2026-09-29

**Fixed (blocking, missed in 0.3.0):** the settings card never appeared and writes
reported "configuration not writable". The host's `volatileForm()` keeps only
volatile-marked fields; the old `Config` used plain `.default()` everywhere, so
every leaf was dropped and the entry was skipped in `describe()`. Neither `tsc`
nor the 92 existing tests could catch it. A new `test/schema.test.ts` replicates
the host's filter rule so the class cannot regress.

**Breaking:** flat `pool` → user-defined `tiers` list; the legacy field is kept
read-only and migrated automatically by each route's tier label.

**Changed:** fallback rotation happens in the lowest tier only; higher tiers are
reached only by an explicit controller selection.

## 0.3.0 — 2026-09-29

**Breaking:** minimum host raised again, to DSH **0.2.0-rc.1**; peer ranges moved from
`^0.1.7-rc.2` to `^0.2.0-rc.1` and `@deepseek-ai/cordis` from `^4.0.2` to `^4.0.4`.
0.2.x requires DSH 0.1.7-rc.2 or newer; 0.3.0 requires 0.2.0-rc.1 or newer.

**No source changes were required.** The adaptation was dependency ranges plus
verification against the 0.2.0-rc.1 artifacts: the `agent/request` waterfall contract,
the `subagentModelSelection` allowlist service, and the typert `create()` requirement
all survive unchanged.

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

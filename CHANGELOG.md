# Changelog

本文件记录 `@gjs27/dsh-value-router` 的版本变更。
[English](#changelog-english) · [中文](#changelog)

---

## 0.10.0 — 2026-10-07

**统一模型路由**：插件从「按价值把带工具的子任务下沉给便宜的 executor 子代理」
改为 **DSH 唯一的模型路由 owner**。调用方提交结构化 `difficulty + role + route`，
插件返回最终 `provider / model / reasoning_effort`；调用方在成员创建时**冻结**该线路
并记录到自己的状态文件，启动后不中途换模型。对外只暴露一个服务 `valueRouterRouting`
（`catalog` / `validate` / `resolve` / `record`）。

### Breaking

- **配置 schema 收敛为固定四档 `low / medium / high / max` + 单一全局 `fallback`。**
  `pool`、动态 `tiers`、`executor`、`strategy`、`ambiguousPolicy`、`tierRouting`、
  会话级覆写整体退役；**不做旧配置迁移，也不做双读兼容**。
- 随 executor 概念一并退役的还有桥接通道、委派计数、token 估算与批次进度。
- 设置卡与顶栏状态不再呈现「轮转池 / 兜底线路」，改为四档线路、档内成员与审计事件。

### Added

- `valueRouterRouting` 服务（`src/service.ts`）：`catalog` / `validate` / `resolve` /
  `record`。`validate` 不查目录（纯校验）；`resolve` 会同时查目录，并自动记一条审计事件。
- `src/core/catalog.ts`：**宿主 LLM 目录是 provider / model 的唯一真源**——只有显式分档
  的线路可派发，新模型默认未分档。
- `src/core/intent.ts`：`difficulty + role + route` 意图校验。
- `src/core/route.ts`：档内轮转 → 同档替代 → 逐档降级（**只降不升**）→ 全局 fallback；
  全局 fallback 不参与轮转。
- `src/core/audit.ts`：路由审计事件（`validate` / `tier-rotate` / `route-rejected` /
  `queue` 等）。
- 用户硬指定线路不可用时**保持未解析、不走 fallback**；调用方给出的非法 route 记
  `route-rejected` 后自动重选；自动路由禁止无提示升档。
- 测试：`test/catalog.test.ts`、`test/intent.test.ts`、`test/route.test.ts`、
  `test/audit.test.ts`、`test/service.test.ts`。

### 验证

- `pnpm typecheck`（宿主 + 客户端两个 tsconfig）零错误。
- `pnpm test`：10 个文件 / 106 个用例全通过。
- `pnpm build`（tsdown）通过。

### 文档

`README.md` 与 `package.json` 的 `description` 已按 0.10.0 重写：四档配置形状与全局兜底、
冻结的解析顺序与两条硬路由语义、`available` / `missing` / `blocked` 三态与白名单闸门、
`valueRouterRouting` 能力服务（含给调用方的示例与审计说明）、破坏性升级步骤。

---

## 0.9.0 — 2026-09-30

**适配 DSH 0.2.0-rc.2**（宿主 `@deepseek-ai/dsh-desktop@0.2.0-rc.2`）。

先说结论：**本插件用到的宿主契约在 rc.2 全部保持不变**，没有一处 API 破坏。
`peerDependencies` / `devDependencies` 全部从 `0.2.0-rc.1` 提到 `0.2.0-rc.2`，
在真实的 rc.2 类型定义下 `tsc --noEmit` 零错误、117 个测试全绿、构建通过。
逐条核对过的契约（均**未变**）：

| 契约 | rc.2 位置 | 结论 |
| --- | --- | --- |
| `Config` 必须从 entry 模块导出 | `dsh-settings/lib/index.js:539` | 未变 |
| `describe()` 的 fiber 闸门 | `dsh-settings/lib/index.js:417` | 未变（仍是 `state !== 2` 跳过） |
| `volatileForm()` 只保留 volatile 子树 | `dsh-settings/lib/index.js:122` | 未变 |
| typert 严格编解码器必须有 `create()` 工厂 | `dsh-typert-loader/lib/index.js:211` | 未变 |
| 子代理白名单 `subagentModelSelection.current().allowedModels` | `dsh-tool-subagent/lib/model-selection-settings.js:55` | 未变 |
| `configEditor.entries()` | `dsh-config-editor/lib/index.js:30` | 未变 |
| `systemPrompt.section({name, order, text})` | `dsh-system-prompt/lib/index.js:240` | 未变 |
| 会话头 `parentSession` / `origin === 'subagent'` | `dsh-session/lib/index.js:1048-1050` | 未变 |
| `agent/request` 瀑布改写 `provider`/`model` | `dsh-agent/lib/index.js:181` | 未变 |

### Fixed

- **宿主主题 token 被 rc.2 改名/删除，样式静默退化成写死颜色。**
  rc.2 把 `state-danger-*` 整个并入 `state-error-primary`，取消了 `state-*-surface`
  那一档，并删除了 `brand-bg-hover`。因为每处引用都带硬编码 fallback，变量失效时
  **不报错、不闪红**，只是暗色/写死色块在浅色主题上又回来了——正是 0.8.1 修过的问题。
  涉及 3 个 CSS 文件共 11 处：

  | rc.1 | rc.2 |
  | --- | --- |
  | `--dsw-alias-state-danger-primary` | `--dsw-alias-state-error-primary` |
  | `--dsw-alias-state-danger-surface` | `color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent)` |
  | `--dsw-alias-state-success-surface` | `color-mix(in srgb, var(--dsw-alias-state-success-primary) N%, transparent)` |
  | `--dsw-alias-state-warn-surface` | `color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent)` |
  | `--dsw-alias-brand-bg-hover` | `color-mix(in srgb, var(--dsw-alias-brand-primary) N%, transparent)` |

  淡底不再另设一档 token，而是从 primary 调出来——这也正是宿主自己的写法
  （`dsh-client-ui-theme` 内部大量使用 `color-mix(in srgb, var(--dsw-alias-…) N%, transparent)`）。
  顺带把 `value-router-a11y.module.css` 里 `.error` 写死的 `rgba(180,35,24,…)`
  边框/底色也换成同一套 token（它的文字色本来就已用 token，两者此前不一致）。

- **`settings.configure()` 的 disposer 从未被消费。**
  rc.2 起 `configure()` 对**同一 fiber 重复注册直接抛错**
  （`Settings presentation is already configured for this plugin instance`），
  且服务端的 `presentations` 这张 Map 强引用 fiber。本插件此前把返回值丢掉了，
  于是热重载后 `presentations` 只增不减。现在把 configure 的 disposer 与条目轮询的
  disposer 合成一个交给 `ctx.effect`，卸载时两个都跑掉。

### Added

- `test/theme-tokens.test.ts`：主题 token 守卫（2 个用例）。断言 CSS 不引用 rc.2
  已删除的 token 家族，且每个 `var(--dsw-*)` 都带 fallback。这是**反向 canary**——
  不试图证明新名一定存在（那需要把宿主样式表引进测试环境，会在每次升级时变成噪音），
  只保证旧名不会被写回来。已验证非空测试：塞回一个坏 token 会真的失败。

### 已知文档缺口

本文件此前只记到 0.5.2，而包版本已到 0.8.3——0.6.x ~ 0.8.x 的变更从未补记。
此处**不凭空追写**（无据可查的版本说明等于编造），待后续确认后再补。

---

## 0.5.2 — 2026-09-29

**「设置里没有卡片 + 配置不可写」的最终根因**。从 0.2.0 起就存在，此前三轮都在修表层。

### Fixed（阻断性）

- **嵌套 volatile 让整个 Loader 条目不激活。** `tiers` 是 volatile 数组，元素里又标了
  volatile 字段，cordis 的 `resolveConfig` 直接拒绝：

  ```
  value-router (@gjs27/dsh-value-router): ValidationError: invalid config:
    - $.tiers.*.id volatile fields require a fixed object path
      without an enclosing volatile field (at tiers.*.id)
  dsh: warning: 1 entry did not activate
  ```

  条目不激活 → fiber 不存在 → `describe()` 在 `:417` 跳过 → 客户端
  `status=unavailable` → 「配置不可写，请等待运行时连接恢复后重试」。
  0.2.x 的扁平 `pool`（volatile 数组 + volatile 元素）**是同一个错误**。

  修法：volatile 只落在最外层固定路径——`tiers` 整体 volatile，其内部
  （`TierSchema` / `PoolLineSchema`）不再标 volatile。宿主 `volatileForm()` 本来就是
  按「volatile 字段整体作为一片子树」处理的，外层 volatile 已覆盖整棵 `tiers`。
  `test/schema.test.ts` 增加断言：`tiers` 的直接子字段**不得**带 `meta.volatile`。

  / **Nested volatile fields made the whole Loader entry fail to activate.** The same
  error existed in 0.2.x's flat `pool`. Fixed by keeping volatile only on the outermost
  fixed path.

### Added

- 客户端把宿主设置文档的真实状态暴露到 UI（写入被拒时附带
  `status/writable/mode/revision`，并在卡片上常驻显示）。宿主原本把
  「命名空间没进 describe()」和「连接没建立」压成同一句话，而两者的排查方向相反——
  这个盲区让前两轮修复都在猜。
- 宿主启动时打印 `describe()` 命名空间清单（并可用 `VALUE_ROUTER_DIAG_SINK` 环境变量
  落盘），用于直接向宿主取证而不是读编译产物推断。
  / **Client-side and host-side diagnostics** for the settings surface.

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

## 0.10.0 — 2026-10-07

**Unified model routing.** The plugin no longer sinks tool-bearing subtasks onto a
cheaper `executor` subagent; it is now **DSH's single model-routing owner**. A caller
submits a structured `difficulty + role + route` intent and receives the final
`provider / model / reasoning_effort`, which it freezes at member-creation time and
records in its own state file — no mid-run model swap. One service is exposed:
`valueRouterRouting` (`catalog` / `validate` / `resolve` / `record`).

**Breaking:** the config schema collapses to four fixed tiers `low / medium / high /
max` plus a single global `fallback`. `pool`, dynamic `tiers`, `executor`, `strategy`,
`ambiguousPolicy`, `tierRouting` and the session-level override are retired, with **no
migration and no dual-read compatibility**. The bridge channel, delegation counters,
token estimates and batch progress retire together with the executor concept. The
settings card and header status now show the four tiers, in-tier members and audit
events instead of a rotation pool and a fallback line.

**Added:** `src/core/catalog.ts` (the host LLM catalog is the single source of truth —
only explicitly tiered routes are dispatchable, new models start untiered),
`src/core/intent.ts` (intent validation), `src/core/route.ts` (in-tier rotation →
same-tier substitution → downward-only degradation → global fallback, which never
rotates), `src/core/audit.ts` (audit events) and `src/service.ts`
(`valueRouterRouting`). A user-pinned route that is unavailable stays unresolved
instead of falling back; an invalid caller route is recorded as `route-rejected` and
re-selected; automatic routing never upgrades a tier silently. Five new test files
cover catalog, intent, route, audit and service.

**Verification:** `pnpm typecheck` (host and client tsconfigs) clean; `pnpm test`
10 files / 106 cases green; `pnpm build` clean.

**Docs:** `README.md` and the `package.json` `description` were rewritten for 0.10.0 —
the four-tier configuration with its single global fallback, the frozen resolution
order and both hard-route semantics, the `available` / `missing` / `blocked` line
states with the allowlist gate, the `valueRouterRouting` service (with a caller
example and the audit model), and the breaking upgrade steps.

## 0.9.0 — 2026-09-30

**Adapted to DSH 0.2.0-rc.2** (host `@deepseek-ai/dsh-desktop@0.2.0-rc.2`).

Headline: **every host contract this plugin uses is unchanged in rc.2** — there is no
API breakage to code around. `peerDependencies` / `devDependencies` moved from
`0.2.0-rc.1` to `0.2.0-rc.2`; against the real rc.2 type definitions `tsc --noEmit`
reports zero errors, all 117 tests pass, and the build is clean. Contracts verified
individually (all unchanged): the `Config` entry re-export and the `describe()` fiber
gate (`dsh-settings/lib/index.js:417,539`), `volatileForm()` (`:122`), the typert
strict-codec `create()` factory (`dsh-typert-loader/lib/index.js:211`), the subagent
allowlist `subagentModelSelection.current().allowedModels`
(`dsh-tool-subagent/lib/model-selection-settings.js:55`), `configEditor.entries()`,
`systemPrompt.section()`, the session header `parentSession` / `origin === 'subagent'`,
and the `agent/request` waterfall rewrite.

**Fixed — host theme tokens renamed or removed, styles silently fell back to hardcoded
colors.** rc.2 folded `state-danger-*` into `state-error-primary`, dropped the
`state-*-surface` tier, and deleted `brand-bg-hover`. Because every reference carried a
hardcoded fallback, losing a token produces no error and no visual alarm — the dark
blocks simply return on light themes, which is the exact problem 0.8.1 fixed. Eleven
declarations across three CSS files were remapped; tints are now derived with
`color-mix(in srgb, var(--dsw-alias-…-primary) N%, transparent)`, the idiom the host
itself uses. Also replaced the hardcoded `rgba(180,35,24,…)` border/background on
`.error` with the same tokens, for consistency with the text color that already used one.

**Fixed — the `settings.configure()` disposer was never consumed.** rc.2 throws on
re-registering the same fiber (`Settings presentation is already configured for this
plugin instance`) and the service's `presentations` map strongly references the fiber.
The configure disposer is now composed with the entry-watch disposer and handed to
`ctx.effect`, so both run on unload.

**Added — `test/theme-tokens.test.ts`**, a two-case guard asserting the CSS never
references a token family rc.2 removed, and that every `var(--dsw-*)` keeps a fallback.
It is a reverse canary: it does not try to prove the new names exist (that would mean
pulling host stylesheets into the test environment and becoming noise on every upgrade),
only that the old ones cannot come back. Verified non-vacuous by reintroducing a bad
token and watching it fail.

**Known documentation gap:** this file previously stopped at 0.5.2 while the package was
already at 0.8.3, so 0.6.x – 0.8.x were never recorded. They are deliberately not
written from memory here — an unverifiable version history would be fabrication.

## 0.5.2 — 2026-09-29

**The real root cause** of "no settings card / configuration not writable", present
since 0.2.0; the previous three attempts fixed symptoms.

Nested volatile fields made the Loader entry fail to activate with
`ValidationError: $.tiers.*.id volatile fields require a fixed object path without an
enclosing volatile field`, followed by `1 entry did not activate`. The 0.2.x flat
`pool` had the identical defect. Fixed by keeping `volatile` only on the outermost
fixed path — the host's `volatileForm()` already treats a volatile field as covering
its whole subtree. Verified by booting the web profile: `describe()` now lists
`value-router`.

**Added:** client- and host-side diagnostics for the settings surface, so future
failures are observed rather than inferred.

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

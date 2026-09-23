# @gjs27/dsh-value-router —— 价值路由（Value Router）

DSH 会话内的**成本感知协作层**：主模型（用户在预设/会话里选的那个）负责调控与交付，插件只做一条确定性的分流——**子代理路由**：

| 通道 | 触发条件 | 去向 | 机制 |
| --- | --- | --- | --- |
| **子代理路由**（唯一通道） | 带工具的、可拆分的子任务（subagent / subagent_fork / workflow worker） | 便宜的 DSH executor 模型（复用 DSH 已配置 provider） | host 侧拦截 `agent/request`，只改写 `origin === 'subagent'` 的会话 |

一句话：**主模型永不被接管**；带工具的子任务自动下沉给 executor 子代理。插件**不注册任何工具**，只做子代理路由。

本包由两款插件合并而来：

- `@gjs27/dsh-deepseek-web-delegate`（其外发通道已整体退役，详见文末「退役记录」）
- `@linxin666/dsh-value-mode`（模型分层路由、三档策略、顶栏徽章/气泡/引导/设置卡、路由遥测）

合并时**删除**了 value-mode 的 expert 主控路由语义（expert 配置、expert 健康检查、专家会话覆写、`autoReviewKeywords`、`consult_expert` 工具全部移除，不保留兼容导出）。

---

## 1. 生效范围（scope）

| scope | 生效对象 | 说明 |
| --- | --- | --- |
| `preset`（默认） | 仅当前预设为 `value-router` 的会话 | 插件会把自带预设同步到 `<DSH_HOME>/.agent-presets/value-router`，在模式选择器里显示为「价值路由」 |
| `global` | 所有预设（可用 `excludePresets` 排除） | 提示注入所有会话；所有子代理会话都被路由 |

两种 scope 下都遵守同一条硬约束：**`origin !== 'subagent'` 的会话一律不改写 provider/model**（主会话、用户手动开的会话都不受影响）。

### 「当前预设」怎么判定（踩过坑，勿改回 header）

DSH 里 `session.header.agentPreset` 是**会话创建时**的预设且**不可变**；切换预设走的是 `agent-preset/selected` 事件——`AgentPresets.swap()` 会先 `recompose(agent.ctx)`，再追加该事件推进 `agentPreset` **投影**（见 `dsh-agent-presets/lib/index.js` 的 `agentPresetProjectionDefinition` 注释：*"The creation header names the preset a session STARTED with… Reconstruction reads the `agentPreset` Session projection, never the header"*）。

所以本插件按 **实时组合（`agentPresets.composedPreset(agent.ctx)`）→ 会话投影（`sessionProjections.stateOf(session,'agentPreset')`）→ 创建 header** 的优先级取值（`src/core/routing.ts` 的 `resolveCurrentPreset`）。只读创建 header 会出现「新建 standard 会话 → 切成价值路由」的会话被永久判定为不在范围内：提示段不注入、路由被 `scope` 静默跳过，表现为**选了预设却一次都不派子代理**。

### 使用要点

- **在发第一条消息前选好预设**：DSH 的预设切换在会话首轮之后会被锁死（`agent-preset/locked`），所以新会话请在模式选择器里先选「价值路由」，再发消息。
- 想省事就把默认预设设成它：设置里的「默认模式」（对应 `settings.yaml` 的 `agent-presets.default`）改成 `value-router`，新会话直接就在该模式下。
- 与内置的 `subagent-model-selection`（会话级子代理模型白名单）**语义重叠**：本插件会在 `agent/request` 里把子代理会话改写成配置的 executor，覆盖调用时选的模型。若两者同时启用，建议把 executor 也加进那个白名单，避免两套策略互相打架。

## 2. 三档策略（strategy）

档位**只影响注入主模型的派发提示文案的积极程度**，不改变路由机制本身：

| 档位 | 行为 |
| --- | --- |
| `saver`（更省） | 文案更保守，少派发 |
| `balanced`（平衡，默认） | 命中「多文件调查 / 可并行拆分 / 批量机械改动 / 需独立复核」的子任务优先派发 |
| `powerful`（更强） | 复杂架构与疑难根因积极派发，并要求给出证据 |

与档位无关的固定事实：子代理不再派生子代理（预设里 `tool-subagent` / `tool-subagent-fork` 自身的 `maxDepth: 1`）。

## 3. 单通道的关闭与安全放行

只有一条子代理通道，以下情况通道关闭或放行，**绝不因本插件让会话失败**：

| 情况 | 行为 |
| --- | --- |
| executor 半配置（只填 provider 或只填 model） | 被设置校验**拒绝写入**，配置无法保存 |
| executor 两字段皆空（合法状态，默认） | 通道关闭，决策原因 `executor-incomplete`，插件照常加载 |
| executor provider 不在当前 LLM 运行时（`ctx.llm.listProviders()`） | 记 `executor-unavailable`，安全放行普通 DSH 路由 |
| 插件整体 `enabled=false` | 关闭（提示段也不注入） |

## 4. 工具

本插件**不注册任何工具**。历史上曾注册过外发类工具，已于 2026-09-22 随外发通道一并删除，见「退役记录」。

## 5. 界面与状态快照

- **顶栏徽章**（`conversation.session.header.actions`）：策略 / scope / executor / executor 健康 / 本会话 executor 调用次数 / 累计调用次数；
- **快捷气泡**：会话级覆写（`enabled` / `strategy` / `executor`）——「全局默认 ↔ 仅本会话」，只影响本会话、不写回全局设置，可一键重置；
- **首次引导**：选 executor + 策略 + scope；
- **设置卡**（`settings.plugin.item`）：路由区（开关 / scope / 排除清单 / 策略 / executor 选择 / executor 健康）。

状态快照（Remote `valueRouterStatus`）：

- `status` → `{ enabled, scope, strategy, executor, executorStatus, executorReason?, executorCallsTotal }`
- `sessionMetrics` → `{ executorCalls, override }`

## 6. 配置项（settings namespace `value-router`，共 5 个字段）

```
enabled                     总开关，默认 true
scope                       'preset'（默认）| 'global'
excludePresets              仅 scope=global 时生效的排除清单
strategy                    'saver' | 'balanced'（默认）| 'powerful'
executor                    { provider, model, reasoningEffort }
```

`executor` 的校验规则：**半配置（只填 provider 或只填 model）会被设置校验拒绝**；**两个都留空是合法状态**——此时子代理通道自动关闭（决策原因 `executor-incomplete`），插件照常加载（对应 `test/config.test.ts` 的默认配置回归项）。

## 7. 已知行为与边界

- **只有 `origin === 'subagent'` 的会话会被改写**：主会话（用户所选模型）永不被接管，这是核心回归项（`test/routing.test.ts`）。
- **子代理的会话覆写走父会话**：气泡挂在主会话上，子代理会话没有气泡，因此按「自身覆写 → 父会话覆写（`header.parentSession`）→ 全局配置」解析。
- **同模型 no-op**：若目标模型与原请求模型相同，不改写、不计一次 executor 调用、保留原 `reasoningEffort`。
- **reasoningEffort 不继承**：改写时剥掉继承的 `reasoningEffort`，只使用 executor 自己配置的档位，避免把主模型的 effort 强加给 executor 导致 `UNSUPPORTED_REASONING_EFFORT`。
- **计量口径**：只有 executor 路由调用次数是宿主实值（`executorCallsTotal` / 会话级 `executorCalls`）；**没有任何 token 估算口径**。
- **遥测**：仅当 Desktop 指标桥开启（环境变量 `DSH_DESKTOP_PRODUCT_METRICS_BRIDGE=1`）时向 stdout 写 `DSH_VALUE_ROUTER_METRIC {"event":"value_router_route",...}`；只含固定枚举与白名单化的模型 id，不含会话 id / 提示词 / 凭据。

## 8. 退役记录

- **2026-09-22：删除桥接通道**。原因：使用频率低、维护面大——12 道决策门控、脱敏、限额、压缩回注、字符估算记账，整套链路只为把无工具的单轮问答经本地 Chat2API 桥外发给网页端模型。同时删除了 `bridge_ask` / `bridge_batch` / `bridge_batch_result` 三个工具及对应的全部配置面（门控参数、桥设置区、桥徽章指标、批次队列、桥健康探测、压缩回注、字符估算记账等），插件自此**不注册任何工具**。
- **历史配置残留是无害的**：`settings.yaml` 里可能残留历史 `value-router.bridge` 块——schemastery 的 object 解析对未知键不报错，**无需手工清理**，也不影响插件加载。旧的桥 API Key 环境变量（`VALUE_ROUTER_BRIDGE_API_KEY` / `DEEPSEEK_WEB_BRIDGE_API_KEY`）已不再读取。
- **回滚方式**：本插件是 git 仓库，删桥那一版的前一个提交是 `f0c9cbd`（`git checkout f0c9cbd` 即可回到删除前的状态）。

## 9. 开发

```bash
pnpm install
pnpm typecheck     # tsc --noEmit -p tsconfig.json（宿主+测试） && tsc --noEmit -p tsconfig.client.json（浏览器）
pnpm test          # vitest run
pnpm test:node     # 同一批测试用 Node 自带 runner 跑（受限环境下无子进程）
pnpm build         # tsdown：lib/index.js+.d.ts、lib/typert.js+.d.ts、lib/status-controller.js+.d.ts、lib/client/index.js
```

构建布局与两个来源插件一致：**tsc 只做 `--noEmit` 类型检查，`lib/` 全部由 tsdown 产出**（服务端 ESM + 声明文件，客户端自注册经典脚本）。这样避免两套工具往同一个 `lib/` 写文件、产物互相覆盖。

测试统一用 `node:test` + `node:assert` 的 API 书写；`vitest.config.ts` 把 `node:test` 映射到 `test/node-test-shim.ts`，所以两种 runner 跑的是同一批文件。

关键回归项：

- `test/routing.test.ts`：**主会话（`origin !== 'subagent'`）在任何 scope / 任何配置下都不被改写**；
- `test/config.test.ts`：默认配置（executor 未选）必须可加载——settings 的 `validate` 在注册命名空间时就会被调用一次，抛错会让整个插件树加载失败（实测踩过）；
- `test/typert.test.ts`：复刻 `dsh-typert-loader` 的清单校验规则，并交叉校验客户端 descriptor 的 `typeSymbol` 与宿主逐字一致。

## 10. 安装

插件经 profile 的 `dsh.profile.bundles` 全局装载（与两个来源插件相同）。推荐用 `dsh plugin` 管理，它会转发 pnpm 并**按已安装状态自动同步 `bundles` 列表**：

```bash
# 本地开发用 link:（软链，改完 lib 后重启即生效）
dsh plugin --profile web add link:D:/dsh-workspaces/dev/local-plugins/dsh-value-router
```

> 用 `file:` 时 pnpm 会把包**复制**进 profile 的 node_modules，之后重建 `lib/` 不会生效（要重新 install）；开发期请用 `link:`。

迁移自旧插件时，把 `@gjs27/dsh-deepseek-web-delegate` 与 `@linxin666/dsh-value-mode` 从 bundles/dependencies 移除（`dsh plugin --profile web remove ...`），并删除 `<DSH_HOME>/.agent-presets/{deepseek-web,value-mode}`（这两个目录由旧插件同步；`value-router` 预设由本插件同步）。

### 启动自检

改完插件后用**独立 profile** 做启动自检：既不被主 profile 里其它插件干扰，也不影响正在运行的主实例。

```bash
dsh plugin --profile vr-check install
dsh plugin --profile vr-check add link:D:/dsh-workspaces/dev/local-plugins/dsh-value-router
# 再把 "@deepseek-ai/dsh-web-app" 加进 vr-check 的 dsh.profile.bundles
dsh --profile vr-check --port 3081 --no-open
```

判据：启动日志出现 `dsh web: http://127.0.0.1:3081/?token=...`；带 token 打开首页后，启动 combo（`/plugins/??...`）里应包含 `@gjs27/dsh-value-router/client.js`。

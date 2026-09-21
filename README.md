# @gjs27/dsh-value-router —— 价值路由（Value Router）

DSH 会话内的**成本感知协作层**：主模型（用户在预设/会话里选的那个）负责调控与交付，插件只做两件确定性的分流：

| 通道 | 触发条件 | 去向 | 机制 |
| --- | --- | --- | --- |
| **子代理通道** | 带工具的、可拆分的子任务 | 便宜的 DSH executor 模型（复用 DSH 已配置 provider） | host 侧拦截 `agent/request`，只改写 `origin === 'subagent'` 的会话 |
| **桥接通道** | 无工具的、独立单轮问答 | 本地 Chat2API 桥背后的网页端模型（免费额度） | `bridge_ask` / `bridge_batch` / `bridge_batch_result` 三工具 |

一句话：**主模型永不被接管**；有工具的子任务下沉给 executor 子代理，没工具的单轮问答外发网页模型。

本包由两款插件合并而来：

- `@gjs27/dsh-deepseek-web-delegate`（Chat2API 桥、12 道决策门控、脱敏、限额、压缩回注、字符估算记账）
- `@linxin666/dsh-value-mode`（模型分层路由、三档策略、顶栏徽章/气泡/引导/设置卡、路由遥测）

合并时**删除**了 value-mode 的 expert 主控路由语义（expert 配置、expert 健康检查、专家会话覆写、`autoReviewKeywords`、`consult_expert` 工具全部移除，不保留兼容导出）。

---

## 1. 生效范围（scope）

| scope | 生效对象 | 说明 |
| --- | --- | --- |
| `preset`（默认） | 仅 `agentPreset === 'value-router'` 的会话 | 插件会把自带预设同步到 `<DSH_HOME>/.agent-presets/value-router`，在模式选择器里显示为「价值路由」 |
| `global` | 所有预设（可用 `excludePresets` 排除） | 提示注入所有会话；所有子代理会话都被路由 |

两种 scope 下都遵守同一条硬约束：**`origin !== 'subagent'` 的会话一律不改写 provider/model**（主会话、用户手动开的会话都不受影响）。

## 2. 三档策略（strategy）

档位同时决定「派发提示文案」与「桥门控参数」：

| 参数 | saver（更省） | balanced（平衡，默认） | powerful（更强） |
| --- | --- | --- | --- |
| `minEstimatedSavedTokens` | 300 | 200 | 100 |
| `maxDelegationsPerTask` | 6 | 10 | 16 |
| `maxDelegationsPerHour` | 20 | 30 | 48 |

> 上表为策略推导值；`tuning.*` 显式字段可逐个覆盖（未给出的字段仍按策略推导）。
> 事实源：`src/core/config.ts` 的 `STRATEGY_TUNING`。

与档位无关的固定护栏（不可被配置突破）：

- `maxConcurrentDelegations = 1`、`bridge.concurrency = 1` —— 网页版同账号单路输出，避免并发触发风控；
- `maxDepth = 1` —— 子代理不再派生子代理。

## 3. 两通道互相独立降级

| 故障 | 子代理通道 | 桥接通道 |
| --- | --- | --- |
| executor 未配置 / provider 不可用 | 关闭（放行普通 DSH 路由） | 不受影响 |
| 桥 down / 未启用 | 不受影响 | 工具返回 `degraded=true` + 中文原因，主模型自答 |
| 插件整体 `enabled=false` | 关闭 | 关闭（提示段也不注入） |

## 4. 工具

### `bridge_ask`（单问）

入参：`taskType`（必填）、`question`（必填）、`context`、结构化事实（`needsLocalTools` / `requiresProjectContext` / `multiStepPlanning` / `accuracyCritical` / `finalDecision` / `hasNewInfo`）、`model`（按次指定桥模型 id）、`thinking`（`off`/`on`/`silent`）、`webSearch`、`continueFromRequestId`。

管道：**12 道决策门控 → 脱敏 → 限额/去重 → fetch 桥 → 压缩 → 来源标记回注 → 记账 → 释放锁**。任一硬门槛不满足即拒绝（凭据、黑名单任务类型、需要本地工具、依赖项目私有上下文、多轮规划、最终决策、桥 down、超限、收益低于阈值……），拒绝原因可读，且**不消耗委派次数**。

### `bridge_batch` / `bridge_batch_result`（批量）

`bridge_batch` 立即返回 `batchId` 与逐条接受/拒绝结果；`bridge_batch_result` 轮询批次进度与逐条结果，并刷新状态卡。批次并发固定 1，按提交顺序执行。

### 记账口径

本机定制版 Chat2API **不输出 usage**，因此默认走字符估算并如实标注 `estimateOnly=true`（`trustUsage='auto'` 会防护占位值/异常值；`'always'` 仅当桥确实给出真实值时才值得用）。

## 5. 界面

- **顶栏徽章**（`conversation.session.header.actions`）：策略 / scope / executor / executor 调用占比 / 桥健康点 / 累计节省 token（估算口径）/ 桥委派次数 / 批次进度 / 桥最近错误；
- **快捷气泡**：会话级覆写（`enabled` / `strategy` / `executor`）——「全局默认 ↔ 仅本会话」，不污染全局设置，可一键重置；
- **首次引导**：选 executor + 策略 + scope；
- **设置卡**（`settings.plugin.item`）：路由区（开关/scope/排除清单/策略/executor/tuning）+ 桥区（地址/密钥/模型映射/信任策略/超时/批上限）+ 桥健康与可用模型列表。

## 6. 配置项（settings namespace `value-router`）

```
enabled                     总开关
scope                       'preset' | 'global'
excludePresets              scope=global 时的排除清单
strategy                    'saver' | 'balanced' | 'powerful'
executor                    { provider, model, reasoningEffort }
maxDepth                    固定 1
autoDelegate                桥是否自动委派（false 时仅手动调用工具）
allowedTaskTypes            允许外发的任务类型白名单
blockedTaskTypes            禁止外发的任务类型黑名单
allowCodeSnippet            是否允许发送代码片段
allowLocalFileContent       是否允许发送本地文件内容
requireConfirmationForCommands
defaultThinking             'off' | 'on' | 'silent'
fallbackMode                'continue-with-primary' | 'skip-delegation' | 'ask-user'
tuning                      显式覆盖策略推导值（见 §2）
bridge.enabled              桥通道开关
bridge.baseUrl              默认 http://127.0.0.1:8080/v1
bridge.apiKey               机密，永不回显；可用 VALUE_ROUTER_BRIDGE_API_KEY 环境变量兜底
bridge.modelMap             { plain, thinking, thinkingSearch, search }
bridge.extraHeaders         仅保留 string→string
bridge.thinkingBody / searchBody
bridge.reasoningField       默认 reasoning_content
bridge.trustUsage           'auto' | 'always' | 'never'
bridge.timeoutMs            默认 180000
bridge.healthCacheTtlMs     默认 30000（同时是探活间隔）
bridge.concurrency          固定 1
bridge.maxBatchItems        默认 10
```

## 7. 已知行为与边界

- **子代理的会话覆写走父会话**：气泡挂在主会话上，子代理会话有自己的 session id，因此路由时按「自身覆写 → 父会话覆写（`header.parentSession`）→ 全局配置」解析。子代理通常没有自身覆写，所以实际生效的是父会话覆写或全局配置。
- **同模型 no-op**：若 executor 与当前请求的 provider/model 相同，则原样放行（保留原 `reasoningEffort`），也不计一次 executor 调用。
- **reasoningEffort 不继承**：改写路由时按目标模型自身的能力决定（executor 配了 `reasoningEffort` 才带上），避免把主模型的 effort 档位强加给 executor 导致 `UNSUPPORTED_REASONING_EFFORT`。
- **计量口径**：executor 调用次数为宿主实值；桥的 token/节省为字符估算口径，标注 `estimateOnly`。
- **遥测**：仅当 Desktop 指标桥开启（`DSH_DESKTOP_PRODUCT_METRICS_BRIDGE=1`）时向 stdout 写 `DSH_VALUE_ROUTER_METRIC {"event":"value_router_route",...}`；只含固定枚举与白名单化的模型 id，不含会话 id / 提示词 / 凭据。

## 8. 开发

```bash
pnpm install
pnpm typecheck     # tsc --noEmit -p tsconfig.json（宿主+测试） && tsc --noEmit -p tsconfig.client.json（浏览器）
pnpm test          # vitest run（11 个文件 / 174 个用例）
pnpm test:node     # 同一批测试用 Node 自带 runner 跑（受限环境下无子进程）
pnpm build         # tsdown：lib/index.js+.d.ts、lib/typert.js+.d.ts、lib/status-controller.js+.d.ts、lib/client/index.js
```

构建布局与两个来源插件一致：**tsc 只做 `--noEmit` 类型检查，`lib/` 全部由 tsdown 产出**（服务端 ESM + 声明文件，客户端自注册经典脚本）。这样避免两套工具往同一个 `lib/` 写文件、产物互相覆盖。

测试统一用 `node:test` + `node:assert` 的 API 书写；`vitest.config.ts` 把 `node:test` 映射到 `test/node-test-shim.ts`，所以两种 runner 跑的是同一批文件。

关键回归项：

- `test/routing.test.ts`：**主会话（`origin !== 'subagent'`）在任何 scope / 任何配置下都不被改写**；
- `test/config.test.ts`：默认配置（executor 未选）必须可加载——settings 的 `validate` 在注册命名空间时就会被调用一次，抛错会让整个插件树加载失败（实测踩过）；
- `test/typert.test.ts`：复刻 `dsh-typert-loader` 的清单校验规则，并交叉校验客户端 descriptor 的 `typeSymbol` 与宿主逐字一致。

## 9. 安装

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

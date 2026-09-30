# @gjs27/dsh-value-router —— 价值路由（Value Router）

DSH 会话内的**成本感知 + 多模型协作层**。主模型（你在会话里选的那个）负责理解、拆解、
审查与最终交付；插件只做一件事——**决定每个子代理跑在哪个模型上**：

| 场景 | 去向 | 机制 |
| --- | --- | --- |
| 主控**显式指定**了线路（且不同于父模型） | 该线路，放行不改写 | host 侧拦截 `agent/request` |
| 主控**没指定** + 轮转池非空 | `pool[N % 池长]`，N = 该父会话下的第 N 个子代理 | 同上 |
| 池为空，或池中目标线路的 provider 不可用 | 兜底线路 `executor` | 同上 |
| 主会话 / 用户手动开的会话 | **永不改写** | 同上 |

一句话：**主模型永不被接管；没指定线路的子代理按池轮转，于是并行的子代理天然跑在不同模型上。**
插件**不注册任何工具**，只做子代理线路分配。

> **0.2.0 变更**：专属预设已摘除，改为设置里的全局开关，对**全部预设**生效。
> 详见 [CHANGELOG.md](./CHANGELOG.md)。

---

## 1. 为什么是「轮转」而不是「全用一个」

把子代理都赶到同一个便宜模型上省钱，但有两个真实代价：

- **思考盲区**：同一模型对同一类问题有稳定的偏好与盲点，多个子代理得出的结论会高度同质；
  换模型交叉验证才能补上这块。
- **并发瓶颈**：并行子代理全压在一条线路上，吞吐受单 provider 的限流约束；而且单点故障
  直接让整批子任务失败。

轮转同时解决这两点：**第 1 个子代理走池[0]，第 2 个走池[1]，第 3 个走池[0]…**
并行批次天然落在不同线路/供应商上，限流与订阅额度也被摊开。

### 轮转序号是每会话一次，不是每请求递增

这是最容易做错的地方。序号在**子会话首次被观察时分配一次**并固定下来。原因：
若在每个 `agent/request` 上递增，一个多 step 的子代理会在 step 之间换模型——同一段对话
历史由不同模型生成，宿主会插入 model-switch notice，模型看到自己上文的"风格突变"，
体验与一致性都会崩。

验收判据写在测试里：`test/state.test.ts` 的「同一子会话在生命周期内只分配一次」。

### Agent Team 成员也在轮转里

队友是 provider-owned subagent child（走 `startContinuable`，`origin` 固定为 `'subagent'`），
所以插件**不需要、也无法**区分队友与普通子代理——而这恰恰是好事：轮转对两者一视同仁，
队友自然就分散到不同模型了。

宿主**不支持**逐成员指定模型（`spawn_teammate` 的参数只有 `name` / `description` /
`prompt` / `context`；队友 provider 来自插件静态配置 `freshProvider` / `forkProvider`）。
要按角色精确分配，得等宿主加模型入口。

## 2. 配置项

```yaml
value-router:
  enabled: true                    # 总开关
  strategy: balanced               # 派发倾向：saver | balanced | powerful
  pool:                            # 轮转线路池，不限条数
    - provider: hetu               # 顺序 = 轮转顺序 = 优先级
      model: deepseek-v4.1-flash
      tier: cheap                  # cheap | mid | strong（仅用于文案与 UI，不参与路由）
    - provider: commandcode
      model: deepseek-v4.1-flash   # 同一个模型换一家 provider = 换一份订阅额度
      tier: cheap
    - provider: commandcode
      model: z-ai/glm-5.3-flash
      tier: mid
    - provider: xiaomi-token-plan-cn
      model: mimo-v2.6-flash
      tier: strong
  executor:                        # 兜底线路：无可轮转线路时
    provider: hetu
    model: deepseek-v4.1-flash
    reasoningEffort: ''
  ambiguousPolicy: rotate           # rotate | respect，默认 rotate
```

**列表顺序就是轮转顺序**：第 N 个子代理拿第 N 条，取模循环。想优先用哪家的额度就排在前面。
**不限条数**——你的现实是订阅分散在多家 provider，同一个模型在多家各放一条正是轮转的用法。

### 宿主白名单是唯一真源

插件在 host 侧读 `ctx.subagentModelSelection.current()` 的 `allowedModels`（宿主
`subagent-model-selection-settings`），**不在白名单里的池条目**会被：

1. 从**轮转**中排除（不会被派发）；
2. 从**给主控的提示词清单**中排除（主控看不到，就不会去指定）。

这堵死了唯一的真实冲突路径：主控显式指定一条宿主拒绝的线路 → 宿主抛
`gateway/bad-request`，该次工具调用失败。设置卡会把这些条目标成
「不在宿主白名单，不会被派发」。

读不到白名单时（宿主没挂载该服务 / 更老的宿主）**全部放行**——宁可多派，
也不把通道静默清空。

### 为什么 `executor` 不能删

它是**兜底线路**，只在两种情况生效：轮转池为空、或池中目标线路的 provider 不可用。
宿主**不提供任何默认 executor**——`dsh-tool-subagent` 的合并逻辑是
`requested?.provider ?? parentOptions.provider`：主控不显式指定模型时，子代理
**直接继承主模型**，也就是最贵的那条。所以池一旦为空而插件又没有兜底，降本目标就整个失效。

### `ambiguousPolicy` 处置的是什么

宿主层有一组**固有的不可区分性**：`next()` 只能给出"本次请求实际会用的线路"，
分不清下面两种情况——

| 情形 | `next()` 的值 | 真实意图 |
| --- | --- | --- |
| 主控没指定，子代理继承父模型 | = 父线路 | 交给轮转 |
| 主控显式指定了**和父模型一样**的线路 | = 父线路 | 尊重主控 |

- `rotate`（默认）：当作没指定 → 走轮转。省 token，符合本插件的存在目的；
  风险是主控极少见的"显式指定同款"会被改写。
- `respect`：当作显式指定 → 放行保留继承。绝不擅自改动主控明确写下的东西。

线路**不同于**父线路时无歧义，一律认定为主控显式指定并放行。

## 3. 派发倾向（strategy）

档位**只改写注入主模型的提示词**，不改变线路分配：

| 档位 | 提示词行为 |
| --- | --- |
| `saver`（更省） | 少派发；优先自己直接处理，除非能明确拆分、需并行调查或确实高耗时 |
| `balanced`（平衡，默认） | 命中「多文件调查 / 可并行拆分 / 批量机械改动 / 需独立复核」即优先派发 |
| `powerful`（更强） | 复杂架构、疑难根因、安全关键逻辑积极派发，并要求返回证据 |

三档都带同一条硬约束句：**不得以「来不及 / 太麻烦」为由回避派发**。

### 「独立复核走强模型」不是强制

宿主 `agent/request` 的 payload 只有 `{agent, turn, step, signal}`——**没有任务描述**。
判断"这是不是复核类任务"是语义判断，只有主控模型自己知道，插件在路由层拿不到。
因此本插件在提示词里给出**选档建议**，但**不声称强制**，也不做关键词匹配硬改写
（模型自由文本上的关键词匹配误判率高且难排查）。

## 4. 安全放行

以下情况一律放行普通路由，**绝不因本插件让会话失败**：

| 情况 | 决策原因 |
| --- | --- |
| 总开关关闭 | `disabled` |
| `origin !== 'subagent'`（**第一位，不可绕过**） | `not-subagent` |
| 池为空且兜底线路未配置 | `no-target` |
| 主控显式指定了线路 | `explicit-route` |
| 兜底线路半配置（只填一边） | sanitize 成未配置 → `no-target` |
| 目标线路 provider 不可用且无兜底 | `executor-unavailable` |
| 目标线路与当前一致 | `noop`（不改写、不计数） |

**半配置不抛错**：0.1.7-rc.2 删除了插件可注册的 settings `validate` 回调，
抛错会让整个插件树加载失败。半配置一律 sanitize 成"未配置"并记一条 warn。

## 5. 与宿主 `subagent-model-selection` 的关系

宿主自带子代理模型白名单（`subagent-model-selection-settings.allowedModels`），
语义是**授权**："子代理*可以*用哪些模型"。本插件的 `pool` 语义是**路由**："该派谁"。

时序上它们本来不会打架——宿主在子代理**创建前**校验主控显式传入的参数，插件在
**创建后**的 `agent/request` 改写，宿主看不到插件选的线路。但"时序不同"只是解释了
为什么不会崩，并不等于不会**咬人**：主控显式指定一条宿主不认的线路，那次工具调用
就会失败。

所以 0.2.0 让插件**主动读同一份名单当闸门**（见 §2）：池是白名单的子集时，
两条路径都不会被触发。**配置建议：把你想用的线路同时加进宿主白名单和插件池。**

## 6. 安装

最低宿主：**DSH 0.2.0-rc.2**（peer 范围已收窄，更早的宿主会拒绝安装或静默禁用该插件行）。
0.2.x 需要 0.1.7-rc.2 或更新；0.3.0 需要 0.2.0-rc.1 或更新；0.9.0 需要 0.2.0-rc.2 或更新。

```bash
# 开发装载（软链，改 lib/ 后重启 dsh 即生效）
dsh plugin --profile web     add link:D:/dsh-workspaces/dev/local-plugins/dsh-value-router
dsh plugin --profile desktop add link:D:/dsh-workspaces/dev/local-plugins/dsh-value-router
```

> **桌面端**用 `desktop` profile。桌面 profile 里其它插件同样声明 `platform: "web"`——
> 桌面就是同一个 Web 客户端套 Electron 壳，所以本插件**不需要为桌面改任何声明**，
> 两个 profile 的配置也各存各的（改一个不影响另一个）。

> 用 `file:` 会把包**复制**进 profile 的 node_modules，改 `lib/` 不生效。开发期只用 `link:`。

插件声明了 `dsh.bundle.patch`，装完宿主会自动把它写进 `dsh.profile.bundles`，无需手改。

### 升级到 0.2.0

1. 旧配置里的 `scope` / `excludePresets` **不用清理**——它们变成无害的未知键。
   想清理可在 profile 的 `cordis.patch.yml` 里删掉 `value-router` 条目下的这两个键；
   通过设置表单删不掉（宿主会把未知键 merge 回来）。
2. `<DSH_HOME>/.agent-presets/value-router` 是旧版本同步过去的预设目录，
   **插件不会自动删**（避免误删你自建的同名预设），需要你手动删除。
3. `pool` 默认为空。**第一次升级后请务必配置至少一条线路**——否则子代理会继承主模型。

## 7. 验证与回退

```bash
pnpm install --config.confirmModulesPurge=false
pnpm typecheck   # tsc ×2（host + client）
pnpm test        # vitest，92 个用例
pnpm build       # tsdown
```

回退：仓库有完整 git 历史（2026-09-29 从残缺的 `.git/` 中抢救回 5 个提交）。
`v0.1.0-local` tag 指向适配前的状态。

```bash
git checkout v0.1.0-local && pnpm install && pnpm build
```

## 8. 隐私与供应链

- 插件**不读取任何 API Key**；线路从宿主已配置的 provider 中选择。
- 遥测仅在 `DSH_DESKTOP_PRODUCT_METRICS_BRIDGE=1` 时向 stdout 写封闭枚举 + 轮转池**条数**，
  不含会话 id、提示词、模型名或路径。
- 安装期**不执行任何代码**（无 `postinstall` / `prepare`）。`prepublishOnly` 只在
  `npm publish` 时触发。

## 9. 版本适配记录

- **2026-09-30（0.9.0）**：适配宿主 DSH 0.2.0-rc.2。逐条核对插件依赖的运行时契约
  （`Config` 入口导出、`describe()` fiber 闸门、`volatileForm()`、typert `create()` 工厂、
  `subagentModelSelection` 白名单、`configEditor.entries()`、`systemPrompt.section()`、
  会话头 `parentSession`/`origin`、`agent/request` 瀑布）**全部未变**。实际改动两处：
  ① 宿主把 `state-danger-*` 并入 `state-error-primary`、取消 `state-*-surface`、删除
  `brand-bg-hover`，本插件 3 个 CSS 文件 11 处引用改为新 token 或 `color-mix` 淡底
  （变量消失时只会静默退化成写死颜色，不会有任何报错）；② rc.2 起 `configure()` 对同一
  fiber 重复注册会抛错，且服务端强引用 fiber——此前被丢弃的 disposer 现在与条目轮询的
  disposer 合并交给 `ctx.effect`。
- **2026-09-29（0.3.0）**：适配宿主 DSH 0.2.0-rc.1。逐条核对插件依赖的运行时契约
  （`agent/request` waterfall 语义、`subagentModelSelection` 白名单服务、typert 的
  `create()` 要求）全部未变，**无源码改动**。
- **2026-09-29（0.2.0）**：专属预设 `value-router` 整体删除；`scope` / `excludePresets`
  字段删除；「无条件改写子代理线路」改为「显式指定即放行 + 轮转兜底」；
  轮转池不再设条数上限，宿主白名单成为唯一真源闸门。
- **2026-09-22（0.1.0）**：桥接通道（Chat2API 外发 + `bridge_*` 三工具 + 12 道门控 +
  脱敏/限额/压缩回注/字符估算记账）整体删除，配置面从 30+ 字段收缩到 5 个。
  插件只剩子代理路由这一条通道，不再持有任何 HTTP 客户端或批次队列。

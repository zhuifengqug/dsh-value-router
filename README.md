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
并行批次天然落在不同模型上，限流也被摊开。

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
  pool:                            # 轮转线路池，最多 4 条
    - provider: hetu
      model: deepseek-v4.1-flash
      tier: cheap                  # cheap | mid | strong（仅用于文案与 UI，不参与路由）
    - provider: commandcode
      model: z-ai/glm-5.3-flash
      tier: mid
    - provider: commandcode
      model: stealth/space-bunny-alpha
      tier: strong
  executor:                        # 兜底线路：池为空 / 目标 provider 不可用时
    provider: hetu
    model: deepseek-v4.1-flash
    reasoningEffort: ''
  ambiguousPolicy: rotate           # rotate | respect，默认 rotate
```

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
两者是**两份独立配置**，不会自动同步，但**时序不同所以不会打架**：

- 宿主在子代理**创建前**校验工具参数（`assertAllowedModelSelection`）；
- 插件在**创建后**的 `agent/request` 改写，宿主根本看不到插件选的线路。

最坏情况：主控显式指定了宿主白名单外的线路 → 宿主抛 `gateway/bad-request`，
该次工具调用失败。提示词里已明确"只能从清单里挑"来降低发生率。
若你希望插件只使用宿主放行的线路，把两者配成一致的子集即可。

## 6. 安装

最低宿主：**DSH 0.1.7-rc.2**（peer 范围已收窄，更早的宿主会拒绝安装或静默禁用该插件行）。

```bash
# 开发装载（软链，改 lib/ 后重启 dsh 即生效）
dsh plugin --profile web add link:D:/dsh-workspaces/dev/local-plugins/dsh-value-router
```

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
pnpm test        # vitest，80 个用例
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

## 9. 退役记录

- **2026-09-29（0.2.0）**：专属预设 `value-router` 整体删除；`scope` / `excludePresets`
  字段删除；「无条件改写子代理线路」改为「显式指定即放行 + 轮转兜底」。
- **2026-09-22（0.1.0）**：桥接通道（Chat2API 外发 + `bridge_*` 三工具 + 12 道门控 +
  脱敏/限额/压缩回注/字符估算记账）整体删除，配置面从 30+ 字段收缩到 5 个。
  插件只剩子代理路由这一条通道，不再持有任何 HTTP 客户端或批次队列。

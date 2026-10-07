# @gjs27/dsh-value-router —— 价值路由（Value Router）

DSH 的**唯一模型路由 owner**。它只回答一个问题：**这次派发该用哪个
`provider / model / reasoning_effort`？**

| 通道 | 谁在用 | 机制 |
| --- | --- | --- |
| 普通 subagent | 主控通过 `subagent` 工具派发的子代理 | 宿主 `agent/request` 钩子 |
| 任务级路由 | 任何插件（Agent Teams 走这条） | Cordis 能力服务 `valueRouterRouting` |

**主模型永远不被接管**：`origin !== 'subagent'` 一律放行，这是第一位的不变量。
插件不注册任何工具，自身也不发任何网络请求。

> **0.10.0 是一次破坏性重构**：`pool` / `executor` / `strategy` / `ambiguousPolicy` /
> 会话级覆写全部退役，配置面收敛为**固定四档 + 单一全局兜底**。
> **没有迁移、没有双读**，升级必须重配——见 [§7](#7-从旧版本升级到-0100破坏性)。

---

## 1. 四档 + 单一全局兜底

配置长这样（命名空间 `value-router`）：

```yaml
value-router:
  enabled: true
  tiers:
    low:
      lines:
        - provider: hetu
          model: deepseek-v4.1-flash
          reasoning_effort: ''          # 留空 = 跟随目标模型自己的默认档
    medium:
      lines:
        - provider: commandcode
          model: z-ai/glm-5.3-flash
        - provider: xiaomi-token-plan-cn
          model: mimo-v2.6-flash
        - provider: commandcode         # 同一个模型换一家 provider = 换一份订阅额度
          model: z-ai/glm-5.3-flash
    high:
      lines: []
    max:
      lines: []
  fallback:                             # 单一全局兜底：不是任何档位的轮转成员
    provider: hetu
    model: deepseek-v4.1-flash
```

规则：

- **四档固定**：`low` / `medium` / `high` / `max`，顺序即成本顺序。
- **档内顺序 = 轮转顺序**：第 N 个任务拿第 N 条，取模循环。并行任务天然落在不同线路 /
  供应商上，限流与订阅额度被摊开。
- **同一个 `provider/model` 可以跨档各配一条**（哪怕只差 `reasoning_effort`）——
  档位归属由你显式配置决定。
- **档内按完整键去重**：同一档里重复的 `provider/model#effort` 只占一个轮转槽位。
- **没分档的模型不会被派发**：分档是显式配置行为，不是自动发现行为。宿主目录里新出现的
  模型默认**未分档**。
- **四档默认全空**：一条线路都不配时，普通子代理会继承主模型（最贵的那条），任务级路由
  会保持待定。请至少配一条。

### 全局兜底不是轮转成员

它只在**四档全部无可用线路**时使用，不参与轮转、不参与档内替代。没有它时，路由不出来的
任务保持待定，而不是偷偷继承主模型——这是刻意的：宁可让你看见「无人可派」，也不静默地
按最贵的线路跑。

## 2. 解析顺序（0.10.0 冻结，顺序即契约）

```
用户硬指定线路
  → 主模型合法 route 偏好
    → difficulty 档位
      → 档内轮转
        → 同档替代
          → 逐档降级
            → 全局 fallback
```

硬约束（每条都有对应单测）：

1. **用户硬路由不可用时任务保持待定 / 阻塞**，绝不自动换线路、绝不使用 fallback；
2. **只降不升**：自动路由永不升到比请求难度更高的档；
3. **主模型非法 route 只记 `route-rejected`**，然后按 difficulty / role 自动重选，
   不会让你的任务失败；
4. **主模型永不被改写**；
5. 普通 subagent 没有任务描述（`agent/request` 的 payload 只有 `{agent, turn, step, signal}`），
   所以**不猜难度**——固定 `medium` / `general`。真正的难度路由属于任务级（见 §5）。

### 两个来源的语义差别

| `routeSource` | 谁给的 | 不可用时 |
| --- | --- | --- |
| `user` | 用户在 staged 计划里硬指定 | `pending`（等环境）或 `blocked`（需人介入），**不换线路、不走 fallback** |
| `captain` | 主模型给的偏好 | 记 `route-rejected`，继续自动重选 |
| `difficulty` | 按难度档位自动选（含档内轮转 / 同档替代 / 逐档降级） | — |
| `fallback` | 四档全部无可用线路 | — |

`routeStatus` 三态：

- `resolved`：已解析出可直接派发的三元组；
- `pending`：意图合法但**当前**无可用线路（等环境变化，例如目录里暂时看不到）；
- `blocked`：意图本身非法，或用户硬路由被白名单挡住 / `reasoning_effort` 被明确否定
  （要人介入才可能好）。

**`dispatchable=false` 时调用方必须保持任务待定**，不得自行换线路或降级。

## 3. 线路可用性：目录 + 白名单

两个独立闸门，判定顺序 **白名单 > 目录存在 > `reasoning_effort` 能力**：

| 状态 | 含义 | 行为 |
| --- | --- | --- |
| `available` | 目录可见（或目录读不到，无法证伪）且未被白名单挡住 | 可派发 |
| `missing` | 曾经分档，但已从宿主目录消失 | **保留配置**并标记，不派发、不静默删除；目录恢复后自动可用 |
| `blocked` | 被宿主 `subagentModelSelection.allowedModels` 挡住 | 不派发（派了也会被宿主拒绝） |

- **宿主 LLM 目录是 provider / model 的唯一真源**：本插件不维护第二份模型清单，
  也不按名字猜能力（不猜 context、不猜 `reasoning_effort`）。
- **不拿「没声明」当「不存在」**：目录读不到、适配器不声明目录、模型未声明
  `reasoning_effort` 能力，一律按「无法证伪」处理——不拒绝、也不改写你填的值。
- **白名单读不到**（服务未挂载 / 旧宿主）→ **不做白名单拦截**：宁可放行让宿主自己拒绝，
  也不静默清空你的通道。

### 为什么必须有白名单闸门

宿主在**子代理创建前**用白名单校验主控显式传入的线路；本插件的改写发生在**创建之后**，
宿主看不到。所以插件必须拿同一份名单自己当闸门——两条路径都命中同一份名单，就不会出现
「这次工具调用被宿主拒绝」这种失败。

**配置建议：把你想用的线路同时加进宿主白名单和这里的分档。**

## 4. 界面

- **设置卡**（设置 → 插件 → 价值路由）：四档可折叠，档内可增删 / 上移下移线路；
  每条线路带可用性标记（`missing` / `blocked` / `reasoning_effort` 未声明）；
  全局兜底单独一块。
- **顶栏徽章 + 气泡**：本会话与累计改写次数、可用 / 缺失 / 白名单外线路数、
  最近派发记录（含 `routeSource`、降级与兜底标记）、最近运行事件（含排队原因）。
- **模型选择器**：从宿主目录里选，不需要手打 `provider/model`。
- **首次使用引导**：先给一条全局兜底保证「四档全空」时有路可走，再按需补档位。

顶栏读的是只读快照（30 秒周期刷新；超过 5 秒容忍窗口时后台刷新但仍返回旧值）。
快照里**只有线路三元组与判定结果**——不含凭据、不含提示词、不含请求内容。

## 5. 给其他插件用：`valueRouterRouting`

需要**任务级**路由的插件（Agent Teams 就是）通过能力探测调用本服务，
**不必知道本插件的配置形状**：

```ts
const router = ctx.get('valueRouterRouting')
if (router !== undefined) {
  const r = await router.resolve({
    difficulty, role, route, routeSource, rotationIndex, teamId, taskId,
  })
  if (r.dispatchable) {
    // 用 r.provider / r.model / r.reasoning_effort 派发
  } else {
    // 保持任务待定：r.routeStatus 是 pending 还是 blocked，r.reason 说明原因
  }
}
```

| 方法 | 语义 |
| --- | --- |
| `catalog()` | 宿主模型目录 + 四档分档结果（含 `missing` / `blocked` 标记）。异步。 |
| `validate(intent)` | 纯校验：难度、角色、显式线路。非法值走 `errors`，**不静默回落**。 |
| `resolve(input)` | 完整路由链，返回最终三元组 + 来源 + 状态 + 降级/兜底 + 审计数组。 |
| `record(event)` | 追加一条运行事件（派发 / 复用 / 排队 / 兜底 / 降级 / 线路被拒）。 |
| `events()` | 只读事件流（面板用）。 |

- `resolve()` **绝不抛错**：目录不可用之类内部失败会退化成
  `routeStatus: 'pending'` + `reason: 'catalog-unavailable'`，让调用方安全地不派发，
  而不是把异常炸进别人的调度流程。
- `resolve()` 会**自动记一条审计事件**，调用方不必记得为每条决策单独 `record()`。
- 服务缺席时**调用方必须保持原有行为**——本插件不提供任何「降级替身」。
- 线路一旦解析出来，就在**成员创建时冻结**并写进调用方自己的状态（Agent Teams 写
  `team.json`），启动后不中途换模型。
- 成员复用键 `memberReuseKey`（`difficulty` + `normalizedRole` + `provider` + `model` +
  `reasoning_effort`，五段以 `\u0000` 连接，即 `intent.ts` 导出的 `routeKey`）也由本模块
  冻结：**难度是槽位身份的一部分**，同一线路不同难度就是两个成员槽位。调用方用它做成员
  复用与去重（`maxMembers` 到顶时只排队，不降档、不换模型）。

### 决策审计 vs 运行事件

- **决策审计**：`resolveRoute()` 返回的 `audit[]`（步骤依次为
  `validate` → `user-route` / `captain-route` / `route-rejected` → `tier-rotate` →
  `same-tier-substitute` → `tier-degrade` → `fallback` → `pending`）挂在任务上随状态
  落盘，所以「为什么这条任务落在这个模型上」**在冷恢复后依然可查**。
- **运行事件**：有界环形缓冲（512 条，内存、不落盘、不影响路由），供设置卡与顶栏展示。
  类型：`dispatch` / `reuse` / `queue` / `fallback` / `degrade` / `route-rejected` /
  `user-route-pending` / `blocked`。每条事件写入时被**冻结**——审计记录不该能被随手改掉。

## 6. 主模型看到的提示段

插件注入一段系统提示（`value-router:guidance`，order 145），按会话角色分两版：

- **主控段**：职责说明 + 四档难度语义（`low`=机械检索/批量改动；`medium`=常规实现与调查/
  单模块改动（缺省）；`high`=需要设计判断或跨文件推理/契约变更/较大重构；`max`=疑难根因/
  安全关键结论/独立复核）+ **当前可用的线路清单**（只列目录里 `available` 的；
  一条都没有时整段省略，不承诺不存在的围栏）+ 规则（用 difficulty 表达难度而不是猜模型名；
  route 是偏好，非法不会让任务失败；用户指定优先；只降不升）。
- **子代理段**：只做当前单项任务，**不要递归派发**（禁止调用
  `subagent` / `subagent_fork` / `workflow`），给出证据与风险，由主控汇总交付。

## 7. 从旧版本升级到 0.10.0（破坏性）

0.10.0 **不做迁移、不做双读**。旧配置里的 `pool`、`executor`、`strategy`、
`ambiguousPolicy`、`tierRouting`、会话级覆写会被当成**未知键丢弃**，
**不再产生任何路由效果**。

1. 在 profile 的 `cordis.patch.yml` 里把 `value-router` 条目改写成 §1 的形状
   （`tiers.{low,medium,high,max}.lines` + `fallback`）。
2. **至少配一条线路**：四档默认全空 → 普通子代理会继承主模型，任务级路由会保持待定。
3. 想保证「四档全空也有路可走」，配一条 `fallback`。
4. 确认宿主白名单（`subagent-model-selection`）包含你配的线路，否则会被标成 `blocked`。

`strategy`（saver / balanced / powerful）随同退役：它的提示词档位被四档难度语义取代，
遥测改为上报 `difficulty`。

## 8. 安装

最低宿主：**DSH 0.2.0-rc.2**（peer 范围已收窄，更早的宿主会拒绝安装或静默禁用该插件行）。

```bash
# 开发装载（软链，改 lib/ 后重启 dsh 即生效）
dsh plugin --profile web     add link:D:/dsh-workspaces/dev/local-plugins/dsh-value-router
dsh plugin --profile desktop add link:D:/dsh-workspaces/dev/local-plugins/dsh-value-router
```

> **桌面端**用 `desktop` profile。桌面就是同一个 Web 客户端套 Electron 壳，本插件不需要为
> 桌面改任何声明，两个 profile 的配置各存各的（改一个不影响另一个）。
> 用 `file:` 会把包**复制**进 profile 的 node_modules，改 `lib/` 不生效——开发期只用 `link:`。

插件声明了 `dsh.bundle.patch`，装完宿主会自动把它写进 `dsh.profile.bundles`，无需手改。

## 9. 验证与回退

```bash
pnpm install --config.confirmModulesPurge=false
pnpm typecheck   # tsc ×2（host + client）
pnpm test        # vitest，10 个文件 / 106 个用例
pnpm build       # tsdown
```

回退：仓库有完整 git 历史与逐版本标签（`v0.1.0-local` … `v0.9.0`）。

```bash
git checkout v0.9.0 && pnpm install && pnpm build   # 回到 0.10.0 之前
```

## 10. 隐私与供应链

- 插件**不读取任何 API Key**：只消费宿主 LLM 目录的公开元数据
  （`listProviders()` / `listModels()` / `resolveModelInfo()`），不碰凭据配置、不猜端点。
- **自身不发任何网络请求**。遥测只在 `DSH_DESKTOP_PRODUCT_METRICS_BRIDGE=1` 时向 stdout
  写固定字段（事件 `value_router_route`：角色、结果、难度档、模型 id、错误类别），
  不含会话 id、提示词、凭据或上游错误文本。
- 状态快照里只有线路三元组与判定结果，不含请求内容。
- 安装期**不执行任何代码**（无 `postinstall` / `prepare`）；`prepublishOnly` 只在
  `npm publish` 时触发。

## 11. 版本适配记录

- **2026-10-07（0.10.0）**：破坏性重构——不再做「成本感知的子代理下沉」，改为 DSH 唯一的
  模型路由 owner。配置收敛为**固定四档 `low / medium / high / max` + 单一全局兜底**；
  `pool`、动态 `tiers`、`executor`、`strategy`、`ambiguousPolicy`、`tierRouting`、
  会话级覆写与迁移函数整体退役；新增核心模块 `core/catalog.ts`（目录为唯一真源）、
  `core/intent.ts`（意图校验）、`core/route.ts`（解析链）、`core/audit.ts`（审计）
  与对外的能力服务 `valueRouterRouting`（`catalog` / `validate` / `resolve` / `record`）。
  **无迁移、无双读。**
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

# 配置与 `role` 契约

面向两类读者：把本插件内置进发行版、在 profile 的 `cordis.patch.yml` 里 seed 条目的**集成者**，
以及排查"我 seed 的默认值去哪了 / `role` 为什么变了"的**维护者**。按需阅读，不必每次会话都加载。

每条结论都给了代码位置，便于复现而不是重新推理。

## 一句话结论

`role` **不是运行时开关**：Host 与 Client 两个半边始终都会启动。**"同时注册 host + client"**
由**登录完成后的自动补授权**完成，而不是由 `role` 完成。因此发行版 seed 的默认值在**功能上安全**；
唯一会被改写的时机是**有人点了远程卡片里的 DeepSeek 登录** —— 该路径会把 `role` 写成 `client`，
并把整节"可编辑配置"重写一遍。

## `role` 的真实作用

- **不决定哪个运行时启动**。Host 运行时无条件创建，`ClientModeRuntime` 的创建条件只有
  `config.serverUrl !== undefined && connection !== undefined`（`index.ts:290-309`）→ `host` /
  `client` / `both` 三种取值下**两个半边都启动**。插件自带 patch 用 `role: host`
  （`packages/plugin/cordis.patch.yml:13,28`）。
- **不影响双角色注册**。客户端登录完成后 `control-runtime.ts:281-283` 调
  `client.authorizeHostByDefault()` → `client-runtime.ts:276-293` 在 Host 尚未授权时用当前凭据执行
  `authorizeHostAsOwned(accessToken, account)`，把 Host 角色作为同账号"自有设备"注册。
- **`role: both` 是惰性值**。schema 接受它（`config.ts:121`），但所有决策点都写成
  `role === 'client' ? 'client' : 'host'`（`control-runtime.ts:316` 与 `:491`）；穷举搜索 `'both'`
  只命中 schema → **行为上 ≡ `host`**，既不会因此掉功能，也拿不到额外能力。
- `role` 真正影响的只有三处：
  1. 面板把哪侧关联当**主**（`control-runtime.ts:491`）—— 只是显示，`associations` 里 host 与
     client 两份都在；
  2. 登录用哪套**设备身份/凭据目录**（`:234`，凭据按角色分目录，`logout` 也清两份 `:441`）；
  3. 会话中切换角色时的**对侧补授权**（`:317-319`）。

## 写回行为

- **只在控制端点里写**，**没有启动期写入**：`settings.replace(...)` 全部位于 `control-runtime.ts`
  的端点处理器中；激活路径只有读（`index.ts:391-414`）。
- **唯一强制写具体角色的路径**是远程卡片的 DeepSeek 登录：`client.ts:2128-2129` **硬编码
  `role: 'client'`** → `settings.configure` → `control-runtime.ts:284` 用 `editableConfig(next)`
  **整节写回**。发行版看到的"patch 被展开成完整配置"就来自这里。
- **其余控制写入都保留 `current.role`**：`server.set`（`:303`）、`development.set`（`:336`）、
  `codex.set`（`:391`）、`acp.*`（`:377/401`）都是 `{ ...current, 只改自己那几个字段 }`。
- **CLI 完全不写 `role`**（`cli.ts` / `tui-command.ts` 无相关写入）。
- **没有 `DSH_HOME` 之外的存储**：角色只来自 profile 配置；状态全在 `DSH_HOME` 下
  （`identity-store.ts:70` + `serverStorageDirectory()`，凭据按角色分目录）。同机多份 home
  互不影响；外部输入只有 `DSH_REMOTE_SERVER`（`config.ts:140`）。
- 写入粒度是**整节**而非差异，但每次写入前都先 `resolveConfig(settings.get())` 读回当前值，
  所以**手工编辑的字段会被保留**，除了这次调用明确要设的字段。

## 给发行版的三种做法

| 做法 | 说明 |
| --- | --- |
| ① 只求稳定默认值 | seed 用 `role: host`（与插件自带 patch 一致），任何 UI 路径都不会改它。 |
| ② 保持 `role: both` | 功能上安全，但该值本身没有语义；**只要初次配置不走卡片登录**（用例行走 CLI/API）它就不会被改写。 |
| ③ 断言配置的脚本 | 断言 `role` 时接受 `host\|client\|both`，否则用户点过登录后会不一致（不是运行故障，只是断言失败）。 |

## 待办

让 `both` 有一等语义、以及"发行版钉住默认 `role`"的改动，见 [TODO.md](../TODO.md) 的
"发行版默认配置与 role"条目。

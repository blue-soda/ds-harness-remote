# 排查记录：DSH 0.2.1 Desktop 远程模式启动失败（2026-10-06）

本文是一次完整排查的原始记录，含被证伪的假设与取证方法，供后续遇到同类现象时对照。
**当前仍然生效的约束**摘要见 `AGENTS.md` 同名条目。

现象：Desktop 作为 Client 选中远程 CodeX 工作区后，渲染进程的启动判定失败
（`Error: web boot: 48 entries did not activate`），其中 `@deepseek-ai/dsh-client-locale: failed`，
所有依赖 `locale` 的插件保持 pending，应用弹出「DeepSeek Harness is unavailable」。
点 Restart（回到本地模式）必然恢复，因此与本地模式无关。

已确认的事实（每条都有证据，避免重复走弯路）：

- locale 抛出的真实异常只有在给 `dsh-client-locale` 的 `apply()` 临时包一层 try/catch 后才可见
  （DSH 只记录 `failed` 状态、不记录原因）：
  `Error invoking remote method 'dsh-desktop:locale-bootstrap': Error: desktop welcome: Web RPC failed`。
- 该 RPC 走 Desktop 主进程 ↔ 本地 web server 的 `/api/remote.mux`（Gateway 自有 WebSocket，
  见 `packages/api/gateway/README.md`），**不经过**插件的 Typert 网关切换器：给
  `invoke` / `dispatchRpc` / `stream` / `openWireStream` 四条路径都加上「对端无法回答即回退本地」
  后，日志里**没有**出现回退 warning，证明这条调用根本不经被 patch 的 runtime。
- 因此「我们的远程路由把它转走」这一假设**已被证伪**。`typert-gateway-switch` 的本地回退与
  「peer 未连接即走本地」保留为防御性改动，**不声称**修复了上述现象。
- 插件侧确有并已修复的契约缺口：`WorkspaceBaseline.pinnedSessionIds`（客户端直接读其长度）与
  `SessionProjectionHints.kind`（客户端 `assertNever` 穷尽分支）。修好后客户端控制台里
  `installPinned` 与 `block kind` 两条硬错误消失。
- 客户端 `codex.app.call` 调用面与 App Server 字段对照后发现 Host 侧 policy 偏严，已对齐上游：
  `thread/list` 的 `originators`/`sectionId`、`turn/steer` 的 `clientUserMessageId`、
  `thread/name/set` 的空名字（上游用空串清空名字，`.trim().min(1)` 会拒绝合法重命名）。
  拒绝消息现在点名方法与字段；注意未识别字段在 Zod 的 `issue.keys`，不在 `issue.path`。

未解决（**2026-10-06 晚更新：已定位并修复，见下**）：曾经的判断是"根因在 DSH 远程模式的 mux/引导"，
**该判断是错的**，保留在此仅作为排查教训。

**真正的根因与修复**：`client-runtime.ts` 打开远程 CodeX 工作区时执行
`gatewaySwitch.selectRemote(virtual, …)`，把 `CodexVirtualHarness` 作为**远端目标对象**接上，
于是它接管了 `/api` 的**每一个**端点；但载体只实现 CodeX 领域，其余全部落到
`virtual-harness.ts` 的 `default: fail('method-not-found', …)` ✗。Desktop 的原生引导要向
**本地**服务请求 `settings/describe`（见 `apps/desktop/src/welcome-backend.ts`：HTTP POST
`/api/<ns>/<method>`，只有 `result.ok === true` 才算成功，否则抛
`desktop welcome: Web RPC failed`），拿到我们的 `method-not-found` 后 locale 插件失败、
48 个条目 pending、界面判定不可用；Restart 回到本地模式则不经过该载体，所以必然恢复。

复现证据（在本机 web 实例上直接打 RPC，无需 Desktop）：修复前
`POST /api/settings/describe` → `{"ok":false,"error":{"code":"method-not-found","message":"CodeX virtual Harness does not implement settings/describe."}}`；
修复后同一探针 → `{"ok":true,"value":{…}}`。

修复：`virtual-harness.ts` 的 `dispatch`/`open` 默认分支改为**先委派给本地载体**，本地载体由
切换器的 `localCarrier()` 提供（`client-runtime.ts` 在 `selectCodexTarget` 里注入）。判定原则是
**谁拥有窗口谁回答**：CodeX 领域由虚拟载体回答；远端工作区的 `workspaceFiles/*` 与
`terminal/*` 仍由远端 Host 回答（`hostCarrier`）；**其余一律回本地**（设置引导、插件注册表
事件流、账号读取）。

> 中途曾把"非 CodeX 领域"一律转给远端 Host，**那是错的**：本地窗口于是显示**远端**的首次
> 欢迎流程，左下角也显示**远端**的账号（实测"已登录 DeepSeek"而非本机账号）。本地专属端点
> 必须由拥有窗口的那一侧回答。

第二处缺口：**历史分页大小**。原生 UI 会请求远超策略上限的 `maxMessages`，而
`readHistoryPage` 原样转发，Host 直接以 `dsh/sessionHistory → maxMessages: too_big` 拒绝，且
重试阶梯只处理"响应过大"、不处理拒绝，于是历史完全加载不了。现在 `method-policy.ts` 导出
`CODEX_HISTORY_MAX_MESSAGES`，**两个入口都钳制到同一常量**：虚拟载体的 `readHistoryPage`
（唯一收口）与 ApiProxy 的 `harness-api-history.ts`。

**2026-10-06 21:00 用户实测确认**：Desktop ↔ web 的远程 CodeX 工作区**可用** —— 连接、会话
名称、会话历史与对话全部正常，且**不需要运行 ChatGPT 桌面应用**（插件直接以发现到的
`codex.exe app-server` 工作，桌面应用只是二进制来源）。

排查教训：`Web RPC failed` 意味着 **RPC 执行了但回答是失败**（传输失败是 `Web request
failed`）；因此判定"调用是否经过我们"时，不能只看 promise 是否 reject，**必须看返回信封的
`result.ok`**。此前给四条路由加的"对端无法回答即回退本地"因此一次都没触发，并导致我两次
误判根因。

`scripts/codex-app-server-smoke.mts` 在真实 Codex **0.160.0** 上只读跑通了客户端使用的完整
路径：`thread/list`、`thread/read`（元数据与完整历史，含 `cwd=C:\Workspace\opencood` 这类
大小写不同的路径）、`dsh/sessionHistory`、`model/list`、`account/read` 全部成功，
**`thread/read` 不再返回 `CODEX_THREAD_NOT_ALLOWED`**，因此 Windows 路径比较的大小写修复
在真数据上得到确认。另外两点是**有意设计**而非缺陷：客户端直调 `thread/turns/list` 返回
`METHOD_NOT_ALLOWED`（Host 负责上游分页，客户端经 `dsh/sessionHistory` 读取）；`thread/list`
带 `originators` 会被**上游**拒绝，因为 policy 只负责放行上游声明的字段、取值由上游校验。

# TODO

本清单按 2026-09-29 的兼容方向维护：Harness v0.1.1 rc.2 使用官方 ApiProxy，
v0.1.2 alpha.1–rc.1 使用既有 Typert Remote Gateway，v0.1.5 rc.1 / v0.1.6 alpha.1 / v0.2.0 rc.1 作为 Session V3
兼容目标。Android 与 VS Code Client 通过 capability 探测兼容这些 Host carrier；完整 Server、Remote Web 和 Admin 在独立
Server 仓库实现；本仓库 `apps/server` 另提供最小多账号 Relay Server。

Desktop 已使用独立 Remote 工作区入口：本地选择账号下的 Host 与远端 Workspace，或通过
只读目录浏览添加 Workspace，随后复用原生 Harness UI。当前实现已跑通真实设备、Web→Host
主链路和独立 Server 跨仓库联调，具备开发预览发布条件；后续重点转为安全审查、恢复策略、跨平台矩阵和长期稳定性。

测试预算只用于协议、安全、账号授权、认证连接、ApiProxy/Typert Remote allowlist/stream 生命周期和核心
transport 状态机；普通 UI、文案和辅助脚本不单独补测试。

## 已完成基线

- [x] Issue #70：Plugin 刷新跨进程互斥、握手恢复单次重试、重复 Host 连接停止抢占及授权恢复提示
- [ ] Issue #70：Windows 双实例与异常退出遗留锁的实机回归（已有进程级锁与状态机测试）

- [x] pnpm monorepo、共享 Protocol/Crypto/Transport/Client Core
- [x] Host 账号密码/主机匹配码接入、Client 账号接入、device token rotation 与按 Server/角色隔离的身份状态
- [x] 同账号 membership、受保护 peer descriptor 与本地 pinned trust 双重授权
- [x] Relay control、标准 Noise IK、counter/replay 拒绝与 opaque ciphertext
- [x] Desktop Plugin Host runtime、Settings 配置和 GitHub/npm Bundle 入口
- [x] dsh-TUI profile 在无 Desktop `connection` 服务时默认启动 Host，并通过原生 `/remote` 的 `login [github|zhihu]`、`status`、`logout` 完成终端授权和状态管理；`ds-harness-remote` 保留为启动前 CLI
- [x] Host ApiProxy allowlist bridge、mux/host stream 与后台 Local/Remote ApiProxy switch
- [x] Harness v0.1.2 alpha.1–rc.1 Typert Remote unary/stream/event carrier、固定 endpoint allowlist、加密 capability 探测与 legacy ApiProxy 激活兼容
- [x] Harness v0.1.5 rc.1 / v0.2.0 rc.1 Session V3 capability、严格 surface replacement、Assistant stream 与 v0.1.2/V3 mutation 前混连拒绝
- [x] 升级官方依赖到 `dsh-v0.2.0-rc.1`，修正 0.2.0 版本判断、Workspace payload 与原生 UI allowlist，并完成 Plugin 核心回归测试
- [x] Android 与 VS Code Client 按 Host capability 在 rc.2 ApiProxy 和 v0.1.2 Typert Remote 之间选择数据面
- [x] Remote 模态框、主机自过滤、OS/Harness/Plugin 版本展示、远端 Workspace 与目录选择
- [x] Remote Header、LAN/P2P/TURN/Relay 链路、端到端加密状态与退出入口
- [x] 配合 dsh-file-viewer 的远端只读文件 stat/list/分块预览桥与 Client provider
- [x] 不同 Web Client 同时连接一个 Host；RPC、stream 与断开清理按 connectionId 隔离
- [x] Web → Host 主链路真实环境验证：账号授权、Host presence、Remote Workspace、Session/Prompt/approval 与断开回落
- [x] 独立 Server 跨仓库联调：REST、Control WebSocket、Relay、Signaling、conformance fixture 与 membership/IDOR 防护
- [x] 删除自定义 Session/Agent/Workspace/Permission adapters、event replay 和旧 Host RPC 路由
- [x] GitHub Actions 使用 Node.js 22 和 pnpm 9.15.4 执行 build、check、test 与 Bundle 校验

## 发行版默认配置与 role

第三方发行版在 profile patch 里 seed `ds-harness-remote` 条目时的契约与待办；完整证据链见
`docs/config-and-role.md`。

- [x] 核对"seed 的 `role: both` 在全新 home 下被改写成 `client`"：已确认 **`role` 不是运行时开关**
      （两个半边都由 `serverUrl + connection` 决定 ✓）、双角色注册来自 `authorizeHostByDefault()` ✓、
      `both` 为惰性值 ✓、唯一强制写角色的是**远程卡片的 DeepSeek 登录**（`client.ts:2129` 硬编码
      `role: 'client'` ✓）、其余控制写入与 CLI 都保留或不动 `role` ✓
- [ ] 让 `both` 有一等语义：放开 `configure`（`control-runtime.ts:224`）与 `setRole`（`:312`）对 `both`
      的校验，并定义行为（建议：以 host 身份授权后再补授权对侧，与"凭据按角色分目录"的既有模型一致），
      附最小测试
- [ ] 若发行版要"钉住"默认 `role`：允许声明"面板登录不改写 `role`"，或在写入前保留 patch 的原始
      `role`；需先定语义（`both` 是否等于双份授权）再实现

## P0：Plugin 可用链路

- [ ] Windows 用户目录 WinSW 安装实机回归：管理员权限预检/账户密码、独立 Node、旧登录任务迁移、重启后 Host/CodeX、失败重试与卸载保留凭证（含 ARM64 .NET wrapper）

- [x] 在真实 dsh-desktop 中验证 GitHub 安装、重启、Host/Client 配置和 Bundle 入口
- [x] 在真实 dsh-TUI alpha.2 profile 中验证 `/remote` 补全、GitHub/知乎扫码、上线与跨机 Session/Prompt/approval
- [x] 分别用 `dsh-v0.1.1-rc.2`、`dsh-v0.1.2-alpha.1` 与 `dsh-v0.1.2-alpha.2` 跑通双机 Workspace/Session/Prompt/approval E2E，并验证混合代际在 mutation 前拒绝
- [ ] 用 `dsh-v0.1.2-rc.1` 补跑 Desktop/dsh-TUI 跨机 Workspace/Session/Prompt/approval E2E 与长期稳定性回归
- [ ] 用 `dsh-v0.1.5-rc.1` 补跑 Desktop/dsh-TUI 跨机 Workspace/Session/Prompt/approval、CodeX replacement/stream、重连 E2E 与长期稳定性回归
- [x] 用独立 `dsh-v0.1.6-alpha.1` 实例跑通 Web → Host 主链路（Plugin 树加载、Host identity、Codex 域与 client bundle 下发）
- [ ] 用 `dsh-v0.1.6-alpha.1` 补跑 Desktop/dsh-TUI 跨机 Workspace/Session/Prompt/approval、CodeX replacement/stream、重连 E2E 与长期稳定性回归
- [x] 用两台真实 Harness + 外部 Server 跑通同账号授权、选择 Remote、创建/继续会话
- [x] 验证原生 mux/host stream、approval/question respond 与断线关闭行为
- [x] 用手机 Web 与电脑 Web 同时连接一个真实 Host，验证并发操作、同设备重连和流隔离
- [ ] 验证 allowlist 覆盖官方 UI 的必需方法；允许已认证 Remote peer 通过官方 seam 管理 Host 实时注册的 settings 命名空间与全局 credential 引用（credential 值只写），并保持 `settings.openDocument`、native path、目录写入、任意文件访问、attachment upload 和 download 禁止
- [x] 用两台真实 Harness 验证 dsh-file-viewer 文本、图片、PDF、大文件分块与断线回落
- [ ] 在 macOS、Windows、Linux 验证 native picker 只读目录兜底、symlink、权限错误和大目录截断
- [ ] 完善账号过期、`DEVICE_OWNERSHIP_REQUIRED` 和 legacy owner 的显式恢复体验
- [x] transport 关闭后 pending unary/stream 立即返回稳定错误，并清理 timer 和 abort listener

## Codex Remote Session / History（已完成，实验发布）

Codex 属于同一个 Remote Plugin，但在 Plugin 内保持独立业务领域。它在 Remote 工作区选择阶段
提供虚拟 Workspace/Session 数据源，并把 `Thread -> Turn -> Item` 临时投影为 DSH 原生 Session
事件；不迁移数据，也不写入 DSH SessionStore。

- [x] 增加默认开启、可在设置中关闭的 `codex.enabled` 与本机 `binary` 配置；Workspace 优先使用 CodeX `project/list`，为空或不支持时回退到 `thread/list.cwd`
- [x] 增加 Host 单例 stdio App Server 生命周期、initialize/account probe 与动态 capability
- [x] 增加独立 `codex.app.*` RPC/event/transfer、固定 method schema allowlist 与大 History 分块
- [x] 增加按 connection 隔离的 stream、active-turn owner、opaque approval handle 与断线 fail-closed
- [x] 增加共享 Client Core Codex client、`DisplaySession` / `DisplayHistoryItem` 纯展示投影
- [x] Android 按动态 capability 直接接入 `codex.app.*`，将 `project/list`/Thread/分页 History/live frame 合并到现有 Workspace/Session/Chat
- [x] Android 接入 CodeX 模型与 reasoning、固定权限预设、系统图片选择器 Prompt、interrupt 和单次命令/文件审批
- [x] 在 Remote 工作区选择器中增加 CodeX 虚拟工作区入口，不增加本地入口或独立页面
- [x] Desktop 与 Android 增加 CodeX Workspace 创建入口，通过固定 `project/create` 白名单新增经 Host 校验的真实目录
- [x] 增加 rc.2 ApiProxy / v0.1.2 Typert 内存虚拟载体，将 CodeX History/live 映射为原生 Session 事件
- [x] 将 reasoning/plan delta、command/file/MCP progress、Thread status、model reroute 与 Web Search/Subagent/Image/Compaction/Review Mode Item 投影到原生 chunk、状态、projection 和工具卡片
- [x] 将新建空 Thread 稳定挂载到当前 CodeX Workspace，并增加 Host 端消息边界 History 分页与 Client 端 Session 元数据搜索
- [x] 复用 DSH 原生 Workspace/Session 列表、Conversation Renderer、Composer、工具与审批 UI
- [x] 接入原生 Session 权限预设切换、剪贴板图片 Prompt 分块传输，并在不开放通用文件附件时隐藏 Composer“+”入口
- [x] 增加 App Server crash 后有界指数退避重启；关闭旧 stream 且不自动重放 mutation
- [x] 使用当前 v2 schema 与真实 Codex App Server 完成 stdio initialize/account/project/list/read 冒烟
- [x] 使用真实 Codex App Server 完成本机 thread/start、幂等 resume、streamed turn/completed、History 回读与归档清理冒烟
- [x] 迁移旧 `dsh-remote` 用户设置，并在 macOS 默认配置下自动发现 ChatGPT App 内置 Codex
- [x] Windows 自动发现 ChatGPT 桌面应用内置的 `codex.exe`（取最新哈希目录），无需桌面应用运行即可对话（2026-10-06 用户实测）
- [x] 用真实 Codex App Server **0.160.0** 与 DSH **0.2.1-alpha.1** 跨机跑通 Desktop ↔ web 远程 CodeX 工作区：连接、会话名称、会话历史与对话正常（`scripts/codex-app-server-smoke.mts` 覆盖只读调用面）
- [x] 用两台真实 DSH Desktop 跑通加密跨机 resume/turn/event/approval/interrupt 与大 History 传输
- [x] 验证 App Server crash、Host transport 重连和多 Desktop Web Client 同时观察同一 Thread
- [x] 用 Android 真机跑通 CodeX Workspace→Thread→Prompt/steer/approval/interrupt、大 History、图片分块与断线重连
- [ ] 用真实 Desktop 与 Android 验证远端 `project/create`、新增后自动选择和空 CodeX 目录首个项目流程

## P0：协议与安全

- [ ] 将 `packages/protocol` 与 `docs/protocol.md` 的 Control、Account Authorization、Connect、Relay、ApiProxy tunnel、Error 和 Limits schema 逐项对齐
- [x] 清理仅供冻结 Android 原型使用的旧 Session/Event 类型（PR #54, commit 5304fcd + 8ad988b）
- [x] 固定 hello/hello.ack 版本拒绝、capability 协商与 Control/Relay frame 上限
- [x] 拒绝超限 Control/Relay frame 和 binary Control frame
- [ ] 完成 Noise 实现独立安全审查、长期连接 rekey 与断线密钥清理策略
- [ ] 增加剩余协议 golden vectors
- [x] 增加 Noise IK golden vector
- [x] 补齐 counter 安全整数边界与 Control/Relay frame limit 测试
- [ ] 补齐真实 Relay 链路的篡改、重放和错误 identity 跨层验证

## P1：Transport 与恢复

- [ ] 实现 control heartbeat、RTT、最后活动时间和错误分类
- [x] 完成 WebRTC offer/answer/ICE、STUN/TURN、短期 credential 与 Relay fallback 基础链路
- [ ] 完善 `connecting -> direct -> relay -> reconnecting -> offline` UI 状态机和网络切换恢复
- [ ] 定义 direct 超时和 Relay fallback，切换中不得重复已提交的 ApiProxy mutation
- [ ] 重新连接后重开原生 mux/host stream，并由官方 UI 重新获取 history baseline

## P1：跨仓库 Server 联调（已完成）

- [x] 持续同步 `server.md`、`protocol.md` 与 Host Plugin 接入契约
- [x] 冻结 REST、Control WebSocket、Relay 和 Signaling 合约
- [x] 在两仓 CI 使用同一组 conformance fixtures
- [x] 验证 Server 无法解密 ApiProxy payload，且 host registration code/token/membership/IDOR 防护成立

## P2：工程与发布

- [ ] 使用系统 Keychain/Secret Service 保存身份私钥和 refresh token
- [ ] 完成多窗口、休眠/唤醒、代理网络和系统浏览器账号授权
- [ ] 明确版本、License、发布策略与兼容矩阵
- [ ] 提供脱敏日志导出和真实设备长连接性能基线
- [ ] 修复冻结 Android 原型的 Metro exports fallback 警告（仅在恢复 Android 产品线时）

## VS Code Client

`apps/vscode` 已实现 Extension 基础入口、SecretStorage 连接身份/凭证、账号密码与扫码登录、同账号
Host 列表与 identity fingerprint 固定、Adaptive transport + Noise、rc.2 ApiProxy / v0.1.2 Typert Remote
capability 探测，以及 Host → Workspace → Session 层级导航、Prompt、permission command、approval 响应和编辑区会话面板。该能力仍是开发者预览，剩余工作：

- [ ] 在真实 VS Code Extension Host、外部 Server 与跨机 Harness Host 上完成 E2E
- [ ] 增加 token 失效恢复与连接断开后的自动重连
- [ ] 完善实时增量渲染、question 响应界面与重连后的 stream/history 恢复
- [ ] 验证 VSIX 在 macOS、Windows、Linux 的系统 SecretStorage 与代理网络行为

## Browser Launcher（已完成）

`apps/browser` 只作为 Chrome/Edge 的 Remote Web 入口，不实现第二套完整 Client。它负责
从已登录 Remote Web 换取独立 Browser device credential、在线 Host 列表和打开 Remote Web。

- [x] 收缩为 Web 授权入口和在线 Host 列表，删除扩展内账号/扫码登录、Remote transport 与会话 UI
- [x] 临时读取同源 Web 登录授权，经专用 exchange 接口换取隔离的 Browser device credential，不持久化 Web Token
- [x] 点击在线 Host 后直接打开同源 `/app/remote/{hostId}`，复用浏览器已有 Web 登录状态
- [x] 加载 unpacked 扩展，联调 Web 授权、presence 刷新和目标 Host 跳转

## Android Client（主链路已完成）

`apps/android` 已迁移到当前 rc.2 ApiProxy / v0.1.2 Typert Remote 双数据面，并接入可选 CodeX Remote：账号登录注册、成员设备列表与 identity key
固定、Adaptive transport + Noise secure channel、`harness.api.*` 或 `harness.remote.*`
tunnel 与 mux/Gateway frame 聊天。功能已对标 Web 端 Remote 控制台：新建/继续/归档会话、历史分页、
模型目录与切换、相册图片 Prompt（Host limits 预检 + transfer 分块）、Workspace 管理（创建+只读目录浏览/重命名/删除/排序）、连接详情面板与
传输偏好（Auto/TURN/Relay），以及跟随系统/英文/简体中文语言设置。CodeX 侧直接消费独立
`codex.app.*`，使用 `project/list` Workspace 或精确的 `thread/list.cwd` 后备 Workspace、分页 History/独立 stream、模型/权限、图片 Prompt、
interrupt 与单次审批，不恢复旧 Android RPC。剩余工作：

- [x] 数据面端到端联调（本地 Server + 真实插件 Host + smoke client）：账号授权、加密 Relay、
      mux 流、会话列表、`host.describe` 透传与 approval `client-response` 应答
- [x] 更新 smoke client：优先选择在线 Host（presence 探测）、按插件 bridge 的嵌套帧类型匹配
      `assistant/chunk`（原实现永远匹配不到）
- [x] 真机/模拟器 UI E2E：账号登录、设备列表、连接、会话与聊天
- [x] 真机验证 Android Photo Picker 多选、超限提示与大图片 transfer
- [x] 重连后 mux/Gateway stream 重开与 history baseline 重建的真机验证
- [x] WebRTC P2P/TURN 路径真机验证（react-native-webrtc 与 Host werift 互操作）
- [x] 同步协议 conformance fixtures 到 Android 侧校验

`apps/android` 与 Mock Host 曾作为旧 Remote RPC 原型冻结；现在 Android 直接实现/消费官方
ApiProxy / Typert Remote contract，不得在 Plugin Host 恢复 `sessions.*`、`session.send`、
`permissions.respond` 或 `sync.from`。

## 不在本仓库实现

- 完整多账号 Server、Remote Web、Admin runtime 及其数据库、队列和部署代码（`apps/server` 最小自部署版本除外）
- 绕过官方 Session 文件系统或 dsh-file-viewer provider 的任意文件访问、独立文件写入 RPC、远程桌面或通用 Harness tool RPC；用户明确授权的原生 terminal 和受限 loopback 预览除外
- 绕过 ApiProxy allowlist 的 Cordis service 反射

## 第一版完成标准

- [x] 双角色 Plugin 可安装到真实 DeepSeek Harness 并主动连接外部 Server
- [x] Host 账号授权注册后只使用独立 device credential 常驻
- [x] Desktop Client 使用同账号注册并从授权设备详情固定 Host identity key
- [x] Desktop Client 在真实原生 UI 打开 Remote Workspace 并退出回到 Local
- [x] 原生会话、stream、tool、approval/question 通过 ApiProxy tunnel 正常工作
- [x] 连接断开后旧 stream/answer 失效并安全回落 Local
- [ ] Relay capture 无法解密 payload，篡改、重放和 identity mismatch 被拒绝
- [x] 核心 check/test/build 与 Bundle 校验通过

## 最小自部署 Server

- [x] 环境变量单账号、登录/状态页、持久化设备凭据、Control/加密 Relay 转发
- [ ] 真实 Desktop/Android/VS Code 跨机 E2E 与反向代理长期连接回归

## 原生侧栏与开发预览（2026-09-20）

- [x] alpha.2 官方只读文件树/预览 API allowlist、默认开启且可在详细 Remote 设置中关闭的原生终端开关
- [x] 终端按设备归属、连接 attachment 校验；禁止 Remote 修改插件自身访问设置
- [x] 白名单 IPv4 loopback HTTP/WebSocket 通道与独立本机预览 origin
- [x] Relay 背压、串行加密发送、有界 stream 消费队列
- [ ] Windows/Linux 真机、跨机高延迟 Relay、大输出终端、多设备回归
- [ ] 真实应用复杂 HMR、硬编码 localhost、Cookie/CSP 和浏览器兼容性回归
- [ ] Remote Web / Android / VS Code 预览入口（需独立方案，不复用本机 preview URL）

## Android native session tools (2026-09-21)

- [x] 兼容旧版内嵌 permissions.options 与新版 permissionPresets/catalog，补齐 Host 只读 allowlist
- [x] Harness 会话工作区目录浏览、UTF-8 分页只读预览；不支持的 Host 显示更新提示
- [x] Android 本地 xterm 终端、创建/恢复/结束、归属与输入权隔离、序号检查和断线不重放
- [ ] 真机验证新旧 DSH 权限切换、Host 热开启/关闭终端、跨机重连、Windows 路径与 shell、长输出、IME/TalkBack/大字体
- [ ] Android 图片/PDF/Office 只读预览真实 Host 与真机验收：大文件、转换超时/字体缺失、取消与断线、内存峰值、分页缩放
- [ ] PDF 文本选择与 TalkBack 验收（当前已有受限文本叠层，真机未验证）

## 远程连接：断联检测与列表兜底

- [ ] **刷新 Desktop 副本前必须确认 dist 是"打包产物"（2026-10-08 实测事故）**：`pnpm build` 的某个中间状态会
  把 `tsconfig.emit.json` 的**源码直出**写进 `packages/plugin/dist/index.js`（约 20KB、带着 `import { … , }` 类型导入），
  而正确的 esbuild 产物约 **1071KB**。我用 `file:` 依赖把当时那份 20KB 文件拷进 desktop profile 后，Desktop 重启即
  **插件加载崩溃**（Host 掉线 → 客户端走灾难回退 → 重连拿不到 Host，自部署 Server 还把它答成 `INTERNAL_ERROR` 而不是
  "对端离线"）。规则：**先比对大小**（`Get-Item packages/plugin/dist/index.js` 应 ≈1MB），再执行
  `pnpm remove @blue-soda/dsh-remote && pnpm add -w file:…`；构建脚本里"emit 覆盖 bundle"的顺序问题应另行修掉。

- [ ] **半开连接（本端收不到 close）目前没有检测手段**：服务端心跳 25s、75s 无 pong 会 drop link 并通知 Host，
  因此 Relay 链路下通常由服务端先发现；但若本端 socket 静默失效且 close 事件丢失，插件会一直保持"已连接"状态。
  2026-10-07 曾加过一套应用层 `ping` 探测（读取状态时触发、连续两次无应答判定断开），被判定为**

## 远程连接：断联检测与列表兜底

- [x] **进程被杀后重建会自动连回远程**（2026-10-07 实现）：插件把"上次的远程目标"写入
  `<plugin state>/client-target.json`（`mode: local | remote`，remote 时含 Server 与 Host deviceId），
  启动时 `restoreLastTarget()` 读取它；若为 remote 且 Server 与当前配置一致，就走既有的退避重连循环
  （1s/2s/4s/8s/15s，之后每 30s），并通过 `status.restoringTargetDeviceId` 与侧栏文案显式显示正在重连。
  切回本地会写回 `local` 记录并顶掉重试循环；认证类失败（`AUTH_REQUIRED`/`ACCOUNT_AUTH_REQUIRED`/
  `AUTH_INVALID`/`TOKEN_EXPIRED`/`DEVICE_*`/`MEMBERSHIP_REQUIRED`）**立即停止重试**，因为等待无法修复它。
  **Android 真机验收待做**（进程被回收后重开，确认自动连回与侧栏状态）。
- [x] **断链恢复：快速重连窗口 + 有限退避（2026-10-08 重做；上一版的应用层探测已删除）**：
  上一版是"会话建立后每 **30 秒**发一次只读的 `harness.transport.describe`，逐调用预算 **4 秒**，第一次无应答进
  快速重连、第二次无应答进灾难回退"。**该探测已整体删除**：它排在会话自身流量之后，Host 推大历史时会被误判为
  "没有应答"，实测形成自激循环（探测超时 → 快速重连 → 重开工作区 → 再次超时）。
  - **两个真实触发**：Server 通知链路已丢（对端离线 / 被顶替 / 协议失败），以及我们自己发现连接已死（写入吃
    RST，约在 Server 判超时后 1 秒；或传输被关闭）。两者都先走**快速重连窗口**，日志 `reason` 为
    `transport-closed` 或 `link-dropped`。
  - **快速重连窗口**：10 秒内至多 **2 次**尝试，两次都**强制 relay**（实测 relay 建链 2–3 秒，direct 协商单独
    就要 12 秒）；期间**不切视图、不刷新工作区、不重载**，成功后只刷新会话数据，并把工作区选择重新发布一次。
  - **窗口耗尽 → 回退本地**：走 `handleRemoteTransportLost()`（回退本地 + `fellBackToLocal` + 页面重载），
    `phase = 'fallback'`。
  - **退避日程与上限**：立即、5、5、10、20 秒，其后每 30 秒，**至多 5 次**；走完即停止并**收起「重连中」**
    （日志 `reconnect gave up; staying in the local shell {"attempts":10}`），此后只接受手动重连。
  - **可见与可中断**：只有**顶部会话栏**显示「重连中」并可点击取消（`mode.set local`，会顶掉重连循环）；
    侧栏条目与目标对话框**不再重复**该状态（用户 2026-10-07 要求把语义交给顶部栏）。启动恢复是第三阶段
    `phase = 'restore'`。
  - 定时器 `unref()`、随会话启停（切回本地/丢链/关闭时清除），不持有事件循环，也不拖住测试。
  - **回前台立即触发**：浏览器半在 `visibilitychange`（仅 visible）与 `focus` 时调用控制端点
    `client.connection.verify`，不等下一个周期。
  - **实测（`scripts/desktop-silence.ps1` 冻结 Host；`scripts/client-silence.ps1` 冻结客户端）**：冻结 30 秒 →
    什么都不发生 ✓（服务端心跳阈值 45 秒未到，链路存活）；冻结 90 秒 → 服务端在 **48 秒**判离线并丢弃链路 ✓，
    客户端恢复瞬间由**快速窗口第一次尝试**（relay-only）重建 ✓（日志 `session kept its view through a quick reconnect`），
    **没有** `transport lost` ✓、界面不刷新 ✓；Host 长时间不可达时窗口两次都失败 → 回退 ✓ → 日程走完并收起
    「重连中」✓（`attempts:10`）。
  - **自我替换陷阱（已修）**：快速重连的重建会**新建**控制连接，而 Server 会关闭同一设备的旧连接 —— 旧传输的
    `onClose` 曾被当成灾难回退，于是快速重连**永远把自己升级掉**（表现为"只看到灾难回退"）。现在正在被替换的
    传输的关闭会被忽略；触发只认真正的断链信号，日志带 `reason`（`transport-closed` / `link-dropped`）。
  - **回退/恢复的界面重建（实测驱动）**：DSH 的工作区 store 无法从插件侧刷新（`IWorkspaces` 没有 refresh），
    所以进灾难回退时客户端半**重载一次页面**（落到本地列表）、重连成功后再**重载一次**（落回远程工作区）；标签页
    记住工作区选择，重载后能回到原处。首次快照即基准 + 双向限流，保证不循环重载。
  - 真机验收仍待做（Android 后台久置后回前台：应看到"正在重连"，并区分"链路恢复"与"回退本地后重连"）。
- [x] **本地兜底收窄 + 恢复后重取基线（2026-10-07 实现，实测驱动）**：实测日志（warn 走 stderr，
  见 `instance.err.log`）证明传输消失期间插件把 `session/list`、`session/follow`、`settings/describe`、
  `llm/*` 等统统交给本地 shell 回答（`serving <endpoint> locally: the peer did not answer it … The
  authenticated Noise channel is not connected.`），原生 UI 因此把本地/空数据当成远程工作区缓存，链路恢复后
  不会重新取，表现为"会话列表一直不可用"。
  - **A 收窄**：兜底判定区分"对端拒绝"与"对端已消失"。拒绝（能力不匹配，如 `METHOD_NOT_ALLOWED`）仍可本地
    兜底；已消失（见 AGENTS 的码表）时只允许引导类命名空间（`$events`、`settings`、`credentials`、
    `dynamicCordisRunner`）本地回答，**数据端点显式失败**。`client-secure-transport` 的
    "Noise channel is not connected" 现在带 `TRANSPORT_CLOSED` code —— 该码原先甚至不在"对端无法应答"表里，
    所以最初的收窄是失效的，已修。
  - **B 重取基线**：记住上次打开的工作区（`lastWorkspaceSelection`），重连完成（快速重连成功或退避重连成功）
    后重新发布为 `pendingWorkspaceSelection`；客户端半的 `reconcile()` 会 `connectWorkspace()`，从而逼
    原生 UI 重读会话列表。切回本地会清掉这个记忆。
  - 测试：switch 侧（数据端点不再本地兜底 / 能力拒绝仍兜底 / 引导命名空间在断连时仍兜底）、runtime 侧
    （重连完成重新发布选择）。全量 **345 通过**。
- [x] **`plugin-lifecycle` 11 个用例超时（已定位并修复，2026-10-07）**：根因是 Codex 域**默认开启**，
  而 `HostPluginRuntime.start()` 会 `await codex.start()`，**Server 控制连接排在其后**；设备上没有 `codex`
  二进制时，`launchAppServer()` 会逐个尝试 binary 候选、每个候选各消耗一次请求超时，实测 `codex.start()`
  单独耗时 **15250ms**，于是每次启动都超过 vitest 默认的 5s 超时。影响不止测试：Host 在每次启动后
  **15 秒内对 Server 不可达**，客户端启动与启动恢复也顺延。修法：Codex 域改为**后台启动**、不再排在
  Server 连接之前；`hostStatus().starting` 区分"启动中"与"离线"；整个启动加 **5 秒硬预算**
  （`CODEX_START_BUDGET_MS`，超时记 `CODEX_START_TIMEOUT`）；lifecycle 测试的 settings fixture 默认
  `codex.enabled = false`。结果：11 个用例全部通过，全量耗时 57s → 12.7s。
- [x] **`codex-domain` 5 个平台失败（已修复，2026-10-07）**：成因三个，都不是产品缺陷：
  (a) `codexBinaryCandidates` 的 darwin 分支用宿主 `join` 拼 macOS 路径，在 Windows 上得到反斜杠 →
  改为按**参数平台**用 `posix.join`（生产行为不变，因为它总是传入本机平台）；
  (b) 4 个用例直接 `symlink(..., 'dir')`，Windows 未开启开发者模式会 `EPERM` → 新增 `linkDirectory()`，
  失败时回退到**目录 junction**（无需特权，`realpath` 同样解析），两者都不可用时只跳过依赖链接的断言，
  而不是整个用例；
  (c) 隐藏目录断言假设"点号前缀即隐藏"，而实现在 Windows 上按平台返回 `hidden: false` → 期望按平台收敛。
  (c) 是链接修好后**首次**在 Windows 上真正执行到的断言。至此全量测试 330/330 通过。
- [x] **构建会损坏 profile 副本的硬链接（2026-10-08 定案并修复）**：`tsc -p tsconfig.emit.json` 的 `outDir` 是
  `./dist`，所以它**原地截断** `dist/index.js`（写成 20KB 的源码直出），随后 `build-bundles.mjs` 用原子重命名把
  工作区换成新的 1072KB 文件 —— 但 pnpm 安装到 profile 的是**硬链接**，仍指向被截断的旧 inode，于是 Desktop 加载即
  语法报错、插件崩溃（Host 掉线 → 客户端灾难回退 → 重连拿不到 Host）。两个连带坑：`emitDeclarationOnly` 在
  `tsconfig.emit.json` 顶层无效（`--showConfig` 里根本不出现，且 tsc 要求 `outDir` 必须写在 `compilerOptions` 内，
  写错会让构建直接失败并留下坏文件）；`fsutil hardlink list` 的输出不足以判断是否硬链接。**修复**：emit 输出改到
  `dist-types/`（已加入 .gitignore），`dist/index.js` 从此只由打包器写；实测"构建 → 再构建"后 profile 副本稳定
  保持 1072KB。**规则**：刷新 profile 副本前先比对大小（≈1MB），且刷新后不要再构建（或构建后重新刷新）。
- [x] **Desktop 启动崩溃（welcome 认证失败）复盘归档（2026-10-08）**：桌面重启后连"无插件"都起不来，
  根因是**陈旧的 Electron 会话状态**（`electron-user-data`）——由 `BrowserAuth.isAuthenticated()` 的判定条件
  （cookie 必须由**当前激活密钥**签名且绑定 authority；每次启动端口都不同）决定，于是连应用自己打印的 launch URL
  都被回 401；改名该目录后一次通过（崩溃日志 0 份）。**与插件/profile/账号凭证无关**，磁盘凭证始终完整；
  用户侧唯一动作是重新登录一次（当时 `client/server-credentials.json` 为 `AUTH_INVALID`，Host 侧正常刷新）。
  途中另有两个真实但不致命的问题：定制发行版的 `BUNDLED_EXTRA_SPEC = '^0.4.30'` 在版本未发布时会阻塞启动
  （现已发布 ✓）、以及改过 profile 依赖后必须补跑 `dsh-desktop-full.cmd`。完整时间线与证据见
  [`docs/incidents/desktop-welcome-auth-2026-10-08.md`](docs/incidents/desktop-welcome-auth-2026-10-08.md)。


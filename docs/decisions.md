# 不变量与已被采纳的决定

这份文档是**改动前必读**的清单：这些行为是踩过坑之后定下来的，改动前先确认你了解代价。
历史过程（复现步骤、被证伪的假设）在 `docs/incidents/` 与[验证历史](validation-history.md)。

## 1. 身份与角色

- **一台设备一份身份**：`ensureDeviceDirectory()` 把旧的角色目录迁到 `.../<origin>/device`；deviceId 由客户端生成并持久，
  **登录/登出不轮换身份**。注销本设备走 `DELETE /api/v1/devices/self`，服务端删除设备行连同其全部令牌（释放每账号 256 的额度），
  重新登录会复用同一 deviceId。
- **`role` 只存在于连接上**：它不再是配置项（schema/UI/端点已移除，`config.ts` 为兼容旧 profile 仍接受并忽略）。
  服务端 peer 键是 `account + deviceId + role`，同一身份可同时持有两条连接；只有 client 连接能发起 `connect.request`；
  关闭控制时只拒绝 `role=host` 的 hello。**删掉这些就无法区分同一设备的两条连接**。
- **"能否被控制"只看控制开关**：设备列表返回账号内所有未吊销设备（不按角色过滤），每项带 `online` 与 `hostControl`。
  关闭控制 = 向服务端登记标志 + 立即断开 host 连接 + 服务端拒绝其新的 host hello（`CONTROL_DISABLED`）；
  **不清授权、不轮换身份、不影响它作为客户端去控制别人**；重新打开即恢复。
- **并发与锁**：同机并行 Host 必须使用不同的 `DSH_HOME`（凭据有 `.refresh-lock`）。刷新锁只回收"已死持有者"
  （`owner.json` 里的 PID 不存在），**活着的持有者（含被挂起）永不抢占**。被顶替的一方（`CONNECTION_REPLACED`）
  进入待命并**每 5 分钟**重试（`reconnect.replacedRetryMs`，默认 300000），对方退出即接管——永久停止会让"赢家后来退出"变成永久离线。

## 2. 两种丧失，与"用户想要什么"的权威

- **链路事件与域事件是两种事实，不能合并**：一条链路同时承载远程会话、终端、文件预览、loopback 预览与 ACP，
  Codex 只是可选域。"主机用户关掉 Codex"**不得**表现为链路断开。
- Codex 可用性走 `codex.app.capability {available}`，Host 只陈述事实、只在真实翻转时发送；**判定权在 Client**：
  `available:false` 且正在看的会话属于该主机的 Codex 才走恢复阶梯；`available:true` **永远不是丧失**。
- **恢复是"用户此前提出的请求"**：权威是 `lastWorkspaceSelection`（+ `client-target.json` 的 `mode`）。
  `recoveryStillWanted()` 在每次尝试前后、以及每次恢复动作落地之后都要重新问一次；落地时发现用户已取消或另选工作区，
  必须**丢弃结果并回到本地**（`abandonRecovery` → `setMode('local')`）。

## 3. 恢复阶梯（客户端）

- 真正的断链信号只有两个：Server 通知链路已丢（对端离线/被顶替/协议失败），以及我们自己的写入吃 RST（约在 Server 判超时后 1 秒）。
- **快速窗口**：10 秒内至多 2 次，两次都**强制 relay**（实测 relay 建链 2–3 秒，direct 协商单独要 12 秒），
  期间**不切视图 / 不刷新工作区 / 不重载**；成功后只刷新会话数据并重新发布工作区选择。
- 窗口耗尽才回退本地，由重试日程接管（**5、10、20、30、30、30、30 秒，7 次后停止**），走完即放弃并收起"重连中"。
- 恢复只还原**同一个会话**（设备 + 工作区种类 + 目录）；Codex 工作区的身份是**目录**而不是 id。
- **业务路径探测已整体删除**：它排在会话自身流量之后，Host 推大历史时被误判为"没有应答"，形成自激循环。

## 4. 登录与登出（2026-10-29 起，覆盖 2026-10-14 的旧决定）

- **DSH 与 Remote 双向绑定**：插件登录 → DSH 登录；插件登出 → DSH 登出；DSH 登录 → 插件自动授权；DSH 登出 → 插件登出。
- 允许**借用 DSH 的 DeepSeek 会话自动授权**，并允许 Server 为没见过的平台身份**建号**。
  已知代价：若某台机器登录的是另一个 DeepSeek 账号，Server 会为它新建账号并注册设备（2026-10-14「空账号」的成因），
  **不做兜底**。账号仍按 `deepseek:<平台 id>` 命中，不信任插件自称身份。
- **自动登出只清本机凭证**（`logout({ releaseDeepSeek: false })`），**绝不用自动路径登出 DSH**——否则一次瞬时读空就会
  把用户登出，并与用户的登录互相打架。**只有用户点登出**才释放 DSH。
- **未登录不是错误**：`devices()` 在本地凭证不可用时抛 `AUTH_REQUIRED`（不返回空数组）；面板静默处理，只显示登录按钮。
- 触发点只有"面板读设置/打开卡片"和"点刷新"：**没有后台自检、没有常驻轮询**。打开卡片时会等待"本地那一半"对账完成，
  所以 DSH 登出在打开时立刻可见；联网授权在后台进行，面板在打开动作内最多等 10 秒读取设备。

## 5. 数据面与 allowlist

- Harness v0.1.1 rc.2 只用官方 `ApiProxy`；v0.1.2 alpha.1–rc.1 与 v0.1.5 rc.1 / v0.1.6 alpha.1 Session V3 只用官方 `TypertGateway`。
  原生侧栏用 `workspaceFiles` / `officeToPdf` / `terminal` 固定 allowlist；**禁止**新增 session/agent/workspace/permission adapter、
  第二套 wire format、通用文件系统协议。
- Codex 是现有插件内的独立域（`packages/plugin/src/codex/`），**默认关闭**；远端只允许编译期固定 App Server allowlist；
  `project/create` 只能注册 Host 上已存在的绝对目录（`realpath` 校验），禁止推测共同父目录或越界接受客户端自报路径。
- 插件**不监听公网端口**，只建立出站连接；loopback 预览只连 `127.0.0.1` 白名单端口。
- **包装/转发 DSH 网关方法时必须 `...rest` 原样透传**，不得按已知签名重建参数（rc.2 给 dispatcher 加了第 4 个 `peer` 参数，
  少传会让每个调用抛 TypeError、页面只剩骨架）。升级 DSH 时用发布版 rc 做一次"装插件 / 不装插件"的 A/B 渲染对照。

## 6. 日志与隐私

- **Token、私钥、主机匹配码、prompt、源码、工具输出不得写日志**。Server 日志一行一条 JSON、自动轮转、总量有界，
  只写标识符与结果码（`peer.online/offline`、`link.*`）。
- 插件侧的诊断日志只输出布尔与错误码（例如 `[dsh-remote] reconcile {"hasSession":…,"authorized":…}`）。

## 7. 平台细节

- **Windows 原子替换会偶发 `EPERM`**（目标文件被外部句柄以不含 `FILE_SHARE_DELETE` 打开）：所有状态文件统一走
  `src/atomic-file.ts` 的 `replaceFile`（退避重试）与 `sweepStaleTemporaries`。重试不能替代并发模型——两个实例共用
  `DSH_HOME` 仍会在读-改-写上竞争。
- **Server 心跳阈值必须 ≥ 2 × tick**（当前 tick 20 s / 阈值 45 s，丢弃窗口 40–65 s），不满足时构造 Gateway 直接启动失败。
- **端口**：Windows 有保留 TCP 区间，命中会 `EACCES`。测前先试绑定，或用 `DSH_REMOTE_E2E_*_PORT` 指定空闲端口。
- 测试不得假设 POSIX 分隔符、点号即隐藏、或可无特权创建 symlink。

## 8. 测试与发布政策

- **非核心功能不写测试**：测试预算只给协议编解码/schema、身份与加密、授权与握手、RPC 关联与 fail-closed、
  传输 fallback/reconnect 等核心状态机；纯展示 UI、文案、样式不单独加测试。
- 发布三条硬规则、五处版本号一致、2FA 的 OTP 见[release.md](release.md)；
  日常构建/测试/运维命令见[development.md](development.md)。

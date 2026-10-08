# 配置与设备身份契约

面向两类读者：把本插件内置进发行版、在 profile 的 `cordis.patch.yml` 里 seed 条目的**集成者**，
以及排查"这台设备为什么是这个 ID / 为什么它不接受控制"的**维护者**。按需阅读，不必每次会话都加载。

每条结论都给了代码位置，便于复现而不是重新推理。

## 一句话结论

**一台设备只有一份身份，`role` 不再是配置项。** 设备能否被远程控制，由"允许控制当前设备"这个
**开关**决定（标志存在服务端、跨重启保留），与身份无关；`host` / `client` 只是**连接**的属性，
同一份身份可以同时持有两种连接。

## 设备身份

- **一份身份**：`<DSH_HOME>/remote/servers/<sha256(origin)[0:24]>/device/`，内含 `device.json`
  （deviceId、名称、公钥）、`device.key` 与 `server-credentials.json`（`identity-store.ts` 的
  `ensureDeviceDirectory()`）。
- **deviceId 由客户端生成并持久保存**（ULID），服务端只照收、不派生、不改写；一条设备行由
  **deviceId 唯一确定**。
- **ID 终身不变**：登出/登录不轮换身份，被吊销后重新登录也**复用同一个 ID**（`store.register()`
  按 deviceId 写回同一行）。只有用户显式重置身份才会产生新 ID。
- **迁移**：旧布局是**按角色**的两份身份（`.../host`、`.../client`）。首次运行会把 `host` 那份
  （服务端已有对应设备行、凭据一并带上）整目录复制到 `device/`，没有 `host` 时退回 `client`；
  **旧目录原样保留**作为备份，不删任何用户数据。
- **可观测性**：设备行只存 `lastSeenAt` 与 `revoked`。要判断身份年龄可解码 deviceId 的 ULID 前缀
  （前 10 个字符即创建毫秒）；`lastSeenAt` 对 client 行可能长期为 0，**不能**只按它判断在线。

## `role` 的现状

- **不再是配置项**：`Config` / `ResolvedConfig` / 两套 schema（含曾经的死值 `both`）里都已移除；
  `settings.role.set` 端点已删除，面板不再提供角色选择。
- **只是连接的属性**：`hello` 里声明的角色决定这条连接是 host 还是 client（`gateway.ts` 的 peer 键为
  `account + deviceId + role`）。同一份身份可以同时持有 host 与 client 两条连接，互不顶替；
  存储角色与 hello 角色不再要求相等（只校验 deviceId 与凭据匹配）。
- **注册描述符固定声明 `host`**：设备列表里它就是"可被控制的设备"，是否真的接受控制由下面的开关决定。
- **`authorizeHostAsOwned` / `register-owned-role` 保留但通常不再触发**：单一身份下，登录注册出的行
  本身就是 host 行；`authorizeHostByDefault()` 只在尚未授权时补齐。

## 允许控制设备（语义 A）

- **开**：设备向服务端登记标志并**恢复 host 连接**；账号登录、身份、client 半边始终不动。
- **关**：设备向服务端登记标志、**立即断开当前 host 连接**，服务端此后**拒绝**该设备的 `role=host`
  hello（错误码 `CONTROL_DISABLED`）；**不会**清除授权、**不会**轮换身份、**不会**影响它作为客户端
  去控制别的设备。
- **跨重启保留**：标志存在服务端设备行上（`store.setHostControl()`；旧状态文件按 `true` 读取）；
  重新登录**不会**悄悄打开它（`store.register()` 保留既有值）。
- **可见**：设备描述符带 `hostControl`；`online` 只反映实际连接，因此关掉控制后该设备显示为离线。
- 端点：`POST /api/v1/devices/self/control`，body `{ enabled: boolean }`。

## 注销设备（吊销）

- **删行**，不是标记：`DELETE /api/v1/devices/self` → `store.revoke()` 删除设备行**连同它的全部令牌**
  → 立即断权（不必等下次登录），并且**释放 256 设备额度**。
- **重新登录即可回来，且是同一个 ID**：注册需要账号会话或注册码，从不只凭设备令牌；由于 deviceId 由
  客户端提供，重新注册写回同一行（不同身份密钥冒用同一 ID 仍被拒绝）。
- 代价（有意接受）：服务端**不再保留"曾被吊销"的记录**，所以被吊销的设备在重新登录前会得到
  `AUTH_INVALID` 而非 `DEVICE_REVOKED`；客户端把前者当作"凭据失效 → 重新登录"。

## 写回行为

- **只在控制端点里写**，没有启动期写入：`settings.replace(...)` 全部位于 `control-runtime.ts` 的端点
  处理器中；激活路径只有读。
- **`settings.configure` 不再写 `role`**：它只写 `serverUrl` 与 `editableConfig()` 归一化的其余字段。
  授权走哪条 API 由"是否提供了注册码"决定（有注册码 → `HostServerApi`，否则 `ClientServerApi`）。
- **没有 `DSH_HOME` 之外的存储**：状态全在 `DSH_HOME` 下；外部输入只有 `DSH_REMOTE_SERVER`
  （`config.ts`）。同机多份 home 互不影响。
- 写入粒度是**整节**而非差异，但每次写入前都先 `resolveConfig(settings.get())` 读回当前值，
  所以**手工编辑的字段会被保留**，除了这次调用明确要设的字段。
- 发行版 seed 的默认值现在更安全：不再有"点一次登录就被改写"的 `role`。

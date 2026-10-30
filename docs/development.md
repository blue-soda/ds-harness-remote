# 开发、构建、测试与运维

这份文档面向**第一次接触本仓库的人或 agent**：只 clone 仓库、只读文档区，就能把项目跑起来、改得动、测得通、发得出去。

- 产品是什么、支持哪些客户端：见[根 README](../README.md)（[中文](../README.zh.md)）
- 协议权威：见[protocol.md](protocol.md)；Server 设计：见[server.md](server.md)
- 为什么这样设计（不变量与历史决定）：见[decisions.md](decisions.md)
- 发布与版本号规则：见[release.md](release.md)

## 1. 仓库结构

```text
apps/
  android/      React Native/Expo Android 客户端（账号授权 + ApiProxy/Typert/CodeX Remote）
  vscode/       VS Code 扩展客户端
  browser/      Chrome/Edge MV3 轻量入口（换凭证 + 打开在线 Host）
  server/       开源自部署 Server（多账号 Relay、登录/设备页、Docker 部署）
packages/
  plugin/       核心：Host runtime + Remote 面板 + 原生能力代理（构建产物 dist/ 必须提交）
  protocol/     线协议类型与校验
  crypto/       X25519、HKDF、ChaCha20-Poly1305、Noise IK
  webrtc/       LAN/P2P/TURN/Relay 传输
  client-core/  RPC 关联与事件分发
examples/
  mock-host/    外部 Server 互操作工具
scripts/        安装、校验、端到端测试等脚本（全部在 git 内）
docs/           文档区（本文件、协议、设计、排查记录等）
```

根 `package.json` **故意不声明 scripts**：它是 DSH Desktop 的 GitHub 安装边界，声明 scripts 会让 pnpm 误判需要构建。
根 `index.js`、`packages/plugin/dist/index.js`、`packages/plugin/dist/client.github.js`、`packages/plugin/bin/ds-harness-remote.js`
**必须提交**（GitHub 默认禁用构建脚本，安装时直接用这些产物）。

## 2. 环境与依赖

- Node.js **22+**（本机用 24 也可）、**pnpm 9.15.4**
- Android 开发另需 Android Studio、Android SDK、JDK
- Windows 安装脚本会把独立 Node/pnpm/DSH 放到 `%LOCALAPPDATA%\dsh-remote`（`DSH_INSTALL_DIR` 可覆盖）

```bash
pnpm install
pnpm --filter './packages/**' -r build     # 先构建共享包，resh clone 也能解析 dist 类型
```

## 3. 构建

```bash
pnpm -r build                              # 全仓
pnpm -r check                              # 类型检查（不产出）
NODE_ENV=production pnpm -r build          # 发布用构建
pnpm --filter @blue-soda/dsh-remote build  # 只构建插件（产出 packages/plugin/dist）
pnpm --filter @blue-soda/dsh-remote build --watch
pnpm --filter @dsh-remote/server build     # Server（tsc + Web 资源）
```

插件改动后要重新提交 `packages/plugin/dist/`（见上）。

## 4. 测试

```bash
pnpm -r test                               # 全仓单元/集成测试
npx vitest run --root packages/plugin      # 只跑插件（当前 47 文件 / 407 用例）
pnpm --filter @dsh-remote/server test
node scripts/verify-dsh-plugin.mjs         # 校验插件清单、版本号五处一致、bundle 边界
node packages/plugin/scripts/verify-version-sync.mjs
```

已知环境相关抖动：`tests/werift-rtc.test.ts` 的 `lan`/`p2p` 断言取决于本机网卡与防火墙；
以连跑两次结果一致为准，不要当成产品缺陷。

### 端到端矩阵（`scripts/remote-e2e.mts`）

起一台 headless Host 与一台 headless Client，通过插件自己的 loopback 控制协议拨动开关，断言客户端状态机与日志。
**不覆盖界面渲染**（顶部文案、页面重载时机仍需人工确认）。

```bash
node --import tsx/esm scripts/remote-e2e.mts --list        # 权威场景清单（fast/slow 标注）
node --import tsx/esm scripts/remote-e2e.mts --fast        # 快速一半
node --import tsx/esm scripts/remote-e2e.mts               # 完整矩阵（当前 22 场景 / 141 断言，约 18 分钟）
node --import tsx/esm scripts/remote-e2e.mts --login-host  # 一次性授权 headless Host（打印 URL 并等待）
node --import tsx/esm scripts/remote-e2e.mts --against=<id|name> browse-codex   # 不拨开关的场景
```

约定与坑：

- home：Host 默认 `C:\Workspace\.dsh-remote-e2e\host`、Client 默认 `C:\Workspace\.dsh-remote-client`（`DSH_REMOTE_E2E_HOST/CLIENT` 覆盖），
  **Identity 与授权持久保存**，所以只需一次性授权；
- 端口：脚本默认 63731/63721，本机这些端口落在 Windows 保留区间时会 `EACCES` —— 用
  `DSH_REMOTE_E2E_HOST_PORT` / `DSH_REMOTE_E2E_CLIENT_PORT` 改到空闲端口（如 61000/61001）；
- **Host 启动到上线可能很慢**（本机实测约 4 分钟，Codex 域与账号探测占主要时间）；预检已放宽到 6 分钟，
  超时会打印一次性授权 URL —— 那说明 Host **没被授权**，不是产品故障；
- 结果三类：断言失败 / 场景抛错是产品问题；`environment-limited` 归因于本机到 Server 的链路或 Codex 前置条件；
- Client 每次从**本地 shell** 起跑（否则记忆的上次目标会和开机恢复赛跑，结果不可复现）；
- 冻结用 `NtSuspendProcess` 制造"对端静默"，拨开关是干净断开，两者不同。

## 5. 运维

### 5.1 安装 / 卸载（终端用户）

```bash
# Windows（管理员交互式账户提示）
scripts\install.ps1
scripts\uninstall.ps1
# Linux/macOS
sh scripts/install.sh
sh scripts/uninstall.sh
```

Windows 用 WinSW 注册当前用户的服务；卸载保留 profile 与凭证。

### 5.2 DSH 插件

```bash
node packages/plugin/bin/ds-harness-remote.js   # CLI 入口
# dsh-TUI 内：/remote login | status | logout
```

插件安装方式与版本要求见[安装指南](installation.zh.md)、[dsh-TUI 指南](dsh-tui.md)。

### 5.3 自部署 Server

```bash
pnpm --filter @dsh-remote/protocol build
pnpm --filter @dsh-remote/server build
node apps/server/dist/main.js          # 或 systemd 服务 / Docker Compose
```

配置见 `apps/server/README.zh.md` 与 `apps/server/.env`（**不得提交**）。关键环境变量：
`DSH_SERVER_DEEPSEEK_LOGIN=on`、`DSH_SERVER_PASSWORD_LOGIN`、`DSH_SERVER_DEEPSEEK_CREATES_ACCOUNTS`、
`DSH_SERVER_RATE_API|LOGIN|DEEPSEEK|REGISTER|OAUTH`（每 IP 每 60 秒）、
`DSH_SERVER_HEARTBEAT_INTERVAL_MS`（默认 20000）、`DSH_SERVER_PEER_TIMEOUT_MS`（默认 45000，**必须 ≥ 2×interval**，否则启动即失败）、
`DSH_SERVER_LOG_FILE` / `DSH_SERVER_LOG_MAX_BYTES` / `DSH_SERVER_LOG_FILES`。

运维要点（血泪教训）：

- **部署极易落后**：先 `git log -1` 确认提交，再构建、再重启；构建失败不要重启。核对
  `grep -c DSH_SERVER_RATE_ apps/server/dist/server.js` 是否为 1，否则跑的还是旧代码；
- 若远端 checkout 的 `origin` 指向上游仓库，`git pull --ff-only` 会**静默失败**——用正确的远端（如 `fork`）；
- 状态文件 `/var/lib/ds-harness-remote/state.json`，删设备行前**停服务 + 备份**；只删白名单外的设备行与其令牌；
- 日志 `/var/lib/ds-harness-remote/logs/server.log`（一行一条 JSON，自动轮转、总量有界）；
  只记标识符与结果码，**不写令牌、私钥、握手字节**；
- 设备行清理要按**设备族**判断：同批次只要有一行在线就全部保留，否则会误删正在使用的设备。

## 6. 发布

见[release.md](release.md)。三条硬规则：`break-hard-links.mjs` → `cd packages/plugin && npm publish --access public` →
2FA 需要 OTP。版本号**五处**必须一致（根与包的 `package.json`、两个 `dsh-plugin.json`、`src/version.ts`）。

## 7. 当前验证基线（2026-10-30）

- `pnpm -r check`、`node scripts/verify-dsh-plugin.mjs` 通过；`git diff --check` 干净
- 插件单测 **407 通过 / 47 文件**；Protocol 234/7、Server 49/5、Android 307、WebRTC 62、Client Core 39、VS Code 13、Browser 1、Crypto 7
- 端到端矩阵 **22 场景 / 141 断言全绿**（`scripts/remote-e2e.mts`，1071 秒，含 `slow` 场景）
- 已知环境相关抖动：`tests/werift-rtc.test.ts`（网卡/防火墙），以连跑两次一致为准
- 历史记录（当时的构建与实机结论）见[验证历史](validation-history.md)

## 8. 改代码前的必读

[decisions.md](decisions.md) 记录了不变量（设备身份、`role` 只在连接上、控制开关语义、恢复阶梯、登录/登出绑定、
allowlist、日志禁写内容等）。改动这些行为前先读它；`docs/incidents/` 有历史排查过程。

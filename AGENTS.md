# Repository Guide for Agents

本文件面向在当前仓库工作的编码 Agent，记录仓库边界、项目结构、实现状态、验证命令和协作约束。用户产品说明与 Plugin 使用方式见 `README.md`。

## Repository Boundary

当前仓库实现：

- DeepSeek Harness Plugin（Remote Host + 本地 Remote 工作区入口 + dsh-TUI `/remote` 管理命令；无用户可见的 Client 模式）
- Android Client（账号授权 + Adaptive transport + rc.2 ApiProxy / v0.1.2 alpha.1–rc.1 / v0.1.5 rc.1 与 v0.1.6 alpha.1 Session V3 Typert Remote + 可选 CodeX Remote）
- VS Code Client（账号授权 + Host 信任固定 + rc.2 ApiProxy / v0.1.2 alpha.1–rc.1 / v0.1.5 rc.1 与 v0.1.6 alpha.1 Session V3 Typert Remote 会话/Prompt）
- Protocol、Crypto、WebRTC、Client Core 等共享能力
- 开源自部署 Server（`apps/server`）：多账号 JSON 文件持久化（设备与令牌按账号隔离）、注册默认关闭、Control/Noise handshake forwarding/opaque Relay、Web 登录与设备状态页，以及 Dockerfile/Compose 部署入口
- 依赖外部 Server 的 Mock Host/Smoke Client
- Server 设计与跨仓库协议契约

当前仓库禁止实现：

- 完整多账号 Server、Remote Web 会话界面、Admin backend/frontend
- 完整 Server 的数据库、migration、queue 及 Kubernetes、Terraform 等部署基础设施
- `apps/server-web`、`apps/web` 等完整 Server 站点源码

本仓库包含可独立部署的开源 Server，允许在 `apps/server` 内维护上述最小版本的 runtime、文件持久化、限流、Web 页面和 Docker 部署；按用户 2026-10-06 授权，该最小版本扩展为**多账号 + 微信 OAuth 登录入口**，范围声明已随之更新。完整站点（Remote Web 会话界面与 Admin backend/frontend）仍由独立 Server 仓库作为同一站点实现。本仓库必须保留 `docs/server.md` 和 `docs/protocol.md`；不得把完整 Server 的设计目标描述成开源自部署版本已实现的能力。

## Project Structure

```text
apps/
  android/             React Native / Expo Android Client（账号授权 + ApiProxy/Typert/CodeX Remote tunnel）
  vscode/              VS Code Extension Client（Host 列表、加密连接与远程会话）
  browser/             Chrome/Edge MV3 入口（Web 授权换取独立凭证 + 在线 Host + 打开 Remote Web）
  server/              开源自部署 Server（多账号 Relay、登录/设备状态页、Docker 部署）
packages/
  plugin/              Host runtime、Remote 工作区入口与原生 API 代理
  protocol/            Remote/Control frame 类型和运行时校验
  crypto/              X25519、HKDF、ChaCha20-Poly1305 与 Noise IK
  webrtc/              Relay、WebRTC、LAN transport 抽象
  client-core/         RPC correlation 与 Remote event 分发
examples/
  mock-host/           外部 Server 互操作工具
docs/
  design/              产品与功能设计
  plugin-integration.md Host 账号登录、授权注册与凭证接入契约
  protocol.md          Host/Server/Client 权威线协议
  server.md            完整 Server 设计与互操作契约、自部署版本范围入口
```

仓库根包同时是 DSH Desktop 的 GitHub 安装边界：根 `package.json` 必须保留
`dsh.bundle.patch`、Host/Client exports、CLI bin 和 `cordis.patch.yml`；GitHub 默认禁用
构建脚本，所以根 `index.js`、`packages/plugin/dist/index.js`、`client.github.js` 与
`packages/plugin/bin/ds-harness-remote.js` 是需要提交的发布入口。

**发布名与上游归属（2026-10-06）**：本仓库是 `liguobao/ds-harness-remote` 的 fork（MIT），
npm 上的 `ds-harness-remote` 属于上游作者，因此**本 fork 以 `@blue-soda/dsh-remote` 发布**。
发布入口是包目录内的 `npm publish`（`npm publish -w packages/plugin` **不可用**：npm 不读
pnpm workspace，会报 `No workspaces found`）：

```bash
cd packages/plugin && npm publish --access public
```

改名只涉及**包名与解析入口**：根与包的 `package.json`、两个 `cordis.patch.yml` 的 `name:`、
客户端 module id（`scripts/build-bundles.mjs` 与 `src/client.ts` 兜底）、两个 `dsh-plugin.json`
的 `name` 与 `source.repository`、`scripts/verify-dsh-plugin.mjs` 的包名断言。**保持不变**：
Cordis 实例 `id:`、插件导出的 `name`、设置命名空间 `ds-harness-remote`/`dsh-remote`、控制路由
`/ds-harness-remote`、CLI bin 名、`dsh-plugin.json` 的 `id` —— 因此设备授权与设置**不迁移**。
profile 迁移 = 依赖键 + `package.json` 的 `dsh.profile.bundles` 条目改新名（`cordis.patch.yml`
只按 `id` 覆盖配置，无需改）。`publishConfig` 已移除 `provenance`（本地发布无法生成 ✓），
如需 provenance 请改由 GitHub Actions 发布。上游引用**故意保留**：`docs/design/` 的上游 issue 与
`.github/release-notes.md` 中致谢的上游 PR。

**发布前必须断开硬链接**：pnpm 会让包文件与 profile 里的安装副本共享 inode，npm 打包时按 inode
去重并生成 tar 硬链接条目，而 registry 直接拒收：

```
npm error 415 Unsupported Media Type - Hard link is not allowed
```

所以 `npm publish` **之前**执行一次（重写被发布文件、各占独立 inode，内容不变）：

```bash
node scripts/break-hard-links.mjs packages/plugin
```

脚本按包的 `files` 列表遍历，成功时输出 `0 still shared`。任何重新构建或 profile 安装之后都
建议再跑一次。另注意 npm **不理解 pnpm workspace**：`npm publish -w packages/plugin` 会报
`No workspaces found`，必须进入包目录发布。

**发版清单**（`verify-version-sync.mjs` 要求**三处版本号一致**：根 `package.json`、
`packages/plugin/package.json`、`packages/plugin/src/version.ts`）：

```bash
# 1) 三处改成同一个新版本号
# 2) 构建：会校验版本一致并重新生成两个 client bundle
pnpm --filter @blue-soda/dsh-remote build
# 3) 校验 DSH bundle 契约（包名、bin、exports、patch id、客户端 module id）
node scripts/verify-dsh-plugin.mjs
# 4) 断开硬链接（否则 registry 以 415 拒收）
node scripts/break-hard-links.mjs packages/plugin
# 5) 发布（必须进包目录；scoped 包需要 --access public）
cd packages/plugin && npm publish --access public
# 6) 打 tag 并推送（推送目标是 fork 与自建 Server 的镜像）
git tag -f -a vX.Y.Z -m "ds-harness-remote X.Y.Z" && git push -f fork vX.Y.Z && git push fork main
# 7) 核对（registry 传播有几秒延迟，404 时稍等再查）
npm view @blue-soda/dsh-remote version
```

首次发布的实测记录（2026-10-06）：`@blue-soda/dsh-remote@0.4.28` ✓；期间依次遇到
E403（账号未开 2FA + `.npmrc` 里残留旧 `_authToken`，用 `npm logout` 清除并开启 2FA 后解决）
与 E415（硬链接，用上面的脚本解决）。

第二次发布记录（2026-10-06，`0.4.29`）：

- **EOTP**：开启 2FA 后，非交互式发布会在**最后一步**要求一次性密码 ✗，npm 会打印一个
  `https://www.npmjs.com/auth/cli/...` 的浏览器授权链接 ✓。该链接**只能由人工在浏览器完成** ✗
  （它的 URL 内含凭据，会被日志/工具输出屏蔽 ✓），所以发布必须由人执行，或由人提供 6 位码后用
  `npm publish --access public --otp=<码>` ✓。EOTP 发生在真正上传之前 ✓，因此失败不会留下半成品 ✓
  （可用 `npm view @blue-soda/dsh-remote version` 确认仍是旧版本 ✓）。
- **npm 会改写 `bin`**：`"ds-harness-remote": "./bin/ds-harness-remote.js"` 会在发布时被归一化为
  去掉 `./` 的写法 ✓ 并把结果**写回 `package.json`** ✓，同时打印一条 "auto-corrected … was
  invalid and removed" 警告 ✗。**该警告是虚惊** ✓：registry 元数据与实装测试（把打包结果
  `npm install -g --prefix <临时目录>` ✓ 后 `ds-harness-remote.cmd` 存在 ✓）都证明 CLI 正常 ✓。
  现已采纳 npm 的写法，`scripts/verify-dsh-plugin.mjs` 对**npm 包**断言归一化路径 ✓
  （根包不发布，保留显式路径 ✓）。
- **发布前必须先断硬链接** ✓（见上节 ✓），且重新构建/安装 profile 之后要再跑一次 ✓。

空的 Web/UI 预留目录不应创建。Expo 生成的 `.expo/web` cache、`.webp` 图片格式和 `packages/webrtc` 不属于 Remote Web 项目。

## Current Status

| 模块 | 状态 | 主要剩余工作 |
| --- | --- | --- |
| Plugin Host | 账号密码/主机匹配码接入、dsh-TUI 无 browser connection 时默认开启 Host、GitHub/知乎二维码授权与可点击 URL、原生 `/remote` login/status/logout 与 Tab 补全、同账号 peer 校验、隔离身份/凭证、Relay/Noise IK、并发 Client 与按连接隔离的 rc.2 ApiProxy / v0.1.2 alpha.1–rc.1 Typert Remote allowlist bridge 已实现；v0.1.5 rc.1 Session V3 与 v0.1.6 alpha.1 支持已接入，并已在独立 `dsh-v0.1.6-alpha.1` 实例上验证 Web → Host 主链路；真实 Desktop/dsh-TUI 跨机 E2E 已验证；无自定义 Harness 业务适配层 | v0.1.5/v0.1.6 跨机 E2E、legacy owner 恢复体验、allowlist 覆盖审计、跨平台 picker 边界 |
| Plugin Remote Client | 与 Host runtime 同时启动，无需 Client 模式；Remote 模态框支持 GitHub/知乎扫码与账号密码登录、本机过滤、主机/版本信息、已有 Harness/CodeX Workspace、远端目录浏览与 CodeX Project 注册、ApiProxy/Typert 图片 Prompt/回显，以及配合 dsh-file-viewer 的受限只读文件预览，随后复用原生 Harness UI；加密通道 capability 探测保留 legacy Host 降级并拒绝 ApiProxy/Typert 混连；Web → Host 主链路已在 v0.1.5 rc.1 与 v0.1.6 alpha.1 上验证 | CodeX Project 新建跨设备 E2E、断线重连恢复、页面级导航接口、长期稳定性 |
| Android | 已迁移到 rc.2 ApiProxy / v0.1.2 Typert Remote 双数据面，并直接接入可选 `codex.app.*`：账号登录注册、成员设备列表与 identity key 固定、Adaptive transport + Noise、capability 探测、Harness/CodeX Workspace 与 Session、远端目录选择与 CodeX Project 注册、工作区收藏与首页快捷链接（点击直达该工作区最近会话）、分页 History/live frame、模型/权限、文字/图片 Prompt、interrupt 与审批，以及跟随系统/英文/简体中文界面；启动固定进入设备列表，`resolveAutoConnectDevice` 自动连接逻辑保留但不触发；rc.2/v0.1.2/CodeX 真机跨机 E2E、图片分块、重连和 WebRTC 已验证 | CodeX Project 新建跨设备 E2E、协议 conformance fixtures、长期稳定性与跨设备回归 |
| VS Code | Extension 基础已实现：SecretStorage 身份/凭证、账号/扫码登录、Host 指纹固定、Adaptive transport + Noise、rc.2 ApiProxy / v0.1.2 Typert Remote Host→Workspace→Session 导航、Prompt、permission command 与编辑区会话面板 | Extension Host 跨机 E2E、实时流式更新、question 界面与重连恢复 |
| Browser | Chrome/Edge MV3 轻量入口已实现：临时读取已登录 Web 的授权并换取隔离的 device credential，popup 展示在线 Host，点击后直接打开同源 Remote Web；不承载账号登录、Remote transport、ApiProxy 或会话 UI；unpacked 联调与 Web 授权跳转、独立 Server 合约联调已验证 | 随独立 Server 合约变化同步 |
| Protocol | Control/Relay 与 ApiProxy tunnel 基础已实现 | 完整 Zod schema、limits、golden vectors |
| Crypto | 基础原语、标准 Noise IK 与确定性 golden vector 已实现 | 第三方实现审查、rekey、跨端执行 golden vector |
| Relay Transport | Protocol v1 control/relay 已实现 | 心跳、限制协商、断线状态传播 |
| WebRTC | signaling、ICE、TURN、LAN/P2P/Relay 自适应路径基础已实现，Android 真机与 Host werift 互操作已验证 | 网络切换恢复和长期稳定性 |
| Client Core | ApiProxy tunnel RPC/Event 关联基础已实现 | reconnect、pending call/stream 恢复 |
| Codex Remote 领域 | 作为现有 Remote Plugin 内部可选领域：Host stdio App Server、默认开启且可在设置中关闭、固定 allowlist 与连接隔离已实现；Desktop 以 rc.2 ApiProxy / v0.1.2 Typert 内存载体复用 DSH 原生 UI，Android 直接消费同一 `codex.app.*` 并复用移动端 Workspace/Session/Chat；两端可通过受限 `project/create` 将 Host 上已存在的真实目录注册为 Project，并都只保留内存展示投影；既有 Desktop 与 Android 真机 E2E、大 History、断线恢复和多 Client 观察已验证 | Project 新建跨设备 E2E、长期稳定性、跨版本回归和安全审查 |
| Mock Host | 旧 Android Remote RPC 联调工具，当前冻结 | 若恢复 Android 再迁移或替换 |
| Desktop | Host 设置、Remote 工作区模态框、远程 Header、连接链路与加密状态已接入 Harness Web UI，Host status 由 loopback SSE 推送（无固定间隔的 status 轮询），原生窗口跨机 E2E 已验证 | 多窗口、休眠/唤醒和代理网络回归 |
| 开源自部署 Server | `apps/server` 已实现多账号授权、设备凭据持久化与刷新、Control/Noise 握手转发和加密 Relay、Web 登录与设备状态页；账号间设备与令牌完全隔离，注册默认关闭（需显式配置注册码）；QR OAuth 端点已实现（`auto`/`github`/`wechat`/`mock`/`off`，账户密钥只存服务端）；**DeepSeek 账号登录已实现**（`DSH_SERVER_DEEPSEEK_LOGIN=on`，服务端自行向平台核对 grant 后即弃、不落盘，绑定键为平台稳定账号 ID，故同一 DeepSeek 用户必落同一账号；平台 WAF 强制要求浏览器 UA）；`DSH_SERVER_PASSWORD_LOGIN=off` 可关闭密码登录；建号默认关闭；provider 请求带硬超时且失败会将会话标记过期；提供 Dockerfile/Compose；单进程、Relay-only，不提供 Remote Web 会话界面或 WebRTC/TURN。大陆部署需解决 `github.com` 出网：GeoDNS 给大陆返回的亚洲节点不可达，文档给出的 `/etc/hosts` 钉定实测**间歇可用**（同一 IP 曾 20/20 成功、随后 0/12 全败），可靠方案是境外部署或出站代理 | 出站代理或境外部署下的 GitHub 扫码验收、真实微信凭据与备案域名验收、账号自助注册与扫码登录的 Web 页面、Docker 实际构建与启动验证、真实 Desktop/Android/VS Code 跨机 E2E、反向代理长期连接回归 |
| 完整 Server/Remote Web/Admin | 独立 Server 仓库已有实现，REST、Control WebSocket、Relay、Signaling 与 conformance fixture 跨仓库联调已完成 | 完整站点 runtime 变更在独立 Server 仓库完成，并同步跨仓库契约 |

完整任务和优先级以 `TODO.md` 为准。不得把 TODO 中的目标能力描述成已经完成。

## Development

环境：Node.js 22、pnpm 9.15.4。Android 原生开发还需要 Android Studio、Android SDK 和 JDK。

```bash
pnpm install
pnpm --filter './packages/**' -r build
pnpm -r check
node scripts/verify-dsh-plugin.mjs
pnpm -r test
NODE_ENV=production pnpm -r build
```

先构建 `packages/**`，确保 workspace package 从 fresh clone 开始也能解析 `dist` 类型。根 `package.json` 刻意不声明 `scripts`，避免 pnpm 将 DSH Desktop 的 GitHub 安装误判为需要执行构建脚本。

常用命令：

```bash
pnpm --filter @dsh-remote/plugin build --watch
pnpm --filter @dsh-remote/android android
pnpm --filter @dsh-remote/android start
DSH_REMOTE_SERVER=ws://127.0.0.1:8080/ws/v1/connect pnpm --filter @dsh-remote/mock-host dev
```

针对真实 Codex App Server 的只读 smoke（需要本机 Codex 可执行文件路径，验证 `codex.app.call`
allowlist、Workspace authority 与历史读取在已安装版本上是否成立）：

```bash
node --import tsx/esm scripts/codex-app-server-smoke.mts "<path-to-codex.exe>"
```

Android 不能使用 Expo Go，因为 `react-native-webrtc` 依赖原生模块。

开源自部署 Server 的独立验证命令：

```bash
pnpm --filter @dsh-remote/protocol build
pnpm --filter @dsh-remote/server check
pnpm --filter @dsh-remote/server test
pnpm --filter @dsh-remote/server build
```

本地启动、环境变量与 Docker 部署见 `apps/server/README.md` 和 `apps/server/README.zh.md`。Server 设备凭据数据和 `.env` 不得提交。

Windows 自动安装脚本将独立 Node.js/pnpm/DSH 放在 `%LOCALAPPDATA%\dsh-remote`（可用
`DSH_INSTALL_DIR` 覆盖），用 WinSW `3.0.0-alpha.11` 交互式账户提示注册当前用户的服务；
安装和卸载需在安装所属账户的管理员 PowerShell 中执行，脚本只检查权限、不自动提权；
首次安装需 Windows 账户密码，禁止把密码写入 XML。服务与 CLI 共用固定 `DSH_HOME`，
卸载保留 profile 和凭证，不清理旧全局 npm 环境。Windows 实机回归尚待完成。

## Validation Baseline

截至 2026-09-16：

- workspace check 与 DSH bundle 校验通过
- Plugin test：28 个测试文件、228 个测试；Android test 通过：14 个测试文件、163 个测试。本机
  Windows 运行 `tests/codex-domain.test.ts` 有 3 个既有的路径分隔符/目录顺序平台假设失败，
  `tests/werift-rtc.test.ts` 的 `lan` 候选断言受本机 VPN/虚拟网卡候选池影响，两者均与
  Remote status 推送改动无关；完整 workspace 数量以当前 CI 输出为准
- workspace build 通过，包括 Android Hermes bundle
- 真实设备验证已覆盖 Web → Host、Desktop/dsh-TUI 跨机、Android Harness/CodeX、WebRTC、CodeX Desktop/Android E2E 与独立 Server 跨仓库联调
- 独立 `dsh-v0.1.6-alpha.1` 实例验证通过：Plugin 树加载、Host identity、Codex 域与 client bundle 下发正常，Web → Host 主链路可用；peer range 与构建/测试基线已升级到 `@deepseek-ai/dsh-*@0.1.6-alpha.1`
- `git diff --check` 通过

已知构建警告：Metro 对 `@noble/hashes/crypto.js` 使用 package exports fallback。该问题记录在 `TODO.md`，不得静默删除说明。

2026-09-20 开源自部署 Server 补充验证：check、11 个核心测试与生产 build 通过；构建产物本地启动后，健康检查、页面及静态资源、账号登录、Cookie 鉴权与未授权拒绝通过。Docker daemon 未运行，未验证镜像构建和容器启动；真实跨机与反向代理长期连接仍待验证。独立 Server 的既有联调结果不等于本版本已完成部署验收。

2026-10-06 Plugin 补充验证：`pnpm --filter ds-harness-remote build` 与 `pnpm -r check` 通过；
全量 Plugin 测试 **322 个**，其中 **6 个既有失败**（`tests/codex-domain.test.ts` 5 个 Windows
路径分隔符/目录顺序平台假设，`tests/werift-rtc.test.ts` 1 个 `lan` 候选断言受本机虚拟网卡
影响），**316 通过**；本轮新增 `tests/method-policy.test.ts`（6 个，覆盖 `codex.app.call`
allowlist 的上游字段、历史分页上限与 fail-closed 行为）、`tests/harness-api-history.test.ts`
（2 个，页大小钳制），并在 `tests/codex-virtual-harness.test.ts` 增加本地端点委派与载体历史
页钳制的断言。Codex App Server 版本探测基线为 **0.160.0**（`codex app-server
generate-json-schema` 产物用于逐字段对照），另有 `scripts/codex-app-server-smoke.mts` 在真实
0.160.0 上做只读端到端检查。真实跨机结论见下节"用户实测确认"。

## Implementation Rules

1. `docs/protocol.md` 是线协议权威来源。代码与文档冲突时，先按协议实现；必要的协议澄清必须同步更新文档和共享类型。
2. Plugin 不监听公网端口，只建立出站连接。
3. Remote business message 只能进入已认证的加密 channel；明文、未知 connection、错误 target、重放和 identity mismatch 必须 fail closed。
4. Server membership 与 Host 本地 trusted peer 必须同时成立。
5. v1 permission decision 只允许 `allow_once | deny`，禁止恢复 `allow_session`。
6. 按用户 2026-09-20 授权，支持官方原生文件树/只读预览、默认开启且可在详细 Remote 设置中关闭的 `terminal.enabled` 交互终端，以及 `loopback.ports` 明确授权的 HTTP/WebSocket 预览。文件通过官方 `workspaceFiles`/`officeToPdf` 或已有 dsh-file-viewer provider 读取，禁止新增直接 filesystem 写入、远程桌面或通用 Harness tool RPC。终端以 Host 用户权限运行，独立于 Agent 审批；按设备固定终端归属与连接输入权，断线不重放输入。loopback Host 只出站连接 `127.0.0.1` 白名单端口；Desktop Client 可监听随机本机端口承载独立预览 origin，禁止监听公网、任意目标、CONNECT 和通用 TCP 转发。
7. Token、私钥、主机匹配码、prompt、源码和工具输出不得写日志。
8. Harness v0.1.1 rc.2 业务层只使用官方 `ApiProxy`，v0.1.2 alpha.1–rc.1 与 v0.1.5 rc.1 / v0.1.6 alpha.1 Session V3 业务层只使用官方 `TypertGateway` Remote carrier；原生侧栏使用官方 `workspaceFiles` / `officeToPdf` / `terminal` 固定 allowlist；保留 dsh-file-viewer provider 通道。除规则 10 规定的 CodeX 内存展示载体外，禁止增加 session/agent/workspace/permission adapter、另一套 Harness wire format 或通用文件系统协议。
9. 不修改用户已有变更，不提交 `node_modules`、Expo cache、Android build 产物或个人 Agent 配置；唯一允许提交的 `dist` 是根 DSH GitHub Bundle 所需的 `packages/plugin/dist/index.js` 与 `client.github.js`，另需保留根 Host 入口 `index.js`。
10. Codex 支持必须保留在现有 Remote Plugin 内，并作为 `packages/plugin/src/codex/` 独立业务领域实现；默认开启且可在设置中关闭，使用独立 capability/RPC/event/state。允许 Client Plugin 以临时 rc.2 ApiProxy / v0.1.2 Typert 载体复用 DSH 原生 UI，也允许 Android 直接消费同一 `codex.app.*` 并只在内存中投影其移动端 Workspace/Session/Chat；两者都禁止写入 DSH SessionStore、Workspace 数据库或 Harness 日志。远端只允许编译期固定 App Server allowlist；Workspace authority 优先来自 CodeX App Server 的 `project/list`，该接口不可用或无可用根目录时才可回退到 App Server 已通过 `thread/list` 返回的绝对 `cwd`。`project/create` 只可注册 Host 上已存在的单个绝对目录，Host 必须执行 `realpath` 并确认目标是目录，且上游返回的新 Project 才能扩展 authority。新 Thread 还可使用这些 authority 根内经过词法路径与 `realpath` 双重校验的真实子目录，禁止推测共同父目录或越界接受 Client 自报路径。

## Test Policy

用户要求非核心功能不写 Test。测试预算只用于：

- Protocol 编解码、版本和 schema
- 身份、加密、篡改和重放
- Account authorization、Host registration code、Control handshake、Relay authorization
- RPC correlation、权限 fail-closed、ApiProxy/Typert Remote endpoint allowlist、事件顺序和恢复
- Transport fallback/reconnect 等核心状态机

纯展示 UI、普通文案、静态说明、非关键脚本和样式调整不单独增加测试。

## Documentation Rules

- `README.md`：面向用户的默认英文入口；写项目介绍、特性、安全边界、Plugin/Client 使用和开源 Server 自部署入口。
- `README.zh.md`：与根 README 对应的中文版本；功能和版本信息必须同步。
- `AGENTS.md`：面向编码 Agent，写仓库结构、进度、命令和实现约束。
- `TODO.md`：未完成任务与优先级。
- `apps/server/README.md`、`apps/server/README.zh.md`：开源自部署 Server 的实际能力、配置、运行方式和验证边界。
- `docs/server.md`：完整 Server 项目的产品/功能设计，并说明本仓库自部署版本的范围。
- `docs/plugin-integration.md`：Host Plugin 对接 Server 的账号认证、设备认证与凭证状态机，以及最小自部署版本支持的子集。
- `docs/protocol.md`：跨仓库协议规范。
- `vibe-coding.md`：原始需求背景，当前边界以 `README.md`、`AGENTS.md` 和 `docs/README.md` 为准。

文档发生范围变化时，应同时检查以上入口，避免 README、TODO、设计文档和实际目录互相冲突。

## Authorization recovery (Issue #70)

**状态文件的原子替换在 Windows 上会偶发 `EPERM`，那是"被占用"，不是"没权限"**：`rename` 在
Windows 上是 `MoveFileEx(MOVEFILE_REPLACE_EXISTING)` ✓，当**目标文件**被别的句柄以不含
`FILE_SHARE_DELETE` 的方式打开时会返回 `EPERM` ✓。持有者都是**短暂且在本进程之外**的：杀毒/
索引扫描、资源管理器预览、备份同步工具，以及**第二个写同一状态目录的进程** ✗。Node 自己总是带
`FILE_SHARE_DELETE` 打开文件，所以本进程不可能造成它 ✓，而且**下一次尝试通常就成功** ✓ —— 因此
排除项、权限或打包都不是修法 ✓✓。所有状态文件（`trusted-peers`、`server-credentials`、`device.*`）
统一走 `src/atomic-file.ts` 的 `replaceFile`（对 `EPERM`/`EBUSY`/`EACCES` 退避重试 5 次 ✓）与
`sweepStaleTemporaries`（清理崩溃遗留的 `<name>.<pid>.<uuid>.tmp` ✓，只清超过 10 分钟且名字符合
本模块规则的 ✓）。**重试不能替代正确的并发模型** ✗：两个实例共用一个 `DSH_HOME` 仍会在
读-改-写上竞争 ✓ → 同机并行 Host 必须使用不同的 `DSH_HOME` ✓（凭据另有 `.refresh-lock` ✓）。
回归测试见 `tests/atomic-file.test.ts` ✓。

Plugin 凭据刷新使用跨进程目录锁，获得锁后重新读取凭据；握手被拒绝后最多刷新恢复一次。
`4003` 映射为 `CONNECTION_REPLACED` 并停止自动抢占，同机并行 Host 应分别设置 `DSH_HOME`。
锁不按时间强行抢占；`SERVER_CREDENTIALS_BUSY` 的异常退出恢复步骤见 README。
核心测试覆盖多进程刷新互斥与鉴权恢复状态机，Windows 双实例实机验证仍待完成。

**登出保留设备身份**：`clearClientAuthorization()` / `clearHostAuthorization()` / CLI `logout`
只清理本地凭证，**不吊销设备、不轮换身份**，所以再次登录会**复用同一设备行**（`register` 会作废
该设备旧令牌）。原因：每账号设备数上限 **256**，且**只在新 `deviceId` 注册时判定**（已有设备复用
同一行、不占名额）；早期"登出即吊销+轮换"每次消耗一个名额，**约 128 次登出即把账号用满**
（`RATE_LIMITED`）。代价（有意接受）：登出后设备仍留在账号中（离线可见），其旧令牌在下次登录前
仍然有效（access 1h / refresh 30d），所以**登出不等于立即断权**。`revokeCurrentDevice()` 与
`DELETE /api/v1/devices/self` 予以保留但登出不再调用；要彻底移除设备须由运维在服务停止后改
`state.json`（运行期间编辑会被内存状态覆盖）。详见 `docs/plugin-integration.md` §6.1。

## Native sidebar and development preview (2026-09-20)

开发依赖升级到 Harness `0.2.0-rc.1`（同时兼容 `0.1.7-rc.1`），运行时按能力检测同时支持 ≤`0.1.6` 的 settings 注册表路径与 `0.1.7-rc.1` 与 `0.2.0-rc.1` 的 Volatile entry 路径（`typeof settings.register === 'function'` 分流）。终端与 loopback 设置只能在 Host 本地修改，`settings/update|replace|mutate` 禁止远程修改 `ds-harness-remote` 和 `dsh-remote`。终端默认开启；loopback 默认无端口。「远程终端」开关切换即保存并立即更新运行时拦截，「保存访问设置」按钮只提交 Loopback 端口（位于端口输入框右侧）；两者都无需重启 Host。预览入口位于 Remote Header「预览服务」，第一版限 Desktop / 连接本机 Harness 的浏览器；不把本机预览 URL 作为远程 Web 或 Android 可用地址。跨机、Windows 和真实网络热更新回归仍需另行验证。

## Android native tools (2026-09-21)

Android Harness 会话已接入 Files/Terminal：官方 workspaceFiles 目录与分页文本只读预览，
terminal 创建/list/follow/retain/write/resize/close；不对 CodeX 投影开放。终端使用本地打包
xterm + react-native-webview，需重新构建 APK。`apps/android/scripts/build-terminal.mjs` 生成
忽略的 `src/generated/terminal-html.ts`，prepare:workspace/check 和 CI APK 工作流负责生成。
权限控件兼容旧版 permissions.options 与新版仅 currentValue 的投影，后者调用官方
permissionPresets/catalog（已加入 Host 固定只读 allowlist）；Host 插件需同步更新。
核心测试覆盖 catalog 合约与终端输入权/事件顺序/断线不重放。跨机和原生 UI 真机验证仍待完成。

2026-09-22 标题栏入口（Issue #72 PR1）：Files/Terminal 入口移到会话标题栏图标，终端面板
标题栏「＋」才新建终端（打开只列出现有终端），文件面板刷新与层级返回同样在标题栏；未改
公共 TopBar 契约。

本次本地验证：Android 类型检查与 16 个测试文件 / 174 个测试通过；Plugin 类型检查、
5 个 Host Remote bridge 核心测试及 DSH bundle 校验通过。Plugin 全量测试首次有 5 个超时，
相关 3 个文件串行重跑 42 个测试通过。Hermes 导出初次通过；最终原生 APK 预构建未完成，
workspace 全量 check 在 Server web 类型检查处停滞，不作为通过记录。最终 APK 由 CI 构建，
原生键盘、TalkBack 和跨设备行为尚未验证。

Android 只读预览（Issue #72）：`workspace-file-preview.ts` 复用官方 stat/readBytes 和
Office generation/render，校验文件版本、分块、大小和取消；图片/PDF 上限 8 MiB，Office
源文件上限 50 MiB。PDF.js 固定版本与 xterm 一起经 `build:renderers` 本地打包；prepare/check、
CI/release APK 均需生成忽略的 renderer 源文件。PDF 仅单页画布预览，无脚本、外链、导出、
明文文件缓存或文本选择；不增加 Host 端点或写权限。Office 单次调用使用更长客户端超时，
Host 限额仍生效。原生真机与真实跨设备文件预览验收尚待完成。

该预览分支的全仓 check/生产 build、Android 197 测试、client-core 38 测试及本地 PDF 浏览器
烟测通过；全仓 test 仍有既有 codex-domain Windows 平台假设的 3 个失败。原生 APK 构建在
Expo CMake/Prefab 的 Windows 超长批处理路径处失败，不能视为已完成 APK 或真机验收。

## DSH 0.2.1 Desktop 远程模式启动失败（2026-10-06）

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

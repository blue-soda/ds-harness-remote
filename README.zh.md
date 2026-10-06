<p align="center">
  <img src="docs/logo.svg" alt="DeepSeek Harness Remote" width="600">
</p>

<p align="center">
  <a href="README.md">English</a>
  &nbsp;·&nbsp;
  <strong>中文</strong>
  &nbsp;·&nbsp;
  <a href="docs/README.md">文档</a>
  &nbsp;·&nbsp;
  <a href="https://github.com/blue-soda/ds-harness-remote/releases">Releases</a>
  &nbsp;·&nbsp;
  <a href="https://github.com/liguobao/ds-harness-remote/issues/20">iOS</a>
</p>

<p align="center">
  <a href="apps/server/README.zh.md">自部署</a>
  &nbsp;·&nbsp;
  <a href="https://www.npmjs.com/package/@blue-soda/dsh-remote">npm</a>
  &nbsp;·&nbsp;
  <a href="https://dshfind.com/zh/plugins/blue-soda/ds-harness-remote?ref=badge"><img src="https://dshfind.com/api/badge/blue-soda/ds-harness-remote?metric=downloads&amp;lang=zh" alt="dshfind 下载量" width="137" height="20" align="absmiddle"></a>
</p>

> **这是 fork。** 它基于 [liguobao/ds-harness-remote](https://github.com/liguobao/ds-harness-remote)（MIT）
> 继续开发，并以 [`@blue-soda/dsh-remote`](https://www.npmjs.com/package/@blue-soda/dsh-remote) 发布。
> 原项目与贡献者致谢见 [LICENSE](LICENSE) 与 `contributors`。
>
> 本 fork 的主要工作：
>
> - **多账号自部署 Server**：账号之间设备与令牌完全隔离，支持 DeepSeek 平台登录与微信 OAuth 入口。
> - **Windows 上真正可用的远程 Codex**：工作区授权改为大小写无关比较，并自动发现 ChatGPT 桌面应用内置的 `codex.exe` —— **不需要运行那个应用**就能浏览项目、加载历史并对话。
> - **修掉几处真实故障**：打开远程 Codex 工作区会导致原生窗口不可用、会话历史加载失败、上游已声明的调用字段被误拒，以及 Windows 上状态文件写入的瞬时 `EPERM`（已加重试）。
> - **体验优化**：退出登录只保留导航栏入口；登出同时退出借用的 DeepSeek 账号，但保留设备身份（不消耗账号设备名额）；切到后台再回来自动重连；设置卡片里可开关 Codex 连接，并确认或手填二进制路径。
> - **以 npm 包发布**：包名是 `@blue-soda/dsh-remote`，而插件实例 id、设置命名空间与 CLI 命令名保持不变，**已有安装、设备授权与设置无需迁移**。

## 一次连接，随时可用。

从手机、电脑、浏览器继续使用你的 DeepSeek Harness 实例。

无论使用哪台设备，都可以回到同一个 Harness 会话。Harness 始终运行在工作电脑上，原有的工作区、工具和项目配置保持不变。Remote 只是通往这个工作环境的另一个窗口。

Remote 已支持 DeepSeek Harness 桌面版。手动安装时，通过 DSH 插件管理器使用这个固定版本：

`@blue-soda/dsh-remote@0.4.29`

## 主要特性

- 从另一台设备继续活跃会话，查看最新进展
- 发送新指令、调整任务方向，并在 `dsh-v0.1.1-rc.2` 至 `dsh-v0.2.0-rc.2` 范围内的受支持 Harness 版本中使用图片 Prompt
- 在支持实时会话控制的客户端中回答问题、处理权限请求
- 支持 DeepSeek Harness 桌面版，并可使用固定版本的 Remote 插件
- 打开同一账号下另一台已授权电脑上的 Workspace
- 复用 Harness 原生界面，不另外维护一套桌面会话 UI
- 可将纯终端 [dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) profile 作为 Host，并通过 GitHub 或知乎终端二维码授权
- Harness 主机无需开放公网监听端口。你可以从任意可上网的地方，通过双向端到端加密链路安全连接
- 通过 Harness 原生侧栏提供工作区文件、只读预览、终端和已授权本机开发服务预览

## 安装

### 支持 DeepSeek Harness 桌面版

Remote 已支持 DeepSeek Harness 桌面版。通过下面的命令行安装方式使用这个固定版本：

`@blue-soda/dsh-remote@0.4.29`

### dsh-TUI Host

将 [dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) 作为终端 Host 的配置，请参阅
[dsh-TUI Remote 使用指南](docs/dsh-tui.md)。

### 命令行安装

通过 DSH 插件管理命令，将确切版本加入 `web` profile：

```sh
dsh plugin --profile web add -w @blue-soda/dsh-remote@0.4.29
```

`-w` 表示加到 profile 自身的 workspace root；pnpm 低于 11 时不加会直接报
`ERR_PNPM_ADDING_TO_ROOT`。

安装后请重启 Harness。

不要直接用 npm 安装这个包。只有 `dsh plugin` 会更新指定 profile，并加入插件的 bundle 配置层。

### Android 客户端

本仓库的安卓版应用来自上游 Remote 仓库。我们维护自己的构建：
[**blue-soda/deepseek-harness-android-app**](https://github.com/blue-soda/deepseek-harness-android-app/tree/master)
—— 一个可在安卓本地运行 DSH、并自带 Remote 插件的 APK。

点击输入栏 `+` 旁的「快捷提示词」打开已保存的提示词列表，点击条目即可发送，并可在同一面板编辑提示词。文件、终端和轨迹仍位于 `+` →「工具访问」。

### 自动安装（后台服务）

将 Remote Host 安装为后台服务。服务管理、登录、目录配置和卸载方式见[安装指南](docs/installation.zh.md)。

macOS / Linux：

```sh
curl -fsSL https://raw.githubusercontent.com/blue-soda/ds-harness-remote/main/scripts/install.sh | bash
```

Windows PowerShell（以管理员身份运行）：

```powershell
$installer = "$env:TEMP\install.ps1"
Invoke-WebRequest -UseBasicParsing https://raw.githubusercontent.com/blue-soda/ds-harness-remote/main/scripts/install.ps1 -OutFile $installer
& $installer
```

## 快速开始

1. 从 Harness 侧边栏打开 **Remote** 入口。
2. 在 Remote 卡片里**用 DeepSeek 账号登录**：本 fork 的插件只提供这一种登录方式，GitHub/知乎扫码与账号密码入口已从模态框移除（服务端实现仍保留）。
3. Host 启动后默认允许控制当前机器，远程终端也默认开启；需要时可在详细 Remote 设置中关闭远程终端。
4. 在另一台设备上打开 DeepSeek Harness 桌面版或 Android 客户端，并登录同一账号。
5. 选择在线 Host，再选择已有 Workspace 或浏览远端目录后打开。

插件内置的默认 Server 是 `https://sakakibara.ink:8443`；要自建多账号 Server 见[最小自部署 Server](apps/server/README.zh.md)，其 Web 页面提供登录与设备状态。

## 最小自部署 Server

[`apps/server`](apps/server/README.zh.md) 是可独立运行的单进程 Relay Server，**支持多账号**：设备与令牌按账号命名空间隔离，跨账号互不可见。`DSH_SERVER_ACCOUNT`/`DSH_SERVER_PASSWORD` 配置的是**启动种子账号**，其余账号在重启后保留；**建号默认关闭** —— 需要时用 `DSH_SERVER_REGISTRATION_CODE` 开启注册码注册，或用 `DSH_SERVER_DEEPSEEK_LOGIN=on` 以 DeepSeek 平台账号登录、`DSH_SERVER_OAUTH_PROVIDER=github|wechat` 扫码登录（`DSH_SERVER_PASSWORD_LOGIN=off` 可关闭密码登录）。Web 页面目前只有登录与设备状态。Host 与客户端填写同一 Server 地址并登录同一账号，设备凭据在重启后保留 —— 它只做 Relay，不提供 Remote Web 会话界面、Admin 或 WebRTC/TURN；完整配置与部署见 [`apps/server/README.zh.md`](apps/server/README.zh.md)。

## 界面截图

### 桌面端

Host 启动后默认允许控制当前设备，当前电脑即可作为 Host。远程终端默认开启，也可在详细 Remote 设置中关闭。

在另一台电脑上选择在线 Host，然后打开它的 Workspace。

<p align="center">
  <img src="docs/images/host-list.png" alt="列出在线 Host 的远端工作区选择界面" width="900">
</p>

Workspace 会在 Harness 原生界面中打开，顶部显示当前 Host 和加密连接状态。

<p align="center">
  <img src="docs/images/remote.png" alt="通过端到端加密远程连接运行的 Harness 会话" width="900">
</p>

## 工作方式

```text
DSH Desktop / Remote Web / Android
  ↔ 已认证的端到端加密通道
Host 上的 Remote 插件
  ↔ 支持的 Harness 能力或可选 Codex 工作区支持
Harness 会话/Workspace 或 Codex 项目
```

Harness 主机无需开放公网监听端口。只要能够访问互联网，就可以从任意地方连接，
Remote 通过双向端到端加密链路通信。它将客户端切换到所选 Host 的 Harness 原生 API，
因此原有 Workspace、工具和权限流程都保留在该电脑上。Host 当前注册的全部设置分区也可以
通过 Harness 官方设置 API 在远端配置。凭据值仍然只写，Host 本地的文档打开操作不会暴露到远端。

## 实验性 Codex 工作区

Remote 也可以显示已授权 Host 上的 Codex 项目。你从原来的 Workspace 选择器进入，继续在现有
Harness 或 Android 界面里使用 Codex，不需要学习另一个 Codex 页面。Desktop 选择器和 Android
工作区页面也可以把 Host 上的目录新增到 Codex 项目目录，不会导入 Harness 存储。

Codex Remote 是面向自有设备的便捷入口。它支持文本 Prompt、可用客户端上的图片 Prompt、模型与
权限控制、停止和审批。它仍以实验功能发布；长期运行恢复和兼容性工作会继续按 TODO 跟进。

Web 和 Desktop 的审批控件显示所选 Codex 会话经 Host 确认的模式；尚未获知时标明沿用 Host
设置。切换须等 Host 确认成功，发送消息沿用会话当前策略。

Codex 默认开启，也可以在 DeepSeek Remote 设置卡片关闭。Host 上装有 ChatGPT 桌面应用时，插件会
自动发现它内置的 `codex.exe` 并直接以 `codex app-server` 通信，**因此不需要运行桌面应用**就能浏览
Codex 项目、加载历史并对话。高级配置和实现细节见
[Codex Remote 技术说明](docs/codex-remote.md)。

## 端到端加密

Harness 业务流量在 Client 加密，只能由选定的 Host 解密，固定使用
`Noise_IK_25519_ChaChaPoly_SHA256`。连接必须同时通过同账号 membership 与本地固定的设备
identity key 校验。服务端可以协调连接并看到必要的网络元数据，但不能读取会话消息、Prompt、
工具输出、Workspace 路径或 远端文件内容。握手、密钥生命周期、可见元数据、重放保护和
安全边界详见[端到端加密](docs/end-to-end-encryption.md)。

## 网络与传输

Host 只建立出站连接，不监听公网端口，也不要求路由器端口转发。Remote 按
`LAN -> P2P -> TURN -> Relay` 协商路径；WebRTC 不可用或连接失败时，会降级到加密的
WebSocket Relay。所有路径都承载同一份 Noise 密文，并保持相同的 Host/Client 身份边界。
网络拓扑、控制面与数据面、NAT、降级、重连语义和当前验证状态详见[网络与传输](docs/network.md)。

## 安全边界

- 会话流量经过端到端加密；服务端只中继密文，不保存会话明文或设备私钥。
- Server membership 与 Host 本地固定的 peer identity 必须同时授权连接。
- 交互终端使用 Host 本地的 `terminal.enabled`（默认开启），以 Host 用户身份运行，独立于 Agent 审批；不开放通用工具 RPC 或远程桌面。
- Workspace 选择器只列出文件夹，并且只返回受限的只读目录元数据。
- 远端文件预览不能写入、删除、上传、执行文件，也不能调用远端系统的“外部打开”。
- Codex Remote 是可选功能，可以关闭，并遵循与 Remote 其他能力相同的加密 Host 权限边界。
- 移除设备后，其凭证、membership 和已建立的 Remote 连接均会失效。

## 文档

- [插件说明](packages/plugin/README.md)
- [dsh-TUI Remote 使用指南](docs/dsh-tui.md)
- [Codex Remote 技术说明](docs/codex-remote.md)
- [文档索引](docs/README.md)
- [端到端加密](docs/end-to-end-encryption.md)
- [网络与传输](docs/network.md)
- [远程协议](docs/protocol.md)
- [开发进度与路线图](TODO.md)
- 版本兼容详情见[兼容性说明](docs/compatibility.zh.md)。

## 友情链接

- 友情链接：[dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI)（已适配 Remote，参见 [dsh-TUI Remote 使用指南](docs/dsh-tui.md)）
- 友情链接：[LINUX DO 社区](https://linux.do/)
- 友情链接：[赛博刘看山](https://kanshan.r2049.cn/)

## Star History

<a href="https://www.star-history.com/?repos=liguobao%2Fds-harness-remote&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=blue-soda/ds-harness-remote&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=blue-soda/ds-harness-remote&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=blue-soda/ds-harness-remote&type=date&legend=top-left" />
 </picture>
</a>

## 项目声明与商标

本项目是独立的社区项目，不是 DeepSeek 官方产品。DeepSeek 及相关名称和商标归其各自权利人所有。

## License

[MIT](packages/plugin/LICENSE)

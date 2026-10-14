## English

- **Signing in now only happens through the browser authorization you just completed.** The DeepSeek sign-in used to accept whichever platform session DSH already held and authorize with it silently, so a new device landed in whatever account DSH happened to be signed into. On a Server that creates an account for an identity it has never seen, that meant a brand-new, *empty* account: an empty Host list, and no way back to your own account except signing out and in again. The card now asks for the browser flow unless you started this sign-in, and accepts the grant DSH holds once you have.
- **Being signed out is no longer reported as an error.** Device discovery used to answer with an empty list while the local credential could not be used — which the panel read as "signed in, just no computers" — so a fresh device opened on an empty Host list instead of offering its sign-in button. It now reports the authorization failure, and the panel answers it with the button and no error text.
- **Codex is off by default.** Carrying another agent's workspaces is a capability you opt into; it is not something that quietly starts a second process (`codex app-server`), probes an account and retries every minute on a computer that never asked for it. Turn it on in the DeepSeek Remote settings card — the switch applies immediately, without restarting DSH. An install that already had it on stays on.
- Documents the behaviour users actually meet — the recovery stages, what the control switch does and does not do, browsing versus opening a session, and the Codex account gate — and brings the design, protocol and release documents back in line with the implementation.
- Fixes a fresh install opening on an empty Host list instead of the sign-in panel, by keeping the local-credential answer and the device-list answer together when the panel decides.

## 中文

- **登录只通过你刚刚在浏览器中完成的授权进行。** 此前 DeepSeek 登录会接受 DSH 当时持有的平台会话并静默用它完成授权，于是新设备会落进 DSH 当时登录的那个账号。在"首次见到的身份即建号"的 Server 上，这意味着一个**全新的空账号**：主机列表是空的，除了退出再登录没有别的办法回到自己的账号。现在除非本次登录由你发起，卡片会先走浏览器授权；你完成后，DSH 当时持有的 grant 即被接受。
- **未登录不再被当成错误。** 本地凭据不可用时，设备发现此前返回空列表——面板会读成"已登录，只是没有电脑"——于是新设备打开就是一张空主机列表，而不是显示登录按钮。现在它会报告授权失败，面板则静默地用登录按钮回应：没有错误文案。
- **Codex 默认关闭。** 载入其它 agent 的工作区应是你主动开启的能力，而不是在一台从未有此需求的机器上悄悄启动第二个进程（`codex app-server`）、探测账号并每分钟重试。请在 DeepSeek Remote 设置卡片中开启——切换立即生效，无需重启 DSH。已经开启过的安装保持开启。
- 把用户真正会遇到的行为写进文档——恢复的三段、控制开关**做与不做**什么、浏览与打开会话的区别、Codex 的账号门禁——并让设计、协议与发版文档重新与实现对齐。
- 修复全新安装直接打开空主机列表而不是登录面板的问题：面板判定时把"本地凭据"与"设备列表"两个事实合在一起看。

[Full changelog / 完整改动](https://github.com/blue-soda/ds-harness-remote/compare/v0.5.0...v0.5.1) · [Installation / 安装说明](https://github.com/blue-soda/ds-harness-remote/blob/v0.5.1/README.md)

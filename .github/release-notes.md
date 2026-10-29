## English

- **DSH and Remote sign in and out together.** Signing in to DSH's DeepSeek account now authorizes this device on the Server without an extra click, and signing out of DSH signs Remote out and disconnects it. The other direction was already there. With account creation enabled on the Server, a DSH account the Server has never seen becomes a new account - that is the accepted trade; accounts are still matched by platform id, never by a claim the plugin makes.
- Everything from **0.5.1** to **0.5.4** ships here too: sign-in only through the browser authorization, Codex off by default, the credential-lock reclaim, the dsh 0.2.1-rc.2 gateway compatibility, forked Codex sessions showing as separate rows, and the reconnecting/standby fixes.

## 中文

- **DSH 与 Remote 一起登录、一起登出。** 在 DSH 上登录 DeepSeek 账号后，本设备会自动在 Server 上完成授权（无需再点一次）；在 DSH 上退出登录时，Remote 会一并退出并断开连接。反方向原本就已生效。Server 开启建号时，Server 没见过的 DSH 账号会被建成新账号 —— 这是已接受的取舍；账号仍按平台 id 匹配，绝不信任插件自称的身份。
- **0.5.1**–**0.5.4** 的全部内容同样包含在本版：登录只经浏览器授权、Codex 默认关闭、凭据刷新锁回收、对 dsh 0.2.1-rc.2 的网关兼容、Codex 分叉会话独立显示，以及重连/待命相关修复。

[Full changelog / 完整改动](https://github.com/blue-soda/ds-harness-remote/compare/v0.5.4...v0.5.5) · [Installation / 安装说明](https://github.com/blue-soda/ds-harness-remote/blob/v0.5.5/README.md)

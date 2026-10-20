## English

- **A displaced connection is a standby now, not a dead end.** When another instance takes this device identity over, the Server closes the older socket and the plugin used to stop reconnecting for good — so after the winning instance left, the device stayed offline with no explanation (which is how two Android clients saw a Desktop as offline for a day). It now says it is standing by and retries every five minutes (`reconnect.replacedRetryMs`, default five minutes), taking over as soon as the other instance goes. The wait is longer than the Server heartbeat window, so two live instances cannot displace each other in a loop. Authentication failures still stop retrying, and replacing this peer's own transport is still ignored.
- Everything from **0.5.1** to **0.5.3** ships here too: sign-in only through the browser authorization you just completed, signed out as a state rather than an error, Codex off by default, the narrow-screen status pill fix, the credential-lock reclaim, and the dsh 0.2.1-rc.2 gateway compatibility.

## 中文

- **被顶替的连接现在是「待命」，不再是死路。** 另一个实例接管本设备身份时，服务端会关闭旧连接，而插件以前会**永久停止重连** —— 于是赢家离开后设备一直离线且没有任何说明（这正是两个安卓端看到 Desktop 离线一整天的原因）。现在它会记录「待命」并**每 5 分钟**重试一次（`reconnect.replacedRetryMs`，默认 5 分钟），对方退出后自动接管。等待时间刻意长于服务端心跳判定窗口，因此两个活着的实例不会互相顶来顶去。鉴定类错误仍然停止重试，自我替换仍然被忽略。
- **0.5.1**–**0.5.3** 的全部内容同样包含在本版：登录只经浏览器授权、未登录是状态而非错误、Codex 默认关闭、窄屏状态药丸修复、凭据刷新锁回收，以及对 dsh 0.2.1-rc.2 的网关兼容。

[Full changelog / 完整改动](https://github.com/blue-soda/ds-harness-remote/compare/v0.5.3...v0.5.4) · [Installation / 安装说明](https://github.com/blue-soda/ds-harness-remote/blob/v0.5.4/README.md)

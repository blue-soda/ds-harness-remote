## English

- **Bigger history pages when they fit, smaller when they do not.** 0.5.6 capped every Remote history page at 50 messages. That kept each page under the 4 MiB channel limit, but it also cut ordinary sessions ten times below what the client asks for, so every scroll needed another round trip. Pages are now chosen by their encoded size: the Host takes the requested page (up to 500), measures it, and steps down only when it would not cross in one piece. Each session remembers the size that last fit.
- **Signing in no longer gets stuck on "Signing in…".** The settings poll started a new DeepSeek-to-Server authorization on every call (a duplicated reconcile call made it two per poll), so a card whose exchange had already succeeded was restarted before its flag could clear, and every attempt re-registered the device. At most one exchange runs at a time now.
- **A refused credential no longer loops forever.** The Server refuses a hello with close code 4001 and names the refusal in the close reason. The Host ignored that reason and treated every 4001 as a network failure, so a Host whose token had been invalidated kept presenting it every thirty seconds - one real Host did that for four hours and stayed offline until the process was restarted. Known refusal codes are honoured now; terminal ones stop the loop and let the automatic re-authorization run.
- **A healthy Host can no longer be stuck "offline".** Every Server control frame - the heartbeat included - used to wait behind one serialized queue, and closing the socket waited for that same queue with no deadline. One slow handler therefore starved the heartbeat until the Server marked the device offline, and then blocked the reconnect that would have fixed it; only restarting the process recovered. Heartbeats are answered immediately now, and the close path gives in-flight frames five seconds before reconnecting anyway.
- Everything from **0.5.1** to **0.5.6** ships here too: Codex Session ids back to `codex:<threadId>`, sign-in that follows DSH, Codex off by default, the credential-lock reclaim, dsh 0.2.1-rc.2 gateway compatibility, and the standby/reconnect fixes.

## 中文

- **历史页能装下就用大页，装不下才缩小。** 0.5.6 把所有 Remote 历史页钳在 50 条：虽然每条都在 4 MiB 通道上限内，但普通会话只有客户端请求的十分之一，每次向上翻页都要多一个来回。现在按编码后的字节数选页：Host 先按客户端请求取回（最多 500 条），量一下，只有装不进一条消息时才逐级下调；每个会话记住上次装下的窗口。
- **登录不会再卡在“正在登录…”**。设置轮询每次都会重新发起一遍 DeepSeek→Server 授权（重复的 reconcile 调用让它每轮跑两次），已经成功的卡片还没清掉标记就又被重新开始，而且每次都重新注册设备。现在同一时刻只允许一个授权交换。
- **凭据被拒后不再无限重连。** Server 拒绝 hello 时用 4001 关闭，并把拒绝原因写在 close reason 里。Host 以前忽略这个原因，把所有 4001 都当成网络故障，于是一个 token 已失效的 Host 每 30 秒拿着同一个死 token 重试——真实案例持续了四个小时，直到进程重启才恢复。现在会识别 close reason 里的已知拒绝码：终止类停止重试并让自动重新授权接管。
- **健康的 Host 不会再被卡成“离线”。** 以前所有 Server 控制帧（包括心跳）都在同一个串行队列里，而 socket 关闭时又无期限地等这个队列。只要有一个慢处理器，心跳就会被饿到 Server 判定设备离线，随后连本该恢复的重连也被卡住，只能重启进程才能好。现在心跳立即在队列外应答，关闭路径最多等 5 秒就继续重连。
- **0.5.1**–**0.5.6** 的全部内容同样包含在本版：Codex Session id 恢复为 `codex:<threadId>`、跟随 DSH 的登录、Codex 默认关闭、凭据刷新锁回收、对 dsh 0.2.1-rc.2 的网关兼容，以及待命/重连修复。

[Full changelog / 完整改动](https://github.com/blue-soda/ds-harness-remote/compare/v0.5.6...v0.5.7) · [Installation / 安装说明](https://github.com/blue-soda/ds-harness-remote/blob/v0.5.7/README.md)

## English

- **Bigger history pages when they fit, smaller when they do not.** 0.5.6 capped every Remote history page at 50 messages. That kept each page under the 4 MiB channel limit, but it also cut ordinary sessions ten times below what the client asks for, so every scroll needed another round trip. Pages are now chosen by their encoded size: the Host takes the requested page (up to 500), measures it, and steps down only when it would not cross in one piece. Each session remembers the size that last fit.
- **A healthy Host can no longer be stuck "offline".** Every Server control frame - the heartbeat included - used to wait behind one serialized queue, and closing the socket waited for that same queue with no deadline. One slow handler therefore starved the heartbeat until the Server marked the device offline, and then blocked the reconnect that would have fixed it; only restarting the process recovered. Heartbeats are answered immediately now, and the close path gives in-flight frames five seconds before reconnecting anyway.
- Everything from **0.5.1** to **0.5.6** ships here too: Codex Session ids back to `codex:<threadId>`, sign-in that follows DSH, Codex off by default, the credential-lock reclaim, dsh 0.2.1-rc.2 gateway compatibility, and the standby/reconnect fixes.

## 中文

- **历史页能装下就用大页，装不下才缩小。** 0.5.6 把所有 Remote 历史页钳在 50 条：虽然每条都在 4 MiB 通道上限内，但普通会话只有客户端请求的十分之一，每次向上翻页都要多一个来回。现在按编码后的字节数选页：Host 先按客户端请求取回（最多 500 条），量一下，只有装不进一条消息时才逐级下调；每个会话记住上次装下的窗口。
- **健康的 Host 不会再被卡成“离线”。** 以前所有 Server 控制帧（包括心跳）都在同一个串行队列里，而 socket 关闭时又无期限地等这个队列。只要有一个慢处理器，心跳就会被饿到 Server 判定设备离线，随后连本该恢复的重连也被卡住，只能重启进程才能好。现在心跳立即在队列外应答，关闭路径最多等 5 秒就继续重连。
- **0.5.1**–**0.5.6** 的全部内容同样包含在本版：Codex Session id 恢复为 `codex:<threadId>`、跟随 DSH 的登录、Codex 默认关闭、凭据刷新锁回收、对 dsh 0.2.1-rc.2 的网关兼容，以及待命/重连修复。

[Full changelog / 完整改动](https://github.com/blue-soda/ds-harness-remote/compare/v0.5.6...v0.5.7) · [Installation / 安装说明](https://github.com/blue-soda/ds-harness-remote/blob/v0.5.7/README.md)

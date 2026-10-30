## English

- **Codex conversations open again on every client.** 0.5.5 published a Codex Session id as `<threadId>~<createdAt>~<n>` to keep the rows Codex lists for one thread apart. That key then travelled back as the Session id, so a full DSH client asking for the conversation's history or files was told the identifier was invalid, or got a history that no longer matched the Session it asked for. A Codex Session is `codex:<threadId>` again, and the Host lists each thread once instead of once per rollout file. A Session cached from 0.5.5 still resolves to its thread.
- **Why the extra rows are gone:** they are not separate branches. The Codex App Server only opens a thread's current rollout - resuming a superseded one is refused, and history reads take no path at all - so the rows only ever led to the same conversation.
- Everything from **0.5.1** to **0.5.5** ships here too: sign-in that follows DSH, Codex off by default, the credential-lock reclaim, dsh 0.2.1-rc.2 gateway compatibility, and the standby/reconnect fixes.

## 中文

- **Codex 会话在所有客户端上恢复可打开。** 0.5.5 把 Codex Session id 发布成 `<threadId>~<createdAt>~<n>`，想借此区分 Codex 为同一个 thread 列出的多行。这个键随后又作为 Session id 传回来，于是完整 DSH 客户端请求该会话的历史或文件时会被告知标识无效，或者拿到的历史与它请求的会话对不上。现在 Codex Session 重新是 `codex:<threadId>`，Host 每个 thread 只列一行，而不是每个 rollout 文件一行。0.5.5 缓存下来的 Session 仍会解析回它的 thread。
- **那些多出来的行为什么没有了：** 它们并不是独立分支。Codex App Server 只打开 thread 的当前 rollout —— resume 一个已被取代的 rollout 会被拒绝，历史读取根本没有 path 参数 —— 所以那些行最终都指向同一个会话。
- **0.5.1**–**0.5.5** 的全部内容同样包含在本版：跟随 DSH 的登录、Codex 默认关闭、凭据刷新锁回收、对 dsh 0.2.1-rc.2 的网关兼容，以及待命/重连修复。

[Full changelog / 完整改动](https://github.com/blue-soda/ds-harness-remote/compare/v0.5.5...v0.5.6) · [Installation / 安装说明](https://github.com/blue-soda/ds-harness-remote/blob/v0.5.6/README.md)

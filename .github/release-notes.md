## English

- Rebuilds remote session recovery around **one ladder for every kind of loss** and around the session actually being restored (device + workspace kind + directory). A Codex session comes back as a Codex workspace, never as the peer's DSH workspace.
- Keeps the view untouched through the **quick window** (two relay-only attempts inside ten seconds), falls back to the local shell at the ten-second mark, then hands over to a **bounded schedule** (5/10/20/30s…) that ends for good and closes the "reconnecting" indicator instead of retrying forever.
- Treats **the user's own choice as authoritative**: a recovery that lands after the user cancelled it or opened another workspace has its result discarded, and the local shell is restored.
- Adds the `codex.app.capability` event: the Host states Codex availability **only on a real transition**, and the client decides what it means. Switching Codex **on** can therefore never be read as a lost session, and switching it **off** no longer disturbs a DSH session on the same link.
- Improves Codex diagnostics: a 90s start budget with a 60s account probe, serialized launches, the **first** (platform-preferred) candidate's failure reported, and upstream error codes retained (`upstreamCode`). An unreachable account no longer reads as a missing binary, and a blocked proxy/VPN is now visible in the status code.
- Keeps **one identity per device**: `role` exists only on a connection, "can be controlled" is the control switch alone, and a Host with control off is still listed (marked offline) instead of hidden.
- Adds a **scripted end-to-end matrix** (`scripts/remote-e2e.mts`): two session kinds × three ways to lose them (control switch, Codex switch, frozen process) × three stages (quick window, retry schedule, give-up), plus browsing, cancellation, restart-restore and Codex negative cases.

## 中文

- 重构远程会话恢复：**所有丧失复用同一条阶梯**，并且只还原"同一个会话"（设备 + 工作区种类 + 目录）。Codex 会话恢复后仍是 Codex 工作区，**不会**落回对端的 DSH 工作区。
- **快速窗口**（10 秒内至多 2 次、强制 relay）期间不切视图，第 10 秒回退本地，随后交给**有界的重试日程**（5/10/20/30 秒…）；日程走完即明确放弃并收起「重连中」，不再无限重试。
- **用户的选择是权威**：若一次恢复在用户取消或另选工作区之后才落地，其结果会被丢弃并回到本地 shell。
- 新增 `codex.app.capability` 事件：Host **只在真实翻转时**声明 Codex 可用性，由客户端决定其含义。因此"打开 Codex"**永远不会**被读成会话丧失，而"关闭 Codex"也不再干扰同一条链路上的 DSH 会话。
- 改进 Codex 诊断：启动预算 90 秒 / 账号探测 60 秒、启动串行、上报**第一个（平台推荐）候选**的失败、保留上游错误码（`upstreamCode`）。账号不可达不再被掩盖成"缺少二进制"，代理/VPN 被拦也能从状态码看出来。
- 保持**一台设备一份身份**：`role` 只存在于连接上；"能否被控制"只看控制开关；关闭控制的主机仍然列出（标注离线）而不隐藏。
- 新增**脚本化端到端矩阵**（`scripts/remote-e2e.mts`）：2 类会话 × 3 种失去方式（控制开关 / Codex 开关 / 冻结进程）× 3 个阶段（快速窗口 / 重试日程 / 放弃），外加浏览、取消、重启恢复与 Codex 负例。

[Full changelog / 完整改动](https://github.com/blue-soda/ds-harness-remote/compare/v0.4.29...v0.5.0) · [Installation / 安装说明](https://github.com/blue-soda/ds-harness-remote/blob/v0.5.0/README.md)

# 验证历史

按日期追加的验证记录（当时的构建、测试与实机结论）。**当前基线**摘要见 `docs/decisions.md` 的
Validation Baseline 小节；这里保留过程与当时的口径，便于回溯"某个结论是哪次验证得出的"。

2026-10-14 Codex 可用性与"用户想要什么"的权威（本轮）：

- 构建与静态检查：`pnpm --filter './packages/**' -r build`、`pnpm -r check`、
  `node scripts/verify-dsh-plugin.mjs`、`git diff --check` 全部通过。
- 测试：`pnpm -r test` **exit 0**；Plugin **394 通过 / 46 文件**、Protocol **234 / 7**。
- 端到端矩阵（`scripts/remote-e2e.mts --fast`）：**11 场景 / 54 断言全绿，exit 0**。含
  `browse-*`、`open-*`、`browsing-death`、`control-switch-semantics`、`cancel-during-window`、
  `codex-off-harness-session`（负例）、`control-off-{harness,codex}:window`、
  `codex-off-codex:window`。此前失败的 `cancel-during-window` 由 5/6 变 **6/6**。
- 设计变更：Codex 可用性改由 `codex.app.capability {available}` 声明（Host 只陈述事实、只在真实
  翻转时发送；首次观察只记不发；替换式重启不算失去），判定权归 Client（`available:false` 且正在看的
  会话属于该主机才走恢复阶梯，`available:true` 永远不是丧失）；`CodexRemoteDomain` 增加世代号，旧世代
  的启动完成不得改写状态；恢复动作改为在读用户意图（`lastWorkspaceSelection`）之后才采纳结果，落地时
  发现用户已回答（取消/另选工作区）则丢弃结果并回到本地 —— 该判据与恢复路径对 DSH 与 Codex 共用。
- 诊断链补全（本轮查出真因的三层掩盖）：`handleProcessFailure` 记 spawn 的 `errno`/`syscall`、
  候选逐个记码且域对外的码取第一个候选、账号探测记原始码、上游错误保留 `upstreamCode`。
  实测：`CODEX_BINARY_UNAVAILABLE`（最后候选）← `CODEX_ACCOUNT_UNREACHABLE`（分类）←
  `CODEX_REQUEST_TIMEOUT`（15 秒预算）← `-32603`（上游 JSON-RPC internal error）。**根因之一是
  VPN 未开启**：账号后端不可达时冷启动的 app-server 先超时、放宽到 60 秒后报 `-32603`；VPN 开启后
  域立即 `ready`，出网恢复后 60 秒慢重试自行回到 ready（无需重写设置）。
- 用户实测（Desktop 为 Host、隔离 web 为 Client，VPN 开启，Desktop 已重启到本轮构建）：功能全部正常。
  客户端日志客观记录：`trying the quick window` ×6、`kept its view through a quick reconnect` ×3、
  `falling back to the local shell` ×3、`remote session recovered` ×5、`recovery gave up` ×0、
  `Codex session loss ignored` ×15（看 DSH 会话/仅浏览时 Codex 域变化被忽略）。日志同时出现
  `reason:"codex-closed"` 与 `reason:"transport-closed"`（含 `CONTROL_DISABLED`）两类丧失走**同一条**
  阶梯。
- 未覆盖：UI 渲染（顶部文案、页面重载时机）仍为人工判读；`recovery gave up`（日程走完）与两个冻结
  场景（`freeze-*:schedule`）自本轮改动后尚未跑过；Android/VS Code 客户端未同步验证新事件
  （`codex.app.capability` 对它们是增量，可忽略）。

2026-10-14 慢场景（完整矩阵的后半）与 harness 的两处缺陷：

- 慢场景结论（逐个复跑验证）：`*-off-*:schedule`（harness/codex 各两条）全绿，走完"快速窗口耗尽 →
  第 10 秒回退 → 日程接回同一工作区 → 清掉重连标记"；`*-off-*:giveup` 全绿，走完"日程有界且明确放弃 →
  收起顶部重连标记 → 不再自启 → 用户就是本地"；`freeze-{harness,codex}:schedule` 全绿，走完"静默停顿
  被自身的写失败发现 → 窗口 → 日程接回"。
- **harness 缺陷 1（误报产品失败）**：`countLog` 统计的是**整个日志文件**，于是"前面已经跑过
  `:giveup`"之后，`waitFor('recovery gave up')` 立刻返回，断言读到的是仍在飞行中的日程
  （`control-off-codex:giveup` 因此报 "the header stops advertising a reconnect"）。改为**按场景游标计数**
  （runner 在每个场景前推进 `scenarioCursor`），复跑即 10/10。
- **harness 缺陷 2（冻结一直是空操作）**：挂起脚本用 `foreach ($pid in @(...))`，而 **`$PID` 是 PowerShell
  只读自动变量** → 循环每次迭代都失败、`spawnSync` 的失败又被忽略 → "冻结"什么都没做，场景只是在等一个
  从未发生的停机（诊断探针显示被"冻结"的宿主**仍能回答自己的 loopback 端点**）。改用 `$target` 变量，
  并让 NT 状态与 `OpenProcess` 失败**抛出**。
- **对端静默时，Server 的心跳检测正常（已对着线上 Server 日志核实，2026-10-14）**：冻结场景等待期间
  客户端每 10 秒读到的 `online` 一直是 `true`，那只是**超时还没到**——线上日志在同一时刻给出完整链条：
  `18:17:07.649 link.dropped` + `peer.offline host reason=heartbeat-timeout linksDropped=1`（即 Server
  在文档所述 40–65 秒窗口内判定离线**并通知了 client**），客户端随即进入快速窗口；`18:17:27 peer.online
  host`（解冻后重连）、`18:17:48→18:17:50 link.created/accepted/ready`（恢复）。同日 `heartbeat-timeout`
  共 32 次、全部集中在 e2e 实例，安全类关键词（identity mismatch / replay / tamper / decrypt）为 **0**；
  `hello.rejected AUTH_INVALID` 只出现在 10-08/10-10（旧事件），当日无一条。**因此这条不是缺陷**：
  诊断输出保留价值在于"`online=true` 但宿主已不应答"这种组合，而它现在被解释清楚了（超时窗口未到）。
  线上配置与文档一致（`DSH_SERVER_HEARTBEAT_INTERVAL_MS=20000`、`DSH_SERVER_PEER_TIMEOUT_MS=45000`）。
- **harness 缺陷 3（计数窗口切错位置）**：按场景计数时用**字节**游标去切**字符**下标（日志每行的 `…`
  是多字节）→ 切片起点偏后，正好切掉场景**最早**那几行（`trying the quick window` 就在那里），于是
  "窗口已打开"被读成"没打开"（`control-off-codex:window` 因此报错）。改为按字节 `subarray` 切片。
- **最终完整矩阵（2026-10-14 全部 21 场景）：138/138 断言通过，exit 0**，耗时 1253 秒；含
  `browse-*`、`open-*`、`restart-client-*`、`browsing-death`、`control-switch-semantics`、
  `cancel-during-window`、`codex-off-harness-session`，以及 2 类会话 × 3 类失去（控制开关 / Codex 开关 /
  冻结进程）× 3 个阶段（窗口 / 日程 / 放弃）。

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

2026-10-10 远程会话恢复重构验证：`pnpm --filter './packages/**' -r build`、`pnpm -r check`、
`node scripts/verify-dsh-plugin.mjs` 与 `git diff --check` 通过；`pnpm -r test` 全绿——
Plugin **380 通过 / 46 文件**、Protocol **234 通过 / 7 文件**、Server **49 通过 / 5 文件**、
Android **307**、WebRTC 62、Client Core 39、VS Code 13、Browser 1、Crypto 7。本轮新增
`tests/client-recovery.test.ts`（8 个，恢复目标按设备+种类+目录归一、Codex 不落回 DSH 工作区、
按 root 重匹配被改号的 Codex 工作区、Codex 单独失效不重建传输、跨 Host 的 Refresh 不抢会话、
"关闭 Codex"与"从不提供 Codex"给不同 code）与 `tests/host-control-switch.test.ts`（4 个，
控制开关两条端点都写服务端标志且写在前、reconnect 不悄悄解除暂停、写标志失败仍保持本地暂停），
并扩展 `tests/client-target-store.test.ts` 覆盖 `workspace` 字段的往返与容错。

同时修正 `fixtures/protocol/v1/account/authorization.json` 中两条与实现冲突的用例：
`reject-client-device-with-harness-version` 与 `reject-client-registration-with-host-code`
按已落地的"描述符故意不严格、`role` 被忽略"契约改为接受并断言归一化结果（`role` 被剥离、
`harnessVersion` 保留），`docs/protocol.md` §7 同步改写。这两条此前在干净工作树上也失败，
属于身份重做（去掉描述符 `role`）时漏掉的 fixture/doc 同步。

未完成的验收边界：真机跨机回归（Desktop/Android 实际开关"允许控制"与 Codex 后的自动接回）、
`werift-rtc.test.ts` 的 `lan`/`p2p` 断言在本机虚拟网卡环境下的历史失败、以及
`docs/protocol.md` §8.1.2 / `docs/server.md` / `docs/plugin-integration.md` 仍在描述已删除的
`/api/v1/devices/register-owned-role` 端点（跨仓库契约，需与独立 Server 仓库一同确认后再改）。

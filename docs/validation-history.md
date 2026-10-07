# 验证历史

按日期追加的验证记录（当时的构建、测试与实机结论）。**当前基线**摘要见 `AGENTS.md` 的
Validation Baseline 小节；这里保留过程与当时的口径，便于回溯"某个结论是哪次验证得出的"。

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

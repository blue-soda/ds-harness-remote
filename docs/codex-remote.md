# Codex Remote 技术说明

本文记录 Codex Remote 的实现边界、配置方式和当前验证状态。用户入口请看根
[README](../README.zh.md)；线协议和安全约束以 [Remote Protocol v1](protocol.md) 为准。

## 定位

Codex Remote 是现有 Remote Plugin 内的实验性可选领域，不是独立插件，也不是 Server runtime。
它复用 Remote 已有的账号授权、Host 选择、端到端加密连接和客户端入口，让用户在远端设备上打开
Host 上的 Codex 项目。

Remote 只做展示和操作转发。Codex 的 Thread、Turn、History、运行状态和审批状态继续由 Codex
App Server 管理；Remote 不导入、不复制，也不另建一套 Codex 数据库。

## 用户界面

连接 Host 后，Remote 工作区选择器可以展示 Codex 工作区。用户选择后继续使用现有 Harness 或
Android 会话界面：

- Desktop 复用 Harness 原生 Workspace、Session、Conversation、Composer、工具卡片和审批控件。
- Android 复用移动端已有 Workspace、Session、Chat、模型、权限、图片、停止和审批控件。
- Desktop Remote 选择器和 Android Workspace 页面都可选择 Host 上的真实目录并新增 Codex 项目。
- 不增加独立 Codex 页面、本地模式入口或第二套 Thread 导航。

虚拟 Workspace 和 Session 只存在于内存展示层。退出 Codex 模式、切换 Host 或断开连接时，对应
展示状态、订阅和审批状态都必须销毁。

## Workspace 来源

可见 Workspace 优先来自 Codex App Server 的 `project/list`。当该接口不可用或没有可用根目录时，
Host 可以使用 `thread/list` 已返回的绝对 `cwd` 精确生成只读后备 Workspace。

新增 Workspace 通过固定白名单中的 `project/create` 写入 Codex 项目目录。Host 只接受单个现存绝对
目录，并在调用 App Server 前执行 `realpath` 和目录类型校验；成功后 Client 重新读取 `project/list`，
不会把项目写入 DSH Workspace 存储。后备 Workspace 不支持此创建流程。

新建 Thread 的目录只能来自上述 authority root 内的真实子目录。Host 必须同时执行词法路径校验和
`realpath` 校验，拒绝 `..`、符号链接逃逸和 Client 自报的越界路径，也不得推测共同父目录。

## 数据映射

Desktop 端会把 Codex Thread 映射成临时 DSH Session，把 History 和实时 frame 映射成原生 Session
事件。Android 端直接消费同一 Codex 领域，并只在移动端内存中生成展示投影。

实时投影覆盖 assistant、reasoning、plan、命令输出、文件输出、文件变更摘要、MCP progress、
Thread 状态和模型切换。Web Search、Subagent、Image、Compaction 和 Review Mode 复用原生工具卡片。
大段实时工具输出只保留有界内存窗口；文件 patch 只传递路径和变更类型，不把原始 diff 写成
Workspace 文件内容。

History 由 Host 按 DSH 消息边界分页后再传输。Client 只在当前可见 Thread 的标题、预览、目录和
标识中做本地搜索。

## 操作与权限

Project create、Thread create、rename、archive、restore、prompt、interrupt 和 approval 操作都必须路由回 Codex App Server
的固定白名单方法。Remote 不能通过反射、任意 method name、process/config 入口或通用文件系统协议
扩权。

Web 与 Desktop Remote 的审批模式按 Thread 显示 Host 已确认的设置。尚未获知时显示沿用 Host
设置，不把 `workspace-write` 误报为已有会话的当前值。显式切换需 Host 成功确认，并同步观察者；
普通发送和 fork 不重放缓存的 preset，新 Thread 使用 `workspace-write`。纯查看只读取 Host 的
内存快照，不恢复会话；Host 重启后，尚未再次获知的模式回到未知状态。

Codex 支持文本 Prompt，以及 Desktop 剪贴板粘贴或 Android 系统图片选择器提供的 PNG、JPEG、WebP、
GIF 图片 Prompt。图片走受限的加密分块传输；通用文件附件、外部 URL、Host path 直接引用和目录写入
不开放。

权限遵循 Remote 原有 Host 边界：同账号 membership、Host identity 固定、Noise 安全通道、自适应
传输和连接隔离都必须继续成立。虚拟 Workspace/Session 不得写入 DSH SessionStore、Workspace 存储、
Harness 日志或第二份 Codex 数据存储。

## 配置

Codex 默认开启，可在 DeepSeek Remote 设置卡片中关闭，修改后需要重启 DSH。

```yaml
ds-harness-remote:
  codex:
    enabled: false
    binary: codex
```

`binary` 必须指向支持 `codex app-server` 的 Codex CLI。保持默认 `codex` 时，Plugin 会自动查找桌面
应用内置的 Codex，再回退到 `PATH`：macOS 先看当前 ChatGPT App 内置的 `codex-cli`；Windows 看
`%LOCALAPPDATA%\OpenAI\Codex\bin` 下**最新的构建目录**（应用每次更新都会换一个哈希目录，所以不能
在配置里写死路径）。显式配置的 binary 始终原样使用。

桌面应用只是这个 `codex.exe` 的**来源**：Plugin 直接以 `codex app-server` 通信，所以**不需要
运行 ChatGPT 桌面应用**（也不必开着它的窗口）就能浏览 Codex 项目、加载会话历史并对话。
应用升级会新增一个哈希目录，Plugin 每次启动按修改时间取最新，因此升级后无需改配置。

已有安装若仍使用旧的 `dsh-remote` 设置命名空间，Plugin 会一次性复制到 `ds-harness-remote`，同时
保留旧配置作为回退。

## 当前验证状态

已在真实 **Codex App Server 0.160.0** + **DSH 0.2.1-alpha.1** 上完成跨机验证（Desktop ↔ Web）：
连接、会话名称、会话历史与对话均正常，且**不需要运行 ChatGPT 桌面应用**（桌面应用只是
`codex.exe` 的来源，见上文发现规则）。此前也完成过 Desktop 跨机、Android 真机、Web → Host、
多客户端观察、大 History、Prompt、approval、interrupt 与图片分块验证；仍以实验功能发布。

Windows 上的一处已知差异已在 0.4.28 处理：Codex 会以**小写盘符**和 **8.3 短名**
（`c:\Users\SAKAKI~1\…`）报告线程目录，而工作区授权来自 `project/list` 的大写长路径，因此
路径比较在 Windows 上改为**大小写不敏感**；否则每个线程都会被判为越界并回
`CODEX_THREAD_NOT_ALLOWED`。**未验证的残留风险**：短名与长名混用目前只靠大小写归一覆盖，
若将来再次出现越界拒绝，应在此处补 `realpath` 归一。

## 版本漂移与维护

本领域贴在两个高速演进的上游上，是一层**固定契约适配层**，上游升级后需要跟着维护。三类风险：

| 上游变化 | 症状 | 改哪里 |
| --- | --- | --- |
| **Codex App Server** 方法/字段/取值变化 | 调用被拒，错误里**点名方法与字段**：`The CodeX call parameters are invalid. (thread/xxx → 字段: 类型)` | `src/codex/method-policy.ts` 白名单、`src/codex/domain.ts` 字段映射 |
| **DSH 客户端契约** 投影/基线字段变化 | 客户端控制台出现 `assertNever`、`reading 'length' of undefined`，启动期条目成片 pending | `src/codex/virtual-harness.ts` 的投影与 baseline 载荷 |
| **产品行为变化** | 历史加载失败，例如界面请求的页大小超过上限（`maxMessages: too_big`） | `CODEX_HISTORY_MAX_MESSAGES`（在 `method-policy.ts` 定义，两个历史入口共用） |

**上游升级后的自检**（Codex 或 DSH 任一升级后各跑一次，均为只读）：

```bash
node --import tsx/esm scripts/codex-app-server-smoke.mts "<codex.exe 路径>"   # 逐个调用协议面，指名失败的调用
node scripts/verify-dsh-plugin.mjs                                          # 校验 DSH bundle 契约
```

只规避 Codex 升级带来的行为变化时，可在设置卡片把 `codex.binary` **钉死**到当前可用路径
（代价是拿不到新版本特性）。

另外：Codex 领域之外的 `/api` 端点由**拥有窗口的本地 shell**回答，远端工作区的
`workspaceFiles/*` 与 `terminal/*` 才走远端 Host；这条规则让"载体拒掉本地引导"这一类
整机不可用的故障结构性消失，但**不能**保证未来 DSH 的引导顺序不变。

后续恢复策略、跨平台矩阵与长期稳定性仍以 [TODO](../TODO.md) 为准；不应把 TODO 中的目标能力
描述为已完成。


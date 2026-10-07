# Desktop 启动崩溃复盘：`desktop welcome: Web authentication failed`（2026-10-08）

## 现象

Desktop 重启后弹窗 **"The application could not start or stopped unexpectedly"**，正文是
`desktop welcome: Web authentication failed`，并指向
`…\apps\desktop\.desktop-build\development\electron-user-data\logs\crash-<ts>-host.log`。
反复重试每次都在几秒内产生一份新崩溃日志（01:42:44→01:52:37 共 6 份）。**点"禁用第三方插件"也无效**。

## 为什么禁用插件救不回来

失败发生在**任何 bundle 加载之前**，属于应用自身的启动步骤：

1. `apps/desktop/src/main.ts` → `connectDesktopWelcome(ready.url, …)`；
2. `apps/desktop/src/welcome-backend.ts`：
   ```ts
   const authenticated = await send(authenticatedUrl, { credentials: 'include' })
   if (!authenticated.ok) throw new Error('desktop welcome: Web authentication failed')
   ```
   应用用 Electron 的 `net.fetch` 去请求**它自己刚启动的 Web 服务**打印出来的 launch URL；
   只要响应不是 2xx 就直接抛错，welcome 流程中止 → 应用退出。
3. 因此 profile 里的 `bundles` / patch 与这次失败**无关** —— 禁用插件自然无效。

## 为什么"自己的 URL"会被拒

`packages/client/connection/src/browser-auth.ts`：

- `authorizeIndex()`：只有 `GET /` 且查询串里**恰好一个** `?token=` 时，才用**本次激活的密钥**
  （`initializeSecret()`，持久化在 profile 的 credentials 里）签发会话 cookie 并 303 跳转；
- `isAuthenticated()`：只接受**由当前密钥签名**、**绑定 authority（host:port）**、且在有效期内的 cookie；
- 其余一律 401。

每次启动的 Web 端口都不同（实测 56710 / 60721 / 52884 / 57834 …），而 cookie 是 **authority 绑定**的；
Electron 的会话状态（`electron-user-data`：Session Storage / Preferences 等）在多次异常退出后遗留了**陈旧会话**，
于是连应用自己发出的 launch URL 都被判为未认证 → 401 → welcome 抛错。

**决定性验证（因果而非猜测）**：把 `electron-user-data` 改名后（应用重建新会话），
下一次启动即成功 —— Electron 起来了、Web 服务在监听、**崩溃日志 0 份**、stderr 不再出现认证失败；
此前连续 6 次启动全部失败。备份保留为 `electron-user-data.bak-020001`。

## 途中撞到的两个真实、但不致命的问题

1. **定制发行版要求未发布的插件版本**：`apps/desktop/src/bundled-extras.ts` 里
   `BUNDLED_EXTRA_SPEC = '^0.4.30'`，而 `declareBundledExtras(runtimeRoot)` 在该 extra 缺失时**直接抛错**；
   那个提交 `541231da6d feat(desktop): require plugin 0.4.30`（10-07 23:07）把要求从已发布的 `^0.4.29`
   提到了当时**尚未发布**的 `^0.4.30`。它需要 registry 安装（主运行时/development project 的依赖树里都没有
   `@blue-soda/dsh-remote`），所以一旦版本不可用就会成为启动阻塞。**0.4.30 现已发布**，该阻塞解除。
2. **profile 依赖被改动后必须跑 full 启动器**：为刷新插件副本，`profiles/desktop` 被反复
   `pnpm remove/add`（其中一次 `pnpm install` 还裁掉了 4 个包）。启动器自带说明：改过依赖/运行时锁/构建后
   要跑一次 `dsh-desktop-full.cmd`（重链项目 + 校验主运行时，约 70 秒）。补跑后输出
   `No broken requirements found`。

外加一个更早的坑（已在插件仓库修掉）：`packages/plugin/tsconfig.emit.json` 的 `outDir` 指向 `dist`，
`tsc` 会**原地截断** `dist/index.js`（写成 ~20KB 的源码直出）；打包器随后用原子重命名换上新文件，
而 pnpm 装到 profile 的是**硬链接**，仍指向被截断的旧 inode → 插件加载即语法错误。修法：emit 输出改到
`dist-types/`（已加入 .gitignore），`dist/index.js` 只由打包器写。

## 结论与复发时的处置

- 本次崩溃的根因是**陈旧的 Electron 会话状态**，与插件、与 profile 配置、与账号凭证都无关；
- **磁盘凭证从未损坏**：`.dsh\.credentials.yaml` 与 `.dsh\remote\servers\<hash>\{host,client}\` 始终完整；
  唯一需要用户动作的是**重新登录一次** —— 实测 `client/server-credentials.json` 当时返回
  `HTTP 401 AUTH_INVALID`（Host 侧凭证则在启动时正常刷新），Remote 卡片因此不显示用户名/头像；
- 复发处置顺序：① 完全退出应用；② 仍报 welcome 认证失败 → 把 `electron-user-data` 改名（应用会重建）；
  ③ 用 `dsh-desktop.cmd` 启动；④ 若启动器提示依赖问题 → 跑一次 `dsh-desktop-full.cmd`；
  ⑤ 若提示缺少 `@blue-soda/dsh-remote` → 确认该版本已在 registry 上可用（本发行版要求 `^0.4.30`）。

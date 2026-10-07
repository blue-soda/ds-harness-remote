# 发布与发版清单

本仓库以 `@blue-soda/dsh-remote` 发布到 npm（GitHub 仓库同时是 DSH 的 GitHub 安装边界）。
本文记录发布入口、发版清单与两次发布的实测复盘。**仍会直接导致失败的三条硬规则**摘要见
`AGENTS.md` 的 Project Structure 小节。

## 包名、归属与安装边界

本仓库是 `liguobao/ds-harness-remote` 的 fork（MIT），npm 上的 `ds-harness-remote` 属于上游作者，
因此本 fork 以 `@blue-soda/dsh-remote` 发布。改名只涉及包名与解析入口；Cordis 实例 `id:`、插件导出的
`name`、设置命名空间、控制路由与 CLI bin 名保持不变，因此设备授权与设置不迁移。

## 发版清单

仓库根包同时是 DSH Desktop 的 GitHub 安装边界：根 `package.json` 必须保留
`dsh.bundle.patch`、Host/Client exports、CLI bin 和 `cordis.patch.yml`；GitHub 默认禁用
构建脚本，所以根 `index.js`、`packages/plugin/dist/index.js`、`client.github.js` 与
`packages/plugin/bin/ds-harness-remote.js` 是需要提交的发布入口。

**发布名与上游归属（2026-10-06）**：本仓库是 `liguobao/ds-harness-remote` 的 fork（MIT），
npm 上的 `ds-harness-remote` 属于上游作者，因此**本 fork 以 `@blue-soda/dsh-remote` 发布**。
发布入口是包目录内的 `npm publish`（`npm publish -w packages/plugin` **不可用**：npm 不读
pnpm workspace，会报 `No workspaces found`）：

```bash
cd packages/plugin && npm publish --access public
```

改名只涉及**包名与解析入口**：根与包的 `package.json`、两个 `cordis.patch.yml` 的 `name:`、
客户端 module id（`scripts/build-bundles.mjs` 与 `src/client.ts` 兜底）、两个 `dsh-plugin.json`
的 `name` 与 `source.repository`、`scripts/verify-dsh-plugin.mjs` 的包名断言。**保持不变**：
Cordis 实例 `id:`、插件导出的 `name`、设置命名空间 `ds-harness-remote`/`dsh-remote`、控制路由
`/ds-harness-remote`、CLI bin 名、`dsh-plugin.json` 的 `id` —— 因此设备授权与设置**不迁移**。
profile 迁移 = 依赖键 + `package.json` 的 `dsh.profile.bundles` 条目改新名（`cordis.patch.yml`
只按 `id` 覆盖配置，无需改）。`publishConfig` 已移除 `provenance`（本地发布无法生成 ✓），
如需 provenance 请改由 GitHub Actions 发布。上游引用**故意保留**：`docs/design/` 的上游 issue 与
`.github/release-notes.md` 中致谢的上游 PR。

**发布前必须断开硬链接**：pnpm 会让包文件与 profile 里的安装副本共享 inode，npm 打包时按 inode
去重并生成 tar 硬链接条目，而 registry 直接拒收：

```
npm error 415 Unsupported Media Type - Hard link is not allowed
```

所以 `npm publish` **之前**执行一次（重写被发布文件、各占独立 inode，内容不变）：

```bash
node scripts/break-hard-links.mjs packages/plugin
```

脚本按包的 `files` 列表遍历，成功时输出 `0 still shared`。任何重新构建或 profile 安装之后都
建议再跑一次。另注意 npm **不理解 pnpm workspace**：`npm publish -w packages/plugin` 会报
`No workspaces found`，必须进入包目录发布。

**发版清单**（`verify-version-sync.mjs` 要求**三处版本号一致**：根 `package.json`、
`packages/plugin/package.json`、`packages/plugin/src/version.ts`）：

```bash
# 1) 三处改成同一个新版本号
# 2) 构建：会校验版本一致并重新生成两个 client bundle
pnpm --filter @blue-soda/dsh-remote build
# 3) 校验 DSH bundle 契约（包名、bin、exports、patch id、客户端 module id）
node scripts/verify-dsh-plugin.mjs
# 4) 断开硬链接（否则 registry 以 415 拒收）
node scripts/break-hard-links.mjs packages/plugin
# 5) 发布（必须进包目录；scoped 包需要 --access public）
cd packages/plugin && npm publish --access public
# 6) 打 tag 并推送（推送目标是 fork 与自建 Server 的镜像）
git tag -f -a vX.Y.Z -m "ds-harness-remote X.Y.Z" && git push -f fork vX.Y.Z && git push fork main
# 7) 核对（registry 传播有几秒延迟，404 时稍等再查）
npm view @blue-soda/dsh-remote version
```

首次发布的实测记录（2026-10-06）：`@blue-soda/dsh-remote@0.4.28` ✓；期间依次遇到
E403（账号未开 2FA + `.npmrc` 里残留旧 `_authToken`，用 `npm logout` 清除并开启 2FA 后解决）
与 E415（硬链接，用上面的脚本解决）。

第二次发布记录（2026-10-06，`0.4.29`）：

- **EOTP**：开启 2FA 后，非交互式发布会在**最后一步**要求一次性密码 ✗，npm 会打印一个
  `https://www.npmjs.com/auth/cli/...` 的浏览器授权链接 ✓。该链接**只能由人工在浏览器完成** ✗
  （它的 URL 内含凭据，会被日志/工具输出屏蔽 ✓），所以发布必须由人执行，或由人提供 6 位码后用
  `npm publish --access public --otp=<码>` ✓。EOTP 发生在真正上传之前 ✓，因此失败不会留下半成品 ✓
  （可用 `npm view @blue-soda/dsh-remote version` 确认仍是旧版本 ✓）。
- **npm 会改写 `bin`**：`"ds-harness-remote": "./bin/ds-harness-remote.js"` 会在发布时被归一化为
  去掉 `./` 的写法 ✓ 并把结果**写回 `package.json`** ✓，同时打印一条 "auto-corrected … was
  invalid and removed" 警告 ✗。**该警告是虚惊** ✓：registry 元数据与实装测试（把打包结果
  `npm install -g --prefix <临时目录>` ✓ 后 `ds-harness-remote.cmd` 存在 ✓）都证明 CLI 正常 ✓。
  现已采纳 npm 的写法，`scripts/verify-dsh-plugin.mjs` 对**npm 包**断言归一化路径 ✓
  （根包不发布，保留显式路径 ✓）。
- **发布前必须先断硬链接** ✓（见上节 ✓），且重新构建/安装 profile 之后要再跑一次 ✓。

空的 Web/UI 预留目录不应创建。Expo 生成的 `.expo/web` cache、`.webp` 图片格式和 `packages/webrtc` 不属于 Remote Web 项目。

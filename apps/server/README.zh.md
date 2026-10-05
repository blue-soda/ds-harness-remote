# 自部署 Server

[English](README.md) · **中文**

单账号 Remote 中继，环境变量配置账号密码，Web 提供首页、登录和设备状态页。Server 不包含在 Host 插件 bundle 中，需要单独部署。

## 自部署页面

首页地址是 `/`，点击“开始使用”进入登录页；登录成功后进入 `/app/remote` 设备列表。Host 和客户端都填写同一个 Server 地址，并使用相同的账号密码登录。设备凭据由 Server 保存，Web 登录会话使用 HttpOnly Cookie。

## Docker 部署

```bash
cd apps/server
cp .env.example .env
# 编辑 .env，设置账号、密码和访问地址
docker compose up -d --build
```

打开 <http://localhost:8080>。设备凭据保存在 `server-data` 卷；停止使用 `docker compose down`。

发布镜像由 GitHub Tag 工作流构建。生产环境应使用 HTTPS 反向代理，不要直接把 Node 监听端口暴露到公网。

## 本地启动

需要 Node.js 22、pnpm 9.15.4。在仓库根目录执行：

```bash
pnpm install
pnpm --filter @dsh-remote/protocol build
pnpm --filter @dsh-remote/server build
cp apps/server/.env.example apps/server/.env
```

编辑 `apps/server/.env`，设置账号和至少 12 字符的密码，然后启动：

```bash
cd apps/server
node --env-file=.env dist/main.js
```

打开 <http://localhost:8080>。Host 和客户端填写同一 Server 地址，使用同一账号密码登录。建议账号使用邮箱格式，以兼容现有客户端。

| 环境变量 | 用途 / 默认值 |
| --- | --- |
| `DSH_SERVER_ACCOUNT` | 必填，启动时的种子账号（每次启动按此变量校正该账号） |
| `DSH_SERVER_PASSWORD` | 必填，至少 12 字符；修改后该账号的设备令牌失效，设备需重新授权 |
| `DSH_SERVER_REGISTRATION_CODE` | 可选，至少 12 字符。**不设置时账号注册完全关闭**；设置后可用 `POST /api/v1/auth/register` 携带该注册码自助建号 |
| `DSH_SERVER_PUBLIC_URL` | 浏览器访问地址，默认 `http://localhost:8080` |
| `DSH_SERVER_HOST` | 监听/端口映射地址，默认 `127.0.0.1`；局域网设为 `0.0.0.0` |
| `DSH_SERVER_PORT` | 默认 `8080` |
| `DSH_SERVER_DATA_FILE` | 默认 `data/state.json`，相对启动目录 |

**多账号与隔离**：设备与令牌按账号命名空间隔离——不同账号即使设备 `deviceId` 相同也互不影响，设备发现与连接配对都限定在同一账号内，跨账号查询返回 404。`DSH_SERVER_ACCOUNT` 只是启动种子账号，其余账号在重启后保留。注册默认关闭：未设置 `DSH_SERVER_REGISTRATION_CODE` 时无法建号。

**状态文件升级**：旧版单账号格式（`version: 1`）无法无损并入按账号隔离的结构（两个账号可以合法持有同一 `deviceId`）。检测到旧格式时服务会将其重命名为 `state.json.v1.bak` 并以空账号启动，**不会崩溃、不会删除数据**，代价是设备需重新注册与授权。

> 当前范围：账号自助注册只有 REST 端点，Web 页面仍只有登录与设备状态；微信 OAuth 端点尚未实现。

公网使用 HTTPS 反向代理，并将 `DSH_SERVER_PUBLIC_URL` 设为实际域名；代理需支持 `/ws/v1/connect` 的 WebSocket Upgrade，空闲超时大于 75 秒。

## 功能

- 支持多账号设备注册、凭据刷新、设备发现、Control 与端到端加密 Relay；账号间完全隔离。
- 单进程运行；持久化保存 `data` 目录。重启后设备凭据保留，Web 需重新登录；修改密码后该账号设备需重新授权。

验证：`pnpm --filter @dsh-remote/server test`。真实跨机与长期连接仍待回归。UI 复用来源见 [web/UPSTREAM.md](web/UPSTREAM.md)。

## 发布 Tag 检查

发布 Tag 必须与根 `package.json` 和 `packages/plugin/package.json` 的版本一致，例如 `v0.4.15`。Tag 工作流会执行 workspace check、测试、构建、插件 npm 打包、Browser 扩展打包和 SHA256 校验；Server Docker 镜像也从同一个 Tag 构建。

本地可先运行：

```bash
pnpm --filter './packages/**' -r build
pnpm -r check
pnpm -r test
NODE_ENV=production pnpm -r build
node scripts/verify-dsh-plugin.mjs
pnpm --dir packages/plugin pack --pack-destination /tmp/dsh-release-assets
```

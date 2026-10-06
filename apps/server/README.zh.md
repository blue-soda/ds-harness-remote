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
| `DSH_SERVER_DEEPSEEK_LOGIN` | 设为 `on` 启用 DeepSeek 账号登录端点；**默认关闭**（未启用时该端点返回 404） |
| `DSH_SERVER_DEEPSEEK_PLATFORM` | 可选，账号平台地址，默认 `https://platform.deepseek.com` |
| `DSH_SERVER_DEEPSEEK_CREATES_ACCOUNTS` | 可选，默认关。设为 `true` 时首次登录的 DeepSeek 身份会自动建号 |
| `DSH_SERVER_PASSWORD_LOGIN` | 设为 `off` 时**完全拒绝账号密码登录**（配合"只用一种登录方式"的部署） |
| `DSH_SERVER_OAUTH_PROVIDER` | 可选：`auto`（默认，优先 GitHub）/ `github` / `wechat` / `mock` / `off` |
| `DSH_SERVER_GITHUB_CLIENT_ID` | GitHub OAuth App 的 Client ID |
| `DSH_SERVER_GITHUB_CLIENT_SECRET` | 对应 Client secret（只发往 GitHub） |
| `DSH_SERVER_WECHAT_APP_ID` / `DSH_SERVER_WECHAT_APP_SECRET` | 可选，微信 provider（需企业资质与备案域名） |
| `DSH_SERVER_OAUTH_CREATES_ACCOUNTS` | 可选，默认关。设为 `true` 时首次扫码会自动建号；**此类账号没有可用口令**，只能继续扫码登录 |
| `DSH_SERVER_PUBLIC_URL` | 浏览器访问地址，默认 `http://localhost:8080` |
| `DSH_SERVER_HOST` | 监听/端口映射地址，默认 `127.0.0.1`；局域网设为 `0.0.0.0` |
| `DSH_SERVER_PORT` | 默认 `8080` |
| `DSH_SERVER_DATA_FILE` | 默认 `data/state.json`，相对启动目录 |

**多账号与隔离**：设备与令牌按账号命名空间隔离——不同账号即使设备 `deviceId` 相同也互不影响，设备发现与连接配对都限定在同一账号内，跨账号查询返回 404。`DSH_SERVER_ACCOUNT` 只是启动种子账号，其余账号在重启后保留。注册默认关闭：未设置 `DSH_SERVER_REGISTRATION_CODE` 时无法建号。

**状态文件升级**：旧版单账号格式（`version: 1`）无法无损并入按账号隔离的结构（两个账号可以合法持有同一 `deviceId`）。检测到旧格式时服务会将其重命名为 `state.json.v1.bak` 并以空账号启动，**不会崩溃、不会删除数据**，代价是设备需重新注册与授权。

**已吊销设备会累积**：插件登出时会吊销当前设备**并轮换本机身份**（新的 `deviceId` 与密钥对），所以每次登出都会给该账号留下一条已吊销记录。服务端只把 `revoked` 置位、**不做自动清理**；每账号设备数上限为 **256**，且**只在新 `deviceId` 注册时判定**（已有设备复用同一行，不占新名额）。因此**累计约 128 次登出后该账号将无法再注册新设备**（`RATE_LIMITED`），需要运维清理已吊销记录才能恢复。已吊销记录**不会出现在设备查询结果里**，用户看不到，只有运维在状态文件里能看到。需要清理时请在**服务停止后**操作：运行期间直接编辑 `state.json` 会被进程内存中的状态覆盖。机制与代价详见 [`docs/plugin-integration.md` §6.1](../docs/plugin-integration.md)。

> 当前范围：Web 页面仍只有登录与设备状态（账号自助注册与扫码登录只有 REST 端点）。

公网使用 HTTPS 反向代理，并将 `DSH_SERVER_PUBLIC_URL` 设为实际域名；代理需支持 `/ws/v1/connect` 的 WebSocket Upgrade，空闲超时大于 75 秒。

## DeepSeek 账号登录（当前部署使用）

插件现在只提供一种登录入口：**用 DSH 已登录的 DeepSeek 账号登录**。Server 端点：

```text
POST /api/v1/auth/deepseek   { token }   -> { account, token, expiresAt, ... }   与 /auth/v1/auth/login 同形
```

**它如何确认身份**：Server 拿到客户端提交的账号授权（grant）后，**自己**调用账号平台：

```text
GET {platformOrigin}/auth-api/v0/users/current
    User-Agent: <浏览器 UA>          ← WAF 要求，见下
    x-dsh-auth-token: <grant>
    x-client-*: 5 个客户端标识头
-> { code: 0, data: { biz_code: 0, biz_data: { id, email, id_profile } } }
```

`biz_data.id` 是平台稳定账号 ID，Server 用它作为绑定键，账号名为 `deepseek:<id>`。**grant 只用于这一次查询，用完即弃，不落盘。**

**因此绑定是确定性的**：同一个人无论从哪台设备、用哪个 grant 登录，平台返回同一个 `id` → 绑定到同一个 Server 账号，该账号下的设备互相可见。客户端自报的身份**不参与**绑定（伪造无效）；平台没返回 `id` 时拒绝登录，不做猜测。

**WAF 要求浏览器 UA**：`platform.deepseek.com` 前置的 WAF 对没有浏览器 User-Agent 的请求直接返回 **429**（连平台首页也一样），无论请求头是否完整。因此 `apps/server/src/deepseek.ts` 中的 `BROWSER_USER_AGENT` 是协议的一部分，不是可选的礼貌头；改动它会让所有登录失败（症状：假 token 也返回 502，而不是 401）。

**账号创建**：默认拒绝未绑定的身份（403）。设 `DSH_SERVER_DEEPSEEK_CREATES_ACCOUNTS=true` 后自动建号，账号名为 `deepseek:<id>`。

**注意登录发生在用户的机器上**：DSH 的账号授权流程要求回调地址是**环回地址**（`http://127.0.0.1:<端口>` / `localhost` / `[::1]`），DSH 自己会校验并拒绝其他来源。所以：

| 使用形态 | 能否用 DeepSeek 账号登录 |
| --- | --- |
| 用户在自己机器上运行 Desktop / `dsh web` | ✅ 可以 |
| 用户通过公网域名访问你服务器上的 Web 界面 | ❌ 不行（回调回到用户本机，那里没有 DSH） |

**当前部署的安全边界**：本部署启用了 `DSH_SERVER_DEEPSEEK_CREATES_ACCOUNTS=true` 且 `DSH_SERVER_PASSWORD_LOGIN=off`，即**任何能访问本 Server 并持有 DeepSeek 账号的人都能建号**（账号之间仍完全隔离）。若只面向特定用户，请加白名单或改为预绑定。

## GitHub 扫码登录（已实现，当前未启用）

自部署 Server 实现了与插件 `github` provider 对应的 QR OAuth 端点：

```text
POST /api/v1/auth/oauth/qr/start?provider=github   -> { qrId, scanUrl, expiresIn, provider }
GET  /api/v1/auth/oauth/qr/<qrId>                  -> { status: pending | expired | complete, token? }
GET  /api/v1/auth/oauth/github/callback            -> GitHub 回调（服务端换取 access_token 与用户 id）
```

**申请条件**：GitHub → Settings → Developer settings → **OAuth Apps → New OAuth App**，填 Homepage URL 与 **Authorization callback URL**（必须是 `https://<你的地址>/api/v1/auth/oauth/github/callback`）。**无需企业资质、无需 ICP 备案、无审核、免费**；只要回调地址与注册时一致即可。创建后拿到 Client ID，并生成一次 Client secret。

配置：

```bash
DSH_SERVER_OAUTH_PROVIDER=github
DSH_SERVER_GITHUB_CLIENT_ID=...
DSH_SERVER_GITHUB_CLIENT_SECRET=...
```

绑定标识使用 GitHub 的**数字用户 id**（不是用户名），因此用户改名不会丢失绑定。`client_secret` 只发往 GitHub，不经过客户端。

### 账号绑定规则

扫码得到的只是第三方身份。默认情况下只有**已绑定**的身份能登录（运维需先把身份绑到既有账号）；设 `DSH_SERVER_OAUTH_CREATES_ACCOUNTS=true` 后，未绑定的身份会自动建号，账号名为 `github:<id>`。

> ⚠️ **自动建号的账号没有可用口令**（内部是随机值），因此该账号**无法再用账号密码登录**，只能继续用 GitHub 扫码。若你希望用户能用任一种方式登录，请不要依赖自动建号，而是把身份绑定到已配置口令的账号上。

### 无凭据时如何验证

设 `DSH_SERVER_OAUTH_PROVIDER=mock` 启用等价的本地 provider：`scanUrl` 指向本机确认页，确认后回调写入身份，整条 QR 轮询链路与真实 GitHub 完全一致。核心测试覆盖该路径与 GitHub 的 code→token→user 交换。

### 中国大陆部署：必须解决 GitHub 出网

授权码换 token 只能在 `github.com` 上完成（`api.github.com` 没有该端点），所以**服务器必须能出网访问 `github.com`**。大陆机器上这一步常会失败，症状是：

- 用户在 GitHub 授权后跳回回调地址，浏览器**长时间挂起**，最终报"响应时间太长"；
- 服务端日志没有明确错误（请求卡在出网，直到 provider 超时）。

**根因**：GitHub 的 GeoDNS 会给大陆服务器返回亚洲节点（例如 `20.205.243.166`），而该节点在部分网络下**不可达**；换用 `223.5.5.5`、`119.29.29.29`、`8.8.8.8` 等解析器**得到的仍是同一个 IP**，因此没有 DNS 层面的解法。

**处理办法**：把 `github.com` 与 `api.github.com` 钉定到一个实测可用的 IP。

```bash
# 1. 找一个可用 IP（换成候选地址反复测，成功应稳定在 1 秒内）
curl -sS -m 8 --resolve github.com:443:140.82.112.3 -o /dev/null \
  -w "http=%{http_code} time=%{time_total}\n" https://github.com/login/oauth/access_token

# 2. 备份后钉定
cp /etc/hosts /etc/hosts.bak-$(date +%Y%m%d-%H%M%S)
printf '140.82.112.3 github.com # dsh-remote github pin\n140.82.112.5 api.github.com # dsh-remote github pin\n' >> /etc/hosts

# 3. 重启服务并验证（应返回 JSON 错误而非超时；HTTP 200/401 都算通）
systemctl restart ds-harness-remote
curl -sS -m 10 -X POST https://github.com/login/oauth/access_token \
  -H 'Content-Type: application/json' -d '{"client_id":"probe","client_secret":"probe","code":"probe"}'
curl -sS -o /dev/null -w "api=%{http_code}\n" https://api.github.com/user
```

注意事项：

- **不降低安全性**：这里钉的是 IP，TLS 仍按证书校验（`openssl s_client` 应显示 `Verify return code: 0 (ok)`），不存在中间人风险。
- **会失效**：GitHub 更换地址后需要重新测一个可用 IP；如登录突然失败，先查这里。
- **别挡住 SSH**：钉定后 `git@github.com` 仍走 22 端口。改前先确认目标 IP 的 22 端口可达（`/dev/tcp/<ip>/22`），否则服务器的 `git fetch` 会一起断掉。
- **长期方案**：把 Server 部署在境外（香港/新加坡等）可完全避免此问题，也无需 ICP 备案。

### 微信登录

`wechat` provider 实现仍保留（`DSH_SERVER_OAUTH_PROVIDER=wechat` + `DSH_SERVER_WECHAT_APP_ID/SECRET`），但**需要微信开放平台企业主体认证，且回调域名必须已 ICP 备案**，当前插件入口未启用。

### 凭据没有准备好时的替代路径

不想等微信资质，可以用**注册码 + 账号密码**：设 `DSH_SERVER_REGISTRATION_CODE`，客户端用账号密码登录，无需任何第三方平台。

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

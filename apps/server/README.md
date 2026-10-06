# Self-hosted Server

**English** · [中文](README.zh.md)

A multi-account Remote relay with a seed account configured through environment variables and sharing the same JSON-file persistence. Its Web UI includes a landing page, sign-in, and device status page. The Server is deployed separately from the Host plugin bundle.

## Self-hosted Web flow

The `/` landing page links to `/app/login`; a successful sign-in continues to `/app/remote`. Point both Host and Client at the same Server URL and use the same account and password. Device credentials are persisted by the Server, while Web sessions use an HttpOnly cookie.

## Docker deployment

```bash
cd apps/server
cp .env.example .env
# Edit .env: set your account, password, and public URL
docker compose up -d --build
```

Open <http://localhost:8080>. Device credentials persist in the `server-data` volume. Stop the service with `docker compose down`.

The GitHub Tag workflow builds the production image. Put an HTTPS reverse proxy in front of it instead of exposing the Node listener directly to the public internet.

## Local setup

Requires Node.js 22 and pnpm 9.15.4. From the repository root:

```bash
pnpm install
pnpm --filter @dsh-remote/protocol build
pnpm --filter @dsh-remote/server build
cp apps/server/.env.example apps/server/.env
```

Edit `apps/server/.env` with your account and a password of at least 12 characters, then start:

```bash
cd apps/server
node --env-file=.env dist/main.js
```

Open <http://localhost:8080>. Set the same Server URL on your Host and Client, then sign in with the same account. Use an email address as the account name for compatibility with existing clients.

| Variable | Purpose / default |
| --- | --- |
| `DSH_SERVER_ACCOUNT` | Required; the bootstrap account, re-applied on every start |
| `DSH_SERVER_PASSWORD` | Required; at least 12 characters. Changing it rotates that account's device tokens |
| `DSH_SERVER_REGISTRATION_CODE` | Optional; at least 12 characters. **Without it account registration is closed**; when set, `POST /api/v1/auth/register` accepts the code to create an account |
| `DSH_SERVER_DEEPSEEK_LOGIN` | Set to `on` to mount DeepSeek account sign-in; **off by default** (the endpoint answers 404) |
| `DSH_SERVER_DEEPSEEK_PLATFORM` | Optional account-platform origin; default `https://platform.deepseek.com` |
| `DSH_SERVER_DEEPSEEK_CREATES_ACCOUNTS` | Optional, default off. When `true`, a first-time DeepSeek identity creates its account |
| `DSH_SERVER_PASSWORD_LOGIN` | Set to `off` to refuse password sign-in entirely |
| `DSH_SERVER_OAUTH_PROVIDER` | Optional: `auto` (default, prefers GitHub) / `github` / `wechat` / `mock` / `off` |
| `DSH_SERVER_GITHUB_CLIENT_ID` | GitHub OAuth App client id |
| `DSH_SERVER_GITHUB_CLIENT_SECRET` | Matching client secret (sent only to GitHub) |
| `DSH_SERVER_WECHAT_APP_ID` / `DSH_SERVER_WECHAT_APP_SECRET` | Optional WeChat provider (needs enterprise verification and an ICP-filed callback domain) |
| `DSH_SERVER_OAUTH_CREATES_ACCOUNTS` | Optional, default off. When `true`, a first-time scan creates an account |
| `DSH_SERVER_PASSWORD_LOGIN` | Set to `off` to refuse password sign-in entirely (QR-only deployment) |
| `DSH_SERVER_PUBLIC_URL` | Browser-facing URL; default `http://localhost:8080` |
| `DSH_SERVER_HOST` | Listen / port-binding address; default `127.0.0.1`, use `0.0.0.0` for LAN access |
| `DSH_SERVER_PORT` | Default `8080` |
| `DSH_SERVER_DATA_FILE` | Default `data/state.json`, relative to the working directory |

**Accounts and isolation**: devices and tokens are namespaced per account, so the same `deviceId` may exist on several accounts and one account's password change only rotates its own tokens. Device discovery, pairing and presence are all scoped to a single account; a cross-account lookup returns 404. `DSH_SERVER_ACCOUNT` is only the bootstrap account — other accounts survive restarts. Registration is closed unless `DSH_SERVER_REGISTRATION_CODE` is set.

**State-file upgrade**: the older single-account layout (`version: 1`) cannot be merged losslessly (two accounts may legitimately hold the same `deviceId`). On detection the server renames it to `state.json.v1.bak` and starts with no accounts — it never crashes and never deletes data — at the cost of devices re-registering and reauthorizing.

**Devices and signing out**: signing out only clears the local credentials — the device is not revoked and its identity is not rotated, so signing in again **reuses the same device row** (the server invalidates that device's previous tokens during `register`). Each account holds at most **256** devices, and the limit is checked **only when a new `deviceId` registers** (an existing device reuses its row and costs no slot). The cost: after signing out the device **stays in the account** (visible while offline) and its old tokens **remain valid until the next sign-in** (access 1 hour, refresh 30 days), so signing out is not an immediate revocation. To remove a device for good or free a slot, delete its row and tokens from `state.json` **with the server stopped** — edits made while it runs are overwritten by its in-memory state. The mechanism and its cost are described in [`docs/plugin-integration.md` §6.1](../docs/plugin-integration.md).

For public access, use an HTTPS reverse proxy and set `DSH_SERVER_PUBLIC_URL` to your domain. The proxy must support WebSocket Upgrade at `/ws/v1/connect` with an idle timeout above 75 seconds.

## DeepSeek account sign-in (in use here)

The plugin now offers one sign-in entry: **the DeepSeek account DSH is already signed in with**. The Server exposes:

```text
POST /api/v1/auth/deepseek   { token }   -> { account, token, expiresAt, ... }   same shape as /api/v1/auth/login
```

**How identity is confirmed**: the Server takes the grant the client presents and asks the account platform *itself*:

```text
GET {platformOrigin}/auth-api/v0/users/current
    User-Agent: <a browser UA>      <- required by the WAF, see below
    x-dsh-auth-token: <grant>
    x-client-*: the five client identity headers
-> { code: 0, data: { biz_code: 0, biz_data: { id, email, id_profile } } }
```

`biz_data.id` is the platform's stable account id and becomes the binding key, with the account named `deepseek:<id>`. **The grant is used for that one lookup and then discarded; it is never persisted.**

**Binding is therefore deterministic**: one person signs in from any device with any grant, the platform returns the same `id`, and every device lands on the same Server account where they can see each other. Nothing the client claims takes part in the binding, so it cannot be forged; a response without an `id` is refused rather than guessed.

**The WAF requires a browser User-Agent**: the WAF in front of `platform.deepseek.com` answers **429** to any request without one — including the platform's own home page — no matter how complete the other headers are. `BROWSER_USER_AGENT` in `apps/server/src/deepseek.ts` is therefore part of the protocol, not a courtesy header; changing it breaks every sign-in (a bogus token then returns 502 instead of 401).

**Account creation** is refused by default for an unbound identity (403); `DSH_SERVER_DEEPSEEK_CREATES_ACCOUNTS=true` creates the account instead.

**Sign-in happens on the user's own machine**: DSH's account flow requires a **loopback** callback (`http://127.0.0.1:<port>`, `localhost` or `[::1]`) and rejects anything else itself. So:

| Deployment | DeepSeek account sign-in |
| --- | --- |
| The user runs Desktop or `dsh web` on their own machine | works |
| The user reaches a Web UI hosted on your server through a public domain | does not work (the callback lands on their machine, where no DSH runs) |

**Boundary of this deployment**: it sets `DSH_SERVER_DEEPSEEK_CREATES_ACCOUNTS=true` with `DSH_SERVER_PASSWORD_LOGIN=off`, so **anyone who can reach this Server and holds a DeepSeek account can create one** (accounts stay fully isolated). Restrict it with an allowlist or pre-binding if it is meant for specific people.

## GitHub QR sign-in (implemented, not currently offered)

```text
POST /api/v1/auth/oauth/qr/start?provider=github   -> { qrId, scanUrl, expiresIn, provider }
GET  /api/v1/auth/oauth/qr/<qrId>                  -> { status: pending | expired | complete, token? }
GET  /api/v1/auth/oauth/github/callback            -> GitHub callback (server exchanges the code)
```

Register an OAuth App under Settings → Developer settings → OAuth Apps and set the **Authorization callback URL** to `https://<your-host>/api/v1/auth/oauth/github/callback`. This needs no enterprise verification, no ICP filing, no review and no fee; GitHub only requires the callback URL to match the registered value. The binding uses the numeric account id, not the login name, so a rename never orphans it.

**Binding rules**: a scan yields only a third-party identity. By default only an already-bound identity may sign in; with `DSH_SERVER_OAUTH_CREATES_ACCOUNTS=true` an unbound identity creates the account `github:<id>`. Such an account has **no usable password** (internally random), so it can only ever sign in by scanning again.

**Without credentials**: `DSH_SERVER_OAUTH_PROVIDER=mock` runs an equivalent local provider whose `scanUrl` points at a confirmation page on this server, exercising the whole poll/bind/issue path. The core tests cover it plus the GitHub code→token→user exchange.

### Deploying in mainland China

The authorization-code exchange only exists on `github.com` (not `api.github.com`), so the server itself must reach `github.com`. On mainland machines this commonly fails: after authorizing, the browser hangs on the callback and finally reports a timeout, with nothing useful in the server log because the request is stuck on egress.

**Cause**: GitHub's GeoDNS hands mainland servers an Asia endpoint (for example `20.205.243.166`) that is unreachable on some networks, and every public resolver tested (`223.5.5.5`, `119.29.29.29`, `8.8.8.8`) returns that same address, so there is no DNS-side fix.

**Workaround**: pin `github.com` and `api.github.com` to a verified reachable address.

```bash
# 1. Find a working address (repeat with candidates; success should stay under a second)
curl -sS -m 8 --resolve github.com:443:140.82.112.3 -o /dev/null \
  -w "http=%{http_code} time=%{time_total}\n" https://github.com/login/oauth/access_token

# 2. Back up, then pin
cp /etc/hosts /etc/hosts.bak-$(date +%Y%m%d-%H%M%S)
printf '140.82.112.3 github.com # dsh-remote github pin\n140.82.112.5 api.github.com # dsh-remote github pin\n' >> /etc/hosts

# 3. Restart and verify (a JSON error is success; only a timeout is failure)
systemctl restart ds-harness-remote
curl -sS -m 10 -X POST https://github.com/login/oauth/access_token \
  -H 'Content-Type: application/json' -d '{"client_id":"probe","client_secret":"probe","code":"probe"}'
```

Caveats: this pins an address, not a certificate — TLS validation still applies, so there is no man-in-the-middle exposure. It breaks if GitHub changes addresses, so check it first when sign-in suddenly fails. Confirm the target's port 22 is reachable before pinning, or the server's own `git fetch` will break with it. Deploying outside mainland China removes the problem entirely.

### WeChat sign-in

The `wechat` provider is still implemented (`DSH_SERVER_OAUTH_PROVIDER=wechat` plus `DSH_SERVER_WECHAT_APP_ID`/`SECRET`), but it requires enterprise verification on the WeChat Open Platform and a callback domain that has completed ICP filing. The plugin does not offer that entry.

### When you have no third-party credentials

Use **registration code plus password** instead: set `DSH_SERVER_REGISTRATION_CODE` and clients sign in with an account and password, with no third-party platform involved.

## Features

- Multi-account device registration, credential refresh, device discovery, Control, and end-to-end encrypted Relay; accounts are fully isolated.
- QR OAuth sign-in (GitHub implemented; WeChat available), closed-by-default registration and optional password sign-in.
- Single-process operation with persistent data. Device credentials survive restarts; Web users sign in again. Changing an account's password requires that account's devices to reauthorize.

Tests: `pnpm --filter @dsh-remote/server test`. Cross-machine and long-running validation remain pending. UI sources: [web/UPSTREAM.md](web/UPSTREAM.md).

## Release Tag checks

A release tag must match the versions in the root `package.json` and `packages/plugin/package.json`, for example `v0.4.15`. The Tag workflow runs workspace checks, tests, builds, npm plugin packing, browser-extension packaging, and SHA256 checksums; the Server image is built from the same tag.

Run the checks locally before creating a tag:

```bash
pnpm --filter './packages/**' -r build
pnpm -r check
pnpm -r test
NODE_ENV=production pnpm -r build
node scripts/verify-dsh-plugin.mjs
pnpm --dir packages/plugin pack --pack-destination /tmp/dsh-release-assets
```

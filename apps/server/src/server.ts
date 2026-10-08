import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { deviceRegistrationRequestSchema, deviceRefreshRequestSchema } from '@dsh-remote/protocol'
import { ApiError, Store, equal, hash, secret } from './store.js'
import { Gateway } from './gateway.js'
import { ServerLog, type ServerLogOptions } from './log.js'
import { resolveOAuthProvider, type OAuthProvider, type OAuthProviderConfig } from './oauth.js'
import { createDeepSeekVerifier, type DeepSeekLoginOptions } from './deepseek.js'

export interface Config {
  /** Bootstrap account seeded on every start; its password change rotates that account's tokens. */
  account: string
  password: string
  dataFile: string
  publicUrl: string
  /**
   * Self-service registration code. Absent (the default) closes account
   * registration entirely, so accounts can only be seeded from configuration.
   */
  registrationCode?: string
  /** QR OAuth provider selection; `auto` needs WeChat credentials to be active. */
  oauth?: OAuthProviderConfig
  /**
   * Whether a first-time QR login may create an account. Off by default: an
   * unknown subject is refused so scanning a code cannot mint an account.
   */
  oauthCreatesAccounts?: boolean
  /**
   * Refuse `POST /api/v1/auth/login` for every account. Set this when QR OAuth
   * is the only intended sign-in path, so no second credential can diverge from
   * the bound identity. The bootstrap account is still seeded (it can hold
   * devices and be reachable), it just cannot be entered by password.
   */
  passwordLoginDisabled?: boolean
  /** Overrides fetch for the WeChat token exchange; used by tests. */
  oauthFetch?: typeof fetch
  /**
   * DeepSeek account login. Absent (the default) leaves the endpoint unmounted;
   * the grant a client presents is verified against the platform and discarded.
   */
  deepseek?: DeepSeekLoginOptions
  /**
   * Lifecycle log. Absent (the default) writes nothing to disk. The file is capped by
   * rotation, so a long-running service cannot fill the disk with diagnostics.
   */
  log?: ServerLogOptions
  /** Control-heartbeat cadence and the peer silence it tolerates; see the Gateway defaults. */
  heartbeat?: { intervalMs?: number; peerTimeoutMs?: number }
}
const loginSchema = z.object({ email: z.string().min(1).max(254), password: z.string().min(1).max(1024) }).strict()
/** A platform account grant, treated as an opaque bearer value. */
const deepseekSchema = z.object({ token: z.string().min(1).max(4096) }).strict()
const registerSchema = z.object({
  email: z.string().min(1).max(254),
  password: z.string().min(12).max(1024),
  code: z.string().max(256).optional(),
}).strict()
const ACCOUNT_LIMIT = 256
const publicDir = fileURLToPath(new URL('../dist/public/', import.meta.url))
function readAssets(): Map<string, Buffer> {
  if (!existsSync(publicDir)) return new Map()
  const assets = new Map<string, Buffer>()
  for (const entry of readdirSync(publicDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const file = join(entry.parentPath, entry.name)
    const path = file.slice(publicDir.length).replaceAll('\\', '/')
    assets.set(path, readFileSync(file))
  }
  return assets
}
async function body(req: IncomingMessage): Promise<unknown> {
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new ApiError('INVALID_MESSAGE', 415)
  let length = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    length += chunk.length
    if (length > 16384) throw new ApiError('FRAME_TOO_LARGE', 413)
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new ApiError('INVALID_MESSAGE') }
}
export function createRemoteServer(config: Config) {
  if (!config.account.trim() || config.password.length < 12) throw new Error('DSH_SERVER_ACCOUNT and DSH_SERVER_PASSWORD (at least 12 characters) are required.')
  const url = new URL(config.publicUrl)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('DSH_SERVER_PUBLIC_URL must be an HTTP(S) origin.')
  const bootstrapAccount = config.account.trim()
  const store = new Store(config.dataFile)
  // Seed (or re-key) the configured account. Other accounts survive restarts,
  // and a changed password only rotates that one account's tokens.
  store.upsertAccount(bootstrapAccount, config.password)
  const assets = readAssets()
  const oauth = config.oauth === undefined
    ? undefined
    : resolveOAuthProvider(config.oauth, config.oauthFetch)
  const deepseek = config.deepseek === undefined ? undefined : createDeepSeekVerifier(config.deepseek)
  /** Pending QR authorizations: qrId -> expiry and the origin that started it. */
  const qrSessions = new Map<string, { expires: number; origin: string; claimed?: string }>()
  /** Web sessions: digest -> owning account and expiry. */
  const sessions = new Map<string, { account: string; expires: number }>()
  const limits = new Map<string, { count: number; until: number }>()
  function rate(key: string, max: number) {
    for (const [k, v] of limits) if (v.until < Date.now()) limits.delete(k)
    let entry = limits.get(key)
    if (!entry) { if (limits.size >= 4096) throw new ApiError('RATE_LIMITED', 429); entry = { count: 0, until: Date.now() + 60_000 }; limits.set(key, entry) }
    if (++entry.count > max) throw new ApiError('RATE_LIMITED', 429)
  }
  function token(req: IncomingMessage): string {
    const authorization = req.headers.authorization
    if (authorization) return authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
    return /(?:^|;\s*)dsh_session=([A-Za-z0-9_-]+)/.exec(req.headers.cookie ?? '')?.[1] ?? ''
  }
  /** Resolve the account a web session cookie or account token speaks for. */
  function sessionAccount(req: IncomingMessage): string {
    const key = hash(token(req))
    const session = sessions.get(key)
    if (session === undefined || session.expires <= Date.now()) { sessions.delete(key); throw new ApiError('ACCOUNT_AUTH_REQUIRED', 401) }
    return session.account
  }
  function deviceAuth(req: IncomingMessage) {
    if (!req.headers.authorization?.startsWith('Bearer ')) throw new ApiError('AUTH_REQUIRED', 401)
    return store.authenticate(req.headers.authorization.slice(7))
  }
  function cookie(value: string, age: number): string { return `dsh_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${url.protocol === 'https:' ? '; Secure' : ''}` }
  const profile = (accountName: string) => ({ account: accountName, profile: { displayName: accountName }, isAdmin: false })
  /** Open a web session for an account and set its cookie. */
  function issueSession(res: ServerResponse, accountName: string): { token: string; expiresAt: number } {
    for (const [key, session] of sessions) if (session.expires <= Date.now()) sessions.delete(key)
    if (sessions.size >= 4096) throw new ApiError('RATE_LIMITED', 429)
    const value = secret(), expiresAt = Date.now() + 8 * 3600_000
    sessions.set(hash(value), { account: accountName, expires: expiresAt })
    res.setHeader('Set-Cookie', cookie(value, 8 * 3600))
    return { token: value, expiresAt }
  }
  const server = createServer({ requestTimeout: 15000, headersTimeout: 10000 }, (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
    void route(req, res).catch(error => {
      if (res.headersSent || res.destroyed) return
      const e = error instanceof ApiError ? error : error instanceof z.ZodError ? new ApiError('INVALID_MESSAGE') : new ApiError('INTERNAL_ERROR', 500)
      if (e.status === 429) res.setHeader('Retry-After', '60')
      json(res, e.status, { error: { code: e.code, message: e.code, requestId: randomUUID(), retryable: e.status === 429 || e.status >= 500 } })
    })
  })
  const log = config.log === undefined ? undefined : new ServerLog(config.log)
  const gateway = new Gateway(server, store, url.origin, log, config.heartbeat)
  function descriptor(d: ReturnType<Store['get']>) {
    return {
      ...d.descriptor,
      // Membership is account-scoped, so ids from different accounts never collide.
      membershipId: `account:${hash(d.account).slice(0, 16)}`,
      online: gateway.isOnline(d.account, d.descriptor.deviceId),
      // Lets a client show which devices would refuse control before it tries to connect.
      hostControl: d.hostControl !== false,
      lastSeenAt: d.lastSeenAt,
      account: d.account,
    }
  }
  /**
   * Finish a provider callback: bind the external identity to an account, mark
   * the pending session claimed, and send the browser to the waiting client.
   *
   * An unknown subject is refused unless account creation from QR login was
   * explicitly enabled, so scanning a code can never mint an account silently.
   */
  async function finishOAuthCallback(
    provider: OAuthProvider,
    request: URL,
    res: ServerResponse,
  ): Promise<void> {
    const state = request.searchParams.get('state')
    const session = state === null ? undefined : qrSessions.get(state)
    if (state === null || session === undefined || session.expires <= Date.now()) {
      throw new ApiError('METHOD_NOT_FOUND', 404)
    }
    let identity
    try {
      identity = await provider.complete(request.searchParams)
    } catch {
      // Expire the pending session so the waiting client reports an expired code
      // instead of polling forever after a provider that never answered.
      session.expires = 0
      throw new ApiError('CONNECTION_FAILED', 502)
    }
    if (identity === undefined) {
      session.expires = 0
      throw new ApiError('AUTH_INVALID', 403)
    }

    // Only the pending session's own origin is trustworthy for the redirect.
    const returnTo = sameOriginReturnTo(session.origin, request.searchParams.get('returnTo') ?? undefined)
    const redirect = new URL(returnTo)
    redirect.searchParams.set('signedIn', '1')

    const link = `${provider.name}:${identity.subject}`
    let accountName = store.findAccountByOAuth(link)
    if (accountName === undefined) {
      if (config.oauthCreatesAccounts !== true) {
        redirect.searchParams.set('error', 'oauth-unlinked')
        res.writeHead(303, { Location: redirect.toString() }); res.end(); return
      }
      const accounts = store.listAccounts()
      if (accounts.length >= ACCOUNT_LIMIT) throw new ApiError('RATE_LIMITED', 429)
      accountName = `${provider.name}:${identity.subject}`
      store.upsertAccount(accountName, secret())
    }
    store.linkOAuth(accountName, link)
    session.claimed = accountName
    res.writeHead(303, { Location: redirect.toString() }); res.end()
  }

  async function route(req: IncomingMessage, res: ServerResponse) {
    const path = new URL(req.url ?? '/', url).pathname
    const method = req.method
    if (req.headers.origin && req.headers.origin !== url.origin) throw new ApiError('AUTH_INVALID', 403)
    if (req.headers['sec-fetch-site'] === 'cross-site') throw new ApiError('AUTH_INVALID', 403)
    const staticAsset = path.startsWith('/assets/') || ['/icon.png', '/brand-whale.webp', '/landing-atmosphere.webp'].includes(path)
    if (method === 'GET' && (['/', '/app', '/app/login'].includes(path) || staticAsset)) {
      const name = staticAsset ? path.slice(1) : 'index.html'
      const asset = assets.get(name)
      if (!asset) throw new ApiError('METHOD_NOT_FOUND', 404)
      const contentType = name.endsWith('.js') ? 'text/javascript; charset=utf-8' : name.endsWith('.css') ? 'text/css; charset=utf-8' : name.endsWith('.png') ? 'image/png' : name.endsWith('.webp') ? 'image/webp' : 'text/html; charset=utf-8'
      res.setHeader('Content-Type', contentType)
      res.end(asset); return
    }
    if (method === 'GET' && (path === '/health' || path === '/healthz' || path === '/ready')) { json(res, 200, { status: 'ok' }); return }
    rate(`api:${req.socket.remoteAddress ?? ''}`, 240)
    if (method === 'POST' && path === '/api/v1/auth/login') {
      rate(`login:${req.socket.remoteAddress ?? ''}`, 20)
      // A QR-only deployment refuses password entry outright, so the bound
      // external identity stays the single source of truth for the account.
      if (config.passwordLoginDisabled === true) throw new ApiError('METHOD_NOT_ALLOWED', 403)
      const credentials = loginSchema.parse(await body(req))
      const accountName = credentials.email.trim()
      if (!store.verifyAccount(accountName, credentials.password)) throw new ApiError('AUTH_INVALID', 401)
      const session = issueSession(res, accountName)
      json(res, 200, { ...profile(accountName), ...session }); return
    }
    if (method === 'POST' && path === '/api/v1/auth/deepseek') {
      if (deepseek === undefined) throw new ApiError('METHOD_NOT_FOUND', 404)
      rate(`deepseek:${req.socket.remoteAddress ?? ''}`, 30)
      const { token } = deepseekSchema.parse(await body(req))
      // The grant is only ever used to ask the platform who it belongs to. It is
      // not stored, so a compromised Server yields accounts, not DeepSeek access.
      let identity
      try {
        identity = await deepseek.verify(token)
      } catch {
        throw new ApiError('CONNECTION_FAILED', 502)
      }
      if (identity === undefined) throw new ApiError('AUTH_INVALID', 401)
      const link = `deepseek:${identity.subject}`
      let accountName = store.findAccountByOAuth(link)
      if (accountName === undefined) {
        if (config.deepseek?.createsAccounts !== true) throw new ApiError('AUTH_INVALID', 403)
        if (store.listAccounts().length >= ACCOUNT_LIMIT) throw new ApiError('RATE_LIMITED', 429)
        accountName = link
        store.upsertAccount(accountName, secret())
      }
      store.linkOAuth(accountName, link)
      json(res, 200, { ...profile(accountName), ...issueSession(res, accountName) }); return
    }
    if (method === 'POST' && path === '/api/v1/auth/register') {
      rate(`register:${req.socket.remoteAddress ?? ''}`, 10)
      const registration = registerSchema.parse(await body(req))
      // Closed unless a registration code is configured; compare in constant time.
      if (config.registrationCode === undefined || config.registrationCode === ''
        || registration.code === undefined || !equal(registration.code, config.registrationCode)) {
        throw new ApiError('AUTH_INVALID', 403)
      }
      const accountName = registration.email.trim()
      if (!store.listAccounts().includes(accountName) && store.listAccounts().length >= ACCOUNT_LIMIT) throw new ApiError('RATE_LIMITED', 429)
      store.upsertAccount(accountName, registration.password)
      const session = issueSession(res, accountName)
      json(res, 200, { ...profile(accountName), ...session }); return
    }
    if (method === 'POST' && path === '/api/v1/auth/oauth/qr/start') {
      if (oauth === undefined) throw new ApiError('METHOD_NOT_FOUND', 404)
      const requested = new URL(req.url ?? '/', url).searchParams.get('provider')
      // The provider reports its own name; a mismatch is a client bug worth surfacing.
      if (requested !== null && requested !== oauth.name) throw new ApiError('METHOD_NOT_FOUND', 404)
      rate(`oauth:${req.socket.remoteAddress ?? ''}`, 60)
      for (const [key, session] of qrSessions) if (session.expires <= Date.now()) qrSessions.delete(key)
      if (qrSessions.size >= 256) throw new ApiError('RATE_LIMITED', 429)
      const qrId = `${oauth.name}-qr-${secret()}`
      const expiresIn = 600
      qrSessions.set(qrId, { expires: Date.now() + expiresIn * 1_000, origin: url.origin })
      json(res, 200, {
        qrId,
        scanUrl: oauth.scanUrl({ qrId, origin: url.origin }),
        expiresIn,
        provider: oauth.name,
      }); return
    }
    if (method === 'GET' && path.startsWith('/api/v1/auth/oauth/qr/')) {
      if (oauth === undefined) throw new ApiError('METHOD_NOT_FOUND', 404)
      const qrId = decodeURIComponent(path.slice('/api/v1/auth/oauth/qr/'.length))
      const session = qrSessions.get(qrId)
      // An unknown id is reported as expired rather than as a protocol error: the
      // pending map is in-memory, so a restart drops sessions, and a client that
      // polls a second time after an expiry would otherwise surface a raw
      // METHOD_NOT_FOUND. Answering "expired" leaks nothing an id probe could use.
      if (session === undefined) { json(res, 200, { status: 'expired' }); return }
      if (session.expires <= Date.now()) { qrSessions.delete(qrId); json(res, 200, { status: 'expired' }); return }
      if (session.claimed === undefined) { json(res, 200, { status: 'pending' }); return }
      // Claim once: the account token is minted on the first poll after completion.
      const accountName = session.claimed
      qrSessions.delete(qrId)
      json(res, 200, { status: 'complete', ...issueSession(res, accountName) }); return
    }
    if (oauth?.name === 'mock' && path === '/api/v1/auth/oauth/mock/confirm') {
      if (method === 'GET') {
        const state = new URL(req.url ?? '/', url).searchParams.get('state') ?? ''
        const session = qrSessions.get(state)
        if (session === undefined || session.expires <= Date.now()) throw new ApiError('METHOD_NOT_FOUND', 404)
        sendHtml(res, 200, mockConfirmPage('operator', state)); return
      }
      if (method === 'POST') {
        const form = await readForm(req)
        const state = form.get('state') ?? ''
        const subject = (form.get('subject') ?? '').trim()
        const session = qrSessions.get(state)
        if (session === undefined || session.expires <= Date.now()) throw new ApiError('METHOD_NOT_FOUND', 404)
        if (subject === '') throw new ApiError('INVALID_MESSAGE')
        const callback = new URL(oauth.callbackUrl({ qrId: state, origin: session.origin }))
        callback.searchParams.set('subject', subject)
        callback.searchParams.set('returnTo', `${session.origin}/app/remote`)
        res.writeHead(303, { Location: callback.toString() }); res.end(); return
      }
    }
    const callbackPath = oauth === undefined ? undefined : new URL(oauth.callbackUrl({ qrId: 'x', origin: url.origin })).pathname
    const activeProvider = oauth
    if (method === 'GET' && callbackPath !== undefined && path === callbackPath && activeProvider !== undefined) {
      await finishOAuthCallback(activeProvider, new URL(req.url ?? '/', url), res); return
    }
    if (method === 'GET' && path === '/api/v1/auth/me') { const accountName = sessionAccount(req); json(res, 200, profile(accountName)); return }
    if (method === 'POST' && path === '/api/v1/auth/logout') {
      sessions.delete(hash(token(req))); res.setHeader('Set-Cookie', cookie('', 0)); json(res, 200, { status: 'ok' }); return
    }
    if (method === 'GET' && path === '/api/v1/account/devices') {
      const accountName = sessionAccount(req)
      json(res, 200, { items: store.devicesFor(accountName).map(descriptor), serverUrl: url.origin, transport: 'relay' }); return
    }
    if (method === 'POST' && (path === '/api/v1/devices/register' || path === '/api/v1/devices/register-owned-role')) {
      const source = path.endsWith('register-owned-role') ? deviceAuth(req) : undefined
      const accountName = source === undefined ? sessionAccount(req) : source.account
      const { device } = deviceRegistrationRequestSchema.parse(await body(req))
      // A device may register itself: with one identity per installation the client and host halves present the
      // same id and role, so the old "same id or same role" refusal rejected every sign-in. A device registering
      // its own id falls through to `store.register`, which still pins the identity key; a *different* device
      // claiming this role stays refused.
      if (source && source.descriptor.deviceId !== device.deviceId && source.descriptor.role === device.role) {
        throw new ApiError('PEER_IDENTITY_MISMATCH', 409)
      }
      json(res, 200, store.register(accountName, device)); return
    }
    if (method === 'POST' && path === '/api/v1/auth/refresh') {
      const data = deviceRefreshRequestSchema.parse(await body(req))
      json(res, 200, store.refresh(data.deviceId, data.refreshToken)); return
    }
    if (method === 'DELETE' && path === '/api/v1/devices/self') {
      const source = deviceAuth(req)
      store.revoke(source.descriptor.deviceId); json(res, 200, { status: 'revoked' }); return
    }
    if (method === 'POST' && path === '/api/v1/devices/self/control') {
      const source = deviceAuth(req)
      const requested = await body(req) as { enabled?: unknown }
      if (typeof requested.enabled !== 'boolean') throw new ApiError('INVALID_MESSAGE')
      store.setHostControl(source.descriptor.deviceId, requested.enabled)
      // Switching control off has to take effect now, not at the next hello: drop the host connection, and
      // the flag above keeps it from coming back until the device asks again.
      if (!requested.enabled) gateway.disconnectHost(source.account, source.descriptor.deviceId, 'CONTROL_DISABLED')
      json(res, 200, { hostControl: requested.enabled }); return
    }
    if (method === 'GET' && path === '/api/v1/me') { json(res, 200, descriptor(deviceAuth(req))); return }
    if (method === 'GET' && path === '/api/v1/devices') {
      const source = deviceAuth(req)
      // Discovery is account-scoped: any signed-in device sees its own account's hosts. The stored role used to
      // have to be 'client', which locked out unified devices - their row is registered as a host.
      const items = store.devicesFor(source.account).filter(d => d.descriptor.role === 'host').map(d => {
        const { identityKey: _key, ...item } = descriptor(d)
        return item
      })
      json(res, 200, { items, nextCursor: null }); return
    }
    const match = /^\/api\/v1\/devices\/([^/]+)(\/presence)?$/.exec(path)
    if (method === 'GET' && match) {
      // Account scope is enforced by the lookup itself; requiring the two roles to differ locked a device out
      // of its own account now that one identity covers both halves.
      const source = deviceAuth(req), target = store.get(match[1]!, source.account)
      const d = descriptor(target)
      json(res, 200, match[2] ? { deviceId: d.deviceId, online: d.online, lastSeenAt: d.lastSeenAt } : d); return
    }
    throw new ApiError('METHOD_NOT_FOUND', 404)
  }
  log?.info('server.started', { publicUrl: url.origin, logFiles: log.paths(), dataFile: config.dataFile })
  return { server, store, gateway, close: async () => { log?.info('server.stopped', {}); gateway.close(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) } }
}
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value))
}
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => (
    character === '&' ? '&amp;'
      : character === '<' ? '&lt;'
        : character === '>' ? '&gt;'
          : character === '"' ? '&quot;'
            : '&#39;'
  ))
}
function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(html)
}
/** Only the pending session's own origin may receive the confirmation redirect. */
function sameOriginReturnTo(origin: string, value: string | undefined): string {
  if (value === undefined) return `${origin}/`
  try {
    const url = new URL(value, origin)
    return url.origin === origin ? url.toString() : `${origin}/`
  } catch { return `${origin}/` }
}
async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
}
/** Minimal local confirmation page used by the mock provider only. */
function mockConfirmPage(subject: string, state: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Confirm QR login</title></head>`
    + `<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem">`
    + `<h1 style="font-size:1.25rem">Confirm QR login</h1>`
    + `<p>This page stands in for WeChat while no credentials are configured. Confirming signs in as `
    + `<strong>${escapeHtml(subject)}</strong> and finishes the QR login in the waiting client.</p>`
    + `<form method="post"><input type="hidden" name="state" value="${escapeHtml(state)}">`
    + `<label>Subject <input name="subject" value="${escapeHtml(subject)}" required maxlength="128"></label> `
    + `<button type="submit">Confirm</button></form></body></html>`
}

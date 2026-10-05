import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { createRemoteServer } from '../src/server.js'
import { createGithubProvider, createWeixinProvider } from '../src/oauth.js'

const account = 'owner@example.com', password = 'local-test-password'
let app: ReturnType<typeof createRemoteServer> | undefined, dir: string, base: string

type ServerConfig = Parameters<typeof createRemoteServer>[0]

/**
 * Boot a server on an ephemeral port, then rebuild it with the real origin.
 *
 * Production configures one absolute `publicUrl`; a test cannot know its port up
 * front, and redirect targets must match the origin the server actually serves.
 */
async function start(overrides: Partial<ServerConfig> = {}): Promise<void> {
  const dataFile = join(dir, 'state.json')
  const probe = createRemoteServer({ account, password, dataFile, publicUrl: 'http://127.0.0.1:8080', ...overrides })
  probe.server.listen(0, '127.0.0.1'); await once(probe.server, 'listening')
  const port = (probe.server.address() as { port: number }).port
  await probe.close()
  base = `http://127.0.0.1:${port}`
  app = createRemoteServer({ account, password, dataFile, publicUrl: base, ...overrides })
  app.server.listen(port, '127.0.0.1'); await once(app.server, 'listening')
}
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dsh-oauth-')) })
afterEach(async () => {
  // The provider-only cases never start a server.
  await app?.close()
  app = undefined
  rmSync(dir, { recursive: true, force: true })
})

describe('QR OAuth login', () => {
  it('reports the endpoint as missing while no provider is configured', async () => {
    await start()
    const response = await fetch(`${base}/api/v1/auth/oauth/qr/start?provider=wechat`, { method: 'POST' })
    expect(response.status).toBe(404)
    expect((await response.json()).error.code).toBe('METHOD_NOT_FOUND')
  })

  it('refuses a provider name this server does not serve', async () => {
    await start({ oauth: { provider: 'mock' } })
    const response = await fetch(`${base}/api/v1/auth/oauth/qr/start?provider=github`, { method: 'POST' })
    expect(response.status).toBe(404)
  })

  it('completes a mock scan for a bound identity and mints one account token', async () => {
    await start({ oauth: { provider: 'mock' } })
    // An operator binds a WeChat subject to an existing account once, out of band.
    app.store.upsertAccount('oauth-user', 'oauth-user-password-value')
    app.store.linkOAuth('oauth-user', 'mock:operator-openid')
    const startResponse = await fetch(`${base}/api/v1/auth/oauth/qr/start`, { method: 'POST' })
    expect(startResponse.status).toBe(200)
    const session = await startResponse.json() as { qrId: string; scanUrl: string; expiresIn: number; provider: string }
    expect(session.provider).toBe('mock')
    expect(session.qrId.length).toBeGreaterThanOrEqual(20)
    expect(session.expiresIn).toBeGreaterThan(0)

    const pendingResponse = await fetch(`${base}/api/v1/auth/oauth/qr/${encodeURIComponent(session.qrId)}`)
    expect(await pendingResponse.json()).toEqual({ status: 'pending' })

    // Simulate the browser confirming the scan with a provider subject.
    const confirm = await fetch(`${base}/api/v1/auth/oauth/mock/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ state: session.qrId, subject: 'operator-openid' }).toString(),
      redirect: 'manual',
    })
    expect(confirm.status).toBe(303)
    const callbackUrl = new URL(confirm.headers.get('location')!)
    const finished = await fetch(callbackUrl, { redirect: 'manual' })
    expect(finished.status).toBe(303)

    const completed = await (await fetch(`${base}/api/v1/auth/oauth/qr/${encodeURIComponent(session.qrId)}`)).json() as { status: string; token: string }
    expect(completed.status).toBe('complete')
    expect(completed.token.length).toBeGreaterThanOrEqual(16)

    // The minted account token authenticates the profile endpoint…
    const me = await fetch(`${base}/api/v1/auth/me`, { headers: { Authorization: `Bearer ${completed.token}` } })
    expect(me.status).toBe(200)
    // …and the claim is single-use.
    expect((await fetch(`${base}/api/v1/auth/oauth/qr/${encodeURIComponent(session.qrId)}`)).status).toBe(404)
  })

  it('does not create an account for an unbound identity unless explicitly enabled', async () => {
    await start({ oauth: { provider: 'mock' } })
    const session = await (await fetch(`${base}/api/v1/auth/oauth/qr/start`, { method: 'POST' })).json() as { qrId: string }
    const confirm = await fetch(`${base}/api/v1/auth/oauth/mock/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ state: session.qrId, subject: 'stranger-openid' }).toString(),
      redirect: 'manual',
    })
    const finished = await fetch(new URL(confirm.headers.get('location')!), { redirect: 'manual' })
    expect(finished.headers.get('location')).toContain('error=oauth-unlinked')
    // The account list is unchanged: still only the seeded account.
    expect(app.store.listAccounts()).toEqual([account])
    // The session stays pending, so the client keeps waiting instead of signing in.
    expect(await (await fetch(`${base}/api/v1/auth/oauth/qr/${encodeURIComponent(session.qrId)}`)).json()).toEqual({ status: 'pending' })
  })

  it('links a subject on the first scan when account creation is enabled', async () => {
    await start({ oauth: { provider: 'mock' }, oauthCreatesAccounts: true })
    const session = await (await fetch(`${base}/api/v1/auth/oauth/qr/start`, { method: 'POST' })).json() as { qrId: string }
    const confirm = await fetch(`${base}/api/v1/auth/oauth/mock/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ state: session.qrId, subject: 'newcomer-openid' }).toString(),
      redirect: 'manual',
    })
    await fetch(new URL(confirm.headers.get('location')!), { redirect: 'manual' })
    const completed = await (await fetch(`${base}/api/v1/auth/oauth/qr/${encodeURIComponent(session.qrId)}`)).json() as { status: string }
    expect(completed.status).toBe('complete')
    expect(app.store.listAccounts()).toContain('mock:newcomer-openid')
  })
})

describe('WeChat provider', () => {
  it('builds an snsapi_login URL carrying the session state', () => {
    const provider = createWeixinProvider({ appId: 'wx-app-id', appSecret: 'app-secret-value' })
    const url = new URL(provider.scanUrl({ qrId: 'session-1', origin: 'https://remote.example.com' }))
    expect(url.origin + url.pathname).toBe('https://open.weixin.qq.com/connect/qrconnect')
    expect(url.searchParams.get('appid')).toBe('wx-app-id')
    expect(url.searchParams.get('scope')).toBe('snsapi_login')
    expect(url.searchParams.get('state')).toBe('session-1')
    expect(url.searchParams.get('redirect_uri')).toBe('https://remote.example.com/api/v1/auth/oauth/wechat/callback')
  })

  it('exchanges the callback code for the openid and ignores an error payload', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input))
      expect(url.searchParams.get('code')).toBe('one-time-code')
      return new Response(JSON.stringify({ openid: 'openid-value', nickname: 'Ada' }), { status: 200 })
    })
    const provider = createWeixinProvider({ appId: 'wx-app-id', appSecret: 'app-secret-value', fetchImpl: fetchMock as unknown as typeof fetch })

    await expect(provider.complete(new URLSearchParams({ code: 'one-time-code' })))
      .resolves.toEqual({ subject: 'openid-value', displayName: 'Ada' })
    // A cancel or a refused code yields no identity rather than throwing.
    await expect(provider.complete(new URLSearchParams({}))).resolves.toBeUndefined()

    const failing = createWeixinProvider({
      appId: 'wx-app-id', appSecret: 'app-secret-value',
      fetchImpl: (async () => new Response(JSON.stringify({ errcode: 40029 }), { status: 200 })) as unknown as typeof fetch,
    })
    await expect(failing.complete(new URLSearchParams({ code: 'bad' }))).resolves.toBeUndefined()
  })
})

describe('GitHub provider', () => {
  it('builds an authorize URL with the callback GitHub must have registered', () => {
    const provider = createGithubProvider({ clientId: 'gh-client-id', clientSecret: 'gh-secret-value' })
    const url = new URL(provider.scanUrl({ qrId: 'session-2', origin: 'https://sakakibara.ink:8443' }))
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize')
    expect(url.searchParams.get('client_id')).toBe('gh-client-id')
    expect(url.searchParams.get('state')).toBe('session-2')
    expect(url.searchParams.get('redirect_uri')).toBe('https://sakakibara.ink:8443/api/v1/auth/oauth/github/callback')
  })

  it('exchanges the code and identifies the account by numeric id, not the login name', async () => {
    const calls: string[] = []
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      calls.push(url)
      if (url === 'https://github.com/login/oauth/access_token') {
        // The secret is posted server-side and never appears in a URL.
        expect(String(init?.body)).toContain('gh-secret-value')
        return new Response(JSON.stringify({ access_token: 'gh-token' }), { status: 200 })
      }
      if (url === 'https://api.github.com/user') {
        expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer gh-token')
        return new Response(JSON.stringify({ id: 4242, login: 'octocat', name: 'Mona' }), { status: 200 })
      }
      throw new Error(`unexpected request: ${url}`)
    })
    const provider = createGithubProvider({
      clientId: 'gh-client-id', clientSecret: 'gh-secret-value', fetchImpl: fetchMock as unknown as typeof fetch,
    })

    await expect(provider.complete(new URLSearchParams({ code: 'one-time-code' })))
      .resolves.toEqual({ subject: '4242', displayName: 'Mona' })
    expect(calls).toEqual(['https://github.com/login/oauth/access_token', 'https://api.github.com/user'])

    // A cancel, a refused token and a payload without an id all yield no identity.
    await expect(provider.complete(new URLSearchParams({}))).resolves.toBeUndefined()
    const refused = createGithubProvider({
      clientId: 'gh-client-id', clientSecret: 'gh-secret-value',
      fetchImpl: (async () => new Response(JSON.stringify({ error: 'bad_verification_code' }), { status: 200 })) as unknown as typeof fetch,
    })
    await expect(refused.complete(new URLSearchParams({ code: 'bad' }))).resolves.toBeUndefined()
  })
})

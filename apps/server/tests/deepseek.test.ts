import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { createRemoteServer } from '../src/server.js'
import { createDeepSeekVerifier } from '../src/deepseek.js'

const account = 'owner@example.com', password = 'local-test-password'
let app: ReturnType<typeof createRemoteServer> | undefined, dir: string, base: string, dataFile: string

/** One platform profile response in the platform's own envelope. */
function profilePayload(id: string, overrides: Record<string, unknown> = {}) {
  return {
    code: 0,
    data: {
      biz_code: 0,
      biz_data: { id, email: 'person@example.com', id_profile: { name: 'Ada', picture: null }, ...overrides },
    },
  }
}

/**
 * A stub platform that records the request it received.
 *
 * The recorded headers matter as much as the response: the production platform
 * refuses any request without a browser User-Agent, so a regression there would
 * break every real login while a body-only stub kept passing.
 */
function platformFetch(payload: unknown) {
  const calls: { url: string; headers: Record<string, string> }[] = []
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> })
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

type ServerConfig = Parameters<typeof createRemoteServer>[0]

async function start(overrides: Partial<ServerConfig> = {}): Promise<void> {
  dataFile = join(dir, 'state.json')
  const probe = createRemoteServer({ account, password, dataFile, publicUrl: 'http://127.0.0.1:8080', ...overrides })
  probe.server.listen(0, '127.0.0.1'); await once(probe.server, 'listening')
  const port = (probe.server.address() as { port: number }).port
  await probe.close()
  base = `http://127.0.0.1:${port}`
  app = createRemoteServer({ account, password, dataFile, publicUrl: base, ...overrides })
  app.server.listen(port, '127.0.0.1'); await once(app.server, 'listening')
}

async function login(token = 'grant-value'): Promise<Response> {
  return fetch(`${base}/api/v1/auth/deepseek`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  })
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dsh-deepseek-')) })
afterEach(async () => {
  await app?.close()
  app = undefined
  rmSync(dir, { recursive: true, force: true })
})

describe('DeepSeek account login', () => {
  it('reports the endpoint as missing while the feature is not configured', async () => {
    await start()
    const response = await login()
    expect(response.status).toBe(404)
    expect((await response.json()).error.code).toBe('METHOD_NOT_FOUND')
  })

  it('refuses an unbound grant unless account creation is allowed', async () => {
    const { fetchImpl } = platformFetch(profilePayload('user-1'))
    await start({ deepseek: { fetchImpl } })
    const response = await login()
    expect(response.status).toBe(403)
    expect(app!.store.listAccounts()).toEqual([account])
  })

  it('creates the account for a verified grant and issues a Server session', async () => {
    const { calls, fetchImpl } = platformFetch(profilePayload('user-1'))
    await start({ deepseek: { fetchImpl, createsAccounts: true } })

    const response = await login('grant-abc')
    expect(response.status).toBe(200)
    const body = await response.json() as { account: string; token: string }
    expect(body.account).toBe('deepseek:user-1')
    expect(body.token.length).toBeGreaterThanOrEqual(16)
    expect(app!.store.listAccounts()).toContain('deepseek:user-1')

    // The session authenticates the account, like any other sign-in.
    const me = await fetch(`${base}/api/v1/auth/me`, { headers: { Authorization: `Bearer ${body.token}` } })
    expect(me.status).toBe(200)

    // The request the platform saw is the contract the WAF enforces.
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://platform.deepseek.com/auth-api/v0/users/current')
    expect(calls[0]!.headers['x-dsh-auth-token']).toBe('grant-abc')
    expect(calls[0]!.headers['User-Agent']).toMatch(/^Mozilla\/5\.0 /)
    expect(calls[0]!.headers['x-client-platform']).toBe('web')
    expect(calls[0]!.headers['x-client-locale']).toBe('zh_CN')
  })

  it('keeps the grant out of the persisted state', async () => {
    const { fetchImpl } = platformFetch(profilePayload('user-7'))
    await start({ deepseek: { fetchImpl, createsAccounts: true } })
    const grant = 'grant-must-not-be-stored'
    expect((await login(grant)).status).toBe(200)
    expect(readFileSync(dataFile, 'utf8')).not.toContain(grant)
  })

  it('reuses the bound account on a later login with the same grant', async () => {
    const { fetchImpl } = platformFetch(profilePayload('user-2'))
    await start({ deepseek: { fetchImpl, createsAccounts: true } })
    await login()
    const again = await login()
    expect(again.status).toBe(200)
    expect((await again.json() as { account: string }).account).toBe('deepseek:user-2')
    expect(app!.store.listAccounts().filter(name => name.startsWith('deepseek:'))).toEqual(['deepseek:user-2'])
  })

  it('refuses a grant the platform rejects', async () => {
    // The platform answers an authorization failure as a business code, not a status.
    const { fetchImpl } = platformFetch({ code: 40003, msg: 'Authorization Failed (invalid token)', data: null })
    await start({ deepseek: { fetchImpl, createsAccounts: true } })
    const response = await login('bogus')
    expect(response.status).toBe(401)
    expect(app!.store.listAccounts()).toEqual([account])
  })
})

describe('DeepSeek verifier', () => {
  it('projects the stable id and prefers the profile name', async () => {
    const { fetchImpl } = platformFetch(profilePayload('42'))
    await expect(createDeepSeekVerifier({ fetchImpl }).verify('grant')).resolves
      .toEqual({ subject: '42', displayName: 'Ada' })
  })

  it('falls back to the contact address when no profile name exists', async () => {
    const { fetchImpl } = platformFetch(profilePayload('43', { id_profile: null }))
    await expect(createDeepSeekVerifier({ fetchImpl }).verify('grant')).resolves
      .toEqual({ subject: '43', displayName: 'person@example.com' })
  })

  it('treats a missing id, an empty grant and a non-JSON body as no identity', async () => {
    const noId = platformFetch(profilePayload('44', { id: null }))
    await expect(createDeepSeekVerifier({ fetchImpl: noId.fetchImpl }).verify('grant')).resolves.toBeUndefined()
    await expect(createDeepSeekVerifier({ fetchImpl: noId.fetchImpl }).verify('   ')).resolves.toBeUndefined()

    const broken = vi.fn(async () => new Response('<html>blocked</html>', { status: 200 })) as unknown as typeof fetch
    await expect(createDeepSeekVerifier({ fetchImpl: broken }).verify('grant')).rejects.toThrow()
  })
})

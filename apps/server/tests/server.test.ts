import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import { createControlFrame } from '@dsh-remote/protocol'
import { NoiseIkSession, createNoisePrologue, generateKeyPair, toBase64Url, fromBase64Url } from '../../../packages/crypto/src/index.js'
import { createRemoteServer } from '../src/server.js'

const account = 'owner@example.com', password = 'local-test-password'
let app: ReturnType<typeof createRemoteServer>, dir: string, base: string, accountToken: string
const sockets: WebSocket[] = []
async function request(path: string, method = 'GET', body?: unknown, token?: string, headers = {}) {
  const response = await fetch(`${base}/api/v1${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  return { status: response.status, data: await response.json(), headers: response.headers }
}
async function start(pass = password, options: {
  account?: string
  registrationCode?: string
  heartbeat?: { intervalMs?: number; peerTimeoutMs?: number }
} = {}) {
  app = createRemoteServer({
    account: options.account ?? account,
    password: pass,
    dataFile: join(dir, 'state.json'),
    publicUrl: 'http://localhost:8080',
    ...(options.registrationCode === undefined ? {} : { registrationCode: options.registrationCode }),
    ...(options.heartbeat === undefined ? {} : { heartbeat: options.heartbeat }),
  })
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening')
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`
}
/**
 * Register a device. `token` defaults to the bootstrap account's account token;
 * pass another account's token to prove cross-account isolation.
 */
async function device(role: 'host' | 'client' = 'client', token = accountToken) {
  const keys = generateKeyPair()
  const descriptor = { deviceId: randomUUID(), identityKey: keys.publicKey, name: 'test-device', role, platform: 'linux', clientVersion: '0.4.15' }
  const result = await request('/devices/register', 'POST', { v: 1, device: descriptor }, token)
  expect(result.status).toBe(200)
  return { ...descriptor, keys, ...result.data }
}
class Wire {
  messages: any[] = []
  waiters: (() => void)[] = []
  constructor(readonly ws: WebSocket) { ws.on('message', raw => { this.messages.push(JSON.parse(raw.toString())); for (const notify of this.waiters.splice(0)) notify() }) }
  send(type: Parameters<typeof createControlFrame>[0], payload: unknown) { this.ws.send(JSON.stringify(createControlFrame(type, payload))) }
  async next(type: string): Promise<any> {
    const until = Date.now() + 3000
    while (Date.now() < until) {
      const idx = this.messages.findIndex(m => m.type === type)
      if (idx >= 0) return this.messages.splice(idx, 1)[0].payload
      await new Promise<void>(resolve => { const timer = setTimeout(resolve, 50); this.waiters.push(() => { clearTimeout(timer); resolve() }) })
    }
    throw new Error(`Missing frame ${type}`)
  }
}
async function socket(d: Awaited<ReturnType<typeof device>>, overrides = {}) {
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws/v1/connect'); sockets.push(ws)
  const wire = new Wire(ws); await once(ws, 'open')
  wire.send('hello', { role: d.role, deviceId: d.deviceId, accessToken: d.accessToken, protocols: [1], capabilities: ['transport.relay', 'transport.p2p'], clientVersion: d.clientVersion, ...overrides })
  return wire
}
async function connection() {
  const h = await device('host'), c = await device(), host = await socket(h), client = await socket(c)
  expect(await host.next('hello.ack')).toMatchObject({ capabilities: ['transport.relay'], webrtcEnabled: false })
  await client.next('hello.ack')
  client.send('connect.request', { hostDeviceId: h.deviceId, preferredTransports: ['relay'] })
  const incoming = await host.next('connect.incoming')
  expect(incoming.clientIdentityKey).toBe(c.identityKey)
  host.send('connect.accepted', { connectionId: incoming.connectionId })
  const { connectionId } = await client.next('connect.accepted')
  return { h, c, host, client, connectionId }
}
async function handshake(ctx: Awaited<ReturnType<typeof connection>>) {
  const { h, c, host, client, connectionId } = ctx
  const prologue = createNoisePrologue(connectionId, h.deviceId, c.deviceId)
  const initiator = new NoiseIkSession({ role: 'initiator', localPrivateKey: c.keys.privateKey, localPublicKey: c.identityKey, remotePublicKey: h.identityKey, prologue })
  const responder = new NoiseIkSession({ role: 'responder', localPrivateKey: h.keys.privateKey, localPublicKey: h.identityKey, remotePublicKey: c.identityKey, prologue })
  client.send('secure.handshake', { connectionId, targetDeviceId: h.deviceId, step: 1, data: toBase64Url(initiator.writeHandshake()) })
  responder.readHandshake(fromBase64Url((await host.next('secure.handshake')).data))
  host.send('secure.handshake', { connectionId, targetDeviceId: c.deviceId, step: 2, data: toBase64Url(responder.writeHandshake()) })
  initiator.readHandshake(fromBase64Url((await client.next('secure.handshake')).data))
  return { initiator, responder }
}
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-server-')); await start()
  accountToken = (await request('/auth/login', 'POST', { email: account, password })).data.token
})
afterEach(async () => { for (const ws of sockets.splice(0)) ws.terminate(); await app.close(); rmSync(dir, { recursive: true, force: true }) })

describe('control heartbeat', () => {
  it('rejects a grace period that does not span two intervals', () => {
    // The check runs once per interval, so a shorter grace period drops every peer on the next check:
    // that has to fail the boot instead of silently disconnecting everyone.
    expect(() => createRemoteServer({
      account,
      password,
      dataFile: join(dir, 'state.json'),
      publicUrl: 'http://localhost:8080',
      heartbeat: { intervalMs: 20_000, peerTimeoutMs: 25_000 },
    })).toThrow(/at least twice/)
  })

  it('advertises the configured cadence to peers', async () => {
    await app.close()
    await start(password, { heartbeat: { intervalMs: 15_000, peerTimeoutMs: 40_000 } })
    accountToken = (await request('/auth/login', 'POST', { email: account, password })).data.token
    const h = await device('host')
    const host = await socket(h)
    expect(await host.next('hello.ack')).toMatchObject({ heartbeatIntervalMs: 15_000 })
  })
})

describe('account and device authorization', () => {
  it('separates account, cookie and device credentials; rejects cross-origin requests', async () => {
    expect((await request('/auth/login', 'POST', { email: account, password: 'wrong' })).status).toBe(401)
    expect((await request('/auth/login', 'POST', { email: account, password }, undefined, { Origin: 'https://attacker.example' })).status).toBe(403)
    const d = await device()
    expect((await request('/auth/me', 'GET', undefined, d.accessToken)).status).toBe(401)
    expect((await request('/devices', 'GET', undefined, accountToken)).status).toBe(401)
    expect((await request('/devices/register', 'POST', { v: 1, device: d })).status).toBe(401)
    const login = await request('/auth/login', 'POST', { email: account, password })
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!
    expect(login.headers.get('set-cookie')).toContain('HttpOnly')
    expect((await request('/account/devices', 'GET', undefined, undefined, { Cookie: cookie })).status).toBe(200)
    await request('/auth/logout', 'POST', {}, undefined, { Cookie: cookie })
    expect((await request('/auth/me', 'GET', undefined, login.data.token)).status).toBe(401)
  })
  it('pins identity and refuses a second device in the same role', async () => {
    const h = await device('host'), c = await device()
    const changed = { deviceId: h.deviceId, name: h.name, role: h.role, platform: h.platform, clientVersion: h.clientVersion, identityKey: c.identityKey }
    expect((await request('/devices/register', 'POST', { v: 1, device: changed }, accountToken)).data.error.code).toBe('PEER_IDENTITY_MISMATCH')
    expect((await request(`/devices/${h.deviceId}`, 'GET', undefined, c.accessToken)).data.identityKey).toBe(h.identityKey)
    // A device may read its own row: one identity covers both halves, so the two roles no longer have to differ.
    expect((await request(`/devices/${c.deviceId}`, 'GET', undefined, c.accessToken)).status).toBe(200)
    // Registering an owned role is gone with the two-identity model. What remains is that a device may
    // re-register itself - the ordinary sign-in path - and that its row keeps the same id.
    const own = { ...changed, identityKey: h.identityKey }
    expect((await request('/devices/register', 'POST', { v: 1, device: own }, accountToken)).status).toBe(200)
    expect((await request(`/devices/${h.deviceId}`, 'GET', undefined, c.accessToken)).data.deviceId).toBe(h.deviceId)
  })
  it('persists credentials as digests, rotates refresh tokens and revokes a reused family', async () => {
    const d = await device()
    const saved = readFileSync(join(dir, 'state.json'), 'utf8')
    expect(saved).not.toContain(d.refreshToken); expect(saved).not.toContain(d.accessToken); expect(saved).not.toContain(password)
    await app.close(); await start()
    expect((await request('/devices', 'GET', undefined, d.accessToken)).status).toBe(200)
    const rotated = await request('/auth/refresh', 'POST', { deviceId: d.deviceId, refreshToken: d.refreshToken })
    expect(rotated.status).toBe(200)
    expect(rotated.data.refreshTokenExpiresAt).toBe(d.refreshTokenExpiresAt)
    expect((await request('/auth/refresh', 'POST', { deviceId: d.deviceId, refreshToken: d.refreshToken })).status).toBe(401)
    expect((await request('/devices', 'GET', undefined, rotated.data.accessToken)).status).toBe(401)
  })
  it('invalidates credentials when the configured password changes', async () => {
    const d = await device(); await app.close(); await start('a-different-password')
    expect((await request('/devices', 'GET', undefined, d.accessToken)).status).toBe(401)
    expect((await request('/auth/refresh', 'POST', { deviceId: d.deviceId, refreshToken: d.refreshToken })).status).toBe(401)
  })
})
describe('control authorization and encrypted relay', () => {
  it('relays real Noise IK ciphertext and rejects replay', async () => {
    const ctx = await connection(), { initiator, responder } = await handshake(ctx)
    const ciphertext = toBase64Url(initiator.encrypt(new TextEncoder().encode('private prompt')))
    const payload = { connectionId: ctx.connectionId, targetDeviceId: ctx.h.deviceId, counter: 0, ciphertext }
    ctx.client.send('relay', payload)
    const received = await ctx.host.next('relay')
    expect(received.ciphertext).not.toContain('private prompt')
    expect(new TextDecoder().decode(responder.decrypt(fromBase64Url(received.ciphertext)))).toBe('private prompt')
    ctx.client.send('relay', payload)
    expect((await ctx.client.next('error')).code).toBe('INVALID_MESSAGE')
  })
  it.each(['wrong-target', 'third-device', 'before-handshake'])('rejects unauthorized relay: %s', async reason => {
    const ctx = await connection()
    const attacker = reason === 'third-device' ? await socket(await device()) : ctx.client
    if (reason === 'third-device') await attacker.next('hello.ack')
    attacker.send('relay', { connectionId: ctx.connectionId, targetDeviceId: reason === 'wrong-target' ? randomUUID() : ctx.h.deviceId, counter: 0, ciphertext: 'opaque' })
    expect((await attacker.next('error')).code).toMatch(/CONNECTION_NOT_FOUND|INVALID_MESSAGE/)
    expect(ctx.host.messages.filter(m => m.type === 'relay')).toHaveLength(0)
  })
  it('rejects account tokens in hello and lets one identity hold both roles', async () => {
    const d = await device()
    expect((await (await socket(d, { accessToken: accountToken })).next('error')).code).toBe('AUTH_INVALID')
    // The role belongs to the connection, not to the identity: one device may present itself as a client
    // and as a host at the same time, and the second connection must not replace the first. Keying peers
    // by device alone is what used to force one identity per role.
    const asClient = await socket(d)
    await asClient.next('hello.ack')
    const asHost = await socket(d, { role: 'host' })
    await asHost.next('hello.ack')
    asClient.send('ping', { nonce: 'still-here' })
    expect(await asClient.next('pong')).toEqual({ nonce: 'still-here' })
  })
  it('replaces a device socket without removing the new connection', async () => {
    const d = await device(), old = await socket(d); await old.next('hello.ack')
    const closed = once(old.ws, 'close'), current = await socket(d)
    await current.next('hello.ack'); expect((await closed)[0]).toBe(4003)
    current.send('ping', { nonce: 'new-socket' }); expect(await current.next('pong')).toEqual({ nonce: 'new-socket' })
  })
  it('keeps concurrent clients isolated and tears down revoked connections', async () => {
    const ctx = await connection(), second = await device(), wire = await socket(second); await wire.next('hello.ack')
    wire.send('connect.request', { hostDeviceId: ctx.h.deviceId, preferredTransports: ['relay'] })
    const incoming = await ctx.host.next('connect.incoming')
    ctx.host.send('connect.accepted', { connectionId: incoming.connectionId }); await wire.next('connect.accepted')
    expect(ctx.client.messages.filter(m => m.type === 'error')).toHaveLength(0)
    await handshake(ctx)
    const closed = once(wire.ws, 'close')
    expect((await request('/devices/self', 'DELETE', undefined, second.accessToken)).status).toBe(200)
    await closed
    expect(await ctx.host.next('error')).toMatchObject({ connectionId: incoming.connectionId })
    expect((await request('/devices', 'GET', undefined, second.accessToken)).status).toBe(401)
  })
})
describe('multi-account isolation', () => {
  it('keeps devices, discovery and pairing inside one account', async () => {
    const hostA = await device('host')
    // Seed a second account on the running server, then register its own host.
    app.store.upsertAccount('second@example.com', 'second-account-password')
    const tokenB = (await request('/auth/login', 'POST', { email: 'second@example.com', password: 'second-account-password' })).data.token
    const hostB = await device('host', tokenB)

    // A client of the first account sees only its own account's host.
    const clientA = await device('client')
    const listed = await request('/devices', 'GET', undefined, clientA.accessToken)
    expect(listed.status).toBe(200)
    // Every device of the account is listed now - the row's role no longer decides - and each item carries
    // online and hostControl, so a panel marks an unavailable device instead of hiding it.
    const listedIds = listed.data.items.map((item: { deviceId: string }) => item.deviceId)
    expect(listedIds).toContain(hostA.deviceId)
    expect(listedIds).not.toContain(hostB.deviceId)

    // The second account's host is invisible to the first account, by id too.
    expect((await request(`/devices/${hostB.deviceId}`, 'GET', undefined, clientA.accessToken)).status).toBe(404)
    expect((await request(`/devices/${hostB.deviceId}/presence`, 'GET', undefined, clientA.accessToken)).status).toBe(404)

    // Device ids are namespaced per account: the same uuid can exist on both.
    const id = randomUUID()
    const keys = generateKeyPair()
    const descriptor = { deviceId: id, identityKey: keys.publicKey, name: 'shared-id', platform: 'linux', clientVersion: '0.4.15' }
    expect((await request('/devices/register', 'POST', { v: 1, device: descriptor }, accountToken)).status).toBe(200)
    expect((await request('/devices/register', 'POST', { v: 1, device: descriptor }, tokenB)).status).toBe(200)
  })

  it('refuses to pair a client with another account\'s host', async () => {
    app.store.upsertAccount('second@example.com', 'second-account-password')
    const tokenB = (await request('/auth/login', 'POST', { email: 'second@example.com', password: 'second-account-password' })).data.token
    const hostB = await device('host', tokenB), clientA = await device('client')
    const hostWire = await socket({ ...hostB, accessToken: hostB.accessToken })
    const clientWire = await socket(clientA)
    await hostWire.next('hello.ack')
    await clientWire.next('hello.ack')
    clientWire.send('connect.request', { hostDeviceId: hostB.deviceId, preferredTransports: ['relay'] })
    // The host of another account is not even addressable: reported as offline.
    expect(await clientWire.next('error')).toMatchObject({ code: 'HOST_OFFLINE' })
  })

  it('closes registration unless a code is configured', async () => {
    const request_ = (body: Record<string, unknown>) => request('/auth/register', 'POST', body)
    expect((await request_({ email: 'new@example.com', password: 'a-long-enough-password' })).status).toBe(403)

    await app.close(); await start(password, { registrationCode: 'registration-code-value' })
    expect((await request_({ email: 'new@example.com', password: 'a-long-enough-password', code: 'wrong-code-value' })).status).toBe(403)
    const created = await request_({ email: 'new@example.com', password: 'a-long-enough-password', code: 'registration-code-value' })
    expect(created.status).toBe(200)
    expect(created.data.account).toBe('new@example.com')
    expect((await request('/auth/login', 'POST', { email: 'new@example.com', password: 'a-long-enough-password' })).status).toBe(200)
    // The new account starts empty and cannot see the bootstrap account's devices.
    const listed = await request('/account/devices', 'GET', undefined, created.data.token)
    expect(listed.data.items).toEqual([])
  })
})
describe('health and readiness endpoints', () => {
  it('serves health, healthz, and ready without authentication or rate limiting', async () => {
    for (const path of ['/health', '/healthz', '/ready']) {
      const response = await fetch(`${base}${path}`)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ status: 'ok' })
    }
  })
})
describe('host control switch', () => {
  it('refuses a host connection while control is off and keeps the switch across a re-registration', async () => {
    const h = await device('host')
    const online = await socket(h)
    await online.next('hello.ack')

    // Switching control off takes effect at once: the Server records it and drops the host connection.
    expect((await request('/devices/self/control', 'POST', { enabled: false }, h.accessToken)).status).toBe(200)
    await once(online.ws, 'close')

    // While the switch is off a host connection is refused, with a code the client can act on.
    expect((await (await socket(h)).next('error')).code).toBe('CONTROL_DISABLED')

    // Signing in again must not quietly switch control back on, and the flag is visible to clients listing
    // devices - the descriptor carries it.
    const descriptor = {
      deviceId: h.deviceId, identityKey: h.identityKey, name: h.name,
      role: 'host', platform: h.platform, clientVersion: h.clientVersion,
    }
    const again = await request('/devices/register', 'POST', { v: 1, device: descriptor }, accountToken)
    expect(again.status).toBe(200)
    expect((await request('/me', 'GET', undefined, again.data.accessToken)).data.hostControl).toBe(false)

    // Turning it back on lets the same device in again, with no further sign-in.
    expect((await request('/devices/self/control', 'POST', { enabled: true }, again.data.accessToken)).status).toBe(200)
    const back = await socket({ ...h, accessToken: again.data.accessToken })
    await back.next('hello.ack')
  })
})

describe('device revocation', () => {
  it('removes the device and lets the same installation register again with the same id', async () => {
    const d = await device('client')
    // The row and its tokens go together, so the cut-off is immediate rather than on next login.
    const revoked = await request('/devices/self', 'DELETE', undefined, d.accessToken)
    expect(revoked.status).toBe(200)
    // Row and token go together: the device is cut off immediately rather than on its next login.
    expect((await request('/me', 'GET', undefined, d.accessToken)).status).toBe(401)
    // Signing in again registers the same installation, and the id it presents comes back unchanged:
    // this is what keeps one device from looking like several over time.
    const descriptor = {
      deviceId: d.deviceId, identityKey: d.identityKey, name: d.name,
      role: d.role, platform: d.platform, clientVersion: d.clientVersion,
    }
    const again = await request('/devices/register', 'POST', { v: 1, device: descriptor }, accountToken)
    expect(again.status).toBe(200)
    expect((await request('/me', 'GET', undefined, again.data.accessToken)).status).toBe(200)
  })
})
describe('unified device identity', () => {
  it('lets a device registered as a host list its account hosts', async () => {
    // One identity per installation means the row is registered as a host, and the listing used to require the
    // stored role to be 'client' - which locked every unified device out with a 403.
    const h = await device('host')
    const listed = await request('/devices', 'GET', undefined, h.accessToken)
    expect(listed.status).toBe(200)
    expect(listed.data.items.map(item => item.deviceId)).toContain(h.deviceId)
  })
})

describe('host control switch', () => {
  it('lists a device with control off, marked unavailable instead of hidden', async () => {
    const h = await device('host')
    // Switching control off records the flag, drops the host connection and refuses a new one (covered below).
    expect((await request('/devices/self/control', 'POST', { enabled: false }, h.accessToken)).status).toBe(200)
    // The device stays in the account's list; a panel shows it as unavailable rather than losing sight of it.
    const listed = await request('/devices', 'GET', undefined, h.accessToken)
    const item = listed.data.items.find((entry: { deviceId: string }) => entry.deviceId === h.deviceId)
    expect(item).toMatchObject({ hostControl: false, online: false })
  })
})

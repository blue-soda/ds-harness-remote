import { RpcId, type ApiProxy } from '@deepseek-ai/dsh-host-apiproxy/api'
import { createRpcRequest, type RemoteMessage, type RpcResponsePayload, type RpcErrorPayload } from '@dsh-remote/protocol'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { WebSocketServer } from 'ws'
import { describe, expect, it, vi } from 'vitest'
import type { ResolvedConfig } from '../src/config.js'
import type { HostIdentity, IdentityStore } from '../src/identity-store.js'
import type { SafeLogger } from '../src/logging.js'
import { HostPluginRuntime } from '../src/service.js'
import type { AuthenticatedPeerChannel } from '../src/types.js'
import type { LocalTypertGateway } from '../src/typert-gateway-contract.js'

describe('HostPluginRuntime multi-Client routing', () => {
  it.each(['0.1.5-rc.1', '0.2.0-rc.1'])('advertises ApiProxy alongside Session V3 on %s', async version => {
    const runtime = new HostPluginRuntime(
      config(),
      identities(),
      apiProxy({}),
      logger(),
      localGateway(),
    )
    await runtime.start()
    ;(runtime as unknown as { harnessVersion: string }).harnessVersion = version

    expect(runtime.diagnostics()).toMatchObject({
      capabilities: expect.arrayContaining([
        'harness.remote.v3',
        'harness.remote.transfer.v1',
        'harness.api.v1',
        'harness.api.transfer.v1',
      ]),
    })
    await runtime.close()
  })

  it('allows identical stream ids on different Client connections without crossing frames', async () => {
    const streamSignals: AbortSignal[] = []
    const mux: ApiProxy['events']['mux'] = async function* (request, signal) {
      streamSignals.push(signal)
      yield {
        rpcId: RpcId(`frame-for-${String(request.rpcId)}`),
        payload: { type: 'session/subscribed', sessionId: 'session-1' as never, lastSeq: 0 },
      }
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    }
    const api = apiProxy({
      mux,
    })
    const runtime = new HostPluginRuntime(
      config(),
      identities(),
      api,
      logger(),
    )
    await runtime.start()

    const phone = fakeChannel('connection-phone', 'client-phone')
    const desktop = fakeChannel('connection-desktop', 'client-desktop')
    await runtime.acceptAuthenticatedPeer(phone)
    await runtime.acceptAuthenticatedPeer(desktop)

    phone.push(streamRequest('phone-open'))
    desktop.push(streamRequest('desktop-open'))

    await vi.waitFor(() => {
      expect(streamSignals).toHaveLength(2)
      expect(phone.sent()).toContainEqual(expect.objectContaining({ type: 'rpc.response' }))
      expect(desktop.sent()).toContainEqual(expect.objectContaining({ type: 'rpc.response' }))
      expect(streamFrameRpcIds(phone.sent())).toEqual(['frame-for-phone-open'])
      expect(streamFrameRpcIds(desktop.sent())).toEqual(['frame-for-desktop-open'])
    })
    expect(runtime.diagnostics()).toMatchObject({
      online: true,
      activeConnections: 2,
    })
    expect(runtime.connections.peerDeviceIds()).toEqual(['client-phone', 'client-desktop'])
    expect(runtime.hostStatus().connectedClients).toEqual([
      { deviceId: 'client-phone', name: 'Phone', platform: 'android', mode: 'LAN' },
      { deviceId: 'client-desktop', name: 'Laptop', platform: 'darwin', mode: 'P2P' },
    ])
    expect(phone.sent()).not.toContainEqual(expect.objectContaining({ type: 'rpc.error' }))
    expect(desktop.sent()).not.toContainEqual(expect.objectContaining({ type: 'rpc.error' }))

    await runtime.close()
    expect(streamSignals.every(signal => signal.aborted)).toBe(true)
  })
  it('revokes preview ports for every connected Client while retaining allowed sockets', async () => {
    const servers = [createServer(), createServer()]
    const upstreams = servers.map(server => new WebSocketServer({ server }))
    const runtime = new HostPluginRuntime(config(), identities(), apiProxy({}), logger())
    try {
      const ports = await Promise.all(servers.map(async server => {
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
        return (server.address() as { port: number }).port
      }))
      runtime.setLoopbackPorts(ports)
      await runtime.start()
      const phone = fakeChannel('connection-phone', 'client-phone')
      const desktop = fakeChannel('connection-desktop', 'client-desktop')
      await runtime.acceptAuthenticatedPeer(phone)
      await runtime.acceptAuthenticatedPeer(desktop)
      const call = async (channel: typeof phone, params: unknown): Promise<unknown> => {
        const request = createRpcRequest('loopback.call', params)
        channel.push(request)
        let response: RemoteMessage | undefined
        await vi.waitFor(() => {
          response = channel.sent().find(message => (message.type === 'rpc.response' || message.type === 'rpc.error')
            && (message.payload as RpcResponsePayload | RpcErrorPayload).requestId === request.id)
          expect(response).toBeDefined()
        })
        if (response!.type === 'rpc.error') throw response!.payload
        return (response!.payload as RpcResponsePayload).result
      }
      const open = { op: 'ws.open', path: '/', headers: [], protocols: [] }
      const revokedIds = [randomUUID(), randomUUID()]; const keptId = randomUUID()
      await call(phone, { ...open, id: revokedIds[0], port: ports[0] })
      await call(desktop, { ...open, id: revokedIds[1], port: ports[0] })
      await call(desktop, { ...open, id: keptId, port: ports[1] })
      expect(upstreams[0]!.clients.size).toBe(2)
      runtime.setLoopbackPorts([ports[1]!])
      await vi.waitFor(() => expect(upstreams[0]!.clients.size).toBe(0))
      expect(upstreams[1]!.clients.size).toBe(1)
      for (const [index, channel] of [phone, desktop].entries()) {
        await expect(call(channel, { op: 'ws.send', id: revokedIds[index], data: '', binary: false }))
          .rejects.toMatchObject({ code: 'LOOPBACK_CLOSED' })
        await expect(call(channel, { ...open, id: randomUUID(), port: ports[0] }))
          .rejects.toMatchObject({ code: 'LOOPBACK_PORT_DENIED' })
      }
      await expect(call(desktop, { op: 'ws.send', id: keptId, data: '', binary: false })).resolves.toEqual({ sent: true })
    } finally {
      await runtime.close()
      for (const upstream of upstreams) { for (const socket of upstream.clients) socket.terminate(); upstream.close() }
      await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))))
    }
  })
})

function streamRequest(rpcId: string): RemoteMessage {
  return createRpcRequest('harness.api.stream.open', {
    streamId: 'same-client-stream-id',
    stream: 'mux',
    rpcId,
    payload: {},
  })
}

function streamFrameRpcIds(messages: RemoteMessage[]): unknown[] {
  return messages
    .filter(message => message.type === 'event'
      && (message.payload as { event?: string }).event === 'harness.api.frame')
    .map(message => (
      message.payload as { data: { frame: { rpcId: unknown } } }
    ).data.frame.rpcId)
}

function identities(): IdentityStore {
  const identity: HostIdentity = {
    schemaVersion: 1,
    deviceId: 'host-1',
    name: 'Host',
    publicKey: 'host-public-key',
    privateKey: 'host-private-key',
    fingerprint: 'HOST',
  }
  const peers = new Map([
    ['client-phone', { deviceId: 'client-phone', name: 'Phone', platform: 'android' }],
    ['client-desktop', { deviceId: 'client-desktop', name: 'Laptop', platform: 'darwin' }],
  ])
  return {
    loadOrCreate: vi.fn(async () => identity),
    isTrusted: vi.fn(() => true),
    listTrustedPeers: vi.fn(() => [...peers.values()]),
    trustedPeer: vi.fn((deviceId: string) => peers.get(deviceId)),
  } as unknown as IdentityStore
}

function apiProxy(events: Partial<ApiProxy['events']>): ApiProxy {
  const empty = {}
  return {
    sessions: empty,
    subagents: empty,
    host: empty,
    workspace: empty,
    skills: empty,
    agentPresets: empty,
    goals: empty,
    settings: empty,
    credentials: empty,
    llm: empty,
    events: {
      mux: events.mux ?? (async function* () { return }),
      host: events.host ?? (async function* () { return }),
    },
    downloads: empty,
    respond: async () => ({ accepted: true }),
  } as unknown as ApiProxy
}

function localGateway(): LocalTypertGateway {
  return {
    invoke: vi.fn(async () => undefined),
    dispatch: vi.fn(async () => ({ ok: true as const })),
    open: vi.fn(async () => (async function* () { return })()),
    failure: vi.fn(() => ({ code: 'internal', message: 'failed', details: {} })),
    supportsCarrier: true,
  }
}

function fakeChannel(
  connectionId: string,
  peerDeviceId: string,
): AuthenticatedPeerChannel & { push(message: RemoteMessage): void; sent(): RemoteMessage[] } {
  let handler: (message: RemoteMessage) => void = () => undefined
  const sentMessages: RemoteMessage[] = []
  const send = vi.fn(async (message: RemoteMessage) => { sentMessages.push(message) })
  return {
    security: { protocol: 'Noise_IK_25519_ChaChaPoly_SHA256', connectionId, membershipId: 'membership-1' },
    peerDeviceId,
    peerIdentityKey: `key-${peerDeviceId}`,
    mode: peerDeviceId === 'client-desktop' ? 'P2P' : 'LAN',
    send,
    close: vi.fn(async () => undefined),
    onMessage: vi.fn(next => { handler = next; return () => { handler = () => undefined } }),
    push: message => handler(message),
    sent: () => [...sentMessages],
  }
}

function config(): ResolvedConfig {
  return {
    terminal: { enabled: false },
    loopback: { ports: [] },
    enabled: true,
    role: 'host',
    serverUrl: undefined,
    deviceName: 'Host',
    forceRelay: true,
    logLevel: 'error',
    reconnect: { enabled: false, initialDelayMs: 100, maxDelayMs: 1_000, jitter: 0 },
    codex: { enabled: false, binary: 'codex' },
  }
}

function logger(): SafeLogger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as SafeLogger
}

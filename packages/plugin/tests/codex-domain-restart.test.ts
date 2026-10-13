import { describe, expect, it, vi } from 'vitest'
import { CodexRemoteDomain } from '../src/codex/domain.js'
import { SafeLogger } from '../src/logging.js'

const logger = new SafeLogger({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never)

/**
 * A stand-in App Server that reports itself ready and answers the account probe.
 *
 * The probe is the domain's gate, and it only needs `requiresOpenaiAuth === false` to pass, so this keeps the
 * restart state machine testable without Codex, without a binary and without the account being reachable.
 */
function stubAppServer(): { close: ReturnType<typeof vi.fn> } & Record<string, unknown> {
  return {
    start: vi.fn(async () => undefined),
    isReady: vi.fn(() => true),
    call: vi.fn(async (method: string) => (method === 'account/read' ? { requiresOpenaiAuth: false } : {})),
    onInbound: vi.fn(() => () => undefined),
    onUnavailable: vi.fn(() => () => undefined),
    close: vi.fn(async () => undefined),
  }
}

describe('Codex domain restart', () => {
  it('does not announce a lost domain when it is merely starting up', async () => {
    // Announcing "your Codex session is gone" while Codex is coming *back* made the client start a fresh recovery
    // and undo a cancel the user had just made. Only a domain that was serving can take a session away.
    const published: Array<{ event: string; data: unknown }> = []
    const factory = vi.fn(() => stubAppServer() as never)
    const disabled = new CodexRemoteDomain({ enabled: false, binary: 'codex' } as never, logger, factory as never)
    await disabled.start()
    expect(disabled.status()).toMatchObject({ enabled: false, available: false })
    disabled.createPeer(
      { connectionId: 'connection-1', peerDeviceId: 'peer-1' },
      async (event, data) => { published.push({ event, data }) },
    )

    await disabled.restart({ enabled: true, binary: 'codex' } as never)

    expect(published.filter(item => item.event === 'codex.app.capability')).toEqual([])
    await disabled.close()
  })

  it('reaches ready and stays ready across a restart, on a freshly built App Server', async () => {
    // The configuration is injected at construction, so "applied" means a new instance - the factory call count is
    // what proves the restart rebuilt it instead of reusing residual state.
    const servers: Array<ReturnType<typeof stubAppServer>> = []
    const factory = vi.fn(() => {
      const server = stubAppServer()
      servers.push(server)
      return server as never
    })
    const domain = new CodexRemoteDomain({ enabled: true, binary: 'codex' } as never, logger, factory as never)

    await domain.start()
    expect(domain.status()).toMatchObject({ enabled: true, available: true, state: 'ready' })
    expect(factory).toHaveBeenCalledTimes(1)

    await domain.restart()
    expect(domain.status()).toMatchObject({ enabled: true, available: true, state: 'ready' })
    expect(factory).toHaveBeenCalledTimes(2)
    // The retired App Server process is closed; the per-connection bridges outlive it on purpose.
    expect(servers[0]!.close).toHaveBeenCalled()
    expect(servers[1]!.close).not.toHaveBeenCalled()

    await domain.restart()
    expect(domain.status()).toMatchObject({ available: true, state: 'ready' })
    expect(factory).toHaveBeenCalledTimes(3)

    await domain.close()
  })

  it('stops and never launches when the configuration is disabled', async () => {
    const factory = vi.fn(() => stubAppServer() as never)
    const domain = new CodexRemoteDomain({ enabled: false, binary: 'codex' } as never, logger, factory as never)

    await domain.start()
    expect(domain.status()).toMatchObject({ enabled: false, available: false, state: 'disabled' })
    expect(factory).not.toHaveBeenCalled()

    await domain.restart()
    expect(domain.status()).toMatchObject({ enabled: false, available: false, state: 'disabled' })
    expect(factory).not.toHaveBeenCalled()

    await domain.close()
  })

  it('keeps an attached client working across a restart instead of closing its bridge', async () => {
    // The reported failure: switching Codex off and on again left every already-connected client with a closed
    // bridge ("The Codex connection is closed") that no refresh could clear, because the domain instance - and
    // with it the client's only handle on Codex - had been replaced.
    const factory = vi.fn(() => stubAppServer() as never)
    const domain = new CodexRemoteDomain({ enabled: true, binary: 'codex' } as never, logger, factory as never)
    await domain.start()

    const bridge = domain.createPeer({ connectionId: 'connection-1', peerDeviceId: 'peer-1' }, async () => undefined)
    expect(bridge).toBeDefined()
    await expect(bridge!.call({ method: 'account/read', params: { refreshToken: false } }))
      .resolves.toMatchObject({ authenticated: true })

    await domain.restart({ enabled: true, binary: 'codex' } as never)

    expect(factory).toHaveBeenCalledTimes(2)
    // Same bridge, new App Server: the client never has to reconnect to get Codex back.
    await expect(bridge!.call({ method: 'account/read', params: { refreshToken: false } }))
      .resolves.toMatchObject({ authenticated: true })
    await domain.close()
  })

  it('tells every attached connection, stream or not, when Codex becomes unavailable', async () => {
    // A client only hears about a switched-off Codex through the streams it happens to follow, and a session
    // sitting on its history follows nothing - so the Host has to state availability out loud, once per connection.
    const published: Array<{ event: string; data: unknown }> = []
    const factory = vi.fn(() => stubAppServer() as never)
    const domain = new CodexRemoteDomain({ enabled: true, binary: 'codex' } as never, logger, factory as never)
    await domain.start()

    const bridge = domain.createPeer(
      { connectionId: 'connection-1', peerDeviceId: 'peer-1' },
      async (event, data) => { published.push({ event, data }) },
    )
    expect(bridge).toBeDefined()
    published.length = 0

    await domain.restart({ enabled: false, binary: 'codex' } as never)

    expect(published).toContainEqual({ event: 'codex.app.capability', data: { available: false } })
    // Switching it back on is a transition *into* availability. It must never be reported as a loss: the client
    // would answer a loss with a fresh recovery, pulling back a view the user had just cancelled.
    published.length = 0
    await domain.restart({ enabled: true, binary: 'codex' } as never)
    expect(published.filter(item => item.event === 'codex.app.capability'
      && (item.data as { available?: boolean }).available === false)).toEqual([])
    expect(published).toContainEqual({ event: 'codex.app.capability', data: { available: true } })
    await domain.close()
  })

  it('keeps retrying slowly once the fast restart ladder is spent', async () => {
    // Giving up for good is what left the panel reading "unavailable" until the Codex settings were re-written
    // by hand, even though the cause (a proxy that was just switched on) had already gone away.
    vi.useFakeTimers()
    try {
      let crash: ((code: string) => void) | undefined
      const factory = vi.fn(() => ({
        ...stubAppServer(),
        onUnavailable: (handler: (code: string) => void) => { crash = handler; return () => undefined },
      }) as never)
      // An empty ladder sends the first failure straight to the slow retry.
      const domain = new CodexRemoteDomain({ enabled: true, binary: 'codex' } as never, logger, factory as never, [])

      await domain.start()
      expect(domain.status()).toMatchObject({ available: true, state: 'ready' })
      expect(factory).toHaveBeenCalledTimes(1)

      crash?.('CODEX_APP_SERVER_EXITED')
      await vi.advanceTimersByTimeAsync(0)
      expect(domain.status()).toMatchObject({ available: false, state: 'unavailable' })

      await vi.advanceTimersByTimeAsync(60_000)
      expect(factory).toHaveBeenCalledTimes(2)
      expect(domain.status()).toMatchObject({ available: true, state: 'ready' })
      await domain.close()
    } finally {
      vi.useRealTimers()
    }
  })
})

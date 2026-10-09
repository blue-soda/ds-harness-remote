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
    // The retired instance is closed - that is what drops its Codex peers.
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
})

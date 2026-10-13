import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedConfig } from '../src/config.js'
import { IdentityStore } from '../src/identity-store.js'
import type { SafeLogger } from '../src/logging.js'
import { HostPluginRuntime } from '../src/service.js'

/**
 * "Can this device be controlled" is one fact, and the Server's copy of it is what other clients list.
 *
 * The panel reaches it through two endpoints - the authorization one and the plain connection one - and
 * only one of them used to write the Server's flag. A device paused through the other path stayed listed
 * as online-and-controlling, which is exactly the wrong thing to tell the person deciding whether to
 * connect. The switch now writes the flag from either path, and reconnecting cannot undo a pause.
 */
const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function makeRuntime(): Promise<{ runtime: HostPluginRuntime; setHostControl: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; resume: ReturnType<typeof vi.fn> }> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-host-control-'))
  directories.push(directory)
  const runtime = new HostPluginRuntime(
    config(),
    new IdentityStore({ directory }),
    undefined,
    logger(),
  )
  const setHostControl = vi.fn(async () => undefined)
  const stop = vi.fn(async () => undefined)
  const resume = vi.fn()
  const seams = runtime as unknown as { serverApi: unknown; serverConnection: unknown }
  seams.serverApi = { setHostControl, currentAuthorization: () => undefined }
  seams.serverConnection = {
    stop,
    resume,
    reconnect: vi.fn(),
    lastError: () => undefined,
    isOnline: () => false,
    isReconnecting: () => false,
    lastActivity: () => undefined,
  }
  return { runtime, setHostControl, stop, resume }
}

describe('Host control switch', () => {
  it('records "control off" on the Server before taking the connection away', async () => {
    const { runtime, setHostControl, stop } = await makeRuntime()

    await runtime.pauseHostConnection()

    expect(setHostControl).toHaveBeenCalledWith(false)
    expect(stop).toHaveBeenCalledOnce()
    expect(runtime.hostStatus().paused).toBe(true)
    // Recording the flag before stopping is what makes a client reading the device list see the truth.
    expect(setHostControl.mock.invocationCallOrder[0]).toBeLessThan(stop.mock.invocationCallOrder[0]!)
  })

  it('records "control on" on the Server before resuming', async () => {
    const { runtime, setHostControl, resume } = await makeRuntime()
    await runtime.pauseHostConnection()
    setHostControl.mockClear()

    await runtime.resumeHostConnection()

    expect(setHostControl).toHaveBeenCalledWith(true)
    expect(resume).toHaveBeenCalledOnce()
    expect(runtime.hostStatus().paused).toBe(false)
  })

  it('does not let "reconnect" quietly undo a pause', async () => {
    const { runtime } = await makeRuntime()
    await runtime.pauseHostConnection()

    expect(() => runtime.reconnectHost()).toThrowError(/not accepting control/u)
    expect(runtime.hostStatus().paused).toBe(true)

    await runtime.resumeHostConnection()
    expect(() => runtime.reconnectHost()).not.toThrow()
    await runtime.close()
  })

  it('keeps the switch honoured even when the Server copy cannot be written', async () => {
    const { runtime, setHostControl, stop } = await makeRuntime()
    setHostControl.mockRejectedValueOnce(Object.assign(new Error('auth'), { code: 'AUTH_INVALID' }))

    // A signed-out device has no credential to write the flag with; the local pause still holds.
    await expect(runtime.pauseHostConnection()).resolves.toBeUndefined()
    expect(stop).toHaveBeenCalledOnce()
    expect(runtime.hostStatus().paused).toBe(true)
    await runtime.close()
  })
})

function config(): ResolvedConfig {
  return {
    terminal: { enabled: false },
    loopback: { ports: [] },
    enabled: true,
    deviceName: 'Local Harness',
    forceRelay: false,
    logLevel: 'error',
    reconnect: { enabled: true, initialDelayMs: 100, maxDelayMs: 1_000, jitter: 0 },
    codex: { enabled: false, binary: 'codex' },
    hostControl: { enabled: true, paused: false },
  }
}

function logger(): SafeLogger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as SafeLogger
}

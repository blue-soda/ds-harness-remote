import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy/api'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClientModeRuntime, remoteHostFeatures } from '../src/client-runtime.js'
import { ClientTargetStore } from '../src/client-target-store.js'
import type { ResolvedConfig } from '../src/config.js'
import { IdentityStore } from '../src/identity-store.js'
import type { SafeLogger } from '../src/logging.js'
import type { ClientServerApi } from '../src/server-api.js'

/**
 * The recovery rules the spec is written around, at the seam where they were broken:
 *
 *  - a lost session is always "this device, this kind of workspace, this directory";
 *  - a Codex session is restored as Codex, never as the peer's DSH workspace;
 *  - a Codex-only loss does not churn a transport that is still perfectly alive;
 *  - "switched off" and "never provided" are different facts with different sentences.
 *
 * These drive the runtime's own seams (the same way `client-runtime.test.ts` does), because the
 * transport ladder itself is not what regressed - the decision about *what* to restore is.
 */
const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function makeRuntime(options: { targetStore?: ClientTargetStore } = {}): Promise<ClientModeRuntime> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-client-recovery-'))
  directories.push(directory)
  const runtime = new ClientModeRuntime(
    config(),
    new IdentityStore({ directory }),
    { bindIdentity: vi.fn() } as unknown as ClientServerApi,
    apiProxy(),
    gateway(),
    logger(),
    undefined,
    undefined,
    options.targetStore,
  )
  await runtime.start()
  return runtime
}

interface RuntimeSeams {
  connected?: unknown
  browsing?: { target: { deviceId: string } }
  reconnecting?: { targetDeviceId: string; phase: 'restore' | 'fast' | 'fallback' }
  fellBackToLocal?: boolean
  remoteReconnectRun?: number
  lastWorkspaceSelection?: unknown
  handleControl(endpoint: string, payload: unknown, signal: AbortSignal): Promise<unknown>
  codexHostsSeen: Set<string>
  connectWithReason(deviceId: string, signal?: AbortSignal, forceRelay?: boolean): Promise<unknown>
  sessionTargetFor(deviceId: string): unknown
  restoreSession(target: unknown): Promise<boolean>
  restoreCodexCarrier(target: unknown): Promise<boolean>
  openCodexWorkspace(...args: unknown[]): Promise<unknown>
  listCodexWorkspaces(deviceId: string): Promise<unknown>
  codexWorkspaceIdForPath(deviceId: string, path: string): Promise<string | undefined>
  noteCodexSessionLost(trigger: string): void
  handleRemoteTransportLost(client: unknown, deviceId: string, reason: string): Promise<void>
  quickReconnectSession(deviceId: string, target: unknown, transportLost: boolean, run: number): Promise<boolean>
  reestablish(deviceId: string, forceRelay?: boolean): Promise<boolean>
  reconnectRemoteSession(deviceId: string, target?: unknown): Promise<void>
  recoverCurrentSession(): Promise<Record<string, unknown>>
}

function seams(runtime: ClientModeRuntime): RuntimeSeams {
  return runtime as unknown as RuntimeSeams
}

function connect(runtime: ClientModeRuntime, client: Record<string, unknown>, deviceId = 'host-1'): void {
  seams(runtime).connected = {
    client,
    target: { deviceId, name: 'Workstation' },
    transport: {},
    features: remoteHostFeatures(),
  }
}

describe('remote session recovery targets the same session', () => {
  it('stops a recovery in flight when the user opens a workspace instead', async () => {
    // The reported failure: a Codex retry schedule restored its own workspace *over* the DSH workspace the user
    // had just opened, so a background timer changed which session was on screen. The user's own choice is the
    // only thing allowed to do that, so it cancels the recovery rather than racing it.
    const runtime = await makeRuntime()
    const client = { rpc: vi.fn(), close: vi.fn(async () => undefined), getStats: () => ({ mode: 'Relay' }) }
    connect(runtime, client)
    seams(runtime).reconnecting = { targetDeviceId: 'host-1', phase: 'fallback' }
    seams(runtime).fellBackToLocal = true
    const before = seams(runtime).remoteReconnectRun ?? 0
    const openCodex = vi.fn(async () => ({ mode: 'remote', backend: 'codex' }))
    seams(runtime).openCodexWorkspace = openCodex

    await seams(runtime).handleControl(
      'codex.workspace.open',
      { targetDeviceId: 'host-1', workspaceId: 'codex-workspace:project:p1' },
      new AbortController().signal,
    )

    expect(openCodex).toHaveBeenCalledOnce()
    const after = runtime.status()
    expect(after).not.toHaveProperty('reconnecting')
    expect(after).toMatchObject({ fellBackToLocal: false })
    expect(seams(runtime).remoteReconnectRun).toBe(before + 1)
    await runtime.close()
  })

  it('keeps the recovery when the panel only looks at workspaces', async () => {
    // Listing is browsing, not a choice: it must not cancel a recovery the user has not answered yet.
    const runtime = await makeRuntime()
    const client = { rpc: vi.fn(), close: vi.fn(async () => undefined), getStats: () => ({ mode: 'Relay' }) }
    connect(runtime, client)
    seams(runtime).reconnecting = { targetDeviceId: 'host-1', phase: 'fallback' }
    const before = seams(runtime).remoteReconnectRun ?? 0
    seams(runtime).listCodexWorkspaces = vi.fn(async () => [])

    await seams(runtime).handleControl('codex.workspaces.list', { targetDeviceId: 'host-1' }, new AbortController().signal)

    expect((runtime.status() as { reconnecting?: unknown }).reconnecting).toMatchObject({ phase: 'fallback' })
    expect(seams(runtime).remoteReconnectRun).toBe(before)
    await runtime.close()
  })

  it('discards a restore that lands after the user answered, and puts the local shell back', async () => {
    // The reported failure: the user cancels while the restore is in flight, the restore succeeds anyway (the peer
    // was back by then), and the session reappears - work the user asked for earlier outranked the answer they
    // gave since. The remembered selection is the record of what they want, so it is re-read once the work lands.
    const runtime = await makeRuntime()
    const client = { rpc: vi.fn(), close: vi.fn(async () => undefined), getStats: () => ({ mode: 'Relay' }) }
    connect(runtime, client)
    seams(runtime).lastWorkspaceSelection = {
      targetDeviceId: 'host-1',
      workspaceId: 'codex-workspace:project:p1',
      backend: 'codex',
      workspacePath: '/srv/project',
    }
    seams(runtime).reconnecting = { targetDeviceId: 'host-1', phase: 'fast' }
    const run = seams(runtime).remoteReconnectRun ?? 0
    seams(runtime).restoreSession = vi.fn(async () => {
      // Exactly what `mode.set local` does while this call is in flight.
      seams(runtime).lastWorkspaceSelection = undefined
      seams(runtime).reconnecting = undefined
      return true
    })

    const rescued = await seams(runtime).quickReconnectSession(
      'host-1',
      { deviceId: 'host-1', kind: 'codex', workspaceId: 'codex-workspace:project:p1', workspacePath: '/srv/project' },
      false,
      run,
    )

    expect(rescued).toBe(false)
    expect(runtime.status()).toMatchObject({ mode: 'local' })
    expect(runtime.status()).not.toHaveProperty('reconnecting')
    await runtime.close()
  })

  it('restores a Codex session as Codex, never as the Host DSH workspace', async () => {
    const runtime = await makeRuntime()
    const openCodex = vi.fn(async () => ({ mode: 'remote', backend: 'codex' }))
    seams(runtime).openCodexWorkspace = openCodex
    seams(runtime).lastWorkspaceSelection = {
      targetDeviceId: 'host-1',
      workspaceId: 'codex-workspace:project:p1',
      backend: 'codex',
      workspacePath: '/srv/project',
      sessionId: 'codex:s1',
    }

    const target = seams(runtime).sessionTargetFor('host-1')
    expect(target).toMatchObject({
      deviceId: 'host-1',
      kind: 'codex',
      workspaceId: 'codex-workspace:project:p1',
      workspacePath: '/srv/project',
    })

    await expect(seams(runtime).restoreSession(target)).resolves.toBe(true)
    // The Codex carrier is the one that is rebuilt; the Harness carrier must not be selected instead.
    expect(openCodex).toHaveBeenCalledWith('host-1', 'codex-workspace:project:p1')
    expect(runtime.status()).toMatchObject({
      workspaceSelection: { targetDeviceId: 'host-1', backend: 'codex' },
    })
    await runtime.close()
  })

  it('restores a DSH session through its workspace selection', async () => {
    const runtime = await makeRuntime()
    const openCodex = vi.fn(async () => ({}))
    seams(runtime).openCodexWorkspace = openCodex
    seams(runtime).lastWorkspaceSelection = { targetDeviceId: 'host-1', workspaceId: 'workspace-1' }

    const target = seams(runtime).sessionTargetFor('host-1')
    expect(target).toMatchObject({ kind: 'harness', workspaceId: 'workspace-1' })
    await expect(seams(runtime).restoreSession(target)).resolves.toBe(true)
    expect(openCodex).not.toHaveBeenCalled()
    expect(runtime.status()).toMatchObject({ workspaceSelection: { workspaceId: 'workspace-1' } })
    await runtime.close()
  })

  it('re-matches a renumbered Codex workspace by its directory', async () => {
    const runtime = await makeRuntime()
    const openCodex = vi.fn()
      .mockRejectedValueOnce(new Error('no such workspace'))
      .mockResolvedValueOnce({ workspaceId: 'codex-workspace:project:p9' })
    seams(runtime).openCodexWorkspace = openCodex
    seams(runtime).codexWorkspaceIdForPath = vi.fn(async () => 'codex-workspace:project:p9')
    const target = {
      deviceId: 'host-1',
      kind: 'codex' as const,
      workspaceId: 'codex-workspace:project:p1',
      workspacePath: '/srv/project',
    }

    await expect(seams(runtime).restoreCodexCarrier(target)).resolves.toBe(true)
    expect(openCodex).toHaveBeenNthCalledWith(1, 'host-1', 'codex-workspace:project:p1')
    expect(openCodex).toHaveBeenNthCalledWith(2, 'host-1', 'codex-workspace:project:p9')
    await runtime.close()
  })

  it('does not start a recovery for a Host whose Codex went away while a DSH workspace is on screen', async () => {
    const runtime = await makeRuntime()
    const lost = vi.fn(async () => undefined)
    seams(runtime).handleRemoteTransportLost = lost
    connect(runtime, { rpc: vi.fn(), close: vi.fn(async () => undefined), getStats: () => ({ mode: 'Relay' }) })
    seams(runtime).lastWorkspaceSelection = { targetDeviceId: 'host-1', workspaceId: 'workspace-1' }

    seams(runtime).noteCodexSessionLost('call-failed')
    expect(lost).not.toHaveBeenCalled()

    seams(runtime).lastWorkspaceSelection = {
      targetDeviceId: 'host-1',
      workspaceId: 'codex-workspace:project:p1',
      backend: 'codex',
    }
    seams(runtime).noteCodexSessionLost('call-failed')
    expect(lost).toHaveBeenCalledWith(expect.anything(), 'host-1', 'codex-closed')
    await runtime.close()
  })

  it('treats connecting to browse a Host as browsing, never as a session', async () => {
    // The rule the panel's whole flow rests on: opening it, connecting to a Host and looking at or picking its
    // workspaces is not a session. The user is still in the local shell, so nothing may be armed for a later
    // reconnect and nothing may switch the window to that Host's workspace.
    const runtime = await makeRuntime()
    const client = { rpc: vi.fn(), close: vi.fn(async () => undefined), getStats: () => ({ mode: 'Relay' }) }
    const stub = { client, target: { deviceId: 'host-1', name: 'Workstation' }, features: remoteHostFeatures() }
    const connectWithReason = vi.fn(async () => stub)
    seams(runtime).connectWithReason = connectWithReason

    await (runtime as unknown as { ensureBrowsing(id: string): Promise<unknown> }).ensureBrowsing('host-1')

    // Browsing is not the session, so the runtime does not claim to be connected remotely.
    expect(connectWithReason).toHaveBeenCalledOnce()
    expect(runtime.status()).toMatchObject({ connected: false, fellBackToLocal: false })
    expect(runtime.status()).not.toHaveProperty('reconnecting')
    expect((runtime as unknown as { browsing?: { target: { deviceId: string } } }).browsing)
      .toMatchObject({ target: { deviceId: 'host-1' } })

    // And its loss is ignored: no quick window, no fallback, no retry schedule.
    const reestablish = vi.fn(async () => true)
    seams(runtime).reestablish = reestablish
    await seams(runtime).handleRemoteTransportLost(client, 'host-1', 'transport-closed')
    expect(reestablish).not.toHaveBeenCalled()
    expect(runtime.status()).not.toHaveProperty('reconnecting')
    expect(runtime.status()).toMatchObject({ fellBackToLocal: false })
    // Forgotten, though: a browse connection lives outside `connected`, so the session guard below dropped its
    // close on the floor and kept handing the dead client back to the panel - the card then answered "the
    // authenticated Noise channel is not connected" until the plugin was restarted, with the Host healthy and
    // accepting control. The next request has to open a fresh connection instead.
    expect((runtime as unknown as { browsing?: unknown }).browsing).toBeUndefined()
    expect(client.close).toHaveBeenCalled()
    await runtime.close()
  })

  it('walks the background ladder five, ten, twenty, then thirty, and stops', async () => {
    // The intervals the whole recovery rides on: after the quick window is spent, the retries must be spaced
    // out and must end. Leaving the loop unbounded would retry a Host that is gone forever.
    const runtime = await makeRuntime()
    const client = { rpc: vi.fn(), close: vi.fn(async () => undefined), getStats: () => ({ mode: 'Relay' }) }
    connect(runtime, client)
    const target = { deviceId: 'host-1', kind: 'harness' as const, workspaceId: 'workspace-1' }
    seams(runtime).lastWorkspaceSelection = { targetDeviceId: 'host-1', workspaceId: 'workspace-1' }
    const restoreSession = vi.fn(async () => false)
    seams(runtime).restoreSession = restoreSession
    seams(runtime).reconnecting = { targetDeviceId: 'host-1', phase: 'fallback' }

    vi.useFakeTimers()
    try {
      const ladder = seams(runtime).reconnectRemoteSession('host-1', target)
      // 5 + 10 + 20 + 30 + 30 + 30 + 30 seconds, one attempt each.
      await vi.advanceTimersByTimeAsync(155_000)
      await ladder
    } finally {
      vi.useRealTimers()
    }

    expect(restoreSession).toHaveBeenCalledTimes(7)
    // The ladder is spent, so the header stops advertising a reconnect and the user is simply local.
    expect(runtime.status()).not.toHaveProperty('reconnecting')
    await runtime.close()
  })

  it('never forces remote mode when there is no session to restore', async () => {
    const runtime = await makeRuntime()
    const setMode = vi.spyOn(runtime, 'setMode')
    seams(runtime).lastWorkspaceSelection = undefined

    // The retry schedule must not be able to put the window on a Host's DSH workspace just because the Host is
    // reachable: with nothing remembered, the answer is the local shell.
    await seams(runtime).reconnectRemoteSession('host-1', undefined)

    expect(setMode).not.toHaveBeenCalled()
    expect(runtime.status()).not.toHaveProperty('reconnecting')
    await runtime.close()
  })

  it('names the session being recovered, not the carrier that happens to be live', async () => {
    // A Codex recovery falls back to the local shell, so the header could no longer read the kind off the live
    // carrier: it said "remote DSH, reconnecting" while a Codex session was the one coming back.
    const runtime = await makeRuntime()
    const client = { rpc: vi.fn(), close: vi.fn(async () => undefined), getStats: () => ({ mode: 'Relay' }) }
    connect(runtime, client)
    seams(runtime).reconnecting = { targetDeviceId: 'host-1', phase: 'fallback' }

    seams(runtime).lastWorkspaceSelection = {
      targetDeviceId: 'host-1',
      workspaceId: 'codex-workspace:project:p1',
      backend: 'codex',
    }
    expect(runtime.status()).toMatchObject({ reconnecting: { kind: 'codex', phase: 'fallback' } })

    seams(runtime).lastWorkspaceSelection = { targetDeviceId: 'host-1', workspaceId: 'workspace-1' }
    expect(runtime.status()).toMatchObject({ reconnecting: { kind: 'harness' } })

    // Another Host's session says nothing about this one.
    seams(runtime).lastWorkspaceSelection = { targetDeviceId: 'host-2', workspaceId: 'workspace-1' }
    expect(runtime.status()).toMatchObject({ reconnecting: { targetDeviceId: 'host-1' } })
    expect(runtime.status().reconnecting).not.toHaveProperty('kind')
    await runtime.close()
  })

  it('keeps the remote view through the Codex quick window and only then falls back', async () => {
    // The reported bug: a Codex-only loss went straight to the local shell, skipping the quick window entirely,
    // so the user never saw "reconnecting" and the workspace changed under them immediately.
    const runtime = await makeRuntime()
    const client = { rpc: vi.fn(), close: vi.fn(async () => undefined), getStats: () => ({ mode: 'Relay' }) }
    connect(runtime, client)
    seams(runtime).lastWorkspaceSelection = {
      targetDeviceId: 'host-1',
      workspaceId: 'codex-workspace:project:p1',
      backend: 'codex',
    }
    const reestablish = vi.fn(async () => true)
    seams(runtime).reestablish = reestablish
    const restoreSession = vi.fn(async () => false)
    seams(runtime).restoreSession = restoreSession

    // Fake clocks: the window really waits five seconds between attempts and holds the view for its whole
    // length, and burning that in real time only starves the tests running beside it.
    vi.useFakeTimers()
    try {
      const lost = seams(runtime).handleRemoteTransportLost(client, 'host-1', 'codex-closed')

      // Phase 1: the user keeps looking at the session while the window runs - no local fallback yet.
      expect(runtime.status()).toMatchObject({
        fellBackToLocal: false,
        reconnecting: { targetDeviceId: 'host-1', phase: 'fast' },
      })

      await vi.advanceTimersByTimeAsync(10_000)
      await lost

      // Phase 1 spent both attempts; the link was never rebuilt, because this Host only replaced its Codex domain.
      expect(restoreSession).toHaveBeenCalledTimes(2)
      expect(reestablish).not.toHaveBeenCalled()
      // Phase 2: the session is handed to the local shell, with the retry ladder still advertised.
      expect(runtime.status()).toMatchObject({
        fellBackToLocal: true,
        reconnecting: { targetDeviceId: 'host-1', phase: 'fallback' },
      })
      // Supersede the running schedule so it does not keep a timer alive in the test.
      await runtime.setMode('local')
      await runtime.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves another Host’s session alone when Refresh asks to recover the current one', async () => {
    const runtime = await makeRuntime()
    const client = { rpc: vi.fn(), close: vi.fn(async () => undefined), getStats: () => ({ mode: 'Relay' }) }
    connect(runtime, client, 'host-2')
    seams(runtime).lastWorkspaceSelection = {
      targetDeviceId: 'host-1',
      workspaceId: 'codex-workspace:project:p1',
      backend: 'codex',
    }
    const probe = vi.spyOn(runtime, 'probeRemoteFeatures')

    await seams(runtime).recoverCurrentSession()

    // The user has since chosen host-2, so a Refresh must not drag them back to host-1.
    expect(probe).not.toHaveBeenCalled()
    expect(runtime.status()).not.toHaveProperty('reconnecting')
    expect(runtime.status()).toMatchObject({ fellBackToLocal: false })
    await runtime.close()
  })

  it('tells a switched-off Codex apart from a Host that never provided one', async () => {
    const runtime = await makeRuntime()
    const rpc = vi.fn(async () => ({ capabilities: ['harness.remote.v1'] }))
    connect(runtime, { rpc, close: vi.fn(async () => undefined), getStats: () => ({ mode: 'Relay' }) })

    await expect(runtime.listCodexWorkspaces('host-1')).rejects.toMatchObject({ code: 'CODEX_NOT_PROVIDED' })

    seams(runtime).codexHostsSeen.add('host-1')
    await expect(runtime.listCodexWorkspaces('host-1')).rejects.toMatchObject({ code: 'CODEX_DISABLED' })
    await runtime.close()
  })

  it('keeps the remembered Codex workspace across a restart through the target record', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'dsh-client-recovery-state-'))
    directories.push(stateDirectory)
    const store = new ClientTargetStore(stateDirectory)
    await store.save({
      mode: 'remote',
      hostDeviceId: 'host-1',
      hostName: 'Workstation',
      serverUrl: config().serverUrl,
      workspace: {
        workspaceId: 'codex-workspace:project:p1',
        kind: 'codex',
        workspacePath: '/srv/project',
        sessionId: 'codex:s1',
      },
    })
    const runtime = await makeRuntime({ targetStore: store })

    await expect(runtime.restoreLastTarget()).resolves.toBe(true)
    // The kind is seeded before the first attempt, so the recovery cannot settle on the Host's DSH workspace.
    expect(seams(runtime).sessionTargetFor('host-1')).toMatchObject({
      kind: 'codex',
      workspacePath: '/srv/project',
    })
    await runtime.setMode('local')
    await runtime.close()
  })
  it('retries in place when this client\'s own connection replacement closed the link', async () => {
    // The reported case: the panel refresh and the automatic reconnect both open a control connection, the Server
    // closes the older one with 4003, and the link built on it dies with CONNECTION_REPLACED. That must read as a
    // retry, not as the peer going away - falling back here is what looked like a dropped sign-in.
    const runtime = await makeRuntime()
    const client = { rpc: vi.fn(), close: vi.fn(async () => undefined), getStats: () => ({ mode: 'Relay' }) }
    connect(runtime, client)
    seams(runtime).lastWorkspaceSelection = { targetDeviceId: 'host-1', workspaceId: 'workspace-1' }
    const quick = vi.fn(async () => true)
    seams(runtime).quickReconnectSession = quick

    await seams(runtime).handleRemoteTransportLost(client, 'host-1', 'CONNECTION_REPLACED')

    expect(quick).toHaveBeenCalledTimes(1)
    expect(seams(runtime).fellBackToLocal).toBeFalsy()
    await runtime.close()
  })

  it('keeps the target and the ladder when that replacement retry does not land', async () => {
    const runtime = await makeRuntime()
    const client = { rpc: vi.fn(), close: vi.fn(async () => undefined), getStats: () => ({ mode: 'Relay' }) }
    connect(runtime, client)
    const selection = { targetDeviceId: 'host-1', workspaceId: 'workspace-1' }
    seams(runtime).lastWorkspaceSelection = selection
    seams(runtime).quickReconnectSession = vi.fn(async () => false)
    const ladder = vi.fn(async () => undefined)
    seams(runtime).reconnectRemoteSession = ladder

    await seams(runtime).handleRemoteTransportLost(client, 'host-1', 'CONNECTION_REPLACED')

    expect(ladder).toHaveBeenCalledTimes(1)
    expect(seams(runtime).fellBackToLocal).toBeFalsy()
    expect(seams(runtime).lastWorkspaceSelection).toEqual(selection)
    expect(seams(runtime).reconnecting?.phase).toBe('fast')
    await runtime.close()
  })

})

function config(): ResolvedConfig {
  return {
    terminal: { enabled: false },
    loopback: { ports: [] },
    enabled: true,
    serverUrl: 'https://dsh.r2049.cn',
    deviceName: 'Local Harness',
    forceRelay: false,
    logLevel: 'error',
    reconnect: { enabled: true, initialDelayMs: 100, maxDelayMs: 1_000, jitter: 0 , replacedRetryMs: 1 },
    codex: { enabled: false, binary: 'codex' },
  }
}

function apiProxy(): ApiProxy {
  const empty = {}
  return {
    sessions: { list: vi.fn() },
    subagents: empty,
    host: empty,
    workspace: empty,
    skills: empty,
    agentPresets: empty,
    goals: empty,
    settings: empty,
    credentials: empty,
    llm: empty,
    events: empty,
    downloads: empty,
    respond: async () => ({ accepted: true }),
  } as unknown as ApiProxy
}

function logger(): SafeLogger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as SafeLogger
}

function gateway(): { invoke(request: unknown): Promise<unknown> } {
  return { invoke: vi.fn(async () => undefined) }
}

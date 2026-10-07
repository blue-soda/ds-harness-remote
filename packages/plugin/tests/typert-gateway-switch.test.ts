import { describe, expect, it, vi } from 'vitest'
import type { TypertGatewayLike } from '../src/harness-api-bridge.js'
import { TypertGatewaySwitch } from '../src/typert-gateway-switch.js'

describe('TypertGatewaySwitch', () => {
  it('routes command catalog and execution to the selected Host while leaving other calls local', async () => {
    const localInvoke = vi.fn(async () => 'local')
    const remoteInvoke = vi.fn(async () => 'remote')
    const gateway: TypertGatewayLike = { invoke: localInvoke }
    const target = new TypertGatewaySwitch(gateway)
    const alwaysLocal = target.local()

    target.install()
    await expect(gateway.invoke(command())).resolves.toBe('local')
    await expect(gateway.invoke(commandList())).resolves.toBe('local')
    target.selectRemote(remoteInvoke)
    await expect(gateway.invoke(command())).resolves.toBe('remote')
    await expect(gateway.invoke(commandList())).resolves.toBe('remote')
    await expect(gateway.invoke({ namespace: 'goals', method: 'create', args: { agentId: 's1' } })).resolves.toBe('local')
    await expect(alwaysLocal.invoke(command())).resolves.toBe('local')
    target.selectLocal()
    await expect(gateway.invoke(command())).resolves.toBe('local')
    expect(remoteInvoke).toHaveBeenCalledTimes(2)
  })

  it('returns an empty command catalog for legacy Hosts while forwarding execution', async () => {
    const localInvoke = vi.fn(async () => 'local')
    const remoteInvoke = vi.fn(async () => 'remote')
    const gateway: TypertGatewayLike = { invoke: localInvoke }
    const target = new TypertGatewaySwitch(gateway)

    target.install()
    target.selectRemote(remoteInvoke, { execute: true, list: false })

    await expect(gateway.invoke(command())).resolves.toBe('remote')
    await expect(gateway.invoke(commandList())).resolves.toEqual([])
    expect(remoteInvoke).toHaveBeenCalledOnce()
    expect(localInvoke).not.toHaveBeenCalled()
  })

  it('stops serving remote data locally once the peer is gone', async () => {
    const localDispatch = vi.fn(async () => ({ ok: true as const, value: 'local' }))
    const gateway = { invoke: vi.fn(async () => 'local'), dispatchRpc: localDispatch } as unknown as TypertGatewayLike
    const dispatch = (endpoint: string): Promise<unknown> => (
      gateway as unknown as { dispatchRpc(endpoint: string, payload: unknown, signal: AbortSignal): Promise<unknown> }
    ).dispatchRpc(endpoint, {}, new AbortController().signal)
    const target = new TypertGatewaySwitch(gateway)
    target.install()
    const gone = Object.assign(new Error('The authenticated Noise channel is not connected.'), { code: 'TRANSPORT_CLOSED' })
    const goneTarget = {
      invoke: vi.fn(async () => { throw gone }),
      dispatch: vi.fn(async () => { throw gone }),
      open: vi.fn(async () => { throw gone }),
    }

    // A peer that is gone must not be papered over with local data: the native UI would cache a local
    // answer as if the remote workspace had produced it, which is how a session list stays wrong.
    target.selectRemote(goneTarget as never)
    await expect(dispatch('session/list')).rejects.toMatchObject({ code: 'TRANSPORT_CLOSED' })
    expect(localDispatch).not.toHaveBeenCalled()

    // A refusal is a capability mismatch instead, so the local shell still answers it.
    const refused = Object.assign(new Error('not allowed'), { code: 'METHOD_NOT_ALLOWED' })
    target.selectRemote({
      invoke: vi.fn(async () => { throw refused }),
      dispatch: vi.fn(async () => { throw refused }),
      open: vi.fn(async () => { throw refused }),
    } as never)
    await expect(dispatch('session/list')).resolves.toMatchObject({ value: 'local' })

    // The bootstrap a window cannot start without keeps answering even while the peer is gone.
    target.selectRemote(goneTarget as never)
    await expect(dispatch('settings/describe')).resolves.toMatchObject({ value: 'local' })
  })

  it('restores the original gateway method', () => {
    const invoke = vi.fn(async () => undefined)
    const gateway: TypertGatewayLike = { invoke }
    const target = new TypertGatewaySwitch(gateway)
    target.install()
    target.restore()
    expect(gateway.invoke).toBe(invoke)
  })

  it('switches alpha unary, stream, and internal carrier calls together', async () => {
    const localInvoke = vi.fn(async (_request: Parameters<TypertGatewayLike['invoke']>[0]) => 'local-invoke')
    const localStream = vi.fn(async (_request: Parameters<TypertGatewayLike['invoke']>[0]) => (
      async function* () { yield 'local-stream' }
    )())
    const localDispatch = vi.fn(async (_endpoint: string, _payload: unknown, _signal: AbortSignal) => (
      { ok: true as const, value: 'local-dispatch' }
    ))
    const localOpen = vi.fn(async (_endpoint: string, _payload: unknown, _signal: AbortSignal) => (
      async function* () { yield 'local-open' }
    )())
    const gateway = {
      invoke: localInvoke,
      stream: localStream,
      dispatchRpc: localDispatch,
      openWireStream: localOpen,
      wireStream: {
        open: localOpen,
        failure: () => ({ code: 'internal', message: 'failed', details: {} }),
      },
    }
    const remote = {
      invoke: vi.fn(async () => 'remote-invoke'),
      dispatch: vi.fn(async () => ({ ok: true as const, value: 'remote-dispatch' })),
      open: vi.fn(async () => (async function* () { yield 'remote-open' })()),
    }
    const target = new TypertGatewaySwitch(gateway)
    const alwaysLocal = target.local()

    target.install()
    target.selectRemote(remote)

    await expect(gateway.invoke({ namespace: 'session', method: 'list', args: {} })).resolves.toBe('remote-invoke')
    await expect(gateway.dispatchRpc('session/list', { args: {} }, new AbortController().signal))
      .resolves.toEqual({ ok: true, value: 'remote-dispatch' })
    await expect(values(await gateway.openWireStream('$events', { args: {} }, new AbortController().signal)))
      .resolves.toEqual(['remote-open'])
    await expect(alwaysLocal.dispatch('session/list', { args: {} }, new AbortController().signal))
      .resolves.toEqual({ ok: true, value: 'local-dispatch' })

    target.selectLocal()
    await expect(gateway.invoke({ namespace: 'session', method: 'list', args: {} })).resolves.toBe('local-invoke')
    await expect(values(await gateway.openWireStream('session/follow', { args: {} }, new AbortController().signal)))
      .resolves.toEqual(['local-open'])
  })

  it('keeps dynamic Cordis UI runtime calls local in alpha remote mode', async () => {
    const localInvoke = vi.fn(async (_request: Parameters<TypertGatewayLike['invoke']>[0]) => 'local-invoke')
    const localStream = vi.fn(async (_request: Parameters<TypertGatewayLike['invoke']>[0]) => (
      async function* () { yield 'local-stream' }
    )())
    const localDispatch = vi.fn(async (_endpoint: string, _payload: unknown, _signal: AbortSignal) => (
      { ok: true as const, value: 'local-dispatch' }
    ))
    const localOpen = vi.fn(async (_endpoint: string, _payload: unknown, _signal: AbortSignal) => (
      async function* () { yield 'local-open' }
    )())
    const gateway = {
      invoke: localInvoke,
      stream: localStream,
      dispatchRpc: localDispatch,
      openWireStream: localOpen,
      wireStream: {
        open: localOpen,
        failure: () => ({ code: 'internal', message: 'failed', details: {} }),
      },
    }
    const remote = {
      invoke: vi.fn(async () => 'remote-invoke'),
      dispatch: vi.fn(async () => ({ ok: true as const, value: 'remote-dispatch' })),
      open: vi.fn(async () => (async function* () { yield 'remote-open' })()),
    }
    const target = new TypertGatewaySwitch(gateway)
    const signal = new AbortController().signal

    target.install()
    target.selectRemote(remote)

    await expect(gateway.invoke({ namespace: 'dynamicCordisRunner', method: 'inventory', args: {} }))
      .resolves.toBe('local-invoke')
    await expect(values(await gateway.stream({ namespace: 'dynamicCordisRunner', method: 'events', args: {} })))
      .resolves.toEqual(['local-stream'])
    await expect(gateway.dispatchRpc('dynamicCordisRunner/getClientCode', { args: {} }, signal))
      .resolves.toEqual({ ok: true, value: 'local-dispatch' })
    await expect(values(await gateway.openWireStream('dynamicCordisRunner/events', { args: {} }, signal)))
      .resolves.toEqual(['local-open'])
    expect(remote.invoke).not.toHaveBeenCalled()
    expect(remote.dispatch).not.toHaveBeenCalled()
    expect(remote.open).not.toHaveBeenCalled()
  })
  it('carries the signal to the rc.1 fifth slot and never as the third argument (P0-2)', async () => {
    const calls: unknown[][] = []
    // A real six-parameter function keeps `.length === 6` so the switch detects the rc.1 arity.
    function rc1Open(
      endpoint: string,
      payload: unknown,
      uplink: AsyncIterable<unknown>,
      peer: unknown,
      signal: AbortSignal,
      control: AbortController,
    ): Promise<AsyncIterable<unknown>> {
      calls.push([endpoint, payload, uplink, peer, signal, control])
      return Promise.resolve((async function* () { yield 'rc1-open' })())
    }
    const gateway = {
      invoke: vi.fn(async () => 'local-invoke'),
      dispatchRpc: vi.fn(async () => ({ ok: true as const, value: 'local-dispatch' })),
      openWireStream: rc1Open,
      wireStream: {
        open: async (_endpoint: string, _payload: unknown, _signal: AbortSignal) => (async function* () { yield 'rc1-wire' })(),
        failure: () => ({ code: 'internal', message: 'failed', details: {} }),
      },
    }
    const remote = {
      invoke: vi.fn(async () => 'remote-invoke'),
      dispatch: vi.fn(async () => ({ ok: true as const, value: 'remote-dispatch' })),
      open: vi.fn(async () => (async function* () { yield 'remote-open' })()),
    }
    const target = new TypertGatewaySwitch(gateway)
    const alwaysLocal = target.local()
    target.install()
    target.selectRemote(remote)

    const signal = new AbortController().signal
    await expect(values(await alwaysLocal.open('$events', { args: {} }, signal))).resolves.toEqual(['rc1-open'])
    expect(calls).toHaveLength(1)
    const args = calls[0]!
    expect(typeof (args[2] as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator]).toBe('function')
    expect(args[3]).toBeUndefined()
    expect(args[4]).toBe(signal)
    expect(args[5]).toBeInstanceOf(AbortController)

    // The public carrier wrapper receives the same rc.1 argument order from the mux.
    calls.length = 0
    const muxSignal = new AbortController().signal
    const uplink = (async function* () {})()
    await expect(values(await gateway.openWireStream('$events', { args: {} }, uplink, undefined, muxSignal, new AbortController())))
      .resolves.toEqual(['remote-open'])
    expect(remote.open).toHaveBeenCalledWith('$events', { args: {} }, muxSignal)
  })

  it('keeps the legacy three-argument carrier contract for older Hosts', async () => {
    const legacy = vi.fn(async (_endpoint: string, _payload: unknown, _signal: AbortSignal) => (
      async function* () { yield 'legacy-open' }
    )())
    const gateway = {
      invoke: vi.fn(async () => 'local-invoke'),
      dispatchRpc: vi.fn(async () => ({ ok: true as const, value: 'local-dispatch' })),
      openWireStream: legacy,
      wireStream: { open: legacy, failure: () => ({ code: 'internal', message: 'failed', details: {} }) },
    }
    const target = new TypertGatewaySwitch(gateway)
    const alwaysLocal = target.local()
    target.install()

    const signal = new AbortController().signal
    await expect(values(await alwaysLocal.open('session/follow', { args: {} }, signal))).resolves.toEqual(['legacy-open'])
    expect(legacy).toHaveBeenCalledWith('session/follow', { args: {} }, signal)
  })
})

async function values(source: AsyncIterable<unknown>): Promise<unknown[]> {
  const result: unknown[] = []
  for await (const value of source) result.push(value)
  return result
}

function command(): Parameters<TypertGatewayLike['invoke']>[0] {
  return { namespace: 'commands', method: 'execute', args: { agentId: 's1', line: '/permission danger-full-access', images: [] } }
}

function commandList(): Parameters<TypertGatewayLike['invoke']>[0] {
  return { namespace: 'commands', method: 'list', args: { agentId: 's1' } }
}

describe('TypertGatewaySwitch carrier chain', () => {
  it('forwards data endpoints to the carrier it was installed in front of when it owns only commands', async () => {
    const localShell = vi.fn(async () => ({ ok: true as const, value: 'local-shell' }))
    const gateway = { invoke: vi.fn(async () => 'local'), dispatchRpc: localShell } as unknown as TypertGatewayLike
    const target = new TypertGatewaySwitch(gateway)

    // The rc.2 window installs the ApiProxy carrier first and then grants this switch the command namespace.
    const previousCarrier = vi.fn(async () => ({ ok: true as const, value: 'api-proxy' }))
    ;(gateway as unknown as { dispatchRpc: unknown }).dispatchRpc = previousCarrier
    target.install()
    target.selectRemote(async () => 'command', { execute: true, list: true })

    const dispatch = (endpoint: string): Promise<unknown> => (
      gateway as unknown as { dispatchRpc(endpoint: string, payload: unknown, signal: AbortSignal): Promise<unknown> }
    ).dispatchRpc(endpoint, {}, new AbortController().signal)

    // Answering this here reached the local shell and the native schema rejected the result.
    await expect(dispatch('workspaceFiles/readBytes')).resolves.toMatchObject({ value: 'api-proxy' })
    expect(previousCarrier).toHaveBeenCalledOnce()
    expect(localShell).not.toHaveBeenCalled()

    // With the peer gone - or not connected yet - the shell has to work locally again: the carrier behind
    // cannot serve it, and forwarding there made every local call fail.
    target.setRemoteAvailability(() => false)
    await expect(dispatch('session/create')).resolves.toMatchObject({ value: 'local-shell' })
    await expect(dispatch('session/list')).resolves.toMatchObject({ value: 'local-shell' })
    expect(previousCarrier).toHaveBeenCalledOnce()
  })
})

describe('TypertGatewaySwitch byte results', () => {
  it('restores bytes the CodeX projection answers as base64', async () => {
    const localDispatch = vi.fn(async () => ({ ok: true as const, value: 'local' }))
    const gateway = { invoke: vi.fn(async () => 'local'), dispatchRpc: localDispatch } as unknown as TypertGatewayLike
    const dispatch = (endpoint: string): Promise<unknown> => (
      gateway as unknown as { dispatchRpc(endpoint: string, payload: unknown, signal: AbortSignal): Promise<unknown> }
    ).dispatchRpc(endpoint, {}, new AbortController().signal)
    const target = new TypertGatewaySwitch(gateway)
    target.install()
    const remoteDispatch = vi.fn(async (): Promise<unknown> => ({
      ok: true as const,
      value: { absolutePath: 'C:/tmp/a.png', version: '1:2', bytes: 3, offset: 0, data: 'AAEC', eof: true },
    }))
    target.selectRemote({ invoke: vi.fn(), dispatch: remoteDispatch, open: vi.fn() } as never)

    // The native schema requires a real Uint8Array; base64 from the CodeX projection reaches it as
    // `expected "Uint8Array", path: ["data"]` and the image never renders.
    const result = await dispatch('workspaceFiles/readBytes') as { value: { data: unknown; absolutePath: string } }
    expect(result.value.data).toBeInstanceOf(Uint8Array)
    expect(Array.from(result.value.data as Uint8Array)).toEqual([0, 1, 2])
    expect(result.value.absolutePath).toBe('C:/tmp/a.png')

    // Already-binary and unrelated results are left exactly as they were.
    const binary = new Uint8Array([9])
    remoteDispatch.mockResolvedValueOnce({ ok: true as const, value: { data: binary } })
    const same = await dispatch('workspaceFiles/readBytes') as { value: { data: unknown } }
    expect(same.value.data).toBe(binary)
    remoteDispatch.mockResolvedValueOnce({ ok: true as const, value: { data: 'AAEC' } })
    const other = await dispatch('workspaceFiles/list') as { value: { data: unknown } }
    expect(other.value.data).toBe('AAEC')
  })
})

import { describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HarnessRemoteBridge } from '../src/harness-remote-bridge.js'
import { MAX_SECURE_MESSAGE_BYTES } from '@dsh-remote/protocol'
import { CodexWorkspaceBridge, type RemoteTerminalProcess, type RemoteTerminalSpawner } from '../src/codex-workspace-bridge.js'
import { TerminalPolicy } from '../src/terminal-policy.js'
import { RpcError } from '../src/rpc-router.js'
import type { LocalTypertGateway } from '../src/typert-gateway-contract.js'

describe('HarnessRemoteBridge', () => {
  it('forwards only the fixed alpha Gateway endpoint allowlist', async () => {
    const dispatch = vi.fn(async () => ({ ok: true as const, value: [{ id: 'session-1' }] }))
    const bridge = new HarnessRemoteBridge(gateway({ dispatch }), vi.fn(async () => undefined))

    await expect(bridge.call({ endpoint: 'session/list', payload: { args: {} } })).resolves.toEqual({
      ok: true,
      value: [{ id: 'session-1' }],
    })
    await expect(bridge.call({ endpoint: 'session/canOpenWorkspacePath', payload: { args: {} } })).resolves.toEqual({
      ok: true,
      value: true,
    })
    expect(dispatch).toHaveBeenCalledWith('session/list', { args: {} }, expect.any(AbortSignal))

    await expect(bridge.call({ endpoint: 'directoryPicker/pick', payload: { args: {} } }))
      .rejects.toMatchObject({ code: 'METHOD_NOT_ALLOWED' })
    await expect(bridge.call({ endpoint: 'session/openWorkspacePath', payload: { args: {} } }))
      .rejects.toMatchObject({ code: 'METHOD_NOT_ALLOWED' })
    await expect(bridge.call({ endpoint: 'settings/openConfigFile', payload: { args: {} } }))
      .rejects.toBeInstanceOf(RpcError)
    await expect(bridge.call({ endpoint: 'permissionPresets/catalog', payload: { args: {} } })).resolves.toMatchObject({ ok: true })
    expect(dispatch).toHaveBeenCalledWith('permissionPresets/catalog', { args: {} }, expect.any(AbortSignal))
    await expect(bridge.call({ endpoint: 'permissionPresets/select', payload: { args: {} } })).rejects.toMatchObject({ code: 'METHOD_NOT_ALLOWED' })
    expect(dispatch).toHaveBeenCalledTimes(2)
    for (const endpoint of ['session/projections', 'session/initializeDefaultModel', 'workspace/pinSession', 'workspace/unpinSession']) {
      const payload = { args: { request: { sessionId: 'session-1' } } }
      await expect(bridge.call({ endpoint, payload })).resolves.toMatchObject({ ok: true })
      expect(dispatch).toHaveBeenLastCalledWith(endpoint, payload, expect.any(AbortSignal))
    }
  })

  it('forwards the 0.2.2 job roster, follow and kill endpoints', async () => {
    const open = vi.fn(async () => (async function* () {
      yield { type: 'roster', jobs: [] }
    })())
    const dispatch = vi.fn(async () => ({ ok: true as const, value: { outcome: 'accepted' } }))
    const bridge = new HarnessRemoteBridge(gateway({ open, dispatch }), vi.fn(async () => undefined))

    await expect(bridge.openStream({
      streamId: 'job-list-1',
      endpoint: 'job/list',
      payload: { args: { request: { sessionId: 'session-1' } } },
    })).resolves.toEqual({ opened: true, streamId: 'job-list-1' })
    await expect(bridge.openStream({
      streamId: 'job-follow-1',
      endpoint: 'job/follow',
      payload: { args: { request: { sessionId: 'session-1', jobId: 'job-1' } } },
    })).resolves.toEqual({ opened: true, streamId: 'job-follow-1' })
    await expect(bridge.call({
      endpoint: 'job/kill',
      payload: { args: { request: { sessionId: 'session-1', jobId: 'job-1' } } },
    })).resolves.toMatchObject({ ok: true })

    expect(open).toHaveBeenCalledWith('job/list', { args: { request: { sessionId: 'session-1' } } }, expect.any(AbortSignal))
    expect(open).toHaveBeenCalledWith('job/follow', { args: { request: { sessionId: 'session-1', jobId: 'job-1' } } }, expect.any(AbortSignal))
    expect(dispatch).toHaveBeenCalledWith('job/kill', { args: { request: { sessionId: 'session-1', jobId: 'job-1' } } }, expect.any(AbortSignal))
  })

  it('falls back to Host directory metadata for the v0.1.2-rc.1 native-only picker failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-remote-alpha-directory-'))
    await mkdir(join(root, 'project'))
    const dispatch = vi.fn(async (endpoint: string) => {
      if (endpoint === 'directoryPicker/list') {
        return {
          ok: false as const,
          error: {
            code: 'directory-picker/unavailable',
            message: 'directoryPicker.list needs the browse capability; the composed picker serves "native"',
            details: { capability: 'native' },
          },
        }
      }
      return { ok: true as const }
    })
    const bridge = new HarnessRemoteBridge(gateway({ dispatch }), vi.fn(async () => undefined))

    try {
      await expect(bridge.call({
        endpoint: 'directoryPicker/list',
        payload: { args: { path: root } },
      })).resolves.toMatchObject({
        ok: true,
        value: {
          path: root,
          entries: [{ name: 'project', path: join(root, 'project') }],
        },
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each(['0.1.5-rc.1', '0.2.0-rc.1'])('selects the renamed command attachment field for a %s Host', async version => {
    const dispatch = vi.fn(async (_endpoint: string, payload: { args: Record<string, unknown> }) => {
      expect(payload.args).toEqual({ agentId: 'session-1', line: '/goal complete', submittedAttachments: [] })
      return { ok: true as const, value: { commandId: 'cmd-0.1.5' } }
    })
    const bridge = new HarnessRemoteBridge(gateway({ dispatch }), vi.fn(async () => undefined), undefined, version)

    await expect(bridge.call({
      endpoint: 'commands/execute',
      payload: { args: { agentId: 'session-1', line: '/goal complete', images: [] } },
    })).resolves.toEqual({ ok: true, value: { commandId: 'cmd-0.1.5' } })
    expect(dispatch).toHaveBeenCalledWith('commands/execute', {
      args: { agentId: 'session-1', line: '/goal complete', submittedAttachments: [] },
    }, expect.any(AbortSignal))
    expect(dispatch).toHaveBeenCalledOnce()
  })

  it('publishes alpha stream frames and an explicit terminal event', async () => {
    const publish = vi.fn(async () => undefined)
    const open = vi.fn(async () => (async function* () {
      yield { type: 'baseline', value: { items: [] } }
      yield { type: 'upsert', value: { id: 'workspace-1' } }
      yield undefined
    })())
    const bridge = new HarnessRemoteBridge(gateway({ open }), publish)

    await expect(bridge.openStream({
      streamId: 'workspace-stream-1',
      endpoint: 'workspace/follow',
      payload: { args: {} },
    })).resolves.toEqual({ opened: true, streamId: 'workspace-stream-1' })

    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(4))
    expect(open).toHaveBeenCalledWith('workspace/follow', { args: {} }, expect.any(AbortSignal))
    expect(publish.mock.calls[0]).toEqual([
      'harness.remote.frame',
      { streamId: 'workspace-stream-1', hasValue: true, value: { type: 'baseline', value: { items: [] } } },
    ])
    expect(publish.mock.calls[2]).toEqual([
      'harness.remote.frame',
      { streamId: 'workspace-stream-1', hasValue: true },
    ])
    expect(publish.mock.calls[3]).toEqual([
      'harness.remote.stream.closed',
      { streamId: 'workspace-stream-1', reason: 'completed' },
    ])
  })

  it.each(['0.1.7-rc.1', '0.2.0-rc.1'])('adds the workspace root to legacy file-change subscriptions on %s', async version => {
    const open = vi.fn(async () => (async function* () {
      yield { kind: 'ready' }
    })())
    const bridge = new HarnessRemoteBridge(
      gateway({ open }),
      vi.fn(async () => undefined),
      undefined,
      version,
    )

    await expect(bridge.openStream({
      streamId: 'file-changes-017',
      endpoint: 'workspaceFiles/changes',
      payload: { args: { workspaceFileScopeId: 'session-1' } },
    })).resolves.toEqual({ opened: true, streamId: 'file-changes-017' })
    expect(open).toHaveBeenCalledWith(
      'workspaceFiles/changes',
      { args: { workspaceFileScopeId: 'session-1', path: '.' } },
      expect.any(AbortSignal),
    )
  })

  it('does not add the 0.1.7 path field to legacy Hosts', async () => {
    const open = vi.fn(async () => (async function* () {
      yield { kind: 'ready' }
    })())
    const bridge = new HarnessRemoteBridge(
      gateway({ open }),
      vi.fn(async () => undefined),
      undefined,
      '0.1.6-alpha.2',
    )

    await bridge.openStream({
      streamId: 'file-changes-016',
      endpoint: 'workspaceFiles/changes',
      payload: { args: { workspaceFileScopeId: 'session-1' } },
    })
    expect(open).toHaveBeenCalledWith(
      'workspaceFiles/changes',
      { args: { workspaceFileScopeId: 'session-1' } },
      expect.any(AbortSignal),
    )
  })

  it('re-roots a relative workspace file path through the live working directory', async () => {
    const headerCwd = join(tmpdir(), 'practice')
    const liveCwd = join(headerCwd, 'kotlin')
    const dispatch = vi.fn(async (endpoint: string, payload: { args?: { path?: string } }) => {
      if (endpoint === 'session/projections') {
        return { ok: true as const, value: { asOfSeq: 1, values: { workingDirectory: liveCwd } } }
      }
      if (endpoint === 'workspaceFiles/stat') {
        return { ok: true as const, value: { exists: payload.args?.path === join('kotlin', 'phase-1-kotlin-basics/notes/00-prologue.md') } }
      }
      return { ok: true as const }
    })
    const bridge = new HarnessRemoteBridge(
      gateway({ dispatch }),
      vi.fn(async () => undefined),
      undefined,
      undefined,
      undefined,
      undefined,
      () => headerCwd,
    )

    await expect(bridge.call({
      endpoint: 'workspaceFiles/stat',
      payload: { args: { workspaceFileScopeId: 'session-1', path: 'phase-1-kotlin-basics/notes/00-prologue.md' } },
    })).resolves.toEqual({ ok: true, value: { exists: true } })
    expect(dispatch).toHaveBeenCalledWith('workspaceFiles/stat', {
      args: {
        workspaceFileScopeId: 'session-1',
        path: join('kotlin', 'phase-1-kotlin-basics/notes/00-prologue.md'),
      },
    }, expect.any(AbortSignal))
  })

  it('re-roots an absolute workspace file path that was built from the header root', async () => {
    const headerCwd = join(tmpdir(), 'practice')
    const liveCwd = join(headerCwd, 'kotlin')
    const dispatch = vi.fn(async (endpoint: string) => {
      if (endpoint === 'session/projections') {
        return { ok: true as const, value: { asOfSeq: 1, values: { workingDirectory: liveCwd } } }
      }
      if (endpoint === 'workspaceFiles/stat') {
        return { ok: true as const, value: { exists: true } }
      }
      return { ok: true as const }
    })
    const bridge = new HarnessRemoteBridge(
      gateway({ dispatch }),
      vi.fn(async () => undefined),
      undefined,
      undefined,
      undefined,
      undefined,
      () => headerCwd,
    )

    await expect(bridge.call({
      endpoint: 'workspaceFiles/stat',
      payload: { args: { workspaceFileScopeId: 'session-1', path: join(headerCwd, 'phase-1/notes/00.md') } },
    })).resolves.toEqual({ ok: true, value: { exists: true } })
    expect(dispatch).toHaveBeenCalledWith('workspaceFiles/stat', {
      args: { workspaceFileScopeId: 'session-1', path: join(liveCwd, 'phase-1/notes/00.md') },
    }, expect.any(AbortSignal))
  })

  it('falls back to the original workspace file path when the re-rooted path misses', async () => {
    const headerCwd = join(tmpdir(), 'practice')
    const liveCwd = join(headerCwd, 'kotlin')
    const seen: string[] = []
    const dispatch = vi.fn(async (endpoint: string, payload: { args?: { path?: string } }) => {
      if (endpoint === 'session/projections') {
        return { ok: true as const, value: { asOfSeq: 1, values: { workingDirectory: liveCwd } } }
      }
      if (endpoint === 'workspaceFiles/stat') {
        const path = payload.args?.path ?? ''
        seen.push(path)
        return { ok: true as const, value: { exists: path === 'phase-1-kotlin-basics/notes/00-prologue.md' } }
      }
      return { ok: true as const }
    })
    const bridge = new HarnessRemoteBridge(
      gateway({ dispatch }),
      vi.fn(async () => undefined),
      undefined,
      undefined,
      undefined,
      undefined,
      () => headerCwd,
    )

    await expect(bridge.call({
      endpoint: 'workspaceFiles/stat',
      payload: { args: { workspaceFileScopeId: 'session-1', path: 'phase-1-kotlin-basics/notes/00-prologue.md' } },
    })).resolves.toEqual({ ok: true, value: { exists: true } })
    expect(seen).toEqual([
      join('kotlin', 'phase-1-kotlin-basics/notes/00-prologue.md'),
      'phase-1-kotlin-basics/notes/00-prologue.md',
    ])
  })

  it.each(['0.1.7-rc.1', '0.2.0-rc.1'])('nests readBytes ranges for a %s Host', async version => {
    const dispatch = vi.fn(async () => ({ ok: true as const, value: { bytes: '' } }))
    const bridge = new HarnessRemoteBridge(
      gateway({ dispatch }),
      vi.fn(async () => undefined),
      undefined,
      version,
    )

    await bridge.call({
      endpoint: 'workspaceFiles/readBytes',
      payload: {
        args: {
          workspaceFileScopeId: 'session-1',
          path: '/tmp/a.bin',
          range: { offset: 0, length: 1024 },
        },
      },
    })
    expect(dispatch).toHaveBeenCalledWith('workspaceFiles/readBytes', {
      args: {
        workspaceFileScopeId: 'session-1',
        path: '/tmp/a.bin',
        options: { range: { offset: 0, length: 1024 } },
      },
    }, expect.any(AbortSignal))
  })

  it('keeps the legacy readBytes range shape for older Hosts', async () => {
    const dispatch = vi.fn(async () => ({ ok: true as const, value: { bytes: '' } }))
    const bridge = new HarnessRemoteBridge(
      gateway({ dispatch }),
      vi.fn(async () => undefined),
      undefined,
      '0.1.6-alpha.2',
    )
    const payload = {
      args: {
        workspaceFileScopeId: 'session-1',
        path: '/tmp/a.bin',
        range: { offset: 0, length: 1024 },
      },
    }

    await bridge.call({ endpoint: 'workspaceFiles/readBytes', payload })
    expect(dispatch).toHaveBeenCalledWith('workspaceFiles/readBytes', payload, expect.any(AbortSignal))
  })

  it('normalizes alpha stream failures without exposing the original error', async () => {
    const publish = vi.fn(async () => undefined)
    const bridge = new HarnessRemoteBridge(gateway({
      open: async () => (async function* () {
        throw Object.assign(new Error('sensitive local failure'), { code: 'gateway-failed' })
      })(),
      failure: () => ({ code: 'gateway-failed', message: 'Request failed.', details: {} }),
    }), publish)

    await bridge.openStream({ streamId: 'events-stream-1', endpoint: '$events', payload: { args: {} } })

    await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce())
    expect(publish).toHaveBeenCalledWith('harness.remote.stream.closed', {
      streamId: 'events-stream-1',
      reason: 'failed',
      failure: { code: 'gateway-failed', message: 'Request failed.', details: {} },
    })
  })

  it('routes CodeX terminal calls to the CodeX carrier and keeps device ownership', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-remote-codex-terminal-'))
    const dispatch = vi.fn(async () => ({ ok: true as const }))
    const bridge = new HarnessRemoteBridge(gateway({ dispatch }), vi.fn(async () => undefined), undefined, undefined,
      new TerminalPolicy(() => true, 'device-a', new Map()),
      new CodexWorkspaceBridge(async () => root, () => true, undefined, stubTerminalSpawner()))

    await expect(bridge.call({ endpoint: 'terminal/environment', payload: { args: { agentId: 'codex:one' } } }))
      .resolves.toMatchObject({ ok: true, value: { cwd: await realpath(root), scrollback: expect.any(Number) } })
    await expect(bridge.call({ endpoint: 'terminal/create', payload: { args: { agentId: 'codex:one', request: { id: 't1', cols: 80, rows: 24 } } } }))
      .resolves.toMatchObject({ ok: true, value: { id: 't1', shell: { path: expect.any(String) } } })
    expect(dispatch).not.toHaveBeenCalled()

    // A Harness session still reaches the official Gateway.
    await bridge.call({ endpoint: 'terminal/environment', payload: { args: { agentId: 'session-1' } } })
    expect(dispatch).toHaveBeenCalledWith('terminal/environment', { args: { agentId: 'session-1' } }, expect.any(AbortSignal))

    // The terminal belongs to the creating device only.
    const other = new HarnessRemoteBridge(gateway(), vi.fn(async () => undefined), undefined, undefined,
      new TerminalPolicy(() => true, 'device-b', new Map()),
      new CodexWorkspaceBridge(async () => root, () => true, undefined, stubTerminalSpawner()))
    await expect(other.call({ endpoint: 'terminal/list', payload: { args: { sessionId: 'codex:one' } } }))
      .resolves.toEqual({ ok: true, value: [] })
    await bridge.closeAll(); await other.closeAll(); await rm(root, { recursive: true, force: true })
  })

  // Regression: a session with one long Turn is paged by `maxMessages` (the turn window never finds the
  // second Turn start), and DSH's client asks for 500 of them. One real session was 6 MB, so its follow
  // snapshot exceeded the 4 MiB secure-message limit: the frame could not be encrypted, the peer
  // connection dropped, and every Session on it sat on "history loading" until a timeout. Each attempt
  // is now measured and the request steps down until the page fits.
  it('steps a history page down until one secure message can carry it', async () => {
    const dispatch = vi.fn(async (_endpoint: string, payload: { args: { maxMessages: number } }) => pageOf(payload.args.maxMessages))
    const bridge = new HarnessRemoteBridge(gateway({ dispatch }), vi.fn(async () => undefined))

    await expect(bridge.call({
      endpoint: 'session/page',
      payload: { args: {
        address: { kind: 'session', sessionId: 'session-1' },
        throughSeq: 42,
        maxMessages: 500,
        turnWindow: { minMessages: 200, minTurns: 2 },
      } },
    })).resolves.toMatchObject({ ok: true, value: { blob: 'small' } })

    const attempts = dispatch.mock.calls.map(([, payload]) => (payload as { args: Record<string, unknown> }).args)
    expect(attempts.map(args => args['maxMessages'])).toEqual([50, 30])
    // Only the window changes: the cursor and address stay exactly as the client sent them.
    expect(attempts.map(args => args['throughSeq'])).toEqual([42, 42])
    expect(attempts.every(args => (args['address'] as { sessionId: string }).sessionId === 'session-1')).toBe(true)
    // The turn minimum follows the window down, or DSH rejects the page.
    expect(attempts[1]!['turnWindow']).toEqual({ minMessages: 30, minTurns: 2 })

    // Endpoints outside history keep the window the client asked for.
    await bridge.call({ endpoint: 'session/list', payload: { args: { maxMessages: 500 } } })
    expect(dispatch).toHaveBeenLastCalledWith('session/list', { args: { maxMessages: 500 } }, expect.any(AbortSignal))
  })

  // The official DSH client wraps the call as `{ request: {...} }` (TypertRemoteMethod). Rewriting
  // the top level instead of that request added a stray `maxMessages`, the Host's strict schema threw,
  // and every Session failed with `gateway/internal`.
  it('rewrites the window inside the official Typert request wrapper', async () => {
    const dispatch = vi.fn(async (_endpoint: string, payload: { request: { maxMessages: number } }) => pageOf(payload.request.maxMessages))
    const bridge = new HarnessRemoteBridge(gateway({ dispatch }), vi.fn(async () => undefined))

    await expect(bridge.call({
      endpoint: 'session/page',
      payload: { request: {
        address: { kind: 'session', sessionId: 'session-1' },
        throughSeq: 42,
        maxMessages: 500,
        turnWindow: { minMessages: 200, minTurns: 2 },
      } },
    })).resolves.toMatchObject({ ok: true, value: { blob: 'small' } })

    const requests = dispatch.mock.calls.map(([, payload]) => (payload as { request: Record<string, unknown> }).request)
    expect(requests.map(request => request.maxMessages)).toEqual([50, 30])
    expect(dispatch.mock.calls.every(([, payload]) => !('maxMessages' in (payload as object)))).toBe(true)
    expect(requests[1]!.turnWindow).toEqual({ minMessages: 30, minTurns: 2 })

    // The remembered window is keyed on the session address, not on the whole request.
    await bridge.call({ endpoint: 'session/page', payload: { request: {
      address: { kind: 'session', sessionId: 'session-1' },
      beforeSeq: 9,
      maxMessages: 500,
    } } })
    expect(dispatch).toHaveBeenLastCalledWith('session/page', expect.objectContaining({
      request: expect.objectContaining({ maxMessages: 30 }),
    }), expect.any(AbortSignal))
  })

  // The official stream RPC sends positional arguments whose params wrap the request:
  // `{ args: [{ request }] }`. Rewriting the outer level left `maxMessages` beside the wrapper,
  // which the Host rejected as `gateway/internal`.
  it('rewrites the window inside positional stream arguments', async () => {
    const opened: number[] = []
    const open = vi.fn(async (_endpoint: string, payload: { args: [{ request: { maxMessages: number } }] }) => {
      const size = payload.args[0].request.maxMessages
      opened.push(size)
      return (async function* () {
        yield { type: 'snapshot', records: [], ...(size >= 50 ? { blob: OVER_BUDGET } : { blob: 'small' }) }
      })()
    })
    const publish = vi.fn(async (_event: string, _data: unknown) => undefined)
    const bridge = new HarnessRemoteBridge(gateway({ open }), publish)

    await expect(bridge.openStream({
      streamId: 'session-stream-positional',
      endpoint: 'session/follow',
      payload: { args: [{ request: {
        address: { kind: 'session', sessionId: 'session-1' },
        assistantStream: true,
        maxMessages: 500,
        turnWindow: { minMessages: 200, minTurns: 2 },
      } }] },
    })).resolves.toEqual({ opened: true, streamId: 'session-stream-positional' })

    expect(opened).toEqual([50, 30])
    expect(open.mock.calls.every(([, payload]) => Array.isArray((payload as { args: unknown }).args)
      && Object.keys((payload as { args: [{ request: object }] }).args[0]).length === 1)).toBe(true)
    await vi.waitFor(() => expect(publish).toHaveBeenCalledWith(
      'harness.remote.frame',
      expect.objectContaining({ value: { type: 'snapshot', records: [], blob: 'small' } }),
    ))
    await bridge.closeAll()
  })

  it('rewrites the window inside positional unary arguments', async () => {
    const dispatch = vi.fn(async (_endpoint: string, payload: { args: [{ request: { maxMessages: number } }] }) => ({
      ok: true as const,
      value: { records: [], ...(payload.args[0].request.maxMessages >= 50 ? { blob: OVER_BUDGET } : { blob: 'small' }) },
    }))
    const bridge = new HarnessRemoteBridge(gateway({ dispatch }), vi.fn(async () => undefined))

    await expect(bridge.call({
      endpoint: 'session/page',
      payload: { args: [{ request: {
        address: { kind: 'session', sessionId: 'session-1' },
        throughSeq: 42,
        maxMessages: 500,
        turnWindow: { minMessages: 200, minTurns: 2 },
      } }] },
    })).resolves.toMatchObject({ ok: true, value: { blob: 'small' } })

    const requests = dispatch.mock.calls.map(([, payload]) => (payload as { args: [{ request: { maxMessages: number } }] }).args[0].request)
    expect(requests.map(request => request.maxMessages)).toEqual([50, 30])
    expect(dispatch.mock.calls.every(([, payload]) => Object.keys((payload as { args: [{ request: object }] }).args[0]).length === 1)).toBe(true)
  })

  it('does not retry a history page that failed for a business reason', async () => {
    const failure = { ok: false as const, error: { code: 'session/not-found', message: 'gone', details: {} } }
    const dispatch = vi.fn(async () => failure)
    const bridge = new HarnessRemoteBridge(gateway({ dispatch }), vi.fn(async () => undefined))

    await expect(bridge.call({
      endpoint: 'session/page',
      payload: { args: { address: { kind: 'session', sessionId: 'missing' }, throughSeq: 1, maxMessages: 500 } },
    })).resolves.toEqual(failure)
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('reports RESPONSE_TOO_LARGE only after every smaller page fails too', async () => {
    const dispatch = vi.fn(async (_endpoint: string, _payload: { args: { maxMessages: number } }) => ({
      ok: true as const,
      value: { records: [], blob: OVER_BUDGET },
    }))
    const bridge = new HarnessRemoteBridge(gateway({ dispatch }), vi.fn(async () => undefined))

    const result = await bridge.call({
      endpoint: 'session/page',
      payload: { args: { address: { kind: 'session', sessionId: 'session-1' }, throughSeq: 1, maxMessages: 500 } },
    })

    expect(result).toMatchObject({ ok: false, error: { code: 'RESPONSE_TOO_LARGE' } })
    const attempts = dispatch.mock.calls.map(([, payload]) => (payload as { args: { maxMessages: number } }).args.maxMessages)
    expect(attempts).toEqual([50, 30, 20, 12, 6, 3, 1])
  })

  it('starts the next page from the window that last fit', async () => {
    const dispatch = vi.fn(async (_endpoint: string, payload: { args: { maxMessages: number } }) => pageOf(payload.args.maxMessages))
    const bridge = new HarnessRemoteBridge(gateway({ dispatch }), vi.fn(async () => undefined))
    const payload = {
      args: {
        address: { kind: 'session', sessionId: 'session-1' },
        throughSeq: 1,
        maxMessages: 500,
      },
    }

    await bridge.call({ endpoint: 'session/page', payload })
    // An older page of the same session starts where the tail page ended up, not at 500 again.
    await bridge.call({ endpoint: 'session/page', payload: { args: { ...payload.args, beforeSeq: 9 } } })

    const attempts = dispatch.mock.calls.map(([, value]) => (value as { args: { maxMessages: number } }).args.maxMessages)
    expect(attempts).toEqual([50, 30, 30])

    // The remembered window belongs to that session only.
    await bridge.call({ endpoint: 'session/page', payload: { args: { ...payload.args, address: { kind: 'session', sessionId: 'session-2' } } } })
    expect(dispatch.mock.calls.map(([, value]) => (value as { args: { maxMessages: number } }).args.maxMessages))
      .toEqual([50, 30, 30, 50, 30])
  })

  it('forgets the oldest remembered window beyond its cache bound', async () => {
    const dispatch = vi.fn(async (_endpoint: string, payload: { args: { maxMessages: number } }) => pageOf(payload.args.maxMessages))
    const bridge = new HarnessRemoteBridge(gateway({ dispatch }), vi.fn(async () => undefined))
    const page = (sessionId: string) => ({
      endpoint: 'session/page',
      payload: { args: { address: { kind: 'session', sessionId }, throughSeq: 1, maxMessages: 500 } },
    })

    // 64 windows are remembered; the 65th evicts the oldest.
    for (let index = 0; index < 65; index += 1) await bridge.call(page(`session-${index}`))
    expect(dispatch).toHaveBeenCalledTimes(65 * 2)

    await bridge.call(page('session-0'))
    expect(dispatch).toHaveBeenCalledTimes(65 * 2 + 2)
    expect(dispatch.mock.calls.slice(-2).map(([, payload]) => (payload as { args: { maxMessages: number } }).args.maxMessages))
      .toEqual([50, 30])

    // The newest entry still starts from the window that fit.
    await bridge.call(page('session-64'))
    expect(dispatch.mock.calls.slice(-1).map(([, payload]) => (payload as { args: { maxMessages: number } }).args.maxMessages))
      .toEqual([30])
  })

  it('measures a page by the records it carries, not by one oversized blob', async () => {
    const recordBytes = 90_000
    const dispatch = vi.fn(async (_endpoint: string, payload: { args: { maxMessages: number } }) => ({
      ok: true as const,
      // 500 records of 9 KB each is ~4.5 MiB: over the limit without any single oversized field.
      value: { records: Array.from({ length: payload.args.maxMessages }, (_, seq) => ({ seq, text: 'x'.repeat(recordBytes) })) },
    }))
    const bridge = new HarnessRemoteBridge(gateway({ dispatch }), vi.fn(async () => undefined))

    const result = await bridge.call({
      endpoint: 'session/page',
      payload: { args: { address: { kind: 'session', sessionId: 'session-big' }, throughSeq: 1, maxMessages: 500 } },
    })

    expect(result).toMatchObject({ ok: true })
    expect(dispatch.mock.calls.map(([, payload]) => (payload as { args: { maxMessages: number } }).args.maxMessages))
      .toEqual([50, 30])
  })

  it('steps the opening follow snapshot down and publishes the accepted page once', async () => {
    const opened: number[] = []
    const closed: number[] = []
    const open = vi.fn(async (_endpoint: string, payload: { args: { maxMessages: number } }) => {
      const size = payload.args.maxMessages
      opened.push(size)
      return (async function* () {
        try {
          yield size >= 50
            ? { type: 'snapshot', records: [], blob: OVER_BUDGET }
            : { type: 'snapshot', records: [{ seq: 0 }] }
          yield { type: 'event', seq: 1 }
        } finally {
          closed.push(size)
        }
      })()
    })
    const publish = vi.fn(async (_event: string, _data: unknown) => undefined)
    const bridge = new HarnessRemoteBridge(gateway({ open }), publish)

    await expect(bridge.openStream({
      streamId: 'session-stream-1',
      endpoint: 'session/follow',
      payload: { args: {
        address: { kind: 'session', sessionId: 'session-1' },
        assistantStream: true,
        maxMessages: 500,
        turnWindow: { minMessages: 50, minTurns: 2 },
      } },
    })).resolves.toEqual({ opened: true, streamId: 'session-stream-1' })

    expect(opened).toEqual([50, 30])
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(3))
    const frames = publish.mock.calls
      .filter(call => call[0] === 'harness.remote.frame')
      .map(call => (call[1] as { value: unknown }).value)
    // The accepted snapshot is published exactly once, followed by the live tail.
    expect(frames).toEqual([
      { type: 'snapshot', records: [{ seq: 0 }] },
      { type: 'event', seq: 1 },
    ])
    expect(publish.mock.calls.at(-1)).toEqual([
      'harness.remote.stream.closed',
      { streamId: 'session-stream-1', reason: 'completed' },
    ])
    // Abandoned attempts were closed; the accepted one ended on its own.
    await vi.waitFor(() => expect(closed).toEqual([50, 30]))
    await bridge.closeAll()
  })

  it('refuses a history stream when even one message cannot cross', async () => {
    const open = vi.fn(async (_endpoint: string, _payload: { args: { maxMessages: number } }) => (async function* () {
      yield { type: 'snapshot', records: [], blob: OVER_BUDGET }
    })())
    const publish = vi.fn(async (_event: string, _data: unknown) => undefined)
    const bridge = new HarnessRemoteBridge(gateway({ open }), publish)

    await expect(bridge.openStream({
      streamId: 'session-stream-2',
      endpoint: 'session/follow',
      payload: { args: { address: { kind: 'session', sessionId: 'session-1' }, maxMessages: 500 } },
    })).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' })

    expect(open.mock.calls.map(([, payload]) => (payload as { args: { maxMessages: number } }).args.maxMessages))
      .toEqual([50, 30, 20, 12, 6, 3, 1])
    expect(publish).not.toHaveBeenCalled()
    // A failed open leaves no stream behind.
    expect(bridge.closeStream({ streamId: 'session-stream-2' })).toEqual({ closed: false, streamId: 'session-stream-2' })
    await bridge.closeAll()
  })

  it('opens a history stream that ends before its first frame', async () => {
    const publish = vi.fn(async (_event: string, _data: unknown) => undefined)
    const open = vi.fn(async () => (async function* () {})())
    const bridge = new HarnessRemoteBridge(gateway({ open }), publish)

    await expect(bridge.openStream({
      streamId: 'session-stream-3',
      endpoint: 'session/follow',
      payload: { args: { address: { kind: 'session', sessionId: 'session-1' }, maxMessages: 500 } },
    })).resolves.toEqual({ opened: true, streamId: 'session-stream-3' })

    await vi.waitFor(() => expect(publish).toHaveBeenCalledWith(
      'harness.remote.stream.closed',
      { streamId: 'session-stream-3', reason: 'completed' },
    ))
    expect(publish.mock.calls.some(call => call[0] === 'harness.remote.frame')).toBe(false)
    await bridge.closeAll()
  })

  it('fails one oversized live frame instead of the peer connection', async () => {
    const publish = vi.fn(async (_event: string, _data: unknown) => undefined)
    const open = vi.fn(async () => (async function* () {
      yield { blob: OVER_BUDGET }
      yield { type: 'after' }
    })())
    const bridge = new HarnessRemoteBridge(gateway({ open }), publish)

    // Not a history endpoint: the frame is checked in the pump, not by the opening probe.
    await bridge.openStream({ streamId: 'live-stream-1', endpoint: '$events', payload: { args: {} } })

    await vi.waitFor(() => expect(publish).toHaveBeenCalledWith(
      'harness.remote.stream.closed',
      expect.objectContaining({ streamId: 'live-stream-1', reason: 'failed' }),
    ))
    const closed = publish.mock.calls.find(call => call[0] === 'harness.remote.stream.closed')?.[1] as {
      failure?: { code: string }
    }
    expect(closed.failure?.code).toBe('RESPONSE_TOO_LARGE')
    expect(publish.mock.calls.some(call => call[0] === 'harness.remote.frame')).toBe(false)
    await bridge.closeAll()
  })

  it('releases the device reservation when a CodeX terminal cannot start', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-remote-codex-terminal-'))
    const owners = new Map<string, string>()
    const failing = new HarnessRemoteBridge(gateway(), vi.fn(async () => undefined), undefined, undefined,
      new TerminalPolicy(() => true, 'device-a', owners),
      new CodexWorkspaceBridge(async () => root, () => true, undefined, async () => { throw new Error('no terminal provider') }))
    await expect(failing.call({ endpoint: 'terminal/create', payload: { args: { agentId: 'codex:one', request: { id: 't1', cols: 80, rows: 24 } } } }))
      .rejects.toMatchObject({ code: 'CODEX_TERMINAL_UNAVAILABLE' })

    // Another device can still claim that id because the failed attempt released it.
    const other = new HarnessRemoteBridge(gateway(), vi.fn(async () => undefined), undefined, undefined,
      new TerminalPolicy(() => true, 'device-b', owners),
      new CodexWorkspaceBridge(async () => root, () => true, undefined, stubTerminalSpawner()))
    await expect(other.call({ endpoint: 'terminal/create', payload: { args: { agentId: 'codex:one', request: { id: 't1', cols: 80, rows: 24 } } } }))
      .resolves.toMatchObject({ ok: true, value: { id: 't1' } })
    await failing.closeAll(); await other.closeAll(); await rm(root, { recursive: true, force: true })
  })
})

/** A blob larger than one secure message, so any page carrying it cannot be encrypted. */
const OVER_BUDGET = 'x'.repeat(MAX_SECURE_MESSAGE_BYTES)

/** A fake history page: too large at 50+ messages, small at 30 and below. */
function pageOf(maxMessages: number): { ok: true; value: Record<string, unknown> } {
  return {
    ok: true,
    value: { records: [], hasMore: true, ...(maxMessages >= 50 ? { blob: OVER_BUDGET } : { blob: 'small' }) },
  }
}

function stubTerminalSpawner(): RemoteTerminalSpawner {
  return async (): Promise<RemoteTerminalProcess> => ({
    output: (async function* () { return })(),
    write: () => undefined,
    resize: () => undefined,
    terminate: () => undefined,
    completed: Promise.resolve({ exitCode: 0 }),
  })
}

function gateway(overrides: Partial<LocalTypertGateway> = {}): LocalTypertGateway {
  return {
    invoke: async () => undefined,
    dispatch: async () => ({ ok: true }),
    open: async () => (async function* () { return })(),
    failure: () => ({ code: 'internal', message: 'Request failed.', details: {} }),
    supportsCarrier: true,
    ...overrides,
  }
}

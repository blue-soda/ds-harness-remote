import { describe, expect, it, vi } from 'vitest'
import { isCodexSessionLoss } from '../src/client-runtime.js'
import { CodexVirtualHarness } from '../src/codex/virtual-harness.js'

describe('Codex session loss classification', () => {
  it('treats a closed Codex connection as a lost session', () => {
    // What the peer bridge throws once the Host replaced its Codex domain.
    expect(isCodexSessionLoss(Object.assign(new Error('The Codex connection is closed.'), { code: 'CODEX_CONNECTION_CLOSED' }))).toBe(true)
    expect(isCodexSessionLoss(Object.assign(new Error('The Codex Remote domain is closed.'), { code: 'CODEX_CLOSED' }))).toBe(true)
  })

  it('treats a Codex that answers "unavailable" as a lost session too', () => {
    // What a switched-off Codex answers now that the Host keeps a client's bridge across the change: the domain
    // is still there, it just has no App Server behind it. Reported as a session loss so the top bar shows the
    // same "reconnecting" it shows when the whole device stops accepting control.
    expect(isCodexSessionLoss(Object.assign(
      new Error('Codex Remote is disabled or unavailable on this Host.'),
      { code: 'CODEX_UNAVAILABLE' },
    ))).toBe(true)
    // The wrapped form the carrier hands back.
    expect(isCodexSessionLoss({ code: 'CODEX_UNAVAILABLE' })).toBe(true)
  })

  it('leaves ordinary failures alone', () => {
    expect(isCodexSessionLoss(Object.assign(new Error('no such workspace'), { code: 'WORKSPACE_NOT_FOUND' }))).toBe(false)
    expect(isCodexSessionLoss(new Error('boom'))).toBe(false)
  })

  it('reports a stream the peer ended as a lost session, and an ordinary end as nothing', async () => {
    // The proactive trigger: turning Codex off on the Host ends the followed streams, and that has to reach the
    // runtime immediately - waiting for the user's next action is what made the switch look like a plain error.
    const harness = new CodexVirtualHarness(
      { request: vi.fn(), subscribe: vi.fn(), respond: vi.fn() } as never,
      { deviceId: 'host-1', name: 'Host' },
    )
    const lost = vi.fn()
    harness.watchCodexSessionLost(lost)
    const follow = { sessionId: 'thread-1', queue: { close: () => undefined } }
    const seams = harness as unknown as {
      noteRemoteStreamClosed(follow: unknown, reason: string): void
    }

    seams.noteRemoteStreamClosed(follow, 'failed')
    seams.noteRemoteStreamClosed(follow, 'peer-disconnected')
    expect(lost).toHaveBeenCalledTimes(2)
    expect(lost).toHaveBeenCalledWith('stream-closed')

    seams.noteRemoteStreamClosed(follow, 'completed')
    seams.noteRemoteStreamClosed(follow, 'cancelled')
    expect(lost).toHaveBeenCalledTimes(2)

    await harness.close()
  })

  it('turns an unavailable-Codex announcement into a loss, and an available one into nothing', async () => {
    // The gap the polling was meant to paper over: a session on its history page follows no thread, so nothing
    // told this client that Codex was switched off - and the user only saw a failed history load. The Host now
    // states availability per connection, and the client decides what it means: unavailable costs this session,
    // while Codex coming back is not a loss - a session still waiting to be restored is put back by the ladder.
    let capability: ((available: boolean) => void) | undefined
    const harness = new CodexVirtualHarness(
      {
        request: vi.fn(),
        subscribe: vi.fn(),
        respond: vi.fn(),
        watchCapability: (handler: (available: boolean) => void) => {
          capability = handler
          return () => { capability = undefined }
        },
      } as never,
      { deviceId: 'host-1', name: 'Host' },
    )
    const lost = vi.fn()
    harness.watchCodexSessionLost(lost)
    expect(capability).toBeDefined()

    capability?.(true)
    expect(lost).not.toHaveBeenCalled()

    capability?.(false)
    expect(lost).toHaveBeenCalledWith('domain-notice')

    // A closed workspace stops listening: the announcement belongs to the session, not to the process.
    await harness.close()
    expect(capability).toBeUndefined()
  })
})

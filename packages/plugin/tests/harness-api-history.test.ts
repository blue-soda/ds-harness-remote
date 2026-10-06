import { describe, expect, it, vi } from 'vitest'
import { CODEX_HISTORY_MAX_MESSAGES } from '../src/codex/method-policy.js'
import { callSessionHistory } from '../src/harness-api-history.js'

/**
 * The history adapter retries with smaller pages only when a response is too large for
 * the channel, so the page it sends first must already be one the Host's call policy
 * admits. A session history load failed outright with "maxMessages: too_big" before
 * the request was clamped to the policy's cap.
 */
describe('session history page sizing', () => {
  it('clamps the first attempt to the call policy limit', async () => {
    const seen: Array<number | undefined> = []
    const callWithTimeout = vi.fn(async (payload: unknown) => {
      seen.push((payload as { maxMessages?: number }).maxMessages)
      return { type: 'rpc.response', rpcId: 'r1', result: { ok: true, value: {} } } as never
    })
    await callSessionHistory(callWithTimeout, { sessionId: 'codex:thr_1', maxMessages: 5000 }, 'r1')
    expect(seen[0]).toBe(CODEX_HISTORY_MAX_MESSAGES)
  })

  it('keeps a smaller request as asked', async () => {
    const seen: Array<number | undefined> = []
    const callWithTimeout = vi.fn(async (payload: unknown) => {
      seen.push((payload as { maxMessages?: number }).maxMessages)
      return { type: 'rpc.response', rpcId: 'r1', result: { ok: true, value: {} } } as never
    })
    await callSessionHistory(callWithTimeout, { sessionId: 'codex:thr_1', maxMessages: 6 }, 'r1')
    expect(seen[0]).toBe(6)
  })
})

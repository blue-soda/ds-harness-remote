import { describe, expect, it } from 'vitest'
import { CODEX_APP_ALLOWLIST, CODEX_HISTORY_MAX_MESSAGES, parseCodexCall } from '../src/codex/method-policy.js'

/**
 * The policy is the Host-side allowlist for `codex.app.call`, so it must accept
 * every shape the App Server itself declares and refuse everything else. Each case
 * below was a real upstream field the plugin refused, which surfaced to the client as
 * an unexplained "The CodeX call parameters are invalid.".
 */
describe('CodeX App Server call policy', () => {
  it('accepts the ThreadListParams fields upstream declares', () => {
    const parsed = parseCodexCall('thread/list', {
      limit: 20,
      sortKey: 'updated_at',
      sortDirection: 'desc',
      archived: false,
      originators: ['vscode'],
      sectionId: null,
    })
    expect(parsed.params).toMatchObject({ originators: ['vscode'], sectionId: null })
  })

  it('accepts clearing a thread name, which upstream spells as an empty string', () => {
    expect(parseCodexCall('thread/name/set', { threadId: 'thr_1', name: '' }).params)
      .toEqual({ threadId: 'thr_1', name: '' })
  })

  it('accepts the TurnSteerParams client message id', () => {
    expect(parseCodexCall('turn/steer', {
      threadId: 'thr_1',
      expectedTurnId: 'turn_1',
      input: [{ type: 'text', text: 'steer' }],
      clientUserMessageId: null,
    }).params).toMatchObject({ clientUserMessageId: null })
  })

  it('still refuses unknown fields and names the offending one', () => {
    expect(() => parseCodexCall('thread/read', { threadId: 'thr_1', surprise: true }))
      .toThrowError(expect.objectContaining({
        code: 'INVALID_MESSAGE',
        message: expect.stringContaining('thread/read'),
      }))
    expect(() => parseCodexCall('thread/read', { threadId: 'thr_1', surprise: true }))
      .toThrowError(/surprise/u)
  })

  it('admits a history page up to the cap and refuses a larger one', () => {
    // The client clamps to this same constant; an unclamped request reached the Host and
    // failed the whole history load with "maxMessages: too_big".
    expect(parseCodexCall('dsh/sessionHistory', { threadId: 'thr_1', maxMessages: CODEX_HISTORY_MAX_MESSAGES }).params)
      .toMatchObject({ maxMessages: CODEX_HISTORY_MAX_MESSAGES })
    expect(() => parseCodexCall('dsh/sessionHistory', { threadId: 'thr_1', maxMessages: CODEX_HISTORY_MAX_MESSAGES + 1 }))
      .toThrowError(/maxMessages/u)
  })

  it('refuses methods outside the allowlist', () => {
    expect(() => parseCodexCall('thread/delete', {})).toThrowError(expect.objectContaining({ code: 'METHOD_NOT_ALLOWED' }))
    expect(CODEX_APP_ALLOWLIST).toContain('thread/read')
  })
})

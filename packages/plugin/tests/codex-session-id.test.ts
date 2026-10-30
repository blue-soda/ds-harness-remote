import { describe, expect, it } from 'vitest'
import { parseCodexSessionId, requireCodexSessionId } from '../src/codex/session-id.js'

describe('CodeX session ids', () => {
  it('parses codex thread ids without treating them as Harness ids', () => {
    expect(parseCodexSessionId('codex:thread_1')).toEqual({ sessionId: 'codex:thread_1', threadId: 'thread_1' })
    expect(parseCodexSessionId('harness:thread_1')).toBeUndefined()
  })
  it('rejects malformed ids with a stable code', () => {
    expect(() => requireCodexSessionId('codex:')).toThrowError(expect.objectContaining({ code: 'CODEX_SESSION_INVALID' }))
  })
  // Regression: the thread list hands out composite row keys ("<id>~<createdAt>~<n>") so two records of the same
  // Codex thread stay distinguishable; the public session id is "codex:" plus that key. The parser used to reject
  // "~", so a phone asking for that session's history was told the identifier was invalid.
  it('accepts the composite row key from the thread list', () => {
    const parsed = parseCodexSessionId('codex:01a188f0-7f9d-7262-aaf2-67273dbf9a24~1793298885~0')
    expect(parsed?.threadId).toBe('01a188f0-7f9d-7262-aaf2-67273dbf9a24~1793298885~0')
  })
})

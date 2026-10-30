import { describe, expect, it } from 'vitest'
import { parseCodexSessionId, requireCodexSessionId, resolveCodexThreadKey } from '../src/codex/session-id.js'

describe('CodeX session ids', () => {
  it('parses codex thread ids without treating them as Harness ids', () => {
    expect(parseCodexSessionId('codex:thread_1')).toEqual({ sessionId: 'codex:thread_1', threadId: 'thread_1' })
    expect(parseCodexSessionId('codex:01a188f0-7f9d-7262-aaf2-67273dbf9a24')).toEqual({
      sessionId: 'codex:01a188f0-7f9d-7262-aaf2-67273dbf9a24',
      threadId: '01a188f0-7f9d-7262-aaf2-67273dbf9a24',
    })
    expect(parseCodexSessionId('harness:thread_1')).toBeUndefined()
    expect(parseCodexSessionId('codex:')).toBeUndefined()
    expect(parseCodexSessionId('codex:../etc/passwd')).toBeUndefined()
    expect(parseCodexSessionId(undefined)).toBeUndefined()
  })

  it('rejects malformed ids with a stable code', () => {
    expect(() => requireCodexSessionId('codex:')).toThrowError(expect.objectContaining({ code: 'CODEX_SESSION_INVALID' }))
  })

  // Regression: a release published `<threadId>~<createdAt>~<n>` as the Session id to keep the rows Codex
  // lists for one thread apart, and that key travelled back into request validation, which rejected it.
  // The key still resolves to its thread so a Client built against that release keeps working - but the
  // public identity is the bare thread id, which is what every App Server method expects.
  it('resolves a legacy composite row key to its thread id', () => {
    expect(parseCodexSessionId('codex:01a188f0-7f9d-7262-aaf2-67273dbf9a24~1793298885~0')).toEqual({
      sessionId: 'codex:01a188f0-7f9d-7262-aaf2-67273dbf9a24~1793298885~0',
      threadId: '01a188f0-7f9d-7262-aaf2-67273dbf9a24',
    })
    // A missing createdAt was serialised as an empty segment.
    expect(parseCodexSessionId('codex:thread_1~~3')?.threadId).toBe('thread_1')
    expect(parseCodexSessionId('codex:thread_1~1793298885~0~extra')).toBeUndefined()
  })

  it('resolves a thread key and returns anything unrecognised unchanged', () => {
    expect(resolveCodexThreadKey('thread_1')).toBe('thread_1')
    expect(resolveCodexThreadKey('thread_1~1793298885~0')).toBe('thread_1')
    expect(resolveCodexThreadKey('not a thread id')).toBe('not a thread id')
  })
})

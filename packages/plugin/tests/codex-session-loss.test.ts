import { describe, expect, it } from 'vitest'
import { isCodexSessionLoss } from '../src/client-runtime.js'

describe('Codex session loss classification', () => {
  it('treats a closed Codex connection as a lost session', () => {
    // What the peer bridge throws once the Host replaced its Codex domain.
    expect(isCodexSessionLoss(Object.assign(new Error('The Codex connection is closed.'), { code: 'CODEX_CONNECTION_CLOSED' }))).toBe(true)
    expect(isCodexSessionLoss(Object.assign(new Error('The Codex Remote domain is closed.'), { code: 'CODEX_CLOSED' }))).toBe(true)
  })

  it('leaves ordinary failures alone', () => {
    expect(isCodexSessionLoss(Object.assign(new Error('no such workspace'), { code: 'WORKSPACE_NOT_FOUND' }))).toBe(false)
    expect(isCodexSessionLoss(new Error('boom'))).toBe(false)
  })
})

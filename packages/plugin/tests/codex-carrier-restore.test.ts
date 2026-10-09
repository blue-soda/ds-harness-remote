import { describe, expect, it } from 'vitest'
import { shouldRestoreCodexCarrier } from '../src/client-runtime.js'

describe('Codex carrier restore decision', () => {
  it('rebuilds for a Codex workspace on the Host that just reconnected', () => {
    expect(shouldRestoreCodexCarrier({ targetDeviceId: 'a', backend: 'codex' }, 'a')).toBe(true)
  })

  it('leaves a Harness workspace alone', () => {
    // Opening Codex on top of a Harness selection would replace a working view with a different one.
    expect(shouldRestoreCodexCarrier({ targetDeviceId: 'a', backend: 'harness' }, 'a')).toBe(false)
    expect(shouldRestoreCodexCarrier({ targetDeviceId: 'a' }, 'a')).toBe(false)
  })

  it('ignores a selection that belongs to another Host', () => {
    expect(shouldRestoreCodexCarrier({ targetDeviceId: 'b', backend: 'codex' }, 'a')).toBe(false)
    expect(shouldRestoreCodexCarrier(undefined, 'a')).toBe(false)
  })
})

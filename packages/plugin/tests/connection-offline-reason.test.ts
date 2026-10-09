import { describe, expect, it } from 'vitest'
import { offlineConnectionError } from '../src/client-runtime.js'

describe('offline connection reason', () => {
  it('names the control switch when the Server says the device refuses control', () => {
    // Presence reads offline for such a device, so without this the user only sees transport failures.
    const error = offlineConnectionError(false)
    expect(error.code).toBe('CONTROL_DISABLED')
    expect(error.message).toContain('not accepting control')
  })

  it('keeps the ordinary offline message when control is on or unknown', () => {
    expect(offlineConnectionError(true).code).toBe('HOST_OFFLINE')
    expect(offlineConnectionError(undefined).code).toBe('HOST_OFFLINE')
  })
})

import { describe, expect, it } from 'vitest'
import { authorizationStillNeeded } from '../src/panel-authorization.js'

describe('Remote panel authorization decision', () => {
  it('keeps asking for authorization when a fresh install answers with an empty Host list', () => {
    // The reported bug: a new device opened straight into an empty Host list - which reads as "signed in to an
    // account that has no computers" - and only reached the sign-in panel after signing out by hand. Discovery
    // answers with an empty list while nothing is stored, so a successful read must not be read as proof that
    // this installation is authorized.
    expect(authorizationStillNeeded(false, 0)).toBe(true)
  })

  it('stops asking once a credential is stored, or once a Host is actually listed', () => {
    // An account whose only device is this one lists no *other* Host, and is still authorized.
    expect(authorizationStillNeeded(true, 0)).toBe(false)
    // The local pre-check can race a sign-in that has just finished; a listed Host settles the question.
    expect(authorizationStillNeeded(false, 1)).toBe(false)
    expect(authorizationStillNeeded(true, 2)).toBe(false)
  })
})

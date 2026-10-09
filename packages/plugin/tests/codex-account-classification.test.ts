import { describe, expect, it } from 'vitest'
import { classifyAccountProbeFailure } from '../src/codex/domain.js'

describe('Codex account probe classification', () => {
  it('names a region block instead of reporting an opaque upstream error', () => {
    // The measured upstream answer when the network cannot reach the Codex account.
    const error = new Error('403 Forbidden: Country, region, or territory not supported (unsupported_country_region_territory)')
    expect(classifyAccountProbeFailure(error)).toMatchObject({ code: 'CODEX_ACCOUNT_UNREACHABLE' })
  })

  it('treats a stalled probe as unreachable too', () => {
    expect(classifyAccountProbeFailure(new Error('request timed out'))).toMatchObject({ code: 'CODEX_ACCOUNT_UNREACHABLE' })
  })

  it('passes anything else through unchanged', () => {
    const error = new Error('something else')
    expect(classifyAccountProbeFailure(error)).toBe(error)
  })
})

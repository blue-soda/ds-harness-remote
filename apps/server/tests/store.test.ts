import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dsh-store-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('state file handling', () => {
  it('starts empty when no state file exists', () => {
    const store = new Store(join(dir, 'state.json'))
    expect(store.listAccounts()).toEqual([])
  })

  it('preserves a single-account file as a backup and starts empty instead of failing', () => {
    const file = join(dir, 'state.json')
    const legacy = {
      version: 1,
      account: 'owner@example.com',
      salt: 'legacy-salt',
      verifier: 'legacy-verifier',
      devices: { 'device-1': { descriptor: { deviceId: 'device-1' }, revoked: false, lastSeenAt: 0 } },
      tokens: {},
    }
    writeFileSync(file, JSON.stringify(legacy))

    // Startup must not throw: an upgrade has to come up even with an old file.
    const store = new Store(file)
    expect(store.listAccounts()).toEqual([])

    const backup = `${file}.v1.bak`
    expect(existsSync(backup)).toBe(true)
    expect(JSON.parse(readFileSync(backup, 'utf8'))).toMatchObject({ account: 'owner@example.com' })
    // The live file is replaced with the current format on first write.
    store.upsertAccount('owner@example.com', 'a-long-enough-password')
    expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(2)
  })

  it('never overwrites a state file it cannot interpret', () => {
    const file = join(dir, 'state.json')
    writeFileSync(file, JSON.stringify({ version: 99, something: 'else' }))
    expect(() => new Store(file)).toThrow(/not a recognised state file/)
    expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(99)
  })
})

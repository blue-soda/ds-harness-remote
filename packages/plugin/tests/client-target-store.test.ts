import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ClientTargetStore } from '../src/client-target-store.js'

/**
 * The record exists for one case: Android reclaiming a backgrounded process, which leaves no
 * socket and no close event, so nothing would otherwise start the reconnect loop. What matters is
 * that a boot can trust the file - a malformed or half-written record must never be restored.
 */
const directories: string[] = []

const makeDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-client-target-'))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('ClientTargetStore', () => {
  it('round-trips a remote target and a local record', async () => {
    const store = new ClientTargetStore(await makeDirectory())

    await expect(store.load()).resolves.toBeUndefined()
    await store.save({ mode: 'remote', hostDeviceId: 'host-1', serverUrl: 'https://remote.example.com' })
    await expect(store.load()).resolves.toMatchObject({
      schemaVersion: 1,
      mode: 'remote',
      hostDeviceId: 'host-1',
      serverUrl: 'https://remote.example.com',
    })
    const saved = await store.load()
    expect(saved?.savedAt).toBeGreaterThan(0)

    await store.save({ mode: 'local' })
    await expect(store.load()).resolves.toMatchObject({ mode: 'local' })
    // A local record must not keep the Host around: it would be restored on the next boot.
    expect((await store.load())?.hostDeviceId).toBeUndefined()
  })

  it('reads a malformed or half-written record as no record at all', async () => {
    const directory = await makeDirectory()
    const store = new ClientTargetStore(directory)
    const cases = [
      'not json',
      '[]',
      '{"schemaVersion":2,"mode":"remote","hostDeviceId":"host-1"}',
      '{"schemaVersion":1,"mode":"elsewhere"}',
      // A remote record without a Host cannot be restored, so it must not look restorable.
      '{"schemaVersion":1,"mode":"remote"}',
      '{"schemaVersion":1,"mode":"remote","hostDeviceId":""}',
    ]
    for (const contents of cases) {
      await writeFile(store.file, contents)
      await expect(store.load()).resolves.toBeUndefined()
    }
  })

  it('writes atomically, leaving no temporary file behind', async () => {
    const directory = await makeDirectory()
    const store = new ClientTargetStore(directory)
    await store.save({ mode: 'remote', hostDeviceId: 'host-2', serverUrl: 'https://remote.example.com' })
    const { readdir } = await import('node:fs/promises')
    expect((await readdir(directory)).sort()).toEqual(['client-target.json'])
    await expect(readFile(store.file, 'utf8')).resolves.toContain('"hostDeviceId": "host-2"')
  })
})

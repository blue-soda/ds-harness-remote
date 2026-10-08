import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureDeviceDirectory, serverStorageDirectory } from '../src/identity-store.js'

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

describe('one identity per device', () => {
  it('creates the device directory when the installation has none yet', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-identity-'))
    directories.push(root)
    const device = await ensureDeviceDirectory(root, 'https://example.test')
    expect(existsSync(device)).toBe(true)
    expect(device).toBe(serverStorageDirectory(root, 'https://example.test', 'device'))
  })

  it('adopts the host identity and keeps the old directory as a backup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-identity-'))
    directories.push(root)
    const legacy = serverStorageDirectory(root, 'https://example.test', 'host')
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, 'device.json'), '{"deviceId":"01a10eeb-ad34-71a4-8789-1bf787afc346"}')
    const device = await ensureDeviceDirectory(root, 'https://example.test')
    expect(await readFile(join(device, 'device.json'), 'utf8')).toContain('01a10eeb-ad34')
    // Nothing is deleted: the per-role directory stays as a backup the user can fall back to.
    expect(existsSync(join(legacy, 'device.json'))).toBe(true)
  })

  it('leaves an existing device directory alone', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-identity-'))
    directories.push(root)
    const device = serverStorageDirectory(root, 'https://example.test', 'device')
    await mkdir(device, { recursive: true })
    await writeFile(join(device, 'device.json'), '{"deviceId":"keep-me"}')
    const legacy = serverStorageDirectory(root, 'https://example.test', 'host')
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, 'device.json'), '{"deviceId":"do-not-copy"}')
    await ensureDeviceDirectory(root, 'https://example.test')
    expect(await readFile(join(device, 'device.json'), 'utf8')).toContain('keep-me')
  })
})

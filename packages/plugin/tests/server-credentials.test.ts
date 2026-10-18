import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ServerCredentialStore } from '../src/server-credentials.js'

const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'dsh-refresh-lock-'))
  directories.push(path)
  return path
}

describe('credential refresh process lock', () => {
  it('allows only one process to consume the same expired credential', async () => {
    const path = await directory()
    const entry = join(path, 'store.mjs')
    await build({
      entryPoints: [fileURLToPath(new URL('../src/server-credentials.ts', import.meta.url))],
      outfile: entry, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
    })
    const store = new ServerCredentialStore(path)
    await store.save({
      serverUrl: 'https://example.com', deviceId: 'test-host', authorizationMethod: 'owned_device',
      accessToken: 'expired-test-access-value', accessTokenExpiresAt: 1,
      refreshToken: 'initial-test-refresh-value', refreshTokenExpiresAt: Date.now() + 60_000,
    })
    const worker = join(path, 'worker.mjs')
    await writeFile(worker, `
      import { ServerCredentialStore } from ${JSON.stringify(pathToFileURL(entry).href)};
      const store = new ServerCredentialStore(process.argv[2]);
      await store.withRefreshLock(async () => {
        const stored = await store.load('https://example.com', 'test-host');
        if (stored.accessTokenExpiresAt > Date.now()) { process.stdout.write('cached'); return; }
        await new Promise(resolve => setTimeout(resolve, 150));
        await store.save({ ...stored, accessToken: 'rotated-test-access-value',
          refreshToken: 'rotated-test-refresh-value', accessTokenExpiresAt: Date.now() + 60_000 });
        process.stdout.write('refreshed');
      });
    `)
    const run = promisify(execFile)
    const results = await Promise.all([run(process.execPath, [worker, path]), run(process.execPath, [worker, path])])
    expect(results.map(result => result.stdout).sort()).toEqual(['cached', 'refreshed'])
    await expect(stat(join(path, 'server-credentials.json.refresh-lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not steal a lock after the wait deadline', async () => {
    const path = await directory()
    const lock = join(path, 'server-credentials.json.refresh-lock')
    await mkdir(lock)
    vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(16_000)
    const operation = vi.fn()
    await expect(new ServerCredentialStore(path).withRefreshLock(operation)).rejects.toMatchObject({ code: 'SERVER_CREDENTIALS_BUSY' })
    expect(operation).not.toHaveBeenCalled()
    expect((await stat(lock)).isDirectory()).toBe(true)
  })

  it('releases its lock when the operation rejects', async () => {
    const path = await directory()
    const store = new ServerCredentialStore(path)
    await expect(store.withRefreshLock(async () => { throw new Error('failed') })).rejects.toThrow('failed')
    await expect(new ServerCredentialStore(path).withRefreshLock(async () => 'recovered')).resolves.toBe('recovered')
  })

  /**
   * A phone kills the app mid-refresh routinely, which left the lock behind forever: every later sign-in then
   * answered `SERVER_CREDENTIALS_BUSY` and told the user to delete a file they cannot reach. The owner now
   * decides - a lock whose process is gone is taken over, a live one (even suspended) is still respected.
   */
  it('reclaims a lock left by a process that no longer exists', async () => {
    const path = await directory()
    const lock = join(path, 'server-credentials.json.refresh-lock')
    await mkdir(lock)
    // A pid that cannot be running: even if it were, it is not ours to signal and would count as alive.
    await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: 2_147_483_646, at: Date.now() }))
    await expect(new ServerCredentialStore(path).withRefreshLock(async () => 'reclaimed')).resolves.toBe('reclaimed')
    await expect(stat(lock)).rejects.toMatchObject({ code: 'ENOENT' })
    // The reclaimed lock is gone, so the next transaction simply takes a fresh one.
    await expect(new ServerCredentialStore(path).withRefreshLock(async () => 'again')).resolves.toBe('again')
  })

  it('keeps waiting for a lock a live process holds', async () => {
    const path = await directory()
    const store = new ServerCredentialStore(path)
    let release = (): void => {}
    const held = store.withRefreshLock(() => new Promise<string>(resolve => { release = (): void => { resolve('first') } }))
    await vi.waitFor(async () => { await stat(join(path, 'server-credentials.json.refresh-lock', 'owner.json')) })
    const waiting = new ServerCredentialStore(path).withRefreshLock(async () => 'second')
    // Give the second contender time to hit the lock at least once before the first one lets go.
    await new Promise(resolve => setTimeout(resolve, 200))
    release()
    await expect(waiting).resolves.toBe('second')
    await expect(held).resolves.toBe('first')
  })

  it('treats an owner-less lock older than the abandoned window as stale', async () => {
    const path = await directory()
    const lock = join(path, 'server-credentials.json.refresh-lock')
    await mkdir(lock)
    const stale = new Date(Date.now() - 11 * 60_000)
    await utimes(lock, stale, stale)
    await expect(new ServerCredentialStore(path).withRefreshLock(async () => 'reclaimed')).resolves.toBe('reclaimed')
    await expect(stat(lock)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

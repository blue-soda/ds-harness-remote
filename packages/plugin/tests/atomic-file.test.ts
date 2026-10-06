import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { replaceFile, sweepStaleTemporaries } from '../src/atomic-file.js'

/**
 * The retry exists for a failure this process cannot reproduce: Node always opens files with
 * FILE_SHARE_DELETE, so only an outside holder (antivirus or indexer scan, Explorer preview,
 * backup agent, or a second writer) makes MoveFileEx fail while replacing an existing file.
 * Stubbing `rename` injects exactly that failure.
 */
const { renameMock } = vi.hoisted(() => ({ renameMock: vi.fn() }))

vi.mock('node:fs/promises', async importOriginal => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  rename: renameMock,
}))

const failingRename = (code: string) =>
  Object.assign(new Error(`${code}: operation not permitted, rename 'a.tmp' -> 'a.json'`), { code })

const directories: string[] = []

beforeEach(() => { renameMock.mockReset() })
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

describe('atomic state file replacement', () => {
  it('retries the transient Windows failures and then succeeds', async () => {
    renameMock
      .mockRejectedValueOnce(failingRename('EPERM'))
      .mockRejectedValueOnce(failingRename('EACCES'))
      .mockRejectedValueOnce(failingRename('EBUSY'))
      .mockResolvedValueOnce(undefined)

    await replaceFile('state.json.1.tmp', 'state.json', { delaysMs: [0, 0, 0] })

    expect(renameMock).toHaveBeenCalledTimes(4)
    expect(renameMock).toHaveBeenLastCalledWith('state.json.1.tmp', 'state.json')
  })

  it('rethrows an error that is not an occupied destination', async () => {
    renameMock.mockRejectedValueOnce(failingRename('ENOENT'))

    await expect(replaceFile('state.json.1.tmp', 'state.json', { delaysMs: [0, 0, 0] })).rejects.toMatchObject({ code: 'ENOENT' })
    expect(renameMock).toHaveBeenCalledTimes(1)
  })

  it('gives up once the retry budget is spent', async () => {
    renameMock.mockRejectedValue(failingRename('EPERM'))

    await expect(replaceFile('state.json.1.tmp', 'state.json', { delaysMs: [0, 0] })).rejects.toMatchObject({ code: 'EPERM' })
    expect(renameMock).toHaveBeenCalledTimes(3)
  })
})

describe('stale temporary sweep', () => {
  it('removes only abandoned temporaries this module could have written', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'atomic-file-'))
    directories.push(directory)
    const stale = join(directory, 'trusted-peers.json.23412.01a111a1-dfe1-7c51-a34e-373932cebcb2.tmp')
    const fresh = join(directory, 'trusted-peers.json.23413.01a111a1-dfe1-7c51-a34e-373932cebcb2.tmp')
    const unrelated = join(directory, 'notes.tmp')
    const target = join(directory, 'trusted-peers.json')
    for (const path of [stale, fresh, unrelated, target]) await writeFile(path, '{}\n')
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000)
    await utimes(stale, hourAgo, hourAgo)
    await utimes(unrelated, hourAgo, hourAgo)

    const removed = await sweepStaleTemporaries(directory)
    const remaining = await readdir(directory)

    expect(removed).toEqual([stale])
    expect(remaining).toContain(basename(target))
    expect(remaining).toContain(basename(fresh))
    expect(remaining).toContain(basename(unrelated))
  })
})

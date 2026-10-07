import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ServerLog } from '../src/log.js'

/**
 * The Server is the only party that can prove why a remote connection ended, so its lifecycle
 * log has to survive a long-running deployment: rotation is what keeps it from filling the disk.
 */
const directories: string[] = []

const makeDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-server-log-'))
  directories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('server lifecycle log', () => {
  it('caps the active file and keeps only the declared number of rotated files', () => {
    const directory = makeDirectory()
    const file = join(directory, 'server.log')
    const log = new ServerLog({ file, maxBytes: 4096, maxFiles: 3 })

    for (let index = 0; index < 400; index += 1) {
      log.info('link.dropped', { connectionId: `conn-${index}`, code: 'CONNECTION_FAILED', padding: 'x'.repeat(80) })
    }

    for (const path of log.paths()) {
      expect(existsSync(path)).toBe(true)
      expect(statSync(path).size).toBeLessThanOrEqual(4096)
    }
    // maxFiles counts the active file, so nothing beyond the last rotated index exists.
    expect(existsSync(`${file}.3`)).toBe(false)
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    expect(JSON.parse(lines.at(-1) as string)).toMatchObject({ event: 'link.dropped', connectionId: 'conn-399' })
  })

  it('appends to an existing file instead of restarting it', () => {
    const directory = makeDirectory()
    const file = join(directory, 'server.log')
    writeFileSync(file, '{"event":"earlier"}\n')

    new ServerLog({ file }).info('peer.online', { deviceId: 'device-1' })

    const lines = readFileSync(file, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0] as string).event).toBe('earlier')
    expect(JSON.parse(lines[1] as string)).toMatchObject({ event: 'peer.online', deviceId: 'device-1' })
  })

  it('clamps a misconfigured cap so rotation cannot be disabled', () => {
    const directory = makeDirectory()
    const log = new ServerLog({ file: join(directory, 'server.log'), maxBytes: 1, maxFiles: 10_000 })
    expect(log.paths()).toHaveLength(10)
  })
})

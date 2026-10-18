import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { replaceFile, sweepStaleTemporaries } from './atomic-file.js'
import { uuidV7 } from './ids.js'

/**
 * How long a lock may sit without a readable owner before it counts as abandoned.
 *
 * A refresh takes seconds, so this only ever fires for a lock left by a process that died between creating the
 * directory and recording itself - and for locks written by a version that did not record an owner at all.
 */
const LOCK_ABANDONED_MS = 10 * 60_000

/** The holder recorded inside the lock directory, so a contender can tell a live owner from a dead one. */
const lockOwnerSchema = z.object({
  pid: z.number().int().positive(),
  at: z.number().int().nonnegative(),
})

const credentialSchema = z.object({
  schemaVersion: z.literal(1),
  serverUrl: z.string().url(),
  deviceId: z.string().min(1),
  authorizationMethod: z.enum(['account', 'host_registration_code', 'owned_device']),
  account: z.string().min(1).max(254).optional(),
  accessToken: z.string().min(16),
  accessTokenExpiresAt: z.number().int().positive(),
  refreshToken: z.string().min(16),
  refreshTokenExpiresAt: z.number().int().positive(),
}).strict()

export interface ServerCredentials extends z.infer<typeof credentialSchema> {}

export class ServerCredentialStore {
  private readonly path: string

  constructor(directory: string) { this.path = join(directory, 'server-credentials.json') }

  /** Serialize the complete read/refresh/write transaction across processes.
   *
   * A lock left by a process that no longer exists can never be released by that process, and being killed
   * mid-refresh is routine on a phone (the app is backgrounded or swept away) - the old rule then left the user
   * with `SERVER_CREDENTIALS_BUSY` forever and told them to delete a file they cannot reach. So the lock now
   * records its owner and a contender reclaims it when that owner is **gone**. Liveness is what is checked, not
   * age: an owner that is merely suspended still protects its one-use refresh token, which is exactly what the
   * old unconditional rule was guarding against.
   */
  async withRefreshLock<T>(operation: () => Promise<T>): Promise<T> {
    const lock = `${this.path}.refresh-lock`
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const deadline = Date.now() + 15_000
    for (;;) {
      try {
        await claimRefreshLock(lock)
        break
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error
        // Reclaiming is a rename, so only one contender wins it; the rest keep waiting.
        if (await reclaimAbandonedRefreshLock(lock)) continue
        if (Date.now() >= deadline) throw new ServerCredentialsBusyError()
        await new Promise(resolve => setTimeout(resolve, 50))
      }
    }
    try {
      return await operation()
    } finally {
      await rm(lock, { recursive: true, force: true })
    }
  }

  async load(serverUrl: string, deviceId: string): Promise<ServerCredentials | undefined> {
    if (!(await exists(this.path))) return undefined
    await assertPrivateMode(this.path)
    let parsed: ServerCredentials
    try {
      parsed = credentialSchema.parse(JSON.parse(await readFile(this.path, 'utf8')))
    } catch (error) {
      throw new ServerCredentialsInvalidError(`server credentials are invalid: ${safeMessage(error)}`)
    }
    return parsed.serverUrl === serverUrl && parsed.deviceId === deviceId ? parsed : undefined
  }

  async save(credentials: Omit<ServerCredentials, 'schemaVersion'>): Promise<ServerCredentials> {
    const record = credentialSchema.parse({ schemaVersion: 1, ...credentials })
    await atomicWrite(this.path, `${JSON.stringify(record, null, 2)}\n`)
    return record
  }

  async clear(): Promise<void> {
    await rm(this.path, { force: true })
  }
}

export class ServerCredentialsInvalidError extends Error {
  readonly code = 'SERVER_CREDENTIALS_INVALID'
}

export class ServerCredentialsBusyError extends Error {
  readonly code = 'SERVER_CREDENTIALS_BUSY'
  constructor() {
    super('Credential refresh is locked. Stop other instances; after a crash, stop all instances before removing server-credentials.json.refresh-lock and authorizing again.')
  }
}

/** Take the lock directory and record who holds it. */
async function claimRefreshLock(lock: string): Promise<void> {
  await mkdir(lock, { mode: 0o700 })
  await writeFile(join(lock, 'owner.json'), `${JSON.stringify({ pid: process.pid, at: Date.now() })}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
}

/**
 * Remove a lock whose owner is gone, and report whether it was reclaimed.
 *
 * An owner that is not recorded (a version without owner files, or a holder that died between `mkdir` and its
 * first write) is judged by age instead. A live owner - including one that is suspended - is never stolen, and
 * `EPERM` counts as alive because that is how a process we may not signal reports itself.
 */
async function reclaimAbandonedRefreshLock(lock: string): Promise<boolean> {
  const owner = await readRefreshLockOwner(lock)
  const abandoned = owner === undefined ? await olderThan(lock, LOCK_ABANDONED_MS) : !processAlive(owner.pid)
  if (!abandoned) return false
  // The rename *is* the claim: only one contender can move the directory away, so two processes cannot both
  // decide they own the recovery.
  const tomb = `${lock}.${process.pid}.${uuidV7()}.abandoned`
  try {
    await rename(lock, tomb)
  } catch {
    return false
  }
  await rm(tomb, { recursive: true, force: true })
  return true
}

async function readRefreshLockOwner(lock: string): Promise<{ pid: number } | undefined> {
  try {
    return lockOwnerSchema.parse(JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')))
  } catch {
    return undefined
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // ESRCH is "no such process". Anything else (EPERM) means it exists but is not ours to signal.
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH')
  }
}

async function olderThan(path: string, ageMs: number): Promise<boolean> {
  try {
    return Date.now() - (await stat(path)).mtimeMs > ageMs
  } catch {
    return false
  }
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  const directory = dirname(path)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await sweepStaleTemporaries(directory)
  const temporary = `${path}.${process.pid}.${uuidV7()}.tmp`
  await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  await chmod(temporary, 0o600)
  await replaceFile(temporary, path)
  await chmod(path, 0o600)
}

async function assertPrivateMode(path: string): Promise<void> {
  if (process.platform === 'win32') return
  const mode = (await stat(path)).mode & 0o777
  if ((mode & 0o077) !== 0) throw new ServerCredentialsInvalidError('server credentials permissions must be 0600')
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

function safeMessage(error: unknown): string { return error instanceof Error ? error.message : 'invalid credential data' }

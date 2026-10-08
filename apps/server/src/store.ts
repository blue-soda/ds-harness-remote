import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { accountDeviceDescriptorSchema, type AccountDeviceDescriptor } from '@dsh-remote/protocol'
import { z } from 'zod'

export class ApiError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code) }
}
export const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
export const secret = (): string => randomBytes(32).toString('base64url')
export const equal = (left: string, right: string): boolean => timingSafeEqual(Buffer.from(hash(left)), Buffer.from(hash(right)))

const tokenSchema = z.object({ kind: z.enum(['access', 'refresh']), deviceId: z.string(), expires: z.number(), used: z.boolean() })
const savedDeviceSchema = z.object({
  /** Account this device belongs to; membership is scoped to it. */
  account: z.string(),
  descriptor: accountDeviceDescriptorSchema,
  revoked: z.boolean(),
  // Whether this device accepts control. Defaulted, so files written before the switch existed load as
  // "yes", which is what they meant.
  hostControl: z.boolean().default(true),
  lastSeenAt: z.number(),
})
/**
 * One account's credentials and its own device/token namespace. Accounts are
 * independent: devices and tokens never cross the boundary, and a password
 * change invalidates only that account's tokens.
 */
const savedAccountSchema = z.object({
  salt: z.string(),
  verifier: z.string(),
  devices: z.record(savedDeviceSchema),
  tokens: z.record(tokenSchema),
  createdAt: z.number(),
  /**
   * External identities bound to this account, as `provider:subject` -> bound-at
   * timestamp. A QR login only succeeds for a subject already listed here, unless
   * the server was explicitly told to create accounts for new subjects.
   */
  oauthLinks: z.record(z.number()).default({}),
})
const stateSchema = z.object({
  version: z.literal(2),
  accounts: z.record(savedAccountSchema),
})
type SavedDevice = z.infer<typeof savedDeviceSchema>
type SavedAccount = z.infer<typeof savedAccountSchema>

/**
 * Read the state file, tolerating an older format.
 *
 * A single-account file stores one `account` with its own `devices`/`tokens`.
 * That layout cannot be merged into the account-scoped one (two accounts may
 * legitimately hold a device with the same id), so the file is preserved
 * alongside as `<file>.v1.bak` and the server starts empty: every device
 * re-registers and re-authorizes, but no data is destroyed and startup never
 * fails on an old file.
 */
function loadState(file: string): z.infer<typeof stateSchema> {
  if (!existsSync(file)) return { version: 2, accounts: {} }
  let raw: unknown
  try { raw = JSON.parse(readFileSync(file, 'utf8')) } catch { throw new Error(`${file} is not valid JSON.`) }
  const parsed = stateSchema.safeParse(raw)
  if (parsed.success) return parsed.data
  const legacy = z.object({ version: z.literal(1), account: z.string() }).safeParse(raw)
  if (legacy.success) {
    let backup = `${file}.v1.bak`
    for (let ordinal = 2; existsSync(backup); ordinal += 1) backup = `${file}.v1.bak${ordinal}`
    renameSync(file, backup)
    console.warn(`Remote Server: ${file} used the single-account format; kept it as ${backup} and started with no accounts.`)
    return { version: 2, accounts: {} }
  }
  throw new Error(`${file} is not a recognised state file; refusing to overwrite it.`)
}

/**
 * Single-process multi-account store. Only token digests and public identities
 * reach disk; passwords are stored as scrypt verifiers, never in clear text.
 */
export class Store {
  private state: z.infer<typeof stateSchema>
  onInvalidate: (id: string, account: string) => void = () => {}

  constructor(private readonly file: string) {
    this.state = loadState(file)
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 })
    renameSync(tmp, this.file)
  }

  /** Accounts known to this server, newest last. */
  listAccounts(): string[] { return Object.keys(this.state.accounts) }

  /** The account an external identity is bound to, if any. */
  findAccountByOAuth(link: string): string | undefined {
    for (const [name, account] of Object.entries(this.state.accounts)) {
      if (account.oauthLinks[link] !== undefined) return name
    }
    return undefined
  }

  /** Bind an external identity to an existing account, replacing any other binding for it. */
  linkOAuth(accountName: string, link: string): void {
    const account = this.account(accountName)
    if (account === undefined) throw new ApiError('AUTH_INVALID', 401)
    for (const [name, other] of Object.entries(this.state.accounts)) {
      if (name !== accountName) delete other.oauthLinks[link]
    }
    account.oauthLinks[link] = Date.now()
    this.save()
  }

  /** One account's record, or undefined when it does not exist. */
  private account(name: string): SavedAccount | undefined {
    return Object.hasOwn(this.state.accounts, name) ? this.state.accounts[name] : undefined
  }

  /**
   * Create the account, or update its password. A changed verifier drops that
   * account's tokens (devices stay registered, as they re-authorize with the
   * new password), matching the single-account behaviour this replaces.
   */
  upsertAccount(name: string, password: string): void {
    const existing = this.account(name)
    const salt = existing?.salt ?? secret()
    const verifier = scryptSync(password, salt, 32).toString('hex')
    if (existing === undefined) {
      this.state.accounts[name] = { salt, verifier, devices: {}, tokens: {}, createdAt: Date.now(), oauthLinks: {} }
      this.save()
      return
    }
    if (!equal(existing.verifier, verifier)) {
      existing.salt = salt
      existing.verifier = verifier
      for (const id of Object.keys(existing.devices)) this.onInvalidate(id, name)
      existing.tokens = {}
    }
    this.save()
  }

  /** Whether the account exists and the password matches, without issuing anything. */
  verifyAccount(name: string, password: string): boolean {
    const account = this.account(name)
    if (account === undefined) return false
    return equal(account.verifier, scryptSync(password, account.salt, 32).toString('hex'))
  }

  /** Number of active (non-revoked) devices on an account. */
  deviceCount(name: string): number {
    return Object.values(this.account(name)?.devices ?? {}).filter(d => !d.revoked).length
  }

  /** Devices of one account, excluding revoked ones. */
  devicesFor(name: string): SavedDevice[] {
    return Object.values(this.account(name)?.devices ?? {}).filter(d => !d.revoked)
  }

  /**
   * Resolve a device scoped to one account. Tokens are per-account, so a token
   * issued for one account can never resolve a device of another.
   */
  get(id: string, accountName?: string): SavedDevice {
    const device = accountName === undefined
      ? Object.values(this.state.accounts).map(a => a.devices[id]).find(d => d !== undefined)
      : this.account(accountName)?.devices[id]
    if (!device) throw new ApiError('DEVICE_NOT_FOUND', 404)
    if (device.revoked) throw new ApiError('DEVICE_REVOKED', 403)
    return device
  }

  /** Every non-revoked device on the server, across accounts. */
  list(): SavedDevice[] {
    return Object.values(this.state.accounts).flatMap(a => Object.values(a.devices)).filter(d => !d.revoked)
  }

  /**
   * Register a device on an account. The device namespace is per account, so the
   * same machine may hold a device on several accounts.
   */
  register(accountName: string, descriptor: AccountDeviceDescriptor): ReturnType<Store['issue']> {
    const account = this.account(accountName)
    if (account === undefined) throw new ApiError('AUTH_INVALID', 401)
    const old = account.devices[descriptor.deviceId]
    // A revoked row left behind by an older server build stays unusable unless the same identity key
    // proves it is the same installation asking to come back; a different key claiming the id is
    // refused, so ids can never be taken over.
    if (old?.revoked && old.descriptor.identityKey !== descriptor.identityKey) throw new ApiError('DEVICE_REVOKED', 403)
    // The identity key decides ownership: a different key claiming the same id is refused, which is what keeps
    // an id from being taken over now that no role pins a device.
    if (old && old.descriptor.identityKey !== descriptor.identityKey) throw new ApiError('PEER_IDENTITY_MISMATCH', 409)
    if (!old && Object.values(account.devices).length >= 256) throw new ApiError('RATE_LIMITED', 429)
    account.devices[descriptor.deviceId] = {
      account: accountName,
      descriptor,
      revoked: false,
      // Signing in again must not silently switch control back on.
      hostControl: old?.hostControl ?? true,
      lastSeenAt: old?.lastSeenAt ?? 0,
    }
    this.invalidate(descriptor.deviceId, accountName)
    return this.issue(accountName, descriptor.deviceId)
  }

  private issue(accountName: string, deviceId: string, refreshTokenExpiresAt = Date.now() + 30 * 86400_000) {
    const account = this.account(accountName)
    if (account === undefined) throw new ApiError('AUTH_INVALID', 401)
    for (const [key, value] of Object.entries(account.tokens)) if (value.expires <= Date.now()) delete account.tokens[key]
    if (Object.keys(account.tokens).length >= 16384) throw new ApiError('RATE_LIMITED', 429)
    const accessToken = secret(), refreshToken = secret()
    const accessTokenExpiresAt = Date.now() + 60 * 60_000
    account.tokens[hash(accessToken)] = { kind: 'access', deviceId, expires: accessTokenExpiresAt, used: false }
    account.tokens[hash(refreshToken)] = { kind: 'refresh', deviceId, expires: refreshTokenExpiresAt, used: false }
    this.save()
    return { accessToken, refreshToken, accessTokenExpiresAt, refreshTokenExpiresAt }
  }

  /** Resolve a device from its access token, within the account that issued it. */
  authenticate(token: string): SavedDevice {
    for (const account of Object.values(this.state.accounts)) {
      const record = account.tokens[hash(token)]
      if (!record || record.kind !== 'access') continue
      if (record.expires <= Date.now()) throw new ApiError('TOKEN_EXPIRED', 401)
      return this.get(record.deviceId)
    }
    throw new ApiError('AUTH_INVALID', 401)
  }

  /** The account a device token belongs to, without exposing the device. */
  accountForToken(token: string): string {
    return this.authenticate(token).account
  }

  refresh(deviceId: string, token: string) {
    const digest = hash(token)
    for (const [accountName, account] of Object.entries(this.state.accounts)) {
      const record = account.tokens[digest]
      if (!record || record.kind !== 'refresh' || record.deviceId !== deviceId) continue
      this.get(deviceId, accountName)
      if (record.expires <= Date.now()) throw new ApiError('TOKEN_EXPIRED', 401)
      // A reused refresh token drops the whole family for that device.
      if (record.used) { this.invalidate(deviceId, accountName); throw new ApiError('AUTH_INVALID', 401) }
      record.used = true
      return this.issue(accountName, deviceId, record.expires)
    }
    throw new ApiError('AUTH_INVALID', 401)
  }

  /** Drop every token of one device; reports the device id and account for socket teardown. */
  invalidate(deviceId: string, accountName?: string): void {
    const accounts = accountName === undefined
      ? Object.entries(this.state.accounts)
      : Object.entries(this.state.accounts).filter(([name]) => name === accountName)
    for (const [, account] of accounts) {
      for (const [key, value] of Object.entries(account.tokens)) if (value.deviceId === deviceId) delete account.tokens[key]
    }
    this.onInvalidate(deviceId, accountName ?? '')
    this.save()
  }

  /**
   * Remove a device from its account for good.
   *
   * The row is deleted rather than marked, which is what makes a device identity stable: the device
   * keeps its own id, so registering again after a fresh login recreates *this* device instead of
   * forcing a new identity - the rotation the client used to perform, which burned an account's 256
   * device slots and made one installation look like several. Deleting the row also drops every token
   * it held, so the cut-off is immediate rather than "on next login".
   *
   * A device is only eligible to return by signing in again: registration requires an account session
   * or a registration code, never just a device token.
   */
  /** Record whether a device accepts control. Persisted, so it survives a Server restart. */
  setHostControl(id: string, enabled: boolean): void {
    const device = this.get(id)
    device.hostControl = enabled
    this.save()
  }

  revoke(id: string): void {
    const device = this.get(id)
    delete this.account(device.account)!.devices[id]
    this.invalidate(id, device.account)
  }

  touch(id: string, clientVersion?: string, harnessVersion?: string): void {
    const d = this.get(id)
    d.lastSeenAt = Date.now()
    if (clientVersion) d.descriptor.clientVersion = clientVersion.slice(0, 64)
    if (harnessVersion) d.descriptor.harnessVersion = harnessVersion.slice(0, 64)
    this.save()
  }
}

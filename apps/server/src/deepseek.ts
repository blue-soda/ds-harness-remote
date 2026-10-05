/**
 * DeepSeek account verification for the self-hosted Server.
 *
 * A DSH Host signs in to the DeepSeek account platform with a browser
 * authorization and holds an account grant. This module lets the Server confirm
 * that grant *itself*, so a client cannot simply claim someone else's account id:
 * the plugin hands over the grant, the Server asks the platform who it belongs
 * to, and then discards it. The grant is never persisted.
 */

/** Stable account identity produced by the platform. */
export interface DeepSeekIdentity {
  /** Platform `id`, the stable account identifier a binding is keyed on. */
  subject: string
  /** Profile name when the platform exposes one, else the contact address. */
  displayName?: string
}

export interface DeepSeekVerifierOptions {
  /** Account platform origin; defaults to the production platform. */
  platformOrigin?: string
  /** Client version reported to the platform. */
  clientVersion?: string
  /** Overrides fetch in tests. */
  fetchImpl?: typeof fetch
}

export interface DeepSeekVerifier {
  readonly platformOrigin: string
  /** Resolve the grant's account, or undefined when the platform rejects it. */
  verify(token: string): Promise<DeepSeekIdentity | undefined>
}

/** Login policy in addition to the platform connection itself. */
export interface DeepSeekLoginOptions extends DeepSeekVerifierOptions {
  /**
   * Whether a grant with no existing binding may create its account. Off by
   * default: an unknown grant is refused, so holding any DeepSeek account does
   * not by itself open an account on this Server.
   */
  createsAccounts?: boolean
}

export const DEFAULT_DEEPSEEK_PLATFORM_ORIGIN = 'https://platform.deepseek.com'

/**
 * The platform sits behind a WAF that answers 429 to any request without a
 * browser User-Agent, so a plain programmatic client is refused before it ever
 * reaches the account API. A browser-shaped value is therefore part of the
 * protocol, not a cosmetic header; removing it breaks every verification.
 */
const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** Bound the verification call so a slow platform cannot hold a login open. */
const VERIFY_TIMEOUT_MS = 15_000

const USERS_CURRENT_PATH = '/auth-api/v0/users/current'

/**
 * Platform client identity headers.
 *
 * The platform attributes each request to the UI that made it, so these are
 * required alongside the grant; the bundle id is intentionally empty.
 */
function clientHeaders(clientVersion: string): Record<string, string> {
  return {
    'User-Agent': BROWSER_USER_AGENT,
    'x-client-bundle-id': '',
    'x-client-platform': 'web',
    'x-client-version': clientVersion,
    'x-client-locale': 'zh_CN',
    // Shanghai offset in seconds; the platform only uses this for display.
    'x-client-timezone-offset': '28800',
  }
}

export function createDeepSeekVerifier(options: DeepSeekVerifierOptions = {}): DeepSeekVerifier {
  const platformOrigin = (options.platformOrigin ?? DEFAULT_DEEPSEEK_PLATFORM_ORIGIN).replace(/\/+$/, '')
  const clientVersion = options.clientVersion ?? '0.2.1-alpha.1'
  const doFetch = options.fetchImpl ?? fetch

  return {
    platformOrigin,
    async verify(token) {
      if (token.trim().length === 0) return undefined
      const response = await doFetch(`${platformOrigin}${USERS_CURRENT_PATH}`, {
        method: 'GET',
        headers: { ...clientHeaders(clientVersion), 'x-dsh-auth-token': token },
        signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
        redirect: 'error',
      })
      if (!response.ok) return undefined
      const payload = await response.json() as {
        code?: unknown
        data?: { biz_code?: unknown; biz_data?: unknown } | null
      }
      // A rejected or missing grant reports a business code rather than a status.
      if (payload.code !== 0) return undefined
      if (payload.data === null || payload.data === undefined || payload.data.biz_code !== 0) return undefined
      return projectIdentity(payload.data.biz_data)
    },
  }
}

/** Read the stable id and a display name out of one profile payload. */
function projectIdentity(value: unknown): DeepSeekIdentity | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const user = value as {
    id?: unknown
    email?: unknown
    id_profile?: { name?: unknown } | null
  }
  const id = user.id
  if (typeof id !== 'string' || id.length === 0) return undefined
  const name = user.id_profile?.name
  const displayName = typeof name === 'string' && name.length > 0
    ? name
    : typeof user.email === 'string' && user.email.length > 0 ? user.email : undefined
  return { subject: id, ...(displayName === undefined ? {} : { displayName }) }
}

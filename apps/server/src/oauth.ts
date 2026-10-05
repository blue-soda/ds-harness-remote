/**
 * QR OAuth providers for the self-hosted server.
 *
 * WeChat's Open Platform website login is the production path; it needs an
 * enterprise-verified app plus a registered callback origin, so a local mock
 * provider implements the same contract and lets the whole flow be exercised
 * without any WeChat credentials.
 */

/** One completed authorization: the provider's stable subject plus a display name. */
export interface OAuthIdentity {
  subject: string
  displayName: string
}

/** Everything a provider needs to build an authorization URL. */
export interface QrAuthorizationRequest {
  /** Opaque session id the client polls with; the provider echoes it through WeChat `state`. */
  qrId: string
  /** Public origin of this server, used to build the callback URL. */
  origin: string
}

export interface OAuthProvider {
  readonly name: string
  /** Authorization URL to encode in the QR image. */
  scanUrl(request: QrAuthorizationRequest): string
  /** Server-side callback URL this provider redirects to. */
  callbackUrl(request: QrAuthorizationRequest): string
  /**
   * Exchange a provider callback for an identity. Returns undefined when the
   * callback does not complete an authorization (for example a user cancel).
   */
  complete(query: URLSearchParams): Promise<OAuthIdentity | undefined>
}

/**
 * Bound every outbound provider call. Without this a blocked or slow provider
 * leaves the browser waiting on the callback until the reverse proxy times it
 * out, so the failure has to become a fast, reportable error instead.
 */
const PROVIDER_TIMEOUT_MS = 15_000

/** `fetch` with a hard deadline; the caller turns a rejection into a 5xx. */
function providerFetch(
  doFetch: typeof fetch,
  input: string,
  init?: Parameters<typeof fetch>[1],
): Promise<Response> {
  return doFetch(input, { ...init, signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) })
}

const WEIXIN_AUTHORIZE_URL = 'https://open.weixin.qq.com/connect/qrconnect'
const WEIXIN_TOKEN_URL = 'https://api.weixin.qq.com/sns/oauth2/access_token'
const WEIXIN_CALLBACK_PATH = '/api/v1/auth/oauth/wechat/callback'

export interface WeixinProviderOptions {
  appId: string
  appSecret: string
  /** Overrides the fetch implementation in tests. */
  fetchImpl?: typeof fetch
}

/**
 * WeChat Open Platform website-application QR login (`snsapi_login`).
 *
 * The callback carries a one-time `code`, exchanged server-side for the user's
 * `openid`; that openid is the stable subject an account is bound to.
 */
export function createWeixinProvider(options: WeixinProviderOptions): OAuthProvider {
  const doFetch = options.fetchImpl ?? fetch
  return {
    name: 'wechat',
    scanUrl(request) {
      const url = new URL(WEIXIN_AUTHORIZE_URL)
      url.searchParams.set('appid', options.appId)
      url.searchParams.set('redirect_uri', callbackUrl(request))
      url.searchParams.set('response_type', 'code')
      url.searchParams.set('scope', 'snsapi_login')
      url.searchParams.set('state', request.qrId)
      return `${url.toString()}#wechat_redirect`
    },
    callbackUrl,
    async complete(query) {
      const code = query.get('code')
      if (typeof code !== 'string' || code.length === 0) return undefined
      const url = new URL(WEIXIN_TOKEN_URL)
      url.searchParams.set('appid', options.appId)
      url.searchParams.set('secret', options.appSecret)
      url.searchParams.set('code', code)
      url.searchParams.set('grant_type', 'authorization_code')
      const response = await providerFetch(doFetch, url.toString())
      if (!response.ok) return undefined
      const body = await response.json() as { openid?: unknown; nickname?: unknown }
      if (typeof body.openid !== 'string' || body.openid.length === 0) return undefined
      return {
        subject: body.openid,
        displayName: typeof body.nickname === 'string' && body.nickname.length > 0
          ? body.nickname
          : `wechat:${body.openid.slice(0, 8)}`,
      }
    },
  }

  function callbackUrl(request: QrAuthorizationRequest): string {
    return new URL(WEIXIN_CALLBACK_PATH, request.origin).toString()
  }
}

const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize'
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const GITHUB_USER_URL = 'https://api.github.com/user'
const GITHUB_CALLBACK_PATH = '/api/v1/auth/oauth/github/callback'

export interface GithubProviderOptions {
  clientId: string
  clientSecret: string
  /** Overrides the fetch implementation in tests. */
  fetchImpl?: typeof fetch
}

/**
 * GitHub OAuth App login.
 *
 * Unlike WeChat this needs no enterprise verification, no ICP-filed domain and
 * no fee: any GitHub account may register an OAuth App, and GitHub only requires
 * the callback URL to match the one registered on the app.
 *
 * The stable subject is the numeric account id, not the login name, so renaming
 * a GitHub user never orphans the binding.
 */
export function createGithubProvider(options: GithubProviderOptions): OAuthProvider {
  const doFetch = options.fetchImpl ?? fetch
  return {
    name: 'github',
    scanUrl(request) {
      const url = new URL(GITHUB_AUTHORIZE_URL)
      url.searchParams.set('client_id', options.clientId)
      url.searchParams.set('redirect_uri', callbackUrl(request))
      url.searchParams.set('scope', 'read:user')
      url.searchParams.set('state', request.qrId)
      return url.toString()
    },
    callbackUrl,
    async complete(query) {
      const code = query.get('code')
      if (typeof code !== 'string' || code.length === 0) return undefined
      const tokenResponse = await providerFetch(doFetch, GITHUB_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          client_id: options.clientId,
          client_secret: options.clientSecret,
          code,
        }),
      })
      if (!tokenResponse.ok) return undefined
      const tokenBody = await tokenResponse.json() as { access_token?: unknown }
      if (typeof tokenBody.access_token !== 'string' || tokenBody.access_token.length === 0) return undefined

      const userResponse = await providerFetch(doFetch, GITHUB_USER_URL, {
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${tokenBody.access_token}` },
      })
      if (!userResponse.ok) return undefined
      const user = await userResponse.json() as { id?: unknown; login?: unknown; name?: unknown }
      if (typeof user.id !== 'number' || !Number.isFinite(user.id)) return undefined
      const displayName = typeof user.name === 'string' && user.name.length > 0
        ? user.name
        : typeof user.login === 'string' && user.login.length > 0 ? user.login : `github:${user.id}`
      return { subject: String(user.id), displayName }
    },
  }

  function callbackUrl(request: QrAuthorizationRequest): string {
    return new URL(GITHUB_CALLBACK_PATH, request.origin).toString()
  }
}

const MOCK_CALLBACK_PATH = '/api/v1/auth/oauth/mock/callback'
const MOCK_CONFIRM_PATH = '/api/v1/auth/oauth/mock/confirm'

/**
 * Local stand-in for WeChat: the QR image encodes a URL on this server where a
 * browser confirms the login, and the callback hands back a deterministic
 * subject. Only reachable when the server is explicitly configured for it.
 */
export function createMockProvider(): OAuthProvider {
  return {
    name: 'mock',
    scanUrl: request => new URL(`${MOCK_CONFIRM_PATH}?state=${encodeURIComponent(request.qrId)}`, request.origin).toString(),
    callbackUrl: request => new URL(`${MOCK_CALLBACK_PATH}?state=${encodeURIComponent(request.qrId)}`, request.origin).toString(),
    async complete(query) {
      const subject = query.get('subject')
      if (typeof subject !== 'string' || subject.trim().length === 0) return undefined
      return { subject: subject.trim(), displayName: subject.trim() }
    },
  }
}

export interface OAuthProviderConfig {
  /** `auto` uses GitHub when configured, then WeChat, and is otherwise off. */
  provider: 'auto' | 'github' | 'wechat' | 'mock' | 'off'
  githubClientId?: string
  githubClientSecret?: string
  appId?: string
  appSecret?: string
}

/**
 * Resolve the configured provider, or undefined when QR login is unavailable.
 *
 * `auto` prefers GitHub (no enterprise verification and no ICP-filed callback
 * domain needed) and falls back to WeChat when only WeChat credentials exist.
 */
export function resolveOAuthProvider(
  config: OAuthProviderConfig,
  fetchImpl?: typeof fetch,
): OAuthProvider | undefined {
  if (config.provider === 'off') return undefined
  if (config.provider === 'mock') return createMockProvider()

  const github = { id: config.githubClientId, secret: config.githubClientSecret }
  const wechat = { id: config.appId, secret: config.appSecret }
  const githubReady = github.id !== undefined && github.secret !== undefined
  const wechatReady = wechat.id !== undefined && wechat.secret !== undefined

  if (config.provider === 'github') {
    if (!githubReady) throw new Error('DSH_SERVER_GITHUB_CLIENT_ID and DSH_SERVER_GITHUB_CLIENT_SECRET are required when DSH_SERVER_OAUTH_PROVIDER=github.')
    return createGithubProvider({ clientId: github.id!, clientSecret: github.secret!, ...(fetchImpl === undefined ? {} : { fetchImpl }) })
  }
  if (config.provider === 'wechat') {
    if (!wechatReady) throw new Error('DSH_SERVER_WECHAT_APP_ID and DSH_SERVER_WECHAT_APP_SECRET are required when DSH_SERVER_OAUTH_PROVIDER=wechat.')
    return createWeixinProvider({ appId: wechat.id!, appSecret: wechat.secret!, ...(fetchImpl === undefined ? {} : { fetchImpl }) })
  }

  if (githubReady) return createGithubProvider({ clientId: github.id!, clientSecret: github.secret!, ...(fetchImpl === undefined ? {} : { fetchImpl }) })
  if (wechatReady) return createWeixinProvider({ appId: wechat.id!, appSecret: wechat.secret!, ...(fetchImpl === undefined ? {} : { fetchImpl }) })
  return undefined
}

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
      const response = await doFetch(url)
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
  /** `auto` uses WeChat when credentials are present and is otherwise off. */
  provider: 'auto' | 'wechat' | 'mock' | 'off'
  appId?: string
  appSecret?: string
}

/**
 * Resolve the configured provider, or undefined when QR login is unavailable.
 * Default `auto` requires both WeChat credentials, so a server without them
 * simply does not advertise QR login.
 */
export function resolveOAuthProvider(
  config: OAuthProviderConfig,
  fetchImpl?: typeof fetch,
): OAuthProvider | undefined {
  if (config.provider === 'off') return undefined
  if (config.provider === 'mock') return createMockProvider()
  const hasCredentials = config.appId !== undefined && config.appSecret !== undefined
  if (config.provider === 'wechat' && !hasCredentials) {
    throw new Error('DSH_SERVER_WECHAT_APP_ID and DSH_SERVER_WECHAT_APP_SECRET are required when DSH_SERVER_OAUTH_PROVIDER=wechat.')
  }
  if (!hasCredentials) return undefined
  const { appId, appSecret } = config
  if (appId === undefined || appSecret === undefined) return undefined
  return createWeixinProvider({
    appId,
    appSecret,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  })
}

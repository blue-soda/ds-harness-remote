import { dirname, join, resolve } from 'node:path'
import { createRemoteServer } from './server.js'

/** Read an optional positive-integer environment variable, rejecting nonsense loudly. */
function optionalPositiveInteger(name: string): number | undefined {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return undefined
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`)
  return value
}
const port = Number(process.env.DSH_SERVER_PORT ?? '8080')
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid DSH_SERVER_PORT.')
const registrationCode = process.env.DSH_SERVER_REGISTRATION_CODE
if (registrationCode !== undefined && registrationCode.trim().length < 12) {
  throw new Error('DSH_SERVER_REGISTRATION_CODE must be at least 12 characters when set.')
}
/** QR OAuth: `auto` prefers GitHub, then WeChat, and is otherwise disabled. */
const oauthProvider = (process.env.DSH_SERVER_OAUTH_PROVIDER ?? 'auto').trim()
if (!['auto', 'github', 'wechat', 'mock', 'off'].includes(oauthProvider)) {
  throw new Error('DSH_SERVER_OAUTH_PROVIDER must be one of: auto, github, wechat, mock, off.')
}
const githubClientId = process.env.DSH_SERVER_GITHUB_CLIENT_ID?.trim()
const githubClientSecret = process.env.DSH_SERVER_GITHUB_CLIENT_SECRET?.trim()
if (oauthProvider === 'github' && (githubClientId === undefined || githubClientId === '' || githubClientSecret === undefined || githubClientSecret === '')) {
  throw new Error('DSH_SERVER_GITHUB_CLIENT_ID and DSH_SERVER_GITHUB_CLIENT_SECRET are required when DSH_SERVER_OAUTH_PROVIDER=github.')
}
const wechatAppId = process.env.DSH_SERVER_WECHAT_APP_ID?.trim()
const wechatAppSecret = process.env.DSH_SERVER_WECHAT_APP_SECRET?.trim()
if (oauthProvider === 'wechat' && (wechatAppId === undefined || wechatAppId === '' || wechatAppSecret === undefined || wechatAppSecret === '')) {
  throw new Error('DSH_SERVER_WECHAT_APP_ID and DSH_SERVER_WECHAT_APP_SECRET are required when DSH_SERVER_OAUTH_PROVIDER=wechat.')
}
const dataFile = resolve(process.env.DSH_SERVER_DATA_FILE ?? 'data/state.json')
const logFile = process.env.DSH_SERVER_LOG_FILE?.trim()
const logMaxBytes = optionalPositiveInteger('DSH_SERVER_LOG_MAX_BYTES')
const logMaxFiles = optionalPositiveInteger('DSH_SERVER_LOG_FILES')
// Heartbeat cadence and the silence it tolerates. The Gateway rejects a pair whose grace period does
// not span at least two intervals, so a mistake here fails the boot instead of dropping every peer.
const heartbeatIntervalMs = optionalPositiveInteger('DSH_SERVER_HEARTBEAT_INTERVAL_MS')
const peerTimeoutMs = optionalPositiveInteger('DSH_SERVER_PEER_TIMEOUT_MS')
const app = createRemoteServer({
  account: process.env.DSH_SERVER_ACCOUNT ?? '',
  password: process.env.DSH_SERVER_PASSWORD ?? '',
  publicUrl: process.env.DSH_SERVER_PUBLIC_URL ?? `http://localhost:${port}`,
  dataFile,
  ...(registrationCode === undefined || registrationCode.trim() === '' ? {} : { registrationCode: registrationCode.trim() }),
  oauth: {
    provider: oauthProvider as 'auto' | 'github' | 'wechat' | 'mock' | 'off',
    ...(githubClientId === undefined || githubClientId === '' ? {} : { githubClientId }),
    ...(githubClientSecret === undefined || githubClientSecret === '' ? {} : { githubClientSecret }),
    ...(wechatAppId === undefined || wechatAppId === '' ? {} : { appId: wechatAppId }),
    ...(wechatAppSecret === undefined || wechatAppSecret === '' ? {} : { appSecret: wechatAppSecret }),
  },
  // Lifecycle log beside the state file unless the operator points it elsewhere. Rotation caps
  // the size, so diagnostics cannot grow without bound.
  log: {
    file: logFile === undefined || logFile === '' ? join(dirname(dataFile), 'logs', 'server.log') : resolve(logFile),
    ...(logMaxBytes === undefined ? {} : { maxBytes: logMaxBytes }),
    ...(logMaxFiles === undefined ? {} : { maxFiles: logMaxFiles }),
  },
  heartbeat: {
    ...(heartbeatIntervalMs === undefined ? {} : { intervalMs: heartbeatIntervalMs }),
    ...(peerTimeoutMs === undefined ? {} : { peerTimeoutMs }),
  },
  // Scanning a code may create an account only when the operator opts in.
  oauthCreatesAccounts: process.env.DSH_SERVER_OAUTH_CREATES_ACCOUNTS === 'true',
  // QR-only deployments keep one sign-in path, so no password can diverge.
  passwordLoginDisabled: process.env.DSH_SERVER_PASSWORD_LOGIN === 'off',
  // DeepSeek account login is opt-in: it mounts an endpoint and calls the
  // account platform, so it stays off until an operator asks for it.
  ...(process.env.DSH_SERVER_DEEPSEEK_LOGIN === 'on'
    ? {
      deepseek: {
        ...(process.env.DSH_SERVER_DEEPSEEK_PLATFORM?.trim() ? { platformOrigin: process.env.DSH_SERVER_DEEPSEEK_PLATFORM.trim() } : {}),
        // A first-time grant creates its account only when explicitly allowed.
        createsAccounts: process.env.DSH_SERVER_DEEPSEEK_CREATES_ACCOUNTS === 'true',
      },
    }
    : {}),
})
app.server.listen(port, process.env.DSH_SERVER_HOST ?? '127.0.0.1', () => console.info(`Remote Server listening on port ${port}`))
app.server.on('error', () => { console.error('Remote Server could not listen. Check address and port.'); process.exitCode = 1; app.gateway.close() })
let stopping = false
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (stopping) return
  stopping = true
  void app.close().then(() => { process.exitCode = 0 }, () => { process.exitCode = 1 })
})

import { resolve } from 'node:path'
import { createRemoteServer } from './server.js'

const port = Number(process.env.DSH_SERVER_PORT ?? '8080')
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid DSH_SERVER_PORT.')
const registrationCode = process.env.DSH_SERVER_REGISTRATION_CODE
if (registrationCode !== undefined && registrationCode.trim().length < 12) {
  throw new Error('DSH_SERVER_REGISTRATION_CODE must be at least 12 characters when set.')
}
/** QR OAuth: `auto` uses WeChat when both credentials are present, else disabled. */
const oauthProvider = (process.env.DSH_SERVER_OAUTH_PROVIDER ?? 'auto').trim()
if (!['auto', 'wechat', 'mock', 'off'].includes(oauthProvider)) {
  throw new Error('DSH_SERVER_OAUTH_PROVIDER must be one of: auto, wechat, mock, off.')
}
const wechatAppId = process.env.DSH_SERVER_WECHAT_APP_ID?.trim()
const wechatAppSecret = process.env.DSH_SERVER_WECHAT_APP_SECRET?.trim()
if (oauthProvider === 'wechat' && (wechatAppId === undefined || wechatAppId === '' || wechatAppSecret === undefined || wechatAppSecret === '')) {
  throw new Error('DSH_SERVER_WECHAT_APP_ID and DSH_SERVER_WECHAT_APP_SECRET are required when DSH_SERVER_OAUTH_PROVIDER=wechat.')
}
const app = createRemoteServer({
  account: process.env.DSH_SERVER_ACCOUNT ?? '',
  password: process.env.DSH_SERVER_PASSWORD ?? '',
  publicUrl: process.env.DSH_SERVER_PUBLIC_URL ?? `http://localhost:${port}`,
  dataFile: resolve(process.env.DSH_SERVER_DATA_FILE ?? 'data/state.json'),
  ...(registrationCode === undefined || registrationCode.trim() === '' ? {} : { registrationCode: registrationCode.trim() }),
  oauth: {
    provider: oauthProvider as 'auto' | 'wechat' | 'mock' | 'off',
    ...(wechatAppId === undefined || wechatAppId === '' ? {} : { appId: wechatAppId }),
    ...(wechatAppSecret === undefined || wechatAppSecret === '' ? {} : { appSecret: wechatAppSecret }),
  },
  // Scanning a code may create an account only when the operator opts in.
  oauthCreatesAccounts: process.env.DSH_SERVER_OAUTH_CREATES_ACCOUNTS === 'true',
})
app.server.listen(port, process.env.DSH_SERVER_HOST ?? '127.0.0.1', () => console.info(`Remote Server listening on port ${port}`))
app.server.on('error', () => { console.error('Remote Server could not listen. Check address and port.'); process.exitCode = 1; app.gateway.close() })
let stopping = false
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (stopping) return
  stopping = true
  void app.close().then(() => { process.exitCode = 0 }, () => { process.exitCode = 1 })
})

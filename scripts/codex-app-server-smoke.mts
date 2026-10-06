// Read-only smoke test against the real Codex App Server.
//
// Drives the same path a remote Client uses: the domain's peer bridge applies the
// codex.app.call policy, resolves the workspace authority, and reads threads and
// history. It answers what no unit test can: does the installed Codex still accept
// our requests, and does the authority accept the threads Codex itself lists.
//
// Observed on Codex 0.160.0 (2026-10-06): thread/list, thread/read (metadata and
// full history), dsh/sessionHistory, model/list and account/read all succeed, while
// thread/turns/list is refused by the policy on purpose - the Host paginates
// upstream and clients read the result through dsh/sessionHistory. A thread/list
// carrying originators reaches the App Server and is refused there when the value
// is not one it knows, which is the intended split: the policy admits the field
// upstream declares, upstream validates the value.
//
// Usage: node --import tsx/esm scripts/codex-app-server-smoke.mts <path-to-codex.exe>
import { CodexRemoteDomain } from '../packages/plugin/src/codex/domain.js'
import { SafeLogger } from '../packages/plugin/src/logging.js'

const binary = process.argv[2] ?? 'codex'
const logger = new SafeLogger({
  debug: () => {},
  info: message => { console.log(`  · ${message}`) },
  warn: message => { console.log(`  ! ${message}`) },
  error: message => { console.log(`  !! ${message}`) },
}, 'debug')

const domain = new CodexRemoteDomain({ enabled: true, binary }, logger)
await domain.start()
console.log(`  available = ${String(domain.isAvailable())}`)
if (!domain.isAvailable()) {
  console.log('  status =', JSON.stringify(domain.status()))
  await domain.close()
  process.exit(0)
}

const peer = domain.createPeer({ connectionId: 'smoke', peerDeviceId: 'smoke-device' }, () => undefined)
if (peer === undefined) {
  console.log('  no peer bridge')
  await domain.close()
  process.exit(0)
}

const call = async (method, params) => {
  try {
    return { ok: true, value: await peer.call({ method, params }) }
  } catch (error) {
    return { ok: false, code: error?.code ?? '(no code)', message: String(error?.message ?? error).slice(0, 200) }
  }
}

const listed = await call('thread/list', { limit: 5, sortKey: 'updated_at', sortDirection: 'desc', archived: false })
if (!listed.ok) {
  console.log(`  thread/list FAILED ${listed.code}: ${listed.message}`)
} else {
  const threads = listed.value?.data ?? []
  console.log(`  thread/list ok: ${threads.length} threads`)
  for (const thread of threads.slice(0, 3)) {
    const name = thread.name === null ? '(null)' : JSON.stringify(thread.name)
    const read = await call('thread/read', { threadId: thread.id, includeTurns: false })
    const verdict = read.ok ? 'read ok' : `read FAILED ${read.code}: ${read.message}`
    console.log(`  ${String(thread.id).slice(0, 12)}… name=${name} cwd=${thread.cwd ?? '-'} → ${verdict}`)
  }
}

// The exact call surface the virtual Harness uses, in the order a session open
// exercises it, so a policy or App Server refusal names the call that broke.
const first = (listed.ok ? listed.value?.data ?? [] : [])[0]
if (first !== undefined) {
  console.log('  --- virtual Harness surface ---')
  for (const probe of [
    { method: 'project/list', params: { limit: 100 } },
    { method: 'thread/list', params: { limit: 100, sortKey: 'updated_at', sortDirection: 'desc', archived: false } },
    { method: 'thread/read', params: { threadId: first.id, includeTurns: false } },
    { method: 'dsh/sessionHistory', params: { threadId: first.id } },
    { method: 'dsh/sessionHistory', params: { threadId: first.id, maxMessages: 25 } },
    { method: 'dsh/sessionHistory', params: { threadId: first.id, beforeSeq: 10, maxMessages: 25 } },
    { method: 'thread/resume', params: { threadId: first.id } },
    { method: 'thread/name/set', params: { threadId: first.id, name: '' } },
    { method: 'thread/read', params: { threadId: first.id, includeTurns: true } },
    { method: 'dsh/directoryList', params: { path: 'C:\\Workspace' } },
  ]) {
    const result = await call(probe.method, probe.params)
    const verdict = result.ok ? 'ok' : `${result.code}: ${result.message}`
    console.log(`  ${probe.method} ${JSON.stringify(probe.params).slice(0, 90)} → ${verdict}`)
  }
}

// The fields this release aligned with upstream, so a refusal here means the policy
// is still stricter than the App Server.
for (const probe of [
  { method: 'thread/list', params: { limit: 1, sectionId: null } },
  { method: 'model/list', params: {} },
  { method: 'account/read', params: { refreshToken: false } },
]) {
  const result = await call(probe.method, probe.params)
  console.log(`  ${probe.method} ${JSON.stringify(probe.params)} → ${result.ok ? 'ok' : `${result.code}: ${result.message}`}`)
}

// The history paths: our own endpoint is what the client labels "history load
// failed", and the legacy full-history read is what an older client still asks for.
if (first !== undefined) {
  for (const probe of [
    { method: 'dsh/sessionHistory', params: { threadId: first.id } },
    { method: 'thread/read', params: { threadId: first.id, includeTurns: true } },
    { method: 'thread/turns/list', params: { threadId: first.id, limit: 5 } },
  ]) {
    const result = await call(probe.method, probe.params)
    const shape = result.ok ? `ok (${Object.keys(result.value ?? {}).slice(0, 6).join(',')})` : `${result.code}: ${result.message}`
    console.log(`  ${probe.method} → ${shape}`)
  }
}

await domain.close()

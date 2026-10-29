/**
 * Scripted Remote behaviour tests: a headless Host instance and a headless Client instance, driven
 * through the plugin's own loopback control protocol.
 *
 * Every flow here used to be checked by hand - open the Remote card, pick the Host, browse its
 * workspaces, open one, flip the Host's "allow control" / "Codex" switch (or freeze its process to
 * imitate a real disconnection), then watch the header through the reconnect ladder. The card talks to
 * the plugin over `POST /ds-harness-remote/<endpoint>` (`control-route.ts`), and the plugin's own panel
 * is the only other client of that channel, so this drives exactly what a person clicks - and times the
 * reconnect stages far more precisely than an eye can.
 *
 * Usage (from the repository root):
 *   node --import tsx/esm scripts/remote-e2e.mts --list                 # every scenario, with speeds
 *   node --import tsx/esm scripts/remote-e2e.mts --login-host           # one-time Host authorization
 *   node --import tsx/esm scripts/remote-e2e.mts --fast                 # the quick half of the matrix
 *   node --import tsx/esm scripts/remote-e2e.mts control-off-codex:window
 *   node --import tsx/esm scripts/remote-e2e.mts --against=<id|name> browse-codex   # no switches needed
 *
 * Persistent DSH homes, so a one-time authorization survives:
 *   Host   %DSH_REMOTE_E2E_HOST%   (default C:\Workspace\.dsh-remote-e2e\host, port 63731)
 *   Client %DSH_REMOTE_E2E_CLIENT% (default C:\Workspace\.dsh-remote-client, port 63721)
 * The Host home needs one authorization (see --login-host); the Client home only needs the account it
 * already has. Nothing here sends credentials anywhere, and no token or key is written to the log.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'

/** The DSH checkout that runs the plugin; both instances are started from it. */
const DSH_CHECKOUT = process.env.DSH_CHECKOUT ?? 'C:\\Workspace\\deepseek-harness'
const HOST_HOME = process.env.DSH_REMOTE_E2E_HOST ?? 'C:\\Workspace\\.dsh-remote-e2e\\host'
const CLIENT_HOME = process.env.DSH_REMOTE_E2E_CLIENT ?? 'C:\\Workspace\\.dsh-remote-client'
const HOST_PORT = Number(process.env.DSH_REMOTE_E2E_HOST_PORT ?? 63731)
const CLIENT_PORT = Number(process.env.DSH_REMOTE_E2E_CLIENT_PORT ?? 63721)
const NODE = process.env.DSH_NODE ?? 'C:\\Program Files\\nodejs\\node.exe'
/** Run one side on a different dsh build: a published 
ode_modules/@deepseek-ai/dsh/lib/bin.js, or another checkout. */
const HOST_ENTRY = process.env.DSH_REMOTE_E2E_HOST_ENTRY
const CLIENT_ENTRY = process.env.DSH_REMOTE_E2E_CLIENT_ENTRY
/** The window the plugin promises in `client-runtime.ts`; the timing assertions are built on it. */
const WINDOW_MS = 10_000
/** The ladder the plugin promises after the window. */
const LADDER_MS = [5_000, 10_000, 20_000, 30_000, 30_000, 30_000, 30_000]
/** How long a frozen Host takes to be declared offline (Server tick 20s / timeout 45s). */
const FREEZE_DETECT_MS = 120_000

// -------------------------------------------------------------------------------------------- instances

/** One running DSH instance plus its authenticated control channel. */
interface Instance {
  readonly label: string
  readonly home: string
  readonly port: number
  /** This instance's own Remote device id, read from its status. */
  readonly deviceId: string
  /** Absolute path of the stdout capture; log assertions read it. */
  readonly logPath: string
  process: ChildProcess
  control<T = unknown>(endpoint: string, payload?: unknown): Promise<T>
  log(): string
  countLog(marker: string): number
  /** Per-file byte marks, so a scenario can dump exactly what it added (the two streams are separate files). */
  mark(): { out: number; err: number }
  since(mark: { out: number; err: number }): string
  stop(): void
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Byte cursors of the scenario that is running, so `countLog` answers about this scenario only.
 *
 * Set by the runner before each scenario and left in place after it, which is also what makes the dump on a
 * thrown scenario show exactly what that scenario added.
 */
let scenarioCursor: { out: number; err: number } | undefined

/**
 * Everything the two log files gained since a cursor, concatenated.
 *
 * The cursors are **byte** offsets (`sizeOf`), so the slicing has to be done on bytes as well: slicing a decoded
 * string by a byte offset lands too far right whenever the file holds multi-byte characters - and every line here
 * does, because identifiers are abbreviated with `…`. That skipped the first lines a scenario wrote, which is
 * exactly where "the quick window opened" is logged, so a scenario that had opened its window read as if it had
 * not.
 */
function sliceSince(mark: { out: number; err: number }, logPath: string, errPath: string): string {
  return [logPath, errPath]
    .map((file, index) => {
      try {
        return readFileSync(file).subarray(index === 0 ? mark.out : mark.err).toString('utf8')
      } catch {
        return ''
      }
    })
    .join('')
}

/** Current size of a log file, used as a cursor; 0 while it does not exist yet. */
function sizeOf(file: string): number {
  try {
    return Buffer.byteLength(readFileSync(file, 'utf8'))
  } catch {
    return 0
  }
}

/** Wait until a predicate holds; throws with the last observation when it does not. */
async function waitFor<T>(
  what: string,
  read: () => T | undefined | Promise<T | undefined>,
  timeoutMs: number,
  everyMs = 250,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: unknown
  for (;;) {
    const value = await read()
    if (value !== undefined) return value
    last = value
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}${last === undefined ? '' : ` (last: ${JSON.stringify(last)})`}`)
    }
    await sleep(everyMs)
  }
}

function get(port: number, path: string): Promise<{ status: number; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers: { host: `127.0.0.1:${port}` } }, res => {
      res.resume()
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }))
    })
    req.on('error', reject)
    req.end()
  })
}

/** POST the control envelope `control-route.ts` expects. */
function post(port: number, endpoint: string, payload: unknown, cookie: string): Promise<unknown> {
  const body = JSON.stringify({ type: 'client-request', rpcId: `e2e-${Date.now()}`, method: endpoint, payload })
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      path: `/ds-harness-remote/${endpoint}`,
      method: 'POST',
      headers: {
        host: `127.0.0.1:${port}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        cookie,
      },
    }, res => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { text += chunk })
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`${endpoint}: HTTP ${res.statusCode} ${text.slice(0, 200)}`))
        try {
          resolve(JSON.parse(text))
        } catch {
          reject(new Error(`${endpoint}: response was not JSON: ${text.slice(0, 200)}`))
        }
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

/** Start one instance, exchange its launch token for the signed cookie, and read its identity. */
async function startInstance(label: string, home: string, port: number, entry?: string): Promise<Instance> {
  if (!existsSync(home)) mkdirSync(home, { recursive: true })
  const logPath = join(home, 'instance.out.log')
  const errPath = join(home, 'instance.err.log')
  writeFileSync(logPath, '')
  writeFileSync(errPath, '')
  const out = openSync(logPath, 'a')
  const err = openSync(errPath, 'a')
  const env = { ...process.env }
  // The profile comes from argv alone; a stray DSH_PROFILE would decide it instead.
  for (const name of ['DSH_PROFILE', 'DSH_PROFILE_DIR', 'DSH_SESSION_ID', 'DSH_SHELL', 'DSH_WEB_URL']) delete env[name]
  // `entry` lets one side of the harness run a *different* dsh build than the other - a published release
  // (`node_modules/@deepseek-ai/dsh/lib/bin.js`) or another checkout - which is how the cross-version link
  // matrix asks "does a client on one dsh talk to a host on another". Tsx is only needed for a TypeScript
  // checkout; a published build is plain JavaScript.
  const args = entry === undefined
    ? ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web', '--port', String(port), '--host', '127.0.0.1', '--no-open']
    : [entry, 'web', '--port', String(port), '--host', '127.0.0.1', '--no-open']
  const child = spawn(NODE, args, { cwd: DSH_CHECKOUT, env: { ...env, DSH_HOME: home }, stdio: ['ignore', out, err], windowsHide: true })

  const readLog = (): string => {
    // Both streams: the plugin writes its `info` lines to stdout and its `warn`/`error` ones to stderr, and
    // the markers this suite asserts on - the quick window, the fallback, the ladder attempts - are warnings.
    let text = ''
    for (const file of [logPath, errPath]) {
      try {
        text += readFileSync(file, 'utf8')
      } catch {
        // Not written yet; the other stream still counts.
      }
    }
    return text
  }
  const url = await waitFor(`the ${label} launch URL`, () => {
    const match = /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/u.exec(readLog())
    return match?.[1]
  }, 90_000, 200)
  const token = new URL(url).searchParams.get('token')
  if (token === null) throw new Error(`${label}: the launch URL carried no token`)
  const index = await get(port, `/?token=${encodeURIComponent(token)}`)
  const setCookie = index.headers['set-cookie']
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';', 1)[0]
  if (cookie === undefined) throw new Error(`${label}: no session cookie (HTTP ${index.status})`)
  launchUrls.set(label, url)

  const instance: Instance = {
    label,
    home,
    port,
    logPath,
    process: child,
    deviceId: '',
    log: readLog,
    // Counting is always about *this* scenario. A whole-file count made a wait return instantly whenever an
    // earlier scenario had already produced the same line: `control-off-codex:giveup` then read the state of a
    // ladder that was still running, and reported "the header stops advertising a reconnect" as a product
    // failure. The runner advances this cursor before each scenario runs.
    countLog: marker => sliceSince(scenarioCursor ?? instance.mark(), logPath, errPath)
      .split('\n')
      .filter(line => line.includes(marker)).length,
    mark: () => ({ out: sizeOf(logPath), err: sizeOf(errPath) }),
    since: mark => sliceSince(mark, logPath, errPath),
    async control<T>(endpoint: string, payload: unknown = {}): Promise<T> {
      const response = await post(port, endpoint, payload, cookie) as {
        result?: { ok?: boolean; value?: unknown; error?: { code?: string; message?: string } }
      }
      const result = response.result
      if (result?.ok === true) return result.value as T
      throw new Error(`${label} ${endpoint}: ${result?.error?.code ?? 'unknown'} ${result?.error?.message ?? JSON.stringify(result)}`)
    },
    stop: () => {
      try {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      } catch {
        child.kill()
      }
    },
  }
  // The launch URL appears before the plugin finishes starting, and `status` reports no device until its
  // identity is loaded - wait for that rather than for the URL alone.
  const self = await waitFor(`${label} to report its Remote identity`, async () => {
    const value = await instance.control<{ deviceId?: string }>('status').catch(() => undefined)
    return typeof value?.deviceId === 'string' ? value : undefined
  }, 60_000, 500)
  return { ...instance, deviceId: self.deviceId as string }
}

/** The launch URL each instance printed, so a one-time authorization can be handed to a person. */
const launchUrls = new Map<string, string>()

/** The whole process tree of an instance, for freezing: a suspended DSH looks like a real outage. */
function treePids(pid: number): number[] {
  const out = spawnSync('powershell', [
    '-NoProfile', '-Command',
    `$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId;` +
    `$ids = @(${pid}); $grow = $true; while ($grow) { $grow = $false; foreach ($p in $all) {` +
    ` if ($ids -contains $p.ParentProcessId -and $ids -notcontains $p.ProcessId) { $ids += $p.ProcessId; $grow = $true } } };` +
    `$ids -join ','`,
  ], { encoding: 'utf8', windowsHide: true })
  return (out.stdout ?? '').trim().split(',').map(Number).filter(value => Number.isSafeInteger(value) && value > 0)
}

/**
 * Suspend or resume a process and its children.
 *
 * A frozen Host answers nothing while its TCP connections stay open: that is the silent outage the
 * quick window exists for, and it cannot be produced by flipping a switch (which drops the link at
 * once and cleanly). `NtSuspendProcess` is the only way to do it from a script on Windows.
 *
 * The loop variable is **not** `$pid`: PowerShell's `$PID` is a read-only automatic variable, so the loop failed
 * on every iteration and the "freeze" silently did nothing - the scenario then timed out waiting for an outage
 * that had never been produced, and the frozen process happily answered its own socket. Failures are thrown now,
 * because a freeze that did not happen must not look like an outage nobody noticed.
 * @param pids - the process tree to act on.
 * @param suspended - true to freeze, false to resume.
 */
function setSuspended(pids: number[], suspended: boolean): void {
  if (pids.length === 0) throw new Error('no process to freeze: the instance tree came back empty')
  const script = [
    'Add-Type -Namespace E2E -Name Native -MemberDefinition \'[DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr h);',
    '[DllImport("ntdll.dll")] public static extern int NtResumeProcess(IntPtr h);',
    '[DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(int a, bool i, int p);\'',
    `foreach ($target in @(${pids.join(',')})) {`,
    '  $h = [E2E.Native]::OpenProcess(0x1F0FFF, $false, $target);',
    '  if ($h -eq [IntPtr]::Zero) { Write-Error "OpenProcess failed for $target"; exit 2 }',
    `  $status = [E2E.Native]::${suspended ? 'NtSuspendProcess' : 'NtResumeProcess'}($h);`,
    '  if ($status -ne 0) { Write-Error "nt call failed for $target with $status"; exit 3 }',
    '}',
  ].join('\n')
  const out = spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true })
  if (out.status !== 0) {
    throw new Error(`could not ${suspended ? 'suspend' : 'resume'} ${pids.join(',')}: ${(out.stderr ?? '').trim() || `exit ${String(out.status)}`}`)
  }
}

// ------------------------------------------------------------------------------------------------- state

type SessionKind = 'harness' | 'codex'
/** What the run opens and then loses. */
interface SessionRef {
  kind: SessionKind
  workspaceId: string
  path: string
}

interface RemoteStatus {
  mode?: 'local' | 'remote'
  backend?: 'harness' | 'codex'
  connected?: boolean
  fellBackToLocal?: boolean
  connectedTargetDeviceId?: string
  reconnecting?: { targetDeviceId: string; phase: 'restore' | 'fast' | 'fallback'; kind?: string }
  workspaceSelection?: { targetDeviceId: string; workspaceId: string; backend?: string; workspacePath?: string }
}

interface Host {
  deviceId: string
  name?: string
  online?: boolean
  hostControl?: boolean
}

/** What every scenario is handed. */
interface Ctx {
  client: Instance
  host: Instance
  target: Host
  /** Stop and start the Client again; the remembered target has to survive it. */
  restartClient(): Promise<void>
  /** Start the Host again after it was killed; the Client's ladder has to find it. */
  restartHost(): Promise<void>
}

const failures: string[] = []
const threw: string[] = []
/** Scenarios whose failure the Client's own log blames on this machine's link to the Server. */
const limited: string[] = []
let checks = 0

/** The Client's log lines that mean the network, not the state machine, ended the attempt. */
const ENVIRONMENT_TROUBLE = /"code":"(CONNECTION_FAILED|SERVER_CREDENTIALS_BUSY|CONTROL_DISABLED|HOST_OFFLINE)"|This operation was aborted|Server rejected the connection|Adaptive control handshake timed out|AdaptiveTransport failed to connect/u

function check(label: string, ok: boolean, detail?: unknown): void {
  checks += 1
  if (ok) {
    process.stdout.write(`  ✓ ${label}\n`)
    return
  }
  failures.push(label)
  process.stdout.write(`  ✗ ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}\n`)
}

const status = (client: Instance): Promise<RemoteStatus> => client.control<RemoteStatus>('status')

/**
 * The same status read, but for use *inside* a poll.
 *
 * `status` reaches the peer for its transport details, so a link that is mid-drop makes the read itself
 * throw - and a poll that throws would abort the very assertion that is waiting for the drop to be noticed.
 * Tolerating it here is not a licence to pass: the poll still fails if the state never appears.
 */
const pollStatus = (client: Instance): Promise<RemoteStatus | undefined> => status(client).catch(() => undefined)

/** A status read outside a poll: the control channel is local, so a failure here is the Client's own. */
async function requireStatus(client: Instance): Promise<RemoteStatus> {
  const value = await pollStatus(client)
  if (value === undefined) throw new Error('the Client answered its control channel but not with a status')
  return value
}

/**
 * Put the Host's switches back, however a scenario ended: a failed case must not poison the next one.
 *
 * Only writes what is actually off. `settings.codex.set` restarts the Codex domain, and a restart lands on the
 * app-server that is still answering its first `account/read` - which closes it mid-read (`CODEX_CLOSED`) and
 * leaves the domain unavailable. Unconditionally re-asserting "Codex on" after every scenario did exactly that,
 * once per scenario, and the Codex half of the matrix then skipped itself for a cause the harness had created.
 */
async function restoreHostSwitches(ctx: Ctx): Promise<void> {
  await ctx.host.control('host.connection.set', { connected: true }).catch(() => undefined)
  const settings = await ctx.host.control<{ codex?: { enabled?: boolean } }>('settings.get').catch(() => undefined)
  if (settings !== undefined && settings.codex?.enabled !== true) {
    await ctx.host.control('settings.codex.set', { enabled: true }).catch(() => undefined)
  }
  setSuspended(treePids(ctx.host.process.pid as number), false)
  await ctx.client.control('mode.set', { mode: 'local', targetDeviceId: ctx.target.deviceId }).catch(() => undefined)
}

/** Wait until the Host is reachable again; the Server link on this machine is a proxy and does blip. */
async function waitForHostOnline(ctx: Ctx, budgetMs = 90_000): Promise<boolean> {
  const online = await waitFor('the Host to come back online', async () => {
    const devices = await ctx.client.control<Host[]>('devices').catch(() => [] as Host[])
    return devices.find(device => device.deviceId === ctx.target.deviceId)?.online === true ? true : undefined
  }, budgetMs, 2_000).catch(() => undefined)
  return online === true
}

/**
 * Why the Host cannot offer Codex right now, or undefined when it can.
 *
 * A Host's Codex has gates the state machine knows nothing about: the binary has to be there and the account
 * has to refresh. Skipping those scenarios with the Host's own code keeps the suite honest - a green run that
 * silently proved nothing would be worse than a skip.
 */
async function hostCodexRefusal(ctx: Ctx): Promise<string | undefined> {
  try {
    await ctx.client.control('codex.workspaces.list', { targetDeviceId: ctx.target.deviceId })
    return undefined
  } catch (error) {
    const message = String((error as Error).message ?? error)
    if (!/Codex|CodeX/u.test(message)) return undefined
    const code = /Codex Remote domain unavailable \{"code":"([A-Z_]+)"/u.exec(ctx.host.log())?.[1]
    return `${message}${code === undefined ? '' : ` [Host: ${code}]`}`
  }
}

/** Pick the Host the scenarios drive, by name fragment or id prefix. */
async function pickHost(client: Instance, deviceId: string, wanted?: string): Promise<Host> {
  const devices = await client.control<Host[]>('devices')
  const candidates = devices.filter(device => typeof device.deviceId === 'string')
  if (wanted !== undefined) {
    const found = candidates.find(device => device.deviceId.startsWith(wanted) || device.name?.includes(wanted))
    if (found === undefined) {
      const names = candidates.map(device => `${device.name ?? '?'}(${device.deviceId.slice(0, 8)})`).join(', ')
      throw new Error(`no Host matching ${wanted} among ${names}`)
    }
    return found
  }
  const found = candidates.find(device => device.deviceId === deviceId)
  if (found === undefined) throw new Error(`the Client cannot see the Host ${deviceId.slice(0, 8)}; is it authorized?`)
  return found
}

/**
 * Retry a call whose only job is to reach the Host.
 *
 * The Server path on this machine runs through a proxy and blips (`fetch failed`); the panel retries
 * too, and a phantom failure here would hide the real ones. Only reach-the-Host calls are wrapped - the
 * state-machine assertions must still see a genuine failure.
 */
async function withFlakeRetry<T>(what: string, run: () => Promise<T>): Promise<T> {
  let last: unknown
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await run()
    } catch (error) {
      last = error
      const message = String((error as Error).message ?? error)
      if (!/fetch failed|CONNECTION_FAILED|TRANSPORT_CLOSED|internal|timed out/u.test(message)) throw error
      process.stdout.write(`  · ${what}: transient (${message}); retrying\n`)
      await sleep(2_000)
    }
  }
  throw last
}

/** List the workspaces of one kind and open the first, as the panel does. */
async function openSession(client: Instance, target: Host, kind: SessionKind): Promise<SessionRef> {
  const endpoint = kind === 'harness' ? 'workspaces.list' : 'codex.workspaces.list'
  const listed = await withFlakeRetry(`${kind} workspaces`,
    async () => client.control<Array<{ workspaceId: string; path: string }>>(endpoint, { targetDeviceId: target.deviceId }))
  const first = Array.isArray(listed) ? listed[0] : undefined
  if (first === undefined) {
    throw new Error(kind === 'harness'
      ? 'the Host offers no DSH workspace to open'
      : 'the Host offers no Codex workspace; register one in its Codex settings first')
  }
  await withFlakeRetry(`${kind} workspace open`, async () => {
    if (kind === 'harness') await client.control('workspace.open', { targetDeviceId: target.deviceId, path: first.path })
    else await client.control('codex.workspace.open', { targetDeviceId: target.deviceId, workspaceId: first.workspaceId })
  })
  return { kind, workspaceId: first.workspaceId, path: first.path }
}

/** Leave the window clean: back to the local shell, nothing armed. */
async function closeSession(ctx: Ctx): Promise<void> {
  await ctx.client.control('mode.set', { mode: 'local', targetDeviceId: ctx.target.deviceId }).catch(() => undefined)
  await sleep(500)
}

/** The window must open, name the right session kind, and keep the carriers remote. */
/**
 * Wait for the quick window, reporting why it is taking so long.
 *
 * A frozen peer is noticed by the Server's heartbeat first (its pong stops) and only then by the client, so the
 * budget is minutes rather than seconds. When that budget runs out the interesting question is *who* missed it -
 * the Server never declaring the device offline, or the client not acting on the notice - so the wait prints the
 * device's own `online` flag as it polls: `online` false while no window is open means the Server knew and the
 * client did not act; `online` true throughout means the freeze was never detected at all.
 * @param ctx - the running instances.
 * @param ref - the session that should be restored.
 * @param budgetMs - how long to wait, and the only case where the progress line is printed.
 */
async function expectWindowOpen(ctx: Ctx, ref: SessionRef, budgetMs = 8_000): Promise<void> {
  let lastReport = 0
  const window = await waitFor('the quick window to open', async () => {
    const now = await pollStatus(ctx.client)
    if (now?.reconnecting?.phase === 'fast') return now
    if (budgetMs > 30_000 && Date.now() - lastReport > 10_000) {
      lastReport = Date.now()
      const list = await ctx.client.control<Array<{ deviceId?: string; online?: boolean }>>('devices').catch(() => undefined)
      const peer = list?.find(item => item.deviceId?.startsWith(ctx.host.deviceId.slice(0, 8)))
      // Two different misses produce the same "no window": the freeze never reached the process, or it did and
      // nobody noticed. A suspended process cannot answer its own loopback endpoint, so asking it settles which.
      const answers = await Promise.race([
        ctx.host.control('status').then(() => true).catch(() => true),
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), 1_500)),
      ])
      process.stdout.write(`    · waiting: the Host reads online=${String(peer?.online)} to this Client, and answers its own socket: ${String(answers)}\n`)
    }
    return undefined
  }, budgetMs)
  check(`the quick window opens (${ref.kind})`, true, window.reconnecting)
  check('the window names the session it is putting back', window.reconnecting?.kind === ref.kind, window.reconnecting)
  check('the window stands for the whole ten seconds, not one attempt', ctx.client.countLog('trying the quick window') > 0)
}

/** Apply one of the three ways a session can be lost. */
async function loseSession(ctx: Ctx, ref: SessionRef, trigger: 'control' | 'codex' | 'freeze', pids?: number[]): Promise<void> {
  if (trigger === 'control') {
    await ctx.host.control('host.connection.set', { connected: false })
    return
  }
  if (trigger === 'codex') {
    await ctx.host.control('settings.codex.set', { enabled: false })
    return
  }
  void ref
  setSuspended(pids ?? treePids(ctx.host.process.pid as number), true)
}

/** Undo it: the same call the user makes to switch it back on. */
async function restoreSession(ctx: Ctx, trigger: 'control' | 'codex' | 'freeze', pids?: number[]): Promise<void> {
  if (trigger === 'control') return void await ctx.host.control('host.connection.set', { connected: true })
  if (trigger === 'codex') return void await ctx.host.control('settings.codex.set', { enabled: true })
  setSuspended(pids ?? treePids(ctx.host.process.pid as number), false)
}

/** The session is back, on the same Host, the same kind and the same workspace. */
async function expectSessionBack(ctx: Ctx, ref: SessionRef, budgetMs: number): Promise<void> {
  const back = await waitFor(`the ${ref.kind} session to come back`, async () => {
    const now = await pollStatus(ctx.client)
    return now !== undefined && now.reconnecting === undefined && isSameSession(now, ref) ? now : undefined
  }, budgetMs, 500)
  check(`the same ${ref.kind} session is restored`, back.backend === ref.kind, back.backend)
  check('the recovery returns to the same workspace', isSameSession(back, ref), back.workspaceSelection)
}

/**
 * Whether the live session is the one a scenario opened.
 *
 * A Codex workspace is identified by its directory - the Host renumbers its ids, and the whole point of the
 * Codex target is that the directory is the identity. A DSH workspace is identified by the id the Host
 * reports, because its selection carries no path at all.
 */
function isSameSession(now: RemoteStatus, ref: SessionRef): boolean {
  if (now.backend !== ref.kind) return false
  const selection = now.workspaceSelection
  if (selection === undefined) return false
  return ref.kind === 'codex'
    ? selection.workspacePath === ref.path
    : selection.workspaceId === ref.workspaceId
}

// --------------------------------------------------------------------------------------------- scenarios

/** Browsing one kind of workspace is never a session, and never arms a reconnect. */
async function browse(ctx: Ctx, kind: SessionKind): Promise<void> {
  const endpoint = kind === 'harness' ? 'workspaces.list' : 'codex.workspaces.list'
  const listed = await withFlakeRetry(`${kind} workspaces`,
    async () => ctx.client.control<unknown[]>(endpoint, { targetDeviceId: ctx.target.deviceId }))
  check(`${kind}: the Host lists its workspaces`, Array.isArray(listed) && listed.length > 0, listed)
  const now = await pollStatus(ctx.client)
  check(`${kind}: browsing does not claim a remote session`, now?.connected !== true, now)
  check(`${kind}: browsing arms no reconnect`, now?.reconnecting === undefined, now?.reconnecting)
  check(`${kind}: browsing stays in the local shell`, now?.mode !== 'remote' || now?.backend === undefined, now?.mode)
}

/** Opening one kind of workspace makes it the session, and records it as the target. */
async function open(ctx: Ctx, kind: SessionKind): Promise<void> {
  const ref = await openSession(ctx.client, ctx.target, kind)
  const now = await pollStatus(ctx.client)
  check(`${kind}: opening a workspace switches to the Host`, now.mode === 'remote', now.mode)
  check(`${kind}: the session keeps the kind the user picked`, (now.backend ?? 'harness') === kind, now.backend)
  check(`${kind}: the selection is remembered`, now.workspaceSelection?.targetDeviceId === ctx.target.deviceId, now.workspaceSelection)
  await closeSession(ctx)
  void ref
}

/** The panel keeps working after its browse connection dies: it opens a new one instead of failing. */
async function browsingDeath(ctx: Ctx): Promise<void> {
  await ctx.client.control('workspaces.list', { targetDeviceId: ctx.target.deviceId })
  await ctx.host.control('host.connection.set', { connected: false })
  await waitFor('the browsing link to be dropped', () => (ctx.client.countLog('browsing connection closed') > 0 ? true : undefined), 30_000)
  await ctx.host.control('host.connection.set', { connected: true })
  await sleep(1_000)
  // The Host has just come back; the Server on this machine blips, and the panel would retry too.
  const listed = await withFlakeRetry('workspaces after the browse link died',
    async () => ctx.client.control<unknown[]>('workspaces.list', { targetDeviceId: ctx.target.deviceId }))
  check('the panel recovers by opening a new connection', Array.isArray(listed) && listed.length > 0, listed)
  const now = await pollStatus(ctx.client)
  check('a browse loss still arms no reconnect', now.reconnecting === undefined, now.reconnecting)
}

/** The control switch is the only thing that decides whether a device can be controlled. */
async function controlSwitchSemantics(ctx: Ctx): Promise<void> {
  const before = ctx.host.deviceId
  await ctx.host.control('host.connection.set', { connected: false })
  const off = await waitFor('the Host to show up as not accepting control', async () => {
    const devices = await ctx.client.control<Host[]>('devices')
    const self = devices.find(device => device.deviceId === before)
    return self !== undefined && self.online !== true ? self : undefined
  }, 30_000, 1_000)
  check('a Host with control off is still listed, not hidden', off.deviceId === before, off)
  const offline = await requireStatus(ctx.client)
  check('its identity is not rotated by the switch', offline.deviceId !== undefined)
  await ctx.host.control('host.connection.set', { connected: true })
  await waitFor('the Host to accept control again', async () => {
    const devices = await ctx.client.control<Host[]>('devices')
    return devices.find(device => device.deviceId === before)?.online === true ? true : undefined
  }, 30_000, 1_000)
  const after = await ctx.host.control<{ deviceId?: string }>('status')
  check('the same device comes back, with the same identity', after.deviceId === before, { before, after: after.deviceId })
}

// ----------------------------------------------------------------------------------- the loss matrix

type Trigger = 'control' | 'codex' | 'freeze'
type Outcome = 'window' | 'schedule' | 'giveup'

/**
 * One cell of the matrix: open a session, lose it one way, and check the stage it lands in.
 *
 * The three triggers are genuinely different paths - a switch drops the link cleanly at once, the Codex
 * switch leaves the link up and only removes the domain, and a frozen process is neither: the peer is
 * simply silent until the Server's heartbeat gives up on it.
 */
async function lossCase(ctx: Ctx, kind: SessionKind, trigger: Trigger, outcome: Outcome): Promise<void> {
  const ref = await openSession(ctx.client, ctx.target, kind)
  const now = await requireStatus(ctx.client)
  check(`${kind}: the session is live before the loss`, now.mode === 'remote', now.mode)
  const pids = trigger === 'freeze' ? treePids(ctx.host.process.pid as number) : undefined

  await loseSession(ctx, ref, trigger, pids)
  await expectWindowOpen(ctx, ref, trigger === 'freeze' ? FREEZE_DETECT_MS : 15_000)

  if (outcome === 'window') {
    // Bring it back at once: the window's first attempt happens the moment the loss is noticed, so a switch
    // that is still off there is refused (`CONTROL_DISABLED`) by design - the second attempt is the one that
    // can succeed, and it is five seconds later.
    await sleep(500)
    await restoreSession(ctx, trigger, pids)
    const res = await waitFor('the session to come back through the window', async () => {
      const value = await pollStatus(ctx.client)
      return value !== undefined && value.reconnecting === undefined && value.backend === kind ? value : undefined
    }, 45_000, 500)
    check('the view was never handed to the local shell', res.fellBackToLocal !== true, res.fellBackToLocal)
    check('the recovery happened inside the window', ctx.client.countLog('kept its view through a quick reconnect') > 0)
    await expectSessionBack(ctx, ref, 10_000)
  } else {
    // Outlive the window: the view goes local at about the tenth second, and the ladder takes over.
    const fallen = await waitFor('the local fallback at the end of the window', async () => {
      const value = await pollStatus(ctx.client)
      return value?.fellBackToLocal === true ? value : undefined
    }, WINDOW_MS + (trigger === 'freeze' ? 30_000 : 8_000))
    check('the fallback is a fallback, not a new session', fallen.backend !== kind || kind === 'harness', fallen.backend)
    check('the retry schedule is advertised', fallen.reconnecting?.phase === 'fallback', fallen.reconnecting)

    if (outcome === 'schedule') {
      // Restore after a couple of rungs so the ladder is provably the thing that recovered it.
      await sleep(LADDER_MS[0]! + 2_000)
      await restoreSession(ctx, trigger, pids)
      await expectSessionBack(ctx, ref, 120_000)
      check('the ladder is what put it back', /remote session recovered/u.test(ctx.client.log()))
      await sleep(1_000)
      const settled = await requireStatus(ctx.client)
      check('nothing is left reconnecting once it is back', settled.reconnecting === undefined, settled.reconnecting)
    } else {
      // Let the whole ladder run out: it must stop, clear the flag, and not keep trying.
      const gaveUp = await waitFor('the ladder to give up', () => {
        return ctx.client.countLog('recovery gave up') > 0 ? true : undefined
      }, 240_000, 1_000).catch(() => undefined)
      check('the ladder is bounded and says so', gaveUp === true)
      const stopped = await requireStatus(ctx.client)
      check('the header stops advertising a reconnect', stopped.reconnecting === undefined, stopped.reconnecting)
      const attemptsBefore = ctx.client.countLog('remote session recovery attempt failed')
      await restoreSession(ctx, trigger, pids)
      await sleep(60_000)
      check('it does not start a new ladder by itself', ctx.client.countLog('remote session recovery attempt failed') <= attemptsBefore + 1,
        { before: attemptsBefore, after: ctx.client.countLog('remote session recovery attempt failed') })
      check('the user is simply local', (await requireStatus(ctx.client)).mode !== 'remote')
    }
  }
  await closeSession(ctx)
}

/**
 * The negative cell: a DSH session with the Host's Codex switched off must not move at all. The Codex
 * domain is not what the user is looking at, and a loss there is not a loss of their session.
 */
async function codexOffHarnessSession(ctx: Ctx): Promise<void> {
  const ref = await openSession(ctx.client, ctx.target, 'harness')
  await ctx.host.control('settings.codex.set', { enabled: false })
  await sleep(3_000)
  const now = await requireStatus(ctx.client)
  check('a Codex switch does not move a DSH session', now.reconnecting === undefined, now.reconnecting)
  check('the DSH session stays on screen', now.mode === 'remote', now.mode)
  check('nothing was armed for later', now.fellBackToLocal !== true, now.fellBackToLocal)
  await ctx.host.control('settings.codex.set', { enabled: true })
  await expectSessionBack(ctx, ref, 30_000)
  await closeSession(ctx)
}

/** Cancelling the reconnect during the window must stop it for good. */
async function cancelDuringWindow(ctx: Ctx): Promise<void> {
  const ref = await openSession(ctx.client, ctx.target, 'codex')
  await ctx.host.control('settings.codex.set', { enabled: false })
  await expectWindowOpen(ctx, ref)
  await ctx.client.control('mode.set', { mode: 'local', targetDeviceId: ctx.target.deviceId })
  const attemptsBefore = ctx.client.countLog('remote session recovery attempt failed')
  await ctx.host.control('settings.codex.set', { enabled: true })
  await sleep(WINDOW_MS + 12_000)
  const now = await requireStatus(ctx.client)
  check('cancelling takes the window away', now.reconnecting === undefined, now.reconnecting)
  check('and the ladder does not start afterwards', ctx.client.countLog('remote session recovery attempt failed') <= attemptsBefore,
    { before: attemptsBefore, after: ctx.client.countLog('remote session recovery attempt failed') })
  check('the user is left in the local shell', now.mode !== 'remote', now.mode)
}

/** The remembered target has to survive a client restart, for both kinds. */
async function restartClientRestoresTarget(ctx: Ctx, kind: SessionKind): Promise<void> {
  const ref = await openSession(ctx.client, ctx.target, kind)
  await ctx.restartClient()
  const back = await waitFor(`the ${kind} session to be restored on start`, async () => {
    const now = await pollStatus(ctx.client)
    return now !== undefined && now.mode === 'remote' && isSameSession(now, ref) ? now : undefined
  }, 90_000, 500).catch(() => undefined)
  check(`${kind}: the restart restores the remembered workspace`, back !== undefined, ref)
  check(`${kind}: it is restored as the same kind`, (back?.backend ?? 'harness') === kind, back?.backend)
  await closeSession(ctx)
}

// ------------------------------------------------------------------------------------------------- suite

interface Scenario {
  name: string
  /** True when the scenario flips the Host's switches or freezes it, so it needs a Host we own. */
  toggles: boolean
  /** True when the scenario cannot run at all unless the Host offers Codex. */
  needsCodex: boolean
  /** 'slow' scenarios run a whole ladder, or wait out a heartbeat timeout. */
  speed: 'fast' | 'slow'
  run: (ctx: Ctx) => Promise<void>
}

const KINDS: SessionKind[] = ['harness', 'codex']

/**
 * Two instances of the same device identity, which is what a second Desktop on one DSH_HOME looks like.
 *
 * Before 0.5.4 the displaced instance treated `CONNECTION_REPLACED` as terminal and stopped reconnecting, so once the
 * winning instance went away the device stayed offline - a Desktop stayed offline for a day that way. The displaced
 * side now stands by and retries on a fixed interval, so it must take over here as soon as the winner stops.
 */
async function standbyTakeover(ctx: Ctx): Promise<void> {
  check('the original Host is online before the second instance starts', await waitForHostOnline(ctx, 90_000))
  // Same home, same device identity, different port: the Server keeps one host connection per identity, so this
  // instance displaces the original - exactly the collision that has no other way to be produced from a script.
  const second = await startInstance('standby host', HOST_HOME, HOST_PORT + 2, HOST_ENTRY)
  const stopSecond = async (): Promise<void> => {
    for (const pid of treePids(second.process.pid as number)) {
      try { process.kill(pid) } catch { /* already gone */ }
    }
    await new Promise(resolve => setTimeout(resolve, 1_000))
  }
  try {
    const displaced = await waitFor('the original Host to be displaced', async () => {
      const status = await ctx.host.control<{ host?: { error?: string } }>('status')
      return status?.host?.error === 'CONNECTION_REPLACED' ? true : undefined
    }, 90_000, 1_000).catch(() => undefined)
    check('the displaced instance reports CONNECTION_REPLACED', displaced === true)

    // The displaced side must still be trying. This is the regression: it used to log the collision and stop for good,
    // leaving nothing to take over once the winner was gone.
    await stopSecond()
    const backOnline = await waitForHostOnline(ctx, 90_000)
    check('the standby takes over once the other instance leaves', backOnline === true)
  } finally {
    await stopSecond()
  }
}
const scenarios: Scenario[] = [
  { name: 'standby-takeover', toggles: true, needsCodex: false, speed: 'slow', run: standbyTakeover },
  { name: 'browse-harness', toggles: false, needsCodex: false, speed: 'fast', run: ctx => browse(ctx, 'harness') },
  { name: 'browse-codex', toggles: false, needsCodex: true, speed: 'fast', run: ctx => browse(ctx, 'codex') },
  { name: 'open-harness', toggles: false, needsCodex: false, speed: 'fast', run: ctx => open(ctx, 'harness') },
  { name: 'open-codex', toggles: false, needsCodex: true, speed: 'fast', run: ctx => open(ctx, 'codex') },
  { name: 'restart-client-harness', toggles: false, needsCodex: false, speed: 'slow', run: ctx => restartClientRestoresTarget(ctx, 'harness') },
  { name: 'restart-client-codex', toggles: false, needsCodex: true, speed: 'slow', run: ctx => restartClientRestoresTarget(ctx, 'codex') },
  { name: 'browsing-death', toggles: true, needsCodex: false, speed: 'fast', run: browsingDeath },
  { name: 'control-switch-semantics', toggles: true, needsCodex: false, speed: 'fast', run: controlSwitchSemantics },
  { name: 'cancel-during-window', toggles: true, needsCodex: true, speed: 'fast', run: cancelDuringWindow },
  { name: 'codex-off-harness-session', toggles: true, needsCodex: true, speed: 'fast', run: codexOffHarnessSession },
]

for (const kind of KINDS) {
  for (const trigger of ['control', 'codex'] as const) {
    if (trigger === 'codex' && kind === 'harness') continue
    for (const outcome of ['window', 'schedule', 'giveup'] as const) {
      scenarios.push({
        name: `${trigger}-off-${kind}:${outcome}`,
        toggles: true,
        needsCodex: kind === 'codex' || trigger === 'codex',
        speed: outcome === 'window' ? 'fast' : 'slow',
        run: ctx => lossCase(ctx, kind, trigger, outcome),
      })
    }
  }
  // A frozen Host is the silent outage: no switch does this, and it takes the Server's heartbeat to notice.
  scenarios.push({
    name: `freeze-${kind}:schedule`,
    toggles: true,
    needsCodex: kind === 'codex',
    speed: 'slow',
    run: ctx => lossCase(ctx, kind, 'freeze', 'schedule'),
  })
}

// ------------------------------------------------------------------------------------------------- main

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const only = args.filter(arg => !arg.startsWith('--'))
  const keep = args.includes('--keep')
  const fast = args.includes('--fast')
  const against = args.find(arg => arg.startsWith('--against='))?.slice('--against='.length)
  const loginHost = args.includes('--login-host')

  process.stdout.write(`Host home   ${HOST_HOME}\nClient home ${CLIENT_HOME}\n\n`)
  if (args.includes('--list')) {
    for (const scenario of scenarios) {
      process.stdout.write(`  ${scenario.name.padEnd(30)} ${scenario.speed}${scenario.toggles ? '  (needs our own Host)' : ''}\n`)
    }
    return
  }

  let host = await startInstance('host', HOST_HOME, HOST_PORT, HOST_ENTRY)
  let client = await startInstance('client', CLIENT_HOME, CLIENT_PORT, CLIENT_ENTRY)
  const ctx: Ctx = {
    client,
    host,
    target: { deviceId: host.deviceId },
    async restartClient() {
      client.stop()
      await sleep(2_000)
      client = await startInstance('client', CLIENT_HOME, CLIENT_PORT, CLIENT_ENTRY)
      ctx.client = client
    },
    async restartHost() {
      host.stop()
      await sleep(2_000)
      host = await startInstance('host', HOST_HOME, HOST_PORT, HOST_ENTRY)
      ctx.host = host
    },
  }

  try {
    // Authorization is a one-time human step; without it the Host never reaches the Server and every
    // scenario would fail with an unrelated error. `--against` drives somebody else's Host, so it does
    // not need ours at all.
    const online = against !== undefined ? true : await waitFor('the Host to appear online in the Client\'s device list', async () => {
      const devices = await ctx.client.control<Host[]>('devices').catch(() => [] as Host[])
      return devices.find(device => device.deviceId === host.deviceId)?.online === true ? true : undefined
    }, 360_000, 2_000).catch(() => undefined)
    let hostOnline = online === true
    if (!hostOnline && against === undefined) {
      // An earlier run that failed mid-scenario can leave the Host switched off, and a switched-off Host is
      // refused by the Server (`CONTROL_DISABLED`) - which looks exactly like "not authorized". Ask it to
      // accept control once before sending anyone to a browser.
      process.stdout.write('The Host is not online; asking it to accept control…\n')
      await host.control('host.connection.set', { connected: true }).catch(() => undefined)
      hostOnline = await waitForHostOnline(ctx, 360_000)
    }
    if (!hostOnline) {
      const url = launchUrls.get('host')
      process.stdout.write([
        '',
        `The headless Host (${host.deviceId.slice(0, 8)}) is not online on the Server yet.`,
        'Authorize it once, with the same account the Client uses:',
        '',
        `  1. open   ${url ?? '<see instance.out.log>'}`,
        '  2. sign in, and authorize this Host',
        '  3. keep "Allow other users to control this device" on',
        '  4. run this script again — the authorization is stored in the Host home from then on',
        '',
      ].join('\n'))
      if (!loginHost) return
      process.stdout.write('Waiting for the authorization (up to ten minutes)…\n')
      let polls = 0
      const authorized = await waitFor('the Host to come online after authorizing', async () => {
        polls += 1
        if (polls % 10 === 0) process.stdout.write(`  … still waiting (${polls * 3}s)\n`)
        const devices = await ctx.client.control<Host[]>('devices').catch(() => [] as Host[])
        return devices.find(device => device.deviceId === host.deviceId)?.online === true ? true : undefined
      }, 600_000, 3_000).catch(() => undefined)
      if (authorized !== true) {
        process.stdout.write('\nStill not online. Check the panel, then run --login-host again.\n')
        return
      }
      process.stdout.write('\nAuthorized. The Host home keeps it; drop --login-host from now on.\n')
      if (only.length === 0) return
    }
    process.stdout.write(`Driving ${host.deviceId.slice(0, 8)} as the Host\n`)

    // Codex is off by default (2026-10-14), and a switched-off domain answers `settings.get` with `enabled: false`
    // — which the Codex half of the matrix reads as "this Host cannot offer Codex" and skips. Switch it on first,
    // through the same guarded helper each scenario's `finally` uses (it only writes what is actually off, so it
    // never restarts a domain that is already starting up), and then **wait for the domain**: `settings.codex.set`
    // launches `codex app-server` in the background, and the first Codex scenario would otherwise race that launch
    // and skip itself for a reason the harness had just created.
    await restoreHostSwitches(ctx)
    const codex = await waitFor('the Host to offer Codex after switching it on', async () => {
      const view = await ctx.host.control<{ codexStatus?: { state?: string } }>('settings.get').catch(() => undefined)
      const state = view?.codexStatus?.state
      if (state === 'ready') return true
      // A domain that cannot run at all - no binary, account refused - is not something to wait for.
      return state === 'unavailable' || state === 'disabled' ? false : undefined
    }, 150_000, 2_000).catch(() => undefined)
    process.stdout.write(codex === true
      ? 'Codex is available on the Host\n'
      : 'Codex is not available on the Host; its scenarios will report why\n')

    // The Client home remembers the target of the previous run, so it comes up mid-restore (`phase: 'restore'`)
    // and the first scenario would be racing it - which makes results depend on what ran last. Each scenario
    // states its own preconditions, so the run starts from the plain local shell.
    await ctx.client.control('mode.set', { mode: 'local', targetDeviceId: ctx.target.deviceId }).catch(() => undefined)
    const settled = await waitFor('the Client to settle into its own shell', async () => {
      const now = await pollStatus(ctx.client)
      return now !== undefined && now.reconnecting === undefined ? true : undefined
    }, 30_000, 500).catch(() => undefined)
    process.stdout.write(settled === true ? 'The Client starts from the local shell\n' : 'The Client never settled; results may be noisy\n')

    const selected = scenarios
      .filter(scenario => (only.length === 0 || only.includes(scenario.name)))
      .filter(scenario => !(fast && scenario.speed === 'slow'))
      .filter(scenario => !(against !== undefined && scenario.toggles))
    if (selected.length === 0) throw new Error(`nothing selected; known: ${scenarios.map(item => item.name).join(', ')}`)
    if (against !== undefined) {
      ctx.target = await pickHost(ctx.client, '', against)
      process.stdout.write(`Driving ${ctx.target.name ?? '?'} (${ctx.target.deviceId.slice(0, 8)}) — its switches are not ours to flip\n`)
    }

    const started = Date.now()
    for (const scenario of selected) {
      process.stdout.write(`\n${scenario.name}\n`)
      const cursor = ctx.client.mark()
      scenarioCursor = cursor
      try {
        // The Server link on this machine is a proxy and does blip; a Host that is merely reconnecting must
        // not be reported as a scenario failure, but it must not be papered over either - say it out loud.
        if (scenario.toggles && !await waitForHostOnline(ctx)) {
          process.stdout.write('  · the Host never came back online; the scenario was not run\n')
          threw.push(`${scenario.name}: the Host stayed offline`)
          continue
        }
        if (scenario.needsCodex) {
          // A Host whose Codex is unavailable (no binary, account refused) cannot run these at all.
          const refusal = await hostCodexRefusal(ctx)
          if (refusal !== undefined) {
            limited.push(`${scenario.name}: the Host cannot offer Codex — ${refusal}`)
            process.stdout.write(`  · skipped: the Host cannot offer Codex — ${refusal}\n`)
            continue
          }
        }
        await scenario.run(ctx)
      } catch (error) {
        const added = ctx.client.since(cursor).split('\n').filter(line => line.includes('[dsh-remote]'))
        // This suite drives a real self-hosted Server through whatever network the machine has, and a real Codex
        // on the Host's side, which has its own gates (the binary, the account). When the failure is one of
        // those - not the state machine - say so instead of reporting a product failure a healthy Host would
        // not have produced.
        const hostCodex = /Codex Remote domain unavailable \{"code":"([A-Z_]+)"/u.exec(ctx.host.log())?.[1]
        const environment = ENVIRONMENT_TROUBLE.exec(added.join('\n'))?.[1]
          ?? (/Codex is switched off or unavailable|does not provide CodeX workspaces|CODEX_UNAVAILABLE/u.test(String(error))
            ? `the Host cannot offer Codex (${hostCodex ?? 'CODEX_DISABLED'})`
            : undefined)
        if (environment !== undefined) {
          limited.push(`${scenario.name}: ${environment}`)
          process.stdout.write(`  · environment: ${environment}\n${added.map(line => `    ${line}`).join('\n')}\n`)
        } else {
          threw.push(`${scenario.name}: ${String(error)}`)
          process.stdout.write(`  ✗ ${scenario.name} threw: ${String(error)}\n`)
          if (added.length > 0) process.stdout.write(`  client log:\n${added.map(line => `    ${line}`).join('\n')}\n`)
        }
      } finally {
        // However the scenario ended, the next one needs a Host that accepts control and offers Codex.
        if (scenario.toggles) await restoreHostSwitches(ctx)
      }
    }
    process.stdout.write(`\n${selected.length} scenarios in ${Math.round((Date.now() - started) / 1000)}s\n`)
  } finally {
    if (keep) {
      process.stdout.write(`\nKept running: host pid ${ctx.host.process.pid} (:${HOST_PORT}), client pid ${ctx.client.process.pid} (:${CLIENT_PORT})\n`)
    } else {
      ctx.client.stop()
      ctx.host.stop()
    }
  }

  process.stdout.write(`${checks - failures.length}/${checks} checks passed\n`)
  for (const error of threw) process.stdout.write(`  ! ${error}\n`)
  for (const failure of failures) process.stdout.write(`  - ${failure}\n`)
  for (const item of limited) process.stdout.write(`  ~ environment-limited: ${item}\n`)
  // Environment-limited scenarios are reported but do not fail the run: their attempts were ended by this
  // machine's link to the Server, which no state machine can be blamed for.
  if (failures.length > 0 || threw.length > 0) process.exitCode = 1
}

await main()

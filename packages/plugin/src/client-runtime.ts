import { connectionFailureDetail } from './server-connection.js'
import { LoopbackPreview } from './loopback-preview.js'
import type { ApiProxy, RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { CodexAppCapabilityData, CodexAppFrameData, CodexAppStreamClosedData } from '@dsh-remote/protocol'
import { CodexRemoteClient, RemoteClientCore } from '@dsh-remote/client-core'
import {
  AdaptiveTransport,
  stunOnlyIceServers,
  type RtcConnectionDiagnostics,
  type RtcIceServer,
  type RtcPeerConnectionFactory,
} from '@dsh-remote/webrtc'
import { ApiProxySwitch, type HarnessMode } from './api-proxy-switch.js'
import { ClientSecureTransport } from './client-secure-transport.js'
import { ClientTargetStore } from './client-target-store.js'
import type { ResolvedCodexConfig, ResolvedConfig } from './config.js'
import { registerControlRoute, type HostWebServerLike } from './control-route.js'
import type { HostIdentity, IdentityStore, TrustedPeer } from './identity-store.js'
import type { TypertGatewayLike } from './typert-gateway-contract.js'
import { uuidV7 } from './ids.js'
import type { SafeLogger } from './logging.js'
import { harnessSessionGeneration } from './harness-version.js'
import { RemoteHarnessApiProxy } from './remote-api-proxy.js'
import { RemoteTypertGateway } from './remote-typert-gateway.js'
import {
  codexProjectWorkspaceId,
  CodexVirtualHarness,
  discoverCodexVirtualWorkspaces,
  sameWorkspaceRoot,
  type CodexSessionLossTrigger,
  type CodexVirtualWorkspaceView,
} from './codex/virtual-harness.js'
import {
  ClientServerApi,
  ServerApiError,
  type AuthorizedPeerDevice,
  type OAuthProvider,
  type ServerHostDevice,
} from './server-api.js'
import { TypertGatewaySwitch } from './typert-gateway-switch.js'
import type { RemoteFileViewerEndpoint } from './file-viewer-contract.js'
import { loadNodeRtcFactory, type WeriftFactoryOptions } from './werift-rtc.js'
import { safeErrorCode } from './safe-error.js'

interface ConnectedRemote {
  client: RemoteClientCore
  target: TrustedPeer
  transport: AdaptiveTransport
  features: RemoteHostFeatures
  progressRunId: number
  clientVersion?: string
  harnessVersion?: string
}

export interface RemoteHostFeatures {
  commandList: boolean
  fileViewer: boolean
  terminal: boolean
  apiProxy: boolean
  remoteGateway: boolean
  sessionFormat?: 3
  codex: boolean
}

interface CodexLoopbackStream {
  target: { kind: 'remote'; client: RemoteClientCore } | { kind: 'local' }
  frames: Array<{ method: string; params: unknown }>
  closed?: string
  unsubscribe: () => void
  close: () => Promise<void>
  wake: () => void
}

const REMOTE_COMMAND_LIST_MIN_VERSION = [0, 3, 16] as const
const REMOTE_FILE_VIEWER_MIN_VERSION = [0, 3, 17] as const
const DIRECT_WEBRTC_NEGOTIATE_TIMEOUT_MS = 12_000
const DIRECT_LAN_PROGRESS_DISPLAY_MS = 1_400
export const HOST_AUTHORIZATION_ERRORS = new Set([
  'ACCOUNT_AUTH_REQUIRED',
  'AUTH_INVALID',
  'DEVICE_OWNERSHIP_REQUIRED',
  'DEVICE_REVOKED',
  'TOKEN_EXPIRED',
])

/** What noticed that the remote Codex session is gone; logged so "the banner did not show up" is answerable. */
type RemoteCodexLossTrigger = CodexSessionLossTrigger | 'capability-missing' | 'list-failed' | 'project-create-failed'

type TransportAttempt = 'direct' | 'turn' | 'relay'

interface ConnectionProgressState {
  runId: number
  targetDeviceId: string
  phase: 'checking-host' | 'authorizing-peer' | 'probing' | 'connected'
  activeTransports?: Array<'lan' | 'p2p' | 'turn' | 'relay'>
}

export interface RemoteDirectoryEntry {
  name: string
  path: string
  hidden: boolean
}

export interface RemoteDirectoryListing {
  path: string
  home: string
  crumbs: RemoteDirectoryEntry[]
  entries: RemoteDirectoryEntry[]
  truncated: boolean
}

export interface RemoteWorkspaceView {
  workspaceId: string
  path: string
  title: string
}

interface RemoteWorkspaceSelection {
  targetDeviceId: string
  workspaceId: string
  backend?: 'harness' | 'codex'
  sessionId?: string
  /**
   * The workspace root this selection was made on.
   *
   * A Codex domain that gets replaced hands out new project ids for the same directories, so the id alone cannot
   * recognise the workspace after a reconnect; the root path can.
   */
  workspacePath?: string
}

type HarnessRemoteTransport = 'remoteGateway' | 'apiProxy'

/** Which of a Host's two carriers the user is watching. */
export type RemoteSessionKind = 'harness' | 'codex'

/**
 * The session a recovery has to put back.
 *
 * A device plus a kind plus a workspace directory: everything else (project id, session id, carrier) is
 * re-derived on the way back, because a Host that replaced its Codex domain renumbers all of it.
 */
export interface RemoteSessionTarget {
  deviceId: string
  kind: RemoteSessionKind
  workspaceId: string
  workspacePath?: string
  sessionId?: string
}

/** Why a remote session is being recovered. Logged as-is; never shown to the user as a reason. */
export type RemoteSessionLossReason = 'transport-closed' | 'link-dropped' | 'codex-closed' | 'manual'

export interface RemoteDeviceView {
  deviceId: string
  name: string
  platform: string
  membershipId: string
  online: boolean
  lastSeenAt?: number
  clientVersion?: string
  harnessVersion?: string
}

export interface HostConnectionRpc {
  handle(
    channel: string,
    handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<RpcResult<unknown>>,
    options: { authority: 'loopback' | 'trusted-host' },
  ): () => Promise<void>
}

export interface HostConnectionHandle {
  requestRejection?(request: { headers: Record<string, string | string[] | undefined> }): number | undefined
  rpc: HostConnectionRpc
}

export interface HostAuthorizationControl {
  setTerminalEnabled?(enabled: boolean): void
  setLoopbackPorts?(ports: readonly number[]): void
  hostStatus(): {
    deviceId?: string
    configured: boolean
    online: boolean
    reconnecting: boolean
    lastActiveAt?: number
    error?: string
    account?: string
    authorized: boolean
    accountRequired: boolean
    /** Whether the user asked this machine to stay unreachable while signed in. */
    paused?: boolean
    connectedClients?: Array<{
      deviceId: string
      name: string
      platform?: string
      mode?: 'LAN' | 'P2P' | 'TURN' | 'Relay'
    }>
  }
  hasStoredAuthorization?(): Promise<boolean>
  /** Record, on the Server, whether this machine accepts control. */
  setHostControl?(enabled: boolean): Promise<void>
  /** Re-read this device's credentials from disk after a sign-in. */
  reloadCredentials?(): void
  reconnectHost(): void
  /** Stop being reachable without releasing the authorization. */
  pauseHostConnection?(): Promise<void>
  /** Resume with the same credentials and device identity. */
  resumeHostConnection?(): Promise<void>
  clearHostAuthorization(): Promise<void>
  localHarnessVersion?(): string | undefined
  authorizeHostWithAccount(email: string, password: string): Promise<unknown>
  authorizeHostWithCode(code: string): Promise<unknown>
  codexStatus?(): { available: boolean; enabled?: boolean; state?: string; error?: string }
  /** Restart the Codex connection with a new configuration, without restarting DSH. */
  restartCodex?(config: ResolvedCodexConfig): Promise<void>
  codexCall?(input: unknown, signal?: AbortSignal): Promise<unknown>
  codexRespond?(input: unknown, signal?: AbortSignal): Promise<{ resolved: true }>
  codexOpenStream?(
    input: unknown,
    publish: (
      event: 'codex.app.frame' | 'codex.app.stream.closed' | 'codex.app.capability',
      data: CodexAppFrameData | CodexAppStreamClosedData | CodexAppCapabilityData,
    ) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<unknown>
  codexCloseStream?(input: unknown): Promise<unknown>
}

/**
 * Failures a retry loop cannot resolve on its own.
 *
 * The Account authorization has to be redone by the user, so retrying only burns attempts and
 * would keep a boot restore alive forever on a device that is no longer signed in.
 */
const CREDENTIAL_FAILURE_CODES = new Set([
  'AUTH_REQUIRED',
  'ACCOUNT_AUTH_REQUIRED',
  'AUTH_INVALID',
  'TOKEN_EXPIRED',
  'DEVICE_NOT_FOUND',
  'DEVICE_REVOKED',
  'MEMBERSHIP_REQUIRED',
])


/**
 * One quick reconnect window: at most this many attempts inside this many milliseconds.
 *
 * Both triggers funnel here - the Server reporting that a link is gone, and discovering that our own
 * connection died (a write that gets RST, about a second after the Server times us out). A Host that is
 * merely busy answers late rather than never, so nothing outside this window is treated as a dead peer:
 * the session keeps its view, its Workspace and its Session list while the link is rebuilt.
 */
const QUICK_RECONNECT_ATTEMPTS = 2
const QUICK_RECONNECT_WINDOW_MS = 10_000
const QUICK_RECONNECT_RETRY_DELAY_MS = 5_000
/** The quick window skips the WebRTC ladder: relay is the only path measured under five seconds. */
const QUICK_RECONNECT_FORCE_RELAY = true
/**
 * The background ladder that runs once the quick window is spent.
 *
 * Five seconds after the fallback, then 10, 20, and a steady 30 for the rest: seven attempts in total, after
 * which the loop stops and the user stays in the local shell until they act. Both the disconnect recovery and
 * a boot restore share it - only the first rung differs, because a boot has no quick window behind it.
 */
const BACKGROUND_RETRY_DELAYS_MS: readonly number[] = [5_000, 10_000, 20_000, 30_000, 30_000, 30_000, 30_000]





export class ClientModeRuntime {
  private preview?: LoopbackPreview
  private identity?: HostIdentity
  private connected?: ConnectedRemote
  /**
   * The connection the Remote panel browses a Host with.
   *
   * Deliberately separate from {@link connected}: opening the panel, connecting to a Host and looking at or
   * picking its workspaces is *not* a remote session. Nothing here may become "what the user is watching",
   * arm a reconnect, or survive as something a later boot would restore - the user is still in the local
   * shell until they actually open a workspace. Keeping it in this field is what enforces that: the recovery
   * path only ever looks at {@link connected}.
   */
  private browsing?: ConnectedRemote
  /**
   * Set when a remote session dropped and the runtime fell back to local.
   *
   * The mode then reads 'local', which is what every "return to local" control is
   * gated on, so without this the user is left in a stale remote view with no way
   * back except signing out.
   */
  private fellBackToLocal = false
  /**
   * Identifies the live reconnect loop.
   *
   * A dropped transport starts one; anything else that settles the connection —
   * the user returning to local, a logout, a fresh connect — bumps it so the loop
   * stops instead of fighting the newer decision.
   */
  private remoteReconnectRun = 0
  private pendingWorkspaceSelection?: RemoteWorkspaceSelection
  /**
   * Transport a running fast reconnect is replacing.
   *
   * The rebuild opens its own control connection and the Server closes the older one for the same
   * device, so that close belongs to our own replacement. Reading it as a lost peer is what made the
   * fast level escalate itself into the fallback before it could ever succeed.
   */
  private supersededClient?: RemoteClientCore
  /**
   * The last workspace the user opened for a Host.
   *
   * Kept so a reconnect can republish it: re-selecting the workspace is what makes the native UI
   * re-read its session list, and without it a list poisoned by the outage stays wrong even after
   * the link is back.
   */
  private lastWorkspaceSelection?: RemoteWorkspaceSelection
  /**
   * The last workspaces listed per Host.
   *
   * A workspace picked in the panel is opened by id, and a replaced Codex domain hands out new ids for the same
   * directories. Keeping the previous listing is what lets a stale id be translated back to its root and opened
   * again instead of failing as "no longer available".
   */
  private readonly lastCodexListing = new Map<string, CodexVirtualWorkspaceView[]>()
  /**
   * Every workspace id this client has seen for a Host, mapped to its root.
   *
   * A panel entry can come from a listing made before the Host replaced its Codex domain, so the id is missing from
   * the latest listing while the directory itself is unchanged. Keeping the whole history is what lets such an id be
   * translated back to a root and reopened.
   */
  private readonly codexWorkspaceRoots = new Map<string, string>()
  /**
   * Hosts this run has actually opened a Codex workspace on.
   *
   * Whether the peer merely never offered Codex or has just switched it off decides the wording the user sees, and
   * the remembered selection cannot answer that on its own: switching to local clears it by design.
   */
  private readonly codexHostsSeen = new Set<string>()
  private codexVirtual?: CodexVirtualHarness
  private readonly proxySwitch?: ApiProxySwitch
  private readonly gatewaySwitch: TypertGatewaySwitch
  private readonly codexStreams = new Map<string, CodexLoopbackStream>()
  private connectionProgress?: ConnectionProgressState
  private connectionProgressRun = 0
  /**
   * Host a boot is trying to restore, reported to the UI while the retry loop runs.
   *
   * Nothing is connected yet, so without this the window would show the local shell while the
   * user is still looking at the remote workspace they left.
   */
  /**
   * Recovery in progress, and which kind.
   *
   * `restore` is a start that is reconnecting to the recorded target, `fast` keeps the session on
   * screen while its link is rebuilt, and `fallback` is the last resort that returns the user to
   * the local shell. The UI shows all three, so a reconnect is never invisible, and the retry loop
   * stops as soon as the user asks for local.
   */
  private reconnecting?: { targetDeviceId: string; targetName?: string; phase: 'restore' | 'fast' | 'fallback' }
  /**
   * What the recovery is putting back, for the header.
   *
   * The window has to be able to say *which* session is coming back while the carriers are already local - a
   * Codex recovery that fell back to the local shell used to read "remote DSH, reconnecting", which describes
   * a different thing than the one being restored. The kind comes from the remembered selection, so it stays
   * right for the whole window without a second copy of the state to keep in sync.
   * @returns the payload the status carries for a running recovery.
   */
  private reconnectState(): { targetDeviceId: string; targetName?: string; phase: 'restore' | 'fast' | 'fallback'; kind?: RemoteSessionKind } {
    const state = this.reconnecting
    if (state === undefined) return { targetDeviceId: '', phase: 'restore' }
    const kind = this.sessionTargetFor(state.targetDeviceId)?.kind
    return { ...state, ...(kind === undefined ? {} : { kind }) }
  }
  /** Periodic proof of life for the live remote session; absent while nothing is connected. */
  private closed = false

  constructor(
    private readonly config: ResolvedConfig,
    private readonly identities: IdentityStore,
    private readonly server: ClientServerApi,
    apiProxy: ApiProxy | undefined,
    typertGateway: TypertGatewayLike,
    private readonly logger: SafeLogger,
    private readonly host?: HostAuthorizationControl,
    private readonly rtcFactoryProvider: (options?: WeriftFactoryOptions) => Promise<RtcPeerConnectionFactory | undefined> = loadNodeRtcFactory,
    private readonly targetStore?: ClientTargetStore,
  ) {
    this.proxySwitch = apiProxy === undefined ? undefined : new ApiProxySwitch(apiProxy)
    this.gatewaySwitch = new TypertGatewaySwitch(typertGateway)
    // Serve the local shell while no peer session is live. Otherwise a remote-mode
    // boot routes its own local services at a peer that may not be there, and the
    // shell never finishes activating.
    this.gatewaySwitch.setRemoteAvailability(() => this.connected !== undefined)
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error('client remote-mode runtime is closed')
    this.identity = await this.identities.loadOrCreate(this.config.deviceName)
    this.server.bindIdentity(this.identity)
    this.proxySwitch?.install()
    this.gatewaySwitch.install()
    this.logger.info('client remote-mode identity ready', {
      deviceId: shortId(this.identity.deviceId),
      fingerprint: this.identity.fingerprint,
    })
    // A previously authorized Client should make the local Host controllable
    // on startup as well. Do not register an anonymous Client just to probe:
    // only persisted Client credentials opt into this default.
    if (this.config.hostControl?.enabled !== false
      && this.host !== undefined
      && this.server.hasStoredAuthorization !== undefined) {
      try {
        if (await this.server.hasStoredAuthorization()
          && (this.host.hasStoredAuthorization === undefined || !await this.host.hasStoredAuthorization())) {
          // One identity, one registration: signing in registers this device as a host too, so there is no
          // separate "owned role" to authorize here. The Host connection starts on its own unless paused.
          this.logger.info('Host credentials are present; the Host connection starts on its own')
        }
      } catch (error) {
        this.logger.warn('automatic Host authorization failed', { code: safeErrorCode(error) })
      }
    }
  }

  /**
   * Whether this installation already holds stored Server credentials for its
   * Client identity.
   *
   * This is the local answer to "is this installation signed in", available
   * without contacting the Server, so the UI can choose its panel immediately
   * instead of inferring the answer from a failed network round trip.
   */
  async hasStoredAuthorization(): Promise<boolean> {
    return this.server.hasStoredAuthorization === undefined
      ? false
      : await this.server.hasStoredAuthorization()
  }

  registerControl(connection: HostConnectionHandle, webServer?: HostWebServerLike): () => Promise<void> {
    return registerControlRoute(connection, (endpoint, payload, signal) => this.handleControl(endpoint, payload, signal), webServer)
  }

  status(): Record<string, unknown> {
    const targetStatus = this.gatewaySwitch.supportsCarrier()
      ? this.gatewaySwitch.status()
      : this.proxySwitch?.status() ?? this.gatewaySwitch.status()
    return {
      available: this.config.serverUrl !== undefined,
      identityReady: this.identity !== undefined,
      deviceId: this.identity?.deviceId,
      deviceName: this.identity?.name,
      serverUrl: this.config.serverUrl,
      ...targetStatus,
      connected: this.connected !== undefined,
      fellBackToLocal: this.fellBackToLocal,
      ...(this.reconnecting === undefined ? {} : { reconnecting: this.reconnectState() }),
      transport: this.connected?.client.getStats().mode ?? 'Disconnected',
      connectedTargetDeviceId: this.connected?.target.deviceId,
      preferredTransports: this.config.forceRelay ? ['relay'] : ['lan', 'p2p', 'turn', 'relay'],
      ...(this.connectionProgress === undefined ? {} : {
        connectionProgress: {
          targetDeviceId: this.connectionProgress.targetDeviceId,
          phase: this.connectionProgress.phase,
          ...(this.connectionProgress.activeTransports === undefined
            ? {}
            : { activeTransports: [...this.connectionProgress.activeTransports] }),
        },
      }),
      remoteFeatures: this.connected?.features ?? remoteHostFeatures(),
      ...(this.pendingWorkspaceSelection === undefined
        ? {}
        : { workspaceSelection: { ...this.pendingWorkspaceSelection } }),
      backend: this.codexVirtual === undefined ? 'harness' : 'codex',
      hostAuthorizationAvailable: this.host !== undefined,
      ...(this.host === undefined ? {} : { host: this.host.hostStatus() }),
    }
  }

  private async closePreview(): Promise<void> {
    const preview = this.preview; this.preview = undefined
    await preview?.close()
  }

  private async detailedStatus(): Promise<Record<string, unknown>> {
    const connected = this.connected
    if (connected === undefined || this.identity === undefined) return this.status()
    const details = await connected.transport.connectionDetails()
    if (this.connected !== connected) return this.status()
    return {
      ...this.status(),
      network: {
        ...details,
        local: {
          deviceId: this.identity.deviceId,
          name: this.identity.name,
          platform: process.platform,
        },
        remote: {
          deviceId: connected.target.deviceId,
          name: connected.target.name,
          platform: connected.target.platform,
        },
      },
    }
  }

  async devices(): Promise<RemoteDeviceView[]> {
    // A stale Host credential must not become a dead end: the user is usually *in the middle* of signing in,
    // and "sign out and authorize again" is a circle they cannot act on. Try to re-authorize from the stored
    // Client credential, and when that cannot work either, report no devices - the panel already renders the
    // authorization state from the host status, and nothing is leaked.
    if (!await this.recoverHostAuthorization()) return []
    this.requireIdentity()
    const serverDevices = await this.server.listDevices()
    const remoteDevices = serverDevices.filter(device => device.deviceId !== this.host?.hostStatus().deviceId)
    return Promise.all(remoteDevices.map(async device => {
      await this.authorizeHostPeer(device)
      const presence = await this.server.presenceFor(device.deviceId).catch(() => ({ online: false }))
      return { ...device, ...presence }
    }))
  }

  /**
   * Whether the Host credential is usable, after one attempt to re-authorize it.
   *
   * Device discovery runs through the local app control route and must not leak a device directory for a
   * Host the Server no longer accepts, but refusing outright was worse than useless: it told a user who was
   * already signing in to sign out first. Re-authorizing from the stored Client credential is the move that
   * helps; when that fails too - the device was removed from the account, so there is nothing left to
   * refresh - discovery reports nothing and the panel's authorization state takes over.
   * @returns whether the Host credential is usable.
   */
  private async recoverHostAuthorization(): Promise<boolean> {
    const status = this.host?.hostStatus()
    return status === undefined || status.error === undefined || !HOST_AUTHORIZATION_ERRORS.has(status.error)
  }

  async authorizeClientWithAccount(email: string, password: string): Promise<unknown> {
    let authorization
    try {
      authorization = await this.server.authorizeWithAccount(this.requireIdentity(), email, password)
    } catch (error) {
      if (!(error instanceof ServerApiError) || error.code !== 'DEVICE_REVOKED') throw error
      // (no identity rotation: the device id must stay stable for the life of the installation)
      const identity = this.requireIdentity()
      this.server.bindIdentity(identity)
      authorization = await this.server.authorizeWithAccount(identity, email, password)
    }
    this.logger.info('Client account authorized')
    return authorization
  }

  async startClientOAuthQrLogin(provider: OAuthProvider): Promise<unknown> {
    return this.server.startOAuthQrLogin(provider)
  }

  async pollClientOAuthQrLogin(qrId: string): Promise<unknown> {
    const result = await this.server.pollOAuthQrLogin(this.requireIdentity(), qrId, async () => {
      // (no identity rotation: the device id must stay stable for the life of the installation)
      const identity = this.requireIdentity()
      this.server.bindIdentity(identity)
      // Same identity: a revoked device comes back as itself once its key proves ownership.
      return identity
    })
    if (result.status === 'complete') this.logger.info('Client account authorized with QR login')
    return result
  }

  /**
   * Stop this Client from being authorized, keeping its device identity.
   *
   * The device is deliberately *not* revoked and the identity is deliberately
   * *not* rotated. Signing out used to revoke the device, which forced a new
   * identity on the next sign-in and registered a second device for the same
   * installation; an account holds at most 256 devices, so signing out often
   * enough could exhaust it. Keeping the row also means the next sign-in reuses
   * it, and the server invalidates the previous tokens at that point.
   *
   * The cost, by choice: while signed out the device stays in the account and
   * its old tokens stay valid until the next sign-in or their expiry, so signing
   * out is no longer a way to cut a leaked token off immediately. Removing the
   * device for good is an operator action on the server's state file.
   */
  async clearClientAuthorization(): Promise<void> {
    const previous = this.connected
    this.connected = undefined
    this.connectionProgress = undefined
    this.pendingWorkspaceSelection = undefined
    this.closeBrowsing()
    await this.closeCodexVirtual()
    this.proxySwitch?.selectLocal()
    await this.closePreview()
    this.gatewaySwitch.selectLocal()
    await this.closeCodexStreams(previous?.client)
    await previous?.client.close().catch(() => undefined)
    // A sign-out ends the session for good, so no reconnect loop may keep trying.
    this.remoteReconnectRun += 1
    // Clear the in-memory authorization as well as the stored credential. The
    // caller clears the credential file, but this API also caches the
    // authorization in memory, and a stale copy keeps reporting the Client as
    // authorized — which stops the Host from re-authorizing and leaves the
    // connection retrying tokens the Server no longer accepts.
    await this.server.clearAuthorization()
  }

  /**
   * Revoke this device on the Server, then drop the local authorization.
   *
   * Used by the Remote panel's removal action. The device deliberately keeps its identity: signing in
   * again re-registers the same installation instead of adding another device row, which is what stops
   * one machine from looking like several over time.
   */
  async revokeCurrentDevice(): Promise<void> {
    await this.server.revokeCurrentDevice()
    // The Server has already torn the connection down with the row, so only local session state is left.
    this.connected = undefined
    this.connectionProgress = undefined
    this.closeBrowsing()
    this.reconnecting = undefined
    this.fellBackToLocal = false
    this.remoteReconnectRun += 1
  }

  /**
   * Switch whether this machine accepts control.
   *
   * Turning it off takes the Host connection away and tells the Server to refuse a new one, while the
   * account sign-in, the device identity and the client half stay exactly as they are - so the device
   * remains signed in and can still control other machines, and turning control back on reconnects
   * without another sign-in.
   */
  /** Re-read this device's credentials from disk, so a sign-in is picked up without a restart. */
  reloadCredentials(): void {
    this.server.reloadCredentials()
  }

  async setHostAuthorization(enabled: boolean): Promise<unknown> {
    if (this.host === undefined) throw new ClientModeError('METHOD_NOT_ALLOWED', 'This plugin is not running as a Host.')
    // The flag first: resuming before the Server knows would only get the hello refused.
    await this.host.setHostControl?.(enabled)
    if (enabled) await this.host.resumeHostConnection?.()
    else await this.host.pauseHostConnection?.()
    return this.status()
  }

  async setMode(mode: HarnessMode, targetDeviceId?: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (mode === 'local') {
      await this.closeCodexVirtual()
      this.proxySwitch?.selectLocal()
      await this.closePreview()
      this.gatewaySwitch.selectLocal()
      const previous = this.connected
      this.connected = undefined
      this.connectionProgress = undefined
      this.pendingWorkspaceSelection = undefined
      // The user asked for local, so the next remote session starts from a fresh workspace choice.
      this.lastWorkspaceSelection = undefined
      // Browsing was also for the session they just left; there is nothing left for it to serve.
      this.closeBrowsing()
      await this.closeCodexStreams(previous?.client)
      await previous?.client.close().catch(() => undefined)
      // Returning to local is the answer to a dropped session, so the record of
      // that drop must not outlive it: otherwise the exit affordances stay on
      // screen after the user has already acted on them. Stop any pending
      // reconnect too — the user asked for local, not for a retry.
      this.fellBackToLocal = false
      this.reconnecting = undefined
      this.remoteReconnectRun += 1
      await this.rememberTarget({ mode: 'local' })
      this.logger.info('Harness target switched', { mode: 'local' })
      return this.status()
    }
    if (targetDeviceId === undefined || targetDeviceId.length === 0) {
      throw new ClientModeError('INVALID_MESSAGE', 'A targetDeviceId is required for remote mode.')
    }
    // The panel may already hold a browse connection to this Host, and the Server keeps one control connection
    // per device and role: that link becomes the session instead of a second one being opened.
    const browsingHere = this.browsing?.target.deviceId === targetDeviceId ? this.browsing : undefined
    if (browsingHere !== undefined) this.browsing = undefined
    const next = browsingHere ?? await this.connectWithReason(targetDeviceId, signal)
    try {
      this.assertRemoteCompatible(next)
    } catch (error) {
      this.clearConnectionProgress(next.progressRunId)
      await next.client.close().catch(() => undefined)
      throw error
    }
    const previous = this.connected
    await this.closePreview()
    this.connected = next
    this.clearConnectionProgress(next.progressRunId)
    this.pendingWorkspaceSelection = undefined
    await this.closeCodexVirtual()
    this.selectRemoteTarget(next)
    this.closeBrowsing()
    // A fresh remote session clears the record of an earlier dropped one.
    this.fellBackToLocal = false
    this.reconnecting = undefined
    await this.rememberTarget({ mode: 'remote', hostDeviceId: next.target.deviceId, hostName: next.target.name })
    await this.closeCodexStreams(previous?.client)
    await previous?.client.close().catch(() => undefined)
    this.logger.info('Harness target switched', { mode: 'remote', targetDeviceId: shortId(next.target.deviceId) })
    return this.status()
  }


  /**
   * Build a new transport for the session already on screen.
   *
   * The carriers hold the previous client, so they are rebound to the new one before the old client
   * is closed; leaving it open would keep pointing remote calls at a dead transport.
   * @param targetDeviceId - the Host to reconnect to.
   * @returns true when a new session is in place.
   */
  private async reestablish(targetDeviceId: string, forceRelay = false): Promise<boolean> {
    const previous = this.connected
    // From here until the new session is in place, a close of the old transport is our own doing:
    // superseding it keeps that close from being read as an unrelated second failure.
    this.supersededClient = previous?.client
    try {
      const next = await this.connectWithReason(targetDeviceId, undefined, forceRelay)
      if (previous === undefined) {
        // The user asked for local while this attempt was running.
        this.supersededClient = undefined
        await next.client.close().catch(() => undefined)
        return false
      }
      await this.closePreview()
      this.connected = next
      this.clearConnectionProgress(next.progressRunId)
      this.selectRemoteTarget(next)
      await this.closeCodexStreams(previous.client)
      await previous.client.close().catch(() => undefined)
      this.supersededClient = undefined
      return true
    } catch (error: unknown) {
      this.supersededClient = undefined
      // The code here is our own fallback (INTERNAL_ERROR) whenever the failure came from below, so the
      // message and system codes carry the actual reason: a Host that refused control, a replaced link, a
      // closed socket. Without them every cause reads the same.
      this.logger.warn('fast reconnect attempt failed', {
        targetDeviceId: shortId(targetDeviceId),
        code: failureCode(error),
        ...connectionFailureDetail(error),
      })
      return false
    }
  }

  private rememberWorkspaceSelection(selection: RemoteWorkspaceSelection): void {
    this.pendingWorkspaceSelection = selection
    this.lastWorkspaceSelection = { ...selection }
    // Record the workspace with the Host as soon as it is chosen, so a process that is reclaimed before the
    // next reconnect still knows what the user was looking at.
    const connected = this.connected
    if (connected?.target.deviceId === selection.targetDeviceId) {
      void this.rememberTarget({
        mode: 'remote',
        hostDeviceId: selection.targetDeviceId,
        hostName: connected.target.name,
      })
    }
  }

  /**
   * What the user is watching, reduced to the only thing a recovery has to restore.
   *
   * A lost session is always "this device, this kind of workspace, this directory". Deriving that once -
   * instead of letting each recovery path re-read `lastWorkspaceSelection` and decide for itself - is what
   * keeps a Codex session from being restored onto the peer's DeepSeek carrier, which is exactly the bug the
   * reconnect used to produce.
   * @param targetDeviceId - the Host the lost session belonged to.
   * @returns the target, or undefined when nothing on that Host is being watched.
   */
  private sessionTargetFor(targetDeviceId: string): RemoteSessionTarget | undefined {
    const selection = this.lastWorkspaceSelection
    if (selection === undefined || selection.targetDeviceId !== targetDeviceId) return undefined
    return {
      deviceId: targetDeviceId,
      kind: selection.backend === 'codex' ? 'codex' : 'harness',
      workspaceId: selection.workspaceId,
      ...(selection.workspacePath === undefined ? {} : { workspacePath: selection.workspacePath }),
      ...(selection.sessionId === undefined ? {} : { sessionId: selection.sessionId }),
    }
  }

  /**
   * Put the session the user was watching back in place on the current link.
   *
   * The one step every recovery path ends with, whichever way the link came back: the retry schedule, the
   * quick window, or a boot restore. A Codex target rebuilds the Codex carrier - never the peer's Harness
   * workspace - and a Harness target republishes its workspace selection so the native UI re-reads its list.
   * @param target - the session to restore.
   * @param fallbackToLocal - whether a failed Codex rebuild may hand the view to the local shell. The quick
   * window passes false: its whole point is to keep the user looking at the session while it is rescued.
   * @returns true when the user is looking at that session again.
   */
  private async restoreSession(
    target: RemoteSessionTarget,
    options: { fallbackToLocal?: boolean } = {},
  ): Promise<boolean> {
    if (target.kind === 'codex') {
      const restored = await this.restoreCodexCarrier(target, options.fallbackToLocal !== false)
      if (restored) {
        this.logger.info('remote Codex session restored', {
          targetDeviceId: shortId(target.deviceId),
          kind: 'codex',
          path: target.workspacePath ?? '(unknown)',
        })
      }
      return restored
    }
    this.restoreWorkspaceSelection(target.deviceId)
    this.logger.info('remote DSH session restored', {
      targetDeviceId: shortId(target.deviceId),
      kind: 'harness',
    })
    return true
  }

  /**
   * Clear the recovery flag once the user is back on the session they were watching.
   *
   * The header reads this flag to show "reconnecting", so it must be cleared exactly when the recovery
   * succeeded - not when a transport happened to come back, and not while a Codex workspace is still missing.
   * @param targetDeviceId - the Host the recovery was about.
   * @param reason - what brought the session back, for the log.
   * @param kind - which carrier was restored.
   */
  private finishRecovery(targetDeviceId: string, reason: string, kind: RemoteSessionKind): void {
    this.reconnecting = undefined
    this.fellBackToLocal = false
    this.logger.info('remote session recovered', {
      targetDeviceId: shortId(targetDeviceId),
      kind,
      reason,
    })
  }

  /**
   * Republish the workspace selection so the native UI re-reads its remote session list.
   *
   * The client half consumes status.workspaceSelection and reconnects that workspace; that refresh is
   * what replaces a list the outage had filled with local answers.
   * @param targetDeviceId - the Host the reconnect finished against.
   */
  private restoreWorkspaceSelection(targetDeviceId: string): void {
    const selection = this.lastWorkspaceSelection
    if (selection === undefined || selection.targetDeviceId !== targetDeviceId) return
    this.pendingWorkspaceSelection = { ...selection }
    this.logger.info('republishing the workspace selection to re-read the remote session list', {
      targetDeviceId: shortId(targetDeviceId),
      workspaceId: selection.workspaceId,
    })
  }

  /**
   * Put the Codex carrier back onto the link that just replaced the old one.
   *
   * A reconnect leaves the carrier holding a transfer channel bound to a transport that no longer exists, and the
   * first use fails with "remote transport closed" while the UI still looks connected - the reported symptom:
   * Codex sessions vanish and clicking one errors. Rebuilding the carrier is what lets an open Codex workspace
   * survive a reconnect.
   *
   * The workspace is matched by directory, not by id: a Host that replaced its Codex domain renumbers the very
   * same directories, so an id that misses is retried once by root before the workspace is given up on.
   * @param target - the Codex session to restore.
   * @param fallbackToLocal - whether a failure may hand the view to the client's own shell. The quick window
   * passes false so the user keeps looking at the session for the whole window.
   * @returns true when the Codex carrier is back on the given workspace.
   */
  private async restoreCodexCarrier(target: RemoteSessionTarget, fallbackToLocal = true): Promise<boolean> {
    try {
      try {
        await this.openCodexWorkspace(target.deviceId, target.workspaceId)
      } catch (error) {
        const root = target.workspacePath
        if (root === undefined) throw error
        const recovered = await this.codexWorkspaceIdForPath(target.deviceId, root)
        if (recovered === undefined) throw error
        if (recovered !== target.workspaceId) {
          this.logger.info('CodeX workspace restored under a new id', {
            targetDeviceId: shortId(target.deviceId),
            path: root,
          })
        }
        await this.openCodexWorkspace(target.deviceId, recovered)
      }
      // Only now may the UI re-read: the Codex carrier is the one that answers it.
      this.restoreWorkspaceSelection(target.deviceId)
      return true
    } catch (error) {
      this.logger.warn('CodeX workspace could not be restored', {
        targetDeviceId: shortId(target.deviceId),
        code: failureCode(error),
        path: target.workspacePath ?? '(unknown)',
        ...connectionFailureDetail(error),
      })
      // A Codex session that cannot be brought back must not leave the user in this Host's Harness workspace: the
      // agreed fallback is the client's own shell, with the retry schedule still trying the Codex workspace.
      if (fallbackToLocal) await this.fallBackToLocalForCodex()
      // The remembered selection is deliberately kept: a Host that has just come back can report no Codex
      // capability for a few seconds while its domain starts, and forgetting the selection on that first answer
      // would leave the client with nothing to restore - it would settle on the Host's Harness view instead of
      // retrying the Codex workspace. Only an explicit choice by the user replaces the selection.
      return false
    }
  }

  /**
   * The id the Host currently uses for a workspace root.
   *
   * @param targetDeviceId - the Host to ask.
   * @param path - the workspace root as it was remembered.
   * @returns the current workspace id, or undefined when the Host no longer offers that root.
   */
  private async codexWorkspaceIdForPath(targetDeviceId: string, path: string): Promise<string | undefined> {
    const workspaces = await this.listCodexWorkspaces(targetDeviceId)
    const match = workspaces.find(candidate => sameWorkspaceRoot(candidate.path, path))
    return match?.workspaceId
  }

  /**
   * Show the client's own shell while a Codex session is unavailable.
   *
   * The peer's other carrier must not stand in for the Codex workspace that was lost, and this deliberately does not
   * touch the reconnect run counter: the retry schedule keeps trying to restore the Codex workspace while the user
   * works locally.
   * @returns nothing.
   */
  private async fallBackToLocalForCodex(): Promise<void> {
    await this.closeCodexVirtual()
    this.proxySwitch?.selectLocal()
    this.gatewaySwitch.selectLocal()
    this.fellBackToLocal = true
  }

  /**
   * The Codex session is gone while the transport is still up (the Host replaced or switched off its Codex
   * domain). Deliberately the same entry point as a lost link, so both carriers take one path: quick reconnect,
   * local fallback and the retry schedule.
   *
   * The trigger is logged, because "the banner did not appear" is otherwise indistinguishable between "no
   * signal arrived" and "the signal arrived but the UI did not show it".
   * @param trigger - what noticed it.
   * @returns nothing; the reconnect runs in the background.
   */
  noteCodexSessionLost(trigger: RemoteCodexLossTrigger): void {
    const connected = this.connected
    if (connected === undefined || this.reconnecting !== undefined) {
      this.logger.info('Codex session loss ignored', {
        targetDeviceId: connected === undefined ? undefined : shortId(connected.target.deviceId),
        trigger,
        reason: connected === undefined ? 'not-connected' : 'recovery-already-running',
      })
      return
    }
    // Only a Codex session the user is actually watching is lost here. A Host whose Codex went away while the
    // user is in its DSH workspace must not turn into a recovery: that would move a session nobody asked to move.
    if (this.sessionTargetFor(connected.target.deviceId)?.kind !== 'codex') {
      this.logger.info('Codex session loss ignored', {
        targetDeviceId: shortId(connected.target.deviceId),
        trigger,
        reason: 'watching-another-session',
      })
      return
    }
    this.logger.warn('remote Codex session lost', {
      targetDeviceId: shortId(connected.target.deviceId),
      trigger,
    })
    void this.handleRemoteTransportLost(connected.client, connected.target.deviceId, 'codex-closed')
  }

  /**
   * Check the live session now, outside the cadence.
   *
   * Used when the page becomes visible again, which is when a suspended client is most likely to be
   * holding a link that already ended.
   * @returns the status after the check.
   */
  async verifyRemoteConnection(): Promise<Record<string, unknown>> {
    // Nothing here probes the business path: that check queued behind a large history and mistook a busy
    // Host for a dead one. Death arrives either as the Server's link-dropped notice or as a failed write,
    // and both funnel through handleRemoteTransportLost into the quick reconnect window.
    return this.status()
  }

  /**
   * Re-read the connected Host's capabilities.
   *
   * A Host that switches Codex (or the terminal) on or off changes what it advertises, and the cached feature
   * set used to be refreshed only when a workspace list happened to be requested - which is why the Remote card
   * could describe a Host it no longer matched. One round trip, no business payload, so the card can poll it.
   * @returns the connected Host's fresh feature set, or `{ connected: false }`.
   */
  async probeRemoteFeatures(): Promise<Record<string, unknown>> {
    const remote = this.connected
    if (remote === undefined) return { connected: false }
    try {
      remote.features = await probeRemoteHostFeatures(remote.client, remote.clientVersion)
    } catch (error) {
      const code = failureCode(error)
      this.logger.warn('remote capability probe failed', {
        targetDeviceId: shortId(remote.target.deviceId),
        code,
      })
      return { connected: true, targetDeviceId: remote.target.deviceId, features: remote.features, error: code }
    }
    return { connected: true, targetDeviceId: remote.target.deviceId, features: remote.features }
  }

  /**
   * Re-establish the session the user is watching, without changing which session that is.
   *
   * What the Remote card's Refresh does for a live session: the transport may have died, the peer's Codex may
   * have come back, or a previous recovery may have given up. This never selects another Host and never another
   * kind of workspace - the remembered selection is the only thing it works from.
   * @returns the status after the attempt.
   */
  async recoverCurrentSession(): Promise<Record<string, unknown>> {
    const selection = this.lastWorkspaceSelection
    if (selection === undefined) return this.status()
    // One recovery at a time: a running schedule (or quick window) already targets the same session.
    if (this.reconnecting !== undefined) return this.status()
    const target = this.sessionTargetFor(selection.targetDeviceId)
    const connected = this.connected
    if (connected === undefined) {
      this.reconnecting = { targetDeviceId: selection.targetDeviceId, phase: 'fallback' }
      void this.reconnectRemoteSession(selection.targetDeviceId, target)
      return this.status()
    }
    // The user has since chosen a different Host; Refresh must not move them back.
    if (connected.target.deviceId !== selection.targetDeviceId) return this.status()
    // Ask the Host one cheap question. An answer means the link is alive and only the session behind it may be
    // missing; silence means the link itself is gone and the ordinary ladder - quick window, then the retry
    // schedule - has to rebuild it. Deliberately not a periodic probe: it runs on the user's own Refresh.
    const probe = await this.probeRemoteFeatures()
    if (probe.connected === true && probe.error === undefined) {
      if (target !== undefined) await this.restoreSession(target)
      return this.status()
    }
    if (probe.error === undefined) return this.status()
    await this.handleRemoteTransportLost(connected.client, connected.target.deviceId, 'manual')
    return this.status()
  }


  /**
   * Shared cleanup for a session whose transport is gone.
   *
   * Every trigger runs this - a close on our own transport, and the quick window running out - so they all
   * leave exactly the same state behind. The session is gone for good here, which is why the phase becomes
   * 'fallback' and the retry schedule takes over until it is spent; once it is, the reconnect flag is
   * cleared so the header stops advertising a reconnect that is no longer happening.
   * @param client - the client that was connected.
   * @param targetDeviceId - the Host it was bound to.
   */
  /**
   * A user's explicit workspace choice supersedes a recovery that is still in flight.
   *
   * The retry schedule belongs to the session the user was watching. When they pick another workspace, that
   * schedule must not land later and move the view again: the reported failure was a Codex ladder restoring its
   * own workspace over the DSH workspace the user had just opened - "the user's own choice is the only thing
   * that changes which session is on screen" was broken by a background timer. Only the panel's open endpoints
   * call this; the recovery restores through the internal open paths, so it never cancels itself.
   */
  private supersedeRemoteRecovery(): void {
    if (this.reconnecting === undefined && !this.fellBackToLocal) return
    this.logger.info('a workspace was opened; stopping the recovery in flight', {
      phase: this.reconnecting?.phase ?? 'fallback',
    })
    this.reconnecting = undefined
    this.fellBackToLocal = false
    this.remoteReconnectRun += 1
  }

  /**
   * Whether the user still wants the session a recovery is putting back.
   *
   * The user's own choice is the record, not a counter: cancelling clears `lastWorkspaceSelection` (and writes
   * `local` to the target file), and opening another workspace points the selection somewhere else. A recovery is
   * work the user asked for *earlier*, so it may only adopt its result while that is still what they want. The
   * reported failure was an attempt that landed after the answer - it reconnected and put the session back on
   * screen, because nothing re-read the user's intent once the attempt was in flight.
   * @param targetDeviceId - the Host the recovery is restoring.
   * @returns true while the remembered target is still that Host.
   */
  private recoveryStillWanted(targetDeviceId: string): boolean {
    if (this.reconnecting === undefined) return false
    return this.lastWorkspaceSelection?.targetDeviceId === targetDeviceId
  }

  /**
   * Undo a recovery the user answered while it was landing: their choice wins over work already in flight.
   * @param targetDeviceId - the Host the recovery was restoring.
   */
  private async abandonRecovery(targetDeviceId: string): Promise<void> {
    this.logger.info('the user answered while the recovery was landing; returning to the local shell', {
      targetDeviceId: shortId(targetDeviceId),
    })
    // Exactly what the user's own cancel does: close it, select the local carriers, forget the selection. The
    // session this attempt just restored goes with it.
    await this.setMode('local')
  }

  private async handleRemoteTransportLost(
    client: RemoteClientCore,
    targetDeviceId: string,
    reason: RemoteSessionLossReason,
  ): Promise<void> {
    const browsing = this.browsing?.client === client ? this.browsing : undefined
    if (browsing !== undefined && this.connected?.client !== client) {
      // The panel's browse connection is not a session: nothing here may move the view or start a recovery.
      // It must, however, be forgotten. It lives outside `connected`, so the guard below dropped its close on
      // the floor and every later request was handed the dead client - the Remote card then answered "the
      // authenticated Noise channel is not connected" until the plugin was restarted, even though the Host was
      // healthy and accepting control. Dropping it here makes the next request open a fresh connection.
      this.browsing = undefined
      this.clearConnectionProgress(browsing.progressRunId)
      this.logger.info('browsing connection closed; the panel will open a new one', {
        targetDeviceId: shortId(targetDeviceId),
        reason,
      })
      void browsing.client.close().catch(() => undefined)
      return
    }
    if (this.connected?.client !== client) return
    this.supersededClient = undefined
    const targetName = this.connected.target.name
    const target = this.sessionTargetFor(targetDeviceId)
    const kind: RemoteSessionKind = target?.kind ?? 'harness'
    if (target === undefined) {
      // No workspace was ever opened on this Host, so there is no session here - only the panel's browsing link
      // (which lives elsewhere) or an open attempt that failed. Losing it must leave the user in the local
      // shell: no quick window, no fallback, no retry schedule, and never a switch to this Host's workspace.
      this.logger.info('connection closed with no remote session to recover; staying local', {
        targetDeviceId: shortId(targetDeviceId),
        reason,
      })
      const previous = this.connected
      this.connected = undefined
      this.connectionProgress = undefined
      await this.closeCodexStreams(previous?.client)
      await previous?.client.close().catch(() => undefined)
      return
    }
    // A Caller that already probed the link reports 'manual'; the close notice and the Server's link-dropped
    // notice are the transport-level signals. Only a Codex-only loss arrives with a link that is known to be up.
    const transportLost = reason !== 'codex-closed'
    if (this.reconnecting === undefined) {
      // Phase 1 - the quick window. Two attempts inside ten seconds, and the view is deliberately NOT touched:
      // the same Workspace and Session list stay on screen while the session is rescued. A Codex-only loss needs
      // no new link (the transport is fine), so its attempts rebuild the carrier in place instead; a lost
      // transport has to be rebuilt first, and only then can the session be put back on it.
      //
      // The run id is captured here so the window's own continuation can tell whether the user answered while it
      // ran: cancelling (`mode.set local`) and opening another workspace both bump it. Without this check a
      // cancel during the window was ignored - the handler still fell back and started the ladder, and the first
      // rung put the remote session back on screen seconds after the user had asked for local.
      const run = this.remoteReconnectRun
      this.reconnecting = { targetDeviceId, ...(targetName === undefined ? {} : { targetName }), phase: 'fast' }
      this.logger.warn('remote session lost; trying the quick window', {
        targetDeviceId: shortId(targetDeviceId),
        kind,
        reason,
        attempts: QUICK_RECONNECT_ATTEMPTS,
        windowMs: QUICK_RECONNECT_WINDOW_MS,
      })
      const rescued = await this.quickReconnectSession(targetDeviceId, target, transportLost, run)
      if (run !== this.remoteReconnectRun) {
        this.logger.info('the user answered during the quick window; the recovery stops here', {
          targetDeviceId: shortId(targetDeviceId),
          kind,
        })
        return
      }
      if (rescued) {
        this.finishRecovery(targetDeviceId, 'quick-window', kind)
        this.logger.info('remote session kept its view through a quick reconnect', {
          targetDeviceId: shortId(targetDeviceId),
          kind,
        })
        return
      }
    }
    // Phase 2 - the window is spent. The session is handed back to the client's own shell (the view switches to
    // the local workspaces, which is what the tenth second is for) and phase 3 takes over.
    await this.fallBackToLocalShell(targetDeviceId, targetName, reason, kind, transportLost)
    // Phase 3 - background retries on the same ladder for every kind of loss.
    void this.reconnectRemoteSession(targetDeviceId, target)
  }

  /**
   * The quick window: rescue the same session without disturbing the view.
   *
   * At most {@link QUICK_RECONNECT_ATTEMPTS} attempts inside {@link QUICK_RECONNECT_WINDOW_MS}, spaced by
   * {@link QUICK_RECONNECT_RETRY_DELAY_MS}. Nothing here falls back to the local shell or republishes a
   * workspace - the user keeps looking at the session they were in, and the caller decides what happens once the
   * window is spent. A lost transport is rebuilt first, over relay only (the one path measured under five
   * seconds); a Codex-only loss already has its link, so its attempts only rebuild the carrier.
   * @param targetDeviceId - the Host the session was bound to.
   * @param target - the session to put back.
   * @param transportLost - whether the link itself has to be rebuilt.
   * @param run - the recovery run this window belongs to; the user answering bumps it.
   * @returns true when the session is on screen again.
   */
  private async quickReconnectSession(
    targetDeviceId: string,
    target: RemoteSessionTarget,
    transportLost: boolean,
    run: number,
  ): Promise<boolean> {
    let linkUp = !transportLost
    const deadline = Date.now() + QUICK_RECONNECT_WINDOW_MS
    for (let attempt = 1; attempt <= QUICK_RECONNECT_ATTEMPTS; attempt += 1) {
      // The user's answer ends the window at once. Without this the second attempt still ran - and by then the
      // peer was often back, so it restored the very session the user had just cancelled.
      if (!this.recoveryStillWanted(targetDeviceId) || run !== this.remoteReconnectRun) return false
      if (!linkUp) linkUp = await this.reestablish(targetDeviceId, QUICK_RECONNECT_FORCE_RELAY)
      if (!this.recoveryStillWanted(targetDeviceId) || run !== this.remoteReconnectRun) return false
      // Once the link is up there is no reason to rebuild it again: what is still missing is the session, and a
      // second rebuild would close the peer's fresh link for nothing.
      if (linkUp && await this.restoreSession(target, { fallbackToLocal: false })) {
        // The restore takes seconds, and the user can answer inside it. Their answer outranks it: put the local
        // shell back instead of leaving a session on screen that they had already left.
        if (!this.recoveryStillWanted(targetDeviceId) || run !== this.remoteReconnectRun) {
          await this.abandonRecovery(targetDeviceId)
          return false
        }
        return true
      }
      if (attempt === QUICK_RECONNECT_ATTEMPTS) break
      const wait = Math.min(QUICK_RECONNECT_RETRY_DELAY_MS, Math.max(0, deadline - Date.now()))
      if (wait === 0) break
      await sleep(wait)
    }
    if (!this.recoveryStillWanted(targetDeviceId) || run !== this.remoteReconnectRun) return false
    // Hold the view for the rest of the window even when both attempts have already failed. The window is a
    // length of time as much as a pair of attempts: the local fallback belongs at its end, not at the moment an
    // attempt happens to fail, or a peer that refuses instantly would change the view five seconds early.
    const remaining = deadline - Date.now()
    if (remaining > 0) await sleep(remaining)
    // The window is over and the caller owns the flag from here: it either finishes the recovery or hands the
    // session to the local shell, which re-claims it as the fallback phase.
    this.reconnecting = undefined
    return false
  }

  /**
   * Hand the session back to the client's own shell.
   *
   * Phase two of the ladder, and the same for every kind of loss. A link that broke is closed here; one that is
   * still up (a Codex-only loss) is kept, because the retry schedule needs it and dropping a healthy link only to
   * open it again five seconds later is churn the user pays for. Switching the carriers to local is what makes
   * the view fall back - the point of this step.
   * @param targetDeviceId - the Host the session was bound to.
   * @param targetName - its display name, kept for the header while the reconnect runs.
   * @param reason - why the session was lost, for the log.
   * @param kind - which carrier was lost.
   * @param transportLost - whether the link itself is gone.
   */
  private async fallBackToLocalShell(
    targetDeviceId: string,
    targetName: string | undefined,
    reason: RemoteSessionLossReason,
    kind: RemoteSessionKind,
    transportLost: boolean,
  ): Promise<void> {
    void this.closePreview()
    this.connectionProgress = undefined
    this.pendingWorkspaceSelection = undefined
    await this.closeCodexVirtual()
    this.proxySwitch?.selectLocal()
    this.gatewaySwitch.selectLocal()
    this.fellBackToLocal = true
    this.reconnecting = { targetDeviceId, ...(targetName === undefined ? {} : { targetName }), phase: 'fallback' }
    if (transportLost) {
      const previous = this.connected
      this.connected = undefined
      await this.closeCodexStreams(previous?.client)
      void previous?.client.close().catch(() => undefined)
    }
    // One line per loss, with the identifiers and the outcome of the window that just failed: "why did it move"
    // is answerable from the log alone, without guessing at which trigger fired.
    this.logger.warn('remote session lost; falling back to the local shell and retrying', {
      targetDeviceId: shortId(targetDeviceId),
      kind,
      reason,
    })
  }

  /**
   * The background retry ladder, shared by every way a session can be recovered.
   *
   * It runs after the quick window has been spent (the caller has already fallen back to the local shell), or
   * straight away for a boot restore, which has no window behind it. Every attempt targets the same session; on
   * success the workspace and the session data are re-read, and when the ladder is spent the reconnect flag is
   * cleared so the user is simply local. A loop that is superseded, or one whose session came back another way,
   * stops quietly.
   * @param targetDeviceId - the Host the lost session was bound to.
   * @param target - the session to put back.
   * @param immediateFirstAttempt - true for a boot restore, which should not wait five seconds to start.
   */
  private async reconnectRemoteSession(
    targetDeviceId: string,
    target: RemoteSessionTarget | undefined = this.sessionTargetFor(targetDeviceId),
    immediateFirstAttempt = false,
  ): Promise<void> {
    const run = ++this.remoteReconnectRun
    const kind: RemoteSessionKind = target?.kind ?? 'harness'
    if (target === undefined) {
      // There is no session to put back: the connection that dropped was the panel browsing a Host, or an open
      // attempt that never completed. The user is still in the local shell, so nothing may be re-established
      // here - forcing remote mode would show that Host's DSH workspace without anybody asking for it.
      this.reconnecting = undefined
      this.fellBackToLocal = false
      this.logger.info('no remote session to restore; staying in the local shell', {
        targetDeviceId: shortId(targetDeviceId),
      })
      return
    }
    // Fast attempts first, then a steady low rate. Timers do not run while a
    // client is suspended, so a pending wait simply lands when it comes back —
    // which is what makes a backgrounded phone reconnect on its own. Keeping the
    // loop alive matters for the other order too: attempts spent while the network
    // was down must not leave the session dead until the user acts.
    // The quick window already spent its two attempts, so this ladder starts at 5s and is the same for every
    // kind of loss; when it is spent the user stays in the local shell instead of the loop retrying forever.
    // The header's cancel button supersedes the loop at any point.
    const delays: readonly number[] = immediateFirstAttempt
      ? [0, ...BACKGROUND_RETRY_DELAYS_MS]
      : BACKGROUND_RETRY_DELAYS_MS
    let attempt = 0
    for (;;) {
      if (attempt >= delays.length) {
        // The schedule is spent, so stop advertising a reconnect: the header reads this flag, and leaving
        // it set made a session that had already settled in the local shell show "reconnecting" forever.
        // The user can still reconnect by hand from the Remote panel.
        this.reconnecting = undefined
        this.logger.warn('remote session recovery gave up; staying in the local shell', {
          targetDeviceId: shortId(targetDeviceId),
          kind,
          attempts: attempt,
        })
        return
      }
      const wait = delays[attempt] ?? BACKGROUND_RETRY_DELAYS_MS[BACKGROUND_RETRY_DELAYS_MS.length - 1]!
      if (wait > 0) await sleep(wait)
      attempt += 1
      if (run !== this.remoteReconnectRun) return
      const reconnecting = this.reconnecting
      // No recovery in progress means the user cancelled it (or signed out): the run id usually covers
      // that too, but the flag is the user's own decision and is honoured first.
      if (reconnecting === undefined) return
      try {
        if (this.connected?.target.deviceId !== targetDeviceId) {
          await this.setMode('remote', targetDeviceId)
          // setMode ends a recovery as its own decision; this loop owns the flag until the session is really back.
          this.reconnecting = reconnecting
        }
        // The same step whichever kind it is: a Harness session republishes its workspace selection, a Codex
        // session rebuilds its carrier. A connected transport is not by itself the session the user left.
        if (target !== undefined && !await this.restoreSession(target)) continue
        // Restoring takes seconds, and the user can answer inside it (cancel, or pick another workspace). Their
        // answer outranks an attempt that was already in flight.
        if (!this.recoveryStillWanted(targetDeviceId)) {
          await this.abandonRecovery(targetDeviceId)
          return
        }
        this.finishRecovery(targetDeviceId, 'retry-schedule', kind)
        return
      } catch (error) {
        const code = failureCode(error)
        // Credentials that are missing or refused cannot be fixed by waiting, and a boot restore
        // would otherwise retry an unauthorized connection forever. Stop and let the user sign in.
        if (CREDENTIAL_FAILURE_CODES.has(code)) {
          this.reconnecting = undefined
          this.logger.warn('remote session recovery stopped: authorization is required', {
            targetDeviceId: shortId(targetDeviceId),
            kind,
            code,
          })
          return
        }
        // Report the early attempts, then only occasionally: a Host that stays
        // away would otherwise fill the log every half minute.
        if (attempt < 3 || attempt % 10 === 0) {
          const detail = connectionFailureDetail(error)
          const systemCode = typeof detail.systemCode === 'string' ? detail.systemCode : undefined
          // `code` here is only the error's class - INTERNAL_ERROR when nothing matched - while the connect path's
          // own code (HOST_OFFLINE, CAPABILITY_MISSING, ...) is what actually says why. That one is logged as the
          // code, and the prose stays a detail so it does not read like a verdict about the peer.
          this.logger.warn('remote session recovery attempt failed', {
            targetDeviceId: shortId(targetDeviceId),
            kind,
            attempt,
            code: systemCode ?? code,
            ...detail,
          })
        }
      }
      attempt += 1
    }
  }

  /**
   * Persist the target a later boot may have to restore.
   *
   * A failure here must not fail a connect: the only cost is that a killed process comes back to
   * the local shell, which is where it would have been without this record.
   * @param target - the target to record.
   */
  private async rememberTarget(target: { mode: 'local' | 'remote'; hostDeviceId?: string; hostName?: string }): Promise<void> {
    if (this.targetStore === undefined) return
    // The workspace is recorded with the Host, not instead of it: a restarted process can rebuild the same
    // Codex workspace (its directory) or the same DSH workspace, instead of coming back to an empty shell.
    const selection = target.mode === 'remote' && target.hostDeviceId !== undefined
      ? this.sessionTargetFor(target.hostDeviceId)
      : undefined
    try {
      await this.targetStore.save({
        ...target,
        ...(this.config.serverUrl === undefined ? {} : { serverUrl: this.config.serverUrl }),
        ...(selection === undefined ? {} : {
          workspace: {
            workspaceId: selection.workspaceId,
            kind: selection.kind,
            ...(selection.workspacePath === undefined ? {} : { workspacePath: selection.workspacePath }),
            ...(selection.sessionId === undefined ? {} : { sessionId: selection.sessionId }),
          },
        }),
      })
    } catch (error: unknown) {
      this.logger.warn('could not record the remote target', { code: safeErrorCode(error) })
    }
  }

  /**
   * Reconnect to the target this device was last using, with the usual backoff.
   *
   * A resumed app can miss the transport close entirely - Android may reclaim the process - so
   * nothing would start the retry loop and the user would face a local shell behind a remote
   * workspace view. Restoring the recorded target gives that case the same loop a dropped
   * transport gets. A target recorded for another Server is left alone: it is not reachable
   * through the configured one.
   * @returns true when a retry loop was started.
   */
  async restoreLastTarget(): Promise<boolean> {
    if (this.closed || this.connected !== undefined) return false
    const record = await this.targetStore?.load()
    if (record === undefined || record.mode !== 'remote' || record.hostDeviceId === undefined) return false
    if (record.serverUrl !== undefined && record.serverUrl !== this.config.serverUrl) {
      this.logger.info('recorded remote target belongs to another Server; not restoring', {
        targetDeviceId: shortId(record.hostDeviceId),
      })
      return false
    }
    // Only a session is restored. A record that names a Host but no workspace means the user was still browsing
    // when the process ended - they had not opened anything, so they belong in the local shell.
    if (record.workspace === undefined) {
      this.logger.info('the recorded target has no workspace; staying in the local shell', {
        targetDeviceId: shortId(record.hostDeviceId),
      })
      return false
    }
    this.reconnecting = {
      targetDeviceId: record.hostDeviceId,
      ...(record.hostName === undefined ? {} : { targetName: record.hostName }),
      phase: 'restore',
    }
    // Seed what the recovery is for before the first attempt: without the kind, a Codex session would come back
    // as this Host's DSH workspace, which is the one thing the recovery must never do.
    this.lastWorkspaceSelection = {
      targetDeviceId: record.hostDeviceId,
      workspaceId: record.workspace.workspaceId,
      ...(record.workspace.kind === 'codex' ? { backend: 'codex' as const } : {}),
      ...(record.workspace.workspacePath === undefined ? {} : { workspacePath: record.workspace.workspacePath }),
      ...(record.workspace.sessionId === undefined ? {} : { sessionId: record.workspace.sessionId }),
    }
    this.logger.info('restoring the remote target of the previous run', {
      targetDeviceId: shortId(record.hostDeviceId),
      kind: record.workspace.kind,
    })
    // No quick window ran for a boot, so the first attempt is immediate; the rest of the ladder is identical.
    void this.reconnectRemoteSession(record.hostDeviceId, this.sessionTargetFor(record.hostDeviceId), true)
    return true
  }

  async listRemoteDirectory(targetDeviceId: string, path?: string, signal?: AbortSignal): Promise<RemoteDirectoryListing> {
    const remote = await this.ensureBrowsing(targetDeviceId, signal)
    if (remote.features.remoteGateway) {
      const value = await new RemoteTypertGateway(remote.client).invoke({
        namespace: 'directoryPicker',
        method: 'list',
        args: path === undefined ? {} : { path },
        ...(signal === undefined ? {} : { signal }),
      })
      return value as RemoteDirectoryListing
    }
    const api = new RemoteHarnessApiProxy(remote.client).api
    const response = await api.host.listDirectory({
      rpcId: `remote-directory-${Date.now()}` as never,
      payload: path === undefined ? {} : { path },
    }, signal ?? new AbortController().signal)
    return unwrapNativeResult<RemoteDirectoryListing>(response)
  }

  async listRemoteWorkspaces(targetDeviceId: string, signal?: AbortSignal): Promise<RemoteWorkspaceView[]> {
    const remote = await this.ensureBrowsing(targetDeviceId, signal)
    if (remote.features.remoteGateway) {
      return readRemoteWorkspaceBaseline(new RemoteTypertGateway(remote.client), signal)
    }
    const api = new RemoteHarnessApiProxy(remote.client).api
    const response = await api.workspace.list({
      rpcId: `remote-workspaces-${Date.now()}` as never,
      payload: {},
    })
    const value = unwrapNativeResult<{ items: RemoteWorkspaceView[] }>(response)
    return value.items
  }

  async openRemoteWorkspace(targetDeviceId: string, path: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (path.trim() === '') throw new ClientModeError('INVALID_MESSAGE', 'A remote working directory is required.')
    const remote = await this.ensureConnected(targetDeviceId, signal)
    const transport = this.selectHarnessRemoteTransport(remote)
    let workspace: { workspace: unknown; created: boolean }
    if (transport === 'remoteGateway') {
      workspace = await new RemoteTypertGateway(remote.client).invoke({
        namespace: 'workspace',
        method: 'create',
        args: { request: { path } },
        ...(signal === undefined ? {} : { signal }),
      }) as { workspace: unknown; created: boolean }
    } else {
      const api = new RemoteHarnessApiProxy(remote.client).api
      const response = await api.workspace.create({
        rpcId: `remote-workspace-${Date.now()}` as never,
        payload: { path },
      })
      workspace = unwrapNativeResult<{ workspace: unknown; created: boolean }>(response)
    }
    await this.closeCodexVirtual()
    this.selectRemoteTarget(remote, transport)
    const workspaceId = workspaceRecordId(workspace.workspace)
    this.rememberWorkspaceSelection({ targetDeviceId: remote.target.deviceId, workspaceId })
    this.logger.info('Remote workspace opened', { targetDeviceId: shortId(remote.target.deviceId) })
    return { ...this.status(), workspace }
  }

  /**
   * The refusal to report when a Host is not offering Codex right now.
   *
   * Two different facts hid behind one generic code, so the panel could not tell a user who had switched Codex
   * off from a Host that never had it. Which one it is comes from this client's own memory: a Host whose Codex
   * workspace was opened before has Codex, so its absence now means it was switched off (or is still starting);
   * a Host that never offered one simply does not provide it.
   *
   * A Codex that disappeared is also a lost session, so this hands it to the same recovery every other loss
   * uses before reporting it - a switched-off Codex that is switched back on is then restored on its own.
   * @param targetDeviceId - the Host the caller was talking to.
   * @returns the error to throw.
   */
  private remoteCodexUnavailable(targetDeviceId: string): ClientModeError {
    const expected = shouldRestoreCodexCarrier(this.lastWorkspaceSelection, targetDeviceId)
      || this.codexHostsSeen.has(targetDeviceId)
    if (expected) this.noteCodexSessionLost('capability-missing')
    return expected
      ? new ClientModeError('CODEX_DISABLED', 'Codex is switched off or unavailable on the selected Host.')
      : new ClientModeError('CODEX_NOT_PROVIDED', 'The selected Host does not provide CodeX workspaces.')
  }

  async listCodexWorkspaces(targetDeviceId: string, signal?: AbortSignal): Promise<CodexVirtualWorkspaceView[]> {
    const remote = await this.ensureBrowsing(targetDeviceId, signal)
    remote.features = await probeRemoteHostFeatures(remote.client, remote.clientVersion)
    if (!remote.features.codex) {
      throw this.remoteCodexUnavailable(targetDeviceId)
    }
    let workspaces: CodexVirtualWorkspaceView[]
    try {
      workspaces = await discoverCodexVirtualWorkspaces(new CodexRemoteClient(remote.client), signal)
    } catch (error) {
      // A Codex call that failed because the session behind it is gone is a lost session like any other, and it
      // has to be said out loud: this used to fail silently, so the panel kept a stale error on screen and
      // nothing ever tried to bring the workspace list back.
      this.logger.warn('Codex workspaces could not be listed', {
        targetDeviceId: shortId(targetDeviceId),
        code: failureCode(error),
      })
      if (isCodexSessionLoss(error)) this.noteCodexSessionLost('list-failed')
      throw error
    }
    this.lastCodexListing.set(targetDeviceId, workspaces)
    for (const item of workspaces) {
      this.codexWorkspaceRoots.set(`${targetDeviceId}|${item.workspaceId}`, item.path)
    }
    // An empty result is what the panel renders as "no Codex workspaces". Recording the count - and the fact that
    // the capability probe passed to get here - turns the next such report into an answer instead of a guess.
    // The field name must avoid the logger's redaction pattern (it matches "workspace"), which is why the count is
    // called count: logging it as "workspaces" printed [REDACTED] and told nobody anything.
    this.logger.info('Codex workspaces listed', {
      targetDeviceId: shortId(targetDeviceId),
      count: workspaces.length,
    })
    return workspaces
  }

  async openCodexWorkspace(
    targetDeviceId: string,
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const remote = await this.ensureConnected(targetDeviceId, signal)
    remote.features = await probeRemoteHostFeatures(remote.client, remote.clientVersion)
    if (!remote.features.codex) {
      throw this.remoteCodexUnavailable(targetDeviceId)
    }
    this.assertLocalHarnessCarrierAvailable()
    const virtual = CodexVirtualHarness.remote(remote.client, {
      deviceId: remote.target.deviceId,
      name: remote.target.name,
    }, harnessSessionGeneration(this.host?.localHarnessVersion?.()), new RemoteTypertGateway(remote.client))
    // A Codex call that fails because the session is gone goes through the same reconnect entry point as a lost link,
    // instead of being shown as an error the user cannot act on.
    virtual.watchCodexSessionLost(trigger => this.noteCodexSessionLost(trigger))
    let workspace: CodexVirtualWorkspaceView
    try {
      workspace = await virtual.selectWorkspace(workspaceId, signal)
    } catch (error) {
      const code = safeErrorCode(error)
      // The panel opens the id it listed earlier; a replaced domain has since renumbered the same directories, so the
      // id is unknown while the workspace is still there. The root is what survives, and it can come from either the
      // listing that produced the id or the selection this client remembered.
      const listed = this.lastCodexListing.get(targetDeviceId)
      const previousRoot = listed?.find(item => item.workspaceId === workspaceId)?.path
        ?? this.codexWorkspaceRoots.get(`${targetDeviceId}|${workspaceId}`)
        ?? this.lastWorkspaceSelection?.workspacePath
      const inListing = listed?.some(item => item.workspaceId === workspaceId) ?? false
      // Retry the same id with the root as a hint before renumbering anything: the carrier rebuilds its catalog on
      // every call and may number the directory differently than the listing that produced this id.
      if (previousRoot !== undefined) {
        const byRoot = await virtual.selectWorkspace(workspaceId, signal, previousRoot).catch(() => undefined)
        if (byRoot !== undefined) {
          this.logger.info('CodeX workspace opened by root after the id missed', {
            targetDeviceId: shortId(targetDeviceId),
            path: previousRoot,
          })
          await virtual.close()
          return this.openCodexWorkspace(targetDeviceId, byRoot.workspaceId, signal)
        }
      }
      await virtual.close()
      let currentId: string | undefined
      if (previousRoot !== undefined) {
        currentId = await this.codexWorkspaceIdForPath(targetDeviceId, previousRoot).catch(() => undefined)
      }
      if (currentId !== undefined && currentId !== workspaceId) {
        this.logger.info('CodeX workspace reopened under a new id', {
          targetDeviceId: shortId(targetDeviceId),
          path: previousRoot,
        })
        return this.openCodexWorkspace(targetDeviceId, currentId, signal)
      }
      // Nothing to recover with is exactly the case that used to be silent, so say what was known: the code the Host
      // gave, whether that id ever appeared in a listing, and whether a root was available to re-match on.
      const currentListing = this.lastCodexListing.get(targetDeviceId) ?? []
      this.logger.warn('selected CodeX workspace could not be opened', {
        targetDeviceId: shortId(targetDeviceId),
        code,
        inListing,
        hasRoot: previousRoot !== undefined,
        roots: [...this.codexWorkspaceRoots.keys()].filter(key => key.startsWith(`${targetDeviceId}|`)).length,
        listed: listed?.length ?? -1,
        // What was asked for against what the Host currently offers, so the next report needs no second round trip.
        wanted: workspaceId.slice(0, 60),
        root: previousRoot === undefined ? '(none)' : previousRoot,
        current: currentListing.slice(0, 5).map(item => item.workspaceId + '@' + item.path).join(', '),
      })
      throw error instanceof ClientModeError
        ? error
        : new ClientModeError('WORKSPACE_NOT_FOUND', 'The selected CodeX workspace is no longer available.')
    }
    await this.closeCodexVirtual()
    this.codexVirtual = virtual
    this.selectCodexTarget(virtual, remote)
    const preferredSessionId = await virtual.preferredSessionId(signal)
    this.rememberWorkspaceSelection({
      targetDeviceId: remote.target.deviceId,
      workspaceId,
      backend: 'codex',
      ...(workspace.path === undefined ? {} : { workspacePath: workspace.path }),
      ...(preferredSessionId === undefined ? {} : { sessionId: preferredSessionId }),
    })
    this.codexHostsSeen.add(remote.target.deviceId)
    this.logger.info('CodeX virtual workspace opened', { targetDeviceId: shortId(remote.target.deviceId) })
    return { ...this.status(), workspace }
  }

  async createCodexWorkspace(
    targetDeviceId: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const trimmedPath = path.trim()
    if (trimmedPath === '') throw new ClientModeError('INVALID_MESSAGE', 'A CodeX project directory is required.')
    // Registering a project is still browsing: the session only starts once the workspace is actually opened,
    // which promotes this same connection in openCodexWorkspace().
    const remote = await this.ensureBrowsing(targetDeviceId, signal)
    remote.features = await probeRemoteHostFeatures(remote.client, remote.clientVersion)
    if (!remote.features.codex) {
      throw this.remoteCodexUnavailable(targetDeviceId)
    }
    this.assertLocalHarnessCarrierAvailable()
    let result: Record<string, unknown>
    try {
      result = record(await new CodexRemoteClient(remote.client).request('project/create', {
        name: remoteWorkspaceTitle(trimmedPath),
        roots: [{ path: trimmedPath }],
        idempotencyKey: uuidV7(),
      }, signal))
    } catch (error) {
      // Same rule as the listing: a Codex call that failed because the session is gone is a lost session, and
      // it is logged so "why did it move" is answerable without a rerun.
      this.logger.warn('CodeX project could not be registered', {
        targetDeviceId: shortId(targetDeviceId),
        code: failureCode(error),
      })
      if (isCodexSessionLoss(error)) this.noteCodexSessionLost('project-create-failed')
      throw error
    }
    const project = record(result.project)
    if (typeof project.id !== 'string' || project.id.length === 0) {
      throw new ClientModeError('INVALID_MESSAGE', 'The Host returned an invalid CodeX project.')
    }
    return this.openCodexWorkspace(targetDeviceId, codexProjectWorkspaceId(project.id), signal)
  }

  private consumeWorkspaceSelection(selection: RemoteWorkspaceSelection): Record<string, unknown> {
    // The client half opened this selection, so it is the workspace a later reconnect has to republish.
    // It can arrive from the browser's own stored selection rather than from workspaces.open, which is
    // why remembering it here - and not only where we publish it - is what makes the re-baseline work.
    this.lastWorkspaceSelection = { ...selection }
    const pending = this.pendingWorkspaceSelection
    if (pending?.targetDeviceId === selection.targetDeviceId
      && pending.workspaceId === selection.workspaceId
      && (pending.backend ?? 'harness') === (selection.backend ?? 'harness')) {
      this.pendingWorkspaceSelection = undefined
    }
    return this.status()
  }

  async close(): Promise<void> {
    await this.closePreview()
    if (this.closed) return
    this.closed = true
    this.proxySwitch?.selectLocal()
    await this.closePreview()
    this.gatewaySwitch.selectLocal()
    this.pendingWorkspaceSelection = undefined
    await this.closeCodexVirtual()
    this.closeBrowsing()
    await this.closeCodexStreams(this.connected?.client)
    await this.connected?.client.close().catch(() => undefined)
    this.connected = undefined
    this.connectionProgress = undefined
    this.proxySwitch?.restore()
    this.gatewaySwitch.restore()
  }

  private async callRemoteFileViewer(
    endpoint: RemoteFileViewerEndpoint,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const remote = this.connected
    if (remote === undefined || this.status().mode !== 'remote') {
      throw new ClientModeError('REMOTE_NOT_CONNECTED', 'No Remote Host is selected.', true)
    }
    if (!remote.features.fileViewer) {
      throw new ClientModeError('FEATURE_NOT_SUPPORTED', 'The selected Remote Host does not support remote file viewing.')
    }
    return remote.client.rpc('fileviewer.call', { endpoint, payload }, signal)
  }

  private activeRemote(): ConnectedRemote | undefined {
    return this.connected
  }

  private activeCodexRemote(): ConnectedRemote | undefined {
    const remote = this.activeRemote()
    if (remote === undefined) return undefined
    if (!remote.features.codex) {
      return undefined
    }
    return remote
  }

  private async openCodexStream(payload: unknown, signal?: AbortSignal): Promise<unknown> {
    const remote = this.activeCodexRemote()
    const value = record(payload)
    if (typeof value.streamId !== 'string' || value.streamId.length === 0 || value.streamId.length > 128
      || typeof value.threadId !== 'string' || value.threadId.length === 0) {
      throw new ClientModeError('INVALID_MESSAGE', 'A Codex stream and thread are required.')
    }
    if (this.codexStreams.has(value.streamId)) throw new ClientModeError('REQUEST_CONFLICT', 'The Codex stream is already open.')
    let wake = () => undefined
    const stream: CodexLoopbackStream = {
      target: remote === undefined ? { kind: 'local' } : { kind: 'remote', client: remote.client },
      frames: [],
      unsubscribe: () => undefined,
      close: async () => {
        if (remote === undefined) {
          await this.host?.codexCloseStream?.({ streamId: value.streamId }).catch(() => undefined)
          return
        }
        await remote.client.rpc('codex.app.stream.close', { streamId: value.streamId }).catch(() => undefined)
      },
      wake: () => wake(),
    }
    if (remote === undefined) {
      const host = this.requireLocalCodex()
      this.codexStreams.set(value.streamId, stream)
      try {
        const result = await host.codexOpenStream({ streamId: value.streamId, threadId: value.threadId }, this.publishLocalCodexFrame, signal)
        return result
      } catch (error) {
        this.codexStreams.delete(value.streamId)
        stream.wake()
        throw error
      }
    }
    stream.unsubscribe = remote.client.onEvent(event => {
      if (event.event === 'codex.app.frame' && isRecord(event.data) && event.data.streamId === value.streamId) {
        this.appendCodexFrame(stream, event.data)
      }
      if (event.event === 'codex.app.stream.closed' && isRecord(event.data) && event.data.streamId === value.streamId) {
        stream.closed = typeof event.data.reason === 'string' ? event.data.reason : 'closed'
        stream.wake()
      }
    })
    try {
      // Subscribe before opening the Host stream so the first App Server
      // notification cannot race past the loopback listener.
      await remote.client.rpc('codex.app.stream.open', { streamId: value.streamId, threadId: value.threadId }, signal)
    } catch (error) {
      stream.unsubscribe()
      throw error
    }
    this.codexStreams.set(value.streamId, stream)
    return { opened: true, streamId: value.streamId, threadId: value.threadId }
  }

  private readonly publishLocalCodexFrame = async (
    event: 'codex.app.frame' | 'codex.app.stream.closed' | 'codex.app.capability',
    data: CodexAppFrameData | CodexAppStreamClosedData | CodexAppCapabilityData,
  ): Promise<void> => {
    // A capability announcement is one of the events the peer bridge may publish, but this path only carries the
    // frames of streams this runtime opened for its own module; there is nothing local to tell.
    if (event === 'codex.app.capability') return
    const streamId = (data as CodexAppFrameData).streamId
    const stream = this.codexStreams.get(streamId)
    if (stream === undefined || stream.target.kind !== 'local') return
    if (event === 'codex.app.frame') {
      this.appendCodexFrame(stream, data)
      return
    }
    const closed = data as CodexAppStreamClosedData
    stream.closed = typeof closed.reason === 'string' ? closed.reason : 'closed'
    stream.wake()
  }

  private appendCodexFrame(stream: CodexLoopbackStream, data: unknown): void {
    if (!isRecord(data) || !isRecord(data.frame) || typeof data.frame.method !== 'string') return
    if (stream.frames.length >= 256) {
      stream.closed = 'overflow'
    } else {
      stream.frames.push({ method: data.frame.method, params: data.frame.params })
    }
    stream.wake()
  }

  private localCodexAvailable(): boolean {
    return this.host?.codexStatus?.().available === true
  }

  private requireLocalCodex(): Required<Pick<HostAuthorizationControl,
    'codexCall' | 'codexRespond' | 'codexOpenStream' | 'codexCloseStream'
  >> {
    if (!this.localCodexAvailable()
      || this.host?.codexCall === undefined
      || this.host.codexRespond === undefined
      || this.host.codexOpenStream === undefined
      || this.host.codexCloseStream === undefined) {
      throw new ClientModeError('FEATURE_NOT_SUPPORTED', 'Local CodeX is disabled or unavailable on this Host.')
    }
    return {
      codexCall: this.host.codexCall.bind(this.host),
      codexRespond: this.host.codexRespond.bind(this.host),
      codexOpenStream: this.host.codexOpenStream.bind(this.host),
      codexCloseStream: this.host.codexCloseStream.bind(this.host),
    }
  }

  private async nextCodexFrames(payload: unknown, signal?: AbortSignal): Promise<unknown> {
    const value = record(payload)
    if (typeof value.streamId !== 'string') throw new ClientModeError('INVALID_MESSAGE', 'A Codex stream is required.')
    const stream = this.codexStreams.get(value.streamId)
    if (stream === undefined) throw new ClientModeError('STREAM_NOT_FOUND', 'The Codex stream is not open.')
    if (stream.frames.length === 0 && stream.closed === undefined) await waitForCodexFrames(stream, signal)
    const frames = stream.frames.splice(0, 100)
    return {
      streamId: value.streamId,
      frames,
      closed: stream.closed !== undefined,
      ...(stream.closed === undefined ? {} : { reason: stream.closed }),
    }
  }

  private async closeCodexStream(payload: unknown): Promise<unknown> {
    const value = record(payload)
    if (typeof value.streamId !== 'string') throw new ClientModeError('INVALID_MESSAGE', 'A Codex stream is required.')
    const stream = this.codexStreams.get(value.streamId)
    if (stream === undefined) return { closed: false, streamId: value.streamId }
    this.codexStreams.delete(value.streamId)
    stream.unsubscribe()
    stream.wake()
    await stream.close()
    return { closed: true, streamId: value.streamId }
  }

  private async closeCodexStreams(client?: RemoteClientCore): Promise<void> {
    const targets = [...this.codexStreams.entries()].filter(([, stream]) => (
      client === undefined || (stream.target.kind === 'remote' && stream.target.client === client)
    ))
    await Promise.all(targets.map(async ([streamId, stream]) => {
      this.codexStreams.delete(streamId)
      stream.unsubscribe()
      stream.closed = 'peer-disconnected'
      stream.wake()
      await stream.close()
    }))
  }

  private selectRemoteTarget(remote: ConnectedRemote, transport = this.selectHarnessRemoteTransport(remote)): void {
    const target = { deviceId: remote.target.deviceId, name: remote.target.name }
    if (transport === 'remoteGateway') {
      this.gatewaySwitch.selectRemote(this.remoteTypertGateway(remote), undefined, target)
      return
    }
    this.proxySwitch?.selectRemote(new RemoteHarnessApiProxy(remote.client, remote.harnessVersion).api, target)
    this.gatewaySwitch.selectRemote(request => invokeRemoteCommand(remote.client, request), {
      execute: true,
      list: remote.features.commandList,
    }, target)
  }

  private remoteTypertGateway(remote: ConnectedRemote): RemoteTypertGateway {
    const localSessionGeneration = harnessSessionGeneration(this.host?.localHarnessVersion?.())
    return new RemoteTypertGateway(
      remote.client,
      localSessionGeneration === 'v3' && remote.features.sessionFormat !== 3 ? 'legacy-to-v3' : undefined,
      remote.harnessVersion,
    )
  }

  private selectCodexTarget(virtual: CodexVirtualHarness, remote: ConnectedRemote): void {
    const target = { deviceId: remote.target.deviceId, name: remote.target.name }
    // The Harness answers every `/api` endpoint once it is the Codex target, so give it
    // the local carriers: everything outside the CodeX domain (the shell's settings
    // bootstrap, plugin registry and account reads) has to describe this installation.
    virtual.setLocalCarrier(this.gatewaySwitch.localCarrier())
    if (this.gatewaySwitch.supportsCarrier()) {
      this.gatewaySwitch.selectRemote(virtual, undefined, target)
      return
    }
    this.proxySwitch!.selectRemote(virtual.api, target)
    this.gatewaySwitch.selectRemote(request => virtual.invoke(request), { execute: true, list: true }, target)
  }

  private async closeCodexVirtual(): Promise<void> {
    const virtual = this.codexVirtual
    this.codexVirtual = undefined
    await virtual?.close()
  }

  private assertRemoteCompatible(remote: ConnectedRemote): void {
    this.selectHarnessRemoteTransport(remote)
  }

  private selectHarnessRemoteTransport(remote: ConnectedRemote): HarnessRemoteTransport {
    const localRemoteGateway = this.gatewaySwitch.supportsCarrier()
    const localSessionGeneration = harnessSessionGeneration(this.host?.localHarnessVersion?.())
    if (localRemoteGateway && remote.features.remoteGateway) {
      if (localSessionGeneration === 'v3' || remote.features.sessionFormat !== 3) return 'remoteGateway'
      throw new ClientModeError(
        'HARNESS_VERSION_INCOMPATIBLE',
        'The selected Host uses Harness Session V3, but this Client uses the legacy Typert Remote session format.',
      )
    }
    if (this.proxySwitch !== undefined && remote.features.apiProxy) return 'apiProxy'
    throw new ClientModeError(
      'HARNESS_VERSION_INCOMPATIBLE',
      localRemoteGateway
        ? 'The selected Host does not provide a compatible Harness Typert Remote Gateway transport.'
        : 'The selected Host does not provide the legacy Harness ApiProxy transport.',
    )
  }

  private assertLocalHarnessCarrierAvailable(): void {
    if (this.gatewaySwitch.supportsCarrier() || this.proxySwitch !== undefined) return
    throw new ClientModeError(
      'HARNESS_VERSION_INCOMPATIBLE',
      'This Client does not provide a compatible Harness carrier for the selected remote workspace.',
    )
  }

  /**
   * Connect, and report the control switch when that is what refused us.
   *
   * A device whose control switch is off has its host connection refused by the Server. Its presence may still read
   * online, so the failure comes back from whichever transport step gave up first - "adaptive transport has not been
   * authorized", "the authenticated Noise channel is not connected", "the selected Host is offline" - and none of
   * them name the switch. The device row does, so a failed attempt is re-read against it; an error that already names
   * a cause is passed through untouched.
   * @param targetDeviceId - the Host being connected to.
   * @param signal - aborts the attempt.
   * @param forceRelay - skips direct negotiation, as the reconnect window does.
   * @returns the connected remote session.
   */
  private async connectWithReason(targetDeviceId: string, signal?: AbortSignal, forceRelay = false): Promise<ConnectedRemote> {
    try {
      return await this.connect(targetDeviceId, signal, forceRelay)
    } catch (error) {
      if (safeErrorCode(error) === 'CONTROL_DISABLED') throw error
      const row = await this.server.listDevices()
        .then(list => list.find(device => device.deviceId === targetDeviceId))
        .catch(() => undefined)
      if (row?.hostControl === false) throw offlineConnectionError(false)
      throw error
    }
  }

  private async connect(targetDeviceId: string, signal?: AbortSignal, forceRelay = false): Promise<ConnectedRemote> {
    signal?.throwIfAborted()
    const progressRunId = this.connectionProgressRun + 1
    this.connectionProgressRun = progressRunId
    this.connectionProgress = { runId: progressRunId, targetDeviceId, phase: 'checking-host' }
    const identity = this.requireIdentity()
    let client: RemoteClientCore | undefined
    try {
      const serverDevice = (await this.server.listDevices()).find(device => device.deviceId === targetDeviceId)
      if (serverDevice === undefined) {
        throw new ClientModeError('MEMBERSHIP_REQUIRED', 'The selected Host is not authorized for this account.')
      }
      this.updateConnectionProgress(progressRunId, 'authorizing-peer')
      const target = await this.authorizeHostPeer(serverDevice)
      const presence = await this.server.presenceFor(targetDeviceId)
      if (!presence.online) throw offlineConnectionError(serverDevice.hostControl)
      const credentials = await this.server.authenticate(identity)
      const rtcFactory = this.config.forceRelay
        ? undefined
        : await this.rtcFactoryProvider({ routeTargets: [this.server.baseUrl] }).catch(() => undefined)
      if (!this.config.forceRelay && rtcFactory === undefined) {
        this.logger.warn('remote Harness WebRTC backend unavailable; using relay', {
          targetDeviceId: shortId(target.deviceId),
        })
      }
      let webRtcFallback = false
      const createTransport = (attempt: TransportAttempt): AdaptiveTransport => new AdaptiveTransport(
        websocketUrl(this.server.baseUrl),
        {
          role: 'client',
          deviceId: identity.deviceId,
          accessToken: credentials.accessToken,
          targetDeviceId,
          forceRelay: forceRelay || this.config.forceRelay || attempt === 'relay',
          preferredTransports: preferredTransportsForAttempt(attempt),
          negotiateTimeoutMs: attempt === 'direct' ? DIRECT_WEBRTC_NEGOTIATE_TIMEOUT_MS : undefined,
          ...(rtcFactory === undefined || attempt === 'relay' ? {} : { rtcFactory }),
          fetchIceServers: async connectionId => iceServersForAttempt(attempt, await this.server.turnCredentials(connectionId)),
          onWebRtcFallback: (error, diagnostics) => {
            webRtcFallback = true
            this.logger.warn(attempt === 'direct'
              ? 'remote Harness direct WebRTC failed; trying TURN'
              : 'remote Harness TURN WebRTC failed; using relay', {
              targetDeviceId: shortId(target.deviceId),
              attempt,
              reason: diagnosticReason(error),
            })
            if (diagnostics !== undefined) {
              this.logger.debug('remote Harness WebRTC fallback diagnostics', {
                targetDeviceId: shortId(target.deviceId),
                attempt,
                ...webrtcDiagnosticsLogFields(diagnostics),
              })
            }
          },
        },
      )
      const attempts: TransportAttempt[] = this.config.forceRelay || rtcFactory === undefined
        ? ['relay']
        : ['direct', 'turn', 'relay']
      let transport: AdaptiveTransport | undefined
      for (const attempt of attempts) {
        webRtcFallback = false
        const stopProgressTimer = this.beginAttemptProgress(progressRunId, attempt)
        try {
          transport = createTransport(attempt)
          client = new RemoteClientCore(new ClientSecureTransport(transport, identity, target), 60_000)
          await client.connect()
          signal?.throwIfAborted()
        } finally {
          stopProgressTimer()
        }
        if (attempt === 'relay' || !webRtcFallback) break
        await client.close()
        client = undefined
        transport = undefined
        if (attempt === 'turn') {
          this.logger.info('remote Harness relay fallback re-established', {
            targetDeviceId: shortId(target.deviceId),
          })
        }
      }
      if (client === undefined || transport === undefined) {
        throw new ClientModeError('CONNECTION_FAILED', 'Unable to establish a remote transport.', true)
      }
      const connectedClient = client
      const connectedTransport = transport
      const connectedPreference = transportPreferenceForMode(connectedClient.getStats().mode)
      this.updateConnectionProgress(
        progressRunId,
        'connected',
        connectedPreference === undefined ? undefined : [connectedPreference],
      )
      connectedClient.onClose(() => {
        if (this.supersededClient === connectedClient) {
          this.logger.info('ignoring the close of the transport a reconnect is replacing', {
            targetDeviceId: shortId(target.deviceId),
          })
          return
        }
        // The UI keeps whatever the remote session rendered and offers no exit route once the mode
        // reads 'local' again, so remember that the session dropped: the card uses this to keep a
        // way back to the local shell.
        this.handleRemoteTransportLost(connectedClient, target.deviceId, 'transport-closed')
      })
      const connectionDetails = await connectedTransport.connectionDetails().catch(() => undefined)
      this.logger.info('remote Harness transport ready', {
        targetDeviceId: shortId(target.deviceId),
        transport: connectedClient.getStats().mode,
        ...(connectionDetails === undefined ? {} : {
          preferredTransports: connectionDetails.preferredTransports,
          negotiatedCapabilities: connectionDetails.negotiatedCapabilities,
          webRtcEnabled: connectionDetails.webRtcEnabled,
        }),
      })
      if (connectionDetails?.webRtc?.diagnostics !== undefined) {
        this.logger.debug('remote Harness transport diagnostics', {
          targetDeviceId: shortId(target.deviceId),
          ...webrtcDiagnosticsLogFields(connectionDetails.webRtc.diagnostics),
        })
      }
      const features = await probeRemoteHostFeatures(connectedClient, serverDevice.clientVersion)
      return {
        client: connectedClient,
        target,
        transport: connectedTransport,
        features,
        progressRunId,
        ...(serverDevice.clientVersion === undefined ? {} : { clientVersion: serverDevice.clientVersion }),
        ...(serverDevice.harnessVersion === undefined ? {} : { harnessVersion: serverDevice.harnessVersion }),
      }
    } catch (error) {
      this.clearConnectionProgress(progressRunId)
      await client?.close().catch(() => undefined)
      throw error
    }
  }

  /**
   * Connect for a read-only panel request.
   *
   * Browsing a Host is not a session. This connection never becomes {@link connected}, so a later drop is
   * ignored by the recovery path and the window stays where the user left it. The session's own link is
   * reused when it already points at that Host, because the Server keeps only one control connection per
   * device and role.
   * @param targetDeviceId - the Host being browsed.
   * @param signal - aborts the connection attempt.
   * @returns the connection to read through.
   */
  private async ensureBrowsing(targetDeviceId: string, signal?: AbortSignal): Promise<ConnectedRemote> {
    if (this.connected?.target.deviceId === targetDeviceId) return this.connected
    if (this.browsing?.target.deviceId === targetDeviceId) return this.browsing
    const next = await this.connectWithReason(targetDeviceId, signal)
    const previous = this.browsing
    this.browsing = next
    this.clearConnectionProgress(next.progressRunId)
    await previous?.client.close().catch(() => undefined)
    return next
  }

  /**
   * Drop the panel's browsing connection.
   *
   * Called whenever the user's own decision makes the browse stale: returning to local, signing out, or
   * opening a session somewhere else. A browsing connection is never kept for later.
   * @param except - a browsing connection to keep (the one just promoted to a session).
   */
  private closeBrowsing(except?: ConnectedRemote): void {
    const browsing = this.browsing
    if (browsing === undefined || browsing === except) return
    this.browsing = undefined
    void browsing.client.close().catch(() => undefined)
  }

  private async ensureConnected(targetDeviceId: string, signal?: AbortSignal): Promise<ConnectedRemote> {
    if (this.connected?.target.deviceId === targetDeviceId) return this.connected
    const previous = this.connected
    // The user just opened a workspace on the Host they were browsing: that connection becomes the session
    // instead of a second one being opened for the same device (the Server would replace one of them).
    if (this.browsing?.target.deviceId === targetDeviceId) {
      const next = this.browsing
      this.browsing = undefined
      await this.closePreview()
      this.connected = next
      await previous?.client.close().catch(() => undefined)
      return next
    }
    const next = await this.connectWithReason(targetDeviceId, signal)
    await this.closePreview()
    this.connected = next
    this.clearConnectionProgress(next.progressRunId)
    // The carriers are deliberately NOT re-selected here. `ensureConnected` also serves the open paths before
    // they prove they can succeed, and re-selecting would hand the window this Host's DSH workspace - a view
    // switch nobody asked for. Only the explicit open, or the recovery restoring the session the user was
    // actually watching, may change what is on screen.
    this.closeBrowsing()
    await previous?.client.close().catch(() => undefined)
    return next
  }

  private beginAttemptProgress(runId: number, attempt: TransportAttempt): () => void {
    if (attempt !== 'direct') {
      this.updateConnectionProgress(runId, 'probing', [attempt])
      return () => undefined
    }
    this.updateConnectionProgress(runId, 'probing', ['lan'])
    // LAN and public P2P candidates are gathered inside one ICE attempt. The
    // linear Remote UI still needs a single active route, so advance the
    // visible cue if direct negotiation takes longer than a local probe.
    const timer = setTimeout(() => {
      if (this.connectionProgress?.runId === runId && this.connectionProgress.phase === 'probing') {
        this.updateConnectionProgress(runId, 'probing', ['p2p'])
      }
    }, DIRECT_LAN_PROGRESS_DISPLAY_MS)
    return () => clearTimeout(timer)
  }

  private updateConnectionProgress(
    runId: number,
    phase: ConnectionProgressState['phase'],
    activeTransports?: ConnectionProgressState['activeTransports'],
  ): void {
    if (this.connectionProgress?.runId !== runId) return
    this.connectionProgress = {
      runId,
      targetDeviceId: this.connectionProgress.targetDeviceId,
      phase,
      ...(activeTransports === undefined ? {} : { activeTransports }),
    }
  }

  private clearConnectionProgress(runId: number): void {
    if (this.connectionProgress?.runId === runId) this.connectionProgress = undefined
  }

  async handleControl(endpoint: string, payload: unknown, signal: AbortSignal): Promise<RpcResult<unknown>> {
    try {
      if (endpoint === 'status') return ok(await this.detailedStatus())
      // A client that just came back to the foreground reports its view of the session; the runtime
      // reacts only to a session it already knows is gone, because the Server's link-dropped notice and
      // a failed write are what actually prove a link ended.
      if (endpoint === 'client.connection.verify') return ok(await this.verifyRemoteConnection())
      // The Remote card polls the first while a Host is selected (its capability set is the Host's truth, not
      // this process's memory of it) and calls the second for "Refresh, and fix what can be fixed".
      if (endpoint === 'remote.features.probe') return ok(await this.probeRemoteFeatures())
      if (endpoint === 'remote.session.recover') return ok(await this.recoverCurrentSession())
      if (endpoint === 'client.device.revoke') {
        await this.revokeCurrentDevice()
        return ok(this.status())
      }
      if (endpoint === 'devices') return ok(await this.devices())
      if (endpoint === 'client.account.login') {
        const value = record(payload)
        if (typeof value.email !== 'string' || typeof value.password !== 'string') {
          throw new ClientModeError('INVALID_MESSAGE', 'Email and password are required.')
        }
        return ok(await this.authorizeClientWithAccount(value.email, value.password))
      }
      if (endpoint === 'client.account.qr.start') {
        const value = record(payload)
        const provider = value.provider ?? 'zhihu'
        if (provider !== 'zhihu' && provider !== 'github') {
          throw new ClientModeError('INVALID_MESSAGE', 'A supported OAuth provider is required.')
        }
        return ok(await this.startClientOAuthQrLogin(provider))
      }
      if (endpoint === 'client.account.qr.poll') {
        const value = record(payload)
        if (typeof value.qrId !== 'string' || value.qrId.length < 20) {
          throw new ClientModeError('INVALID_MESSAGE', 'A QR login session is required.')
        }
        return ok(await this.pollClientOAuthQrLogin(value.qrId))
      }
      if (endpoint === 'preview.open') {
        const remote = this.activeRemote()
        if (remote === undefined) throw new ClientModeError('TRANSPORT_CLOSED', 'Connect to a Remote Host first.')
        this.preview ??= new LoopbackPreview(remote.client)
        return ok(await this.preview.open(record(payload).port as number))
      }
      if (endpoint === 'directory.list') {
        const value = record(payload)
        if (typeof value.targetDeviceId !== 'string') throw new ClientModeError('INVALID_MESSAGE', 'A Host is required.')
        return ok(await this.listRemoteDirectory(
          value.targetDeviceId,
          typeof value.path === 'string' ? value.path : undefined,
          signal,
        ))
      }
      if (endpoint === 'workspaces.list') {
        const value = record(payload)
        if (typeof value.targetDeviceId !== 'string') throw new ClientModeError('INVALID_MESSAGE', 'A Host is required.')
        return ok(await this.listRemoteWorkspaces(value.targetDeviceId, signal))
      }
      if (endpoint === 'codex.workspaces.list') {
        const value = record(payload)
        if (typeof value.targetDeviceId !== 'string') throw new ClientModeError('INVALID_MESSAGE', 'A Host is required.')
        return ok(await this.listCodexWorkspaces(value.targetDeviceId, signal))
      }
      if (endpoint === 'workspace.open') {
        const value = record(payload)
        if (typeof value.targetDeviceId !== 'string' || typeof value.path !== 'string') {
          throw new ClientModeError('INVALID_MESSAGE', 'A Host and working directory are required.')
        }
        this.supersedeRemoteRecovery()
        return ok(await this.openRemoteWorkspace(value.targetDeviceId, value.path, signal))
      }
      if (endpoint === 'codex.workspace.open') {
        const value = record(payload)
        if (typeof value.targetDeviceId !== 'string' || typeof value.workspaceId !== 'string') {
          throw new ClientModeError('INVALID_MESSAGE', 'A Host and CodeX Workspace are required.')
        }
        this.supersedeRemoteRecovery()
        return ok(await this.openCodexWorkspace(value.targetDeviceId, value.workspaceId, signal))
      }
      if (endpoint === 'codex.workspace.create') {
        const value = record(payload)
        if (typeof value.targetDeviceId !== 'string' || typeof value.path !== 'string') {
          throw new ClientModeError('INVALID_MESSAGE', 'A Host and CodeX project directory are required.')
        }
        return ok(await this.createCodexWorkspace(value.targetDeviceId, value.path, signal))
      }
      if (endpoint === 'workspace.selection.consume') {
        const value = record(payload)
        if (typeof value.targetDeviceId !== 'string' || typeof value.workspaceId !== 'string') {
          throw new ClientModeError('INVALID_MESSAGE', 'A Host and Workspace are required.')
        }
        return ok(this.consumeWorkspaceSelection({
          targetDeviceId: value.targetDeviceId,
          workspaceId: value.workspaceId,
          ...(value.backend === 'codex' ? { backend: 'codex' } : {}),
          ...(typeof value.sessionId === 'string' ? { sessionId: value.sessionId } : {}),
        }))
      }
      if (endpoint === 'fileviewer.stat' || endpoint === 'fileviewer.readRange' || endpoint === 'fileviewer.list') {
        const method = endpoint === 'fileviewer.stat'
          ? 'stat'
          : endpoint === 'fileviewer.readRange' ? 'readRange' : 'list'
        return ok(await this.callRemoteFileViewer(method, payload, signal))
      }
      if (endpoint === 'codex.call') {
        const value = record(payload)
        if (typeof value.method !== 'string' || !('params' in value)) {
          throw new ClientModeError('INVALID_MESSAGE', 'A Codex method and params are required.')
        }
        const remote = this.activeCodexRemote()
        if (remote !== undefined) return ok(await new CodexRemoteClient(remote.client).request(value.method, value.params, signal))
        const host = this.requireLocalCodex()
        return ok(await host.codexCall(value, signal))
      }
      if (endpoint === 'codex.probe') {
        const local = this.localCodexAvailable()
        let remoteSupported = false
        const remote = this.activeRemote()
        if (remote !== undefined) {
          try {
            remote.features = await probeRemoteHostFeatures(remote.client, remote.clientVersion)
            remoteSupported = remote.features.codex
          } catch (error) {
            if (!local) throw error
          }
        }
        return ok({ supported: local || remoteSupported, local, remote: remoteSupported })
      }
      if (endpoint === 'codex.respond') {
        const value = record(payload)
        const remote = this.activeCodexRemote()
        if (remote !== undefined) return ok(await remote.client.rpc('codex.app.respond', value, signal))
        const host = this.requireLocalCodex()
        return ok(await host.codexRespond(value, signal))
      }
      if (endpoint === 'codex.stream.open') return ok(await this.openCodexStream(payload, signal))
      if (endpoint === 'codex.stream.next') return ok(await this.nextCodexFrames(payload, signal))
      if (endpoint === 'codex.stream.close') return ok(await this.closeCodexStream(payload))
      if (endpoint === 'host.account.login') {
        if (this.host === undefined) throw new ClientModeError('METHOD_NOT_ALLOWED', 'This plugin is not running as a Host.')
        const value = record(payload)
        if (typeof value.email !== 'string' || typeof value.password !== 'string') {
          throw new ClientModeError('INVALID_MESSAGE', 'Email and password are required.')
        }
        return ok(await this.host.authorizeHostWithAccount(value.email, value.password))
      }
      if (endpoint === 'host.authorization.set') {
        const value = record(payload)
        if (typeof value.enabled !== 'boolean') {
          throw new ClientModeError('INVALID_MESSAGE', 'Host authorization state is required.')
        }
        return ok(await this.setHostAuthorization(value.enabled))
      }
      if (endpoint === 'host.registration-code.submit') {
        if (this.host === undefined) throw new ClientModeError('METHOD_NOT_ALLOWED', 'This plugin is not running as a Host.')
        const value = record(payload)
        if (typeof value.code !== 'string' || value.code.trim() === '') {
          throw new ClientModeError('INVALID_MESSAGE', 'A Host registration code is required.')
        }
        return ok(await this.host.authorizeHostWithCode(value.code))
      }
      if (endpoint === 'mode.set') {
        const value = record(payload)
        if (value.mode !== 'local' && value.mode !== 'remote') throw new ClientModeError('INVALID_MESSAGE', 'Mode must be local or remote.')
        return ok(await this.setMode(value.mode, typeof value.targetDeviceId === 'string' ? value.targetDeviceId : undefined, signal))
      }
      throw new ClientModeError('METHOD_NOT_FOUND', 'The remote-mode control method does not exist.')
    } catch (error) {
      return fail(error)
    }
  }

  private requireIdentity(): HostIdentity {
    if (this.identity === undefined) throw new ClientModeError('IDENTITY_INVALID', 'The client identity is not ready.')
    return this.identity
  }

  private async authorizeHostPeer(serverDevice: ServerHostDevice): Promise<TrustedPeer> {
    const descriptor = await this.server.deviceFor(serverDevice.deviceId)
    assertAuthorizedHost(serverDevice, descriptor)
    const existing = this.identities.trustedPeer(descriptor.deviceId)
    if (existing !== undefined && existing.publicKey !== descriptor.identityKey) {
      throw new ClientModeError('PEER_IDENTITY_MISMATCH', 'The authorized Host identity key changed unexpectedly.')
    }
    if (existing !== undefined
      && existing.membershipId === descriptor.membershipId
      && existing.name === descriptor.name
      && existing.platform === descriptor.platform) {
      return existing
    }
    return this.identities.trustPeer({
      deviceId: descriptor.deviceId,
      name: descriptor.name,
      platform: descriptor.platform,
      publicKey: descriptor.identityKey,
      membershipId: descriptor.membershipId,
    })
  }
}

/**
 * The error to report when a Host reads as offline.
 *
 * The Server refuses the host connection of a device whose control switch is off, so presence says offline and the
 * failure surfaces as whichever transport step gave up first - "adaptive transport has not been authorized", "the
 * authenticated Noise channel is not connected", "the selected Host is offline" - none of which name the switch. When
 * the device row says control is off, that is the reason, and saying it is the only part the user can act on.
 * @param hostControl - the Server's control flag for that device, if the row carried one.
 * @returns the error to throw.
 */
export function offlineConnectionError(hostControl: boolean | undefined): ClientModeError {
  return hostControl === false
    ? new ClientModeError(
      'CONTROL_DISABLED',
      'This device is not accepting control. Turn on "Allow other users to control this device" on that device.',
      true,
    )
    : new ClientModeError('HOST_OFFLINE', 'The selected Host is offline.', true)
}

/**
 * Whether a finished reconnect should rebuild a Codex carrier.
 *
 * Only for the same Host, and only when the remembered selection was a Codex workspace: a Harness workspace must
 * not turn into a Codex one, and another Host's selection says nothing about this reconnect.
 * @param selection - the client's last remembered workspace selection, if any.
 * @param targetDeviceId - the Host the reconnect finished against.
 * @returns true when the Codex carrier has to be rebuilt.
 */
/**
 * Whether a Codex RPC failure means the remote session is gone, rather than the request being wrong.
 *
 * Turning the Codex switch off on the Host ends the session in one of two ways, and both are a lost session
 * like any other - the same quick rebuild, local fallback and retry schedule - not an error to show and forget:
 *
 *  - the bridge itself was closed, which answers `CODEX_CONNECTION_CLOSED` / `CODEX_CLOSED`;
 *  - the domain is still there but has no App Server to answer with (switched off, starting, or restarting),
 *    which answers `CODEX_UNAVAILABLE`.
 *
 * The second one is what a switched-off Codex looks like now that the Host keeps a client's bridge across the
 * change, and leaving it out is why the top bar never said "reconnecting" for that switch while it did for the
 * whole-device one - the same thing happening to the user, reported two different ways.
 * The codes are stable on purpose; the prose is not matched against.
 * @param error - whatever the Codex call threw.
 * @returns true when the remote Codex session should be treated as lost.
 */
export function isCodexSessionLoss(error: unknown): boolean {
  // The RpcError the bridge throws carries its code as a plain property, which safeErrorCode does not necessarily
  // surface, so read it first and fall back to the helper for wrapped errors.
  const own = error !== null && typeof error === 'object' && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined
  const code = typeof own === 'string' ? own : safeErrorCode(error)
  return code === 'CODEX_CONNECTION_CLOSED' || code === 'CODEX_CLOSED' || code === 'CODEX_UNAVAILABLE'
}

export function shouldRestoreCodexCarrier(
  selection: { targetDeviceId: string; backend?: string } | undefined,
  targetDeviceId: string,
): boolean {
  return selection !== undefined && selection.targetDeviceId === targetDeviceId && selection.backend === 'codex'
}

export class ClientModeError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) { super(message) }
}

function assertAuthorizedHost(listed: ServerHostDevice, descriptor: AuthorizedPeerDevice): void {
  if (descriptor.deviceId !== listed.deviceId || descriptor.membershipId !== listed.membershipId) {
    throw new ClientModeError('PEER_IDENTITY_MISMATCH', 'Server Host details do not match the authorized device list.')
  }
}

function websocketUrl(baseUrl: string): string {
  const url = new URL(baseUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = `${url.pathname.replace(/\/$/, '')}/ws/v1/connect`
  return url.toString()
}

function webrtcDiagnosticsLogFields(diagnostics: RtcConnectionDiagnostics | undefined): Record<string, unknown> {
  if (diagnostics === undefined) return {}
  return {
    rtcConnectionState: diagnostics.connectionState,
    rtcIceConnectionState: diagnostics.iceConnectionState,
    rtcIceGatheringState: diagnostics.iceGatheringState,
    rtcLocalCandidates: diagnostics.localCandidates,
    rtcRemoteCandidates: diagnostics.remoteCandidates,
    rtcCandidatePairs: diagnostics.candidatePairs,
    rtcFilteredLocalCandidates: diagnostics.filteredLocalCandidates,
    rtcFilteredCandidatePairs: diagnostics.filteredCandidatePairs,
    ...(diagnostics.selectedPath === undefined ? {} : { rtcSelectedPath: diagnostics.selectedPath }),
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ClientModeError('INVALID_MESSAGE', 'The control request payload is invalid.')
  }
  return value as Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function ok(value: unknown): RpcResult<unknown> { return { ok: true, value } }

async function invokeRemoteCommand(
  client: RemoteClientCore,
  request: Parameters<TypertGatewayLike['invoke']>[0],
): Promise<unknown> {
  const rpcId = uuidV7()
  const response = await client.rpc<{ rpcId: string; result: unknown }>('harness.api.call', {
    method: `${request.namespace}.${request.method}`,
    rpcId,
    payload: request.args,
  }, request.signal)
  if (response.rpcId !== rpcId) {
    throw new ClientModeError('INVALID_MESSAGE', 'The remote Host returned an invalid command response.')
  }
  return unwrapNativeResult(response)
}

async function readRemoteWorkspaceBaseline(
  gateway: RemoteTypertGateway,
  signal?: AbortSignal,
): Promise<RemoteWorkspaceView[]> {
  const lifetime = new AbortController()
  const activeSignal = signal === undefined
    ? lifetime.signal
    : AbortSignal.any([signal, lifetime.signal])
  const source = await gateway.open('workspace/follow', { args: {} }, activeSignal)
  const iterator = source[Symbol.asyncIterator]()
  try {
    const first = await iterator.next()
    if (first.done || !isRecord(first.value) || first.value.type !== 'baseline'
      || !isRecord(first.value.value) || !Array.isArray(first.value.value.items)) {
      throw new ClientModeError('INVALID_MESSAGE', 'The remote Host returned an invalid Workspace baseline.')
    }
    return first.value.value.items.map((item: unknown) => {
      if (!isRecord(item) || typeof item.workspaceId !== 'string'
        || typeof item.path !== 'string' || typeof item.title !== 'string') {
        throw new ClientModeError('INVALID_MESSAGE', 'The remote Host returned an invalid Workspace row.')
      }
      return { workspaceId: item.workspaceId, path: item.path, title: item.title }
    })
  } finally {
    lifetime.abort('workspace-baseline-read')
    await iterator.return?.()
  }
}

function unwrapNativeResult<T>(response: { result: unknown }): T {
  const result = response.result
  if (typeof result !== 'object' || result === null || !('ok' in result)) {
    throw new ClientModeError('INVALID_MESSAGE', 'The remote Host returned an invalid response.')
  }
  if (result.ok !== true || !('value' in result)) {
    const message = 'error' in result && typeof result.error === 'object' && result.error !== null
      && 'message' in result.error && typeof result.error.message === 'string'
      ? result.error.message
      : 'The remote Host rejected the request.'
    throw new ClientModeError('REMOTE_API_ERROR', message)
  }
  return result.value as T
}

function workspaceRecordId(value: unknown): string {
  if (typeof value !== 'object' || value === null || !('workspaceId' in value)
    || typeof value.workspaceId !== 'string' || value.workspaceId.length === 0) {
    throw new ClientModeError('INVALID_MESSAGE', 'The remote Host returned an invalid Workspace.')
  }
  return value.workspaceId
}

function remoteWorkspaceTitle(path: string): string {
  const normalized = path.replace(/[\\/]+$/u, '')
  return normalized.split(/[\\/]+/u).filter(Boolean).at(-1) ?? path
}

function fail(error: unknown): RpcResult<unknown> {
  const source = error instanceof Error ? error : undefined
  const remoteCode = source !== undefined && 'code' in source && typeof source.code === 'string'
    ? source.code
    : source instanceof ClientModeError ? source.code : undefined
  const retryable = source !== undefined && 'retryable' in source && typeof source.retryable === 'boolean'
    ? source.retryable
    : source instanceof ClientModeError ? source.retryable : false
  return {
    ok: false,
    error: {
      code: 'internal',
      message: source?.message ?? 'The remote-mode operation failed.',
      details: remoteCode === undefined ? {} : { remoteCode, retryable },
    },
  }
}

function shortId(value: string): string { return value.length <= 12 ? value : `${value.slice(0, 8)}…${value.slice(-4)}` }

/**
 * The stable code of a failure, including this runtime's own errors.
 *
 * `safeErrorCode` only recognises the shared error types, so a `ClientModeError` - which is what every
 * deliberate refusal in this file is - read as INTERNAL_ERROR in the log. The code is a plain identifier
 * (never a message, token or payload), which is exactly what the log is allowed to carry.
 * @param error - whatever was thrown.
 * @returns the code to log.
 */
function failureCode(error: unknown): string {
  const own = error !== null && typeof error === 'object' && 'code' in error
    && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined
  return own ?? safeErrorCode(error)
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>(resolve => { setTimeout(resolve, ms) })
}

/** Conservative feature profile for Hosts that predate fine-grained capability discovery. */
export function remoteHostFeatures(clientVersion?: string): RemoteHostFeatures {
  return {
    commandList: isVersionAtLeast(clientVersion, REMOTE_COMMAND_LIST_MIN_VERSION),
    fileViewer: isVersionAtLeast(clientVersion, REMOTE_FILE_VIEWER_MIN_VERSION),
    terminal: false,
    apiProxy: true,
    remoteGateway: false,
    codex: false,
  }
}

export async function probeRemoteHostFeatures(
  client: RemoteClientCore,
  clientVersion?: string,
): Promise<RemoteHostFeatures> {
  const fallback = remoteHostFeatures(clientVersion)
  let value: unknown
  try {
    value = await client.rpc('harness.transport.describe', {})
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'METHOD_NOT_FOUND') return fallback
    throw error
  }
  if (!isRecord(value) || !Array.isArray(value.capabilities)
    || value.capabilities.some(capability => typeof capability !== 'string')) {
    throw new ClientModeError('INVALID_MESSAGE', 'The remote Host returned invalid transport capabilities.')
  }
  const capabilities = new Set(value.capabilities as string[])
  const apiProxy = capabilities.has('harness.api.v1')
  const remoteV1 = capabilities.has('harness.remote.v1')
  const remoteV3 = capabilities.has('harness.remote.v3')
  const terminal = capabilities.has('harness.terminal.v1')
  const codex = capabilities.has('codex.appserver.v1')
  if (remoteV1 && remoteV3) {
    throw new ClientModeError('INVALID_MESSAGE', 'The remote Host advertised conflicting Harness Session formats.')
  }
  const sessionFormat = remoteV3 ? 3 as const : undefined
  const remoteGateway = remoteV3 || remoteV1
  if (!apiProxy && !remoteGateway && !codex) {
    throw new ClientModeError('FEATURE_NOT_SUPPORTED', 'The remote Host exposes no supported Harness transport.')
  }
  return {
    commandList: remoteGateway || (apiProxy && fallback.commandList),
    fileViewer: capabilities.has('fileviewer.read.v1'),
    terminal,
    apiProxy,
    remoteGateway,
    ...(sessionFormat === undefined ? {} : { sessionFormat }),
    codex,
  }
}

async function waitForCodexFrames(stream: CodexLoopbackStream, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new ClientModeError('RPC_ABORTED', 'The Codex event poll was cancelled.')
  await new Promise<void>((resolve, reject) => {
    const previousWake = stream.wake
    const timer = setTimeout(done, 25_000)
    const onAbort = () => {
      cleanup()
      reject(new ClientModeError('RPC_ABORTED', 'The Codex event poll was cancelled.'))
    }
    function cleanup() {
      clearTimeout(timer)
      stream.wake = previousWake
      signal?.removeEventListener('abort', onAbort)
    }
    function done() {
      cleanup()
      resolve()
    }
    stream.wake = () => {
      previousWake()
      done()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function isVersionAtLeast(value: string | undefined, minimum: readonly [number, number, number]): boolean {
  const match = value?.match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/)
  if (match === undefined || match === null) return false
  const version = match.slice(1, 4).map(part => Number(part))
  for (let index = 0; index < minimum.length; index += 1) {
    const part = version[index] ?? 0
    const expected = minimum[index] ?? 0
    if (part > expected) return true
    if (part < expected) return false
  }
  return true
}

function diagnosticReason(error: Error): string {
  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined
  const message = error.message.replace(/[\r\n\t]+/g, ' ').slice(0, 240)
  return code === undefined ? message : `${code}: ${message}`
}

function preferredTransportsForAttempt(attempt: TransportAttempt): Array<'lan' | 'p2p' | 'turn' | 'relay'> {
  if (attempt === 'direct') return ['lan', 'p2p', 'relay']
  if (attempt === 'turn') return ['turn', 'relay']
  return ['relay']
}

function transportPreferenceForMode(
  mode: 'LAN' | 'P2P' | 'TURN' | 'Relay' | 'Disconnected',
): 'lan' | 'p2p' | 'turn' | 'relay' | undefined {
  if (mode === 'LAN') return 'lan'
  if (mode === 'P2P') return 'p2p'
  if (mode === 'TURN') return 'turn'
  if (mode === 'Relay') return 'relay'
  return undefined
}

function iceServersForAttempt(attempt: TransportAttempt, iceServers: RtcIceServer[]): RtcIceServer[] {
  return attempt === 'direct' ? stunOnlyIceServers(iceServers) : iceServers
}

import type {
  LegacyWireStreamOpen,
  LocalTypertGateway,
  Rc1WireStreamOpen,
  RemoteTypertGatewayTarget,
  TypertGatewayLike,
  TypertGatewayRequest,
  TypertRpcResult,
} from './typert-gateway-contract.js'

type RemoteInvoke = (request: TypertGatewayRequest) => Promise<unknown>
type CarrierDispatch = (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<TypertRpcResult>
type CarrierOpen = (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<AsyncIterable<unknown>>

/**
 * dsh 0.1.7-rc.1 private carrier dispatcher:
 * `openWireStream(endpoint, payload, uplink, peer, signal, control)`. The public
 * `wireStream.open` omits `control`; both move the signal out of the third slot.
 */
type Rc1OpenWireStream = (
  endpoint: string,
  payload: unknown,
  uplink: AsyncIterable<unknown>,
  peer: unknown,
  signal: AbortSignal,
  control: AbortController,
) => Promise<AsyncIterable<unknown>>

interface RuntimeGateway extends TypertGatewayLike {
  // Alpha Connection adapters call these prototype methods dynamically.
  dispatchRpc?: CarrierDispatch
  openWireStream?: CarrierOpen | Rc1OpenWireStream
}

const REMOTE_COMMAND_METHODS = ['execute', 'list'] as const
const LOCAL_ONLY_NAMESPACES = new Set(['dynamicCordisRunner'])

export interface RemoteCommandSupport {
  execute: boolean
  list: boolean
}

const ALL_REMOTE_COMMANDS: RemoteCommandSupport = { execute: true, list: true }

/** Keeps the official Gateway object stable while its selected Host changes. */
export class TypertGatewaySwitch {
  private readonly runtime: RuntimeGateway
  private readonly originalInvoke: TypertGatewayLike['invoke']
  private readonly localInvoke: TypertGatewayLike['invoke']
  private readonly originalStream?: NonNullable<TypertGatewayLike['stream']>
  private readonly localStream?: NonNullable<TypertGatewayLike['stream']>
  private readonly originalDispatch?: CarrierDispatch
  private readonly localDispatch?: CarrierDispatch
  private readonly originalOpen?: CarrierOpen | Rc1OpenWireStream
  private readonly localOpen?: CarrierOpen
  private remoteInvoke?: RemoteInvoke
  private remoteTarget?: RemoteTypertGatewayTarget
  private remoteSupport: RemoteCommandSupport = { execute: false, list: false }
  private target?: { deviceId: string; name: string }
  private installed = false
  /** Defaults to reachable so a caller that never wires this keeps the old behaviour. */
  private remoteAvailability: () => boolean = () => true

  constructor(gateway: TypertGatewayLike) {
    this.runtime = gateway as RuntimeGateway
    this.originalInvoke = gateway.invoke
    this.localInvoke = this.originalInvoke.bind(gateway)
    this.originalStream = gateway.stream
    this.localStream = gateway.stream?.bind(gateway)
    this.originalDispatch = this.runtime.dispatchRpc
    this.localDispatch = this.runtime.dispatchRpc?.bind(gateway)
    this.originalOpen = this.runtime.openWireStream
    this.localOpen = createLocalOpen(gateway, this.runtime)
  }

  /** Original local dispatcher, used by the Host bridge without switch recursion. */
  local(): LocalTypertGateway {
    const dispatch: CarrierDispatch = this.localDispatch ?? (async (endpoint, payload, signal) => {
      try {
        const request = requestFromCarrier(endpoint, payload, signal)
        return { ok: true, value: await this.localInvoke(request) }
      } catch (error) {
        return { ok: false, error: this.failure(error) }
      }
    })
    const open: CarrierOpen = this.localOpen ?? (async (endpoint, payload, signal) => {
      if (this.localStream === undefined) throw new Error('The local Harness Gateway does not support Remote streams.')
      return this.localStream(requestFromCarrier(endpoint, payload, signal))
    })
    return {
      invoke: this.localInvoke,
      ...(this.localStream === undefined ? {} : { stream: this.localStream }),
      dispatch,
      open,
      failure: error => this.failure(error),
      supportsCarrier: this.localDispatch !== undefined && this.localOpen !== undefined,
    }
  }

  supportsCarrier(): boolean {
    return this.localDispatch !== undefined && this.localOpen !== undefined
  }

  status(): { mode: 'local' | 'remote'; target?: { deviceId: string; name: string } } {
    return this.remoteInvoke === undefined
      ? { mode: 'local' }
      : { mode: 'remote', ...(this.target === undefined ? {} : { target: { ...this.target } }) }
  }

  install(): void {
    if (this.installed) return
    this.runtime.invoke = request => this.selectInvoke(request)
    if (this.originalStream !== undefined) {
      this.runtime.stream = request => !this.routesToRemote(endpointOf(request))
        ? this.localStream!(request)
        : this.withLocalFallback(
          endpointOf(request),
          () => this.remoteTarget!.open(endpointOf(request), { args: request.args }, request.signal ?? new AbortController().signal),
          () => this.localStream!(request),
        )
    }
    if (this.originalDispatch !== undefined) {
      this.runtime.dispatchRpc = (endpoint, payload, signal) => !this.routesToRemote(endpoint)
        ? this.localDispatch!(endpoint, payload, signal)
        : this.withLocalFallback(
          endpoint,
          () => Promise.resolve(this.remoteTarget!.dispatch(endpoint, payload, signal)),
          () => this.localDispatch!(endpoint, payload, signal),
        )
    }
    if (this.originalOpen !== undefined) {
      const open = this.originalOpen
      const rc1 = usesRc1Arity(open)
      this.runtime.openWireStream = (...callArgs: unknown[]) => {
        const endpoint = callArgs[0] as string
        if (!this.routesToRemote(endpoint)) {
          return rc1
            ? Reflect.apply(open, this.runtime, callArgs) as Promise<AsyncIterable<unknown>>
            : (open as CarrierOpen).call(this.runtime, endpoint, callArgs[1], callArgs[2] as AbortSignal)
        }
        const signal = (rc1 ? callArgs[4] : callArgs[2]) as AbortSignal | undefined
        if (!rc1) {
          // The legacy carrier returns an iterable, so a rejection cannot be caught and
          // the local fallback stays unavailable on that arity.
          return this.remoteTarget!.open(endpoint, callArgs[1], signal ?? new AbortController().signal)
        }
        return this.withLocalFallback(
          endpoint,
          () => this.remoteTarget!.open(endpoint, callArgs[1], signal ?? new AbortController().signal),
          () => Reflect.apply(open, this.runtime, callArgs) as Promise<AsyncIterable<unknown>>,
        )
      }
    }
    this.installed = true
  }

  selectRemote(
    remote: RemoteInvoke | RemoteTypertGatewayTarget,
    support: RemoteCommandSupport = ALL_REMOTE_COMMANDS,
    target?: { deviceId: string; name: string },
  ): void {
    if (!this.installed) throw new Error('The Typert gateway switch is not installed.')
    this.remoteInvoke = typeof remote === 'function' ? remote : request => remote.invoke(request)
    this.remoteTarget = typeof remote === 'function' ? undefined : remote
    this.remoteSupport = { ...support }
    this.target = target === undefined ? undefined : { ...target }
  }

  selectLocal(): void {
    this.remoteInvoke = undefined
    this.remoteTarget = undefined
    this.remoteSupport = { execute: false, list: false }
    this.target = undefined
  }

  /**
   * The local shell's carriers, for a remote target that owns only part of the
   * endpoint space. The Codex virtual Harness owns the CodeX domain; the shell's own
   * settings bootstrap, plugin registry and account reads must stay here, or the
   * window describes the remote Host instead of this installation.
   * @returns the captured local carriers, absent when the running release has none.
   */
  localCarrier(): { dispatch?: CarrierDispatch; open?: CarrierOpen } {
    return {
      ...(this.localDispatch === undefined ? {} : { dispatch: this.localDispatch }),
      ...(this.localOpen === undefined ? {} : { open: this.localOpen }),
    }
  }

  restore(): void {
    if (!this.installed) return
    this.selectLocal()
    this.runtime.invoke = this.originalInvoke
    if (this.originalStream !== undefined) this.runtime.stream = this.originalStream
    if (this.originalDispatch !== undefined) this.runtime.dispatchRpc = this.originalDispatch
    if (this.originalOpen !== undefined) this.runtime.openWireStream = this.originalOpen
    this.installed = false
  }

  /**
   * Whether the peer a remote target routes to is reachable right now.
   *
   * A remote-mode boot still needs its own local services — localizations, theme,
   * the plugin registry — before any remote work can happen. Routing those to a
   * peer that is not connected leaves them unanswered, so the whole shell fails to
   * activate: a dropped connection becomes "the application is unavailable" and
   * stays that way until the user restarts into local mode. Serve local while the
   * peer is away; the live session takes over again as soon as it is reachable.
   */
  setRemoteAvailability(check: () => boolean): void { this.remoteAvailability = check }

  private routesToRemote(endpoint: string): boolean {
    return this.remoteTarget !== undefined && !isLocalOnlyEndpoint(endpoint) && this.remoteAvailability()
  }

  private selectInvoke(request: TypertGatewayRequest): Promise<unknown> {
    if (isLocalOnlyEndpoint(endpointOf(request))) return this.localInvoke(request)
    if (this.remoteTarget !== undefined && this.remoteAvailability()) {
      // A remote-mode boot still issues RPCs only the local shell can answer: the
      // Desktop asks the local Web server for its locale bootstrap before any remote
      // work happens. Sweeping those to the peer failed as "desktop welcome: Web RPC
      // failed", the locale plugin failed with it, and 48 entries never activated.
      // Serve locally when the peer does not implement the endpoint, or when it went
      // away mid-call; a business error still propagates.
      return this.remoteTarget.invoke(request).catch(error => {
        if (!isUnansweredByPeer(error)) throw error
        console.warn(`[dsh-remote] serving ${endpointOf(request)} locally: the peer did not answer it`, error)
        return this.localInvoke(request)
      })
    }
    if (request.namespace !== 'commands' || !isRemoteCommandMethod(request.method) || this.remoteInvoke === undefined) {
      return this.localInvoke(request)
    }
    if (!this.remoteAvailability()) return this.localInvoke(request)
    if (this.remoteSupport[request.method]) return this.remoteInvoke(request)
    if (request.method === 'list') return Promise.resolve([])
    return this.localInvoke(request)
  }

  /**
   * Run a remote call, and answer it locally when the peer turns out not to serve
   * that endpoint. A remote-mode boot still issues RPCs only the local shell can
   * answer: the Desktop asks the local Web server for its locale bootstrap over the
   * remote mux before any remote work happens. Forwarding those swept them to a host
   * that does not implement them, the locale plugin failed, and every entry
   * depending on it stayed pending. A genuine business error still propagates.
   * @param endpoint - endpoint being routed, for the diagnostic warning.
   * @param remote - the remote carrier call.
   * @param local - the local call used when the peer could not answer.
   * @returns the remote or local result.
   */
  private withLocalFallback<T>(endpoint: string, remote: () => Promise<T>, local: () => T | Promise<T>): Promise<T> {
    return remote().catch(error => {
      if (!isUnansweredByPeer(error)) throw error
      console.warn(`[dsh-remote] serving ${endpoint} locally: the peer did not answer it`, error)
      return local()
    })
  }

  private failure(error: unknown): { code: string; message: string; details: Record<string, unknown> } {
    const normalized = this.runtime.wireStream?.failure(error)
    if (normalized !== undefined) return normalized
    const source = error instanceof Error ? error : new Error('The Harness Gateway rejected the request.')
    const code = 'code' in source && typeof source.code === 'string' ? source.code : 'internal'
    const details = 'details' in source && isRecord(source.details) ? source.details : {}
    return { code, message: source.message, details }
  }
}

/**
 * dsh 0.1.7-rc.1 moved the cancellation signal from the third parameter to the
 * fifth; legacy releases keep `(endpoint, payload, signal)`.
 * @param open - carrier opener captured from the running release.
 * @returns whether the opener follows the rc.1 argument order.
 */
function usesRc1Arity(open: { readonly length: number }): boolean {
  return open.length >= 5
}

/** An uplink nobody sends on, so a read-only stream opens without buffering. */
function endedUplink(): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<unknown> {
      return { next: () => Promise.resolve({ done: true, value: undefined }) }
    },
  }
}

/** Controller aborted with the logical stream so the rc.1 carrier owns one lifetime. */
function linkControl(signal: AbortSignal): AbortController {
  const control = new AbortController()
  if (signal.aborted) control.abort(signal.reason)
  else signal.addEventListener('abort', () => control.abort(signal.reason), { once: true })
  return control
}

/**
 * Adapt the running release's carrier opener to the plugin's 3-argument
 * `(endpoint, payload, signal)` seam without leaking the argument displacement.
 * @param gateway - official Gateway whose public `wireStream` is the fallback.
 * @param runtime - Gateway object owning the private `openWireStream` dispatcher.
 * @returns a local opener that carries the signal to the release's signal slot.
 */
function createLocalOpen(gateway: TypertGatewayLike, runtime: RuntimeGateway): CarrierOpen | undefined {
  const open = runtime.openWireStream
  if (open !== undefined) {
    return usesRc1Arity(open)
      ? (endpoint, payload, signal) => (open as Rc1OpenWireStream)
        .call(runtime, endpoint, payload, endedUplink(), undefined, signal, linkControl(signal))
      : (endpoint, payload, signal) => (open as CarrierOpen).call(runtime, endpoint, payload, signal)
  }
  const wire = gateway.wireStream
  if (wire === undefined) return undefined
  const wireOpen = wire.open
  if (usesRc1Arity(wireOpen)) {
    const rc1 = wireOpen as Rc1WireStreamOpen
    return (endpoint, payload, signal) => rc1.call(wire, endpoint, payload, endedUplink(), undefined, signal)
  }
  const legacy = wireOpen as LegacyWireStreamOpen
  return (endpoint, payload, signal) => legacy.call(wire, endpoint, payload, signal)
}

function requestFromCarrier(endpoint: string, payload: unknown, signal: AbortSignal): TypertGatewayRequest {
  const segments = endpoint.split('/')
  if (segments.length !== 2 || segments.some(segment => segment.length === 0)) {
    throw new Error('The Harness Gateway endpoint is invalid.')
  }
  if (!isRecord(payload) || !isRecord(payload.args)) {
    throw new Error('The Harness Gateway payload is invalid.')
  }
  return { namespace: segments[0]!, method: segments[1]!, args: payload.args, signal }
}

function endpointOf(request: TypertGatewayRequest): string {
  return `${request.namespace}/${request.method}`
}

function isLocalOnlyEndpoint(endpoint: string): boolean {
  const separator = endpoint.indexOf('/')
  return separator > 0 && LOCAL_ONLY_NAMESPACES.has(endpoint.slice(0, separator))
}

function isRemoteCommandMethod(method: string): method is typeof REMOTE_COMMAND_METHODS[number] {
  return (REMOTE_COMMAND_METHODS as readonly string[]).includes(method)
}

/**
 * Whether the peer cannot answer this call at all, as opposed to answering with a
 * refusal. An unimplemented endpoint (a local-only concern the switch forwarded
 * anyway) and a connection that dropped mid-call are both permissionless to retry
 * locally; a business error such as a denied permission is not.
 * @param error - rejection from the remote carrier.
 * @returns whether the local shell should answer the call instead.
 */function isUnansweredByPeer(error: unknown): boolean {
  // A wrapped carrier failure such as "Web RPC failed" often arrives with no code at
  // all, and refusing to fall back there would leave the local shell unanswered. The
  // warning emitted at the call site keeps the decision visible in DevTools.
  if (!isRecord(error)) return error instanceof Error
  const code = typeof error.code === 'string' ? error.code : ''
  return code === '' || UNANSWERED_BY_PEER_CODES.has(code)
}

const UNANSWERED_BY_PEER_CODES = new Set([
  'METHOD_NOT_ALLOWED',
  'METHOD_NOT_FOUND',
  'method-not-found',
  'not-implemented',
  'CONNECTION_FAILED',
  'CONNECTION_REPLACED',
  'NOT_CONNECTED',
  'UNAVAILABLE',
  'internal',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

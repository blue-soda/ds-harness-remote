import { Buffer } from 'node:buffer'
import type {
  HarnessApiTransferChunkParams,
  HarnessApiTransferCommitResult,
  HarnessApiTransferOpenParams,
  HarnessApiTransferReadParams,
  HarnessApiTransferReadResult,
  HarnessRemoteCallParams,
  HarnessRemoteFrameData,
  HarnessRemoteStreamClosedData,
  HarnessRemoteStreamOpenParams,
} from '@dsh-remote/protocol'
import {
  HARNESS_API_TRANSFER_CHUNK_BYTES,
  MAX_ACTIVE_TRANSFERS_PER_DIRECTION,
  MAX_ALPHA_STREAMS_PER_CONNECTION,
  MAX_HARNESS_API_TRANSFER_BYTES,
  MAX_SECURE_MESSAGE_BYTES,
  TRANSFER_IDLE_MS,
} from '@dsh-remote/protocol'
import { z } from 'zod'
import { TerminalPolicy, TERMINAL_CALLS, TERMINAL_STREAMS } from './terminal-policy.js'
import { harnessSessionGeneration } from './harness-version.js'
import type { SafeLogger } from './logging.js'
import { listRemoteDirectory } from './remote-directory-browser.js'
import { RpcError } from './rpc-router.js'
import { collectRpcAttachments } from './rpc-binary-attachments.js'
import type { LocalTypertGateway, TypertRpcResult } from './typert-gateway-contract.js'
import { CodexWorkspaceBridge } from './codex-workspace-bridge.js'

type PublishRemoteFrame = (
  event: 'harness.remote.frame' | 'harness.remote.stream.closed',
  data: HarnessRemoteFrameData | HarnessRemoteStreamClosedData,
) => Promise<void>

interface ActiveRemoteStream {
  controller: AbortController
}

interface IncomingTransfer {
  totalBytes: number
  totalChunks: number
  chunks: Uint8Array[]
  receivedBytes: number
  touchedAt: number
}

interface OutgoingTransfer {
  bytes: Uint8Array
  totalChunks: number
  nextIndex: number
  touchedAt: number
}

const endpointSchema = z.string().min(1).max(128).regex(/^(?:\$events(?:\/result)?|[A-Za-z0-9_$.-]+\/[A-Za-z0-9_$.-]+)$/)
const callSchema = z.object({ endpoint: endpointSchema, payload: z.unknown() }).strict()
const streamOpenSchema = z.object({
  streamId: z.string().min(1).max(128),
  endpoint: endpointSchema,
  payload: z.unknown(),
}).strict()
const streamCloseSchema = z.object({ streamId: z.string().min(1).max(128) }).strict()
const commandExecuteArgsSchema = z.object({
  agentId: z.string().min(1).max(128),
  line: z.string().min(1).max(2048),
  // dsh-commands <= 0.1.2 calls this field `images`; dsh-commands 0.1.5
  // renamed it to `submittedAttachments`. Only empty arrays are exposed by
  // the Remote bridge; command attachments are deliberately out of scope.
  images: z.array(z.never()).length(0).optional(),
  submittedAttachments: z.array(z.never()).length(0).optional(),
}).strict().superRefine((value, context) => {
  if (value.images !== undefined && value.submittedAttachments !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Use either images or submittedAttachments, not both.',
      path: ['submittedAttachments'],
    })
  }
})
const commandExecutePayloadSchema = z.object({ args: commandExecuteArgsSchema }).strict()
const transferOpenSchema = z.object({
  transferId: z.string().uuid(),
  totalBytes: z.number().int().positive().max(MAX_HARNESS_API_TRANSFER_BYTES),
  totalChunks: z.number().int().positive(),
}).strict()
const transferChunkSchema = z.object({
  transferId: z.string().uuid(),
  index: z.number().int().nonnegative(),
  data: z.string().min(1),
}).strict()
const transferIdSchema = z.object({ transferId: z.string().uuid() }).strict()
const transferReadSchema = z.object({
  transferId: z.string().uuid(),
  index: z.number().int().nonnegative(),
}).strict()
const directoryListSchema = z.object({
  path: z.string().min(1).max(4096).optional(),
}).strict()

const MAX_ACTIVE_STREAMS = MAX_ALPHA_STREAMS_PER_CONNECTION
const MAX_ACTIVE_TRANSFERS = MAX_ACTIVE_TRANSFERS_PER_DIRECTION
const INLINE_TRANSFER_RESPONSE_BYTES = 2 * 1024 * 1024
/** Envelope bytes a published stream event adds around the frame it carries. */
const STREAM_FRAME_ENVELOPE_BYTES = 4 * 1024
/** Envelope bytes an RPC response adds around the result it carries. */
const RESPONSE_ENVELOPE_BYTES = 8 * 1024
/**
 * Page sizes a history request steps down through when one page cannot cross the channel.
 *
 * 50 is the floor DSH itself uses for a page (`PAGE_MESSAGES`); the smaller steps exist for
 * sessions whose messages are individually huge, and 1 is the last chance before the page is
 * reported as unrepresentable over Remote.
 */
const HISTORY_PAGE_SIZES = [50, 30, 20, 12, 6, 3, 1] as const
/** Largest window one page may ask for; DSH's own client tops out here. */
const MAX_HISTORY_PAGE_MESSAGES = 500
/** Unary endpoints whose single page has to fit in one secure message. */
const REMOTE_HISTORY_CALL_ENDPOINTS = new Set(['session/page', 'session/history'])
/** Stream endpoints whose opening page has to fit in one secure message frame. */
const REMOTE_HISTORY_STREAM_ENDPOINTS = new Set(['session/follow'])
/** How many sessions remember the page size that last fit. */
const MAX_CACHED_HISTORY_PAGES = 64

/** Fixed v0.1.2 Typert Remote subset exposed to authenticated peers. */
export const HARNESS_REMOTE_ALLOWLIST = [
  '$events',
  '$events/result',
  'agentPresets/list',
  'agentPresets/read',
  'agentPresets/select',
  'commands/execute',
  'commands/list',
  'credentials/describe',
  'credentials/set',
  'credentials/unset',
  'directoryPicker/list',
  'fileReferences/list',
  'goals/clear',
  'goals/complete',
  'goals/create',
  'goals/edit',
  'goals/pause',
  'goals/resume',
  'llm/discoverModels',
  'llm/listConfigurableProviders',
  'llm/listProviders',
  'messageFeedback/delete',
  'messageFeedback/list',
  'messageFeedback/put',
  'pluginInventory/list',
  'permissionPresets/catalog',
  'session/attachment',
  'session/cancel',
  'session/canOpenWorkspacePath',
  'session/control',
  'session/create',
  'session/follow',
  'session/fork',
  'session/list',
  'session/modelCatalog',
  'session/page',
  'session/prompt',
  'session/projections',
  'session/initializeDefaultModel',
  'session/workspacePathApplications',
  'session/rename',
  'session/search',
  'session/selectModel',
  'session/updateQueue',
  'sessionReferenceResolver/candidates',
  'settings/describe',
  'settings/mutate',
  'settings/replace',
  'settings/update',
  'skills/list',
  'subagents/interruptByParent',
  'subagents/list',
  'subagents/prompt',
  'workspaceFiles/list',
  'workspaceFiles/stat',
  'workspaceFiles/read',
  'workspaceFiles/readBytes',
  'workspaceFiles/readAll',
  'workspaceFiles/readRelated',
  'workspaceFiles/changes',
  'officeToPdf/render',
  'officeToPdf/generation',
  'workspace/archiveSession',
  'workspace/create',
  'workspace/delete',
  'workspace/follow',
  'workspace/insertBefore',
  'workspace/insertSessionBefore',
  'workspace/rename',
  'workspace/unarchiveSession',
  'workspace/initializeDefault',
  'workspace/pinSession',
  'workspace/unpinSession',
] as const

const allowedEndpoints = new Set<string>(HARNESS_REMOTE_ALLOWLIST)

/** Host-side adapter from the encrypted peer channel to the official alpha Gateway carrier. */
export class HarnessRemoteBridge {
  private readonly streams = new Map<string, ActiveRemoteStream>()
  private readonly incomingTransfers = new Map<string, IncomingTransfer>()
  private readonly outgoingTransfers = new Map<string, OutgoingTransfer>()
  /** Last page size that fit one secure message, per session, so probing is paid once. */
  private readonly historyPageSizes = new Map<string, number>()

  constructor(
    private readonly gateway: LocalTypertGateway,
    private readonly publish: PublishRemoteFrame,
    private readonly logger?: SafeLogger,
    private readonly harnessVersion?: string,
    private readonly terminal = new TerminalPolicy(() => false, "", new Map()),
    private readonly codexWorkspace?: CodexWorkspaceBridge,
  ) {}

  /**
   * Answer one remote Gateway call.
   *
   * Bytes have to leave in DSH's own form: this result is JSON-encoded on its way to the client, and a
   * \`Uint8Array\` would arrive there as \`{"0":…}\` and fail the generated schema (the image-preview
   * failure). Tagging here, hydrating on the client, keeps one convention on both sides.
   */
  async call(input: unknown): Promise<TypertRpcResult> {
    return collectRpcAttachments(await this.dispatchCall(input))
  }

  private async dispatchCall(input: unknown): Promise<TypertRpcResult> {
    const params = callSchema.parse(input) as HarnessRemoteCallParams
    this.assertAllowed(params.endpoint)
    if (TERMINAL_STREAMS.has(params.endpoint)) throw new RpcError('METHOD_NOT_ALLOWED', 'Use a stream for this terminal endpoint.')
    if (['settings/update', 'settings/replace', 'settings/mutate'].includes(params.endpoint)) {
      const args = requestArgs(params.payload)
      if (args.ns === 'ds-harness-remote' || args.ns === 'dsh-remote') {
        throw new RpcError('PERMISSION_DENIED', 'Remote access settings can only be changed locally on the Host.')
      }
    }
    const reservation = params.endpoint.startsWith('terminal/') ? this.terminal.check(params.endpoint, params.payload) : undefined
    let codexResult: TypertRpcResult | undefined
    if (this.codexWorkspace !== undefined) {
      try {
        codexResult = await this.codexWorkspace.call(params.endpoint, params.payload, AbortSignal.timeout(60_000))
      } catch (error) {
        // A failed allocation must release the device ownership it reserved.
        if (reservation !== undefined) {
          this.terminal.result(params.endpoint, params.payload, { ok: false, error: { code: 'FAILED', message: '', details: {} } }, reservation)
        }
        throw error
      }
    }
    if (codexResult !== undefined) return reservation === undefined ? codexResult : this.terminal.result(params.endpoint, params.payload, codexResult, reservation)
    if (params.endpoint === 'session/canOpenWorkspacePath') {
      return { ok: true, value: true }
    }
    const startedAt = performance.now()
    const signal = AbortSignal.timeout(60_000)
    try {
      const nativePayload = normalizeWorkspaceRequestPayload(params.endpoint, params.payload, this.harnessVersion)
      const nativeResult = REMOTE_HISTORY_CALL_ENDPOINTS.has(params.endpoint)
        ? await this.dispatchHistoryPage(params.endpoint, nativePayload, signal)
        : params.endpoint === 'commands/execute'
          ? await dispatchCommandForHost(this.gateway, params.payload, signal, this.harnessVersion)
          : await this.gateway.dispatch(params.endpoint, nativePayload, signal)
      const result = params.endpoint === 'directoryPicker/list' && needsDirectoryFallback(nativeResult)
        ? await this.directoryList(params.payload, signal)
        : nativeResult
      this.logger?.debug('harness remote call ok', {
        endpoint: params.endpoint,
        durationMs: Math.round(performance.now() - startedAt),
      })
      return reservation === undefined ? result : this.terminal.result(params.endpoint, params.payload, result, reservation)
    } catch (error) {
      if (reservation !== undefined) this.terminal.result(params.endpoint, params.payload, { ok: false, error: { code: 'FAILED', message: '', details: {} } }, reservation)
      if (params.endpoint === 'directoryPicker/list') {
        const result = await this.directoryList(params.payload, signal)
        this.logger?.debug('harness remote call ok', {
          endpoint: params.endpoint,
          durationMs: Math.round(performance.now() - startedAt),
          fallback: 'directory-browser',
        })
        return result
      }
      this.logger?.warn('harness remote call failed', {
        endpoint: params.endpoint,
        durationMs: Math.round(performance.now() - startedAt),
        code: this.gateway.failure(error).code,
      })
      throw error
    }
  }

  private async directoryList(payload: unknown, signal: AbortSignal): Promise<TypertRpcResult> {
    const args = requestArgs(payload)
    const params = directoryListSchema.parse(args)
    return { ok: true, value: await listRemoteDirectory(params.path, signal) }
  }

  openTransfer(input: unknown): { opened: true; transferId: string } {
    this.pruneTransfers()
    const params = transferOpenSchema.parse(input) as HarnessApiTransferOpenParams
    if (params.totalChunks !== Math.ceil(params.totalBytes / HARNESS_API_TRANSFER_CHUNK_BYTES)) {
      throw new RpcError('INVALID_MESSAGE', 'The Harness Remote transfer chunk count is invalid.')
    }
    if (this.incomingTransfers.has(params.transferId) || this.outgoingTransfers.has(params.transferId)) {
      throw new RpcError('REQUEST_CONFLICT', 'The Harness Remote transfer id is already active.')
    }
    if (this.incomingTransfers.size >= MAX_ACTIVE_TRANSFERS) {
      throw new RpcError('RATE_LIMITED', 'Too many Harness Remote transfers are active.', undefined, true)
    }
    this.incomingTransfers.set(params.transferId, {
      totalBytes: params.totalBytes,
      totalChunks: params.totalChunks,
      chunks: [],
      receivedBytes: 0,
      touchedAt: Date.now(),
    })
    return { opened: true, transferId: params.transferId }
  }

  appendTransfer(input: unknown): { accepted: true; transferId: string; index: number } {
    this.pruneTransfers()
    const params = transferChunkSchema.parse(input) as HarnessApiTransferChunkParams
    const transfer = this.incomingTransfers.get(params.transferId)
    if (transfer === undefined) throw new RpcError('TRANSFER_NOT_FOUND', 'The Harness Remote transfer is not active.')
    if (params.index !== transfer.chunks.length || params.index >= transfer.totalChunks) {
      this.incomingTransfers.delete(params.transferId)
      throw new RpcError('INVALID_MESSAGE', 'Harness Remote transfer chunks must arrive exactly once and in order.')
    }
    const chunk = decodeCanonicalBase64(params.data)
    const expectedBytes = Math.min(
      HARNESS_API_TRANSFER_CHUNK_BYTES,
      transfer.totalBytes - params.index * HARNESS_API_TRANSFER_CHUNK_BYTES,
    )
    if (chunk.byteLength !== expectedBytes) {
      this.incomingTransfers.delete(params.transferId)
      throw new RpcError('INVALID_MESSAGE', 'The Harness Remote transfer chunk size is invalid.')
    }
    transfer.chunks.push(chunk)
    transfer.receivedBytes += chunk.byteLength
    transfer.touchedAt = Date.now()
    return { accepted: true, transferId: params.transferId, index: params.index }
  }

  async commitTransfer(input: unknown): Promise<HarnessApiTransferCommitResult> {
    this.pruneTransfers()
    const params = transferIdSchema.parse(input)
    const transfer = this.incomingTransfers.get(params.transferId)
    if (transfer === undefined) throw new RpcError('TRANSFER_NOT_FOUND', 'The Harness Remote transfer is not active.')
    this.incomingTransfers.delete(params.transferId)
    if (transfer.chunks.length !== transfer.totalChunks || transfer.receivedBytes !== transfer.totalBytes) {
      throw new RpcError('INVALID_MESSAGE', 'The Harness Remote transfer is incomplete.')
    }
    let request: unknown
    try {
      request = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(concatChunks(transfer.chunks, transfer.totalBytes)))
    } catch {
      throw new RpcError('INVALID_MESSAGE', 'The Harness Remote transfer does not contain a valid request.')
    }
    const response = await this.call(callSchema.parse(request))
    const responseBytes = new TextEncoder().encode(JSON.stringify(response))
    if (responseBytes.byteLength <= INLINE_TRANSFER_RESPONSE_BYTES) return { kind: 'inline', response }
    if (responseBytes.byteLength > MAX_HARNESS_API_TRANSFER_BYTES) {
      throw new RpcError('RESPONSE_TOO_LARGE', 'The Harness Remote response exceeds the bounded transfer limit.')
    }
    if (this.outgoingTransfers.size >= MAX_ACTIVE_TRANSFERS) {
      throw new RpcError('RATE_LIMITED', 'Too many Harness Remote response transfers are active.', undefined, true)
    }
    const totalChunks = Math.ceil(responseBytes.byteLength / HARNESS_API_TRANSFER_CHUNK_BYTES)
    this.outgoingTransfers.set(params.transferId, {
      bytes: responseBytes,
      totalChunks,
      nextIndex: 0,
      touchedAt: Date.now(),
    })
    return { kind: 'chunked', transferId: params.transferId, totalBytes: responseBytes.byteLength, totalChunks }
  }

  readTransfer(input: unknown): HarnessApiTransferReadResult {
    this.pruneTransfers()
    const params = transferReadSchema.parse(input) as HarnessApiTransferReadParams
    const transfer = this.outgoingTransfers.get(params.transferId)
    if (transfer === undefined) throw new RpcError('TRANSFER_NOT_FOUND', 'The Harness Remote response transfer is not active.')
    if (params.index !== transfer.nextIndex || params.index >= transfer.totalChunks) {
      this.outgoingTransfers.delete(params.transferId)
      throw new RpcError('INVALID_MESSAGE', 'Harness Remote response chunks must be read exactly once and in order.')
    }
    const start = params.index * HARNESS_API_TRANSFER_CHUNK_BYTES
    const end = Math.min(start + HARNESS_API_TRANSFER_CHUNK_BYTES, transfer.bytes.byteLength)
    transfer.nextIndex += 1
    transfer.touchedAt = Date.now()
    return {
      transferId: params.transferId,
      index: params.index,
      data: Buffer.from(transfer.bytes.subarray(start, end)).toString('base64'),
    }
  }

  closeTransfer(input: unknown): { closed: boolean; transferId: string } {
    const params = transferIdSchema.parse(input)
    const closed = this.incomingTransfers.delete(params.transferId) || this.outgoingTransfers.delete(params.transferId)
    return { closed, transferId: params.transferId }
  }

  async openStream(input: unknown): Promise<{ opened: true; streamId: string }> {
    const params = streamOpenSchema.parse(input) as HarnessRemoteStreamOpenParams
    this.assertAllowed(params.endpoint)
    if (params.endpoint.startsWith('settings/')) throw new RpcError('METHOD_NOT_ALLOWED', 'Settings endpoints are not streams.')
    if (TERMINAL_CALLS.has(params.endpoint)) throw new RpcError('METHOD_NOT_ALLOWED', 'This terminal endpoint is not a stream.')
    if (TERMINAL_STREAMS.has(params.endpoint)) this.terminal.check(params.endpoint, params.payload)
    if (this.streams.has(params.streamId)) throw new RpcError('REQUEST_CONFLICT', 'The Harness Remote stream is already open.')
    if (this.streams.size >= MAX_ACTIVE_STREAMS) {
      throw new RpcError('RATE_LIMITED', 'Too many Harness Remote streams are open.', undefined, true)
    }
    const controller = new AbortController()
    this.streams.set(params.streamId, { controller })
    try {
      const nativePayload = normalizeWorkspaceChangesPayload(params.endpoint, params.payload, this.harnessVersion)
      if (REMOTE_HISTORY_STREAM_ENDPOINTS.has(params.endpoint)) {
        // The opening snapshot is the page that has to fit. Probe it here, so an oversized
        // page steps down before the client is told the stream is open; the accepted first
        // frame is buffered and published by the pump before the live tail.
        const opened = await this.openHistoryStream(params, nativePayload, controller.signal)
        void this.pump(params.streamId, opened.source, controller.signal, opened.frame)
        return { opened: true, streamId: params.streamId }
      }
      const source = (this.codexWorkspace === undefined ? undefined : await this.codexWorkspace.open(params.endpoint, params.payload, controller.signal))
        ?? await this.gateway.open(params.endpoint, nativePayload, controller.signal)
      controller.signal.throwIfAborted()
      void this.pump(params.streamId, source, controller.signal)
      return { opened: true, streamId: params.streamId }
    } catch (error) {
      this.streams.delete(params.streamId)
      controller.abort()
      throw error
    }
  }

  /**
   * Open a history stream with its opening page chosen by byte budget.
   *
   * `session/follow` yields one snapshot page and then live events. The snapshot cannot be
   * retried after the stream is handed to the client, so each attempt is pulled here, measured,
   * and closed again when it would not fit one secure message. The accepted iterator continues
   * after that first frame, which the pump publishes before the live tail.
   * @param params - the validated stream-open request.
   * @param payload - the request payload after endpoint normalization.
   * @param signal - the stream's cancellation signal.
   * @returns the remaining source and the measured first frame.
   */
  private async openHistoryStream(
    params: HarnessRemoteStreamOpenParams,
    payload: unknown,
    signal: AbortSignal,
  ): Promise<{ source: AsyncIterable<unknown>; frame?: HarnessRemoteFrameData }> {
    const { key, sizes } = this.historyPageSizesFor(payload)
    for (const size of sizes) {
      const source = await this.gateway.open(params.endpoint, withHistoryWindow(payload, size), signal)
      const iterator = source[Symbol.asyncIterator]()
      let first: IteratorResult<unknown>
      try {
        first = await iterator.next()
      } catch (error) {
        await iterator.return?.()
        throw error
      }
      if (first.done === true) {
        await iterator.return?.()
        return { source: EMPTY_ASYNC_ITERABLE }
      }
      const frame: HarnessRemoteFrameData = {
        streamId: params.streamId,
        hasValue: true,
        ...(first.value === undefined ? {} : { value: collectRpcAttachments(first.value) }),
      }
      if (streamFrameBytes(frame) <= MAX_SECURE_MESSAGE_BYTES - STREAM_FRAME_ENVELOPE_BYTES) {
        this.rememberHistoryPageSize(key, size)
        return { source: remainingIterable(iterator), frame }
      }
      await iterator.return?.()
    }
    throw new RpcError(
      'RESPONSE_TOO_LARGE',
      'The Harness history page is too large for the secure Remote channel. Request a smaller page.',
      { maxBytes: MAX_SECURE_MESSAGE_BYTES },
      true,
    )
  }

  /**
   * Answer one unary history page with the largest window that still fits.
   *
   * DSH's client asks for 500 messages; a session whose only Turn is long answers that with
   * its whole log, which the 4 MiB secure-message limit cannot carry. Each page is measured
   * after attachment tagging (the form the wire carries) and the request steps down through
   * {@link HISTORY_PAGE_SIZES} until it fits. Only a size overflow retries: a business failure
   * is returned immediately.
   * @param endpoint - the history endpoint being called.
   * @param payload - the request payload after endpoint normalization.
   * @param signal - the call's timeout signal.
   * @returns the page, or `RESPONSE_TOO_LARGE` when even one message cannot cross.
   */
  private async dispatchHistoryPage(
    endpoint: string,
    payload: unknown,
    signal: AbortSignal,
  ): Promise<TypertRpcResult> {
    const { key, sizes } = this.historyPageSizesFor(payload)
    for (const size of sizes) {
      const result = await this.gateway.dispatch(endpoint, withHistoryWindow(payload, size), signal)
      if (!result.ok) return result
      const wire = collectRpcAttachments(result)
      if (responseBytes(wire) <= MAX_SECURE_MESSAGE_BYTES - RESPONSE_ENVELOPE_BYTES) {
        this.rememberHistoryPageSize(key, size)
        return wire
      }
    }
    return {
      ok: false,
      error: {
        code: 'RESPONSE_TOO_LARGE',
        message: 'The Harness history page is too large for the secure Remote channel. Request a smaller page.',
        details: { maxBytes: MAX_SECURE_MESSAGE_BYTES },
      },
    }
  }

  /** The ladder for one history request, starting from what last fit for this session. */
  private historyPageSizesFor(payload: unknown): { key: string; sizes: number[] } {
    const key = historyPageKey(payload)
    const requested = requestedMaxMessages(payload) ?? HISTORY_PAGE_SIZES[0]
    const start = Math.max(1, Math.min(requested, MAX_HISTORY_PAGE_MESSAGES, this.historyPageSizes.get(key) ?? requested))
    return { key, sizes: historyPageSizes(start) }
  }

  private rememberHistoryPageSize(key: string, size: number): void {
    if (this.historyPageSizes.size >= MAX_CACHED_HISTORY_PAGES && !this.historyPageSizes.has(key)) {
      const oldest = this.historyPageSizes.keys().next().value
      if (oldest !== undefined) this.historyPageSizes.delete(oldest)
    }
    this.historyPageSizes.set(key, size)
  }

  closeStream(input: unknown): { closed: boolean; streamId: string } {
    const params = streamCloseSchema.parse(input)
    const active = this.streams.get(params.streamId)
    if (active !== undefined) {
      this.streams.delete(params.streamId)
      active.controller.abort('client-closed')
    }
    return { closed: active !== undefined, streamId: params.streamId }
  }

  async closeAll(reason: HarnessRemoteStreamClosedData['reason'] = 'peer-disconnected'): Promise<void> {
    const streams = [...this.streams.entries()]
    this.streams.clear()
    this.incomingTransfers.clear()
    this.outgoingTransfers.clear()
    this.historyPageSizes.clear()
    for (const [, stream] of streams) stream.controller.abort(reason)
    await this.codexWorkspace?.closeAll()
  }

  private assertAllowed(endpoint: string): void {
    if (!allowedEndpoints.has(endpoint) && !TERMINAL_CALLS.has(endpoint) && !TERMINAL_STREAMS.has(endpoint)) {
      throw new RpcError('METHOD_NOT_ALLOWED', 'The requested Harness Remote endpoint is not allowed.')
    }
    if (endpoint === '$events' && !this.gateway.supportsCarrier) {
      throw new RpcError('FEATURE_NOT_SUPPORTED', 'This Harness version does not support Remote event transport.')
    }
  }

  private async pump(
    streamId: string,
    source: AsyncIterable<unknown>,
    signal: AbortSignal,
    initialFrame?: HarnessRemoteFrameData,
  ): Promise<void> {
    let reason: HarnessRemoteStreamClosedData['reason'] = 'completed'
    let failure: HarnessRemoteStreamClosedData['failure']
    try {
      // A history opener already measured its first frame against the same budget, so it is
      // published as measured; everything after it still passes the size guard below.
      if (initialFrame !== undefined && !signal.aborted) await this.publish('harness.remote.frame', initialFrame)
      for await (const value of source) {
        if (signal.aborted) break
        const frame = {
          streamId,
          hasValue: true as const,
          ...(value === undefined ? {} : { value: collectRpcAttachments(value) }),
        }
        // A frame that cannot be encrypted must fail this stream, not the peer
        // connection: the transport closes the channel when a send throws, which
        // used to leave every other Session on the same connection unanswerable.
        if (streamFrameBytes(frame) > MAX_SECURE_MESSAGE_BYTES - STREAM_FRAME_ENVELOPE_BYTES) {
          failure = {
            code: 'RESPONSE_TOO_LARGE',
            message: 'The Harness stream frame is too large for the secure Remote channel.',
            details: { maxBytes: MAX_SECURE_MESSAGE_BYTES },
          }
          reason = 'failed'
          break
        }
        await this.publish('harness.remote.frame', frame)
      }
      if (signal.aborted) reason = 'cancelled'
    } catch (error) {
      reason = signal.aborted ? 'cancelled' : 'failed'
      if (!signal.aborted) failure = this.gateway.failure(error)
    } finally {
      this.streams.delete(streamId)
      await this.publish('harness.remote.stream.closed', {
        streamId,
        reason,
        ...(failure === undefined ? {} : { failure }),
      }).catch(() => undefined)
    }
  }

  private pruneTransfers(): void {
    const cutoff = Date.now() - TRANSFER_IDLE_MS
    for (const [id, transfer] of this.incomingTransfers) if (transfer.touchedAt < cutoff) this.incomingTransfers.delete(id)
    for (const [id, transfer] of this.outgoingTransfers) if (transfer.touchedAt < cutoff) this.outgoingTransfers.delete(id)
  }
}

/**
 * Rewrite one history request to a page window that may fit the secure channel.
 *
 * Only the window changes: the cursor (`throughSeq` / `beforeSeq`) and every other argument
 * stay as the client sent them, so a smaller page simply cuts later and `hasMore` reports the
 * rest. `turnWindow.minMessages` is clamped too, because DSH rejects a minimum above the page.
 * @param payload - the call payload as the client sent it.
 * @param maxMessages - the window this attempt uses.
 * @returns the payload with the bounded window, in the shape it arrived.
 */
function withHistoryWindow(payload: unknown, maxMessages: number): unknown {
  if (!isRecord(payload)) return payload
  const args = isRecord(payload.args) ? payload.args : payload
  const turnWindow = isRecord(args.turnWindow) ? args.turnWindow : undefined
  const nextArgs: Record<string, unknown> = { ...args, maxMessages }
  if (turnWindow !== undefined) {
    nextArgs.turnWindow = typeof turnWindow.minMessages === 'number' && Number.isFinite(turnWindow.minMessages)
      ? { ...turnWindow, minMessages: Math.min(turnWindow.minMessages, maxMessages) }
      : turnWindow
  }
  // Some callers pass `{ args }`, others the argument object itself; keep whichever shape arrived.
  return isRecord(payload.args) ? { ...payload, args: nextArgs } : nextArgs
}

/** Windows to try for one page: the starting window, then every smaller fixed step. */
function historyPageSizes(start: number): number[] {
  const sizes = [start]
  for (const size of HISTORY_PAGE_SIZES) if (size < start) sizes.push(size)
  return sizes
}

/** The window the client asked for, or undefined when it asked for none. */
function requestedMaxMessages(payload: unknown): number | undefined {
  if (!isRecord(payload)) return undefined
  const args = isRecord(payload.args) ? payload.args : payload
  const value = args.maxMessages
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
}

/**
 * Per-session cache key.
 *
 * Both history endpoints address the same session, so a window that fit the opening snapshot
 * also seeds the older-page reads and vice versa; the page shape, not the endpoint, is what
 * determines the size.
 */
function historyPageKey(payload: unknown): string {
  if (!isRecord(payload)) return 'default'
  const args = isRecord(payload.args) ? payload.args : payload
  const address = args.address ?? args.request ?? args.threadId ?? args.sessionId
  if (address === undefined) return 'default'
  try {
    return JSON.stringify(address)
  } catch {
    return 'default'
  }
}

/** Bytes the encoded wire result occupies; attachments were already tagged by the caller. */
function responseBytes(result: TypertRpcResult): number {
  return Buffer.byteLength(JSON.stringify(result), 'utf8')
}

/** Bytes one published stream frame occupies before the event envelope is added. */
function streamFrameBytes(frame: HarnessRemoteFrameData): number {
  return Buffer.byteLength(JSON.stringify(frame), 'utf8')
}

/** The rest of an iterator that already produced its first value. */
function remainingIterable(iterator: AsyncIterator<unknown>): AsyncIterable<unknown> {
  return { [Symbol.asyncIterator]: () => iterator }
}

/** A stream that yields nothing. */
const EMPTY_ASYNC_ITERABLE: AsyncIterable<unknown> = { async *[Symbol.asyncIterator]() {} }

/**
 * DSH 0.1.7 changed workspaceFiles/changes from a Session-wide feed to a
 * target-scoped feed that requires `path`. Older Web/Client bundles still
 * open the Session-wide form. Keep that request working on a 0.1.7 Host by
 * watching the workspace root; the legacy client continues filtering frames
 * by the file it has opened. Do not add the field to older Hosts, whose
 * generated Typert schema rejects unknown arguments.
 */
function normalizeWorkspaceChangesPayload(endpoint: string, payload: unknown, harnessVersion?: string): unknown {
  if (endpoint !== 'workspaceFiles/changes' || !requiresWorkspaceChangePath(harnessVersion)) return payload
  if (!isRecord(payload) || !isRecord(payload.args) || Object.hasOwn(payload.args, 'path')) return payload
  return { ...payload, args: { ...payload.args, path: '.' } }
}

/**
 * DSH 0.1.7 nests the byte range under `options`, while older clients send
 * it directly on the request args. Keep the translation Host-version gated:
 * older generated descriptors reject the new `options` field.
 */
function normalizeWorkspaceRequestPayload(endpoint: string, payload: unknown, harnessVersion?: string): unknown {
  if (!isRecord(payload) || !isRecord(payload.args)) return payload
  const args = payload.args
  if (endpoint === 'workspaceFiles/readBytes' && requiresWorkspaceChangePath(harnessVersion)) {
    if (!Object.hasOwn(args, 'range') || Object.hasOwn(args, 'options')) return payload
    const { range, ...rest } = args
    return { ...payload, args: { ...rest, options: { range } } }
  }
  // DSH 0.2 removes the first-use naming request; accept a legacy client
  // payload while keeping the generated 0.2 endpoint's zero-argument shape.
  if (endpoint === 'workspace/initializeDefault' && isDshV02OrNewer(harnessVersion) && Object.hasOwn(args, 'request')) {
    const { request: _request, ...rest } = args
    return { ...payload, args: rest }
  }
  return payload
}

function isDshV02OrNewer(version: string | undefined): boolean {
  const match = /^(?:dsh-)?v?(\d+)\.(\d+)\.(\d+)(?:-|$)/u.exec(version?.trim() ?? '')
  if (match === null) return false
  return Number(match[1]) === 0 && Number(match[2]) >= 2
}

function requiresWorkspaceChangePath(version: string | undefined): boolean {
  const match = /^(?:dsh-)?v?(\d+)\.(\d+)\.(\d+)(?:-|$)/u.exec(version?.trim() ?? '')
  if (match === null) return false
  return Number(match[1]) === 0
    && ((Number(match[2]) === 1 && Number(match[3]) >= 7) || Number(match[2]) === 2)
}

async function dispatchCommandForHost(
  gateway: LocalTypertGateway,
  payload: unknown,
  signal: AbortSignal,
  harnessVersion?: string,
): Promise<TypertRpcResult> {
  const parsed = commandExecutePayloadSchema.parse(payload)
  const legacyPayload = {
    args: {
      agentId: parsed.args.agentId,
      line: parsed.args.line,
      images: parsed.args.images ?? [],
    },
  }
  const currentPayload = {
    args: {
      agentId: parsed.args.agentId,
      line: parsed.args.line,
      submittedAttachments: parsed.args.submittedAttachments ?? [],
    },
  }
  const args = harnessSessionGeneration(harnessVersion) === 'v3' ? currentPayload : legacyPayload
  return gateway.dispatch(
    'commands/execute',
    args,
    signal,
  )
}

function decodeCanonicalBase64(value: string): Uint8Array {
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value) throw new RpcError('INVALID_MESSAGE', 'The Harness Remote transfer chunk is invalid.')
  return bytes
}

function concatChunks(chunks: readonly Uint8Array[], totalBytes: number): Uint8Array {
  const result = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

function needsDirectoryFallback(result: TypertRpcResult): boolean {
  if (result.ok) return false
  const code = result.error.code.toLocaleLowerCase()
  const message = result.error.message.toLocaleLowerCase()
  return code.includes('capability')
    || code === 'directory-picker/unavailable'
    || code === 'directory-picker-unavailable'
    || message.includes('browse capability')
    || message.includes('browser capability')
    || message.includes('brower capability')
    || message.includes('directory-picker-unavailable')
}

function requestArgs(payload: unknown): Record<string, unknown> {
  const root = record(payload)
  const args = isRecord(root.args) ? root.args : root
  return record(args.request ?? args._request ?? args)
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

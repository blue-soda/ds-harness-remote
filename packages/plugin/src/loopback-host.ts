import { request as httpRequest, type ClientRequest, type IncomingMessage, type IncomingHttpHeaders } from 'node:http'
import { WebSocket } from 'ws'
import { loopbackRequestSchema, LOOPBACK_CHUNK_BYTES, LOOPBACK_MAX_BODY_BYTES, LOOPBACK_MAX_WS_BYTES, LOOPBACK_MAX_CONNECTIONS,
  type LoopbackRequest, type LoopbackWsRead } from '@dsh-remote/protocol'
import { RpcError } from './safe-error.js'

interface HttpHandle {
  kind: 'http'; request: ClientRequest; response?: IncomingMessage; reading: boolean; total: number; touched: number
}
interface WsHandle {
  kind: 'ws'; socket: WebSocket; messages: LoopbackWsRead['messages']; bytes: number; reading: boolean
  closed: boolean; wake?: () => void; touched: number
}
type Handle = HttpHandle | WsHandle
const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'host', 'content-length', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto'])

/** Strip hop headers including names nominated by Connection. Never log header/body contents. */
export function cleanHeaders(headers: Array<[string, string]>): Array<[string, string]> {
  const removed = new Set(HOP_HEADERS)
  for (const [name, value] of headers) if (name.toLowerCase() === 'connection') {
    for (const token of value.split(',')) removed.add(token.trim().toLowerCase())
  }
  return headers.filter(([name]) => !removed.has(name.toLowerCase()) && !name.toLowerCase().startsWith('sec-websocket-'))
}
export function headerPairs(headers: IncomingHttpHeaders): Array<[string, string]> {
  return Object.entries(headers).flatMap(([name, value]) => value === undefined ? []
    : (Array.isArray(value) ? value : [value]).map(item => [name, item] as [string, string]))
}

/** Per-peer HTTP/WS proxy to explicit IPv4 loopback ports; never a general TCP tunnel. */
export class LoopbackHost {
  private readonly handles = new Map<string, Handle>()
  private closed = false
  private readonly timer: ReturnType<typeof setInterval>
  constructor(private readonly getPorts: () => readonly number[]) {
    this.timer = setInterval(() => {
      for (const [id, handle] of this.handles) if (Date.now() - handle.touched > 60_000) this.close(id)
    }, 10_000)
    this.timer.unref()
  }

  async call(input: unknown): Promise<unknown> {
    if (this.closed) throw new RpcError('TRANSPORT_CLOSED', 'Preview connection closed.')
    const value = loopbackRequestSchema.parse(input)
    if (value.op === 'describe') return { ports: [...this.getPorts()] }
    if (value.op === 'close') { this.close(value.id); return { closed: true } }
    if (value.op === 'http.open' || value.op === 'ws.open') {
      if (!this.getPorts().includes(value.port)) throw new RpcError('LOOPBACK_PORT_DENIED',
        'This preview port is not allowed. Add it to loopback.ports in the Host Remote settings and save the access settings. / 请在 Host Remote 设置中允许此预览端口并保存访问设置。')
      if (this.handles.has(value.id)) throw new RpcError('REQUEST_CONFLICT', 'Preview handle is already in use.')
      if (this.handles.size >= LOOPBACK_MAX_CONNECTIONS) throw new RpcError('RATE_LIMITED', 'Too many active preview requests.')
      try { return value.op === 'http.open' ? await this.openHttp(value) : await this.openWs(value) }
      catch { this.close(value.id); throw new RpcError('LOOPBACK_UNAVAILABLE', 'The allowed loopback service did not respond. Check that it is running on the Host.') }
    }
    const handle = this.handles.get(value.id)
    if (handle === undefined) throw new RpcError('LOOPBACK_CLOSED', 'Preview request closed; reload the preview.')
    handle.touched = Date.now()
    if (value.op === 'http.read' && handle.kind === 'http') {
      if (handle.reading) throw new RpcError('REQUEST_CONFLICT', 'Only one preview read may be pending.')
      handle.reading = true
      try {
        const response = handle.response!
        let chunk = response.read(Math.min(response.readableLength || LOOPBACK_CHUNK_BYTES, LOOPBACK_CHUNK_BYTES)) as Buffer | null
        if (chunk === null && !response.readableEnded && !response.destroyed) {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => finish(new Error('timeout')), 20_000)
            const ready = (): void => finish()
            const fail = (): void => finish(new Error('closed'))
            const finish = (error?: Error): void => {
              clearTimeout(timer); response.off('readable', ready); response.off('end', ready); response.off('close', ready); response.off('error', fail)
              error === undefined ? resolve() : reject(error)
            }
            response.once('readable', ready); response.once('end', ready); response.once('close', ready); response.once('error', fail)
          })
          chunk = response.read(Math.min(response.readableLength || LOOPBACK_CHUNK_BYTES, LOOPBACK_CHUNK_BYTES)) as Buffer | null
          // A short final chunk can be smaller than the requested read size.
          if (chunk === null && response.readableLength > 0) chunk = response.read(Math.min(response.readableLength, LOOPBACK_CHUNK_BYTES)) as Buffer
        }
        const done = chunk === null && (response.readableEnded || response.destroyed)
        if (done && !response.complete) throw new Error('truncated')
        handle.total += chunk?.length ?? 0
        if (handle.total > 64 * 1024 * 1024) throw new Error('size')
        if (done) this.close(value.id)
        return { data: chunk?.toString('base64') ?? '', done }
      } catch { this.close(value.id); throw new RpcError('LOOPBACK_READ_FAILED', 'Preview response ended or exceeded its limit; reload to retry.') }
      finally { handle.reading = false }
    }
    if (handle.kind === 'ws') {
      if (value.op === 'ws.send') {
        const data = Buffer.from(value.data, 'base64')
        if (data.length > LOOPBACK_MAX_WS_BYTES || handle.socket.bufferedAmount > 1024 * 1024) {
          this.close(value.id); throw new RpcError('RATE_LIMITED', 'Preview WebSocket buffer exceeded its limit.')
        }
        await new Promise<void>((resolve, reject) => handle.socket.send(data, { binary: value.binary }, error => error ? reject(new RpcError('LOOPBACK_CLOSED', 'Preview socket closed.')) : resolve()))
        return { sent: true }
      }
      if (value.op === 'ws.read') {
        if (handle.reading) throw new RpcError('REQUEST_CONFLICT', 'Only one preview read may be pending.')
        handle.reading = true
        try {
          if (handle.messages.length === 0 && !handle.closed) await new Promise<void>(resolve => {
            const timer = setTimeout(() => { handle.wake = undefined; resolve() }, 20_000)
            handle.wake = () => { clearTimeout(timer); handle.wake = undefined; resolve() }
          })
          let bytes = 0
          const messages: LoopbackWsRead['messages'] = []
          while (handle.messages.length > 0 && bytes < LOOPBACK_MAX_WS_BYTES) {
            const message = handle.messages.shift()!; bytes += message.data.length; messages.push(message)
          }
          handle.bytes -= bytes
          const closed = handle.closed && handle.messages.length === 0
          if (closed) this.close(value.id)
          return { messages, closed }
        } finally { handle.reading = false }
      }
    }
    throw new RpcError('INVALID_MESSAGE', 'Preview handle kind does not match the operation.')
  }

  closeAll(): void { this.closed = true; clearInterval(this.timer); for (const id of this.handles.keys()) this.close(id) }
  private close(id: string): void {
    const handle = this.handles.get(id); this.handles.delete(id)
    if (handle?.kind === 'http') { handle.response?.destroy(); handle.request.destroy() }
    if (handle?.kind === 'ws') { handle.closed = true; handle.wake?.(); handle.socket.terminate() }
  }

  private openHttp(value: Extract<LoopbackRequest, { op: 'http.open' }>): Promise<unknown> {
    const body = value.body === undefined ? undefined : Buffer.from(value.body, 'base64')
    if ((body?.length ?? 0) > LOOPBACK_MAX_BODY_BYTES) throw new Error('body limit')
    return new Promise((resolve, reject) => {
      const headers = Object.fromEntries(cleanHeaders(value.headers))
      const request = httpRequest({ hostname: '127.0.0.1', port: value.port, method: value.method, path: value.path, headers,
        agent: false, maxHeaderSize: 32 * 1024 }, response => {
        const handle = this.handles.get(value.id)
        if (handle?.kind !== 'http') { response.destroy(); return }
        handle.response = response
        response.on('error', () => undefined)
        clearTimeout(timer)
        resolve({ status: response.statusCode ?? 502, headers: cleanHeaders(headerPairs(response.headers)) })
      })
      const timer = setTimeout(() => { request.destroy(); reject(new Error('timeout')) }, 20_000)
      request.on('error', () => { clearTimeout(timer); reject(new Error('upstream')) })
      this.handles.set(value.id, { kind: 'http', request, reading: false, total: 0, touched: Date.now() })
      request.end(body)
    })
  }

  private openWs(value: Extract<LoopbackRequest, { op: 'ws.open' }>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${value.port}${value.path}`, value.protocols, {
        headers: Object.fromEntries(cleanHeaders(value.headers)), followRedirects: false,
        handshakeTimeout: 15_000, maxPayload: LOOPBACK_MAX_WS_BYTES, perMessageDeflate: false,
      })
      const handle: WsHandle = { kind: 'ws', socket, messages: [], bytes: 0, reading: false, closed: false, touched: Date.now() }
      this.handles.set(value.id, handle)
      socket.once('open', () => resolve({ protocol: socket.protocol }))
      socket.on('message', (data, binary) => {
        const message = { data: Buffer.from(data as Buffer).toString('base64'), binary }
        if (handle.bytes + message.data.length > 1024 * 1024 || handle.messages.length >= 256) { this.close(value.id); return }
        handle.messages.push(message); handle.bytes += message.data.length; handle.wake?.()
      })
      socket.on('close', () => { handle.closed = true; handle.wake?.(); reject(new Error('closed')) })
      socket.on('error', () => { handle.closed = true; handle.wake?.(); reject(new Error('upstream')) })
    })
  }
}

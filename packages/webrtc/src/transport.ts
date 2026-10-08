import type { TransportStats } from '@dsh-remote/protocol'

export interface RemoteTransport {
  connect(): Promise<void>
  send(data: Uint8Array): Promise<void>
  onMessage(cb: (data: Uint8Array) => void): () => void
  onClose?(cb: () => void): () => void
  close(): Promise<void>
  getStats(): TransportStats
}

export interface SecureHandshakeTransport extends RemoteTransport {
  connectionInfo(): { connectionId: string; localDeviceId: string; remoteDeviceId: string }
  sendHandshake(step: number, data: Uint8Array): Promise<void>
  onHandshake(cb: (step: number, data: Uint8Array) => void): () => void
}

type MessageHandler = (data: Uint8Array) => void

export abstract class BaseTransport implements RemoteTransport {
  protected handlers = new Set<MessageHandler>()
  protected closeHandlers = new Set<() => void>()

  onMessage(cb: MessageHandler): () => void {
    this.handlers.add(cb)
    return () => this.handlers.delete(cb)
  }

  onClose(cb: () => void): () => void {
    this.closeHandlers.add(cb)
    return () => this.closeHandlers.delete(cb)
  }

  /**
   * Deliver received bytes to every data handler, isolating a handler that throws.
   *
   * One handler that cannot process a message used to abort the loop and escape into the frame
   * dispatcher, where the surrounding catch read it as a transport fault: on a phone that turned a
   * refused endpoint (`METHOD_NOT_ALLOWED`) into a torn-down link, every RPC the fast reconnect was
   * awaiting rejected with TRANSPORT_CLOSED, and the client escalated to a full fallback on a link that
   * was healthy. A failing handler now costs only its own message, and the handlers behind it still
   * receive the one in flight.
   * @param data - decrypted application bytes from the peer.
   */
  protected emit(data: Uint8Array): void {
    for (const handler of this.handlers) {
      try {
        handler(data)
      } catch (error) {
        console.warn('[dsh-remote] a relay listener failed; keeping the transport up', {
          message: error instanceof Error ? error.message : String(error),
          code: typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined,
        })
      }
    }
  }

  protected emitClose(): void {
    for (const handler of this.closeHandlers) handler()
  }

  abstract connect(): Promise<void>
  abstract send(data: Uint8Array): Promise<void>
  abstract close(): Promise<void>
  abstract getStats(): TransportStats
}

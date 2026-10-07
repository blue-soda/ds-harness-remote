import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

export interface ServerLogOptions {
  /** File that receives one JSON object per line. */
  file: string
  /** Rotate before the active file would exceed this many bytes. */
  maxBytes?: number
  /** How many files to keep, counting the active one. */
  maxFiles?: number
}

const DEFAULT_MAX_BYTES = 1024 * 1024
const DEFAULT_MAX_FILES = 3
const MIN_MAX_BYTES = 4 * 1024
const MAX_MAX_FILES = 10

/**
 * Append-only lifecycle log for the self-hosted Server.
 *
 * The Server is the only party that can prove why a connection ended: it owns the control
 * heartbeat and the link registry, so a client that stops answering pings, a link dropped by a
 * protocol error and a Host that disconnected all surface here first. Records are one JSON
 * object per line, and the file is capped - once the active file would exceed `maxBytes` it is
 * renamed to `.1`, the older files shift down and the oldest is deleted, so disk use stays
 * bounded however long the service runs. Callers pass identifiers and result codes only: no
 * tokens, private keys, handshake bytes or relay ciphertext ever reach this class.
 */
export class ServerLog {
  private readonly maxBytes: number
  private readonly maxFiles: number
  private size = 0

  constructor(private readonly options: ServerLogOptions) {
    this.maxBytes = Math.max(MIN_MAX_BYTES, options.maxBytes ?? DEFAULT_MAX_BYTES)
    this.maxFiles = Math.min(MAX_MAX_FILES, Math.max(1, options.maxFiles ?? DEFAULT_MAX_FILES))
    mkdirSync(dirname(options.file), { recursive: true, mode: 0o700 })
    this.size = this.measure()
  }

  /** Append one record. Never throws: a Server that cannot write its log must keep serving. */
  info(event: string, fields: Record<string, unknown> = {}): void {
    const line = `${JSON.stringify({ time: new Date().toISOString(), event, ...fields })}\n`
    const bytes = Buffer.byteLength(line)
    try {
      if (this.size + bytes > this.maxBytes) this.rotate()
      appendFileSync(this.options.file, line, { encoding: 'utf8', mode: 0o600 })
      this.size += bytes
    } catch {
      // Diagnostics must never take the service down.
    }
  }

  /** Files this logger owns, newest first; the rotational state is useful in support reports. */
  paths(): string[] {
    const files = [this.options.file]
    for (let index = 1; index < this.maxFiles; index += 1) files.push(`${this.options.file}.${index}`)
    return files
  }

  private measure(): number {
    try {
      return statSync(this.options.file).size
    } catch {
      return 0
    }
  }

  private rotate(): void {
    const { file } = this.options
    rmSync(`${file}.${this.maxFiles - 1}`, { force: true })
    for (let index = this.maxFiles - 2; index >= 1; index -= 1) {
      try {
        renameSync(`${file}.${index}`, `${file}.${index + 1}`)
      } catch {
        // The older file has not been created yet.
      }
    }
    try {
      renameSync(file, `${file}.1`)
    } catch {
      // Nothing to rotate on a fresh directory.
    }
    this.size = 0
  }
}

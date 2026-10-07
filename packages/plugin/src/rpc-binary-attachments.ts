/**
 * Rehydrate the out-of-band byte attachments DSH puts beside a Gateway result.
 *
 * The Harness Gateway encodes a result containing a `Uint8Array` as a placeholder plus an
 * attachment list — `{ ok: true, value: { data: null, … }, attachments: [{ path: ['data'],
 * bytes }] }` — and its own connection layer copies `bytes` back to `path` before the value is
 * validated against the generated schema (`z.instanceof(Uint8Array)`, emitted by
 * `typert/generator`). A native Remote call never touches that layer, so our carrier sees the
 * envelope raw, JSON-encoded: the placeholder stays `null` and the bytes arrive as
 * `{ "0": 137, "1": 80, … }`. Handing that to DSH fails with
 * `expected "Uint8Array", path: ["data"]`, which is exactly the image-preview failure.
 *
 * Hydrating here keeps the carrier compatible with any Host version: a Host that never sends
 * attachments passes through untouched.
 */

/** One attachment as it arrives over the JSON carrier. */
interface AttachmentEnvelope {
  readonly attachments?: unknown
  readonly value?: unknown
}

export function hydrateRpcAttachments(result: unknown): unknown {
  if (!isRecord(result)) return result
  const envelope = result as AttachmentEnvelope
  if (!Array.isArray(envelope.attachments) || envelope.attachments.length === 0) return result

  const { attachments, ...rest } = result as Record<string, unknown> & { attachments: unknown[] }
  const base = Object.hasOwn(rest, 'value') ? rest.value : undefined
  for (const attachment of attachments) {
    const entry = attachment as { path?: unknown; bytes?: unknown }
    const path = Array.isArray(entry.path) ? entry.path : undefined
    if (path === undefined || path.length === 0) {
      throw new Error('The remote Host returned a byte attachment without a path.')
    }
    assignAtPath(base, path, decodeAttachmentBytes(entry.bytes))
  }
  // DSH's own client drops the envelope; downstream code must see the identical shape.
  return rest
}

function assignAtPath(base: unknown, path: readonly unknown[], bytes: Uint8Array): void {
  if (base === null || typeof base !== 'object') {
    throw new Error('The remote Host returned a byte attachment that its result cannot hold.')
  }
  let cursor = base as Record<string, unknown>
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = pathKey(path[index])
    const next: unknown = cursor[key]
    if (next === null || typeof next !== 'object') {
      throw new Error('The remote Host returned a byte attachment at an unknown result path.')
    }
    cursor = next as Record<string, unknown>
  }
  cursor[pathKey(path[path.length - 1])] = bytes
}

function pathKey(segment: unknown): string {
  if (typeof segment === 'string') return segment
  if (typeof segment === 'number' && Number.isInteger(segment) && segment >= 0) return String(segment)
  throw new Error('The remote Host returned a byte attachment with an invalid path segment.')
}

/** Accepts every shape a `Uint8Array` takes after a JSON round trip, plus the original. */
function decodeAttachmentBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (typeof value === 'string') return decodeBase64(value)
  if (Array.isArray(value)) return Uint8Array.from(value as number[])
  if (!isRecord(value)) throw new Error('The remote Host returned invalid byte attachment data.')
  if (Array.isArray((value as { data?: unknown }).data)) {
    // Node's Buffer.toJSON() produces { type: 'Buffer', data: [...] }.
    return Uint8Array.from((value as { data: number[] }).data)
  }
  const keys = Object.keys(value)
  if (keys.every(key => /^\d+$/u.test(key))) {
    // JSON.stringify(new Uint8Array([9, 0])) produces { "0": 9, "1": 0 }.
    const ordered = keys.map(Number).sort((left, right) => left - right)
    return Uint8Array.from(ordered.map(key => (value as Record<string, number>)[String(key)]))
  }
  throw new Error('The remote Host returned invalid byte attachment data.')
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Mirror of the same wire form for our own Host half.
 *
 * A native Remote call leaves the Host through this plugin's tunnel, which JSON-encodes whatever the
 * Gateway returned. DSH rehydrates its own result before the Host plugin sees it, so the bytes arrive
 * as a real \`Uint8Array\` again - and \`JSON.stringify\` turns that into \`{"0":137,"1":80,…}\`, a shape no
 * generated schema accepts. Sending DSH's own form instead (a placeholder plus \`attachments\`) keeps one
 * convention on both sides of the tunnel and lets \`hydrateRpcAttachments\` put the bytes back. A result
 * without bytes is returned untouched, and tagging twice changes nothing.
 *
 * @param result - Gateway result about to be JSON-encoded for the client.
 * @returns the same result, or one carrying byte attachments.
 */
export function collectRpcAttachments<T>(result: T): T {
  if (!isRecord(result) || !Object.hasOwn(result, 'value')) return result
  const attachments: ByteAttachment[] = []
  const value = replaceBytes((result as unknown as { value: unknown }).value, [], attachments)
  if (attachments.length === 0) return result
  return { ...(result as Record<string, unknown>), value, attachments } as T
}

interface ByteAttachment {
  readonly path: ReadonlyArray<string | number>
  readonly bytes: string
}

function replaceBytes(
  value: unknown,
  path: ReadonlyArray<string | number>,
  attachments: ByteAttachment[],
): unknown {
  if (value instanceof Uint8Array) {
    attachments.push({ path: [...path], bytes: encodeBase64(value) })
    // The placeholder has to stay assignable at the same path; hydration overwrites it.
    return null
  }
  if (Array.isArray(value)) return value.map((item, index) => replaceBytes(item, [...path, index], attachments))
  if (!isRecord(value)) return value
  const clone: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) clone[key] = replaceBytes(item, [...path, key], attachments)
  return clone
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

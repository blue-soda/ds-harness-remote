import { describe, expect, it } from 'vitest'
import { hydrateRpcAttachments } from '../src/rpc-binary-attachments.js'

/**
 * The Harness Gateway nulls a `Uint8Array` result field and ships the bytes beside the result:
 * `{ ok: true, value: { data: null, … }, attachments: [{ path: ['data'], bytes }] }`. Its own
 * connection layer copies them back before the generated `z.instanceof(Uint8Array)` schema
 * validates the value; a native Remote call skips that layer, and this carrier's JSON hop
 * turns the bytes into `{ "0": 9, "1": 0 }`. Without hydration the client rejects the result
 * with `expected "Uint8Array", path: ["data"]` — the image-preview failure.
 *
 * The shapes below mirror DSH's own `binary-rpc.host.spec.ts` cases.
 */
describe('Gateway byte attachments', () => {
  it('restores the bytes DSH ships beside a nulled result field', () => {
    const bytes = new Uint8Array([0, 128, 255])
    const wire = JSON.parse(JSON.stringify({
      ok: true,
      value: { data: null, offset: 7, eof: false, bytes: 42 },
      attachments: [{ path: ['data'], bytes }],
    })) as Record<string, unknown>

    const hydrated = hydrateRpcAttachments(wire) as { ok: boolean; value: Record<string, unknown> }

    expect(hydrated).not.toHaveProperty('attachments')
    expect(hydrated.value.data).toBeInstanceOf(Uint8Array)
    expect(Array.from(hydrated.value.data as Uint8Array)).toEqual([0, 128, 255])
    expect(Array.from(bytes)).toEqual([0, 128, 255])
    expect(hydrated.value).toMatchObject({ offset: 7, eof: false, bytes: 42 })
  })

  it.each([
    ['a base64 string', 'AID/'],
    ['a plain byte array', [0, 128, 255]],
    ["Node's Buffer JSON", { type: 'Buffer', data: [0, 128, 255] }],
  ])('accepts bytes encoded as %s', (_label, encoded) => {
    const hydrated = hydrateRpcAttachments({
      ok: true,
      value: { data: null },
      attachments: [{ path: ['data'], bytes: encoded }],
    }) as { value: { data: Uint8Array } }

    expect(hydrated.value.data).toBeInstanceOf(Uint8Array)
    expect(Array.from(hydrated.value.data)).toEqual([0, 128, 255])
  })

  it('keeps an already-binary attachment as it is', () => {
    const bytes = new Uint8Array([1, 2])
    const hydrated = hydrateRpcAttachments({
      ok: true,
      value: { data: null },
      attachments: [{ path: ['data'], bytes }],
    }) as { value: { data: Uint8Array } }

    expect(hydrated.value.data).toBe(bytes)
  })

  it('walks a nested result path', () => {
    const hydrated = hydrateRpcAttachments({
      ok: true,
      value: { items: [{ data: null }] },
      attachments: [{ path: ['items', 0, 'data'], bytes: 'AAE=' }],
    }) as { value: { items: Array<{ data: Uint8Array }> } }

    expect(Array.from(hydrated.value.items[0]!.data)).toEqual([0, 1])
  })

  it('leaves a result without attachments untouched', () => {
    const plain = { ok: true, value: { count: 3 } }
    expect(hydrateRpcAttachments(plain)).toBe(plain)
    expect(hydrateRpcAttachments('stream item')).toBe('stream item')
    expect(hydrateRpcAttachments(undefined)).toBeUndefined()
  })

  it('writes the bytes even when the Host sent no null placeholder', () => {
    const hydrated = hydrateRpcAttachments({
      ok: true,
      value: { offset: 7 },
      attachments: [{ path: ['data'], bytes: 'AA==' }],
    }) as { value: { data: Uint8Array; offset: number } }

    expect(Array.from(hydrated.value.data)).toEqual([0])
    expect(hydrated.value.offset).toBe(7)
  })

  it.each([
    ['an empty path', { ok: true, value: {}, attachments: [{ path: [], bytes: 'AA==' }] }],
    ['a path through a non-object', { ok: true, value: { items: 3 }, attachments: [{ path: ['items', 'data'], bytes: 'AA==' }] }],
    ['unusable bytes', { ok: true, value: { data: null }, attachments: [{ path: ['data'], bytes: { odd: true } }] }],
  ])('fails closed on %s', (_label, wire) => {
    expect(() => hydrateRpcAttachments(wire)).toThrow()
  })
})

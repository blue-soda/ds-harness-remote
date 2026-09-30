import { afterEach, describe, expect, it } from 'vitest'
import { createServer, request, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { WebSocket, WebSocketServer } from 'ws'
import { LoopbackHost } from '../src/loopback-host.js'
import { LoopbackPreview } from '../src/loopback-preview.js'
import type { RemoteClientCore } from '@dsh-remote/client-core'
import type { LoopbackRead } from '@dsh-remote/protocol'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function listen(server: Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  return (server.address() as { port: number }).port
}
function host(ports: number[]) { const h = new LoopbackHost(() => ports); cleanup.push(() => h.closeAll()); return h }
function rpc(host: LoopbackHost): RemoteClientCore {
  return { rpc: async (_method: string, params: unknown) => host.call(params) } as RemoteClientCore
}
function get(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: Buffer }> {
  const u = new URL(url)
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: u.port, path: u.pathname + u.search, headers: { Host: u.host, ...headers } }, res => {
      const chunks: Buffer[] = []; res.on('data', data => chunks.push(data)); res.on('error', reject)
      res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks) }))
    }); req.on('error', reject); req.end()
  })
}

describe('restricted loopback HTTP / WebSocket preview', () => {
  it('denies unlisted ports, arbitrary hosts, absolute URLs and cross-peer handles', async () => {
    const h = host([])
    const base = { op: 'http.open', id: randomUUID(), port: 5173, path: '/', method: 'GET', headers: [] }
    await expect(h.call(base)).rejects.toMatchObject({ code: 'LOOPBACK_PORT_DENIED' })
    await expect(h.call({ ...base, host: '169.254.169.254' })).rejects.toThrow()
    for (const path of ['//other/', 'http://other/', '/\r\nheader', '/\\other']) await expect(h.call({ ...base, path })).rejects.toThrow()
    await expect(h.call({ op: 'http.read', id: randomUUID() })).rejects.toMatchObject({ code: 'LOOPBACK_CLOSED' })
  })
  it('streams large responses in bounded chunks without following redirects', async () => {
    const data = Buffer.alloc(3 * 1024 * 1024 + 7, 91)
    const port = await listen(createServer((req, res) => {
      if (req.url === '/redirect') { res.writeHead(302, { Location: 'http://169.254.169.254/' }); res.end(); return }
      res.end(data)
    }))
    const h = host([port]); const id = randomUUID()
    expect(await h.call({ op: 'http.open', id, port, path: '/', method: 'GET', headers: [] })).toMatchObject({ status: 200 })
    const chunks: Buffer[] = []
    while (true) {
      const value = await h.call({ op: 'http.read', id }) as LoopbackRead
      const bytes = Buffer.from(value.data, 'base64'); expect(bytes.length).toBeLessThanOrEqual(65536); chunks.push(bytes)
      if (value.done) break
    }
    expect(Buffer.concat(chunks).equals(data)).toBe(true)
    expect(await h.call({ op: 'http.open', id: randomUUID(), port, path: '/redirect', method: 'GET', headers: [] })).toMatchObject({ status: 302 })
  })
  it('isolates local preview origins and carries HTTP plus bidirectional HMR WebSocket', async () => {
    const server = createServer((req, res) => res.end(`page:${req.url}`))
    const upstream = new WebSocketServer({ server, handleProtocols: protocols => protocols.has('vite-hmr') ? 'vite-hmr' : false })
    upstream.on('connection', socket => socket.on('message', (data, binary) => socket.send(data, { binary })))
    const port = await listen(server)
    cleanup.push(() => { for (const socket of upstream.clients) socket.terminate(); upstream.close() })
    const h = host([port]); const preview = new LoopbackPreview(rpc(h)); cleanup.push(() => preview.close())
    const { url } = await preview.open(port)
    expect(new URL(url).hostname).toMatch(/^dsh-[a-f0-9]{48}\.localhost$/)
    expect((await get(url + 'src/main.ts')).body.toString()).toBe('page:/src/main.ts')
    expect((await get(url, { Host: 'evil.example' })).status).toBe(403)
    expect((await get(url, { Origin: 'https://evil.example' })).status).toBe(403)
    expect((await get(url, { 'Service-Worker': 'script' })).status).toBe(403)
    const parsed = new URL(url)
    const socket = new WebSocket(`ws://127.0.0.1:${parsed.port}/hmr?token=dev`, ['vite-hmr'], { headers: { Host: parsed.host, Origin: parsed.origin } })
    cleanup.push(() => socket.terminate())
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
    expect(socket.protocol).toBe('vite-hmr')
    const received = new Promise<string>(resolve => socket.once('message', bytes => resolve(bytes.toString())))
    socket.send('{"type":"update"}')
    expect(await received).toBe('{"type":"update"}')
    await preview.close()
    await expect(get(url)).rejects.toThrow()
  })
})

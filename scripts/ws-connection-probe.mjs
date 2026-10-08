// Opens N WebSocket connections to the Server and holds them briefly, without sending hello, so the
// Server's own hello deadline closes them. Used to show whether connections consume threads: the Server's
// thread count must not move while its connection count does.
import { createRequire } from 'node:module'

// Resolve ws from the Server's own package, which is where the dependency is linked.
const require = createRequire('C:/Workspace/ds-harness-remote/apps/server/package.json')
const WebSocket = require('ws')

const N = Number(process.argv[2] ?? '40')
const url = 'wss://sakakibara.ink:8443/ws/v1/connect'
const sockets = []
let opened = 0
let failed = 0

for (let index = 0; index < N; index += 1) {
  const socket = new WebSocket(url)
  sockets.push(socket)
  socket.on('open', () => { opened += 1 })
  socket.on('error', () => { failed += 1 })
}

// Hold them open well past the Server's 5s hello deadline check, so the measurement window is real.
await new Promise(resolve => { setTimeout(resolve, 4000) })
console.log(`opened=${opened} failed=${failed} held=${sockets.length}`)
await new Promise(resolve => { setTimeout(resolve, 4000) })
for (const socket of sockets) socket.terminate()
console.log('closed')

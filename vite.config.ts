import { defineConfig } from 'vite'
import { WebSocketServer, type WebSocket, type RawData } from 'ws'
import type { Server } from 'node:http'
import fs from 'node:fs'

// Tiny WebRTC signaling server piggybacked on the Vite http server at /signal.
// Rooms are full-mesh: everyone gets told about everyone, joiners initiate offers.

interface Client { ws: WebSocket; id: string; order: number }
interface Room { clients: Map<string, Client>; nextOrder: number }

function attachSignaling(httpServer: Server | null) {
  if (!httpServer) return
  const wss = new WebSocketServer({ noServer: true })
  const rooms = new Map<string, Room>()

  httpServer.on('upgrade', (req, socket, head) => {
    if (!req.url) return
    const { pathname } = new URL(req.url, 'http://localhost')
    if (pathname !== '/signal') return // vite handles its own HMR upgrades
    wss.handleUpgrade(req, socket, head, ws => setup(ws))
  })

  function setup(ws: WebSocket) {
    let roomName = ''
    let self: Client | null = null

    ws.on('message', (data: RawData) => {
      let msg: any
      try { msg = JSON.parse(String(data)) } catch { return }

      if (msg.t === 'join' && !self) {
        roomName = String(msg.room || 'default')
        let room = rooms.get(roomName)
        if (!room) { room = { clients: new Map(), nextOrder: 0 }; rooms.set(roomName, room) }
        const id = Math.random().toString(36).slice(2, 8)
        self = { ws, id, order: room.nextOrder++ }
        const peers = [...room.clients.values()].map(c => ({ id: c.id, order: c.order }))
        room.clients.set(id, self)
        ws.send(JSON.stringify({ t: 'joined', id, order: self.order, peers }))
        for (const c of room.clients.values()) {
          if (c.id !== id) c.ws.send(JSON.stringify({ t: 'peer-joined', id, order: self.order }))
        }
      } else if (msg.t === 'signal' && self) {
        const to = rooms.get(roomName)?.clients.get(msg.to)
        if (to) to.ws.send(JSON.stringify({ t: 'signal', from: self.id, data: msg.data }))
      }
    })

    ws.on('close', () => {
      if (!self) return
      const room = rooms.get(roomName)
      if (!room) return
      room.clients.delete(self.id)
      for (const c of room.clients.values()) c.ws.send(JSON.stringify({ t: 'peer-left', id: self.id }))
      if (room.clients.size === 0) rooms.delete(roomName)
    })
  }
}

export default defineConfig({
  build: {
    rollupOptions: {
      input: { main: 'index.html', mock: 'mock.html' },
    },
  },
  server: {
    allowedHosts: ['pegasus.local'],
    // Serve https when a local mkcert cert is present (widget hosts and
    // getUserMedia want a secure origin). Recreate with:
    //   mkcert -cert-file certs/pegasus.local.pem \
    //     -key-file certs/pegasus.local-key.pem pegasus.local localhost 127.0.0.1 ::1
    // certs/ is gitignored; without it the server stays plain http, and
    // WORLDSYNC_HTTP=1 forces http regardless (the e2e scripts use it).
    https: !process.env.WORLDSYNC_HTTP && fs.existsSync('certs/pegasus.local-key.pem') ? {
      key: fs.readFileSync('certs/pegasus.local-key.pem'),
      cert: fs.readFileSync('certs/pegasus.local.pem'),
    } : undefined,
  },
  plugins: [{
    name: 'signaling-server',
    configureServer(server) { attachSignaling(server.httpServer) },
    configurePreviewServer(server) { attachSignaling(server.httpServer as Server) },
  }, {
    // The mock widget host points baseUrl at this origin: matrix-js-sdk
    // probes unauthenticated endpoints (/versions, for delayed-event
    // support) over plain HTTP even in widget mode, so answer them here.
    name: 'mock-homeserver',
    configureServer(server) {
      server.middlewares.use('/_matrix/client/versions', (_req, res) => {
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.end(JSON.stringify({
          versions: ['v1.11'],
          unstable_features: { 'org.matrix.msc4140': true },
        }))
      })
    },
  }],
})

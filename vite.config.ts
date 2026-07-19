import { defineConfig } from 'vite'
import { WebSocketServer, type WebSocket, type RawData } from 'ws'
import type { Server } from 'node:http'

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
  plugins: [{
    name: 'signaling-server',
    configureServer(server) { attachSignaling(server.httpServer) },
    configurePreviewServer(server) { attachSignaling(server.httpServer as Server) },
  }],
})

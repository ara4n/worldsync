import { type DcMessage } from './types'

/** Transport-level peer: connection plumbing only. Protocol state (RTT,
 * strikes, divergence) lives in Session's SessionPeer. */
export interface Peer {
  id: string
  order: number
  connected: boolean
  pc: RTCPeerConnection
  dc: RTCDataChannel | null
}

/**
 * Full-mesh WebRTC data channels with ws signaling at /signal.
 * The joiner initiates offers to everyone already in the room, so there is
 * never offer glare. Pure transport: every decoded message (pings included)
 * is handed to onMessage; the Session owns the protocol. Also owns the
 * artificial outgoing latency used to provoke rollbacks when testing on one
 * machine.
 */
export class Net {
  id = ''
  order = 0
  sendDelayMs = 0
  lagPings = true // uncheck in the UI to make our lag look like backdating
  peers = new Map<string, Peer>()
  /** alone: the room had no other members at join time */
  onJoined: (id: string, order: number, alone: boolean) => void = () => {}
  onMessage: (peer: Peer, msg: DcMessage) => void = () => {}
  onPeerConnected: (peer: Peer) => void = () => {}
  onPeerLeft: (id: string) => void = () => {}
  onLog: (line: string) => void = () => {}
  private ws: WebSocket | null = null
  // Signal handling is async (setRemoteDescription etc); process strictly in
  // order or trickled ICE candidates can race ahead of the SDP and get lost.
  private signalQueue: Promise<void> = Promise.resolve()

  connect(room: string) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/signal`)
    this.ws = ws
    ws.onopen = () => ws.send(JSON.stringify({ t: 'join', room }))
    ws.onmessage = ev => {
      const msg = JSON.parse(String(ev.data))
      this.signalQueue = this.signalQueue
        .then(() => this.onSignal(msg))
        .catch(e => this.onLog(`signal error: ${e}`))
    }
    ws.onerror = () => this.soloFallback()
    ws.onclose = () => this.soloFallback()
  }

  private soloFallback() {
    if (this.id) return
    this.id = 'solo' + Math.random().toString(36).slice(2, 6)
    this.order = 1000 + Math.floor(Math.random() * 1e6)
    this.onLog('signaling unavailable, running solo')
    this.onJoined(this.id, this.order, true)
  }

  private async onSignal(msg: any) {
    switch (msg.t) {
      case 'joined':
        this.id = msg.id
        this.order = msg.order
        this.onLog(`joined as ${msg.id} (#${msg.order})`)
        this.onJoined(this.id, this.order, msg.peers.length === 0)
        for (const p of msg.peers) this.makePeer(p.id, p.order, true)
        break
      case 'peer-joined':
        this.makePeer(msg.id, msg.order, false)
        break
      case 'peer-left': {
        const p = this.peers.get(msg.id)
        if (p) {
          p.pc.close()
          this.peers.delete(msg.id)
          this.onLog(`${msg.id} left`)
          this.onPeerLeft(msg.id)
        }
        break
      }
      case 'signal': {
        const p = this.peers.get(msg.from)
        if (!p) return
        const d = msg.data
        if (d.sdp) {
          await p.pc.setRemoteDescription(d.sdp)
          if (d.sdp.type === 'offer') {
            const answer = await p.pc.createAnswer()
            await p.pc.setLocalDescription(answer)
            this.sendSignal(msg.from, { sdp: p.pc.localDescription })
          }
        } else if (d.candidate) {
          await p.pc.addIceCandidate(d.candidate).catch(() => {})
        }
        break
      }
    }
  }

  private sendSignal(to: string, data: any) {
    this.ws?.send(JSON.stringify({ t: 'signal', to, data }))
  }

  private async makePeer(id: string, order: number, initiator: boolean) {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] })
    const peer: Peer = { id, order, connected: false, pc, dc: null }
    this.peers.set(id, peer)
    pc.onicecandidate = ev => { if (ev.candidate) this.sendSignal(id, { candidate: ev.candidate }) }
    if (initiator) {
      this.bindChannel(peer, pc.createDataChannel('sync'))
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      this.sendSignal(id, { sdp: pc.localDescription })
    } else {
      pc.ondatachannel = ev => this.bindChannel(peer, ev.channel)
    }
  }

  private bindChannel(peer: Peer, dc: RTCDataChannel) {
    peer.dc = dc
    dc.onopen = () => {
      peer.connected = true
      this.onLog(`connected to ${peer.id} (#${peer.order})`)
      this.onPeerConnected(peer)
    }
    dc.onclose = () => {
      peer.connected = false
    }
    dc.onmessage = ev => {
      let msg: DcMessage
      try { msg = JSON.parse(String(ev.data)) } catch { return }
      this.onMessage(peer, msg)
    }
  }

  sendTo(peer: Peer, msg: DcMessage) {
    const dc = peer.dc
    if (!dc || dc.readyState !== 'open') return
    const data = JSON.stringify(msg)
    const clockMsg = msg.kind === 'ping' || msg.kind === 'pong'
    const delay = clockMsg && !this.lagPings ? 0 : this.sendDelayMs
    if (delay > 0) setTimeout(() => { if (dc.readyState === 'open') dc.send(data) }, delay)
    else dc.send(data)
  }

  sendToId(id: string, msg: DcMessage) {
    const p = this.peers.get(id)
    if (p) this.sendTo(p, msg)
  }

  broadcast(msg: DcMessage) {
    for (const p of this.peers.values()) this.sendTo(p, msg)
  }
}

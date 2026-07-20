import { wallNow, type DcMessage } from './types'

const PING_MS = 1000
const SAMPLES = 8

export interface Peer {
  id: string
  order: number
  rtt: number
  offset: number // measured wall-clock skew (peer minus us, ms); reported, not corrected for
  strikes: number
  excluded: boolean
  hashMatch: boolean | null
  connected: boolean
  pc: RTCPeerConnection
  dc: RTCDataChannel | null
  samples: { rtt: number; offset: number }[]
  pingTimer: number
}

/**
 * Full-mesh WebRTC data channels with ws signaling at /signal.
 * The joiner initiates offers to everyone already in the room, so there is
 * never offer glare. Ping/pong measures per-peer RTT (for the staleness
 * limit) and wall-clock skew (NTP-style, minimum-RTT sample; displayed but
 * deliberately not corrected for, since claimed timestamps are trusted as-is
 * for now). Also owns the artificial outgoing latency used to provoke
 * rollbacks when testing on one machine.
 */
export class Net {
  id = ''
  order = 0
  sendDelayMs = 0
  lagPings = true // uncheck in the UI to make our lag look like backdating
  peers = new Map<string, Peer>()
  onMessage: (peer: Peer, msg: DcMessage) => void = () => {}
  onPeerConnected: (peer: Peer) => void = () => {}
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
  }

  private async onSignal(msg: any) {
    switch (msg.t) {
      case 'joined':
        this.id = msg.id
        this.order = msg.order
        this.onLog(`joined as ${msg.id} (#${msg.order})`)
        for (const p of msg.peers) this.makePeer(p.id, p.order, true)
        break
      case 'peer-joined':
        this.makePeer(msg.id, msg.order, false)
        break
      case 'peer-left': {
        const p = this.peers.get(msg.id)
        if (p) {
          clearInterval(p.pingTimer)
          p.pc.close()
          this.peers.delete(msg.id)
          this.onLog(`${msg.id} left`)
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
    const peer: Peer = {
      id, order, rtt: 0, offset: 0, strikes: 0, excluded: false, hashMatch: null,
      connected: false, pc, dc: null, samples: [], pingTimer: 0,
    }
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
      peer.pingTimer = window.setInterval(
        () => this.sendTo(peer, { kind: 'ping', t0: wallNow() }), PING_MS)
      this.sendTo(peer, { kind: 'ping', t0: wallNow() })
      this.onPeerConnected(peer)
    }
    dc.onclose = () => {
      peer.connected = false
      clearInterval(peer.pingTimer)
    }
    dc.onmessage = ev => {
      let msg: DcMessage
      try { msg = JSON.parse(String(ev.data)) } catch { return }
      if (msg.kind === 'ping') {
        this.sendTo(peer, { kind: 'pong', t0: msg.t0, t1: wallNow() })
        return
      }
      if (msg.kind === 'pong') {
        this.clockSample(peer, msg.t0, msg.t1, wallNow())
        return
      }
      this.onMessage(peer, msg)
    }
  }

  private clockSample(peer: Peer, t0: number, t1: number, t3: number) {
    peer.samples.push({ rtt: t3 - t0, offset: t1 - (t0 + t3) / 2 })
    if (peer.samples.length > SAMPLES) peer.samples.shift()
    const best = peer.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a))
    peer.rtt = best.rtt
    peer.offset = best.offset
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

  broadcast(msg: DcMessage) {
    for (const p of this.peers.values()) this.sendTo(p, msg)
  }
}

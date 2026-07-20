import { MatrixRTCSessionManager, MatrixRTCSessionEvent, type MatrixRTCSession } from 'matrix-js-sdk/lib/matrixrtc'
import { ClientEvent, EventType, type MatrixClient, type MatrixEvent } from 'matrix-js-sdk'
import { logger } from 'matrix-js-sdk/lib/logger'
import type { DcMessage } from '../types'
import type { WidgetParams } from './params'
import { initWidgetClient } from './widget'
import type { WidgetApi } from 'matrix-widget-api'
import { BroadcastTransport, LiveKitTransport, type DataTransport } from './transport'
import { readWorldSceneUrl } from './world'

/** Transport-level peer view, mirroring the old Net.Peer surface. */
export interface MatrixPeer {
  id: string
  order: number
  connected: boolean
}

/**
 * The Matrix flavour of worldsync's transport: identity and membership come
 * from the host client via the widget API (matryoshka), presence from
 * MatrixRTC m.call.member state events, and the data path is LiveKit text
 * streams (or a BroadcastChannel loopback under the mock host). The Session
 * is oblivious: it still just sees receive() and a send callback.
 *
 * Join order is each member's membership createdTs, read from the same
 * state event by every peer, so orders are globally consistent forever
 * (ranks would shift when seniors leave). The oldest member roots the tick
 * grid, exactly like the ws demo's first joiner.
 */
export class MatrixNet {
  id = ''
  order = 0
  sendDelayMs = 0
  lagPings = true // kept for UI parity: pings dodge the fake latency when off
  peers = new Map<string, MatrixPeer>()
  onJoined: (id: string, order: number, alone: boolean) => void = () => {}
  onMessage: (fromId: string, msg: DcMessage) => void = () => {}
  onPeerConnected: (id: string, order: number) => void = () => {}
  onPeerLeft: (id: string) => void = () => {}
  onLog: (line: string) => void = () => {}
  /** Called with the room's MSC3815 scene url (if any) BEFORE joining the
   * RTC session, so the sim can adopt the scene before its first tick:
   * seniors' worlds contain its colliders, and a joiner whose first
   * snapshot lacked them could never converge across the boot seam. */
  onPreloadScene: (sceneUrl: string) => Promise<void> = async () => {}

  /** the widget-api handle (media upload/download) and proxied client
   * (state events), exposed for the MSC3815 world plumbing in main */
  api!: WidgetApi
  client!: MatrixClient
  private rtc!: MatrixRTCSession
  private transport!: DataTransport
  private reachable = new Set<string>()
  private announced = new Set<string>()
  private joined = false

  async connect(
    p: WidgetParams, lkServiceUrl: string | null,
    /** the handshake started at module scope, before the iframe load event */
    boot: Promise<{ api: WidgetApi; client: MatrixClient }> = initWidgetClient(p),
  ) {
    this.id = `${p.userId}:${p.deviceId}`
    const { api, client } = await boot
    this.api = api
    this.client = client
    this.onLog(`widget client up as ${p.userId} (${p.deviceId})`)

    const room = client.getRoom(p.roomId) ?? await new Promise<ReturnType<MatrixClient['getRoom']>>(res => {
      const check = () => {
        const r = client.getRoom(p.roomId)
        if (r) { client.off(ClientEvent.Room, check); res(r) }
      }
      client.on(ClientEvent.Room, check)
      check()
    })
    if (!room) throw new Error(`room ${p.roomId} not visible through the widget`)

    const manager = new MatrixRTCSessionManager(logger, client)
    manager.start()
    this.rtc = manager.getRoomSession(room)
    this.rtc.on(MatrixRTCSessionEvent.MembershipsChanged, () => this.reconcile())
    // The widget client surfaces injected events via ClientEvent.Event, but
    // the session manager's RoomStateEvent re-emission does not always fire
    // down this path (it does under hosts that negotiate update_state).
    // Poke the session directly when a membership event arrives, then
    // reconcile either way.
    client.on(ClientEvent.Event, (ev: MatrixEvent) => {
      if (ev.getType() !== EventType.GroupCallMemberPrefix) return
      const poke = (this.rtc as unknown as { _onRTCSessionMemberUpdate?: () => Promise<void> })._onRTCSessionMemberUpdate
      void poke?.call(this.rtc).then(() => this.reconcile())
    })

    const serviceUrl = lkServiceUrl ?? this.discoverService()
    this.transport = p.mockTransport
      ? new BroadcastTransport(p.roomId, this.id)
      : new LiveKitTransport(client, serviceUrl!, p.roomId, p.userId, p.deviceId)
    this.transport.onData = (from, data) => {
      try { this.onMessage(from, JSON.parse(data)) } catch { /* not ours */ }
    }
    this.transport.onParticipants = ids => {
      this.reachable = ids
      this.reconcile()
    }

    // Adopt the room's glTF scene before publishing our membership: nobody
    // can be waiting on us yet, and the sim must not start (senior pongs
    // begin once we are a member) until its world matches the seniors'.
    const sceneUrl = readWorldSceneUrl(client, p.roomId)
    if (sceneUrl) {
      this.onLog(`world scene in room state: ${sceneUrl}`)
      try { await this.onPreloadScene(sceneUrl) }
      catch (e) { this.onLog(`scene preload failed (continuing without): ${e}`) }
    }

    this.rtc.joinRTCSession(
      { userId: p.userId, deviceId: p.deviceId, memberId: this.id },
      p.mockTransport || !serviceUrl ? [] : [{ type: 'livekit', livekit_service_url: serviceUrl }],
    )
    await this.transport.connect()
    this.reconcile()
  }

  private discoverService(): string | null {
    const wk = this.client.getClientWellKnown() as Record<string, unknown> | undefined
    const foci = wk?.['org.matrix.msc4143.rtc_foci'] as { type: string; livekit_service_url?: string }[] | undefined
    return foci?.find(f => f.type === 'livekit')?.livekit_service_url ?? null
  }

  /** membership x transport-reachability drives the peer lifecycle */
  private reconcile() {
    const members = new Map<string, number>()
    for (const m of this.rtc.memberships) {
      members.set(`${m.userId}:${m.deviceId}`, m.createdTs())
    }
    const mine = members.get(this.id)
    if (!this.joined && mine !== undefined) {
      this.joined = true
      this.order = mine
      this.onJoined(this.id, this.order, members.size === 1)
      this.onLog(`rtc membership up (${members.size} member${members.size === 1 ? '' : 's'})`)
    }
    if (!this.joined) return
    for (const [id, ts] of members) {
      if (id === this.id) continue
      let peer = this.peers.get(id)
      if (!peer) {
        peer = { id, order: ts, connected: false }
        this.peers.set(id, peer)
      }
      const reachableNow = this.reachable.has(id)
      if (reachableNow && !this.announced.has(id)) {
        peer.connected = true
        this.announced.add(id)
        this.onLog(`connected to ${id.split(':')[0]} (#${ts})`)
        this.onPeerConnected(id, ts)
      }
      peer.connected = reachableNow
    }
    for (const id of [...this.peers.keys()]) {
      if (!members.has(id)) {
        this.peers.delete(id)
        this.announced.delete(id)
        this.onLog(`${id.split(':')[0]} left`)
        this.onPeerLeft(id)
      }
    }
  }

  private sendRaw(to: string | null, msg: DcMessage) {
    if (!this.transport) return // still connecting; peers are not up yet either
    const data = JSON.stringify(msg)
    const clockMsg = msg.kind === 'ping' || msg.kind === 'pong'
    const delay = clockMsg && !this.lagPings ? 0 : this.sendDelayMs
    if (delay > 0) setTimeout(() => this.transport.send(to, data), delay)
    else this.transport.send(to, data)
  }

  sendToId(id: string, msg: DcMessage) { this.sendRaw(id, msg) }
  broadcast(msg: DcMessage) { this.sendRaw(null, msg) }

  leave() {
    this.rtc?.leaveRoomSession(1000)
    this.transport?.close()
  }
}

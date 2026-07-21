import { MatrixRTCSessionManager, MatrixRTCSessionEvent, isLivekitTransportConfig, type MatrixRTCSession } from 'matrix-js-sdk/lib/matrixrtc'
import { ClientEvent, EventType, type MatrixClient, type MatrixEvent } from 'matrix-js-sdk'
import { logger } from 'matrix-js-sdk/lib/logger'
import type { DcMessage } from '../types'
import type { WidgetParams } from './params'
import { initWidgetClient } from './widget'
import type { WidgetApi } from 'matrix-widget-api'
import { BroadcastTransport, LiveKitTransport, type DataTransport } from './transport'
import { readWorldSceneUrl, readWorldScriptUrl, worldUrls, WORLD_EVENT_TYPE } from './world'

/** How long a senior membership may stay unreachable on the transport
 * before a calibrating joiner writes it off as a ghost and self-roots.
 * Short on purpose: SFU presence is continuous, so a live senior is
 * visible almost immediately after we connect, and a false write-off
 * (senior joining at the exact same moment) heals via the hard-resync +
 * boot-seam path. This bounds how long a refresh feels dead. */
const GHOST_GRACE_MS = 3000

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
  /** The room's MSC3815 script_url, reported once after connect and again
   * whenever the world state event changes (null = no script). Scripts are
   * NOT tick-grid state: only the current root peer runs one, and its
   * effects enter the timeline as ordinary ops, so a plain state watch is
   * enough (no op, no seam handling). */
  onWorldScript: (scriptUrl: string | null) => void = () => {}

  /** every membership senior to us has stayed transport-unreachable past
   * the grace period: ghosts. main wires this to Session.seniorsUnreachable
   * so calibration stops waiting for pongs that cannot come. */
  onSeniorsUnreachable: () => void = () => {}

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
      if (ev.getType() === WORLD_EVENT_TYPE) {
        this.onWorldScript(worldUrls(ev.getContent() as Record<string, unknown>).scriptUrl)
        return
      }
      if (ev.getType() !== EventType.GroupCallMemberPrefix) return
      const poke = (this.rtc as unknown as { _onRTCSessionMemberUpdate?: () => Promise<void> })._onRTCSessionMemberUpdate
      void poke?.call(this.rtc).then(() => this.reconcile())
    })

    const serviceUrl = lkServiceUrl ?? await this.discoverService(p)
    if (!p.mockTransport && !serviceUrl) {
      throw new Error('no LiveKit service url: not in rtc_foci of the client well-known, '
        + 'none advertised by current members - pass ?lkService=https://your-lk-jwt-service')
    }
    if (!p.mockTransport) this.onLog(`livekit service: ${serviceUrl}`)
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
    this.onWorldScript(readWorldScriptUrl(client, p.roomId))

    this.rtc.joinRTCSession(
      { userId: p.userId, deviceId: p.deviceId, memberId: this.id },
      p.mockTransport || !serviceUrl ? [] : [{ type: 'livekit', livekit_service_url: serviceUrl }],
    )
    // Best-effort clean leave on refresh/close, so our membership does not
    // linger as a ghost for everyone else (the server-side delayed leave
    // event remains the backstop when this postMessage never lands).
    addEventListener('pagehide', () => this.leave())
    await this.transport.connect()
    this.reconcile()

    // A missing own-membership echo is a capability problem, not a race:
    // publishing succeeded, so if it never comes back the host is not
    // delivering m.call.member state to us. Say so instead of hanging.
    setTimeout(() => {
      if (!this.joined) {
        this.onLog(`own membership echo still missing after 5s (${this.rtc.memberships.length} memberships `
          + 'visible): the host is probably not granting the m.call.member receive capability - '
          + 'check the widget permission prompt / re-add the widget and approve everything')
      }
    }, 5000)

    // Ghost-membership fallback: a crashed session leaves its m.call.member
    // behind (the delayed leave event may never fire), and a joiner would
    // wait forever to calibrate against a senior that cannot answer. Give
    // real seniors a grace period to show up on the transport; if none of
    // them do, declare them ghosts.
    setTimeout(() => {
      let anySenior = false
      let reachableSenior = false
      for (const m of this.rtc.memberships) {
        const id = `${m.userId}:${m.deviceId}`
        if (id === this.id || m.createdTs() >= this.order) continue
        anySenior = true
        if (this.reachable.has(id)) reachableSenior = true
      }
      if (anySenior && !reachableSenior) {
        this.onLog('senior members never became reachable; treating them as ghosts')
        this.onSeniorsUnreachable()
      }
    }, GHOST_GRACE_MS)
  }

  /**
   * Find the lk-jwt-service, element-call style, in preference order:
   * a transport an existing member advertises (joining their session means
   * using their SFU), the host-provided client well-known (usually absent
   * for widgets: a RoomWidgetClient never talks to a homeserver), and
   * finally the user's homeserver .well-known fetched directly over HTTP.
   */
  private async discoverService(p: WidgetParams): Promise<string | null> {
    const fromWk = (wk: unknown): string | null => {
      const foci = (wk as Record<string, unknown> | undefined)?.['org.matrix.msc4143.rtc_foci'] as
        { type: string; livekit_service_url?: string }[] | undefined
      return foci?.find(f => f.type === 'livekit')?.livekit_service_url ?? null
    }
    for (const m of this.rtc.memberships) {
      for (const t of m.transports) {
        if (isLivekitTransportConfig(t)) return t.livekit_service_url
      }
    }
    const viaClient = fromWk(this.client.getClientWellKnown())
    if (viaClient) return viaClient
    const server = p.userId.split(':').slice(1).join(':')
    try {
      const res = await fetch(`https://${server}/.well-known/matrix/client`)
      if (res.ok) return fromWk(await res.json())
    } catch { /* fall through to null */ }
    return null
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

  /** true once the transport has a media path (LiveKit; not the mock) */
  hasAudio(): boolean { return !!this.transport?.setMicEnabled }

  /** publish/unpublish the local mic; resolves to the resulting state
   * (false when the transport has no media path) */
  async setMicEnabled(on: boolean): Promise<boolean> {
    return this.transport?.setMicEnabled ? this.transport.setMicEnabled(on) : false
  }

  leave() {
    this.rtc?.leaveRoomSession(1000)
    this.transport?.close()
  }
}

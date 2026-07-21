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
  /** membership id -> the SFU identity it matched (see matchParticipant) */
  private sfuIdFor = new Map<string, string>()
  private announced = new Set<string>()
  private joined = false

  /** The SFU identity for a membership id. The lk-jwt-service does not
   * necessarily mint identities as `${userId}:${deviceId}` - the modern
   * /get_token slot flow mints OPAQUE HASHES - and an unmatched identity
   * silently kills ALL targeted traffic (pings, pongs, boots) while
   * broadcasts still arrive, which is maximally confusing. The reliable
   * mapping comes from the hello broadcast (each client introduces its
   * membership id over the transport); the string heuristics remain for
   * services that do mint member-id-shaped identities, where they let
   * reachability resolve a hello round-trip earlier. */
  private matchParticipant(memberId: string): string | null {
    const known = this.sfuIdFor.get(memberId)
    if (known !== undefined && this.reachable.has(known)) return known
    if (this.reachable.has(memberId)) return memberId
    for (const pi of this.reachable) {
      if (pi.endsWith(memberId) || pi.includes(memberId) || memberId.startsWith(pi)) return pi
    }
    return null
  }

  /** Introduce our membership id to everyone on the transport; with ackTo,
   * answer one peer's hello instead (targeted at its SFU identity). Acks
   * carry the same mapping but are never answered, so introductions
   * cannot ping-pong. */
  private sayHello(ackTo?: string) {
    this.transport?.send(ackTo ?? null,
      JSON.stringify({ kind: 'hello', peer: this.id, ...(ackTo ? { ack: true } : {}) }))
  }

  private memberIdFor(sfuId: string): string | null {
    for (const [mid, sid] of this.sfuIdFor) if (sid === sfuId) return mid
    for (const id of this.peers.keys()) {
      if (sfuId === id || sfuId.endsWith(id) || sfuId.includes(id) || id.startsWith(sfuId)) return id
    }
    return null
  }

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

    const serviceUrl = lkServiceUrl ?? (p.mockTransport ? null : await this.discoverService(p))
    if (!p.mockTransport && !serviceUrl) {
      throw new Error('no LiveKit service url: not in rtc_foci of the client well-known, '
        + 'none advertised by current members - pass ?lkService=https://your-lk-jwt-service')
    }
    if (!p.mockTransport) this.onLog(`livekit service: ${serviceUrl}`)
    this.transport = p.mockTransport
      ? new BroadcastTransport(p.roomId, this.id)
      : new LiveKitTransport(client, serviceUrl!, p.roomId, p.userId, p.deviceId)
    this.transport.onLog = l => this.onLog(l)
    this.transport.onData = (from, data) => {
      // 'from' is the SFU identity; the session keys peers by membership id
      let msg: DcMessage
      try { msg = JSON.parse(data) } catch { return /* not ours */ }
      if (msg.kind === 'hello') {
        if (this.sfuIdFor.get(msg.peer) !== from) {
          this.sfuIdFor.set(msg.peer, from)
          this.onLog(`hello${msg.ack ? '-ack' : ''}: ${msg.peer} is sfu identity ${from}`)
          this.reconcile()
        }
        // Answer EVERY hello, not just mapping-changing ones: a reloaded
        // peer keeps its membership id AND its SFU identity, so its fresh
        // hello changes nothing on our side - but it still needs our
        // mapping, or it writes us off as a ghost and roots a second
        // world (split-brain). Acks are never answered.
        if (!msg.ack) this.sayHello(from)
        return
      }
      this.onMessage(this.memberIdFor(from) ?? from, msg)
    }
    this.transport.onParticipants = ids => {
      const changed = ids.size !== this.reachable.size || [...ids].some(i => !this.reachable.has(i))
      this.reachable = ids
      if (changed && !p.mockTransport) {
        this.onLog(`transport participants: ${[...ids].join(', ') || '(none)'}`)
        this.sayHello() // whoever appeared needs our membership id mapping
      }
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
    if (!p.mockTransport) this.sayHello()
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
    // them do, declare them ghosts. This also covers the senior-MOST peer
    // rejoining a room of juniors: it has no senior to calibrate from, and
    // before rooting fresh it gets the same grace for a running junior's
    // pong to hand it the existing grid (Session adopts any calibrated
    // peer's grid, whatever its order).
    setTimeout(() => {
      let reachableSenior = false
      for (const m of this.rtc.memberships) {
        const id = `${m.userId}:${m.deviceId}`
        if (id === this.id || m.createdTs() >= this.order) continue
        if (this.matchParticipant(id) !== null) reachableSenior = true
      }
      if (!reachableSenior) {
        this.onLog('no reachable senior after the grace period; rooting the grid here unless a running peer calibrates us first')
        this.onSeniorsUnreachable()
      }
    }, GHOST_GRACE_MS)
  }

  /** the focus advertised by the OLDEST other member (the session's owner,
   * per MSC4143 oldest_membership focus selection) */
  private serviceFromMemberships(): string | null {
    const sorted = [...this.rtc.memberships].sort((a, b) => a.createdTs() - b.createdTs())
    for (const m of sorted) {
      if (`${m.userId}:${m.deviceId}` === this.id) continue
      for (const t of m.transports) {
        if (isLivekitTransportConfig(t)) return t.livekit_service_url
      }
    }
    return null
  }

  /** is there m.call.member state from anyone else, surfaced by the sdk yet
   * or not? (empty content = a left membership, ignored) */
  private hasForeignMemberState(p: WidgetParams): boolean {
    const events = this.client.getRoom(p.roomId)?.currentState.getStateEvents(EventType.GroupCallMemberPrefix) ?? []
    return events.some(ev =>
      Object.keys(ev.getContent()).length > 0 && !(ev.getStateKey() ?? '').includes(p.deviceId))
  }

  /** last-ditch: pull a livekit service straight out of raw m.call.member
   * content (foci_preferred / transports), for state the sdk never parsed */
  private serviceFromRawState(p: WidgetParams): string | null {
    const events = this.client.getRoom(p.roomId)?.currentState.getStateEvents(EventType.GroupCallMemberPrefix) ?? []
    for (const ev of events) {
      if ((ev.getStateKey() ?? '').includes(p.deviceId)) continue
      const c = ev.getContent() as Record<string, unknown>
      for (const list of [c.foci_preferred, c.transports]) {
        if (!Array.isArray(list)) continue
        for (const t of list) {
          const f = t as { type?: string; livekit_service_url?: string }
          if (f?.type === 'livekit' && typeof f.livekit_service_url === 'string') return f.livekit_service_url
        }
      }
    }
    return null
  }

  /**
   * Find the lk-jwt-service, element-call style, in preference order: the
   * focus an existing member advertises - joining their session MUST mean
   * using their SFU, since two peers on different LiveKit clouds (each
   * discovering their own homeserver's focus in a federated room) both
   * come up healthy and never see each other - then the host-provided
   * client well-known (usually absent for widgets: a RoomWidgetClient
   * never talks to a homeserver), and finally the user's homeserver
   * .well-known fetched directly over HTTP. Membership state can surface
   * from the widget AFTER connect() starts, so poke the session and wait
   * briefly before concluding no member advertises a focus.
   */
  private async discoverService(p: WidgetParams): Promise<string | null> {
    const poke = (this.rtc as unknown as { _onRTCSessionMemberUpdate?: () => Promise<void> })._onRTCSessionMemberUpdate
    for (let i = 0; i < 10; i++) {
      await poke?.call(this.rtc)
      const advertised = this.serviceFromMemberships()
      if (advertised) {
        this.onLog('livekit service advertised by an existing member (joining their sfu)')
        return advertised
      }
      // surfaced members that advertise no focus, or no member state at
      // all: nothing to wait for
      if (this.rtc.memberships.some(m => `${m.userId}:${m.deviceId}` !== this.id)) break
      if (!this.hasForeignMemberState(p)) break
      if (i === 0) this.onLog('m.call.member state present but not surfaced yet; giving the sdk a moment')
      await new Promise(r => setTimeout(r, 300))
    }
    const raw = this.serviceFromRawState(p)
    if (raw) {
      this.onLog('livekit service pulled from raw membership state (joining their sfu)')
      return raw
    }
    const fromWk = (wk: unknown): string | null => {
      const foci = (wk as Record<string, unknown> | undefined)?.['org.matrix.msc4143.rtc_foci'] as
        { type: string; livekit_service_url?: string }[] | undefined
      return foci?.find(f => f.type === 'livekit')?.livekit_service_url ?? null
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
      const sfuId = this.matchParticipant(id)
      if (sfuId !== null) this.sfuIdFor.set(id, sfuId)
      const reachableNow = sfuId !== null
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
    // targeted sends need the SFU identity, not the membership id
    const dest = to === null ? null : this.sfuIdFor.get(to) ?? to
    const data = JSON.stringify(msg)
    const clockMsg = msg.kind === 'ping' || msg.kind === 'pong'
    const delay = clockMsg && !this.lagPings ? 0 : this.sendDelayMs
    if (delay > 0) setTimeout(() => this.transport.send(dest, data), delay)
    else this.transport.send(dest, data)
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

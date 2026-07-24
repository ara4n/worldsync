import { BOOT_LEAD_TICKS, Sim, TICK_MS } from './sim'
import { wallNow, type DcMessage, type Interaction, type PropInfo, type Quat, type Vec3 } from './types'

const HASH_EVERY_TICKS = 60
// Only exchange tick hashes older than this. A fold can rewrite any tick in
// the snapshot window (HISTORY_TICKS back), so anything younger can still
// change after being sent, false-positiving the divergence latch; beyond the
// window a rewrite is impossible without a clamp ANOMALY being logged.
const SETTLE_TICKS = 330
const PING_EVERY_MS = 1000
const RTT_SAMPLES = 8
// Tick clock discipline: after the one hard set at join, corrections toward
// the room root are slewed, never stepped, so the sim's tick cadence stays
// smooth. Clock-rate drift between machines is parts-per-million; 0.05 ticks
// per 1Hz pong (~0.8ms/s of adjustment) out-paces it by orders of magnitude.
const SLEW_MAX_TICKS = 0.05
// A disagreement this large is not drift (machine slept, clock stepped):
// hard-resync and let the tick-jump anomaly machinery own the fallout.
const HARD_RESYNC_TICKS = 30
// Heartbeat cadence (5/s). A beat from peer P triggers a fold one whole
// interval deeper than the beat's tick, so every tick is re-simulated at
// least once AFTER P's poses for it fully arrived (ordered channel: they
// were sent before the beat). Bounds how long pose-driven contact drift
// survives; also the attestation that makes staleness provable.
const BEAT_EVERY_TICKS = 12
// Ops older than this cannot fold (snapshot window is HISTORY_TICKS = 300);
// beyond it even an honest peer must be dropped, and it earns a strike.
const STALE_MAX_TICKS = 270

/**
 * Maps the local monotonic clock onto the room's shared tick grid.
 * tickTime is fractional: floor(tickTime) is the current grid tick, the
 * fraction is render-interpolation phase. The first peer in a room fixes
 * the grid (tick 0 = its arrival); everyone else calibrates once against a
 * senior peer's pong and then slews toward the current root.
 */
class TickClock {
  calibrated = false
  private epochMs = 0
  private baseTick = 0

  tickTimeAt(nowMs: number) { return this.baseTick + (nowMs - this.epochMs) / TICK_MS }

  set(nowMs: number, tickTime: number) {
    this.epochMs = nowMs
    this.baseTick = tickTime
    this.calibrated = true
  }

  /** bounded correction; returns the amount actually applied */
  nudge(deltaTicks: number): number {
    const d = Math.max(-SLEW_MAX_TICKS, Math.min(SLEW_MAX_TICKS, deltaTicks))
    this.baseTick += d
    return d
  }
}

/** Per-peer protocol state, transport details excluded (those live in Net). */
export interface SessionPeer {
  id: string
  order: number
  rtt: number
  offset: number // measured wall-clock skew (peer minus us, ms); reported, not corrected for
  strikes: number
  excluded: boolean
  /** true once at least one settled tick hash has been compared */
  checked: boolean
  /** first settled tick at which our pose hash disagreed with theirs */
  divergedAt: number | null
  samples: { rtt: number; offset: number }[]
}

/**
 * One participant's entire sync protocol, transport-agnostic: the sim, the
 * emitter, boot, staleness striking, ping/RTT measurement and the settled
 * hash exchange. The transport is whatever calls receive() and consumes
 * send(); the browser shell hands it WebRTC, the headless hub a loopback.
 */
export class Session {
  id = ''
  order = 0
  peers = new Map<string, SessionPeer>()
  // Ticks below this are excluded from the cross-peer hash exchange, in both
  // directions. A late joiner's hashes before its boot seam describe a world
  // the other peers never had (empty, then partially bootstrapped), so
  // comparing them latches a false-positive divergence.
  compareFloor = 0
  /** display origin: protocol ticks can be large, UI shows tick - startTick */
  startTick = 0
  onLog: (line: string) => void = () => {}
  /** first hash disagreement with a peer, for post-mortem stashing */
  onDiverged: (peerId: string, tick: number) => void = () => {}

  private tickClock = new TickClock()
  private started = false
  private seq = 0
  private spawnCount = 0
  private bootAsked = false
  private nextHashTick = 0
  private nextBeatTick = 0
  private lastPing = -Infinity
  /** ops that arrived before calibration finished; folded in at start */
  private pendingOps: { from: string; i: Interaction }[] = []
  /** highest tick each peer has attested via heartbeat */
  private lastBeat = new Map<string, number>()

  constructor(
    readonly sim: Sim,
    /** to === null broadcasts; delivery to disconnected peers may drop */
    private sendRaw: (to: string | null, msg: DcMessage) => void,
    /** local clock in ms; the browser passes wallNow, the hub virtual time */
    private clock: () => number = wallNow,
  ) {}

  /** alone: the room was empty at join, so this peer roots the tick grid */
  identity(id: string, order: number, alone: boolean) {
    this.id = id
    this.order = order
    if (alone && !this.tickClock.calibrated) {
      this.tickClock.set(this.clock(), 0)
      this.start()
    }
  }

  get calibrated() { return this.tickClock.calibrated }
  tickTimeNow(now = this.clock()) { return this.tickClock.tickTimeAt(now) }
  ready() { return this.id !== '' && this.started }
  nextNetId() { return `${this.id}-${this.spawnCount++}` }

  /** Has the late-join boot settled? Scripts must not start (and e.g.
   * seed a board) while the world they would read is still in flight: a
   * rejoining peer that seeds before its boot seam folds plants a second
   * board on everyone. Boot ops are stamped BOOT_LEAD_TICKS ahead, so
   * settled means the grid has PASSED the seam tick (the ops applied) -
   * mere receipt still reads as an empty world. */
  worldSettled() {
    if (!this.bootAsked) return true
    if (this.bootSeamTick !== null && this.sim.tick > this.bootSeamTick) return true
    return this.clock() - this.startedAtMs > 5000
  }
  private bootSeamTick: number | null = null
  private startedAtMs = 0
  private calibratedFrom: string | null = null

  /** calibration is done: pin the sim to the grid and open for business */
  private start() {
    if (this.started) return
    this.started = true
    this.startedAtMs = this.clock()
    this.sim.startAt(Math.ceil(this.tickClock.tickTimeAt(this.clock())))
    this.startTick = this.sim.tick
    this.nextHashTick = this.sim.tick + HASH_EVERY_TICKS
    this.nextBeatTick = this.sim.tick + BEAT_EVERY_TICKS
    this.onLog(`tick grid ${this.calibratedFrom === null ? 'rooted' : `calibrated (adopted ${this.calibratedFrom.split(':')[0]}'s grid)`} at tick ${this.sim.tick}`)
    for (const p of this.pendingOps) this.receive(p.from, { kind: 'i', i: p.i })
    this.pendingOps.length = 0
    this.maybeBootReq()
  }

  /** the room root: the connected peer (or us) with the lowest join order */
  private rootOrder(): number {
    let min = this.order
    for (const p of this.peers.values()) min = Math.min(min, p.order)
    return min
  }

  // Joiners that ADOPTED a running grid pull a state snapshot, but only
  // once the tick grid is calibrated: boot ops carry tick stamps that
  // mean nothing to an unstarted sim. A peer that rooted its own grid
  // never pulls - it IS the world, and asking a freshly-connected senior
  // for a dump would replace a running board with whatever the senior
  // has (possibly nothing). The dump comes from the senior-most peer -
  // the most settled world; a fresh joiner's dump can race in-flight
  // ops and its seam then drops them everywhere - else from the peer
  // whose grid we adopted (a senior rejoining a room of juniors pulls
  // from them). An unstarted target ignores the request; advance()
  // re-issues until a seam arrives.
  private maybeBootReq() {
    if (!this.started || this.bootAsked || this.calibratedFrom === null) return
    let target: SessionPeer | null = null
    for (const p of this.peers.values()) {
      if (p.order < this.order && (target === null || p.order < target.order)) target = p
    }
    if (!target) target = this.peers.get(this.calibratedFrom) ?? null
    if (target) {
      this.bootAsked = true
      this.bootReqAtMs = this.clock()
      this.sendRaw(target.id, { kind: 'boot-req' })
    }
  }
  private bootReqAtMs = 0

  peerConnected(id: string, order: number) {
    if (!this.peers.has(id)) {
      this.peers.set(id, {
        id, order, rtt: 0, offset: 0, strikes: 0, excluded: false,
        checked: false, divergedAt: null, samples: [],
      })
      // Ping right away rather than waiting for the 1Hz cadence: pongs are
      // what tick calibration feeds on, and until it completes this peer
      // cannot start its sim.
      this.sendRaw(id, { kind: 'ping', t0: this.clock() })
    }
    this.maybeBootReq()
  }

  peerLeft(id: string) {
    this.peers.delete(id)
    // Everyone senior left before we calibrated: root the grid ourselves.
    if (!this.tickClock.calibrated && this.id && this.rootOrder() === this.order) {
      this.onLog('seniors left before calibration; rooting the tick grid here')
      this.tickClock.set(this.clock(), 0)
      this.start()
    }
  }

  /**
   * The transport's judgement that every senior membership is a ghost
   * (dead session whose delayed leave never fired): stop waiting for a
   * calibration pong that cannot come and root the grid here. A no-op if
   * a live senior did connect (it is in peers, so we are not the root) or
   * calibration already happened. If a senior then turns out to be alive
   * after all, its pongs trigger a hard resync + boot seam, which heals.
   */
  seniorsUnreachable() {
    if (!this.tickClock.calibrated && this.id && this.rootOrder() === this.order) {
      this.onLog('no senior is reachable (ghost memberships?); rooting the tick grid here')
      this.tickClock.set(this.clock(), 0)
      this.start()
    }
  }

  // JSON round-trips doubles exactly except that -0 becomes 0, so normalise
  // negative zeros at the source to keep local and remote inputs bit-equal.
  private z = (n: number) => n + 0 === 0 ? 0 : n
  private zv = (v: Vec3) => ({ x: this.z(v.x), y: this.z(v.y), z: this.z(v.z) })
  private zq = (q: Quat) => ({ x: this.z(q.x), y: this.z(q.y), z: this.z(q.z), w: this.z(q.w) })

  emit(type: Interaction['type'], netId: string, data: {
    pos: Vec3; vel?: Vec3; rot?: Quat; angvel?: Vec3
    grab?: { holder: string; order: number; target: Vec3 }; color?: number
    shape?: string; size?: number; unlit?: boolean; bounce?: boolean; pop?: boolean; opacity?: number
    force?: boolean; prop?: PropInfo
    yaw?: number; dims?: Vec3; solid?: boolean
    data?: string
  }, tickOverride?: number, from?: number) {
    const i: Interaction = {
      // Stamped with the tick about to be simulated, so our own sim applies
      // it with zero delay and every peer folds it at the same tick.
      peer: this.id, order: this.order, seq: this.seq++, tick: tickOverride ?? this.sim.tick,
      type, netId, pos: this.zv(data.pos), vel: data.vel && this.zv(data.vel),
      rot: data.rot && this.zq(data.rot), angvel: data.angvel && this.zv(data.angvel),
      grab: data.grab && { holder: data.grab.holder, order: data.grab.order, target: this.zv(data.grab.target) },
      from,
      color: data.color,
      shape: data.shape, size: data.size, unlit: data.unlit, bounce: data.bounce, pop: data.pop,
      opacity: data.opacity !== undefined ? this.z(data.opacity) : undefined,
      force: data.force, prop: data.prop,
      yaw: data.yaw !== undefined ? this.z(data.yaw) : undefined,
      dims: data.dims && this.zv(data.dims), solid: data.solid,
      data: data.data,
    }
    this.sim.insert(i)
    this.sendRaw(null, { kind: 'i', i })
  }

  private strike(peer: SessionPeer, detail: string) {
    peer.strikes++
    this.onLog(`dropped message from ${peer.id} (${detail})`)
    if (peer.strikes >= 10 && !peer.excluded) {
      peer.excluded = true
      this.onLog(`${peer.id} excluded from sim, an admin should kick them`)
    }
  }

  // Beats are attestations: on an ordered channel, anything stamped before
  // the author's own last beat is a provable history rewrite, however slow
  // the link. That rule plus a fold-feasibility bound replaces any fixed
  // RTT-based staleness heuristic, so honest peers may be arbitrarily laggy
  // (up to the snapshot window) without strikes.
  private admissible(peer: SessionPeer, tick: number): boolean {
    const attested = this.lastBeat.get(peer.id)
    if (attested !== undefined && tick < attested) {
      this.strike(peer, `stamped ${attested - tick} ticks before own beat: history rewrite`)
      return false
    }
    if (this.started && this.sim.tick - tick > STALE_MAX_TICKS) {
      this.strike(peer, `${this.sim.tick - tick} ticks late, beyond the fold window`)
      return false
    }
    return true
  }

  /** Continuous motion for a held entity: latest-wins, never rolls anyone
   * back; heartbeat folds heal its contact consequences. */
  streamPose(netId: string, pos: Vec3) {
    if (!this.started) return
    const p = this.zv(pos)
    this.sim.addPose(netId, this.id, this.sim.tick, p)
    this.sendRaw(null, { kind: 'pose', tick: this.sim.tick, peer: this.id, netId, pos: p })
  }

  receive(fromId: string, msg: DcMessage) {
    const peer = this.peers.get(fromId)
    if (!peer) return
    switch (msg.kind) {
      case 'ping': {
        const t1 = this.clock()
        this.sendRaw(fromId, {
          kind: 'pong', t0: msg.t0, t1,
          tt: this.tickClock.calibrated ? this.tickClock.tickTimeAt(t1) : -1,
        })
        break
      }
      case 'pong': {
        // NTP-style: keep the minimum-RTT sample's offset estimate.
        const t3 = this.clock()
        peer.samples.push({ rtt: t3 - msg.t0, offset: msg.t1 - (msg.t0 + t3) / 2 })
        if (peer.samples.length > RTT_SAMPLES) peer.samples.shift()
        const best = peer.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a))
        peer.rtt = best.rtt
        peer.offset = best.offset
        // Tick-clock discipline against the responder's grid reading. Any
        // calibrated peer's first usable pong calibrates us outright - a
        // senior rejoining a running room must adopt the world that exists,
        // not wait for (or out-rank) the juniors already playing on it.
        // After that, only the current root steers, and only by bounded
        // slew, so one bad sample cannot yank the grid. Phase error is
        // harmless for convergence (ops fold at their stamped tick
        // everywhere); this just keeps "now" aligned so folds stay shallow.
        if (msg.tt >= 0) {
          const est = msg.tt + (t3 - msg.t0) / 2 / TICK_MS
          if (!this.tickClock.calibrated) {
            this.calibratedFrom = fromId
            this.tickClock.set(t3, est)
            this.start()
          } else if (peer.order < this.order && peer.order === this.rootOrder()) {
            const delta = est - this.tickClock.tickTimeAt(t3)
            if (Math.abs(delta) > HARD_RESYNC_TICKS) {
              this.onLog(`tick clock ${delta.toFixed(1)} ticks off root; hard resync`)
              this.tickClock.set(t3, est)
              // Our grid was the wrong one (self-rooted before this live
              // senior appeared): our world state is too, so re-pull it
              // from the root that just yanked our clock.
              this.calibratedFrom = fromId
              this.bootAsked = false
              this.bootSeamTick = null
              this.maybeBootReq()
            } else {
              this.tickClock.nudge(delta)
            }
          }
        }
        break
      }
      case 'i': {
        if (peer.excluded) return
        // settled only once the grid PASSES the seam (boot ops are
        // stamped ahead; on receipt they have not applied yet)
        if (msg.i.type === 'boot') this.bootSeamTick = Math.max(this.bootSeamTick ?? -1, msg.i.tick)
        if (!this.started) { this.pendingOps.push({ from: fromId, i: msg.i }); return }
        if (!this.admissible(peer, msg.i.tick)) return
        const k = this.sim.insert(msg.i)
        // A boot seam folded into our timeline: hashes for anything older
        // describe pre-seam worlds and are not comparable across peers.
        if (msg.i.type === 'boot' && k !== null && k + 1 > this.compareFloor) {
          this.compareFloor = k + 1
          this.onLog(`boot seam from ${peer.id} at tick ${k - this.startTick}`)
        }
        break
      }
      case 'pose': {
        if (peer.excluded) return
        if (!this.admissible(peer, msg.tick)) return
        // Recorded, not folded: the next beat from this author re-simulates
        // the interval against the completed track.
        this.sim.addPose(msg.netId, msg.peer, msg.tick, msg.pos)
        break
      }
      case 'beat': {
        if (peer.excluded) return
        this.lastBeat.set(fromId, Math.max(this.lastBeat.get(fromId) ?? 0, msg.tick))
        if (!this.started) break
        // Fold one whole interval deeper than the beat, so every tick gets
        // re-simulated once after its poses fully arrived; skip when this
        // author's motion cannot have influenced the window.
        const from = msg.tick - BEAT_EVERY_TICKS
        if (this.sim.posesFrom(fromId, from, msg.tick) || this.sim.holdsAny(fromId)) {
          this.sim.foldFrom(from)
        }
        break
      }
      case 'boot-req': {
        // Dump our newest snapshot as ordinary interactions so every peer
        // (us included, via emit) folds the identical seam at the same
        // tick, stamped ahead so nobody has already passed it. An empty
        // room still gets a marker op: the seam must exist so ops that
        // raced the join are re-applied everywhere. An UNSTARTED peer
        // must never answer: its dump would be an empty world stamped on
        // a meaningless grid - a wrecking ball for the requester.
        if (!this.started) return
        const seamTick = this.sim.tick + BOOT_LEAD_TICKS
        const { from, entities } = this.sim.dumpSeam()
        if (entities.length === 0) {
          this.emit('boot', '', { pos: { x: 0, y: 0, z: 0 } }, seamTick, from)
        }
        for (const e of entities) {
          this.emit('boot', e.netId,
            { pos: e.pos, rot: e.rot, vel: e.linvel, angvel: e.angvel, grab: e.grab, color: e.color, prop: e.prop,
              data: e.data },
            seamTick, from)
        }
        break
      }
      case 'hashes': {
        for (let j = 0; j < msg.hs.length; j++) {
          const t = msg.start + j
          if (t < this.compareFloor) continue
          const theirs = msg.hs[j]
          if (!theirs) continue
          const ours = this.sim.hashes.get(t)
          if (ours === undefined) continue
          peer.checked = true
          if (ours !== theirs && peer.divergedAt === null) {
            peer.divergedAt = t
            this.onLog(`DIVERGED from ${peer.id} at tick ${t - this.startTick}`)
            this.onLog(`replay self-check: ${JSON.stringify(this.sim.verifyReplay(60))}`)
            this.onDiverged(peer.id, t)
            break
          }
        }
        break
      }
    }
  }

  /** Fold pending rollbacks; the caller captures presented poses first so it
   * can rubber-band the corrections. */
  foldIfNeeded(): boolean {
    if (!this.sim.needsResim) return false
    return this.sim.fold()
  }

  /** Drive the protocol to the current local time: step the sim, ping
   * peers, exchange settled hashes. Before calibration only the pings run
   * (they are what calibration feeds on). All timing reads this.clock();
   * mixing in any other clock would poison the RTT estimates. */
  advance() {
    const now = this.clock()
    if (this.id && now - this.lastPing >= PING_EVERY_MS) {
      this.lastPing = now
      for (const p of this.peers.values()) this.sendRaw(p.id, { kind: 'ping', t0: now })
    }
    if (!this.started) return
    // A boot-req can go unanswered (the target was still unstarted, or
    // the message was lost to a transport blip): re-issue until a seam
    // actually arrives.
    if (this.bootAsked && this.bootSeamTick === null && now - this.bootReqAtMs > 2000) {
      this.bootAsked = false
      this.maybeBootReq()
    }
    this.sim.advance(this.tickClock.tickTimeAt(now))
    if (this.sim.tick >= this.nextBeatTick) {
      this.nextBeatTick = this.sim.tick + BEAT_EVERY_TICKS
      this.sendRaw(null, { kind: 'beat', tick: this.sim.tick })
    }
    if (this.sim.tick >= this.nextHashTick) {
      this.nextHashTick = this.sim.tick + HASH_EVERY_TICKS
      const start = this.sim.tick - SETTLE_TICKS - 2 * HASH_EVERY_TICKS
      const hs: number[] = []
      for (let t = start; t < this.sim.tick - SETTLE_TICKS; t++) {
        hs.push(t < this.compareFloor ? 0 : this.sim.hashes.get(t) ?? 0)
      }
      this.sendRaw(null, { kind: 'hashes', start, hs })
    }
  }
}

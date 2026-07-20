import { BOOT_LEAD_TICKS, Sim, TICK_MS } from './sim'
import { wallNow, type DcMessage, type Interaction, type Quat, type Vec3 } from './types'

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
  // Off by default so arbitrary fake latency folds instead of dropping;
  // dropped interactions are a guaranteed permanent divergence.
  enforceStale = false
  onLog: (line: string) => void = () => {}
  /** first hash disagreement with a peer, for post-mortem stashing */
  onDiverged: (peerId: string, tick: number) => void = () => {}

  private tickClock = new TickClock()
  private started = false
  private seq = 0
  private spawnCount = 0
  private bootAsked = false
  private nextHashTick = 0
  private lastPing = -Infinity
  /** ops that arrived before calibration finished; folded in at start */
  private pendingOps: { from: string; i: Interaction }[] = []

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

  /** calibration is done: pin the sim to the grid and open for business */
  private start() {
    if (this.started) return
    this.started = true
    this.sim.startAt(Math.ceil(this.tickClock.tickTimeAt(this.clock())))
    this.startTick = this.sim.tick
    this.nextHashTick = this.sim.tick + HASH_EVERY_TICKS
    this.onLog(`tick grid ${this.order === this.rootOrder() ? 'rooted' : 'calibrated'} at tick ${this.sim.tick}`)
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

  // Late joiners pull a state snapshot from the first senior peer, but only
  // once the tick grid is calibrated: boot ops carry tick stamps that mean
  // nothing to an unstarted sim.
  private maybeBootReq() {
    if (!this.started || this.bootAsked) return
    let senior: SessionPeer | null = null
    for (const p of this.peers.values()) {
      if (p.order < this.order && (senior === null || p.order < senior.order)) senior = p
    }
    if (senior) {
      this.bootAsked = true
      this.sendRaw(senior.id, { kind: 'boot-req' })
    }
  }

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

  // JSON round-trips doubles exactly except that -0 becomes 0, so normalise
  // negative zeros at the source to keep local and remote inputs bit-equal.
  private z = (n: number) => n + 0 === 0 ? 0 : n
  private zv = (v: Vec3) => ({ x: this.z(v.x), y: this.z(v.y), z: this.z(v.z) })
  private zq = (q: Quat) => ({ x: this.z(q.x), y: this.z(q.y), z: this.z(q.z), w: this.z(q.w) })

  emit(type: Interaction['type'], netId: string, data: {
    pos: Vec3; vel?: Vec3; rot?: Quat; angvel?: Vec3
    grab?: { holder: string; order: number; target: Vec3 }; color?: number
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
    }
    this.sim.insert(i)
    this.sendRaw(null, { kind: 'i', i })
  }

  // "Too old" means significantly older than the round trip should allow.
  private staleLimit(peer: SessionPeer) { return Math.max(250, peer.rtt * 1.5 + 120) }

  private strike(peer: SessionPeer, detail: string) {
    peer.strikes++
    this.onLog(`dropped stale interaction from ${peer.id} (${detail})`)
    if (peer.strikes >= 10 && !peer.excluded) {
      peer.excluded = true
      this.onLog(`${peer.id} excluded from sim, an admin should kick them`)
    }
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
        // Tick-clock discipline against the responder's grid reading. A
        // senior peer's first usable pong calibrates us outright; after
        // that, only the current root steers, and only by bounded slew, so
        // one bad sample cannot yank the grid. Phase error is harmless for
        // convergence (ops fold at their stamped tick everywhere); this
        // just keeps "now" aligned so folds stay shallow.
        if (msg.tt >= 0 && peer.order < this.order) {
          const est = msg.tt + (t3 - msg.t0) / 2 / TICK_MS
          if (!this.tickClock.calibrated) {
            this.tickClock.set(t3, est)
            this.start()
          } else if (peer.order === this.rootOrder()) {
            const delta = est - this.tickClock.tickTimeAt(t3)
            if (Math.abs(delta) > HARD_RESYNC_TICKS) {
              this.onLog(`tick clock ${delta.toFixed(1)} ticks off root; hard resync`)
              this.tickClock.set(t3, est)
            } else {
              this.tickClock.nudge(delta)
            }
          }
        }
        break
      }
      case 'i': {
        if (peer.excluded) return
        if (!this.started) { this.pendingOps.push({ from: fromId, i: msg.i }); return }
        // Age in ticks against our own calibrated clock decides staleness.
        if (this.enforceStale) {
          const age = (this.tickTimeNow() - msg.i.tick) * TICK_MS
          const limit = this.staleLimit(peer)
          if (age > limit) { this.strike(peer, `${age.toFixed(0)}ms old, limit ${limit.toFixed(0)}ms`); return }
        }
        const k = this.sim.insert(msg.i)
        // A boot seam folded into our timeline: hashes for anything older
        // describe pre-seam worlds and are not comparable across peers.
        if (msg.i.type === 'boot' && k !== null && k + 1 > this.compareFloor) {
          this.compareFloor = k + 1
          this.onLog(`boot seam from ${peer.id} at tick ${k - this.startTick}`)
        }
        break
      }
      case 'boot-req': {
        // Dump our newest snapshot as ordinary interactions so every peer
        // (us included, via emit) folds the identical seam at the same
        // tick, stamped ahead so nobody has already passed it. An empty
        // room still gets a marker op: the seam must exist so ops that
        // raced the join are re-applied everywhere.
        const seamTick = this.sim.tick + BOOT_LEAD_TICKS
        const { from, entities } = this.sim.dumpSeam()
        if (entities.length === 0) {
          this.emit('boot', '', { pos: { x: 0, y: 0, z: 0 } }, seamTick, from)
        }
        for (const e of entities) {
          this.emit('boot', e.netId,
            { pos: e.pos, rot: e.rot, vel: e.linvel, angvel: e.angvel, grab: e.grab, color: e.color }, seamTick, from)
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
    this.sim.advance(this.tickClock.tickTimeAt(now))
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

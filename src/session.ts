import { Sim } from './sim'
import { wallNow, type DcMessage, type Interaction, type Quat, type Vec3 } from './types'

const HASH_EVERY_TICKS = 60
// Only exchange tick hashes older than this. A fold can rewrite any tick in
// the snapshot window (HISTORY_TICKS back), so anything younger can still
// change after being sent, false-positiving the divergence latch; beyond the
// window a rewrite is impossible without a clamp ANOMALY being logged.
const SETTLE_TICKS = 330
const PING_EVERY_MS = 1000
const RTT_SAMPLES = 8

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
  /** display origin: protocol ticks are huge, UI shows tick - startTick */
  startTick: number
  // Off by default so arbitrary fake latency folds instead of dropping;
  // dropped interactions are a guaranteed permanent divergence.
  enforceStale = false
  onLog: (line: string) => void = () => {}
  /** first hash disagreement with a peer, for post-mortem stashing */
  onDiverged: (peerId: string, tick: number) => void = () => {}

  private seq = 0
  private spawnCount = 0
  private bootAsked = false
  private nextHashTick: number
  private lastPing = -Infinity

  constructor(
    readonly sim: Sim,
    /** to === null broadcasts; delivery to disconnected peers may drop */
    private sendRaw: (to: string | null, msg: DcMessage) => void,
    /** local clock in ms; the browser passes wallNow, the hub virtual time */
    private clock: () => number = wallNow,
  ) {
    this.startTick = sim.tick
    this.nextHashTick = sim.tick + HASH_EVERY_TICKS
  }

  identity(id: string, order: number) {
    this.id = id
    this.order = order
  }

  ready() { return this.id !== '' }
  nextNetId() { return `${this.id}-${this.spawnCount++}` }

  peerConnected(id: string, order: number) {
    if (!this.peers.has(id)) {
      this.peers.set(id, {
        id, order, rtt: 0, offset: 0, strikes: 0, excluded: false,
        checked: false, divergedAt: null, samples: [],
      })
    }
    // Late joiners pull a state snapshot from the first senior peer they reach.
    if (!this.bootAsked && order < this.order) {
      this.bootAsked = true
      this.sendRaw(id, { kind: 'boot-req' })
    }
  }

  peerLeft(id: string) {
    this.peers.delete(id)
  }

  // JSON round-trips doubles exactly except that -0 becomes 0, so normalise
  // negative zeros at the source to keep local and remote inputs bit-equal.
  private z = (n: number) => n + 0 === 0 ? 0 : n
  private zv = (v: Vec3) => ({ x: this.z(v.x), y: this.z(v.y), z: this.z(v.z) })
  private zq = (q: Quat) => ({ x: this.z(q.x), y: this.z(q.y), z: this.z(q.z), w: this.z(q.w) })

  emit(type: Interaction['type'], netId: string, data: {
    pos: Vec3; vel?: Vec3; rot?: Quat; angvel?: Vec3
    grab?: { holder: string; order: number; target: Vec3 }; color?: number
  }) {
    const i: Interaction = {
      peer: this.id, order: this.order, seq: this.seq++, t: this.clock(),
      type, netId, pos: this.zv(data.pos), vel: data.vel && this.zv(data.vel),
      rot: data.rot && this.zq(data.rot), angvel: data.angvel && this.zv(data.angvel),
      grab: data.grab && { holder: data.grab.holder, order: data.grab.order, target: this.zv(data.grab.target) },
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
      case 'ping':
        this.sendRaw(fromId, { kind: 'pong', t0: msg.t0, t1: this.clock() })
        break
      case 'pong': {
        // NTP-style: keep the minimum-RTT sample's offset estimate.
        const t3 = this.clock()
        peer.samples.push({ rtt: t3 - msg.t0, offset: msg.t1 - (msg.t0 + t3) / 2 })
        if (peer.samples.length > RTT_SAMPLES) peer.samples.shift()
        const best = peer.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a))
        peer.rtt = best.rtt
        peer.offset = best.offset
        break
      }
      case 'i': {
        if (peer.excluded) return
        // The claimed timestamp is trusted as-is; age against our own wall
        // clock decides staleness (peer.offset is reported, not applied).
        if (this.enforceStale) {
          const age = this.clock() - msg.i.t
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
      case 'boot-req':
        // Dump our world as ordinary interactions so every peer (us
        // included, via emit) folds the identical seam at the same tick.
        for (const e of this.sim.dump()) {
          this.emit('boot', e.netId, { pos: e.pos, rot: e.rot, vel: e.linvel, angvel: e.angvel, grab: e.grab, color: e.color })
        }
        break
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

  /** Drive the protocol to local time `now`: step the sim, ping peers,
   * exchange settled hashes. */
  advance(now: number) {
    if (this.id && now - this.lastPing >= PING_EVERY_MS) {
      this.lastPing = now
      for (const p of this.peers.values()) this.sendRaw(p.id, { kind: 'ping', t0: now })
    }
    this.sim.advance(now)
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

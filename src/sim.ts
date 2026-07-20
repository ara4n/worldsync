import RAPIER from '@dimforge/rapier3d-deterministic-compat'
import { wallNow, type BootEntity, type Interaction, type Vec3 } from './types'
import { ensureEntity, entityFor, Position, Rotation, PrevPosition, PrevRotation, Tint } from './ecs'

export const TICK_MS = 1000 / 30
export const HISTORY_TICKS = 150 // 5s rollback window, so high fake latency still folds correctly
export const BOX_HALF = 0.5
const MAX_CATCHUP = 60
const MAX_FUTURE_TICKS = 15 // tolerate ~500ms of claimed-future clock skew
const INPUT_LOG_MAX = 100000

/** One line of the input log: exactly what entered the sim, at which tick. */
export interface InputLogEntry {
  tick: number
  claimedTick: number // differs from tick only when clamped (anomaly)
  t: number
  peer: string
  order: number
  seq: number
  type: string
  netId: string
  pos: Vec3
  vel?: Vec3
  color?: number
}
const ZERO: Vec3 = { x: 0, y: 0, z: 0 }

interface Grab { holder: string; order: number; target: Vec3 }
interface HistoryRec { snap: Uint8Array; bodies: Map<string, number>; grabs: Map<string, Grab> }
interface Entry { tick: number; t: number; order: number; seq: number; i: Interaction }

/** Everything a simulation step touches; the live sim and scratch replay
 * verification worlds both step through the same code via one of these. */
interface Ctx { world: RAPIER.World; bodies: Map<string, number>; grabs: Map<string, Grab> }

function bodyOf(ctx: Ctx, netId: string): RAPIER.RigidBody | null {
  const h = ctx.bodies.get(netId)
  if (h === undefined) return null
  return ctx.world.getRigidBody(h) ?? null
}

// Bit-exact FNV hash over every body's pose and velocities, iterated in
// sorted netId order so map insertion order cannot matter.
const hashF64 = new Float64Array(13)
const hashBytes = new Uint8Array(hashF64.buffer)
function hashCtx(ctx: Ctx): number {
  let h = 0x811c9dc5
  for (const netId of [...ctx.bodies.keys()].sort()) {
    for (let i = 0; i < netId.length; i++) h = Math.imul(h ^ netId.charCodeAt(i), 0x01000193)
    const b = bodyOf(ctx, netId)
    if (!b) continue
    const p = b.translation(), r = b.rotation(), lv = b.linvel(), av = b.angvel()
    hashF64[0] = p.x; hashF64[1] = p.y; hashF64[2] = p.z
    hashF64[3] = r.x; hashF64[4] = r.y; hashF64[5] = r.z; hashF64[6] = r.w
    hashF64[7] = lv.x; hashF64[8] = lv.y; hashF64[9] = lv.z
    hashF64[10] = av.x; hashF64[11] = av.y; hashF64[12] = av.z
    for (let i = 0; i < 104; i++) h = Math.imul(h ^ hashBytes[i], 0x01000193)
    h = Math.imul(h ^ (b.isSleeping() ? 1 : 0), 0x01000193)
  }
  return h >>> 0
}

// The claimed wall-clock timestamp decides what happened when, both across
// and within ticks; (order, seq) only breaks exact-timestamp ties so every
// peer still converges on one total order.
const before = (a: Entry, b: Entry) =>
  a.tick !== b.tick ? a.tick < b.tick :
  a.t !== b.t ? a.t < b.t :
  a.order !== b.order ? a.order < b.order : a.seq < b.seq

function cloneGrabs(m: Map<string, Grab>): Map<string, Grab> {
  const out = new Map<string, Grab>()
  for (const [k, g] of m) out.set(k, { holder: g.holder, order: g.order, target: { ...g.target } })
  return out
}

function boxCollider() {
  return RAPIER.ColliderDesc.cuboid(BOX_HALF, BOX_HALF, BOX_HALF).setRestitution(0.3).setFriction(0.8)
}

const vec = (v: { x: number; y: number; z: number }): Vec3 => ({ x: v.x, y: v.y, z: v.z })

function fnvBytes(u: Uint8Array): number {
  let h = 0x811c9dc5
  for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i], 0x01000193)
  return h >>> 0
}

/**
 * Locally simulated Rapier world with a rollback window.
 *
 * The tick grid is global: tick K covers wall-clock time [K*TICK_MS,
 * (K+1)*TICK_MS), so every peer bins a claimed timestamp into the same tick
 * (to the extent wall clocks agree). Combined with the deterministic Rapier
 * build and physics being driven only by timeline interactions, peers step
 * the same inputs on the same ticks and should converge exactly.
 *
 * Convention: `tick` is the tick about to be simulated; world state is "the
 * beginning of tick N". history[N] snapshots that state, so folding in an
 * interaction at tick K means: restore history[K], insert it into the
 * timeline, and re-step K..N applying every timeline entry on its tick.
 *
 * The netId -> body handle map and the grab table are snapshotted alongside
 * the physics state, because a replay can recreate bodies in a different
 * order (and hence with different handles) than the original run.
 */
export class Sim {
  world!: RAPIER.World
  tick = 0
  bodies = new Map<string, number>()
  grabs = new Map<string, Grab>()
  rollbacks = 0
  lastReplayDepth = 0
  /**
   * Everything that has ever been fed into this Rapier world, with the tick
   * it was applied at, full float precision. Download it on two peers and
   * diff (sorted by tick, t, order, seq) to find where they disagreed.
   */
  inputLog: InputLogEntry[] = []
  /** Anomalies that are expected to cause divergence (tick jumps, clamps). */
  onAnomaly: (msg: string) => void = () => {}
  /** Bit-exact state hash at the START of each tick, on the global tick
   * grid, rewritten by rollbacks; peers exchange settled ranges of these to
   * find the first tick at which their worlds disagreed. */
  hashes = new Map<number, number>()
  /** FNV over the full snapshot bytes at the start of each tick: catches
   * divergence in solver-internal state before it reaches the poses. */
  byteHashes = new Map<number, number>()
  /** EMA of full tick cost in ms (snapshot + normalise restore + step). */
  stepMs = 0
  private history = new Map<number, HistoryRec>()
  private timeline: Entry[] = []
  private seen = new Set<string>()
  private resimFrom: number | null = null

  async init() {
    await RAPIER.init()
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 })
    this.world.timestep = 1 / 30
    const ground = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed())
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(20, 0.5, 20).setTranslation(0, -0.5, 0), ground)
    this.tick = this.tickOf(wallNow())
  }

  get needsResim() { return this.resimFrom !== null }

  tickOf(t: number) { return Math.floor(t / TICK_MS) }

  body(netId: string): RAPIER.RigidBody | null {
    const h = this.bodies.get(netId)
    if (h === undefined) return null
    return this.world.getRigidBody(h) ?? null
  }

  /**
   * Queue an interaction at the tick its claimed timestamp falls in. A past
   * tick schedules a rollback; the current (not yet simulated) tick and
   * claimed-future ticks are simply applied when that tick is stepped, which
   * still honours the claimed time. Ticks older than the available snapshot
   * history (young sim, just after a sleep jump) clamp to the oldest
   * snapshot; genuinely stale peers are already filtered by the RTT-based
   * age check before this is called.
   */
  insert(i: Interaction) {
    const key = `${i.peer}:${i.seq}`
    if (this.seen.has(key)) return
    const claimedTick = this.tickOf(i.t)
    let k = claimedTick
    if (k > this.tick + MAX_FUTURE_TICKS) k = this.tick + MAX_FUTURE_TICKS
    if (k < this.tick) k = Math.max(k, this.tick - this.history.size)
    if (k !== claimedTick) {
      this.onAnomaly(`clamped ${i.type} from ${i.peer} by ${k - claimedTick} ticks; sims will diverge`)
    }
    this.seen.add(key)
    if (this.inputLog.length < INPUT_LOG_MAX) {
      this.inputLog.push({
        tick: k, claimedTick, t: i.t, peer: i.peer, order: i.order, seq: i.seq,
        type: i.type, netId: i.netId, pos: i.pos, vel: i.vel, color: i.color,
      })
    }
    const entry: Entry = { tick: k, t: i.t, order: i.order, seq: i.seq, i }
    let lo = 0, hi = this.timeline.length
    while (lo < hi) { const m = (lo + hi) >> 1; if (before(this.timeline[m], entry)) lo = m + 1; else hi = m }
    this.timeline.splice(lo, 0, entry)
    if (k < this.tick) this.resimFrom = this.resimFrom === null ? k : Math.min(this.resimFrom, k)
  }

  /** Roll back and replay if any past-tick interactions arrived. Returns true if state was rewritten. */
  fold(): boolean {
    if (this.resimFrom === null) return false
    const k = this.resimFrom
    this.resimFrom = null
    const target = this.tick
    const rec = this.history.get(k)!
    this.world.free()
    this.world = RAPIER.World.restoreSnapshot(rec.snap)
    this.world.timestep = 1 / 30
    this.bodies = new Map(rec.bodies)
    this.grabs = cloneGrabs(rec.grabs)
    this.tick = k
    while (this.tick < target) this.step()
    this.rollbacks++
    this.lastReplayDepth = target - k
    return true
  }

  advance(now: number) {
    let n = 0
    while (this.tickOf(now) > this.tick && n < MAX_CATCHUP) { this.step(); n++ }
    // Stalled hard: jump to the current global tick instead of grinding
    // through the backlog. Old snapshots are from before the gap and cannot
    // seed a replay across it, so drop them.
    if (this.tickOf(now) > this.tick) {
      const skipped = this.tickOf(now) - this.tick
      this.tick = this.tickOf(now)
      this.history.clear()
      this.onAnomaly(`jumped ${skipped} ticks without simulating; sims will diverge`)
    }
  }

  private liveCtx(): Ctx { return { world: this.world, bodies: this.bodies, grabs: this.grabs } }

  private applyTick(ctx: Ctx, tick: number) {
    for (const e of this.timeline) {
      if (e.tick > tick) break
      if (e.tick === tick) this.applyTo(ctx, e.i)
    }
  }

  // Grabbed bodies are pinned to their drag target each tick; contacts still
  // resolve, so a held box shoves others out of the way.
  private pinAndStep(ctx: Ctx) {
    for (const [netId, g] of ctx.grabs) {
      const b = bodyOf(ctx, netId)
      if (!b) continue
      b.setTranslation(g.target, true)
      b.setLinvel(ZERO, true)
      b.setAngvel(ZERO, true)
    }
    ctx.world.step()
  }

  private step() {
    const t0 = performance.now()
    const snap = this.world.takeSnapshot()
    this.history.set(this.tick, {
      snap,
      bodies: new Map(this.bodies),
      grabs: cloneGrabs(this.grabs),
    })
    this.history.delete(this.tick - HISTORY_TICKS)
    // Normalise: EVERY tick, on every peer, steps a freshly restored world.
    // Rapier keeps solver-internal state (contact manifolds, warm starts)
    // that evolves differently down a fold-then-replay path than down a
    // continuous live path, and under contact stress that changes outcomes.
    // Restoring from the snapshot we just took drops any non-serialised
    // residue and rebuilds the rest identically everywhere, making live
    // stepping and rollback replay the same operation by construction.
    this.world.free()
    this.world = RAPIER.World.restoreSnapshot(snap)
    this.world.timestep = 1 / 30
    const ctx = this.liveCtx()
    this.applyTick(ctx, this.tick)
    this.writePrev()
    this.pinAndStep(ctx)
    this.tick++
    this.hashes.set(this.tick, hashCtx(ctx))
    this.hashes.delete(this.tick - 2 * HISTORY_TICKS)
    this.byteHashes.set(this.tick, fnvBytes(ctx.world.takeSnapshot()))
    this.byteHashes.delete(this.tick - 2 * HISTORY_TICKS)
    while (this.timeline.length && this.timeline[0].tick < this.tick - HISTORY_TICKS) this.timeline.shift()
    this.stepMs = this.stepMs * 0.95 + (performance.now() - t0) * 0.05
  }

  /**
   * Determinism self-check: restore the snapshot `depth` ticks back into a
   * scratch world, replay the same timeline, and compare against the live
   * world. posesMatch compares the bit-exact state hash; bytesMatch compares
   * whole snapshots (may be false for cosmetic serialisation differences
   * even when the physics agrees). If posesMatch is false, restore+replay
   * does not reproduce live stepping and peers that roll back will diverge
   * from peers that do not, even with identical inputs.
   */
  verifyReplay(depth = 60): { posesMatch: boolean; bytesMatch: boolean; depth: number } | { error: string } {
    const from = this.tick - depth
    const rec = this.history.get(from)
    if (!rec) return { error: `no snapshot ${depth} ticks back` }
    const ctx: Ctx = {
      world: RAPIER.World.restoreSnapshot(rec.snap),
      bodies: new Map(rec.bodies),
      grabs: cloneGrabs(rec.grabs),
    }
    ctx.world.timestep = 1 / 30
    for (let t = from; t < this.tick; t++) {
      // mirror the per-tick normalisation of step()
      const s = ctx.world.takeSnapshot()
      ctx.world.free()
      ctx.world = RAPIER.World.restoreSnapshot(s)
      ctx.world.timestep = 1 / 30
      this.applyTick(ctx, t)
      this.pinAndStep(ctx)
    }
    const posesMatch = hashCtx(ctx) === hashCtx(this.liveCtx())
    const a = this.world.takeSnapshot(), b = ctx.world.takeSnapshot()
    let bytesMatch = a.length === b.length
    if (bytesMatch) for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { bytesMatch = false; break }
    ctx.world.free()
    return { posesMatch, bytesMatch, depth }
  }

  /**
   * Post-mortem: restore the stored snapshot at `tick` and dump every body's
   * state, both human-readable and as bit-exact hex, keyed by netId. Two
   * peers' dumps for the first divergent tick show exactly which body went
   * off and by how much (1 ulp = engine drift, big jump = logic bug).
   */
  stateAt(tick: number): Record<string, string> | null {
    const rec = this.history.get(tick)
    if (!rec) return null
    const w = RAPIER.World.restoreSnapshot(rec.snap)
    const dv = new DataView(hashF64.buffer)
    const out: Record<string, string> = {}
    for (const netId of [...rec.bodies.keys()].sort()) {
      const b = w.getRigidBody(rec.bodies.get(netId)!)
      if (!b) { out[netId] = 'missing'; continue }
      const p = b.translation(), r = b.rotation(), lv = b.linvel(), av = b.angvel()
      hashF64[0] = p.x; hashF64[1] = p.y; hashF64[2] = p.z
      hashF64[3] = r.x; hashF64[4] = r.y; hashF64[5] = r.z; hashF64[6] = r.w
      hashF64[7] = lv.x; hashF64[8] = lv.y; hashF64[9] = lv.z
      hashF64[10] = av.x; hashF64[11] = av.y; hashF64[12] = av.z
      let hex = ''
      for (let i = 0; i < 13; i++) hex += dv.getBigUint64(i * 8).toString(16).padStart(16, '0')
      const g = rec.grabs.get(netId)
      out[netId] = `p=${p.x.toFixed(6)},${p.y.toFixed(6)},${p.z.toFixed(6)}`
        + ` v=${lv.x.toFixed(6)},${lv.y.toFixed(6)},${lv.z.toFixed(6)}`
        + (b.isSleeping() ? ' asleep' : '')
        + (g ? ` grab=${g.holder}` : '') + ` bits=${hex}`
    }
    w.free()
    return out
  }

  /** Raw stored snapshot bytes for a tick still in the history window. */
  snapshotAt(tick: number): Uint8Array | null {
    return this.history.get(tick)?.snap ?? null
  }

  /** Is serialize -> restore -> serialize byte-stable for the live world? */
  roundTrip(): { equal: boolean; firstDiff: number; len1: number; len2: number } {
    const s1 = this.world.takeSnapshot()
    const w2 = RAPIER.World.restoreSnapshot(s1)
    const s2 = w2.takeSnapshot()
    w2.free()
    let firstDiff = -1
    const n = Math.min(s1.length, s2.length)
    for (let i = 0; i < n; i++) if (s1[i] !== s2[i]) { firstDiff = i; break }
    return { equal: s1.length === s2.length && firstDiff === -1, firstDiff, len1: s1.length, len2: s2.length }
  }

  private applyTo(ctx: Ctx, i: Interaction) {
    switch (i.type) {
      case 'spawn': {
        if (ctx.bodies.has(i.netId)) return
        // canSleep(false): the sleep timer is transient solver state that
        // does not survive snapshot restore, so peers that roll back a lot
        // put bodies to sleep later than peers that step live, and a
        // sleeping body diverges from a settling one. No sleep, no drift.
        const body = ctx.world.createRigidBody(
          RAPIER.RigidBodyDesc.dynamic().setCanSleep(false).setTranslation(i.pos.x, i.pos.y, i.pos.z))
        ctx.world.createCollider(boxCollider(), body)
        ctx.bodies.set(i.netId, body.handle)
        ensureEntity(i.netId, i.color ?? 0xffffff)
        return
      }
      case 'grab': {
        const b = bodyOf(ctx, i.netId)
        if (!b) return
        // The grabber teleports the body to their presented pose, which is the
        // "override the rubber-banded view" rule from the design.
        b.setTranslation(i.pos, true)
        b.setLinvel(ZERO, true)
        b.setAngvel(ZERO, true)
        ctx.grabs.set(i.netId, { holder: i.peer, order: i.order, target: { ...i.pos } })
        return
      }
      case 'move': {
        if (!ctx.bodies.has(i.netId)) return
        // Last writer wins, including stealing the grab: contested drags
        // become an explicit tug of war resolved by interaction order.
        ctx.grabs.set(i.netId, { holder: i.peer, order: i.order, target: { ...i.pos } })
        return
      }
      case 'release': {
        const g = ctx.grabs.get(i.netId)
        if (!g || g.holder !== i.peer) return
        ctx.grabs.delete(i.netId)
        const b = bodyOf(ctx, i.netId)
        if (b && i.vel) b.setLinvel(i.vel, true)
        return
      }
    }
  }

  /**
   * Record the pre-step pose of every body so rendering can interpolate
   * between tick N-1 and tick N. Runs inside step(), after interactions have
   * applied (so a grab teleport does not smear) and before the world steps.
   */
  private writePrev() {
    for (const [netId, h] of this.bodies) {
      const b = this.world.getRigidBody(h)
      if (!b) continue
      const eid = entityFor(netId)
      if (eid === undefined) continue
      const p = b.translation(), q = b.rotation()
      PrevPosition.x[eid] = p.x; PrevPosition.y[eid] = p.y; PrevPosition.z[eid] = p.z
      PrevRotation.x[eid] = q.x; PrevRotation.y[eid] = q.y; PrevRotation.z[eid] = q.z; PrevRotation.w[eid] = q.w
    }
  }

  /** Copy body poses into the bitECS Position/Rotation stores for rendering. */
  mirror() {
    for (const [netId, h] of this.bodies) {
      const b = this.world.getRigidBody(h)
      if (!b) continue
      const eid = entityFor(netId)
      if (eid === undefined) continue
      const p = b.translation(), q = b.rotation()
      Position.x[eid] = p.x; Position.y[eid] = p.y; Position.z[eid] = p.z
      Rotation.x[eid] = q.x; Rotation.y[eid] = q.y; Rotation.z[eid] = q.z; Rotation.w[eid] = q.w
    }
  }

  dump(): BootEntity[] {
    const out: BootEntity[] = []
    for (const [netId, h] of this.bodies) {
      const b = this.world.getRigidBody(h)
      const eid = entityFor(netId)
      if (!b || eid === undefined) continue
      const q = b.rotation()
      out.push({
        netId,
        color: Tint.value[eid],
        pos: vec(b.translation()),
        rot: { x: q.x, y: q.y, z: q.z, w: q.w },
        linvel: vec(b.linvel()),
        angvel: vec(b.angvel()),
      })
    }
    return out
  }

  applyBoot(entities: BootEntity[]) {
    for (const e of entities) {
      if (this.bodies.has(e.netId)) continue
      if (this.inputLog.length < INPUT_LOG_MAX) {
        this.inputLog.push({
          tick: this.tick, claimedTick: this.tick, t: 0, peer: 'boot', order: -1, seq: 0,
          type: 'boot', netId: e.netId, pos: e.pos, vel: e.linvel, color: e.color,
        })
      }
      const body = this.world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setCanSleep(false)
          .setTranslation(e.pos.x, e.pos.y, e.pos.z)
          .setRotation(e.rot)
          .setLinvel(e.linvel.x, e.linvel.y, e.linvel.z)
          .setAngvel(e.angvel))
      this.world.createCollider(boxCollider(), body)
      this.bodies.set(e.netId, body.handle)
      const eid = ensureEntity(e.netId, e.color)
      // Seed both interpolation endpoints so the first frame does not smear
      // the booted box in from the origin.
      PrevPosition.x[eid] = e.pos.x; PrevPosition.y[eid] = e.pos.y; PrevPosition.z[eid] = e.pos.z
      PrevRotation.x[eid] = e.rot.x; PrevRotation.y[eid] = e.rot.y; PrevRotation.z[eid] = e.rot.z; PrevRotation.w[eid] = e.rot.w
    }
  }
}

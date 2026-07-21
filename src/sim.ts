import RAPIER from '@dimforge/rapier3d-deterministic-compat'
import { type BootEntity, type Interaction, type PropInfo, type Quat, type Vec3 } from './types'
import { createEcsStore } from './ecs'

export const TICK_HZ = 60
export const TICK_MS = 1000 / TICK_HZ
export const HISTORY_TICKS = 300 // 5s rollback window, so high fake latency still folds correctly
// Boot seams are stamped this far ahead of the sender's present so no peer
// has already passed the seam tick when it arrives. Kept below
// MAX_FUTURE_TICKS so third peers never clamp it.
export const BOOT_LEAD_TICKS = 12
export const BOX_HALF = 0.5
const MAX_CATCHUP = 120
const MAX_FUTURE_TICKS = 30 // tolerate ~500ms of claimed-future clock skew
const INPUT_LOG_MAX = 100000

/** One line of the input log: exactly what entered the sim, at which tick. */
export interface InputLogEntry {
  tick: number
  claimedTick: number // differs from tick only when clamped (anomaly)
  peer: string
  order: number
  seq: number
  type: string
  netId: string
  pos: Vec3
  vel?: Vec3
  rot?: Quat
  angvel?: Vec3
  color?: number
}
const ZERO: Vec3 = { x: 0, y: 0, z: 0 }

interface Grab { holder: string; order: number; target: Vec3; since: number }
/** Kinematic, physics-free entity (a dots-demo sphere): everything here is
 * plain folded state, mutated only by ops, so it participates in rollback
 * and the cross-peer hash like body poses do. `claim` is the coordination
 * primitive: set by the first 'claim' op to arrive in timeline order. */
export interface Prop {
  kind: string; pos: Vec3; color: number; size: number; unlit: boolean; claim: string | null
  yaw?: number; dims?: Vec3; solid?: boolean
  /** solid only: the fixed body's handle. Valid across snapshot restores
   * (rapier serialization preserves handles); cleared with the world. */
  handle?: number
}
/** Baked triangle soup for a glTF scene's fixed collider; every peer parses
 * it from the same GLB bytes, so the arrays are bit-identical everywhere. */
export interface SceneGeometry { vertices: Float32Array; indices: Uint32Array }
/** The active scene: url keys the registered geometry, body is the fixed
 * trimesh body's handle (-1 while the geometry has not arrived yet), tick
 * is when the scene applied (the heal-fold target once it does arrive). */
interface SceneRef { url: string; body: number; tick: number }
interface HistoryRec {
  snap: Uint8Array
  bodies: Map<string, number>
  grabs: Map<string, Grab>
  props: Map<string, Prop>
  scene: SceneRef | null
}
interface Entry { tick: number; order: number; seq: number; i: Interaction }

/** Everything a simulation step touches; the live sim and scratch replay
 * verification worlds both step through the same code via one of these. */
interface Ctx {
  world: RAPIER.World
  bodies: Map<string, number>
  grabs: Map<string, Grab>
  props: Map<string, Prop>
  scene: SceneRef | null
}

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
  // Props are folded state too: position, color, size and claim all matter
  // for convergence, so they join the settled-hash exchange.
  const str = (s: string) => { for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) }
  for (const netId of [...ctx.props.keys()].sort()) {
    const p = ctx.props.get(netId)!
    str(netId)
    str(p.kind)
    hashF64[0] = p.pos.x; hashF64[1] = p.pos.y; hashF64[2] = p.pos.z; hashF64[3] = p.size
    for (let i = 0; i < 32; i++) h = Math.imul(h ^ hashBytes[i], 0x01000193)
    h = Math.imul(h ^ p.color, 0x01000193)
    h = Math.imul(h ^ (p.unlit ? 1 : 0), 0x01000193)
    if (p.solid && p.dims) {
      // a solid's collider geometry shapes box physics: hash it too
      hashF64[0] = p.yaw ?? 0; hashF64[1] = p.dims.x; hashF64[2] = p.dims.y; hashF64[3] = p.dims.z
      for (let i = 0; i < 32; i++) h = Math.imul(h ^ hashBytes[i], 0x01000193)
    }
    str(p.claim ?? '')
  }
  return h >>> 0
}

// Total order on the shared timeline: the author-stamped tick decides what
// happened when; (order, seq) breaks within-tick ties deterministically.
// All-integer keys, so no float formatting can perturb the order.
const before = (a: Entry, b: Entry) =>
  a.tick !== b.tick ? a.tick < b.tick :
  a.order !== b.order ? a.order < b.order : a.seq < b.seq

function cloneGrabs(m: Map<string, Grab>): Map<string, Grab> {
  const out = new Map<string, Grab>()
  for (const [k, g] of m) out.set(k, { holder: g.holder, order: g.order, target: { ...g.target }, since: g.since })
  return out
}

function cloneProps(m: Map<string, Prop>): Map<string, Prop> {
  const out = new Map<string, Prop>()
  for (const [k, p] of m) out.set(k, { ...p, pos: { ...p.pos } })
  return out
}

function boxCollider() {
  return RAPIER.ColliderDesc.cuboid(BOX_HALF, BOX_HALF, BOX_HALF).setRestitution(0.3).setFriction(0.8)
}

const vec = (v: { x: number; y: number; z: number }): Vec3 => ({ x: v.x, y: v.y, z: v.z })

/** The ground body's handle: identical in every world buildWorld makes
 * (first body in a fresh world) and stable across snapshot restore. */
let GROUND_HANDLE = -1

/** Fresh world with just the ground, the common ancestor every peer can
 * rebuild identically (init and boot-seam resets both start here). */
function buildWorld(): RAPIER.World {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 })
  world.timestep = 1 / TICK_HZ
  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed())
  world.createCollider(RAPIER.ColliderDesc.cuboid(20, 0.5, 20).setTranslation(0, -0.5, 0), ground)
  GROUND_HANDLE = ground.handle
  return world
}

/**
 * How the per-tick normalisation (invariant: every peer steps from the same
 * effective state every tick) is achieved:
 * - 'restore': free the world and rebuild it from the snapshot just taken.
 *   Maximally paranoid; pays a full serialise + deserialise every tick.
 * - 'pipeline': keep the world, but replace the two objects step() consults
 *   that takeSnapshot() does NOT serialise (PhysicsPipeline, CCDSolver) with
 *   fresh ones. A restored world differs from a live one only in getting
 *   fresh copies of exactly these, so if serialisation is faithful this is
 *   equivalent to 'restore' at a fraction of the cost.
 * All peers in a room must use the same mode.
 */
export type NormalizeMode = 'restore' | 'pipeline'

// The wrapper classes are not exported by the package; capture their
// constructors from a live world (both take no args and build fresh raws).
let PipelineCtor: new () => RAPIER.World['physicsPipeline']
let CcdCtor: new () => RAPIER.World['ccdSolver']

function resetSolvers(world: RAPIER.World) {
  world.physicsPipeline.free()
  world.physicsPipeline = new PipelineCtor()
  world.ccdSolver.free()
  world.ccdSolver = new CcdCtor()
}

/**
 * Locally simulated Rapier world with a rollback window.
 *
 * The tick grid is shared by the whole room: ops carry the tick number they
 * belong to, stamped by their author, and every peer folds an op at exactly
 * that tick. What tick "now" is comes from the Session's calibrated tick
 * clock, not from wall time. Combined with the deterministic Rapier build
 * and physics being driven only by timeline interactions, peers step the
 * same inputs on the same ticks and converge exactly.
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
  /** This sim's private ECS universe (render-facing mirror of body state). */
  ecs = createEcsStore()
  tick = 0
  bodies = new Map<string, number>()
  grabs = new Map<string, Grab>()
  /** kinematic physics-free entities (see Prop); folded state like bodies */
  props = new Map<string, Prop>()
  /** the active glTF scene (never in `bodies`: not hashed, not dumped) */
  scene: SceneRef | null = null
  private sceneGeoms = new Map<string, SceneGeometry>()
  private sceneWarned = new Set<string>()
  get sceneUrl(): string | null { return this.scene?.url ?? null }
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
  anomalies: string[] = []
  private anomaly(msg: string) {
    this.anomalies.push(msg)
    this.onAnomaly(msg)
  }
  /** Bit-exact state hash at the START of each tick, on the global tick
   * grid, rewritten by rollbacks; peers exchange settled ranges of these to
   * find the first tick at which their worlds disagreed. Poses/velocities
   * only: whole-snapshot bytes are NOT comparable across peers, because
   * Rapier serialises a per-step counter and a folding peer steps more
   * times (replays) than a live one. verifyReplay still compares bytes
   * locally, where step counts do line up. */
  hashes = new Map<number, number>()
  /** EMA of full tick cost in ms (snapshot + normalise restore + step). */
  stepMs = 0
  /** EMA breakdown of stepMs: snapshot+history, normalise, physics step,
   * hashes+bookkeeping. */
  perf = { snap: 0, norm: 0, phys: 0, hash: 0 }
  normalizeMode: NormalizeMode = 'restore'
  /**
   * Snapshot + normalise every K GRID-ALIGNED ticks instead of every tick
   * (rollbacks round down to the nearest cadence point). Cadence points are
   * shared across peers because tick numbers are global, so a folding peer's
   * replay performs restores at exactly the ticks the live path performed
   * them; between cadence points both paths run the same uninterrupted
   * steps. Divides the snapshot+restore cost by K at the price of up to
   * K-1 extra replayed ticks per fold. Must match across peers. Validated
   * bit-exact at 10 by the 150-box stress; ?cad=1 restores the old
   * every-tick behaviour.
   */
  cadence = 10
  private history = new Map<number, HistoryRec>()
  private timeline: Entry[] = []
  private seen = new Set<string>()
  private resimFrom: number | null = null
  /**
   * The pose plane: continuous drag motion as latest-wins streams that
   * NEVER cause rollbacks, recorded per (entity, author) sorted by tick so
   * replays read the poses that belong to the tick being re-simulated,
   * however late they arrived. Deliberately NOT snapshotted: tracks are
   * append-only observations, not simulated state.
   */
  private tracks = new Map<string, Map<string, { tick: number; pos: Vec3 }[]>>()

  addPose(netId: string, peer: string, tick: number, pos: Vec3) {
    let byPeer = this.tracks.get(netId)
    if (!byPeer) this.tracks.set(netId, (byPeer = new Map()))
    let arr = byPeer.get(peer)
    if (!arr) byPeer.set(peer, (arr = []))
    let i = arr.length
    while (i > 0 && arr[i - 1].tick > tick) i--
    arr.splice(i, 0, { tick, pos })
  }

  /**
   * The pin target for a held body at `tick`: velocity-faithful, not
   * latest-wins. A latest-wins pin multiplies the held body's instantaneous
   * velocity whenever samples and ticks misalign (the target holds still,
   * then jumps N samples' worth in one tick - a 4:1 cadence mismatch was
   * measured quadrupling it), and the infinite-mass kinematic body then
   * rams the pile at that phantom speed. Instead the pin approaches the
   * newest sample no faster than the hand's measured rate, spreading a
   * sample that arrives after a gap over the ticks it actually covers.
   *
   * Crucially this reads ONLY samples stamped at or before `tick`: a pin
   * that peeked at later samples (e.g. interpolating between brackets)
   * would compute different values live than on replay, and the holder's
   * own live history - which is never re-simulated, its own samples being
   * always complete - would permanently diverge from what remote peers
   * heal to. With samples-≤-tick only, heartbeat folds converge every peer
   * onto the holder's exact path: each fold re-steps a window whose
   * samples fully arrived before its beat, re-snapshotting as it goes, so
   * the g.target recursion (carried from tick to tick, snapshotted with
   * the grab table) is re-seeded correctly by induction.
   * Samples from before this grab (`since`) never drive it.
   */
  private pinTarget(g: Grab, netId: string, tick: number): Vec3 {
    const arr = this.tracks.get(netId)?.get(g.holder)
    if (!arr || arr.length === 0) return g.target
    let a = -1
    for (let i = arr.length - 1; i >= 0; i--) {
      const s = arr[i]
      if (s.tick < g.since) break
      if (s.tick > tick) continue
      a = i
      break
    }
    if (a < 0) return g.target
    const sa = arr[a]
    const mix = (u: Vec3, v: Vec3, f: number): Vec3 =>
      ({ x: u.x + (v.x - u.x) * f, y: u.y + (v.y - u.y) * f, z: u.z + (v.z - u.z) * f })
    // Rate-limit the catch-up to the hand's measured speed. This applies
    // even when the newest sample is stamped at this very tick: a sample
    // that arrives after a gap CONTAINS the gap's accumulated motion, and
    // that tick is precisely when a latest-wins pin would spike.
    // Rate baseline of several ticks: stamp jitter can land two samples on
    // one tick (or none), which corrupts a one-tick rate estimate in either
    // direction; a >=6-tick window averages it out. Fall back to the
    // nearest distinct-tick sample for very young grabs.
    let pi = a - 1
    while (pi >= 0 && arr[pi].tick > sa.tick - 6 && arr[pi].tick >= g.since) pi--
    if (pi < 0 || arr[pi].tick < g.since) {
      pi = a - 1
      while (pi >= 0 && arr[pi].tick === sa.tick) pi--
    }
    const prev = pi >= 0 && arr[pi].tick >= g.since ? arr[pi] : null
    if (!prev) return sa.pos
    const rate = Math.hypot(sa.pos.x - prev.pos.x, sa.pos.y - prev.pos.y, sa.pos.z - prev.pos.z)
      / (sa.tick - prev.tick)
    const d = Math.hypot(sa.pos.x - g.target.x, sa.pos.y - g.target.y, sa.pos.z - g.target.z)
    if (d <= rate || rate === 0) return sa.pos
    return mix(g.target, sa.pos, rate / d)
  }

  /** did `peer` stream any pose in (from, to]? The beat-fold guard: no
   * samples and no held body means the window cannot need healing. */
  posesFrom(peer: string, from: number, to: number): boolean {
    for (const byPeer of this.tracks.values()) {
      const arr = byPeer.get(peer)
      if (!arr) continue
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i].tick <= from) break
        if (arr[i].tick <= to) return true
      }
    }
    return false
  }

  holdsAny(peer: string): boolean {
    for (const g of this.grabs.values()) if (g.holder === peer) return true
    return false
  }

  /** Schedule a re-simulation from tick k (heartbeat healing): replays read
   * the now-complete pose tracks, converging pose-driven contact outcomes. */
  foldFrom(k: number) {
    if (k < this.tick) this.resimFrom = this.resimFrom === null ? k : Math.min(this.resimFrom, k)
  }

  /**
   * Make a scene's collider geometry available. If the scene op already
   * applied without it (slow download), heal by folding from the op's tick:
   * the replay re-runs the op with the geometry present, so the world ends
   * up as if the download had been instant.
   */
  registerSceneGeometry(url: string, geom: SceneGeometry) {
    this.sceneGeoms.set(url, geom)
    if (this.scene && this.scene.url === url && this.scene.body === -1) this.foldFrom(this.scene.tick)
  }

  /**
   * Late-join path: the scene comes from room state rather than an op (any
   * scene op predates our history and is never applied here). Call after
   * registerSceneGeometry and BEFORE startAt, so the first snapshot already
   * contains the colliders every senior peer's world has.
   */
  adoptScene(url: string) {
    const ctx = this.liveCtx()
    this.addScene(ctx, url, this.tick)
    this.scene = ctx.scene
  }

  /** Swap the fixed trimesh in `ctx` to `url` ('' clears it). */
  private addScene(ctx: Ctx, url: string, tick: number) {
    this.swapScene(ctx, url, tick)
    // The ground plane yields to a loaded scene: real worlds bring their
    // own floors, and a slab at y=0 would slice through them. Toggled
    // rather than removed so every handle stays stable; the enabled flag
    // is serialised, so fold restores preserve it, and this runs inside
    // op application, so every peer flips it on the same tick.
    ctx.world.getRigidBody(GROUND_HANDLE)?.collider(0)?.setEnabled(!(ctx.scene && ctx.scene.body !== -1))
  }

  private swapScene(ctx: Ctx, url: string, tick: number) {
    if (ctx.scene && ctx.scene.body !== -1) {
      const old = ctx.world.getRigidBody(ctx.scene.body)
      if (old) ctx.world.removeRigidBody(old)
    }
    if (!url) { ctx.scene = null; return }
    const geom = this.sceneGeoms.get(url)
    if (!geom || geom.indices.length === 0) {
      ctx.scene = { url, body: -1, tick }
      if (!geom && !this.sceneWarned.has(url)) {
        this.sceneWarned.add(url)
        this.anomaly(`scene ${url} applied before its geometry loaded; heals once fetched`)
      }
      return
    }
    const body = ctx.world.createRigidBody(RAPIER.RigidBodyDesc.fixed())
    ctx.world.createCollider(RAPIER.ColliderDesc.trimesh(geom.vertices, geom.indices), body)
    ctx.scene = { url, body: body.handle, tick }
  }

  async init() {
    await RAPIER.init()
    this.world = buildWorld()
    PipelineCtor = this.world.physicsPipeline.constructor as typeof PipelineCtor
    CcdCtor = this.world.ccdSolver.constructor as typeof CcdCtor
  }

  /** First tick this sim ever simulated; ops stamped earlier are pre-history
   * here (the boot seam covers their effects) and are logged but not run. */
  startTick = 0

  /** Begin simulating at a calibrated grid tick; call once, before stepping.
   * Snapshots immediately (start ticks are rarely cadence-aligned) so folds
   * have a floor from the first tick, not from the next cadence point. */
  startAt(tick: number) {
    this.tick = tick
    this.startTick = tick
    this.history.set(tick, {
      snap: this.world.takeSnapshot(),
      bodies: new Map(this.bodies),
      grabs: cloneGrabs(this.grabs),
      props: cloneProps(this.props),
      scene: this.scene && { ...this.scene },
    })
  }

  get needsResim() { return this.resimFrom !== null }

  body(netId: string): RAPIER.RigidBody | null {
    const h = this.bodies.get(netId)
    if (h === undefined) return null
    return this.world.getRigidBody(h) ?? null
  }

  /**
   * Queue an interaction at its author-stamped tick. A past tick schedules a
   * rollback; the current (not yet simulated) tick and claimed-future ticks
   * are simply applied when that tick is stepped. Ticks older than the
   * available snapshot history (young sim, just after a sleep jump) clamp to
   * the oldest snapshot; genuinely stale peers are filtered by attestation
   * before this is called.
   * Returns the tick the interaction was scheduled at (null for a dup).
   */
  insert(i: Interaction): number | null {
    const key = `${i.peer}:${i.seq}`
    if (this.seen.has(key)) return null
    const claimedTick = i.tick
    let k = claimedTick
    if (k > this.tick + MAX_FUTURE_TICKS) k = this.tick + MAX_FUTURE_TICKS
    // Ops predating our start are pre-history: their effects reach us via
    // the boot seam instead, so they enter the log and timeline at their
    // true tick but are never applied (no fold can reach below startTick).
    // This keeps the input log identical across peers with different join
    // times. Clamping is reserved for genuine window overruns.
    const preHistory = k < this.startTick
    if (!preHistory && k < this.tick) {
      const oldest = this.oldestSnapTick()
      k = oldest === null ? this.tick : Math.max(k, oldest)
    }
    if (k !== claimedTick) {
      this.anomaly(`clamped ${i.type} from ${i.peer} by ${k - claimedTick} ticks; sims will diverge`)
    }
    this.seen.add(key)
    if (this.inputLog.length < INPUT_LOG_MAX) {
      this.inputLog.push({
        tick: k, claimedTick, peer: i.peer, order: i.order, seq: i.seq,
        type: i.type, netId: i.netId, pos: i.pos, vel: i.vel, rot: i.rot, angvel: i.angvel, color: i.color,
      })
    }
    const entry: Entry = { tick: k, order: i.order, seq: i.seq, i }
    let lo = 0, hi = this.timeline.length
    while (lo < hi) { const m = (lo + hi) >> 1; if (before(this.timeline[m], entry)) lo = m + 1; else hi = m }
    this.timeline.splice(lo, 0, entry)
    if (!preHistory && k < this.tick) this.resimFrom = this.resimFrom === null ? k : Math.min(this.resimFrom, k)
    return k
  }

  /** Oldest tick with a stored snapshot; keys are inserted in ascending
   * order and pruned oldest-first, so the first key is the minimum. */
  private oldestSnapTick(): number | null {
    for (const k of this.history.keys()) return k
    return null
  }

  /** Roll back and replay if any past-tick interactions arrived. Returns true if state was rewritten. */
  fold(): boolean {
    if (this.resimFrom === null) return false
    // Round down to a cadence point, but never below the oldest snapshot:
    // the startAt() snapshot is usually off-grid, so a young sim's floor is
    // the start tick itself. Replays from there normalise at the same
    // aligned ticks the live path did, so the paths stay bit-identical.
    const k = Math.max(this.resimFrom - (this.resimFrom % this.cadence), this.oldestSnapTick()!)
    this.resimFrom = null
    const target = this.tick
    const rec = this.history.get(k)!
    this.world.free()
    this.world = RAPIER.World.restoreSnapshot(rec.snap)
    this.world.timestep = 1 / TICK_HZ
    this.bodies = new Map(rec.bodies)
    this.grabs = cloneGrabs(rec.grabs)
    this.props = cloneProps(rec.props)
    // handles are stable across snapshot restore, so the stored ref is valid
    this.scene = rec.scene && { ...rec.scene }
    this.tick = k
    while (this.tick < target) this.step()
    this.rollbacks++
    this.lastReplayDepth = target - k
    return true
  }

  /** Step to the calibrated tick clock's current reading (fractional ticks). */
  advance(tickTime: number) {
    const target = Math.floor(tickTime)
    let n = 0
    while (target > this.tick && n < MAX_CATCHUP) { this.step(); n++ }
    // Stalled hard: jump to the current grid tick instead of grinding
    // through the backlog. Old snapshots are from before the gap and cannot
    // seed a replay across it, so drop them.
    if (target > this.tick) {
      const skipped = target - this.tick
      this.tick = target
      this.history.clear()
      this.anomaly(`jumped ${skipped} ticks without simulating; sims will diverge`)
    }
  }

  private liveCtx(): Ctx {
    return { world: this.world, bodies: this.bodies, grabs: this.grabs, props: this.props, scene: this.scene }
  }

  private applyTick(ctx: Ctx, tick: number) {
    if (this.tickHasBoot(tick)) {
      // A boot seam: the world was just rebuilt from scratch (see step).
      // First the boot entries recreate the dump (state at its `from`
      // snapshot tick), then every non-boot op stamped in [from, seam) is
      // applied AGAIN: their first application was erased by the rebuild
      // (or, on the joiner, never ran at all because the op predates its
      // start), so this is where ops that raced the join take effect. The
      // timeline is identical on every peer, so so is this replay.
      let from = tick - BOOT_LEAD_TICKS
      for (const e of this.timeline) {
        if (e.tick > tick) break
        if (e.tick === tick && e.i.type === 'boot' && e.i.from !== undefined) from = Math.min(from, e.i.from)
      }
      for (const e of this.timeline) {
        if (e.tick > tick) break
        if (e.tick === tick && e.i.type === 'boot') this.applyTo(ctx, e.i, tick)
      }
      for (const e of this.timeline) {
        if (e.tick >= tick) break
        if (e.tick >= from && e.i.type !== 'boot') this.applyTo(ctx, e.i, tick)
      }
      for (const e of this.timeline) {
        if (e.tick > tick) break
        if (e.tick === tick && e.i.type !== 'boot') this.applyTo(ctx, e.i, tick)
      }
      return
    }
    for (const e of this.timeline) {
      if (e.tick > tick) break
      if (e.tick === tick) this.applyTo(ctx, e.i, tick)
    }
  }

  private tickHasBoot(tick: number): boolean {
    for (const e of this.timeline) {
      if (e.tick > tick) break
      if (e.tick === tick && e.i.type === 'boot') return true
    }
    return false
  }

  private normalizeCtx(ctx: Ctx) {
    if (this.normalizeMode === 'restore') {
      const s = ctx.world.takeSnapshot()
      ctx.world.free()
      ctx.world = RAPIER.World.restoreSnapshot(s)
      ctx.world.timestep = 1 / TICK_HZ
    } else {
      resetSolvers(ctx.world)
    }
  }

  // A boot seam reaches this tick via different routes on different peers:
  // the senior has had the bodies for ages (warm contact manifolds and
  // warmstart impulses, which takeSnapshot DOES serialise, so a
  // snapshot+restore cannot equalise them), a joiner creates them cold.
  // The only symmetric state is an empty one: every peer rebuilds the world
  // from scratch and lets the boot entries recreate every body in dump
  // order, giving byte-identical worlds by construction.
  private seamReset(ctx: Ctx) {
    // The scene crosses the seam: seniors know it from the op, the joiner
    // adopted it from room state before starting, so every peer re-adds the
    // same trimesh right after the ground and body creation order matches.
    const scene = ctx.scene
    ctx.world.free()
    ctx.world = buildWorld()
    ctx.bodies.clear()
    ctx.grabs.clear()
    ctx.props.clear() // boot entries recreate them (claims included)
    ctx.scene = null
    if (scene) this.addScene(ctx, scene.url, scene.tick)
  }

  // Held bodies are kinematic and follow their holder's pose stream via
  // setNextKinematicTranslation, so the solver integrates them WITH a
  // velocity: contacts resolve against real motion and a held box plows
  // through the pile instead of teleporting. Replays read the recorded
  // track at the tick being re-simulated, so folding an op back in also
  // folds in the poses that arrived since (the p2p-sync pose plane rule).
  private pinAndStep(ctx: Ctx, tick: number) {
    for (const [netId, g] of ctx.grabs) {
      const b = bodyOf(ctx, netId)
      if (!b) continue
      const t = this.pinTarget(g, netId, tick)
      g.target = { x: t.x, y: t.y, z: t.z } // persist: next tick approaches from here
      b.setNextKinematicTranslation(g.target)
    }
    ctx.world.step()
  }

  private step() {
    const t0 = performance.now()
    // Cadence points are ticks divisible by `cadence`, aligned on the global
    // grid so every peer snapshots and normalises at the same tick numbers.
    const aligned = this.tick % this.cadence === 0
    let snap: Uint8Array | null = null
    if (aligned) {
      snap = this.world.takeSnapshot()
      this.history.set(this.tick, {
        snap,
        bodies: new Map(this.bodies),
        grabs: cloneGrabs(this.grabs),
        props: cloneProps(this.props),
        scene: this.scene && { ...this.scene },
      })
      for (const key of this.history.keys()) {
        if (key > this.tick - HISTORY_TICKS) break
        this.history.delete(key)
      }
    }
    const t1 = performance.now()
    // Normalise: at every cadence point, on every peer, drop the solver
    // state that takeSnapshot does not serialise. Rapier keeps such state in
    // the PhysicsPipeline and CCDSolver; it evolves differently down a
    // fold-then-replay path than down a continuous live path, and under
    // contact stress that changes outcomes. Rollbacks round down to a
    // cadence point, so a replay performs restores at exactly the ticks the
    // live path performed them: live stepping and rollback replay are the
    // same operation by construction. 'restore' rebuilds the whole world
    // from the snapshot just taken; 'pipeline' only replaces the two
    // non-serialised objects, which turned out NOT to be equivalent (the
    // restore also canonicalises in-memory state of the serialised
    // components; see README), so 'restore' is the default.
    if (aligned) {
      if (this.normalizeMode === 'restore') {
        this.world.free()
        this.world = RAPIER.World.restoreSnapshot(snap!)
        this.world.timestep = 1 / TICK_HZ
      } else {
        resetSolvers(this.world)
      }
    }
    const t2 = performance.now()
    const ctx = this.liveCtx()
    if (this.tickHasBoot(this.tick)) this.seamReset(ctx)
    this.applyTick(ctx, this.tick)
    // seam resets and scene ops replace the world and the scene ref
    this.world = ctx.world
    this.scene = ctx.scene
    this.writePrev()
    this.pinAndStep(ctx, this.tick)
    const t3 = performance.now()
    this.tick++
    this.hashes.set(this.tick, hashCtx(ctx))
    this.hashes.delete(this.tick - 2 * HISTORY_TICKS)
    while (this.timeline.length && this.timeline[0].tick < this.tick - HISTORY_TICKS) this.timeline.shift()
    for (const byPeer of this.tracks.values()) {
      for (const arr of byPeer.values()) {
        while (arr.length && arr[0].tick < this.tick - HISTORY_TICKS) arr.shift()
      }
    }
    const t4 = performance.now()
    const ema = (old: number, v: number) => old * 0.95 + v * 0.05
    this.perf.snap = ema(this.perf.snap, t1 - t0)
    this.perf.norm = ema(this.perf.norm, t2 - t1)
    this.perf.phys = ema(this.perf.phys, t3 - t2)
    this.perf.hash = ema(this.perf.hash, t4 - t3)
    this.stepMs = ema(this.stepMs, t4 - t0)
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
    let from = this.tick - depth
    from -= from % this.cadence // replays start at cadence points
    const rec = this.history.get(from)
    if (!rec) return { error: `no snapshot ${depth} ticks back` }
    depth = this.tick - from
    const ctx: Ctx = {
      world: RAPIER.World.restoreSnapshot(rec.snap),
      bodies: new Map(rec.bodies),
      grabs: cloneGrabs(rec.grabs),
      props: cloneProps(rec.props),
      scene: rec.scene && { ...rec.scene },
    }
    ctx.world.timestep = 1 / TICK_HZ
    for (let t = from; t < this.tick; t++) {
      // mirror the cadence normalisation and seam reset of step()
      if (t % this.cadence === 0) this.normalizeCtx(ctx)
      if (this.tickHasBoot(t)) this.seamReset(ctx)
      this.applyTick(ctx, t)
      this.pinAndStep(ctx, t)
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
    for (const [netId, p] of rec.props) {
      out[netId] = `prop ${p.kind} p=${p.pos.x.toFixed(6)},${p.pos.y.toFixed(6)},${p.pos.z.toFixed(6)}`
        + ` color=${p.color.toString(16)} size=${p.size}` + (p.claim ? ` claim=${p.claim}` : '')
    }
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

  /** A solid prop's fixed cuboid body. Created only inside op folds, so
   * creation order (and thus handle assignment) is timeline order on every
   * peer; the handle rides the Prop so despawn/move/dump can find the body
   * again after any snapshot restore. */
  private addSolidBody(ctx: Ctx, p: Prop) {
    const half = (p.yaw ?? 0) / 2
    const body = ctx.world.createRigidBody(RAPIER.RigidBodyDesc.fixed()
      .setTranslation(p.pos.x, p.pos.y, p.pos.z)
      .setRotation({ x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) }))
    ctx.world.createCollider(RAPIER.ColliderDesc.cuboid(p.dims!.x / 2, p.dims!.y / 2, p.dims!.z / 2), body)
    p.handle = body.handle
  }

  private applyTo(ctx: Ctx, i: Interaction, tick: number) {
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
        this.ecs.ensureEntity(i.netId, i.color ?? 0xffffff)
        return
      }
      case 'grab': {
        const b = bodyOf(ctx, i.netId)
        if (!b) return
        // The grabber teleports the body to their presented pose, which is the
        // "override the rubber-banded view" rule from the design. Held bodies
        // become kinematic: the solver then sees their real velocity each
        // tick (from setNextKinematicTranslation), so a held box shoves the
        // pile properly instead of being a zero-velocity teleport.
        b.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true)
        b.setTranslation(i.pos, true)
        ctx.grabs.set(i.netId, { holder: i.peer, order: i.order, target: { ...i.pos }, since: tick })
        return
      }
      case 'release': {
        const g = ctx.grabs.get(i.netId)
        if (!g || g.holder !== i.peer) return
        ctx.grabs.delete(i.netId)
        const b = bodyOf(ctx, i.netId)
        if (!b) return
        // Physics takes back over from the author's authoritative state.
        b.setBodyType(RAPIER.RigidBodyType.Dynamic, true)
        b.setTranslation(i.pos, true)
        if (i.vel) b.setLinvel(i.vel, true)
        b.setAngvel(ZERO, true)
        return
      }
      case 'scene': {
        // netId is the scene's mxc URL ('' clears). Idempotent for the
        // seam-window replay: seamReset has already re-added the same url.
        if ((ctx.scene?.url ?? '') === i.netId) return
        // A scene (re)load deterministically RESETS the world at the op's
        // tick: rebuild from scratch and drop every body, rather than
        // leave the old pile floating wherever the new world's geometry
        // happens to be. The ground comes back with buildWorld and is
        // immediately yielded again when the trimesh lands (addScene).
        ctx.world.free()
        ctx.world = buildWorld()
        ctx.bodies.clear()
        ctx.grabs.clear()
        ctx.props.clear()
        ctx.scene = null
        this.addScene(ctx, i.netId, tick)
        return
      }
      case 'prop': {
        if (ctx.props.has(i.netId) || ctx.bodies.has(i.netId)) return
        const p: Prop = {
          kind: i.shape ?? 'sphere', pos: { ...i.pos },
          color: i.color ?? 0xffffff, size: i.size ?? 0.5, unlit: !!i.unlit, claim: null,
          yaw: i.yaw, dims: i.dims && { ...i.dims }, solid: !!i.solid,
        }
        if (p.solid && p.dims) this.addSolidBody(ctx, p)
        ctx.props.set(i.netId, p)
        return
      }
      case 'despawn': {
        const sp = ctx.props.get(i.netId)
        if (sp) {
          if (sp.handle !== undefined) {
            const b = ctx.world.getRigidBody(sp.handle)
            if (b) ctx.world.removeRigidBody(b)
          }
          ctx.props.delete(i.netId)
          return
        }
        const h = ctx.bodies.get(i.netId)
        if (h === undefined) return
        const b = ctx.world.getRigidBody(h)
        if (b) ctx.world.removeRigidBody(b)
        ctx.bodies.delete(i.netId)
        ctx.grabs.delete(i.netId)
        return
      }
      case 'claim': {
        // First writer wins, by timeline order: a claim against a prop
        // someone else already holds is deterministically inert on every
        // peer, so rival chains resolve without consensus machinery.
        const p = ctx.props.get(i.netId)
        if (!p || (p.claim !== null && p.claim !== i.peer)) return
        p.claim = i.peer
        return
      }
      case 'unclaim': {
        const p = ctx.props.get(i.netId)
        if (!p || p.claim === null) return
        // force is the ghost-cleanup path (a claimer's session died); any
        // author may clear any claim with it, which is fine in a
        // cooperative world and still deterministic (pure state x op).
        if (p.claim !== i.peer && !i.force) return
        p.claim = null
        return
      }
      case 'move': {
        // Anyone may move a prop, claimed or not: board-structure edits
        // (column drops after a dots clear) must win over in-flight chains,
        // whose scripts re-validate against the new positions.
        const p = ctx.props.get(i.netId)
        if (!p) return
        p.pos = { ...i.pos }
        if (p.handle !== undefined) ctx.world.getRigidBody(p.handle)?.setTranslation(p.pos, true)
        return
      }
      case 'paint': {
        const p = ctx.props.get(i.netId)
        if (!p || i.color === undefined) return
        p.color = i.color
        return
      }
      case 'boot': {
        // An empty netId is the seam marker for an empty dump: it exists so
        // the seam (rebuild + raced-op replay) happens even in a room with
        // no entities yet.
        if (!i.netId) return
        // Prop entities cross the seam whole (claim included): recreate in
        // dump order, exactly like bodies.
        if (i.prop) {
          const p: Prop = {
            kind: i.prop.kind, pos: { ...i.pos },
            color: i.prop.color, size: i.prop.size, unlit: i.prop.unlit, claim: i.prop.claim,
            yaw: i.prop.yaw, dims: i.prop.dims && { ...i.prop.dims }, solid: !!i.prop.solid,
          }
          // the seam rebuilt the world from empty: the fixed body must be
          // recreated with the prop, in dump order like everything else
          if (p.solid && p.dims) this.addSolidBody(ctx, p)
          ctx.props.set(i.netId, p)
          return
        }
        // The grab table crosses the seam too: a body mid-drag at boot time
        // must be pinned (kinematic) from the same tick on every peer.
        if (i.grab) ctx.grabs.set(i.netId, { holder: i.grab.holder, order: i.grab.order, target: { ...i.grab.target }, since: tick })
        else ctx.grabs.delete(i.netId)
        const b = bodyOf(ctx, i.netId)
        if (b) {
          b.setBodyType(i.grab ? RAPIER.RigidBodyType.KinematicPositionBased : RAPIER.RigidBodyType.Dynamic, true)
          b.setTranslation(i.pos, true)
          if (i.rot) b.setRotation(i.rot, true)
          if (i.vel) b.setLinvel(i.vel, true)
          if (i.angvel) b.setAngvel(i.angvel, true)
          return
        }
        const desc = (i.grab ? RAPIER.RigidBodyDesc.kinematicPositionBased() : RAPIER.RigidBodyDesc.dynamic())
          .setCanSleep(false)
          .setTranslation(i.pos.x, i.pos.y, i.pos.z)
          .setRotation(i.rot ?? { x: 0, y: 0, z: 0, w: 1 })
          .setLinvel(i.vel?.x ?? 0, i.vel?.y ?? 0, i.vel?.z ?? 0)
          .setAngvel(i.angvel ?? ZERO)
        const body = ctx.world.createRigidBody(desc)
        ctx.world.createCollider(boxCollider(), body)
        ctx.bodies.set(i.netId, body.handle)
        this.ecs.ensureEntity(i.netId, i.color ?? 0xffffff)
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
      const eid = this.ecs.entityFor(netId)
      if (eid === undefined) continue
      const p = b.translation(), q = b.rotation()
      const { PrevPosition, PrevRotation } = this.ecs
      PrevPosition.x[eid] = p.x; PrevPosition.y[eid] = p.y; PrevPosition.z[eid] = p.z
      PrevRotation.x[eid] = q.x; PrevRotation.y[eid] = q.y; PrevRotation.z[eid] = q.z; PrevRotation.w[eid] = q.w
    }
  }

  /** Copy body poses into the bitECS Position/Rotation stores for rendering. */
  mirror() {
    for (const [netId, h] of this.bodies) {
      const b = this.world.getRigidBody(h)
      if (!b) continue
      const eid = this.ecs.entityFor(netId)
      if (eid === undefined) continue
      const p = b.translation(), q = b.rotation()
      const { Position, Rotation } = this.ecs
      Position.x[eid] = p.x; Position.y[eid] = p.y; Position.z[eid] = p.z
      Rotation.x[eid] = q.x; Rotation.y[eid] = q.y; Rotation.z[eid] = q.z; Rotation.w[eid] = q.w
    }
  }

  /**
   * Boot dump for a joiner, read from the NEWEST stored snapshot rather than
   * the live world: the live world's state can be mid-tick relative to the
   * timeline (an op inserted but not yet stepped would be silently missing),
   * while a snapshot is exactly "state at start of tick `from`". Ops stamped
   * at or after `from` are re-applied on top of the seam by applyTick, so
   * nothing that races the join is lost.
   */
  dumpSeam(): { from: number; entities: BootEntity[] } {
    let from = this.tick
    let rec: HistoryRec | null = null
    for (const [k, r] of this.history) { if (k <= this.tick) { from = k; rec = r } }
    const out: BootEntity[] = []
    if (rec) {
      const world = RAPIER.World.restoreSnapshot(rec.snap)
      for (const [netId, h] of rec.bodies) {
        const b = world.getRigidBody(h)
        const eid = this.ecs.entityFor(netId)
        if (!b || eid === undefined) continue
        const q = b.rotation()
        const g = rec.grabs.get(netId)
        out.push({
          netId,
          color: this.ecs.Tint.value[eid],
          pos: vec(b.translation()),
          rot: { x: q.x, y: q.y, z: q.z, w: q.w },
          linvel: vec(b.linvel()),
          angvel: vec(b.angvel()),
          grab: g && { holder: g.holder, order: g.order, target: { ...g.target } },
        })
      }
      world.free()
      for (const [netId, p] of rec.props) {
        out.push({
          netId, color: p.color, pos: { ...p.pos },
          rot: { x: 0, y: 0, z: 0, w: 1 }, linvel: { ...ZERO }, angvel: { ...ZERO },
          prop: {
            kind: p.kind, color: p.color, size: p.size, unlit: p.unlit, claim: p.claim,
            yaw: p.yaw, dims: p.dims && { ...p.dims }, solid: p.solid,
          },
        })
      }
    }
    return { from, entities: out }
  }

}

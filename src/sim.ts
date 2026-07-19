import RAPIER from '@dimforge/rapier3d-compat'
import type { BootEntity, Interaction, Vec3 } from './types'
import { ensureEntity, entityFor, Position, Rotation, Tint } from './ecs'

export const TICK_MS = 1000 / 60
export const HISTORY_TICKS = 120 // 2s rollback window
export const BOX_HALF = 0.5
const MAX_CATCHUP = 15
const ZERO: Vec3 = { x: 0, y: 0, z: 0 }

interface Grab { holder: string; order: number; target: Vec3 }
interface HistoryRec { snap: Uint8Array; bodies: Map<string, number>; grabs: Map<string, Grab> }
interface Entry { tick: number; order: number; seq: number; i: Interaction }

const before = (a: Entry, b: Entry) =>
  a.tick !== b.tick ? a.tick < b.tick : a.order !== b.order ? a.order < b.order : a.seq < b.seq

function cloneGrabs(m: Map<string, Grab>): Map<string, Grab> {
  const out = new Map<string, Grab>()
  for (const [k, g] of m) out.set(k, { holder: g.holder, order: g.order, target: { ...g.target } })
  return out
}

function boxCollider() {
  return RAPIER.ColliderDesc.cuboid(BOX_HALF, BOX_HALF, BOX_HALF).setRestitution(0.3).setFriction(0.8)
}

const vec = (v: { x: number; y: number; z: number }): Vec3 => ({ x: v.x, y: v.y, z: v.z })

/**
 * Locally simulated Rapier world with a rollback window.
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
  epoch = 0
  tick = 0
  bodies = new Map<string, number>()
  grabs = new Map<string, Grab>()
  rollbacks = 0
  lastReplayDepth = 0
  private history = new Map<number, HistoryRec>()
  private timeline: Entry[] = []
  private seen = new Set<string>()
  private resimFrom: number | null = null

  async init() {
    await RAPIER.init()
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 })
    this.world.timestep = 1 / 60
    const ground = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed())
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(20, 0.5, 20).setTranslation(0, -0.5, 0), ground)
    this.epoch = performance.now()
  }

  get needsResim() { return this.resimFrom !== null }

  tickOf(t: number) { return Math.floor((t - this.epoch) / TICK_MS) }

  body(netId: string): RAPIER.RigidBody | null {
    const h = this.bodies.get(netId)
    if (h === undefined) return null
    return this.world.getRigidBody(h) ?? null
  }

  /**
   * Queue an interaction at the tick matching its (already clock-mapped)
   * local time. Returns false if it is older than the rollback window.
   */
  insert(i: Interaction, localT: number): boolean {
    const key = `${i.peer}:${i.seq}`
    if (this.seen.has(key)) return true
    let k = this.tickOf(localT)
    if (k >= this.tick) k = this.tick // slightly-future (clock skew): apply asap
    if (k < this.tick && !this.history.has(k)) return false
    this.seen.add(key)
    const entry: Entry = { tick: k, order: i.order, seq: i.seq, i }
    let lo = 0, hi = this.timeline.length
    while (lo < hi) { const m = (lo + hi) >> 1; if (before(this.timeline[m], entry)) lo = m + 1; else hi = m }
    this.timeline.splice(lo, 0, entry)
    if (k < this.tick) this.resimFrom = this.resimFrom === null ? k : Math.min(this.resimFrom, k)
    return true
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
    this.world.timestep = 1 / 60
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
    // Tab was asleep: rebase the clock instead of grinding through the backlog.
    if (this.tickOf(now) > this.tick) this.epoch = now - this.tick * TICK_MS
  }

  private step() {
    this.history.set(this.tick, {
      snap: this.world.takeSnapshot(),
      bodies: new Map(this.bodies),
      grabs: cloneGrabs(this.grabs),
    })
    this.history.delete(this.tick - HISTORY_TICKS)
    for (const e of this.timeline) {
      if (e.tick > this.tick) break
      if (e.tick === this.tick) this.apply(e.i)
    }
    // Grabbed bodies are pinned to their drag target each tick; contacts still
    // resolve, so a held box shoves others out of the way.
    for (const [netId, g] of this.grabs) {
      const b = this.body(netId)
      if (!b) continue
      b.setTranslation(g.target, true)
      b.setLinvel(ZERO, true)
      b.setAngvel(ZERO, true)
    }
    this.world.step()
    this.tick++
    while (this.timeline.length && this.timeline[0].tick < this.tick - HISTORY_TICKS) this.timeline.shift()
  }

  private apply(i: Interaction) {
    switch (i.type) {
      case 'spawn': {
        if (this.bodies.has(i.netId)) return
        const body = this.world.createRigidBody(
          RAPIER.RigidBodyDesc.dynamic().setTranslation(i.pos.x, i.pos.y, i.pos.z))
        this.world.createCollider(boxCollider(), body)
        this.bodies.set(i.netId, body.handle)
        ensureEntity(i.netId, i.color ?? 0xffffff)
        return
      }
      case 'grab': {
        const b = this.body(i.netId)
        if (!b) return
        // The grabber teleports the body to their presented pose, which is the
        // "override the rubber-banded view" rule from the design.
        b.setTranslation(i.pos, true)
        b.setLinvel(ZERO, true)
        b.setAngvel(ZERO, true)
        this.grabs.set(i.netId, { holder: i.peer, order: i.order, target: { ...i.pos } })
        return
      }
      case 'move': {
        if (!this.bodies.has(i.netId)) return
        // Last writer wins, including stealing the grab: contested drags
        // become an explicit tug of war resolved by interaction order.
        this.grabs.set(i.netId, { holder: i.peer, order: i.order, target: { ...i.pos } })
        return
      }
      case 'release': {
        const g = this.grabs.get(i.netId)
        if (!g || g.holder !== i.peer) return
        this.grabs.delete(i.netId)
        const b = this.body(i.netId)
        if (b && i.vel) b.setLinvel(i.vel, true)
        return
      }
    }
  }

  /** Smooth local-only drag target update between the 20Hz sampled move interactions. */
  setGrabTarget(netId: string, pos: Vec3) {
    const g = this.grabs.get(netId)
    if (g) g.target = { ...pos }
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
      const body = this.world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(e.pos.x, e.pos.y, e.pos.z)
          .setRotation(e.rot)
          .setLinvel(e.linvel.x, e.linvel.y, e.linvel.z)
          .setAngvel(e.angvel))
      this.world.createCollider(boxCollider(), body)
      this.bodies.set(e.netId, body.handle)
      ensureEntity(e.netId, e.color)
    }
  }
}

import * as THREE from 'three'
import { BOX_HALF, TICK_MS } from './sim'
import type { Vec3, Quat, InteractionType } from './types'
import type { View } from './render'
import type { Nav } from './nav'

// Drag samples go on the wire (and into our own timeline) at tick rate; the
// interactions are the ONLY thing driving the physics, locally too, so every
// peer steps identical inputs.
const MOVE_SEND_MS = TICK_MS
const CLICK_MAX_PX = 6
const CLICK_MAX_MS = 400
const GROUND_HALF = 19
const SPAWN_HEIGHT = 2.5
const MAX_THROW = 18
// carry distance while walking: the grabbed box rides the view ray
const CARRY_MIN = 1.3
const CARRY_MAX = 12
const PALETTE = [0xe63946, 0xf4a261, 0xe9c46a, 0x2a9d8f, 0x64b5f6, 0x9b5de5, 0xf15bb5, 0x80ed99]

export interface Emitter {
  ready(): boolean
  nextNetId(): string
  emit(type: InteractionType, netId: string, data: {
    pos: Vec3; vel?: Vec3; rot?: Quat; angvel?: Vec3
    grab?: { holder: string; order: number; target: Vec3 }; color?: number; dims?: Vec3
  }): void
  /** continuous drag motion: pose plane, not an op; rot rides along while
   * the edit gizmo rotates */
  streamPose(netId: string, pos: Vec3, rot?: Quat): void
}

/** A world script's claim on pointer interactions: down() returning true
 * captures the gesture (props were hit), routing move/up to the script and
 * away from box spawning/grabbing until release. hover() sees uncaptured
 * moves too, when the script wants them (world.onpointermove hover
 * effects); the host no-ops it while a handler is absent. */
export interface ScriptPointer {
  down(e: PointerEvent): boolean
  move(e: PointerEvent): void
  up(e: PointerEvent): void
  hover(e: PointerEvent): void
}

interface Drag {
  netId: string
  eid: number
  target: THREE.Vector3
  lastSent: number
  trail: { t: number; p: THREE.Vector3 }[]
  /** orbit-mode plane drag */
  offset?: THREE.Vector3
  plane?: THREE.Plane
  /** walk-mode carry: the box rides the view ray at this distance, so it
   * follows mouselook and WASD alike (tick() retargets every frame) */
  carryDist?: number
}

/** What a pointerdown might become: a drag (past the movement threshold)
 * or a click (select a box / deselect / spawn). The grab op is deferred
 * until the drag is real, so a click never disturbs the box it selects. */
interface Pending {
  x: number
  y: number
  t: number
  moved: number // pointer-lock movement accumulates here (clientX freezes)
  eid: number | null
  netId: string | null
  mesh: THREE.Mesh | null
  hitPoint: THREE.Vector3 | null
  downPresented: THREE.Vector3 | null
}

export class Input {
  draggedEid: number | null = null
  /** installed by main once a world script with pointer handlers is running */
  scriptPointer: ScriptPointer | null = null
  private captured = false
  private drag: Drag | null = null
  private pending: Pending | null = null
  private ray = new THREE.Raycaster()
  private ndc = new THREE.Vector2()

  constructor(private view: View, private out: Emitter, private nav: Nav) {
    view.renderer.domElement.addEventListener('pointerdown', e => this.onDown(e))
    addEventListener('pointermove', e => this.onMove(e))
    addEventListener('pointerup', e => this.onUp(e))
  }

  /** ray through the pointer - or through the crosshair while the walker
   * holds pointer lock (the cursor is captured; clientX/Y are stale) */
  private castAt(e: PointerEvent | null) {
    if (!e || this.nav.locked) {
      this.ndc.set(0, 0)
    } else {
      const r = this.view.renderer.domElement.getBoundingClientRect()
      this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
    }
    this.ray.setFromCamera(this.ndc, this.view.camera)
  }

  private pickBox(e: PointerEvent): THREE.Intersection | null {
    this.castAt(e)
    const hits = this.ray.intersectObjects([...this.view.meshes.values()], false)
    return hits[0] ?? null
  }

  private onDown(e: PointerEvent) {
    // cmd/ctrl-drag belongs to the orbit controls
    if (e.button !== 0 || e.metaKey || e.ctrlKey || !this.out.ready()) return
    // the edit gizmo owns the pointer while an axis is hot
    if (this.nav.gizmoConsumes()) return
    // walking but not looking: the click's job is to capture the mouse
    if (this.nav.effective() === 'walk' && !this.nav.locked) { this.nav.requestLock(); return }
    // the world script gets first refusal (it consumes when a prop is hit)
    if (this.scriptPointer?.down(e)) { this.captured = true; return }
    const hit = this.pickBox(e)
    const mesh = hit ? hit.object as THREE.Mesh : null
    this.pending = {
      x: e.clientX, y: e.clientY, t: performance.now(), moved: 0,
      eid: mesh ? mesh.userData.eid as number : null,
      netId: mesh ? this.view.ecs.netIdFor(mesh.userData.eid as number) : null,
      mesh,
      hitPoint: hit ? hit.point.clone() : null,
      downPresented: mesh ? mesh.position.clone() : null,
    }
  }

  /** the movement threshold passed: the pending gesture is a drag. Grab
   * authority follows the presented (rendered) pose, not the raw sim pose:
   * if the box was mid rubber-band, we teleport it to where the user sees
   * it and broadcast that as truth. */
  private beginDrag() {
    const p = this.pending!
    this.pending = null
    if (p.eid === null || !p.mesh || !this.view.meshes.has(p.eid)) return
    const presented = p.mesh.position.clone()
    this.view.errors.delete(p.eid)
    this.out.emit('grab', p.netId!, { pos: v3(presented) })
    this.draggedEid = p.eid
    const now = performance.now()
    const base: Drag = {
      netId: p.netId!, eid: p.eid, target: presented.clone(),
      lastSent: now, trail: [{ t: now, p: presented.clone() }],
    }
    if (this.nav.effective() === 'walk' && this.nav.locked) {
      // carry: hold the box where it was grabbed on the view ray
      base.carryDist = THREE.MathUtils.clamp(
        this.view.camera.position.distanceTo(presented), CARRY_MIN, CARRY_MAX)
    } else {
      base.offset = p.hitPoint!.clone().sub(p.downPresented!)
      base.plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -p.hitPoint!.y)
      this.view.renderer.domElement.style.cursor = 'grabbing'
    }
    this.drag = base
  }

  /** the lowest a dragged box's center may go: half its (possibly resized)
   * height, so it slides on the ground instead of sinking in */
  private minY(eid: number): number {
    const mesh = this.view.meshes.get(eid)
    return BOX_HALF * (mesh?.scale.y ?? 1)
  }

  private onMove(e: PointerEvent) {
    if (this.captured) { this.scriptPointer?.move(e); return }
    // pointer-lock mouselook, drag or not: carrying steers by looking
    if (this.nav.locked) this.nav.look(e.movementX, e.movementY)
    if (this.pending && this.nav.gizmoConsumes()) {
      // the gizmo won the gesture (its listener runs after ours, so a
      // fast click-on-handle can slip past onDown's check)
      this.pending = null
    }
    if (this.pending) {
      this.pending.moved += Math.hypot(e.movementX, e.movementY)
      const dist = this.nav.locked
        ? this.pending.moved
        : Math.hypot(e.clientX - this.pending.x, e.clientY - this.pending.y)
      if (dist > CLICK_MAX_PX) this.beginDrag()
    }
    if (!this.drag) {
      if (e.target === this.view.renderer.domElement) {
        if (!this.nav.locked) {
          this.view.renderer.domElement.style.cursor = this.pickBox(e) ? 'grab' : ''
        }
        this.scriptPointer?.hover(e) // idle hover, for script highlight effects
      }
      return
    }
    const d = this.drag
    if (d.carryDist !== undefined) return // tick() retargets carries per frame
    this.castAt(e)
    const hitP = new THREE.Vector3()
    if (!this.ray.ray.intersectPlane(d.plane!, hitP)) return
    d.target.copy(hitP.sub(d.offset!))
    d.target.y = Math.max(this.minY(d.eid), d.target.y)
    const now = performance.now()
    d.trail.push({ t: now, p: d.target.clone() })
    while (d.trail.length > 1 && now - d.trail[0].t > 150) d.trail.shift()
    if (now - d.lastSent >= MOVE_SEND_MS) {
      d.lastSent = now
      this.out.streamPose(d.netId, v3(d.target))
    }
  }

  /** per-frame (from main): a carried box rides the view ray, so it must
   * retarget as the walker moves and looks even with the mouse still */
  tick(now: number) {
    const d = this.drag
    if (!d || d.carryDist === undefined) return
    this.castAt(null)
    d.target.copy(this.ray.ray.origin).addScaledVector(this.ray.ray.direction, d.carryDist)
    d.target.y = Math.max(this.minY(d.eid), d.target.y)
    d.trail.push({ t: now, p: d.target.clone() })
    while (d.trail.length > 1 && now - d.trail[0].t > 150) d.trail.shift()
    if (now - d.lastSent >= MOVE_SEND_MS) {
      d.lastSent = now
      this.out.streamPose(d.netId, v3(d.target))
    }
  }

  private onUp(e: PointerEvent) {
    if (this.captured) {
      this.captured = false
      this.scriptPointer?.up(e)
      return
    }
    if (this.drag) {
      const d = this.drag
      const first = d.trail[0]
      const last = d.trail[d.trail.length - 1]
      const dt = (last.t - first.t) / 1000
      const vel = new THREE.Vector3()
      if (dt > 0.02) vel.copy(last.p).sub(first.p).divideScalar(dt)
      if (vel.length() > MAX_THROW) vel.setLength(MAX_THROW)
      this.out.emit('release', d.netId, { pos: v3(d.target), vel: v3(vel) })
      this.drag = null
      this.draggedEid = null
      this.view.renderer.domElement.style.cursor = ''
      return
    }
    const p = this.pending
    this.pending = null
    if (!p || e.button !== 0 || !this.out.ready()) return
    if (performance.now() - p.t > CLICK_MAX_MS) return
    const moved = this.nav.locked ? p.moved : Math.hypot(e.clientX - p.x, e.clientY - p.y)
    if (moved > CLICK_MAX_PX) return
    // a clean click: select a box, else deselect, else spawn
    if (p.eid !== null && p.mesh && this.view.meshes.has(p.eid)) {
      this.nav.clickedBox(p.eid, p.netId!, p.mesh)
      return
    }
    if (this.nav.clickedEmpty()) return
    this.castAt(e)
    const g = new THREE.Vector3()
    if (!this.ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), g)) return
    if (Math.abs(g.x) > GROUND_HALF || Math.abs(g.z) > GROUND_HALF) return
    this.out.emit('spawn', this.out.nextNetId(), {
      pos: { x: g.x, y: SPAWN_HEIGHT, z: g.z },
      color: PALETTE[Math.floor(Math.random() * PALETTE.length)],
    })
  }
}

const v3 = (v: { x: number; y: number; z: number }): Vec3 => ({ x: v.x, y: v.y, z: v.z })

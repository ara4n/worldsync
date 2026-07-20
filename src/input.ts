import * as THREE from 'three'
import { BOX_HALF, TICK_MS } from './sim'
import type { Vec3, Quat, InteractionType } from './types'
import type { View } from './render'

// Drag samples go on the wire (and into our own timeline) at tick rate; the
// interactions are the ONLY thing driving the physics, locally too, so every
// peer steps identical inputs.
const MOVE_SEND_MS = TICK_MS
const CLICK_MAX_PX = 6
const CLICK_MAX_MS = 400
const GROUND_HALF = 19
const SPAWN_HEIGHT = 2.5
const MAX_THROW = 18
const PALETTE = [0xe63946, 0xf4a261, 0xe9c46a, 0x2a9d8f, 0x64b5f6, 0x9b5de5, 0xf15bb5, 0x80ed99]

export interface Emitter {
  ready(): boolean
  nextNetId(): string
  emit(type: InteractionType, netId: string, data: {
    pos: Vec3; vel?: Vec3; rot?: Quat; angvel?: Vec3
    grab?: { holder: string; order: number; target: Vec3 }; color?: number
  }): void
  /** continuous drag motion: pose plane, not an op */
  streamPose(netId: string, pos: Vec3): void
}

interface Drag {
  netId: string
  eid: number
  offset: THREE.Vector3
  plane: THREE.Plane
  target: THREE.Vector3
  lastSent: number
  trail: { t: number; p: THREE.Vector3 }[]
}

export class Input {
  draggedEid: number | null = null
  private drag: Drag | null = null
  private down: { x: number; y: number; t: number; onBox: boolean } | null = null
  private ray = new THREE.Raycaster()
  private ndc = new THREE.Vector2()

  constructor(private view: View, private out: Emitter) {
    view.renderer.domElement.addEventListener('pointerdown', e => this.onDown(e))
    addEventListener('pointermove', e => this.onMove(e))
    addEventListener('pointerup', e => this.onUp(e))
  }

  private castAt(e: PointerEvent) {
    const r = this.view.renderer.domElement.getBoundingClientRect()
    this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
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
    const hit = this.pickBox(e)
    this.down = { x: e.clientX, y: e.clientY, t: performance.now(), onBox: !!hit }
    if (!hit) return
    const mesh = hit.object as THREE.Mesh
    const eid = mesh.userData.eid as number
    const netId = this.view.ecs.netIdFor(eid)
    // Grab authority follows the presented (rendered) pose, not the raw sim
    // pose: if the box was mid rubber-band, we teleport it to where the user
    // sees it and broadcast that as truth.
    const presented = mesh.position.clone()
    this.view.errors.delete(eid)
    this.drag = {
      netId, eid,
      offset: hit.point.clone().sub(presented),
      plane: new THREE.Plane(new THREE.Vector3(0, 1, 0), -hit.point.y),
      target: presented.clone(),
      lastSent: performance.now(),
      trail: [{ t: performance.now(), p: presented.clone() }],
    }
    this.draggedEid = eid
    this.view.renderer.domElement.style.cursor = 'grabbing'
    this.out.emit('grab', netId, { pos: v3(presented) })
  }

  private onMove(e: PointerEvent) {
    if (!this.drag) {
      if (e.target === this.view.renderer.domElement) {
        this.view.renderer.domElement.style.cursor = this.pickBox(e) ? 'grab' : ''
      }
      return
    }
    const d = this.drag
    this.castAt(e)
    const hitP = new THREE.Vector3()
    if (!this.ray.ray.intersectPlane(d.plane, hitP)) return
    d.target.copy(hitP.sub(d.offset))
    d.target.y = Math.max(BOX_HALF, d.target.y)
    const now = performance.now()
    d.trail.push({ t: now, p: d.target.clone() })
    while (d.trail.length > 1 && now - d.trail[0].t > 150) d.trail.shift()
    if (now - d.lastSent >= MOVE_SEND_MS) {
      d.lastSent = now
      this.out.streamPose(d.netId, v3(d.target))
    }
  }

  private onUp(e: PointerEvent) {
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
      this.down = null
      this.view.renderer.domElement.style.cursor = ''
      return
    }
    const down = this.down
    this.down = null
    if (!down || down.onBox || e.button !== 0 || !this.out.ready()) return
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_MAX_PX) return
    if (performance.now() - down.t > CLICK_MAX_MS) return
    this.castAt(e)
    const p = new THREE.Vector3()
    if (!this.ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), p)) return
    if (Math.abs(p.x) > GROUND_HALF || Math.abs(p.z) > GROUND_HALF) return
    this.out.emit('spawn', this.out.nextNetId(), {
      pos: { x: p.x, y: SPAWN_HEIGHT, z: p.z },
      color: PALETTE[Math.floor(Math.random() * PALETTE.length)],
    })
  }
}

const v3 = (v: { x: number; y: number; z: number }): Vec3 => ({ x: v.x, y: v.y, z: v.z })

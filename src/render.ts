import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { ecs, newBoxes, Position, Rotation, PrevPosition, PrevRotation, Tint } from './ecs'

const IDENTITY = new THREE.Quaternion()
const tmpQ = new THREE.Quaternion()
const prevQ = new THREE.Quaternion()
const currQ = new THREE.Quaternion()

export interface Presented { p: THREE.Vector3; q: THREE.Quaternion }

export class View {
  renderer = new THREE.WebGLRenderer({ antialias: true })
  scene = new THREE.Scene()
  camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 200)
  controls: OrbitControls
  meshes = new Map<number, THREE.Mesh>()
  // Rubber-band state: presented pose = sim pose + err decayed to zero over rubberMs.
  errors = new Map<number, { p: THREE.Vector3; q: THREE.Quaternion; t0: number }>()
  rubberMs = 100
  private geo = new THREE.BoxGeometry(1, 1, 1)
  private mats = new Map<number, THREE.MeshStandardMaterial>()

  constructor(parent: HTMLElement) {
    this.renderer.setSize(innerWidth, innerHeight)
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    parent.appendChild(this.renderer.domElement)
    this.scene.background = new THREE.Color(0x0e1116)
    this.camera.position.set(9, 9, 13)
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.target.set(0, 0.5, 0)
    this.controls.enableDamping = true
    this.controls.maxPolarAngle = Math.PI / 2 - 0.05
    // Left button is reserved for spawning and dragging boxes, except while
    // cmd (or ctrl) is held, which turns it into orbit for mac trackpads.
    this.controls.mouseButtons = { MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE } as any
    const setOrbit = (on: boolean) => {
      (this.controls.mouseButtons as any).LEFT = on ? THREE.MOUSE.ROTATE : undefined
    }
    addEventListener('keydown', e => { if (e.key === 'Meta' || e.key === 'Control') setOrbit(true) })
    addEventListener('keyup', e => { if (e.key === 'Meta' || e.key === 'Control') setOrbit(false) })
    addEventListener('blur', () => setOrbit(false))

    this.scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x30281e, 0.9))
    const sun = new THREE.DirectionalLight(0xffffff, 1.6)
    sun.position.set(8, 14, 6)
    this.scene.add(sun)
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(40, 40),
      new THREE.MeshStandardMaterial({ color: 0x1a1f26, roughness: 1 }))
    ground.rotation.x = -Math.PI / 2
    this.scene.add(ground)
    const grid = new THREE.GridHelper(40, 40, 0x39414d, 0x252b33)
    grid.position.y = 0.01
    this.scene.add(grid)

    addEventListener('resize', () => {
      this.camera.aspect = innerWidth / innerHeight
      this.camera.updateProjectionMatrix()
      this.renderer.setSize(innerWidth, innerHeight)
    })
  }

  private matFor(color: number) {
    let m = this.mats.get(color)
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.05 })
      this.mats.set(color, m)
    }
    return m
  }

  private syncNew() {
    for (const eid of newBoxes(ecs)) {
      const mesh = new THREE.Mesh(this.geo, this.matFor(Tint.value[eid]))
      mesh.userData.eid = eid
      this.scene.add(mesh)
      this.meshes.set(eid, mesh)
    }
  }

  capture(): Map<number, Presented> {
    const out = new Map<number, Presented>()
    for (const [eid, mesh] of this.meshes) {
      out.set(eid, { p: mesh.position.clone(), q: mesh.quaternion.clone() })
    }
    return out
  }

  /**
   * After a rollback rewrote the sim, seed rubber-band offsets so each box
   * glides from where it was drawn to where the corrected sim says it is.
   * The locally dragged box is skipped: the pointer has authority there.
   */
  applyCorrections(presented: Map<number, Presented>, now: number, skipEid: number | null) {
    for (const [eid, was] of presented) {
      if (eid === skipEid) { this.errors.delete(eid); continue }
      const sp = new THREE.Vector3(Position.x[eid], Position.y[eid], Position.z[eid])
      const sq = new THREE.Quaternion(Rotation.x[eid], Rotation.y[eid], Rotation.z[eid], Rotation.w[eid])
      const dp = was.p.clone().sub(sp)
      const dq = was.q.clone().multiply(sq.invert())
      if (dp.lengthSq() > 1e-8 || 1 - Math.abs(dq.w) > 1e-7) this.errors.set(eid, { p: dp, q: dq, t0: now })
      else this.errors.delete(eid)
    }
  }

  /**
   * alpha in [0,1] interpolates from the previous tick's pose to the current
   * one (the sim runs at 60Hz, displays may differ), so motion is shown
   * one tick behind but smooth.
   */
  frame(now: number, alpha: number) {
    this.syncNew()
    for (const [eid, mesh] of this.meshes) {
      mesh.position.set(
        PrevPosition.x[eid] + (Position.x[eid] - PrevPosition.x[eid]) * alpha,
        PrevPosition.y[eid] + (Position.y[eid] - PrevPosition.y[eid]) * alpha,
        PrevPosition.z[eid] + (Position.z[eid] - PrevPosition.z[eid]) * alpha)
      prevQ.set(PrevRotation.x[eid], PrevRotation.y[eid], PrevRotation.z[eid], PrevRotation.w[eid])
      currQ.set(Rotation.x[eid], Rotation.y[eid], Rotation.z[eid], Rotation.w[eid])
      mesh.quaternion.copy(prevQ.slerp(currQ, alpha))
      const err = this.errors.get(eid)
      if (err) {
        const k = this.rubberMs <= 0 ? 0 : Math.max(0, 1 - (now - err.t0) / this.rubberMs)
        if (k <= 0) this.errors.delete(eid)
        else {
          mesh.position.addScaledVector(err.p, k)
          tmpQ.copy(IDENTITY).slerp(err.q, k)
          mesh.quaternion.premultiply(tmpQ)
        }
      }
    }
    this.controls.update()
    this.renderer.render(this.scene, this.camera)
  }
}

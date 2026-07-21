import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { EcsStore } from './ecs'

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

  constructor(parent: HTMLElement, public ecs: EcsStore) {
    this.renderer.setSize(innerWidth, innerHeight)
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
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
      // PAN, not ROTATE: OrbitControls swaps rotate<->pan while
      // ctrl/meta/shift is down, and this binding is only ever active
      // with cmd/ctrl held, so PAN is what actually orbits here.
      (this.controls.mouseButtons as any).LEFT = on ? THREE.MOUSE.PAN : undefined
    }
    addEventListener('keydown', e => { if (e.key === 'Meta' || e.key === 'Control') setOrbit(true) })
    addEventListener('keyup', e => { if (e.key === 'Meta' || e.key === 'Control') setOrbit(false) })
    addEventListener('blur', () => setOrbit(false))

    // Wheel is ours, not OrbitControls': a trackpad two-finger drag arrives
    // as plain wheel deltas (pan: the world follows the fingers, sliding
    // along the ground plane), while a pinch arrives with ctrlKey set
    // (zoom). Mouse wheels therefore pan too; ctrl-wheel zooms.
    this.controls.enableZoom = false
    const right = new THREE.Vector3()
    const fwd = new THREE.Vector3()
    this.renderer.domElement.addEventListener('wheel', e => {
      e.preventDefault()
      const unit = e.deltaMode === 1 ? 16 : 1 // lines -> px
      if (e.ctrlKey || e.metaKey) {
        const dir = this.camera.position.clone().sub(this.controls.target)
        dir.setLength(THREE.MathUtils.clamp(dir.length() * Math.exp(e.deltaY * unit * 0.01), 1.5, 200))
        this.camera.position.copy(this.controls.target).add(dir)
        return
      }
      const dist = this.camera.position.distanceTo(this.controls.target)
      const perPx = 2 * dist * Math.tan((this.camera.fov / 2) * Math.PI / 180) / this.renderer.domElement.clientHeight
      right.setFromMatrixColumn(this.camera.matrix, 0)
      right.y = 0
      right.normalize()
      this.camera.getWorldDirection(fwd)
      fwd.y = 0
      fwd.normalize()
      const delta = right.multiplyScalar(e.deltaX * unit * perPx).addScaledVector(fwd, e.deltaY * unit * perPx)
      this.camera.position.add(delta)
      this.controls.target.add(delta)
    }, { passive: false })

    this.scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x30281e, 0.7))
    this.sun = new THREE.DirectionalLight(0xffffff, 1.6)
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(4096, 4096)
    // normalBias trades acne for a light-leak fringe at contact points
    // (gap ~ 1.4x the bias under this sun angle): keep it at about one
    // shadow texel, the floor below which the fringe cannot shrink anyway.
    this.sun.shadow.bias = -0.00015
    this.sun.shadow.normalBias = 0.02
    this.scene.add(this.sun)
    this.scene.add(this.sun.target)
    this.fitShadows(null)
    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(40, 40),
      new THREE.MeshStandardMaterial({ color: 0x2a3140, roughness: 1 }))
    this.ground.rotation.x = -Math.PI / 2
    this.ground.receiveShadow = true
    this.scene.add(this.ground)
    this.grid = new THREE.GridHelper(40, 40, 0x39414d, 0x252b33)
    this.grid.position.y = 0.01
    this.scene.add(this.grid)

    addEventListener('resize', () => {
      this.camera.aspect = innerWidth / innerHeight
      this.camera.updateProjectionMatrix()
      this.renderer.setSize(innerWidth, innerHeight)
    })
  }

  private sceneRoot: THREE.Object3D | null = null
  private ground!: THREE.Mesh
  private grid!: THREE.GridHelper
  private sun!: THREE.DirectionalLight

  // The shadow frustum is a tight window that FOLLOWS the orbit target
  // rather than covering the whole scene: fitting a ~300-unit world into
  // one 4096 map leaves each box a dozen texels (blocky chevron acne).
  // Nearby shadows stay crisp; geometry beyond the window casts none.
  private readonly shadowRadius = 32
  private shadowReach = 40
  private readonly sunDir = new THREE.Vector3(0.45, 0.8, 0.35).normalize()

  /** Scene bounds only tune the vertical reach; the frustum tracks the
   * camera target per-frame (updateShadowFollow). */
  private fitShadows(box: THREE.Box3 | null) {
    const size = box ? box.getSize(new THREE.Vector3()) : new THREE.Vector3(40, 8, 40)
    this.shadowReach = Math.max(size.y, 20)
    const r = this.shadowRadius
    const cam = this.sun.shadow.camera
    cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r
    cam.near = 0.1
    cam.far = this.shadowReach * 3 + r * 4
    cam.updateProjectionMatrix()
  }

  private updateShadowFollow() {
    // snap the window to the shadow-map texel grid, or the follow motion
    // makes every shadow edge shimmer as the camera pans
    const texel = (2 * this.shadowRadius) / this.sun.shadow.mapSize.width
    const cx = Math.round(this.controls.target.x / texel) * texel
    const cz = Math.round(this.controls.target.z / texel) * texel
    this.sun.target.position.set(cx, 0, cz)
    this.sun.position.set(cx, 0, cz).addScaledVector(this.sunDir, this.shadowReach + this.shadowRadius * 2)
    this.sun.target.updateMatrixWorld()
  }

  /** Swap the rendered glTF scene (null removes it). Idempotent per object. */
  setScene(obj: THREE.Object3D | null) {
    if (this.sceneRoot === obj) return
    if (this.sceneRoot) this.scene.remove(this.sceneRoot)
    this.sceneRoot = obj
    if (obj) {
      obj.traverse(node => {
        const mesh = node as THREE.Mesh
        if (mesh.isMesh) { mesh.castShadow = true; mesh.receiveShadow = true }
      })
      this.scene.add(obj)
      this.fitShadows(new THREE.Box3().setFromObject(obj))
    } else {
      this.fitShadows(null)
    }
  }

  /** The ground plane and grid hide while a scene is active (tracks the
   * SIM's scene, not the visual fetch: the colliders are already gone). */
  setGroundVisible(on: boolean) {
    this.ground.visible = on
    this.grid.visible = on
  }

  private matFor(color: number) {
    let m = this.mats.get(color)
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.05 })
      this.mats.set(color, m)
    }
    return m
  }

  /**
   * Reconcile meshes against the sim's live bodies: create for new ones,
   * remove for deleted ones (a scene swap resets the world and drops every
   * box; ECS entities are never deleted, so liveness comes from the caller).
   */
  syncBodies(liveNetIds: Iterable<string>) {
    const live = new Set<number>()
    for (const id of liveNetIds) {
      const eid = this.ecs.entityFor(id)
      if (eid !== undefined) live.add(eid)
    }
    for (const eid of live) {
      if (this.meshes.has(eid)) continue
      const mesh = new THREE.Mesh(this.geo, this.matFor(this.ecs.Tint.value[eid]))
      mesh.castShadow = true
      mesh.receiveShadow = true
      mesh.userData.eid = eid
      this.scene.add(mesh)
      this.meshes.set(eid, mesh)
    }
    for (const [eid, mesh] of this.meshes) {
      if (live.has(eid)) continue
      this.scene.remove(mesh)
      this.meshes.delete(eid)
      this.errors.delete(eid)
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
    const { Position, Rotation } = this.ecs
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
    this.updateShadowFollow()
    const { Position, Rotation, PrevPosition, PrevRotation } = this.ecs
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

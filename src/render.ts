import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { CSM } from 'three/addons/csm/CSM.js'
import { Line2 } from 'three/addons/lines/Line2.js'
import { LineGeometry } from 'three/addons/lines/LineGeometry.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import type { EcsStore } from './ecs'
import { PropLayer } from './props'

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
  props: PropLayer
  private geo = new THREE.BoxGeometry(1, 1, 1)
  private mats = new Map<number, THREE.MeshStandardMaterial>()
  /** cosmetic line entities keyed "author/lineId"; scripts animate them.
   * Line2 "fat lines", because WebGL clamps core line rasterisation to
   * 1px: width is real - screen px, or world units for wire-like lines
   * that should scale with the camera. */
  private lines = new Map<string, { obj: Line2; pointsKey: string }>()
  private defaultBackground = new THREE.Color(0x0e1116)

  constructor(parent: HTMLElement, public ecs: EcsStore) {
    this.renderer.setSize(innerWidth, innerHeight)
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    // Filmic rolloff: glTF scenes with glossy floors turn the analytic sun
    // into a blown white glare puddle under linear output; ACES compresses
    // the highlight so it reads as sheen instead of a searchlight.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    // ACES darkens midtones; a modest exposure lift restores the overall
    // level without re-blowing the highlights it exists to compress.
    this.renderer.toneMappingExposure = 1.2
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

    // Feature stamp: stale-bundle confusion (host iframes cache hard) has
    // burned enough debugging time that the renderer announces itself.
    console.log('[worldsync] renderer: csm x4 backface-shadows aces (46aabb0+)')
    this.scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x30281e, 0.85))
    // Cascaded shadow maps with splits weighted hard toward the camera:
    // the near cascade covers only the first ~4m of view depth, so contact
    // shadows get millimetre texels and the bias needed to prevent acne
    // (which is what peter-pans the shadow off the contact point) shrinks
    // below visibility. Outer cascades keep distant casters shadowing at
    // progressively coarser resolution, with fade blending the seams.
    this.csm = new CSM({
      camera: this.camera,
      parent: this.scene,
      cascades: 4,
      maxFar: 150,
      mode: 'custom',
      customSplitsCallback: (_cascades: number, _near: number, _far: number, breaks: number[]) => {
        // cascade 0 reaches ~8m: box contacts are usually viewed from
        // 3-6m, and they must land in the finest cascade to read clean
        breaks.push(0.055, 0.16, 0.4, 1)
      },
      shadowMapSize: 2048,
      lightDirection: new THREE.Vector3(-0.45, -0.8, -0.35).normalize(),
      lightIntensity: 1.6,
    })
    this.csm.fade = true
    // Casters render BOTH faces into the shadow maps (shadowSide in
    // patchMaterial): back-face-only casting left a thin lit rim at
    // contact edges, because a resting box's bottom face is coplanar with
    // its receiver and edge texels resolved to "equal depth, lit" - with
    // front faces included, those texels store the box wall instead and
    // shadow decisively. The small normalBias covers the acne that front
    // faces reintroduce; at these texel sizes its peter-panning is
    // sub-centimetre.
    this.csm.lights.forEach((l, i) => {
      l.shadow.bias = -0.00002 * (i + 1)
      l.shadow.normalBias = 0.006
    })
    const groundMat = new THREE.MeshStandardMaterial({ color: 0x2a3140, roughness: 1 })
    this.patchMaterial(groundMat)
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), groundMat)
    this.ground.rotation.x = -Math.PI / 2
    this.ground.receiveShadow = true
    this.scene.add(this.ground)
    this.grid = new THREE.GridHelper(40, 40, 0x39414d, 0x252b33)
    this.grid.position.y = 0.01
    this.scene.add(this.grid)

    this.props = new PropLayer(m => this.patchMaterial(m))
    this.scene.add(this.props.group)

    addEventListener('resize', () => {
      this.camera.aspect = innerWidth / innerHeight
      this.camera.updateProjectionMatrix()
      this.renderer.setSize(innerWidth, innerHeight)
      this.csm.updateFrustums()
      // fat-line widths are screen-space: their materials carry the viewport
      for (const l of this.lines.values()) l.obj.material.resolution.set(innerWidth, innerHeight)
    })
  }

  private sceneRoot: THREE.Object3D | null = null
  private ground!: THREE.Mesh
  private grid!: THREE.GridHelper
  private csm!: CSM
  private csmPatched = new WeakSet<THREE.Material>()

  /** Route a lit material through the CSM shader patch (idempotent).
   * Every lit material MUST be patched, or it sums all cascade lights
   * and renders several times too bright; unlit materials ignore lights
   * and are left alone. Casters draw both faces into the shadow maps
   * (see the bias comment in the constructor). */
  private patchMaterial(m: THREE.Material) {
    m.shadowSide = THREE.DoubleSide
    const lit = m as THREE.MeshStandardMaterial
    if (!lit.isMeshStandardMaterial && !(m as THREE.MeshPhongMaterial).isMeshPhongMaterial
      && !(m as THREE.MeshLambertMaterial).isMeshLambertMaterial) return
    if (this.csmPatched.has(m)) return
    this.csmPatched.add(m)
    this.csm.setupMaterial(m)
  }

  /** Swap the rendered glTF scene (null removes it). Idempotent per object. */
  setScene(obj: THREE.Object3D | null) {
    if (this.sceneRoot === obj) return
    if (this.sceneRoot) this.scene.remove(this.sceneRoot)
    this.sceneRoot = obj
    if (obj) {
      obj.traverse(node => {
        const mesh = node as THREE.Mesh
        if (!mesh.isMesh) return
        mesh.castShadow = true
        mesh.receiveShadow = true
        for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
          this.patchMaterial(m)
        }
      })
      this.scene.add(obj)
    }
  }

  /** The ground plane and grid hide while a scene is active (tracks the
   * SIM's scene, not the visual fetch: the colliders are already gone). */
  setGroundVisible(on: boolean) {
    this.ground.visible = on && !this.groundSuppressed
    this.grid.visible = on && !this.groundSuppressed
  }
  private groundSuppressed = false

  /** Script-facing cosmetic environment: background/fog colors and whether
   * the default ground visuals show at all (the dots board floats in a
   * white void). Local-only state, so determinism is untouched; every peer
   * runs the same script and converges on the same look. */
  setEnvironment(env: { background?: number; fog?: { color: number; near: number; far: number } | null; ground?: boolean }) {
    if (env.background !== undefined) this.scene.background = new THREE.Color(env.background)
    else this.scene.background = this.defaultBackground
    this.scene.fog = env.fog ? new THREE.Fog(env.fog.color, env.fog.near, env.fog.far) : null
    if (env.ground !== undefined) {
      this.groundSuppressed = !env.ground
      this.ground.visible = env.ground && this.ground.visible
      this.grid.visible = env.ground && this.grid.visible
    }
  }

  /** One-shot camera framing hint from a script (onload). */
  setCameraPose(pos: { x: number; y: number; z: number }, target: { x: number; y: number; z: number }) {
    this.camera.position.set(pos.x, pos.y, pos.z)
    this.controls.target.set(target.x, target.y, target.z)
    this.controls.update()
  }

  /** Cosmetic line entity, keyed "author/lineId": full state per call,
   * latest wins; null or fewer than 2 points removes it. Geometry rebuilds
   * only when the points actually change, so per-frame color/opacity/width
   * animation from a script stays a material-only update. */
  setLine(key: string, points: { x: number; y: number; z: number }[] | null, color: number, opacity: number,
    width: number, worldUnits: boolean) {
    const existing = this.lines.get(key)
    if (!points || points.length < 2) {
      if (existing) {
        this.scene.remove(existing.obj)
        existing.obj.geometry.dispose()
        existing.obj.material.dispose()
        this.lines.delete(key)
      }
      return
    }
    const lineGeo = () => {
      const g = new LineGeometry()
      g.setPositions(points.flatMap(p => [p.x, p.y, p.z]))
      return g
    }
    const pointsKey = JSON.stringify(points)
    if (existing) {
      if (existing.pointsKey !== pointsKey) {
        existing.obj.geometry.dispose()
        existing.obj.geometry = lineGeo()
        existing.obj.computeLineDistances()
        existing.pointsKey = pointsKey
      }
      const m = existing.obj.material
      m.color.setHex(color)
      m.opacity = opacity
      m.linewidth = width
      if (m.worldUnits !== worldUnits) { m.worldUnits = worldUnits; m.needsUpdate = true }
      // fully transparent still writes depth, which carves invisible
      // notches out of lines it coincides with - skip rendering instead
      existing.obj.visible = opacity > 0
      return
    }
    const mat = new LineMaterial({ color, transparent: true, opacity, linewidth: width, worldUnits })
    mat.resolution.set(innerWidth, innerHeight)
    const obj = new Line2(lineGeo(), mat)
    obj.visible = opacity > 0
    obj.computeLineDistances()
    obj.renderOrder = 999 // never buried by the props it threads through
    this.scene.add(obj)
    this.lines.set(key, { obj, pointsKey })
  }

  /** Remove every line whose key starts with prefix (an author's "id/"). */
  removeLines(prefix: string) {
    for (const key of [...this.lines.keys()]) {
      if (key.startsWith(prefix)) this.setLine(key, null, 0, 0, 0, false)
    }
  }

  // -- video screens: flat planes a world script places, textured with a
  // peer's camera track when one is live and a dark placeholder otherwise.
  // Cosmetic like lines: never part of sim state, never picked. --
  private screens = new Map<string, { obj: THREE.Mesh; peer: string }>()
  private video = new Map<string, { el: HTMLVideoElement; tex: THREE.VideoTexture; mat: THREE.MeshBasicMaterial }>()
  private screenBlank = new THREE.MeshBasicMaterial({ color: 0x10141a, side: THREE.DoubleSide })
  private screenMat(peer: string) { return this.video.get(peer)?.mat ?? this.screenBlank }

  setScreen(key: string, peer: string, pos: { x: number; y: number; z: number },
    yaw: number, w: number, h: number) {
    let s = this.screens.get(key)
    if (!s) {
      s = { obj: new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.screenMat(peer)), peer }
      this.scene.add(s.obj)
      this.screens.set(key, s)
    } else if (s.peer !== peer) {
      s.peer = peer
      s.obj.material = this.screenMat(peer)
    }
    s.obj.position.set(pos.x, pos.y, pos.z)
    s.obj.rotation.set(0, yaw, 0)
    s.obj.scale.set(w, h, 1)
  }

  removeScreen(key: string) {
    const s = this.screens.get(key)
    if (!s) return
    this.scene.remove(s.obj)
    s.obj.geometry.dispose() // materials are shared per peer; disposed with the track
    this.screens.delete(key)
  }

  /** Remove every screen whose key starts with prefix (an author's "id/"). */
  removeScreens(prefix: string) {
    for (const key of [...this.screens.keys()]) {
      if (key.startsWith(prefix)) this.removeScreen(key)
    }
  }

  /** A peer's camera track came (or, with null, went): retexture every
   * screen bound to that peer. The <video> element never joins the DOM;
   * VideoTexture reads it directly. */
  setVideoTrack(peer: string, track: MediaStreamTrack | null) {
    const cur = this.video.get(peer)
    if (cur) {
      cur.mat.dispose()
      cur.tex.dispose()
      cur.el.srcObject = null
      this.video.delete(peer)
    }
    if (track) {
      const el = document.createElement('video')
      el.muted = true // audio arrives separately; a muted element autoplays
      el.playsInline = true
      el.autoplay = true
      el.srcObject = new MediaStream([track])
      void el.play().catch(() => {})
      const tex = new THREE.VideoTexture(el)
      tex.colorSpace = THREE.SRGBColorSpace
      this.video.set(peer, { el, tex, mat: new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }) })
    }
    for (const s of this.screens.values()) {
      if (s.peer === peer) s.obj.material = this.screenMat(peer)
    }
  }

  private matFor(color: number) {
    let m = this.mats.get(color)
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.05 })
      this.patchMaterial(m)
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
    this.props.update(now)
    this.controls.update()
    this.csm.update() // cascade frusta track the camera; must follow controls
    this.renderer.render(this.scene, this.camera)
  }
}

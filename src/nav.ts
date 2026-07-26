import * as THREE from 'three'
import { TransformControls } from 'three/addons/controls/TransformControls.js'
import { BOX_HALF, DIMS_MAX, DIMS_MIN, TICK_MS } from './sim'
import type { View } from './render'
import type { Emitter } from './input'

/**
 * Navigation modes, thirdroom-style. 'orbit' is the classic jig view
 * (OrbitControls, free cursor, plane drags). 'walk' is a first-person
 * avatar: pointer-lock mouselook (or cursor keys), WASD to move, shift to
 * run, space to jump, crosshair clicks to grab (carry), select or spawn.
 *
 * Selecting a box (single-click in either mode) switches to orbit around
 * it for precision work - the selection is outlined, and the bottom HUD
 * offers 'edit', which unlocks move/rotate/scale gizmos (three's
 * TransformControls: per-axis handles, center section = all axes). Gizmo
 * drags ride the existing protocol: grab + pose stream (rot beside pos
 * for rotate) + release; scale lands as one 'resize' op on drag end.
 * Esc or an empty click deselects, returning to the previous mode.
 *
 * A world script can force a mode with world.navigation('orbit'|'walk') -
 * top-down board worlds (dots, chess...) pin orbit so the walker never
 * falls into their void. Selection still overrides to orbit; the HUD
 * toggle yields while a script holds the mode.
 *
 * The avatar is pure camera - local cosmetics, never sim state: walking
 * feeds nothing into the timeline, so determinism is untouched. Floor
 * comes from a downward raycast against the rendered scene (three's
 * per-mesh bounding early-out keeps many-mesh scenes cheap; a single
 * giant terrain mesh would want a BVH). No wall collision: the jig walks
 * through walls rather than carrying a character controller.
 */
export type NavMode = 'orbit' | 'walk'

const EYE_HEIGHT = 1.6
const WALK_SPEED = 4
const RUN_SPEED = 9
const JUMP_SPEED = 5.5
const GRAVITY = 16
const TERMINAL = -30
const KEY_LOOK_SPEED = 1.8 // rad/s, cursor keys
const MOUSE_SENS = 0.0022  // rad/px of pointer-lock movement
const PITCH_MAX = Math.PI / 2 - 0.05
const STEP_UP = 1.0        // tallest ledge the walker steps straight onto
const DOWN = new THREE.Vector3(0, -1, 0)

/** What a click selected: a physics box (edits replicate as ops) or a
 * glTF scene node (edits are local previews, like the inspector's - the
 * baked trimesh collider never moves). */
export type Selection =
  | { kind: 'box'; netId: string; eid: number; mesh: THREE.Mesh }
  | { kind: 'scene'; name: string; obj: THREE.Object3D }

const v3 = (v: { x: number; y: number; z: number }) => ({ x: v.x, y: v.y, z: v.z })
const q4 = (q: THREE.Quaternion) => ({ x: q.x, y: q.y, z: q.z, w: q.w })

export class Nav {
  /** the walker's current pointer-lock state (crosshair rays when true) */
  locked = false
  /** which box the edit gizmo currently owns (render + corrections skip) */
  get authorityEid() { return this.gizmoEid }
  get selection(): Selection | null { return this.selected }
  /** the TransformControls instance, for tests and console poking */
  get gizmo() { return this.tc }
  /** pointer lock is unavailable (a host iframe without
   * allow="pointer-lock" - Element Web today, like MIDI): walk mode
   * falls back to drag-look on empty space */
  lockBroken = false
  /** main wires this: true while a running script claims space + arrows */
  keysClaimedByScript: () => boolean = () => false

  // walk is the default (thirdroom-style avatars want you IN the world);
  // ?nav=orbit restores the classic jig view - the scripted-test estate
  // rides on it, and board-world scripts pin orbit anyway
  private userMode: NavMode = 'walk'
  private scriptMode: NavMode | null = null
  private applied: NavMode = 'orbit'
  private selected: Selection | null = null
  private editOn = false

  // walk state: feet position; the camera rides EYE_HEIGHT above
  private feet = new THREE.Vector3(0, 0, 8)
  private yaw = 0
  private pitch = 0
  private vy = 0
  private grounded = false
  private keys = new Set<string>()
  private lastMs = 0
  private rayDown = new THREE.Raycaster()
  private tmpV = new THREE.Vector3()
  // smoothed walker velocity (m/s), for the avatar's locomotion clips
  private vel = new THREE.Vector3()
  private prevFeet = new THREE.Vector3(0, 0, 8)
  /** true once the user has actually walked (WASD): spawn placement must
   * not yank a walker who already set off exploring */
  hasMoved = false

  /** the avatar plane reads these: feet/view state, world space */
  get avatarState() {
    return {
      pos: { x: this.feet.x, y: this.feet.y, z: this.feet.z },
      yaw: this.yaw, pitch: this.pitch,
      vel: { x: this.vel.x, y: this.vel.y, z: this.vel.z },
      grounded: this.grounded,
    }
  }

  /** place the walker (spawn slots, scene arrivals): feet at (x,z) on
   * whatever floor a ray from fromY finds, facing `yawTo` */
  spawnAt(x: number, z: number, yawTo: number, fromY = 3) {
    this.feet.set(x, this.floorAt(x, z, fromY), z)
    this.prevFeet.copy(this.feet)
    this.vel.set(0, 0, 0)
    this.vy = 0
    this.yaw = yawTo
    this.pitch = 0
    if (this.applied === 'walk') {
      const cam = this.view.camera
      cam.position.set(this.feet.x, this.feet.y + EYE_HEIGHT, this.feet.z)
      cam.rotation.order = 'YXZ'
      cam.rotation.set(this.pitch, this.yaw, 0)
    }
  }

  private hud: HTMLElement
  private crosshair: HTMLElement

  private tc: TransformControls | null = null
  private gizmoEid: number | null = null
  private gizmoLastSent = 0

  constructor(private view: View, private out: Emitter, parent: HTMLElement) {
    this.hud = document.createElement('div')
    this.hud.id = 'navhud'
    parent.appendChild(this.hud)
    this.crosshair = document.createElement('div')
    this.crosshair.id = 'crosshair'
    this.crosshair.textContent = '+'
    parent.appendChild(this.crosshair)

    document.addEventListener('pointerlockchange', () => {
      const was = this.locked
      this.locked = document.pointerLockElement === this.view.renderer.domElement
      if (this.locked) this.lockBroken = false
      if (was && !this.locked) this.lastUnlockMs = performance.now()
      this.renderHud()
    })
    addEventListener('keydown', e => this.onKeyDown(e))
    addEventListener('keyup', e => this.keys.delete(e.code))
    addEventListener('blur', () => this.keys.clear())

    const params = new URLSearchParams(location.search)
    const nv = params.get('nav')
    if (nv === 'walk' || nv === 'orbit') this.userMode = nv
    if (this.userMode === 'walk') {
      // starting on foot: skip applyMode's adopt-the-camera handover (the
      // classic orbit position would drop the walker from mid-air) and
      // stand at the default feet, facing the origin; the avatar spawn
      // placement (main) repositions once the session knows its slot
      this.applied = 'walk'
      this.view.controls.enabled = false
      this.view.camera.position.set(this.feet.x, this.feet.y + EYE_HEIGHT, this.feet.z)
      this.view.camera.rotation.order = 'YXZ'
      this.view.camera.rotation.set(0, 0, 0)
    }
    this.applyMode()
  }

  effective(): NavMode {
    if (this.selected) return 'orbit'
    return this.scriptMode ?? this.userMode
  }

  setUserMode(m: NavMode) {
    this.userMode = m
    this.applyMode()
  }

  /** world.navigation: a script pins the mode; null (script stopped)
   * hands it back to the user's toggle */
  setScriptMode(m: NavMode | null) {
    if (m === this.scriptMode) return
    this.scriptMode = m
    this.applyMode()
  }

  /** world.camera while walking: adopt the pose as the avatar's (eye at
   * pos, facing target); orbit keeps the classic framing hint */
  setCameraPose(pos: { x: number; y: number; z: number }, target: { x: number; y: number; z: number }) {
    if (this.effective() !== 'walk') { this.view.setCameraPose(pos, target); return }
    this.feet.set(pos.x, pos.y - EYE_HEIGHT, pos.z)
    this.prevFeet.copy(this.feet) // a teleport is not motion: no velocity spike
    this.vy = 0
    const d = this.tmpV.set(target.x - pos.x, target.y - pos.y, target.z - pos.z).normalize()
    this.yaw = Math.atan2(-d.x, -d.z)
    this.pitch = THREE.MathUtils.clamp(Math.asin(THREE.MathUtils.clamp(d.y, -1, 1)), -PITCH_MAX, PITCH_MAX)
  }

  private lastUnlockMs = -Infinity

  requestLock() {
    if (this.lockBroken) return
    // Chrome returns a promise; a rejection must not stay unhandled (a
    // widget iframe without allow="pointer-lock" throws WrongDocumentError)
    const p = this.view.renderer.domElement.requestPointerLock() as unknown as Promise<void> | undefined
    p?.catch?.(() => this.lockFailed())
  }

  private lockFailed() {
    // Esc-exiting lock starts a browser cooldown (~1.3s) during which a
    // re-request legitimately fails: that is not a broken host, so only
    // latch the fallback when no lock was recently held
    if (performance.now() - this.lastUnlockMs < 2000 || this.lockBroken) return
    this.lockBroken = true
    console.warn('[worldsync] pointer lock unavailable '
      + '(host iframe without allow="pointer-lock"?); walk mode falls back to drag-look')
    this.renderHud()
  }

  /** pointer-lock mouselook, fed by Input's pointermove (movementX/Y) */
  look(mx: number, my: number) {
    if (this.effective() !== 'walk') return
    this.yaw -= mx * MOUSE_SENS
    this.pitch = THREE.MathUtils.clamp(this.pitch - my * MOUSE_SENS, -PITCH_MAX, PITCH_MAX)
  }

  /** left-drag orbit on empty space (OrbitControls reserves LEFT for box
   * gestures, so Input feeds us the drag): swing the camera around the
   * current pivot, same feel and clamps as OrbitControls' own rotate.
   * This is what keeps the viewpoint movable after selecting an object. */
  orbitBy(dx: number, dy: number) {
    const c = this.view.controls
    const cam = this.view.camera
    const off = cam.position.clone().sub(c.target)
    const sph = new THREE.Spherical().setFromVector3(off)
    const k = 2 * Math.PI / this.view.renderer.domElement.clientHeight
    sph.theta -= dx * k
    sph.phi = THREE.MathUtils.clamp(sph.phi - dy * k, 0.05, c.maxPolarAngle)
    cam.position.copy(c.target).add(off.setFromSpherical(sph))
    cam.lookAt(c.target)
  }

  /** a short click landed on a box: select it (toggle off if reselected) */
  clickedBox(eid: number, netId: string, mesh: THREE.Mesh) {
    if (this.selected?.kind === 'box' && this.selected.eid === eid) { this.deselect(); return }
    this.select({ kind: 'box', netId, eid, mesh })
  }

  /** a short click landed on glTF scene geometry: select the node */
  clickedScene(obj: THREE.Object3D) {
    if (this.selected?.kind === 'scene' && this.selected.obj === obj) { this.deselect(); return }
    this.select({ kind: 'scene', name: obj.name || `(${obj.type})`, obj })
  }

  /** a short click hit nothing: consume it as a deselect when something is
   * selected (so it does not double as a spawn) */
  clickedEmpty(): boolean {
    if (!this.selected) return false
    this.deselect()
    // the click is a user gesture: re-enter the walker's mouselook with it
    if (this.effective() === 'walk') this.requestLock()
    return true
  }

  /** the edit gizmo owns the pointer while an axis is hovered or dragged */
  gizmoConsumes(): boolean {
    return this.editOn && !!this.tc && (this.tc.dragging || this.tc.axis !== null)
  }

  /** An orbit pivot that does NOT move the camera: the point on the
   * current view ray at the object's depth. Selecting must not pop the
   * view (Matthew: keep the camera exactly where it is); orbiting then
   * swings around the selection's distance. */
  private orbitTargetFor(p: THREE.Vector3): THREE.Vector3 {
    const cam = this.view.camera
    const dir = cam.getWorldDirection(this.tmpV)
    const depth = Math.max(0.5, p.x * dir.x + p.y * dir.y + p.z * dir.z
      - cam.position.dot(dir))
    return cam.position.clone().addScaledVector(dir, depth)
  }

  /** Point the orbit controls at target without moving the camera: the
   * target sits on the view ray (orbitTargetFor), and the polar clamp is
   * widened to the current gaze - a walker looking level or upward sits
   * outside the default limit, and OrbitControls would otherwise snap
   * the camera to it (the pop this exists to kill). Recomputed at every
   * handover, so a downward gaze tightens it back to the default. */
  private setOrbitPivot(target: THREE.Vector3) {
    const c = this.view.controls
    c.target.copy(target)
    const off = this.view.camera.position.clone().sub(target)
    const polar = Math.acos(THREE.MathUtils.clamp(off.y / (off.length() || 1), -1, 1))
    c.maxPolarAngle = THREE.MathUtils.clamp(Math.max(Math.PI / 2 - 0.05, polar + 0.02), 0, Math.PI - 0.01)
  }

  /** the selected Object3D, whatever its kind */
  private selObj(): THREE.Object3D | null {
    return this.selected ? (this.selected.kind === 'box' ? this.selected.mesh : this.selected.obj) : null
  }

  private selWorldPos(): THREE.Vector3 {
    return this.selObj()!.getWorldPosition(new THREE.Vector3())
  }

  private select(sel: Selection) {
    this.selected = sel
    this.editOn = false
    this.detachGizmo()
    // selection outline shares the view's OutlinePass with the inspector
    // and world.highlight: last caller wins, which is fine for a jig
    this.view.setOutline([this.selObj()!])
    this.applyMode() // walk hands over to orbit
    this.setOrbitPivot(this.orbitTargetFor(this.selWorldPos()))
    this.renderHud()
  }

  deselect() {
    if (!this.selected) return
    this.selected = null
    this.editOn = false
    this.detachGizmo()
    // a despawn mid-gizmo-drag never fires dragging-changed: drop the
    // authority here or the render loop skips a ghost eid forever
    if (this.gizmoEid !== null) {
      this.gizmoEid = null
      this.view.poseAuthorityEid = null
    }
    this.view.setOutline([])
    this.applyMode()
  }

  private setEdit(on: boolean) {
    if (!this.selected) return
    this.editOn = on
    if (on) {
      const tc = this.ensureGizmo()
      tc.attach(this.selObj()!)
      // refresh the pivot depth (the box may have been dragged since
      // selection) without moving the camera
      this.setOrbitPivot(this.orbitTargetFor(this.selWorldPos()))
    } else this.detachGizmo()
    this.renderHud()
  }

  private detachGizmo() {
    this.tc?.detach()
  }

  private ensureGizmo(): TransformControls {
    if (this.tc) return this.tc
    const tc = new TransformControls(this.view.camera, this.view.renderer.domElement)
    tc.setSize(0.85)
    this.view.scene.add(tc.getHelper())
    tc.addEventListener('dragging-changed', e => {
      if (e.value) this.beginGizmoDrag()
      else this.endGizmoDrag()
    })
    tc.addEventListener('objectChange', () => this.streamGizmo())
    this.tc = tc
    return tc
  }

  // Gizmo drags on a BOX ride the normal interaction protocol, so every
  // peer sees the precision edit live: grab pins the box kinematic, the
  // pose stream carries position (and rotation, in rotate mode), release
  // hands it back to physics. Scale is not streamed - the box holds still
  // under the grab and one 'resize' op lands with the final extents on
  // drag end. Scene-node selections skip all of it: their edits are local
  // previews (the object moves in place, nothing folds, colliders stay).
  private beginGizmoDrag() {
    const sel = this.selected
    if (!sel) return
    this.view.controls.enabled = false
    if (sel.kind !== 'box' || !this.out.ready()) return
    this.gizmoEid = sel.eid
    this.view.poseAuthorityEid = sel.eid
    this.view.errors.delete(sel.eid)
    this.out.emit('grab', sel.netId, { pos: v3(sel.mesh.position) })
  }

  private streamGizmo() {
    const sel = this.selected
    if (this.gizmoEid === null || sel?.kind !== 'box' || !this.tc || this.tc.mode === 'scale') return
    const now = performance.now()
    if (now - this.gizmoLastSent < TICK_MS) return
    this.gizmoLastSent = now
    this.out.streamPose(sel.netId, v3(sel.mesh.position),
      this.tc.mode === 'rotate' ? q4(sel.mesh.quaternion) : undefined)
  }

  private endGizmoDrag() {
    const sel = this.selected
    if (sel?.kind === 'box' && this.tc && this.gizmoEid !== null) {
      const m = sel.mesh
      if (this.tc.mode === 'scale') {
        const c = (n: number) => Math.min(DIMS_MAX, Math.max(DIMS_MIN, n))
        const dims = { x: c(m.scale.x), y: c(m.scale.y), z: c(m.scale.z) }
        m.scale.set(dims.x, dims.y, dims.z)
        this.out.emit('resize', sel.netId, { pos: v3(m.position), dims })
      }
      // release carries the exact final pose (and rotation, which the pin
      // alone could leave one tick stale)
      this.out.emit('release', sel.netId, {
        pos: v3(m.position), vel: { x: 0, y: 0, z: 0 },
        rot: this.tc.mode === 'rotate' ? q4(m.quaternion) : undefined,
      })
    }
    if (sel) this.setOrbitPivot(this.orbitTargetFor(this.selWorldPos()))
    this.gizmoEid = null
    this.view.poseAuthorityEid = null
    this.view.controls.enabled = this.effective() === 'orbit'
  }

  private onKeyDown(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
    if (e.key === 'Escape') {
      // pointer-lock exit is the browser's; deselect is ours
      if (this.selected) this.deselect()
      return
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if (this.effective() !== 'walk') return
    // shift is a modifier, not a movement key: track it here or the
    // held-keys set never learns about it and running never engages
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
      this.keys.add(e.code)
      return
    }
    const scriptOwned = this.keysClaimedByScript()
      && ['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)
    if (scriptOwned) return
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
      e.preventDefault()
      this.keys.add(e.code)
      // jump on the press itself: a quick tap can come and go entirely
      // between two frames, which a per-frame key poll would miss
      if (e.code === 'Space' && !e.repeat && this.grounded) this.vy = JUMP_SPEED
    }
  }

  /** switch camera regimes when the effective mode changed */
  private applyMode() {
    const mode = this.effective()
    if (mode !== this.applied) {
      this.applied = mode
      const cam = this.view.camera
      if (mode === 'walk') {
        this.view.controls.enabled = false
        // adopt the current camera as the avatar: eyes where the view was,
        // facing the same way; gravity then finds the floor
        const d = cam.getWorldDirection(this.tmpV)
        this.yaw = Math.atan2(-d.x, -d.z)
        this.pitch = THREE.MathUtils.clamp(Math.asin(THREE.MathUtils.clamp(d.y, -1, 1)), -PITCH_MAX, PITCH_MAX)
        this.feet.copy(cam.position)
        this.feet.y = Math.max(0, cam.position.y - EYE_HEIGHT)
        this.prevFeet.copy(this.feet)
        this.vy = 0
      } else {
        if (this.locked) document.exitPointerLock()
        this.view.controls.enabled = true
        // pivot along the current view ray so the handover never pops
        this.setOrbitPivot(this.selected
          ? this.orbitTargetFor(this.selWorldPos())
          : cam.position.clone().add(cam.getWorldDirection(this.tmpV).multiplyScalar(6)))
        this.view.controls.update()
      }
    }
    this.renderHud()
  }

  /** per-frame: walk physics, selection liveness, crosshair */
  update(nowMs: number) {
    const dt = Math.min((nowMs - this.lastMs) / 1000, 0.1)
    this.lastMs = nowMs
    // the selection can vanish under us: a box despawns (scene swap,
    // another peer), a scene node's world gets replaced
    if (this.selected) {
      if (this.selected.kind === 'box') {
        if (!this.view.meshes.has(this.selected.eid)) this.deselect()
      } else {
        let p: THREE.Object3D | null = this.selected.obj
        while (p && p !== this.view.scene) p = p.parent
        if (p !== this.view.scene) this.deselect()
      }
    }
    if (this.effective() !== 'walk') {
      this.crosshair.style.display = 'none'
      this.vel.set(0, 0, 0) // out of body: the figure stands still
      this.prevFeet.copy(this.feet)
      return
    }
    this.crosshair.style.display = this.locked ? 'block' : 'none'

    // cursor-key look (the pointer-free path)
    if (this.keys.has('ArrowLeft')) this.yaw += KEY_LOOK_SPEED * dt
    if (this.keys.has('ArrowRight')) this.yaw -= KEY_LOOK_SPEED * dt
    if (this.keys.has('ArrowUp')) this.pitch = Math.min(PITCH_MAX, this.pitch + KEY_LOOK_SPEED * dt)
    if (this.keys.has('ArrowDown')) this.pitch = Math.max(-PITCH_MAX, this.pitch - KEY_LOOK_SPEED * dt)

    // WASD in the yaw plane; shift runs
    const fwd = (this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('KeyS') ? 1 : 0)
    const strafe = (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0)
    if (fwd || strafe) this.hasMoved = true
    if (fwd || strafe) {
      const speed = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? RUN_SPEED : WALK_SPEED
      const norm = speed * dt / Math.hypot(fwd, strafe)
      const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw)
      // rotateY(yaw): forward (0,0,-1) -> (-sin, 0, -cos); right (1,0,0)
      // -> (cos, 0, -sin). The right vector's z is NEGATIVE sin: a +sin
      // here once mirrored strafing over half the compass.
      this.feet.x += (-sin * fwd + cos * strafe) * norm
      this.feet.z += (-cos * fwd - sin * strafe) * norm
    }

    // gravity and floor snap (jumps fire on the Space keydown itself)
    this.vy = Math.max(TERMINAL, this.vy - GRAVITY * dt)
    this.feet.y += this.vy * dt
    const floor = this.floorAt(this.feet.x, this.feet.z, this.feet.y)
    if (this.feet.y <= floor && this.vy <= 0) {
      this.feet.y = floor
      this.vy = 0
      this.grounded = true
    } else this.grounded = false

    // smoothed velocity, for the avatar's locomotion clip selection
    if (dt > 0) {
      this.tmpV.copy(this.feet).sub(this.prevFeet).divideScalar(dt)
      this.vel.lerp(this.tmpV, Math.min(1, dt * 12))
    }
    this.prevFeet.copy(this.feet)

    const cam = this.view.camera
    cam.position.set(this.feet.x, this.feet.y + EYE_HEIGHT, this.feet.z)
    cam.rotation.order = 'YXZ'
    cam.rotation.set(this.pitch, this.yaw, 0)
  }

  private floorAt(x: number, z: number, fromY: number): number {
    const objs = this.view.floorObjects()
    if (objs.length) {
      this.tmpV.set(x, fromY + STEP_UP, z)
      this.rayDown.set(this.tmpV, DOWN)
      this.rayDown.far = 500
      const hit = this.rayDown.intersectObjects(objs, true)[0]
      if (hit) return hit.point.y
    }
    return 0
  }

  // -- the bottom HUD: mode toggle, hints, selection + edit controls --

  private renderHud() {
    const h = this.hud
    h.innerHTML = ''
    const btn = (label: string, on: boolean, cb: () => void, title = '') => {
      const b = document.createElement('button')
      b.textContent = label
      if (on) b.className = 'on'
      if (title) b.title = title
      b.onclick = () => { b.blur(); cb() }
      h.appendChild(b)
      return b
    }
    const hint = (text: string) => {
      const s = document.createElement('span')
      s.className = 'hint'
      s.textContent = text
      h.appendChild(s)
    }
    if (this.selected) {
      const box = this.selected.kind === 'box'
      const label = document.createElement('span')
      label.textContent = box ? (this.selected as { netId: string }).netId
        : `${(this.selected as { name: string }).name} · scene node`
      h.appendChild(label)
      btn('edit', this.editOn, () => this.setEdit(!this.editOn),
        box ? 'precision move/rotate/scale gizmos on the selection'
          : 'move/rotate/scale gizmos - local preview only, like the inspector')
      if (this.editOn) {
        const tc = this.ensureGizmo()
        for (const m of ['translate', 'rotate', 'scale'] as const) {
          btn(m === 'translate' ? 'move' : m, tc.mode === m, () => { tc.setMode(m); this.renderHud() },
            `drag an axis for one-axis ${m}; the center section uses all axes`)
        }
      }
      hint(box
        ? (this.editOn ? 'drag: orbit · drag box: reposition · esc: deselect'
          : 'drag: orbit · drag box: reposition · click empty / esc: deselect')
        : (this.editOn ? 'edits are local previews · esc: deselect'
          : 'drag: orbit · click empty / esc: deselect'))
      return
    }
    const forced = this.scriptMode !== null
    const mode = this.effective()
    btn(mode === 'walk' ? 'walk' : 'orbit', mode === 'walk',
      () => {
        this.setUserMode(this.userMode === 'walk' ? 'orbit' : 'walk')
        // the button click is a user gesture: enter mouselook right away
        if (this.effective() === 'walk') this.requestLock()
      },
      forced ? 'the world script pins the navigation mode'
        : 'toggle first-person walking (WASD / shift / space) vs orbit view')
    if (forced) (h.lastChild as HTMLButtonElement).disabled = true
    if (mode === 'walk') {
      hint(this.locked
        ? 'WASD move · shift run · space jump · 1: spawn · drag box: carry · click: select · esc: cursor'
        : this.lockBroken
          ? 'drag: look around · WASD move · shift run · space jump · 1: spawn'
          : 'click the world to look around · WASD move · shift run · space jump · 1: spawn')
    } else {
      hint('drag: orbit · drag box: move · click: select · 1: spawn box')
    }
  }
}

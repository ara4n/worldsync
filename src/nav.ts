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

export interface Selection { netId: string; eid: number; mesh: THREE.Mesh }

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
  /** main wires this: true while a running script claims space + arrows */
  keysClaimedByScript: () => boolean = () => false

  private userMode: NavMode = 'orbit'
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
      this.locked = document.pointerLockElement === this.view.renderer.domElement
      this.renderHud()
    })
    addEventListener('keydown', e => this.onKeyDown(e))
    addEventListener('keyup', e => this.keys.delete(e.code))
    addEventListener('blur', () => this.keys.clear())

    const params = new URLSearchParams(location.search)
    if (params.get('nav') === 'walk') this.userMode = 'walk'
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
    this.vy = 0
    const d = this.tmpV.set(target.x - pos.x, target.y - pos.y, target.z - pos.z).normalize()
    this.yaw = Math.atan2(-d.x, -d.z)
    this.pitch = THREE.MathUtils.clamp(Math.asin(THREE.MathUtils.clamp(d.y, -1, 1)), -PITCH_MAX, PITCH_MAX)
  }

  requestLock() {
    this.view.renderer.domElement.requestPointerLock()
  }

  /** pointer-lock mouselook, fed by Input's pointermove (movementX/Y) */
  look(mx: number, my: number) {
    if (this.effective() !== 'walk') return
    this.yaw -= mx * MOUSE_SENS
    this.pitch = THREE.MathUtils.clamp(this.pitch - my * MOUSE_SENS, -PITCH_MAX, PITCH_MAX)
  }

  /** a short click landed on a box: select it (toggle off if reselected) */
  clickedBox(eid: number, netId: string, mesh: THREE.Mesh) {
    if (this.selected?.eid === eid) { this.deselect(); return }
    this.select({ netId, eid, mesh })
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

  private select(sel: Selection) {
    this.selected = sel
    this.editOn = false
    this.detachGizmo()
    // selection outline shares the view's OutlinePass with the inspector
    // and world.highlight: last caller wins, which is fine for a jig
    this.view.setOutline([sel.mesh])
    this.applyMode() // walk hands over to orbit
    this.view.controls.target.copy(sel.mesh.position) // orbit pivots the selection
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
      tc.attach(this.selected.mesh)
      this.view.controls.target.copy(this.selected.mesh.position)
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

  // Gizmo drags ride the normal interaction protocol, so every peer sees
  // the precision edit live: grab pins the box kinematic, the pose stream
  // carries position (and rotation, in rotate mode), release hands it back
  // to physics. Scale is not streamed - the box holds still under the grab
  // and one 'resize' op lands with the final extents on drag end.
  private beginGizmoDrag() {
    const sel = this.selected
    if (!sel || !this.out.ready()) return
    this.view.controls.enabled = false
    this.gizmoEid = sel.eid
    this.view.poseAuthorityEid = sel.eid
    this.view.errors.delete(sel.eid)
    this.out.emit('grab', sel.netId, { pos: v3(sel.mesh.position) })
  }

  private streamGizmo() {
    const sel = this.selected
    if (this.gizmoEid === null || !sel || !this.tc || this.tc.mode === 'scale') return
    const now = performance.now()
    if (now - this.gizmoLastSent < TICK_MS) return
    this.gizmoLastSent = now
    this.out.streamPose(sel.netId, v3(sel.mesh.position),
      this.tc.mode === 'rotate' ? q4(sel.mesh.quaternion) : undefined)
  }

  private endGizmoDrag() {
    const sel = this.selected
    if (sel && this.tc && this.gizmoEid !== null) {
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
      this.view.controls.target.copy(m.position)
    }
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
        this.vy = 0
      } else {
        if (this.locked) document.exitPointerLock()
        this.view.controls.enabled = true
        const target = this.selected
          ? this.selected.mesh.position.clone()
          : cam.position.clone().add(cam.getWorldDirection(this.tmpV).multiplyScalar(6))
        this.view.controls.target.copy(target)
        this.view.controls.update()
      }
    }
    this.renderHud()
  }

  /** per-frame: walk physics, selection liveness, crosshair */
  update(nowMs: number) {
    const dt = Math.min((nowMs - this.lastMs) / 1000, 0.1)
    this.lastMs = nowMs
    // a selected box can despawn under us (scene swap, another peer)
    if (this.selected && !this.view.meshes.has(this.selected.eid)) this.deselect()
    if (this.effective() !== 'walk') {
      this.crosshair.style.display = 'none'
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
    if (fwd || strafe) {
      const speed = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? RUN_SPEED : WALK_SPEED
      const norm = speed * dt / Math.hypot(fwd, strafe)
      const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw)
      this.feet.x += (-sin * fwd + cos * strafe) * norm
      this.feet.z += (-cos * fwd + sin * strafe) * norm
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
      const label = document.createElement('span')
      label.textContent = this.selected.netId
      h.appendChild(label)
      btn('edit', this.editOn, () => this.setEdit(!this.editOn),
        'precision move/rotate/scale gizmos on the selection')
      if (this.editOn) {
        const tc = this.ensureGizmo()
        for (const m of ['translate', 'rotate', 'scale'] as const) {
          btn(m === 'translate' ? 'move' : m, tc.mode === m, () => { tc.setMode(m); this.renderHud() },
            `drag an axis for one-axis ${m}; the center section uses all axes`)
        }
      }
      hint(this.editOn ? 'drag box: reposition · esc: deselect'
        : 'drag: orbit · drag box: reposition · click empty / esc: deselect')
      return
    }
    const forced = this.scriptMode !== null
    const mode = this.effective()
    btn(mode === 'walk' ? 'walk' : 'orbit', mode === 'walk',
      () => this.setUserMode(this.userMode === 'walk' ? 'orbit' : 'walk'),
      forced ? 'the world script pins the navigation mode'
        : 'toggle first-person walking (WASD / shift / space) vs orbit view')
    if (forced) (h.lastChild as HTMLButtonElement).disabled = true
    if (mode === 'walk') {
      hint(this.locked
        ? 'WASD move · shift run · space jump · drag box: carry · click box: select · esc: cursor'
        : 'click the world to look around · WASD move · shift run · space jump')
    } else {
      hint('drag box: move · click box: select · click ground: spawn · cmd/right-drag: orbit')
    }
  }
}

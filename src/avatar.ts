import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js'
import type { Vec3 } from './types'

/**
 * Animated peer avatars, ported from thirdroom: one silver Mixamo-rigged
 * figure per peer, driven ENTIRELY by the cosmetic avatar plane (the
 * latest-wins 'avatar' broadcast) - never by the physics sim. The sim
 * only ever sees each avatar's kinematic box collider, pinned through
 * the pose plane like any held box; what you SEE here is presentation:
 * smoothed feet positions, thirdroom's velocity-driven locomotion clip
 * blending, and two bits of bone-level behaviour thirdroom never had -
 * the head pitching to the peer's view angle (walk mode only; orbit is
 * the out-of-body view and leaves the figure alone) and the left arm
 * pointing at whatever object the peer has selected.
 *
 * Nothing binds to a particular character: any GLB whose skin rides the
 * standard mixamorig skeleton drops in (setUrl), and clips resolve by
 * name (Idle, Walk, Run, WalkBack, RunBack, StrafeLeft/Right(+Run),
 * TurnLeft/Right, Fall1/2) - the stock thirdroom clip vocabulary that
 * tools/avatar-glb.mjs bakes into the default asset.
 */

export interface AvatarPose {
  pos: Vec3 // feet, world space
  yaw: number
  pitch: number
  vel: Vec3 // m/s world space; drives locomotion clip selection
  grounded: boolean
  mode: 'walk' | 'orbit'
  aim?: Vec3 | null // left-hand point target (selection, or world.aim)
}

// thirdroom's animation.game.ts constants, thresholds re-tuned to this
// jig's speeds: thresholds are on SQUARED horizontal speed; thirdroom's
// walk->run boundary (10 ~ 3.2m/s) sits below our 4m/s walk, so it
// moves to 6m/s (between WALK_SPEED 4 and RUN_SPEED 9).
const IDLE_T2 = 0.5 // below ~0.7m/s: idle
const WALK_T2 = 36 // below 6m/s: walk set, above: run set
const FADE_IN = 8 // weight/s
const FADE_OUT = 4
const TURN_RATE = 0.6 // rad/s of yaw change that reads as turning in place
const FALL2_VY = -12 // hard-fall clip below this vertical speed
const FWD_DEG = 50 // vel within this of facing = moving forward
const BACK_DEG = 120 // beyond this = backpedalling
// presentation smoothing (per-second exponential rates)
const POS_K = 14
const YAW_K = 12
const HEAD_K = 10
const AIM_K = 6

const DEFAULT_URL = `${import.meta.env.BASE_URL}avatar-default.glb`

/** find a mixamo bone whether or not the loader stripped the ':' */
const bone = (root: THREE.Object3D, name: string): THREE.Object3D | null =>
  root.getObjectByName(`mixamorig${name}`) ?? root.getObjectByName(`mixamorig:${name}`) ?? null

const shortestArc = (from: number, to: number) => {
  let d = (to - from) % (2 * Math.PI)
  if (d > Math.PI) d -= 2 * Math.PI
  if (d < -Math.PI) d += 2 * Math.PI
  return d
}

const tmpV = new THREE.Vector3()
const tmpV2 = new THREE.Vector3()
const tmpV3 = new THREE.Vector3()
const tmpQ2 = new THREE.Quaternion()
const IDENTITY = new THREE.Quaternion()

/** premultiply a WORLD-space rotation onto a bone's local quaternion,
 * scaled to `weight` (parents' world transforms must be current) */
const rotQa = new THREE.Quaternion()
const rotQb = new THREE.Quaternion()
const rotQc = new THREE.Quaternion()
function rotateBoneWorld(b: THREE.Object3D, delta: THREE.Quaternion, weight: number) {
  if (weight <= 0) return
  b.parent!.getWorldQuaternion(rotQa)
  rotQb.copy(IDENTITY).slerp(delta, Math.min(1, weight))
  // local' = inv(parentWorld) * delta^w * parentWorld * local
  rotQc.copy(rotQa).invert().multiply(rotQb).multiply(rotQa)
  b.quaternion.premultiply(rotQc)
}

interface Rig {
  group: THREE.Group // at the feet, yawed to face travel
  mixer: THREE.AnimationMixer
  actions: Map<string, THREE.AnimationAction>
  head: THREE.Object3D | null
  neck: THREE.Object3D | null
  lArm: THREE.Object3D | null
  lForeArm: THREE.Object3D | null
  lHand: THREE.Object3D | null
}

class PeerAvatar {
  target: AvatarPose
  pos = new THREE.Vector3()
  yaw = 0
  yawVel = 0 // smoothed, for turn-in-place detection
  headPitch = 0 // smoothed applied head pitch
  aimWeight = 0
  aimPoint = new THREE.Vector3()
  rig: Rig | null = null

  constructor(pose: AvatarPose) {
    this.target = pose
    this.pos.set(pose.pos.x, pose.pos.y, pose.pos.z)
    this.yaw = pose.yaw
  }
}

export class Avatars {
  readonly group = new THREE.Group()
  /** world.avatars(false): board worlds hide the whole layer */
  enabled = true
  /** the local peer id; its figure hides while the camera is inside it */
  localId = ''

  /** main wires this to the panel log */
  log: (line: string) => void = () => {}

  private url = DEFAULT_URL
  private avatars = new Map<string, PeerAvatar>()
  private asset: { scene: THREE.Object3D; clips: THREE.AnimationClip[] } | null = null
  private loading = false
  private loadFailed = false
  private lastMs = 0

  constructor(private patchMaterial: (m: THREE.Material) => void) {
    this.group.name = 'avatars'
  }

  /** swap the avatar asset (same mixamorig skeleton assumed); existing
   * figures rebuild against it on their next update */
  setUrl(url: string) {
    if (url === this.url) return
    this.url = url
    this.asset = null
    this.loading = false
    this.loadFailed = false
    for (const a of this.avatars.values()) this.dropRig(a)
  }

  setEnabled(on: boolean) {
    this.enabled = on
    this.group.visible = on
  }

  /** latest-wins state for one peer's figure (the cosmetic avatar plane;
   * the local peer feeds its own every frame) */
  apply(peer: string, pose: AvatarPose) {
    const a = this.avatars.get(peer)
    if (a) a.target = pose
    else this.avatars.set(peer, new PeerAvatar(pose))
  }

  /** a departed peer takes its figure with it */
  remove(peer: string) {
    const a = this.avatars.get(peer)
    if (!a) return
    this.dropRig(a)
    this.avatars.delete(peer)
  }

  has(peer: string) { return this.avatars.has(peer) }

  /** per-frame: smoothing, locomotion blending, head + arm overrides.
   * cameraPos hides the LOCAL figure whenever the camera is inside it -
   * which covers first-person walking AND the moment just after going
   * out-of-body (the orbit camera starts at the eyes; the figure fades
   * back in once you swing away instead of filling the screen). */
  update(nowMs: number, cameraPos: THREE.Vector3 | null = null) {
    const dt = Math.min((nowMs - this.lastMs) / 1000, 0.1)
    this.lastMs = nowMs
    if (!this.enabled) return
    if (!this.asset) { this.ensureAsset(); return }
    for (const [peer, a] of this.avatars) {
      if (!a.rig) this.buildRig(a)
      const rig = a.rig!
      rig.group.visible = !(peer === this.localId && cameraPos
        && cameraPos.distanceToSquared(tmpV.set(a.pos.x, a.pos.y + 1.6, a.pos.z)) < 1.44)
      this.animate(a, dt)
    }
  }

  /** dominant clip name per peer plus override state, for tests/console */
  debug(): Record<string, {
    clip: string; weight: number; pos: Vec3; visible: boolean
    headPitch: number; aimWeight: number; bones: boolean
    headWorldY: number | null
  }> {
    const out: ReturnType<Avatars['debug']> = {}
    for (const [peer, a] of this.avatars) {
      let clip = '', weight = 0
      for (const [name, action] of a.rig?.actions ?? []) {
        if (action.weight > weight) { weight = action.weight; clip = name }
      }
      let headWorldY: number | null = null
      if (a.rig?.head) {
        a.rig.head.getWorldDirection(tmpV) // bone +Z in world
        headWorldY = tmpV.y
      }
      out[peer] = {
        clip, weight,
        pos: { x: a.pos.x, y: a.pos.y, z: a.pos.z },
        visible: !!a.rig?.group.visible && this.enabled,
        headPitch: a.headPitch, aimWeight: a.aimWeight,
        bones: !!(a.rig?.head && a.rig.lArm && a.rig.lForeArm),
        headWorldY,
      }
    }
    return out
  }

  private ensureAsset() {
    if (this.loading || this.loadFailed) return
    this.loading = true
    new GLTFLoader().load(this.url, gltf => {
      this.loading = false
      // Mixamo tracks start at frame 1 (t=1/30). While a looping action's
      // time sits BEFORE the first keyframe, the mixer leaves the bones
      // unwritten - so the post-mixer head/aim overrides compound frame
      // over frame and the head visibly spins for a frame or two at every
      // loop wrap (worst on 120Hz displays). Shift every clip to start at
      // 0 so there is no clamp zone; first and last keys are identical in
      // these clips, so the loop stays seamless. glTF tracks SHARE their
      // times arrays (samplers reuse input accessors), so shift each
      // array instance once, not once per track.
      const shifted = new Set<ArrayLike<number>>()
      for (const clip of gltf.animations) {
        const t0 = Math.min(...clip.tracks.map(tr => tr.times[0]))
        if (!(t0 > 0) || !Number.isFinite(t0)) continue
        for (const tr of clip.tracks) {
          if (shifted.has(tr.times)) continue
          shifted.add(tr.times)
          for (let i = 0; i < tr.times.length; i++) tr.times[i] -= t0
        }
        clip.resetDuration()
      }
      gltf.scene.traverse(node => {
        const mesh = node as THREE.Mesh
        if (!mesh.isMesh) return
        mesh.castShadow = true
        mesh.receiveShadow = true
        // skinned meshes animate outside their static bounds; without
        // this the figure vanishes when its bind-pose box leaves view
        mesh.frustumCulled = false
        for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
          this.patchMaterial(m)
        }
      })
      this.asset = { scene: gltf.scene, clips: gltf.animations }
    }, undefined, e => {
      this.loading = false
      this.loadFailed = true // a broken asset must not refetch every frame
      this.log(`avatar asset failed to load (${this.url}): ${e}`)
    })
  }

  private buildRig(a: PeerAvatar) {
    const root = cloneSkinned(this.asset!.scene)
    const group = new THREE.Group()
    // mixamo figures face +Z in bind pose; the jig's yaw-0 forward is -Z,
    // so the rig flips once inside the group and the group takes raw yaw
    root.rotation.y = Math.PI
    group.add(root)
    group.position.copy(a.pos)
    group.rotation.y = a.yaw
    this.group.add(group)
    const mixer = new THREE.AnimationMixer(root)
    const actions = new Map<string, THREE.AnimationAction>()
    for (const clip of this.asset!.clips) {
      const action = mixer.clipAction(clip)
      action.play()
      action.enabled = false
      action.setEffectiveWeight(0)
      actions.set(clip.name, action)
    }
    a.rig = {
      group, mixer, actions,
      head: bone(root, 'Head'), neck: bone(root, 'Neck'),
      lArm: bone(root, 'LeftArm'), lForeArm: bone(root, 'LeftForeArm'), lHand: bone(root, 'LeftHand'),
    }
  }

  private dropRig(a: PeerAvatar) {
    if (!a.rig) return
    this.group.remove(a.rig.group)
    a.rig.mixer.stopAllAction()
    a.rig = null // geometry/materials are shared with the cached asset; nothing to dispose
  }

  // -- thirdroom's clip selection (animation.game.ts), on the broadcast
  // velocity instead of a physics body's --
  private pick(a: PeerAvatar): { name: string; reverse?: boolean }[] {
    const t = a.target
    const speed2 = t.vel.x * t.vel.x + t.vel.z * t.vel.z
    if (t.vel.y < FALL2_VY) return [{ name: 'Fall2' }]
    if (!t.grounded) return [{ name: 'Fall1' }]
    if (speed2 < IDLE_T2) {
      if (a.yawVel > TURN_RATE) return [{ name: 'TurnLeft' }]
      if (a.yawVel < -TURN_RATE) return [{ name: 'TurnRight' }]
      return [{ name: 'Idle' }]
    }
    // angles between travel and the FACING direction (deg), thirdroom-style
    const fwd = tmpV.set(-Math.sin(a.yaw), 0, -Math.cos(a.yaw))
    const right = tmpV2.set(Math.cos(a.yaw), 0, -Math.sin(a.yaw))
    const vel = tmpV3.set(t.vel.x, 0, t.vel.z)
    const angleF = THREE.MathUtils.radToDeg(fwd.angleTo(vel))
    const angleR = THREE.MathUtils.radToDeg(right.angleTo(vel))
    const run = speed2 >= WALK_T2
    const F = run ? 'Run' : 'Walk', B = run ? 'RunBack' : 'WalkBack'
    const SL = run ? 'StrafeLeftRun' : 'StrafeLeft', SR = run ? 'StrafeRightRun' : 'StrafeRight'
    const out: { name: string; reverse?: boolean }[] = []
    const backward = angleF > BACK_DEG
    if (angleF < FWD_DEG) out.push({ name: F })
    if (backward) out.push({ name: B })
    // backward strafes reuse the opposite clip in reverse (thirdroom's trick)
    if (angleR > BACK_DEG) out.push(backward ? { name: SR, reverse: true } : { name: SL })
    if (angleR < FWD_DEG) out.push(backward ? { name: SL, reverse: true } : { name: SR })
    if (!out.length) out.push({ name: F })
    return out
  }

  private animate(a: PeerAvatar, dt: number) {
    const rig = a.rig!
    const t = a.target
    // -- presentation smoothing: feet + yaw chase the broadcast state --
    const k = 1 - Math.exp(-POS_K * dt)
    a.pos.lerp(tmpV.set(t.pos.x, t.pos.y, t.pos.z), k)
    const dyaw = shortestArc(a.yaw, t.yaw)
    const yawStep = dyaw * (1 - Math.exp(-YAW_K * dt))
    a.yaw += yawStep
    a.yawVel = dt > 0 ? a.yawVel * 0.8 + (yawStep / dt) * 0.2 : a.yawVel
    rig.group.position.copy(a.pos)
    rig.group.rotation.y = a.yaw

    // -- locomotion blending: fade everything out, chosen clips in,
    // phase-aligned so blends do not slide feet --
    const chosen = this.pick(a)
    for (const action of rig.actions.values()) {
      const w = Math.max(0, action.weight - FADE_OUT * dt)
      action.setEffectiveWeight(w)
      if (w <= 0) action.enabled = false
    }
    let primary: THREE.AnimationAction | null = null
    for (const c of chosen) {
      const action = rig.actions.get(c.name)
      if (!action) continue
      if (!action.enabled) { action.enabled = true; action.time = 0 }
      action.setEffectiveTimeScale(c.reverse ? -1 : 1)
      action.setEffectiveWeight(Math.min(1, action.weight + (FADE_IN + FADE_OUT) * dt))
      const dur = action.getClip().duration
      if (primary) {
        const pDur = primary.getClip().duration
        action.time = THREE.MathUtils.euclideanModulo(primary.time / pDur, 1) * dur
      } else primary = action
    }
    rig.mixer.update(dt)

    // -- bone-level overrides, after the mixer so they win --
    rig.group.updateMatrixWorld(true)

    // head tracks the peer's view pitch while walking; orbit is the
    // out-of-body view, so the figure's head is left to the clips
    const wantPitch = t.mode === 'walk' ? t.pitch : 0
    a.headPitch += (wantPitch - a.headPitch) * (1 - Math.exp(-HEAD_K * dt))
    if (Math.abs(a.headPitch) > 1e-3) {
      // world right axis of the facing, so the nod is a pure pitch
      const right = tmpV.set(Math.cos(a.yaw), 0, -Math.sin(a.yaw))
      // split across neck + head so extremes keep a natural curve
      if (rig.neck) rotateBoneWorld(rig.neck, tmpQ2.setFromAxisAngle(right, a.headPitch * 0.35), 1)
      if (rig.head) rotateBoneWorld(rig.head, tmpQ2.setFromAxisAngle(right, a.headPitch * 0.65), 1)
    }

    // left arm points at the peer's selection for as long as it has one
    a.aimWeight += ((t.aim ? 1 : 0) - a.aimWeight) * (1 - Math.exp(-AIM_K * dt))
    if (t.aim) a.aimPoint.set(t.aim.x, t.aim.y, t.aim.z)
    if (a.aimWeight > 0.01 && rig.lArm && rig.lForeArm && rig.lHand) {
      this.aimLimb(rig.lArm, rig.lForeArm, a.aimPoint, a.aimWeight)
      this.aimLimb(rig.lForeArm, rig.lHand, a.aimPoint, a.aimWeight)
    }
  }

  /** swing `upper` so its bone axis (toward `lower`) points at target;
   * world matrices must be current, and are refreshed for the subtree */
  private aimLimb(upper: THREE.Object3D, lower: THREE.Object3D, target: THREE.Vector3, weight: number) {
    upper.getWorldPosition(tmpV)
    lower.getWorldPosition(tmpV2)
    const current = tmpV2.sub(tmpV).normalize()
    const desired = tmpV3.copy(target).sub(tmpV).normalize()
    if (current.lengthSq() < 1e-8 || desired.lengthSq() < 1e-8) return
    rotateBoneWorld(upper, tmpQ2.setFromUnitVectors(current, desired), weight)
    upper.updateWorldMatrix(false, true)
  }
}

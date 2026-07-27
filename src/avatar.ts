import * as THREE from 'three'
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js'
import { glbLoader } from './scene'
import type { Vec3 } from './types'

/**
 * Animated peer avatars, ported from thirdroom: one silver Mixamo-rigged
 * figure per peer, driven ENTIRELY by the cosmetic avatar plane (the
 * latest-wins 'avatar' broadcast) - never by the physics sim. The sim
 * only ever sees each avatar's kinematic box collider, pinned through
 * the pose plane like any held box; what you SEE here is presentation:
 * smoothed feet positions, thirdroom's velocity-driven locomotion clip
 * blending, and two bits of bone-level behaviour thirdroom never had -
 * the head pitching to the peer's view angle (held across a switch to
 * orbit rather than snapping back to neutral) and an arm pointing
 * at the peer's aim target - its selection, the box it is dragging, or
 * a script's world.aim - using whichever arm is nearer the target.
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

/** who a figure belongs to, for the name billboard over its head. name is
 * whatever the transport knows (Matrix displayname, else the peer id);
 * imageUrl is a displayable url (blob:/data:/https) or absent. */
export interface AvatarIdentity {
  name: string
  imageUrl?: string | null
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
const AIM_PT_K = 10 // the point itself chases too, or the arm pops per step

const DEFAULT_URL = `${import.meta.env.BASE_URL}avatar-robot-opt.glb`

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

// billboard canvas pixels per world metre: sets on-figure text size
const LABEL_PX_PER_M = 300
const LABEL_IMG_PX = 84 // avatar image diameter
const LABEL_TEXT_PX = 30
const LABEL_PILL_PX = 44 // name pill height

/** name + avatar-image card as a camera-facing sprite. Draws the name
 * immediately; the image streams in with a texture refresh when (if) it
 * loads. Callers own disposal of material.map and material. */
function makeLabel(id: AvatarIdentity): THREE.Sprite {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')!
  ctx.font = `600 ${LABEL_TEXT_PX}px system-ui, sans-serif`
  const textW = Math.ceil(ctx.measureText(id.name).width)
  const withImg = !!id.imageUrl
  const W = Math.max(textW + 28, withImg ? LABEL_IMG_PX + 8 : 0, 60)
  const H = (withImg ? LABEL_IMG_PX + 6 : 0) + LABEL_PILL_PX
  canvas.width = W
  canvas.height = H
  const draw = (img: HTMLImageElement | null) => {
    ctx.clearRect(0, 0, W, H)
    ctx.beginPath()
    ctx.roundRect(0, H - LABEL_PILL_PX, W, LABEL_PILL_PX, 12)
    ctx.fillStyle = 'rgba(10, 12, 18, 0.72)'
    ctx.fill()
    ctx.font = `600 ${LABEL_TEXT_PX}px system-ui, sans-serif`
    ctx.fillStyle = '#fff'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(id.name, W / 2, H - LABEL_PILL_PX / 2 + 1)
    if (img) {
      ctx.save()
      ctx.beginPath()
      ctx.arc(W / 2, LABEL_IMG_PX / 2, LABEL_IMG_PX / 2, 0, Math.PI * 2)
      ctx.clip()
      ctx.drawImage(img, (W - LABEL_IMG_PX) / 2, 0, LABEL_IMG_PX, LABEL_IMG_PX)
      ctx.restore()
    }
  }
  draw(null)
  const map = new THREE.CanvasTexture(canvas)
  map.colorSpace = THREE.SRGBColorSpace
  if (id.imageUrl) {
    const img = new Image()
    // http(s) images would taint the canvas and kill the texture upload;
    // blob:/data: urls (the Matrix path) don't care either way
    img.crossOrigin = 'anonymous'
    img.onload = () => { draw(img); map.needsUpdate = true }
    img.src = id.imageUrl
  }
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map, transparent: true, depthWrite: false }))
  sprite.scale.set(W / LABEL_PX_PER_M, H / LABEL_PX_PER_M, 1)
  return sprite
}

interface Rig {
  group: THREE.Group // at the feet, yawed to face travel
  mixer: THREE.AnimationMixer
  actions: Map<string, THREE.AnimationAction>
  label: THREE.Sprite | null // identity billboard, child of group
  head: THREE.Object3D | null
  neck: THREE.Object3D | null
  lArm: THREE.Object3D | null
  lForeArm: THREE.Object3D | null
  lHand: THREE.Object3D | null
  rArm: THREE.Object3D | null
  rForeArm: THREE.Object3D | null
  rHand: THREE.Object3D | null
}

class PeerAvatar {
  target: AvatarPose
  pos = new THREE.Vector3()
  yaw = 0
  yawVel = 0 // smoothed, for turn-in-place detection
  headPitch = 0 // smoothed applied head pitch
  // per-arm aim weights: the nearer arm points, and a genuine side
  // switch crossfades (one arm eases down while the other rises)
  aimWeightL = 0
  aimWeightR = 0
  aimSide: 'l' | 'r' = 'l'
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
  private identities = new Map<string, AvatarIdentity>()
  private asset: { scene: THREE.Object3D; clips: THREE.AnimationClip[]; height: number } | null = null
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
    this.identities.delete(peer)
  }

  has(peer: string) { return this.avatars.has(peer) }

  /** who this figure is (billboard over its head). Idempotent; a change
   * (displayname edit, avatar image arriving late) redraws in place. */
  setIdentity(peer: string, identity: AvatarIdentity) {
    const cur = this.identities.get(peer)
    if (cur && cur.name === identity.name && (cur.imageUrl ?? null) === (identity.imageUrl ?? null)) return
    this.identities.set(peer, identity)
    const rig = this.avatars.get(peer)?.rig
    if (rig) this.attachLabel(rig, identity)
  }

  private attachLabel(rig: Rig, identity: AvatarIdentity) {
    if (rig.label) {
      rig.group.remove(rig.label)
      rig.label.material.map?.dispose()
      rig.label.material.dispose()
    }
    const label = makeLabel(identity)
    // hover over the head: the asset's bind-pose height plus clearance
    // (sprite position is its center). The group yaw-rotates with travel;
    // sprites ignore rotation and face the camera regardless.
    label.position.y = (this.asset?.height ?? 1.8) + 0.15 + label.scale.y / 2
    rig.group.add(label)
    rig.label = label
  }

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
      if (!a.rig) this.buildRig(peer, a)
      const rig = a.rig!
      rig.group.visible = !(peer === this.localId && cameraPos
        && cameraPos.distanceToSquared(tmpV.set(a.pos.x, a.pos.y + 1.6, a.pos.z)) < 1.44)
      this.animate(a, dt)
    }
  }

  /** dominant clip name per peer plus override state, for tests/console */
  debug(): Record<string, {
    clip: string; weight: number; pos: Vec3; visible: boolean
    headPitch: number; aimWeight: number; aimSide: 'l' | 'r'; bones: boolean
    headWorldY: number | null
    label: string | null // billboard name if one is attached
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
        headPitch: a.headPitch,
        // combined for tests/inspection: whichever arm is up
        aimWeight: Math.max(a.aimWeightL, a.aimWeightR), aimSide: a.aimSide,
        bones: !!(a.rig?.head && a.rig.lArm && a.rig.lForeArm && a.rig.rArm),
        headWorldY,
        label: a.rig?.label ? this.identities.get(peer)?.name ?? '' : null,
      }
    }
    return out
  }

  private ensureAsset() {
    if (this.loading || this.loadFailed) return
    this.loading = true
    glbLoader().load(this.url, gltf => {
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
      // bind-pose height, for hanging the identity billboard over the
      // head whatever the character's proportions (robot 1.5m, bot 1.9m)
      const height = new THREE.Box3().setFromObject(gltf.scene).max.y
      this.asset = { scene: gltf.scene, clips: gltf.animations, height }
    }, undefined, e => {
      this.loading = false
      this.loadFailed = true // a broken asset must not refetch every frame
      this.log(`avatar asset failed to load (${this.url}): ${e}`)
    })
  }

  private buildRig(peer: string, a: PeerAvatar) {
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
      group, mixer, actions, label: null,
      head: bone(root, 'Head'), neck: bone(root, 'Neck'),
      lArm: bone(root, 'LeftArm'), lForeArm: bone(root, 'LeftForeArm'), lHand: bone(root, 'LeftHand'),
      rArm: bone(root, 'RightArm'), rForeArm: bone(root, 'RightForeArm'), rHand: bone(root, 'RightHand'),
    }
    const identity = this.identities.get(peer)
    if (identity) this.attachLabel(a.rig, identity)
  }

  private dropRig(a: PeerAvatar) {
    if (!a.rig) return
    this.group.remove(a.rig.group)
    a.rig.mixer.stopAllAction()
    // the label's canvas texture is per-figure (unlike the shared
    // geometry/materials of the cached asset), so it does need disposing
    a.rig.label?.material.map?.dispose()
    a.rig.label?.material.dispose()
    a.rig = null
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

    // head tracks the peer's view pitch in every mode: going out-of-body
    // keeps the look pose held at the switch (the broadcast pitch freezes
    // at its last walk value; Matthew: no reset to neutral) - third-person
    // steering levels it anyway, since nav zeroes pitch on figure motion
    a.headPitch += (t.pitch - a.headPitch) * (1 - Math.exp(-HEAD_K * dt))
    if (Math.abs(a.headPitch) > 1e-3) {
      // world right axis of the facing, so the nod is a pure pitch
      const right = tmpV.set(Math.cos(a.yaw), 0, -Math.sin(a.yaw))
      // split across neck + head so extremes keep a natural curve
      if (rig.neck) rotateBoneWorld(rig.neck, tmpQ2.setFromAxisAngle(right, a.headPitch * 0.35), 1)
      if (rig.head) rotateBoneWorld(rig.head, tmpQ2.setFromAxisAngle(right, a.headPitch * 0.65), 1)
    }

    // An arm points at the peer's aim target (selection, carried box, or
    // world.aim) while one is set - whichever arm is NEARER the target's
    // side, with a hysteresis band so a target dithering on the midline
    // does not flap the arms. The weights ease the arms up and down (a
    // genuine side switch crossfades); the POINT eases too - a stepping
    // target (the tetris piece, hover hopping keys) would otherwise pop
    // the arm - except while both arms are still down, where chasing
    // from a stale point would read as a sweep in from nowhere.
    const down = a.aimWeightL < 0.05 && a.aimWeightR < 0.05
    if (t.aim) {
      if (down) a.aimPoint.set(t.aim.x, t.aim.y, t.aim.z)
      else a.aimPoint.lerp(tmpV.set(t.aim.x, t.aim.y, t.aim.z), 1 - Math.exp(-AIM_PT_K * dt))
      // signed offset toward the figure's right: rotateY(yaw) * (1,0,0)
      const rightOff = (a.aimPoint.x - a.pos.x) * Math.cos(a.yaw)
        - (a.aimPoint.z - a.pos.z) * Math.sin(a.yaw)
      if (down) a.aimSide = rightOff >= 0 ? 'r' : 'l'
      else if (a.aimSide === 'l' ? rightOff > 0.25 : rightOff < -0.25) {
        a.aimSide = a.aimSide === 'l' ? 'r' : 'l'
      }
    }
    const ak = 1 - Math.exp(-AIM_K * dt)
    a.aimWeightL += ((t.aim && a.aimSide === 'l' ? 1 : 0) - a.aimWeightL) * ak
    a.aimWeightR += ((t.aim && a.aimSide === 'r' ? 1 : 0) - a.aimWeightR) * ak
    if (a.aimWeightL > 0.01 && rig.lArm && rig.lForeArm && rig.lHand) {
      this.aimLimb(rig.lArm, rig.lForeArm, a.aimPoint, a.aimWeightL)
      this.aimLimb(rig.lForeArm, rig.lHand, a.aimPoint, a.aimWeightL)
    }
    if (a.aimWeightR > 0.01 && rig.rArm && rig.rForeArm && rig.rHand) {
      this.aimLimb(rig.rArm, rig.rForeArm, a.aimPoint, a.aimWeightR)
      this.aimLimb(rig.rForeArm, rig.rHand, a.aimPoint, a.aimWeightR)
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

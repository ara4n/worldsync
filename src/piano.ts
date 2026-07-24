import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

/**
 * A modelled concert grand for the script-facing cosmetic piano entity
 * (world.createGrandPiano): curved rim, open lid on its stick, strung
 * frame, legs, lyre - and 88 individually pivoting keys the script plays
 * pianola-style (world.pianoNote), normally straight from world.onmidi.
 *
 * Local units are meters at size 1 (a ~2.2m grand, keys to scale: 23.55mm
 * white-key pitch); the group origin is the floor point under the
 * keyboard's center, X runs across the keys (treble at +X), the tail
 * extends toward -Z. Purely cosmetic, like screens and labels: never sim
 * state, never picked, no audio.
 *
 * Keys rotate about the balance rail like the real action: note() sets a
 * target dip and update() chases it with a fast attack and a slower
 * release, so runs of MIDI read as hammering pianola keys rather than
 * eased UI. Gloss comes from clearcoat materials fed a PMREM room
 * environment (passed in by the View; the scene itself has no envmap).
 */

// -- plan outline: x across the keyboard, s depth from the front edge
// toward the tail. Authored at full size; planShape(inset) shrinks it
// toward the plan's center line for the rim's inner wall, the soundboard,
// and the slightly-proud lid (negative inset). --
const PLAN_W = 0.73
const PLAN_L = 1.95
const planShape = (inset: number): THREE.Shape => {
  const fx = (PLAN_W - inset) / PLAN_W
  const fs = (PLAN_L - 2 * inset) / PLAN_L
  const X = (x: number) => x * fx
  const S = (s: number) => inset + s * fs
  const sh = new THREE.Shape()
  sh.moveTo(X(-0.73), S(0))
  sh.lineTo(X(0.73), S(0))
  sh.lineTo(X(0.73), S(0.42)) // straight treble cheek side
  sh.bezierCurveTo(X(0.73), S(0.78), X(0.56), S(0.86), X(0.5), S(1.06)) // the waist
  sh.bezierCurveTo(X(0.44), S(1.36), X(0.4), S(1.58), X(0.16), S(1.78)) // bent side into the tail
  sh.bezierCurveTo(X(-0.06), S(1.97), X(-0.46), S(1.95), X(-0.66), S(1.74)) // round tail
  sh.bezierCurveTo(X(-0.73), S(1.66), X(-0.73), S(1.58), X(-0.73), S(1.48)) // back to the spine
  sh.lineTo(X(-0.73), S(0)) // straight bass spine
  return sh
}

/** extrude a plan shape and lay it flat: shape (x, s) -> world (x, -z),
 * extrusion depth -> +Y, base at y=0 */
const extrudePlan = (shape: THREE.Shape, depth: number, bevel: number) => {
  const g = new THREE.ExtrudeGeometry(shape, {
    depth, curveSegments: 24,
    bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2,
  })
  g.rotateX(-Math.PI / 2)
  return g
}

const box = (w: number, h: number, d: number, x: number, y: number, z: number) => {
  const g = new THREE.BoxGeometry(w, h, d)
  g.translate(x, y, z)
  return g
}

/** a horizontal bar from (x0,z0) to (x1,z1) at height y: strings, struts */
const bar = (w: number, h: number, x0: number, z0: number, x1: number, z1: number, y: number) => {
  const g = new THREE.BoxGeometry(w, h, Math.hypot(x1 - x0, z1 - z0))
  g.rotateY(Math.atan2(x1 - x0, z1 - z0))
  g.translate((x0 + x1) / 2, y, (z0 + z1) / 2)
  return g
}

// -- vertical layout --
const BODY_BOT = 0.62 // underside of the case
const RIM_TOP = 1.0
const KEYBED_TOP = 0.71
const WHITE_TOP = 0.743
const LID_ANGLE = 0.6 // ~34 degrees on the full stick

// -- keyboard layout: 52 whites at real pitch, blacks offset in their
// groups like a real keyboard (C#/D# hug C/E, F#/A# hug F/B) --
const WHITE_PITCH = 0.02355
const WHITES = 52
const KEY_SPAN = WHITES * WHITE_PITCH // 1.2246
const FIRST_NOTE = 21 // A0
const LAST_NOTE = 108 // C8
const PIVOT_Z = 0.12 // the balance rail, hidden under the nameboard
const WHITE_FRONT = 0.335
const BLACK_FRONT = 0.24
const KEY_BACK = 0.05
const BLACK_BACK = 0.145
const isBlack = (note: number) => [1, 3, 6, 8, 10].includes(note % 12)
const BLACK_OFF: Record<number, number> = { 1: -0.0025, 3: 0.0025, 6: -0.003, 8: 0, 10: 0.003 }

interface Key { mesh: THREE.Mesh; cur: number; target: number; dip: number }

export class GrandPianoView {
  group = new THREE.Group()
  /** notes currently held down (HUD/test introspection) */
  pressed = new Set<number>()
  private keys = new Map<number, Key>()
  private caseMat: THREE.MeshPhysicalMaterial
  private color = -1
  private last = 0
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []

  constructor(patch: (m: THREE.Material) => void, env: THREE.Texture) {
    const mat = <T extends THREE.Material>(m: T): T => {
      patch(m)
      this.mats.push(m)
      return m
    }
    const std = (p: THREE.MeshStandardMaterialParameters) =>
      mat(new THREE.MeshStandardMaterial({ envMap: env, envMapIntensity: 0.4, ...p }))
    // near-black polyester: the gloss must come from the clearcoat layer,
    // not base reflectance - a strong base envMap washes black out to
    // silver under the room environment
    this.caseMat = mat(new THREE.MeshPhysicalMaterial({
      color: 0x080808, roughness: 0.38, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.16,
      envMap: env, envMapIntensity: 0.22,
    }))
    const innerMat = std({ color: 0x121212, roughness: 0.85, envMapIntensity: 0.1 })
    const woodMat = std({ color: 0xc09048, roughness: 0.6, envMapIntensity: 0.25 })
    const goldMat = std({ color: 0x9a7a28, metalness: 0.85, roughness: 0.4 })
    const brassMat = std({ color: 0xb08d2f, metalness: 1, roughness: 0.3 })
    const steelMat = std({ color: 0xbfc3c9, metalness: 1, roughness: 0.25 })
    const copperMat = std({ color: 0xa05a32, metalness: 1, roughness: 0.3 })
    const feltMat = std({ color: 0x8e1f2f, roughness: 1, envMapIntensity: 0 })
    const whiteMat = mat(new THREE.MeshPhysicalMaterial({
      color: 0xf6f3ea, roughness: 0.35, clearcoat: 0.5, clearcoatRoughness: 0.3,
      envMap: env, envMapIntensity: 0.25,
    }))
    const blackMat = mat(new THREE.MeshPhysicalMaterial({
      color: 0x141414, roughness: 0.4, clearcoat: 0.5, clearcoatRoughness: 0.25,
      envMap: env, envMapIntensity: 0.3,
    }))

    const add = (geo: THREE.BufferGeometry, m: THREE.Material, shadow = true) => {
      this.geos.push(geo)
      const mesh = new THREE.Mesh(geo, m)
      mesh.castShadow = shadow
      mesh.receiveShadow = true
      this.group.add(mesh)
      return mesh
    }

    // case: rim walls (outer plan minus inner), bottom board, soundboard
    const rimShape = planShape(0)
    rimShape.holes.push(planShape(0.055))
    add(extrudePlan(rimShape, RIM_TOP - BODY_BOT - 0.016, 0.008).translate(0, BODY_BOT + 0.008, 0), this.caseMat)
    add(extrudePlan(planShape(0.01), 0.024, 0).translate(0, BODY_BOT, 0), innerMat)
    add(extrudePlan(planShape(0.06), 0.012, 0).translate(0, 0.78, 0), woodMat)

    // the strung frame: gold pin-block bar and struts over the fans
    add(box(1.24, 0.02, 0.15, 0, 0.805, -0.135), goldMat)
    const struts = [
      [0.5, -0.28, 0.05, -1.05], [0.18, -0.28, -0.18, -1.55], [-0.15, -0.28, -0.42, -1.35],
    ].map(([x0, z0, x1, z1]) => bar(0.03, 0.02, x0, z0, x1, z1, 0.845))
    add(mergeGeometries(struts), goldMat)
    // strings: steel fan shortening toward the treble, copper bass fan
    // crossing over it toward the tail
    const steel: THREE.BufferGeometry[] = []
    for (let i = 0; i < 26; i++) {
      const t = i / 25
      steel.push(bar(0.0035, 0.0035,
        0.58 - 0.7 * t, -0.22, 0.45 - 0.73 * t, -0.55 - 1.17 * t, 0.815))
    }
    add(mergeGeometries(steel), steelMat, false)
    const copper: THREE.BufferGeometry[] = []
    for (let i = 0; i < 10; i++) {
      const t = i / 9
      copper.push(bar(0.005, 0.005,
        -0.55 + 0.33 * t, -0.22, 0.12 - 0.27 * t, -1.72 + 0.24 * t, 0.832))
    }
    add(mergeGeometries(copper), copperMat, false)

    // keyboard shelf: keybed, case cheeks, end blocks, keyslip, nameboard
    // (with a gold maker's pinstripe) and the red felt over the key backs
    add(box(1.31, 0.05, 0.36, 0, 0.685, 0.18), this.caseMat)
    add(box(0.075, 0.18, 0.36, -0.6925, 0.71, 0.18), this.caseMat)
    add(box(0.075, 0.18, 0.36, 0.6925, 0.71, 0.18), this.caseMat)
    add(box(0.045, 0.05, 0.29, -0.6355, 0.735, 0.195), this.caseMat)
    add(box(0.045, 0.05, 0.29, 0.6355, 0.735, 0.195), this.caseMat)
    add(box(1.31, 0.045, 0.018, 0, 0.7165, 0.353), this.caseMat)
    add(box(1.31, 0.07, 0.02, 0, 0.79, 0.135), this.caseMat)
    add(box(0.3, 0.014, 0.004, 0, 0.795, 0.147), goldMat, false)
    add(box(1.28, 0.007, 0.014, 0, 0.7465, 0.132), feltMat, false)

    // music desk on its ledge, leaned back over the pin block
    const desk = add(box(1.02, 0.26, 0.016, 0, 0, 0), this.caseMat)
    desk.position.set(0, 0.919, -0.183)
    desk.rotation.x = -0.42
    add(box(1.02, 0.016, 0.06, 0, 0.808, -0.115), this.caseMat)

    // lid, hinged along the spine and propped on its stick
    const lid = extrudePlan(planShape(-0.015), 0.03, 0.006)
    lid.translate(PLAN_W, 0, 0)
    lid.rotateZ(LID_ANGLE)
    lid.translate(-PLAN_W, RIM_TOP + 0.005, 0)
    add(lid, this.caseMat)
    const hinges = [-0.35, -0.9, -1.4].map(z => box(0.024, 0.014, 0.1, -0.72, RIM_TOP + 0.004, z))
    add(mergeGeometries(hinges), brassMat, false)
    // stick: from the treble rim up to the lid's underside
    const sx = 0.62 // where it meets the lid, in lid-local x from the hinge
    const top = new THREE.Vector3(
      -PLAN_W + Math.cos(LID_ANGLE) * (sx + PLAN_W), RIM_TOP + Math.sin(LID_ANGLE) * (sx + PLAN_W), -0.68)
    const base = new THREE.Vector3(0.52, RIM_TOP, -0.68)
    const stickGeo = new THREE.CylinderGeometry(0.012, 0.012, top.distanceTo(base), 8)
    this.geos.push(stickGeo)
    const stick = new THREE.Mesh(stickGeo, this.caseMat)
    stick.castShadow = true
    stick.position.copy(base).add(top).multiplyScalar(0.5)
    stick.rotation.z = Math.atan2(base.x - top.x, top.y - base.y)
    this.group.add(stick)

    // legs (square-tapered, brass casters) and the pedal lyre
    for (const [x, z] of [[-0.63, 0.12], [0.63, 0.12], [-0.18, -1.6]]) {
      const leg = new THREE.CylinderGeometry(0.062, 0.045, 0.515, 4, 1)
      leg.rotateY(Math.PI / 4)
      leg.translate(x, 0.3125, z)
      add(leg, this.caseMat)
      add(box(0.125, 0.05, 0.125, x, 0.595, z), this.caseMat)
      const caster = new THREE.CylinderGeometry(0.03, 0.03, 0.055, 10)
      caster.translate(x, 0.0275, z)
      add(caster, brassMat)
    }
    add(box(0.04, 0.45, 0.055, -0.085, 0.395, -0.28), this.caseMat)
    add(box(0.04, 0.45, 0.055, 0.085, 0.395, -0.28), this.caseMat)
    add(box(0.26, 0.055, 0.09, 0, 0.155, -0.28), this.caseMat)
    const pedals = [-0.055, 0, 0.055].map(x => box(0.02, 0.012, 0.095, x, 0.188, -0.215))
    add(mergeGeometries(pedals), brassMat)

    // -- the 88 keys, each pivoting at the balance rail. White keys are a
    // full-width front merged with a back stick narrowed away from the
    // neighbouring blacks; geometries are cached per cutout pattern. --
    const whiteGeos = new Map<string, THREE.BufferGeometry>()
    const whiteGeo = (left: boolean, right: boolean) => {
      const k = `${left}${right}`
      let g = whiteGeos.get(k)
      if (!g) {
        const bw = 0.0224 - (left ? 0.0075 : 0) - (right ? 0.0075 : 0)
        const bx = (left ? 0.00375 : 0) - (right ? 0.00375 : 0)
        g = mergeGeometries([
          box(0.0224, 0.023, WHITE_FRONT - BLACK_FRONT, 0, 0, (BLACK_FRONT + WHITE_FRONT) / 2 - PIVOT_Z),
          box(bw, 0.023, BLACK_FRONT - KEY_BACK, bx, 0, (KEY_BACK + BLACK_FRONT) / 2 - PIVOT_Z),
        ])
        whiteGeos.set(k, g)
        this.geos.push(g)
      }
      return g
    }
    // stepped black key: a base in the white gap and a narrower crown
    const blackGeo = mergeGeometries([
      box(0.011, 0.012, BLACK_FRONT - BLACK_BACK, 0, -0.009, (BLACK_BACK + BLACK_FRONT) / 2 - PIVOT_Z),
      box(0.0095, 0.0125, 0.09, 0, 0.00325, 0.19 - PIVOT_Z),
    ])
    this.geos.push(blackGeo)

    let white = 0
    for (let note = FIRST_NOTE; note <= LAST_NOTE; note++) {
      let mesh: THREE.Mesh
      let x: number
      let dip: number
      if (isBlack(note)) {
        // between its neighbouring whites: `white` already counts the left one
        x = -KEY_SPAN / 2 + white * WHITE_PITCH + BLACK_OFF[note % 12]
        mesh = new THREE.Mesh(blackGeo, blackMat)
        mesh.position.set(x, WHITE_TOP + 0.004, PIVOT_Z)
        dip = 0.075
      } else {
        x = -KEY_SPAN / 2 + (white + 0.5) * WHITE_PITCH
        const left = note > FIRST_NOTE && isBlack(note - 1)
        const right = note < LAST_NOTE && isBlack(note + 1)
        mesh = new THREE.Mesh(whiteGeo(left, right), whiteMat)
        mesh.position.set(x, WHITE_TOP - 0.0115, PIVOT_Z)
        dip = 0.052
        white++
      }
      mesh.castShadow = true
      mesh.receiveShadow = true
      this.group.add(mesh)
      this.keys.set(note, { mesh, cur: 0, target: 0, dip })
    }
  }

  setPose(pos: { x: number; y: number; z: number }, yaw: number, size: number, color: number) {
    this.group.position.set(pos.x, pos.y, pos.z)
    this.group.rotation.y = yaw
    this.group.scale.setScalar(size)
    if (color !== this.color) {
      this.color = color
      this.caseMat.color.setHex(color)
    }
  }

  /** press (velocity 1-127, shading the dip a touch) or release (0) a key */
  note(note: number, velocity: number) {
    const k = this.keys.get(note)
    if (!k) return
    if (velocity > 0) {
      k.target = k.dip * (0.85 + 0.15 * Math.min(velocity, 127) / 127)
      this.pressed.add(note)
    } else {
      k.target = 0
      this.pressed.delete(note)
    }
  }

  /** chase key targets: fast attack, slower release, pianola snap */
  update(now: number) {
    const dt = Math.min(0.1, (now - this.last) / 1000)
    this.last = now
    for (const k of this.keys.values()) {
      if (k.cur === k.target) continue
      const tau = k.target > k.cur ? 0.014 : 0.045
      k.cur += (k.target - k.cur) * (1 - Math.exp(-dt / tau))
      if (Math.abs(k.cur - k.target) < 0.0005) k.cur = k.target
      k.mesh.rotation.x = k.cur
    }
  }

  dispose() {
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
  }
}

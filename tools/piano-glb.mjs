// Build examples/piano.glb: the modelled concert grand as a rigged glTF
// WORLD - a floor plus the piano, every key its own named node
// (key_21..key_108, MIDI numbering) whose origin sits on the balance
// rail, so a WebSG script dips a key by writing node.rotation (rotate
// about local +X; each key node's glTF extras carry {note, black, dip}
// with dip = the full-press angle in radians). The model is the same
// concert grand src/piano.ts used to build at runtime: curved rim, open
// lid on its stick, strung frame, legs, lyre, 88 keys to scale.
//
// Run: node tools/piano-glb.mjs
// Upload the result with "load glTF scene (.glb)" (examples/piano.js is
// the matching pianola script). The app bakes every mesh into the fixed
// trimesh collider, so the case and floor are solid on all peers without
// any script-side collider seeding.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'

// GLTFExporter assembles the GLB through Blob + FileReader; node has
// Blob but no FileReader, so shim the two methods the exporter calls.
class FileReaderShim {
  readAsArrayBuffer(blob) {
    void blob.arrayBuffer().then(buf => { this.result = buf; this.onloadend?.() })
  }
  readAsDataURL(blob) {
    void blob.arrayBuffer().then(buf => {
      this.result = `data:${blob.type};base64,` + Buffer.from(buf).toString('base64')
      this.onloadend?.()
    })
  }
}
globalThis.FileReader ??= FileReaderShim

// -- plan outline: x across the keyboard, s depth from the front edge
// toward the tail (world -z). planShape(inset) shrinks it toward the
// plan's center line for the rim's inner wall, the soundboard, and the
// slightly-proud lid (negative inset). --
const PLAN_W = 0.73
const PLAN_L = 1.95
const planShape = (inset) => {
  const fx = (PLAN_W - inset) / PLAN_W
  const fs = (PLAN_L - 2 * inset) / PLAN_L
  const X = (x) => x * fx
  const S = (s) => inset + s * fs
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
const extrudePlan = (shape, depth, bevel) => {
  const g = new THREE.ExtrudeGeometry(shape, {
    depth, curveSegments: 24,
    bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2,
  })
  g.rotateX(-Math.PI / 2)
  return g
}

const box = (w, h, d, x, y, z) => {
  const g = new THREE.BoxGeometry(w, h, d)
  g.translate(x, y, z)
  return g
}

/** a horizontal bar from (x0,z0) to (x1,z1) at height y: strings, struts */
const bar = (w, h, x0, z0, x1, z1, y) => {
  const g = new THREE.BoxGeometry(w, h, Math.hypot(x1 - x0, z1 - z0))
  g.rotateY(Math.atan2(x1 - x0, z1 - z0))
  g.translate((x0 + x1) / 2, y, (z0 + z1) / 2)
  return g
}

// -- vertical layout --
const BODY_BOT = 0.62 // underside of the case
const RIM_TOP = 1.0
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
const isBlack = (note) => [1, 3, 6, 8, 10].includes(note % 12)
const BLACK_OFF = { 1: -0.0025, 3: 0.0025, 6: -0.003, 8: 0, 10: 0.003 }

// -- materials: same palette as the runtime model, minus the envmaps
// (the app lights glTF worlds itself); clearcoat gloss survives export
// as KHR_materials_clearcoat --
const caseMat = new THREE.MeshPhysicalMaterial({
  color: 0x080808, roughness: 0.38, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.16,
})
const innerMat = new THREE.MeshStandardMaterial({ color: 0x121212, roughness: 0.85 })
const woodMat = new THREE.MeshStandardMaterial({ color: 0xc09048, roughness: 0.6 })
const goldMat = new THREE.MeshStandardMaterial({ color: 0x9a7a28, metalness: 0.85, roughness: 0.4 })
const brassMat = new THREE.MeshStandardMaterial({ color: 0xb08d2f, metalness: 1, roughness: 0.3 })
const steelMat = new THREE.MeshStandardMaterial({ color: 0xbfc3c9, metalness: 1, roughness: 0.25 })
const copperMat = new THREE.MeshStandardMaterial({ color: 0xa05a32, metalness: 1, roughness: 0.3 })
const feltMat = new THREE.MeshStandardMaterial({ color: 0x8e1f2f, roughness: 1 })
const whiteMat = new THREE.MeshPhysicalMaterial({
  color: 0xf6f3ea, roughness: 0.35, clearcoat: 0.5, clearcoatRoughness: 0.3,
})
const blackMat = new THREE.MeshPhysicalMaterial({
  color: 0x141414, roughness: 0.4, clearcoat: 0.5, clearcoatRoughness: 0.25,
})
caseMat.name = 'case'
innerMat.name = 'inner'
woodMat.name = 'soundboard'
goldMat.name = 'frame'
brassMat.name = 'brass'
steelMat.name = 'steel'
copperMat.name = 'copper'
feltMat.name = 'felt'
whiteMat.name = 'ivory'
blackMat.name = 'ebony'

const world = new THREE.Group()
world.name = 'world'

// the stage floor: glTF worlds replace the default ground plane AND its
// collider, so the world must bring its own
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(30, 30),
  new THREE.MeshStandardMaterial({ color: 0x2a3140, roughness: 1, name: 'stage' }))
floor.name = 'floor'
floor.rotation.x = -Math.PI / 2
world.add(floor)

const piano = new THREE.Group()
piano.name = 'piano'
world.add(piano)

const add = (name, geo, mat) => {
  const mesh = new THREE.Mesh(geo, mat)
  mesh.name = name
  piano.add(mesh)
  return mesh
}

// case: rim walls (outer plan minus inner), bottom board, soundboard
const rimShape = planShape(0)
rimShape.holes.push(planShape(0.055))
add('rim', extrudePlan(rimShape, RIM_TOP - BODY_BOT - 0.016, 0.008).translate(0, BODY_BOT + 0.008, 0), caseMat)
add('bottom', extrudePlan(planShape(0.01), 0.024, 0).translate(0, BODY_BOT, 0), innerMat)
add('soundboard', extrudePlan(planShape(0.06), 0.012, 0).translate(0, 0.78, 0), woodMat)

// the strung frame: gold pin-block bar and struts over the fans
add('pinblock', box(1.24, 0.02, 0.15, 0, 0.805, -0.135), goldMat)
add('struts', mergeGeometries([
  [0.5, -0.28, 0.05, -1.05], [0.18, -0.28, -0.18, -1.55], [-0.15, -0.28, -0.42, -1.35],
].map(([x0, z0, x1, z1]) => bar(0.03, 0.02, x0, z0, x1, z1, 0.845))), goldMat)
// strings: steel fan shortening toward the treble, copper bass fan
// crossing over it toward the tail
const steel = []
for (let i = 0; i < 26; i++) {
  const t = i / 25
  steel.push(bar(0.0035, 0.0035, 0.58 - 0.7 * t, -0.22, 0.45 - 0.73 * t, -0.55 - 1.17 * t, 0.815))
}
add('strings_steel', mergeGeometries(steel), steelMat)
const copper = []
for (let i = 0; i < 10; i++) {
  const t = i / 9
  copper.push(bar(0.005, 0.005, -0.55 + 0.33 * t, -0.22, 0.12 - 0.27 * t, -1.72 + 0.24 * t, 0.832))
}
add('strings_copper', mergeGeometries(copper), copperMat)

// keyboard shelf: keybed, case cheeks, end blocks, keyslip, nameboard
// (with a gold maker's pinstripe), the fallboard's top pushed back flush
// over the key backs, and the red felt strip
add('keybed', box(1.31, 0.05, 0.36, 0, 0.685, 0.18), caseMat)
add('cheek_bass', box(0.075, 0.18, 0.36, -0.6925, 0.71, 0.18), caseMat)
add('cheek_treble', box(0.075, 0.18, 0.36, 0.6925, 0.71, 0.18), caseMat)
add('block_bass', box(0.045, 0.05, 0.29, -0.6355, 0.735, 0.195), caseMat)
add('block_treble', box(0.045, 0.05, 0.29, 0.6355, 0.735, 0.195), caseMat)
add('keyslip', box(1.31, 0.045, 0.018, 0, 0.7165, 0.353), caseMat)
add('nameboard', box(1.31, 0.07, 0.02, 0, 0.79, 0.135), caseMat)
add('fallboard_top', box(1.31, 0.016, 0.145, 0, 0.817, 0.0725), caseMat)
add('pinstripe', box(0.3, 0.014, 0.004, 0, 0.795, 0.147), goldMat)
add('felt', box(1.28, 0.007, 0.014, 0, 0.7465, 0.132), feltMat)

// lid, hinged along the spine and propped on its stick
const lidGeo = extrudePlan(planShape(-0.015), 0.03, 0.006)
lidGeo.translate(PLAN_W, 0, 0)
lidGeo.rotateZ(LID_ANGLE)
lidGeo.translate(-PLAN_W, RIM_TOP + 0.005, 0)
add('lid', lidGeo, caseMat)
add('hinges', mergeGeometries(
  [-0.35, -0.9, -1.4].map(z => box(0.024, 0.014, 0.1, -0.72, RIM_TOP + 0.004, z))), brassMat)
// stick: from the treble rim up to the lid's underside
const sx = 0.62 // where it meets the lid, in lid-local x from the hinge
const top = new THREE.Vector3(
  -PLAN_W + Math.cos(LID_ANGLE) * (sx + PLAN_W), RIM_TOP + Math.sin(LID_ANGLE) * (sx + PLAN_W), -0.68)
const base = new THREE.Vector3(0.52, RIM_TOP, -0.68)
const stick = add('lidstick', new THREE.CylinderGeometry(0.012, 0.012, top.distanceTo(base), 8), caseMat)
stick.position.copy(base).add(top).multiplyScalar(0.5)
stick.rotation.z = Math.atan2(base.x - top.x, top.y - base.y)

// legs (square-tapered, brass casters) and the pedal lyre
for (const [i, [x, z]] of [[-0.63, 0.12], [0.63, 0.12], [-0.18, -1.6]].entries()) {
  const leg = new THREE.CylinderGeometry(0.062, 0.045, 0.515, 4, 1)
  leg.rotateY(Math.PI / 4)
  leg.translate(x, 0.3125, z)
  add(`leg_${i}`, mergeGeometries([leg, box(0.125, 0.05, 0.125, x, 0.595, z)]), caseMat)
  const caster = new THREE.CylinderGeometry(0.03, 0.03, 0.055, 10)
  caster.translate(x, 0.0275, z)
  add(`caster_${i}`, caster, brassMat)
}
add('lyre', mergeGeometries([
  box(0.04, 0.45, 0.055, -0.085, 0.395, -0.28),
  box(0.04, 0.45, 0.055, 0.085, 0.395, -0.28),
  box(0.26, 0.055, 0.09, 0, 0.155, -0.28),
]), caseMat)
add('pedals', mergeGeometries(
  [-0.055, 0, 0.055].map(x => box(0.02, 0.012, 0.095, x, 0.188, -0.215))), brassMat)

// -- the 88 keys: one named node each, origin ON the balance rail so
// node.rotation.x is the press. White keys are a full-width front merged
// with a back stick narrowed away from the neighbouring blacks;
// geometries are shared per cutout pattern. --
const whiteGeos = new Map()
const whiteGeo = (left, right) => {
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
  }
  return g
}
// stepped black key: a base in the white gap and a narrower crown
const blackGeo = mergeGeometries([
  box(0.011, 0.012, BLACK_FRONT - BLACK_BACK, 0, -0.009, (BLACK_BACK + BLACK_FRONT) / 2 - PIVOT_Z),
  box(0.0095, 0.0125, 0.09, 0, 0.00325, 0.19 - PIVOT_Z),
])

let white = 0
for (let note = FIRST_NOTE; note <= LAST_NOTE; note++) {
  let mesh
  let dip
  if (isBlack(note)) {
    // between its neighbouring whites: `white` already counts the left one
    const x = -KEY_SPAN / 2 + white * WHITE_PITCH + BLACK_OFF[note % 12]
    mesh = new THREE.Mesh(blackGeo, blackMat)
    mesh.position.set(x, WHITE_TOP + 0.004, PIVOT_Z)
    dip = 0.075
  } else {
    const x = -KEY_SPAN / 2 + (white + 0.5) * WHITE_PITCH
    const left = note > FIRST_NOTE && isBlack(note - 1)
    const right = note < LAST_NOTE && isBlack(note + 1)
    mesh = new THREE.Mesh(whiteGeo(left, right), whiteMat)
    mesh.position.set(x, WHITE_TOP - 0.0115, PIVOT_Z)
    dip = 0.052
    white++
  }
  mesh.name = `key_${note}`
  // rigging metadata -> glTF extras, so scripts need not hardcode it
  mesh.userData = { note, black: isBlack(note), dip }
  piano.add(mesh)
}

const exporter = new GLTFExporter()
exporter.parse(world, result => {
  const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'piano.glb')
  writeFileSync(out, Buffer.from(result))
  // self-check: parse the GLB's JSON chunk and count the rig
  const view = new DataView(result)
  const jsonLen = view.getUint32(12, true)
  const json = JSON.parse(Buffer.from(result, 20, jsonLen).toString('utf8'))
  const keys = json.nodes.filter(n => /^key_\d+$/.test(n.name ?? ''))
  console.log(`wrote ${out}`)
  console.log(`  ${(result.byteLength / 1024).toFixed(0)} kB, ${json.nodes.length} nodes, `
    + `${keys.length} keys (${keys[0]?.name}..${keys[keys.length - 1]?.name}), `
    + `${json.meshes.length} meshes, ${json.materials.length} materials`)
  if (keys.length !== 88) { console.error('FAIL: expected 88 key nodes'); process.exit(1) }
  if (!keys.every(k => typeof k.extras?.note === 'number' && typeof k.extras?.dip === 'number')) {
    console.error('FAIL: key extras missing rigging metadata'); process.exit(1)
  }
}, err => { console.error(err); process.exit(1) }, { binary: true })

// Build public/avatar-default.glb: the DEFAULT AVATAR - a silver Mixamo
// Y-bot carrying the full thirdroom locomotion clip set (Idle, Walk,
// Run, WalkBack, RunBack, StrafeLeft/Right + Run variants, TurnLeft/
// Right, Fall1-3). Nothing else in the app is Y-bot specific: any GLB
// whose skin rides the standard 67-joint mixamorig skeleton can replace
// it, and clips are always resolved by NAME (an avatar lacking clips
// borrows this file's, bound by bone name).
//
// Sources are thirdroom's public assets, read from the sibling checkout
// (../thirdroom): mixamo-y.glb (Alpha = Y-bot skinned mesh; only TPose
// + Walk clips, which we drop) + full-animation-rig.glb (Beta = X-bot
// mesh, all clips, SAME skeleton). The noanim Y-bot variant is useless
// here: it carries no skin. We merge at the GLB JSON/BIN level: copy
// each clip's sampler accessor bytes into the Y-bot's buffer, remap
// every channel's target node by bone name, then compact away accessor
// data the dropped clips stranded. Mesh, skin, hierarchy are untouched.
//
// Run: node tools/avatar-glb.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const TR = join(here, '..', '..', 'thirdroom', 'public', 'gltf')
const OUT = join(here, '..', 'public', 'avatar-default.glb')

// -- silver: lit-workshop values (worldsync has direct lights, no env
// map, so full metal 1.0 would go near-black; keep some diffuse). --
const SILVER = {
  body: { baseColorFactor: [0.62, 0.64, 0.68, 1], metallicFactor: 0.85, roughnessFactor: 0.32 },
  joints: { baseColorFactor: [0.25, 0.26, 0.29, 1], metallicFactor: 0.9, roughnessFactor: 0.45 },
}

function readGlb(path) {
  const buf = readFileSync(path)
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`${path}: not a GLB`)
  const jsonLen = buf.readUInt32LE(12)
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'))
  let bin = Buffer.alloc(0)
  const off = 20 + jsonLen
  if (off < buf.length) {
    const binLen = buf.readUInt32LE(off)
    if (buf.readUInt32LE(off + 4) !== 0x004e4942) throw new Error(`${path}: second chunk not BIN`)
    bin = buf.subarray(off + 8, off + 8 + binLen)
  }
  return { json, bin }
}

function writeGlb(path, json, bin) {
  let jsonBuf = Buffer.from(JSON.stringify(json), 'utf8')
  if (jsonBuf.length % 4) jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(4 - (jsonBuf.length % 4), 0x20)])
  let binBuf = bin
  if (binBuf.length % 4) binBuf = Buffer.concat([binBuf, Buffer.alloc(4 - (binBuf.length % 4))])
  const total = 12 + 8 + jsonBuf.length + 8 + binBuf.length
  const head = Buffer.alloc(12 + 8)
  head.writeUInt32LE(0x46546c67, 0)
  head.writeUInt32LE(2, 4)
  head.writeUInt32LE(total, 8)
  head.writeUInt32LE(jsonBuf.length, 12)
  head.writeUInt32LE(0x4e4f534a, 16)
  const binHead = Buffer.alloc(8)
  binHead.writeUInt32LE(binBuf.length, 0)
  binHead.writeUInt32LE(0x004e4942, 4)
  writeFileSync(path, Buffer.concat([head, jsonBuf, binHead, binBuf]))
}

const COMP_SIZE = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }
const TYPE_COMPS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }

const base = readGlb(join(TR, 'mixamo-y.glb'))
const rig = readGlb(join(TR, 'full-animation-rig.glb'))
if (!base.json.skins?.length) throw new Error('base avatar has no skin')

// node-name -> index in the base file (animation channels retarget here)
const baseByName = new Map(base.json.nodes.map((n, i) => [n.name, i]))

const segments = [base.bin]
let binLen = base.bin.length
if (binLen % 4) { segments.push(Buffer.alloc(4 - (binLen % 4))); binLen += 4 - (binLen % 4) }

// copy one rig accessor's bytes into the merged buffer; returns the new
// accessor index in the base json. Animation sampler data is tightly
// packed (no byteStride) in Blender exports; assert rather than assume.
const copied = new Map()
function copyAccessor(idx) {
  if (copied.has(idx)) return copied.get(idx)
  const acc = rig.json.accessors[idx]
  const bv = rig.json.bufferViews[acc.bufferView]
  if (bv.byteStride) throw new Error(`accessor ${idx}: unexpected byteStride`)
  if (acc.sparse) throw new Error(`accessor ${idx}: unexpected sparse accessor`)
  const byteLen = acc.count * COMP_SIZE[acc.componentType] * TYPE_COMPS[acc.type]
  const start = (bv.byteOffset || 0) + (acc.byteOffset || 0)
  const bytes = rig.bin.subarray(start, start + byteLen)
  const bvIdx = base.json.bufferViews.length
  base.json.bufferViews.push({ buffer: 0, byteOffset: binLen, byteLength: byteLen })
  segments.push(bytes)
  binLen += byteLen
  if (binLen % 4) { segments.push(Buffer.alloc(4 - (binLen % 4))); binLen += 4 - (binLen % 4) }
  const newIdx = base.json.accessors.length
  base.json.accessors.push({
    bufferView: bvIdx, componentType: acc.componentType, count: acc.count,
    type: acc.type, ...(acc.min && { min: acc.min }), ...(acc.max && { max: acc.max }),
  })
  copied.set(idx, newIdx)
  return newIdx
}

base.json.animations = []
let dropped = 0
for (const anim of rig.json.animations || []) {
  const samplers = anim.samplers.map(s => ({
    input: copyAccessor(s.input), output: copyAccessor(s.output),
    ...(s.interpolation && { interpolation: s.interpolation }),
  }))
  const channels = []
  for (const ch of anim.channels) {
    const name = rig.json.nodes[ch.target.node]?.name
    const target = baseByName.get(name)
    if (target === undefined) { dropped++; continue }
    channels.push({ sampler: ch.sampler, target: { node: target, path: ch.target.path } })
  }
  base.json.animations.push({ name: anim.name, samplers, channels })
}

for (const mat of base.json.materials || []) {
  const silver = /joint/i.test(mat.name || '') ? SILVER.joints : SILVER.body
  mat.pbrMetallicRoughness = { ...mat.pbrMetallicRoughness, ...silver }
}

base.json.buffers = [{ byteLength: binLen }]
base.json.asset.copyright = 'Y Bot character and animations: Adobe Mixamo (via thirdroom)'
base.json.asset.generator = 'worldsync tools/avatar-glb.mjs'

// -- compact: dropping TPose/Walk stranded ~0.8MB of sampler data in the
// base buffer. Keep only accessors reachable from meshes, skins and the
// merged animations, then only the bufferViews they use, and rebuild the
// buffer from those views' byte ranges. --
function compact(json, bin) {
  const usedAcc = new Set()
  for (const mesh of json.meshes || [])
    for (const p of mesh.primitives) {
      for (const v of Object.values(p.attributes)) usedAcc.add(v)
      if (p.indices !== undefined) usedAcc.add(p.indices)
      for (const t of p.targets || []) for (const v of Object.values(t)) usedAcc.add(v)
    }
  for (const skin of json.skins || [])
    if (skin.inverseBindMatrices !== undefined) usedAcc.add(skin.inverseBindMatrices)
  for (const anim of json.animations || [])
    for (const s of anim.samplers) { usedAcc.add(s.input); usedAcc.add(s.output) }

  const accMap = new Map(), newAccessors = []
  const bvMap = new Map(), newViews = []
  const parts = []
  let off = 0
  const remapView = (idx) => {
    if (bvMap.has(idx)) return bvMap.get(idx)
    const bv = json.bufferViews[idx]
    const bytes = bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength)
    const nv = { ...bv, byteOffset: off }
    parts.push(bytes)
    off += bv.byteLength
    if (off % 4) { parts.push(Buffer.alloc(4 - (off % 4))); off += 4 - (off % 4) }
    bvMap.set(idx, newViews.length)
    newViews.push(nv)
    return bvMap.get(idx)
  }
  json.accessors.forEach((acc, i) => {
    if (!usedAcc.has(i)) return
    accMap.set(i, newAccessors.length)
    newAccessors.push(acc.bufferView === undefined ? acc : { ...acc, bufferView: remapView(acc.bufferView) })
  })
  const r = (i) => accMap.get(i)
  for (const mesh of json.meshes || [])
    for (const p of mesh.primitives) {
      for (const k of Object.keys(p.attributes)) p.attributes[k] = r(p.attributes[k])
      if (p.indices !== undefined) p.indices = r(p.indices)
      for (const t of p.targets || []) for (const k of Object.keys(t)) t[k] = r(t[k])
    }
  for (const skin of json.skins || [])
    if (skin.inverseBindMatrices !== undefined) skin.inverseBindMatrices = r(skin.inverseBindMatrices)
  for (const anim of json.animations || [])
    for (const s of anim.samplers) { s.input = r(s.input); s.output = r(s.output) }
  json.accessors = newAccessors
  json.bufferViews = newViews
  json.buffers = [{ byteLength: off }]
  return Buffer.concat(parts)
}

const outBin = compact(base.json, Buffer.concat(segments))
writeGlb(OUT, base.json, outBin)
const clipNames = base.json.animations.map(a => a.name).join(', ')
console.log(`wrote ${OUT}`)
console.log(`clips: ${clipNames}`)
console.log(`channels dropped (no matching bone): ${dropped}`)

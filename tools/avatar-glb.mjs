// Build public/avatar-default.glb: the DEFAULT AVATAR - a silver Mixamo
// bot carrying the full thirdroom locomotion clip set (Idle, Walk, Run,
// WalkBack, RunBack, StrafeLeft/Right + Run variants, TurnLeft/Right,
// Fall1-3). Nothing else in the app is bot-specific: any GLB whose skin
// rides the standard 67-joint mixamorig skeleton can replace it, and
// clips are always resolved by NAME (an avatar lacking clips borrows
// this file's, bound by bone name).
//
// Sources are thirdroom's public assets, read from the sibling checkout
// (../thirdroom). The DEFAULT build takes full-animation-rig.glb (Beta
// = X-bot mesh + all 14 clips, the exact rig thirdroom's players use)
// whole: retint silver, compact, done - known-good skinning.
//
// --ybot is the EXPERIMENTAL path: merge the Y-bot mesh (mixamo-y.glb)
// with the X-bot rig's clips at the GLB JSON/BIN level. It retargets by
// bone name with rotation-only channels, harvested bind translations
// and a scaled hips track - and it is still visibly wrong: the two
// skeletons' rest ORIENTATIONS differ (legs fold upward), so a proper
// Y-bot needs its clips re-exported on its own skeleton (Mixamo/Blender)
// rather than more in-tool retargeting. Kept for that future attempt.
//
// Run: node tools/avatar-glb.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const TR = join(here, '..', '..', 'thirdroom', 'public', 'gltf')
const OUT = join(here, '..', 'public', 'avatar-default.glb')

// -- silver: brushed rather than mirror. worldsync has direct lights and
// NO environment map, so high metalness reads near-black (metals take
// almost nothing from diffuse light); low-metal bright grey is what
// actually looks silver in this renderer. --
const SILVER = {
  body: { baseColorFactor: [0.78, 0.8, 0.84, 1], metallicFactor: 0.35, roughnessFactor: 0.42 },
  joints: { baseColorFactor: [0.38, 0.4, 0.45, 1], metallicFactor: 0.5, roughnessFactor: 0.5 },
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

const xbot = !process.argv.includes('--ybot')
const base = readGlb(join(TR, xbot ? 'full-animation-rig.glb' : 'mixamo-y.glb'))
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

// Retarget rules, learned the hard way (the first merge walked as a
// cloud of limbs, the second as a collapsed jumble):
// 1. Between two same-named mixamorig skeletons only ROTATIONS transfer:
//    translation tracks encode the source character's bone lengths.
// 2. These GLBs' node.translation rest values are NOT the bind pose (the
//    skeleton's true shape lives in the animation translation tracks),
//    so the base's bone translations are harvested from its OWN Walk
//    clip's first frames and baked into the nodes before its clips drop.
// 3. mixamorig:Hips translation is the exception (gait bob + root
//    motion): the rig's track rides along, scaled by the ratio of the
//    two Walks' mean hips-translation magnitudes.
const accFloats = (glb, idx) => {
  const acc = glb.json.accessors[idx]
  const bv = glb.json.bufferViews[acc.bufferView]
  const start = (bv.byteOffset || 0) + (acc.byteOffset || 0)
  const n = acc.count * TYPE_COMPS[acc.type]
  return new Float32Array(glb.bin.buffer.slice(glb.bin.byteOffset + start, glb.bin.byteOffset + start + n * 4))
}
const isHipsNode = (glb, i) => /mixamorig:?Hips$/.test(glb.json.nodes[i]?.name ?? '')
const walkHipsMean = (glb) => {
  const walk = (glb.json.animations ?? []).find(a => a.name === 'Walk')
  if (!walk) return null
  for (const ch of walk.channels) {
    if (ch.target.path !== 'translation' || !isHipsNode(glb, ch.target.node)) continue
    const f = accFloats(glb, walk.samplers[ch.sampler].output)
    let sum = 0
    for (let i = 0; i < f.length; i += 3) sum += Math.hypot(f[i], f[i + 1], f[i + 2])
    return sum / (f.length / 3)
  }
  return null
}
let hipScale = 1
if (!xbot) {
  const bm = walkHipsMean(base), rm = walkHipsMean(rig)
  if (bm && rm) hipScale = bm / rm
  const baseWalk = (base.json.animations ?? []).find(a => a.name === 'Walk')
  if (!baseWalk) throw new Error('base avatar has no Walk clip to harvest bind translations from')
  for (const ch of baseWalk.channels) {
    if (ch.target.path !== 'translation') continue
    const f = accFloats(base, baseWalk.samplers[ch.sampler].output)
    base.json.nodes[ch.target.node].translation = [f[0], f[1], f[2]]
  }
}

/** copy a sampler-output accessor scaled by k (float VEC3 only) */
function copyScaledAccessor(idx, k) {
  const acc = rig.json.accessors[idx]
  const bv = rig.json.bufferViews[acc.bufferView]
  if (acc.componentType !== 5126 || acc.type !== 'VEC3') throw new Error(`accessor ${idx}: not float VEC3`)
  const start = (bv.byteOffset || 0) + (acc.byteOffset || 0)
  const floats = new Float32Array(rig.bin.buffer.slice(rig.bin.byteOffset + start,
    rig.bin.byteOffset + start + acc.count * 12))
  for (let i = 0; i < floats.length; i++) floats[i] *= k
  const bytes = Buffer.from(floats.buffer)
  const bvIdx = base.json.bufferViews.length
  base.json.bufferViews.push({ buffer: 0, byteOffset: binLen, byteLength: bytes.length })
  segments.push(bytes)
  binLen += bytes.length
  const newIdx = base.json.accessors.length
  const mm = (arr) => arr.map(v => v * k)
  base.json.accessors.push({
    bufferView: bvIdx, componentType: 5126, count: acc.count, type: 'VEC3',
    ...(acc.min && { min: k >= 0 ? mm(acc.min) : mm(acc.max) }),
    ...(acc.max && { max: k >= 0 ? mm(acc.max) : mm(acc.min) }),
  })
  return newIdx
}

base.json.animations = []
let dropped = 0
for (const anim of rig.json.animations || []) {
  const samplers = []
  const channels = []
  for (const ch of anim.channels) {
    const name = rig.json.nodes[ch.target.node]?.name
    const target = baseByName.get(name)
    if (target === undefined) { dropped++; continue }
    const isHips = /mixamorig:?Hips$/.test(name ?? '')
    // --xbot keeps its own tracks whole: same skeleton, nothing to retarget
    if (!xbot && ch.target.path === 'scale') continue
    if (!xbot && ch.target.path === 'translation' && !isHips) continue
    const s = anim.samplers[ch.sampler]
    const output = ch.target.path === 'translation' && hipScale !== 1
      ? copyScaledAccessor(s.output, hipScale)
      : copyAccessor(s.output)
    samplers.push({
      input: copyAccessor(s.input), output,
      ...(s.interpolation && { interpolation: s.interpolation }),
    })
    channels.push({ sampler: samplers.length - 1, target: { node: target, path: ch.target.path } })
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

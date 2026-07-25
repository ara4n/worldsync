import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import type { SceneGeometry } from './sim'

// -- KHR_audio (thirdroom's flavour of the draft): the world scene can
// carry its own sound. Extracted here at parse time into plain data the
// audio engine consumes: encoded sample bytes per source (note metadata
// in the source's glTF extras marks an instrument sample), grouped
// under emitters that are either positional (anchored to a scene node,
// panned as the camera moves) or global. --
export interface SceneAudioSource {
  name: string
  /** MIDI note this sample records, from the source's extras; null for
   * plain non-instrument sources (ambience, one-shots) */
  note: number | null
  gain: number
  /** encoded audio bytes (mp3/wav per the glb); decoded lazily by the
   * engine, so parsing a scene never touches WebAudio */
  bytes: ArrayBuffer
}
export interface SceneAudioEmitter {
  name: string
  gain: number
  /** the scene node the emitter rides (positional) or null (global) */
  node: THREE.Object3D | null
  positional: {
    distanceModel: DistanceModelType
    refDistance: number
    maxDistance: number
    rolloffFactor: number
    coneInnerAngle: number
    coneOuterAngle: number
    coneOuterGain: number
  } | null
  sources: SceneAudioSource[]
}
export interface SceneAudio { emitters: SceneAudioEmitter[] }

/** A parsed GLB: the renderable graph plus every mesh baked (world-
 * transformed) into one triangle soup for the fixed trimesh collider,
 * plus any KHR_audio sound the world carries. */
export interface ParsedScene { object: THREE.Group; geometry: SceneGeometry; audio: SceneAudio | null }

// Keyed by mxc URL. Parse results are immutable; the same URL always maps
// to the same bytes (Matrix media is content-addressed in practice).
const cache = new Map<string, ParsedScene>()
export const cachedScene = (url: string) => cache.get(url) ?? null
export const cacheScene = (url: string, s: ParsedScene) => { cache.set(url, s) }

let loader: GLTFLoader | null = null

/**
 * Wire the decoders real-world GLBs need: KTX2/Basis textures (needs the
 * renderer to pick a target GPU format), Draco and meshopt geometry
 * compression. Decoder binaries are served from /basis and /draco, copied
 * out of three's examples tree into public/ (pinned alongside the three
 * version in package.json). Call once at startup, before any parseGlb;
 * without it, only uncompressed GLBs parse. Geometry decoders matter for
 * determinism too: every peer runs the same wasm on the same bytes, so
 * decoded POSITION streams (and thus colliders) stay bit-identical.
 */
export function configureGlbLoader(renderer: THREE.WebGLRenderer) {
  if (loader) return
  const ktx2 = new KTX2Loader().setTranscoderPath(`${import.meta.env.BASE_URL}basis/`).detectSupport(renderer)
  const draco = new DRACOLoader().setDecoderPath(`${import.meta.env.BASE_URL}draco/`)
  loader = new GLTFLoader()
    .setKTX2Loader(ktx2)
    .setDRACOLoader(draco)
    .setMeshoptDecoder(MeshoptDecoder)
}

/**
 * Parse glTF JSON (embedded data-URI buffers only) into a renderable
 * graph: script-instantiated cosmetics (world.loadGltf), so no collider
 * bake - scripts draw with these, they do not build physics.
 */
export async function parseGltfJson(json: string): Promise<THREE.Group> {
  const gltf = await (loader ?? new GLTFLoader()).parseAsync(json, '')
  return gltf.scene
}

// GLTFLoader ignores unknown root extensions but keeps the raw JSON on
// its parser, so KHR_audio is read straight from there: audio bytes via
// bufferView dependencies, emitter anchors via node dependencies (the
// loader may rename nodes to dedupe, so index lookup beats names).
type GltfParser = {
  json: {
    extensions?: Record<string, unknown>
    nodes?: { extensions?: Record<string, unknown> }[]
    scenes?: { extensions?: Record<string, unknown> }[]
    scene?: number
  }
  getDependency(type: 'bufferView' | 'node', index: number): Promise<unknown>
}
interface KhrAudioDef {
  audio?: { bufferView?: number; mimeType?: string; name?: string }[]
  sources?: { audio?: number; gain?: number; name?: string; extras?: { note?: unknown } }[]
  emitters?: {
    name?: string; type?: string; gain?: number; sources?: number[]
    positional?: {
      distanceModel?: string; refDistance?: number; maxDistance?: number; rolloffFactor?: number
      coneInnerAngle?: number; coneOuterAngle?: number; coneOuterGain?: number
    }
  }[]
}

async function extractAudio(parser: GltfParser): Promise<SceneAudio | null> {
  const root = parser.json.extensions?.KHR_audio as KhrAudioDef | undefined
  if (!root?.audio?.length || !root.sources?.length || !root.emitters?.length) return null
  const bytes = await Promise.all(root.audio.map(a =>
    a.bufferView === undefined
      ? Promise.resolve(null)
      : (parser.getDependency('bufferView', a.bufferView) as Promise<ArrayBuffer>)))
  const sources = root.sources.map((s, i): SceneAudioSource | null => {
    const b = s.audio === undefined ? null : bytes[s.audio]
    if (!b) return null
    const note = s.extras && typeof s.extras.note === 'number' ? s.extras.note : null
    return { name: s.name ?? `source_${i}`, note, gain: s.gain ?? 1, bytes: b }
  })
  const emitterFor = async (index: number, node: THREE.Object3D | null): Promise<SceneAudioEmitter | null> => {
    const def = root.emitters?.[index]
    if (!def) return null
    const p = def.type === 'positional' ? def.positional ?? {} : null
    return {
      name: def.name ?? `emitter_${index}`,
      gain: def.gain ?? 1,
      node: def.type === 'positional' ? node : null,
      positional: p && {
        distanceModel: (p.distanceModel ?? 'inverse') as DistanceModelType,
        refDistance: p.refDistance ?? 1,
        maxDistance: p.maxDistance ?? 10000,
        rolloffFactor: p.rolloffFactor ?? 1,
        coneInnerAngle: p.coneInnerAngle ?? 2 * Math.PI,
        coneOuterAngle: p.coneOuterAngle ?? 2 * Math.PI,
        coneOuterGain: p.coneOuterGain ?? 0,
      },
      sources: (def.sources ?? []).map(i => sources[i]).filter((s): s is SceneAudioSource => !!s),
    }
  }
  const emitters: SceneAudioEmitter[] = []
  for (const [i, n] of (parser.json.nodes ?? []).entries()) {
    const att = n.extensions?.KHR_audio as { emitter?: number } | undefined
    if (att?.emitter === undefined) continue
    const obj = await (parser.getDependency('node', i) as Promise<THREE.Object3D>)
    const e = await emitterFor(att.emitter, obj)
    if (e) emitters.push(e)
  }
  const sceneDef = parser.json.scenes?.[parser.json.scene ?? 0]
  const att = sceneDef?.extensions?.KHR_audio as { emitters?: number[] } | undefined
  for (const idx of att?.emitters ?? []) {
    const e = await emitterFor(idx, null)
    if (e) emitters.push(e)
  }
  return emitters.length ? { emitters } : null
}

/**
 * Parse GLB bytes into visuals + collider geometry. The bake is
 * deterministic: same bytes -> same scene graph -> same traversal order,
 * and the f64 matrix transforms round to f32 identically on every peer, so
 * Rapier receives bit-identical trimesh input everywhere.
 */
export async function parseGlb(bytes: ArrayBuffer): Promise<ParsedScene> {
  const gltf = await (loader ?? new GLTFLoader()).parseAsync(bytes, '')
  const object = gltf.scene
  object.updateWorldMatrix(true, true)
  const vparts: Float32Array[] = []
  const iparts: Uint32Array[] = []
  let base = 0
  const v = new THREE.Vector3()
  const bake = (geo: THREE.BufferGeometry, matrix: THREE.Matrix4) => {
    const pos = geo.getAttribute('position')
    if (!pos) return
    const out = new Float32Array(pos.count * 3)
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(matrix)
      out[i * 3] = v.x; out[i * 3 + 1] = v.y; out[i * 3 + 2] = v.z
    }
    vparts.push(out)
    const idx = geo.getIndex()
    const ia = new Uint32Array(idx ? idx.count : pos.count)
    if (idx) for (let i = 0; i < ia.length; i++) ia[i] = idx.getX(i) + base
    else for (let i = 0; i < ia.length; i++) ia[i] = i + base
    iparts.push(ia)
    base += pos.count
  }
  const m = new THREE.Matrix4()
  object.traverse(node => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh) return
    // EXT_mesh_gpu_instancing: the renderer places copies via the instance
    // matrix buffer, so the bake must too - one collider copy per instance
    // at matrixWorld * instanceMatrix, or the physics ends up with a single
    // phantom copy parked at the node's origin (invisible walls).
    const inst = mesh as THREE.InstancedMesh
    if (inst.isInstancedMesh) {
      for (let k = 0; k < inst.count; k++) {
        inst.getMatrixAt(k, m)
        bake(mesh.geometry, new THREE.Matrix4().multiplyMatrices(mesh.matrixWorld, m))
      }
    } else {
      bake(mesh.geometry, mesh.matrixWorld)
    }
  })
  const vertices = new Float32Array(vparts.reduce((n, p) => n + p.length, 0))
  const indices = new Uint32Array(iparts.reduce((n, p) => n + p.length, 0))
  let vo = 0; for (const p of vparts) { vertices.set(p, vo); vo += p.length }
  let io = 0; for (const p of iparts) { indices.set(p, io); io += p.length }
  const audio = await extractAudio(gltf.parser as unknown as GltfParser)
  return { object, geometry: { vertices, indices }, audio }
}

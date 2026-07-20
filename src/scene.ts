import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import type { SceneGeometry } from './sim'

/** A parsed GLB: the renderable graph plus every mesh baked (world-
 * transformed) into one triangle soup for the fixed trimesh collider. */
export interface ParsedScene { object: THREE.Group; geometry: SceneGeometry }

// Keyed by mxc URL. Parse results are immutable; the same URL always maps
// to the same bytes (Matrix media is content-addressed in practice).
const cache = new Map<string, ParsedScene>()
export const cachedScene = (url: string) => cache.get(url) ?? null
export const cacheScene = (url: string, s: ParsedScene) => { cache.set(url, s) }

/**
 * Parse GLB bytes into visuals + collider geometry. The bake is
 * deterministic: same bytes -> same scene graph -> same traversal order,
 * and the f64 matrix transforms round to f32 identically on every peer, so
 * Rapier receives bit-identical trimesh input everywhere.
 */
export async function parseGlb(bytes: ArrayBuffer): Promise<ParsedScene> {
  const gltf = await new GLTFLoader().parseAsync(bytes, '')
  const object = gltf.scene
  object.updateWorldMatrix(true, true)
  const vparts: Float32Array[] = []
  const iparts: Uint32Array[] = []
  let base = 0
  const v = new THREE.Vector3()
  object.traverse(node => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh) return
    const pos = mesh.geometry.getAttribute('position')
    if (!pos) return
    const out = new Float32Array(pos.count * 3)
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld)
      out[i * 3] = v.x; out[i * 3 + 1] = v.y; out[i * 3 + 2] = v.z
    }
    vparts.push(out)
    const idx = mesh.geometry.getIndex()
    const ia = new Uint32Array(idx ? idx.count : pos.count)
    if (idx) for (let i = 0; i < ia.length; i++) ia[i] = idx.getX(i) + base
    else for (let i = 0; i < ia.length; i++) ia[i] = i + base
    iparts.push(ia)
    base += pos.count
  })
  const vertices = new Float32Array(vparts.reduce((n, p) => n + p.length, 0))
  const indices = new Uint32Array(iparts.reduce((n, p) => n + p.length, 0))
  let vo = 0; for (const p of vparts) { vertices.set(p, vo); vo += p.length }
  let io = 0; for (const p of iparts) { indices.set(p, io); io += p.length }
  return { object, geometry: { vertices, indices } }
}

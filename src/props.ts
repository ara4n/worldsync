import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import type { Prop } from './sim'

/**
 * Renders the sim's prop table (kinematic, physics-free entities). The sim
 * stores only logical poses; everything lively here is client-side cosmetic,
 * reproducing the dots-3d feel for ANY prop:
 * - spawns fade in,
 * - despawns pop (swell then shrink),
 * - discrete 'move' ops animate as a bouncing drop when they are vertical
 *   falls and a short ease otherwise,
 * - claimed props swell slightly (the claimer's chain line, drawn by the
 *   overlay in their color, is the primary claim signal).
 */

interface Anim { t0: number; frames: { until: number; y0: number; y1: number; easeIn: boolean }[]; x: number; z: number; x0: number; z0: number }
interface Dying { mesh: THREE.Mesh; t0: number; alpha: number }

// Low-poly chess piece kinds: lathe-turned from hand-authored [radius,
// height] profiles in piece-local units (total height 1, base resting at
// y=0, so the prop position is where the piece stands) and scaled by the
// prop's size, which is therefore the piece's world height. Coarse radial
// segments plus flat shading give the faceted look; the knight and the
// king's cross add merged boxes to the turning.
const LATHE_SEGS = 10
const lathe = (pts: [number, number][]) =>
  new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), LATHE_SEGS)
const block = (w: number, h: number, d: number, x: number, y: number, z: number, tiltX = 0) => {
  const g = new THREE.BoxGeometry(w, h, d)
  if (tiltX) g.rotateX(tiltX)
  g.translate(x, y, z)
  return g
}
const PIECE_GEOS: Record<string, () => THREE.BufferGeometry> = {
  pawn: () => lathe([[0, 0], [0.36, 0], [0.36, 0.1], [0.22, 0.22], [0.14, 0.42], [0.11, 0.56],
    [0.2, 0.62], [0.11, 0.68], [0.19, 0.8], [0.13, 0.94], [0, 1]]),
  rook: () => lathe([[0, 0], [0.34, 0], [0.34, 0.1], [0.22, 0.22], [0.18, 0.68], [0.28, 0.76],
    [0.28, 1], [0.2, 1], [0.2, 0.86], [0, 0.86]]),
  knight: () => mergeGeometries([
    lathe([[0, 0], [0.34, 0], [0.34, 0.1], [0.22, 0.22], [0.17, 0.34], [0, 0.34]]),
    block(0.24, 0.52, 0.26, 0, 0.55, -0.02, -0.35), // neck, leaning forward
    block(0.18, 0.2, 0.3, 0, 0.8, 0.16, -0.35), // muzzle
    block(0.1, 0.18, 0.12, 0, 0.9, -0.1, -0.2), // ears
  ]),
  bishop: () => lathe([[0, 0], [0.33, 0], [0.33, 0.09], [0.2, 0.2], [0.13, 0.45], [0.11, 0.58],
    [0.18, 0.64], [0.1, 0.68], [0.17, 0.78], [0.12, 0.9], [0.05, 0.95], [0, 1]]),
  queen: () => lathe([[0, 0], [0.3, 0], [0.3, 0.08], [0.19, 0.18], [0.12, 0.5], [0.1, 0.6],
    [0.17, 0.66], [0.1, 0.7], [0.24, 0.88], [0.15, 0.84], [0.08, 0.92], [0, 1]]),
  king: () => mergeGeometries([
    lathe([[0, 0], [0.3, 0], [0.3, 0.08], [0.19, 0.17], [0.12, 0.5], [0.1, 0.62], [0.18, 0.68],
      [0.1, 0.73], [0.2, 0.84], [0.13, 0.88], [0, 0.88]]),
    block(0.07, 0.16, 0.07, 0, 0.93, 0), // the cross
    block(0.18, 0.07, 0.07, 0, 0.94, 0),
  ]),
}

const FADE_MS = 200
const POP_SWELL_MS = 60
const POP_SHRINK_MS = 160
const EASE_MS = 200
// dots-3d's drop(): bounce fractions between start and rest height, each
// segment timed like sqrt(dh * 75000) ms
const BOUNCE = [0, 0.2, 0, 0.05, 0]

export class PropLayer {
  group = new THREE.Group()
  private meshes = new Map<string, THREE.Mesh>()
  private state = new Map<string, { pos: THREE.Vector3; color: number; claim: string | null; born: number
    swell: boolean; pop: boolean; alpha: number }>()
  private anims = new Map<string, Anim>()
  private dying: Dying[] = []
  private geos = new Map<string, THREE.BufferGeometry>()

  constructor(private patchMaterial: (m: THREE.Material) => void) {}

  private geoFor(kind: string, size: number): THREE.BufferGeometry {
    const key = `${kind}:${size}`
    let g = this.geos.get(key)
    if (!g) {
      g = kind === 'box'
        ? new THREE.BoxGeometry(size * 2, size * 2, size * 2)
        : PIECE_GEOS[kind]
          ? PIECE_GEOS[kind]().scale(size, size, size)
          : new THREE.SphereGeometry(size, 24, 16)
      this.geos.set(key, g)
    }
    return g
  }

  /** Reconcile against the sim's prop table; call once per frame. */
  sync(props: Map<string, Prop>, now: number) {
    for (const [id, p] of props) {
      // solid colliders are invisible: whatever they support (screens)
      // draws its own visuals, and no mesh also means no picking
      if (p.kind === 'collider') continue
      let mesh = this.meshes.get(id)
      if (!mesh) {
        const mat = p.unlit
          ? new THREE.MeshBasicMaterial({ color: p.color })
          : new THREE.MeshStandardMaterial({
            color: p.color, roughness: 0.5, metalness: 0.05, flatShading: p.kind in PIECE_GEOS,
          })
        this.patchMaterial(mat)
        // pop:false skips the spawn fade-in (and the death pop below):
        // snake segments read as one body, not per-cell twinkles. A prop
        // opacity < 1 is the fade target instead of 1 (ghost previews)
        const alpha = p.opacity ?? 1
        if (p.pop !== false) {
          mat.transparent = true
          mat.opacity = 0
        } else if (alpha < 1) {
          mat.transparent = true
          mat.opacity = alpha
        }
        mesh = new THREE.Mesh(this.geoFor(p.kind, p.size), mat)
        mesh.name = id // the prop's net id, for the inspector
        mesh.position.set(p.pos.x, p.pos.y, p.pos.z)
        if (!p.unlit) { mesh.castShadow = true; mesh.receiveShadow = true }
        mesh.userData.netId = id
        mesh.userData.size = p.size
        this.group.add(mesh)
        this.meshes.set(id, mesh)
        this.state.set(id, {
          pos: new THREE.Vector3(p.pos.x, p.pos.y, p.pos.z), color: p.color, claim: p.claim, born: now,
          // bounce:false marks board-game props: they also skip the claim
          // swell, which would weld adjacent cells (tetrix pieces) into a
          // seamless blob until unclaimed
          swell: p.bounce !== false,
          pop: p.pop !== false,
          alpha,
        })
        continue
      }
      const st = this.state.get(id)!
      if (st.color !== p.color) {
        st.color = p.color
        ;(mesh.material as THREE.MeshBasicMaterial).color.setHex(p.color)
      }
      st.claim = p.claim
      if (st.pos.x !== p.pos.x || st.pos.y !== p.pos.y || st.pos.z !== p.pos.z) {
        this.startMove(id, st.pos.clone(), new THREE.Vector3(p.pos.x, p.pos.y, p.pos.z), now, p.bounce !== false)
        st.pos.set(p.pos.x, p.pos.y, p.pos.z)
      }
    }
    for (const [id, mesh] of this.meshes) {
      if (props.has(id)) continue
      const pop = this.state.get(id)?.pop ?? true
      const alpha = this.state.get(id)?.alpha ?? 1
      this.meshes.delete(id)
      this.state.delete(id)
      this.anims.delete(id)
      if (pop) {
        this.dying.push({ mesh, t0: now, alpha })
      } else {
        this.group.remove(mesh)
        ;(mesh.material as THREE.Material).dispose()
      }
    }
  }

  private startMove(id: string, from: THREE.Vector3, to: THREE.Vector3, now: number, bounce: boolean) {
    const dy = to.y - from.y
    const lateral = Math.hypot(to.x - from.x, to.z - from.z)
    if (bounce && dy < -0.1 && lateral < 0.05) {
      // vertical fall: dots-3d bounce chain (uniform start height so
      // simultaneous drops look tidy, like the original's clobbered y)
      const y = to.y + Math.max(1, -dy)
      const frames: Anim['frames'] = []
      let t = 0
      let last = y
      for (const h of BOUNCE) {
        const yk = h * y + (1 - h) * to.y
        const dur = Math.sqrt(Math.abs(yk - last) * 75000)
        frames.push({ until: t + dur, y0: last, y1: yk, easeIn: yk < last })
        t += dur
        last = yk
      }
      this.anims.set(id, { t0: now, frames, x: to.x, z: to.z, x0: from.x, z0: from.z })
    } else {
      const dur = EASE_MS
      this.anims.set(id, {
        t0: now,
        frames: [{ until: dur, y0: from.y, y1: to.y, easeIn: false }],
        x: to.x, z: to.z, x0: from.x, z0: from.z,
      })
    }
  }

  /** Advance fades, bounces, claim swell and death pops. */
  update(now: number) {
    for (const [id, mesh] of this.meshes) {
      const st = this.state.get(id)!
      const mat = mesh.material as THREE.MeshBasicMaterial
      const age = now - st.born
      if (mat.opacity < st.alpha) {
        mat.opacity = Math.min(st.alpha, age / FADE_MS)
        if (mat.opacity >= 1) mat.transparent = false
      }
      const anim = this.anims.get(id)
      if (anim) {
        const t = now - anim.t0
        const total = anim.frames[anim.frames.length - 1].until
        if (t >= total) {
          mesh.position.set(anim.x, st.pos.y, anim.z)
          this.anims.delete(id)
        } else {
          const f = anim.frames.find(fr => t < fr.until)!
          const fT0 = anim.frames[anim.frames.indexOf(f) - 1]?.until ?? 0
          const u = (t - fT0) / (f.until - fT0)
          const e = f.easeIn ? u * u : 1 - (1 - u) * (1 - u)
          const k = t / total
          mesh.position.set(
            anim.x0 + (anim.x - anim.x0) * k,
            f.y0 + (f.y1 - f.y0) * e,
            anim.z0 + (anim.z - anim.z0) * k)
        }
      } else {
        mesh.position.set(st.pos.x, st.pos.y, st.pos.z)
      }
      const target = st.claim && st.swell ? 1.25 : 1
      const s = mesh.scale.x + (target - mesh.scale.x) * 0.25
      mesh.scale.setScalar(Math.abs(s - target) < 0.01 ? target : s)
    }
    for (let i = this.dying.length - 1; i >= 0; i--) {
      const d = this.dying[i]
      const t = now - d.t0
      const mat = d.mesh.material as THREE.MeshBasicMaterial
      if (t < POP_SWELL_MS) {
        d.mesh.scale.setScalar(1 + 0.3 * (t / POP_SWELL_MS))
      } else if (t < POP_SWELL_MS + POP_SHRINK_MS) {
        const u = (t - POP_SWELL_MS) / POP_SHRINK_MS
        d.mesh.scale.setScalar(1.3 * (1 - u))
        mat.transparent = true
        mat.opacity = (1 - u) * d.alpha
      } else {
        this.group.remove(d.mesh)
        mat.dispose()
        this.dying.splice(i, 1)
      }
    }
  }

  /**
   * Pick a prop under the pointer: an exact mesh hit wins unless the ray
   * passes right by another prop's anchor IN FRONT of that hit (a tight
   * 0.8x-size capture) - so a slim chess piece is grabbable at its base
   * without the hit falling through to the tile behind it. With no exact
   * hit at all, dots-3d's generous 2.2x-size hitmask applies, so small
   * spheres are draggable without pixel hunting. Returns the candidate
   * closest to the camera along the ray.
   */
  pick(ray: THREE.Raycaster): { id: string; point: THREE.Vector3 } | null {
    const hits = ray.intersectObjects([...this.meshes.values()], false)
    const hit = hits.length
      ? { id: (hits[0].object as THREE.Mesh).userData.netId as string, point: hits[0].point, along: hits[0].distance }
      : null
    const capture = hit ? 0.8 : 2.2
    let best: { id: string; point: THREE.Vector3; along: number } | null = null
    const closest = new THREE.Vector3()
    for (const [id, mesh] of this.meshes) {
      if (id === hit?.id) continue
      const size = mesh.userData.size as number
      ray.ray.closestPointToPoint(mesh.position, closest)
      if (closest.distanceTo(mesh.position) > size * capture) continue
      const along = closest.distanceTo(ray.ray.origin)
      if (along >= (hit?.along ?? Infinity)) continue
      if (!best || along < best.along) best = { id, point: closest.clone(), along }
    }
    return best ?? hit
  }
}

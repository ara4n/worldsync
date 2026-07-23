/**
 * Local monotonic-ish clock in ms, used only as the raw material the
 * TickClock maps onto the room's shared tick grid. Never trusted across the
 * wire: interactions carry tick numbers, and each peer calibrates its tick
 * clock against the room's senior peer instead of trusting wall stamps.
 */
export const wallNow = () => performance.timeOrigin + performance.now()

export interface Vec3 { x: number; y: number; z: number }
export interface Quat { x: number; y: number; z: number; w: number }

// 'boot' is the late-join seam: the senior peer answering a boot-req dumps
// its world as boot interactions broadcast to EVERYONE (itself included), so
// every peer folds the same create-or-reset at the same tick and post-seam
// histories are bit-identical. A joiner-only side channel cannot be: its
// poses are a snapshot from a different moment than the senior's own history.
// Continuous drag motion is NOT an op: it travels on the pose plane.
// 'scene' swaps the room's glTF scene (MSC3815): netId carries the scene's
// mxc URL (empty string clears it). The geometry itself travels out of band
// (Matrix media repo); the op just fixes WHICH tick the collider swap
// happens on, so every peer rebuilds the trimesh at the same point in
// history and rollbacks re-apply it like any other op.
// Props are the second entity family: kinematic, physics-free objects
// (spheres for the dots demo) whose position/color/claim are plain folded
// state. 'claim'/'unclaim' are the script-facing coordination primitive:
// claim applies only to an unclaimed prop, so racing claims resolve
// deterministically by (tick, order, seq) with no extra consensus, and a
// sustained interaction (chaining dots) excludes rivals for its duration.
// 'despawn' removes a prop or a box; 'move' teleports a prop (renderers
// animate the hop cosmetically); 'paint' recolors one.
// 'data' writes one entry of the shared key-value table (netId = key,
// data = value; missing/empty data deletes). Plain folded state like a
// prop: last write wins in timeline order, hashed for convergence,
// booted across seams - the home for game state that no prop naturally
// carries (chess castling rights, a match score, whose turn a round is).
export type InteractionType =
  'spawn' | 'grab' | 'release' | 'boot' | 'scene'
  | 'prop' | 'despawn' | 'claim' | 'unclaim' | 'move' | 'paint' | 'data'

/** prop state carried by boot seams (and 'prop' spawns, minus claim) */
export interface PropInfo {
  kind: string
  color: number
  size: number
  unlit: boolean
  bounce?: boolean // false: discrete moves ease instead of bounce-dropping
  pop?: boolean    // false: no spawn fade-in or despawn pop; appears/vanishes instantly
  opacity?: number // < 1: rendered translucent (ghost previews)
  claim: string | null
  yaw?: number    // solid only: rotation about Y
  dims?: Vec3     // solid only: cuboid extents
  solid?: boolean // this prop carries a fixed collider in the physics world
}

export interface Interaction {
  peer: string
  order: number // join order of the sender, used as a deterministic tie-break
  seq: number   // per-sender sequence number, used for dedup
  tick: number  // author-stamped tick this op belongs to, on the shared grid
  type: InteractionType
  netId: string
  pos: Vec3
  vel?: Vec3
  rot?: Quat    // boot only
  angvel?: Vec3 // boot only
  grab?: { holder: string; order: number; target: Vec3 } // boot only
  from?: number // boot only: tick of the snapshot the dump was read from
  color?: number
  shape?: string  // prop only: 'sphere' | 'box' | 'collider' | a modelled kind (chess pieces)
  size?: number   // prop only: radius / half-extent
  unlit?: boolean // prop only: cosmetic hint, but folded state so it boots
  bounce?: boolean // prop only: false = ease vertical falls, never bounce
  pop?: boolean   // prop only: false = no spawn fade-in / despawn pop
  opacity?: number // prop only: < 1 renders translucent (ghost previews)
  yaw?: number    // prop only, solid: rotation about Y
  dims?: Vec3     // prop only, solid: cuboid extents
  solid?: boolean // prop only: create a fixed collider in the physics world
  force?: boolean // unclaim only: clear someone else's claim (ghost cleanup)
  prop?: PropInfo // boot only: this entity is a prop, not a rigid body
  data?: string   // data op: the value (JSON text; absent/empty deletes);
                  // boot: this entity is a kv entry (netId = key)
}

export interface BootEntity {
  netId: string
  color: number
  pos: Vec3
  rot: Quat
  linvel: Vec3
  angvel: Vec3
  grab?: { holder: string; order: number; target: Vec3 }
  prop?: PropInfo
  data?: string // this entity is a kv entry (netId = key)
}

export type DcMessage =
  | { kind: 'ping'; t0: number }
  // t1 is the responder's local ms (for NTP-style skew display); tt is its
  // fractional tick-clock reading at the same instant, the datum a joiner
  // calibrates its own tick clock against.
  | { kind: 'pong'; t0: number; t1: number; tt: number }
  // Transport-level introduction: maps the sender's opaque SFU identity
  // (LiveKit's modern token flow mints hashes) to its membership id, and
  // carries its join order once known - so peers can mesh on transport
  // presence alone, without waiting for membership state to crawl
  // through a throttled host tab's sync. Consumed by MatrixNet; the
  // Session never sees it.
  | { kind: 'hello'; peer: string; order?: number; ack?: boolean }
  | { kind: 'i'; i: Interaction }
  // The pose plane: latest-wins continuous motion for a held entity.
  // Never rolls anyone back; recorded per author and read by replays.
  | { kind: 'pose'; tick: number; peer: string; netId: string; pos: Vec3 }
  // Ephemeral cosmetic line entity: latest-wins full state per (author,
  // id), purely cosmetic, never folded and never in the hash. Fewer than 2
  // points removes the line; a departed peer's lines go with it.
  | { kind: 'line'; peer: string; id: string; points: Vec3[]; color: number; opacity: number; width: number
      worldUnits: boolean }
  // The heartbeat: attests the author's present (anything it stamps earlier
  // later is a provable history rewrite) and triggers the healing fold that
  // re-simulates the last interval against complete pose tracks.
  | { kind: 'beat'; tick: number }
  | { kind: 'boot-req' }
  // Bit-exact per-tick hashes for a settled range of the global tick grid:
  // hs[j] hashes poses/velocities at the start of tick start+j; 0 = not yet
  // known. Whole-snapshot bytes are NOT exchanged: Rapier serialises a
  // per-step counter, and a folding peer steps more times than a live one,
  // so peers' snapshot bytes legitimately never match.
  | { kind: 'hashes'; start: number; hs: number[] }

/**
 * Shared timebase for interaction timestamps: wall-clock epoch ms with
 * sub-ms precision. Browsers cap out around microsecond granularity (no true
 * nanoseconds), which is plenty to order events. Peers trust each other's
 * wall clocks for tick placement for now; a future version should carry the
 * tick number instead and calibrate tick timelines explicitly.
 */
export const wallNow = () => performance.timeOrigin + performance.now()

export interface Vec3 { x: number; y: number; z: number }
export interface Quat { x: number; y: number; z: number; w: number }

export type InteractionType = 'spawn' | 'grab' | 'move' | 'release'

export interface Interaction {
  peer: string
  order: number // join order of the sender, used as a deterministic tie-break
  seq: number   // per-sender sequence number, used for dedup
  t: number     // claimed wall-clock time of the interaction (wallNow ms)
  type: InteractionType
  netId: string
  pos: Vec3
  vel?: Vec3
  color?: number
}

export interface BootEntity {
  netId: string
  color: number
  pos: Vec3
  rot: Quat
  linvel: Vec3
  angvel: Vec3
}

export type DcMessage =
  | { kind: 'ping'; t0: number }
  | { kind: 'pong'; t0: number; t1: number }
  | { kind: 'i'; i: Interaction }
  | { kind: 'boot-req' }
  | { kind: 'boot'; entities: BootEntity[] }
  // Bit-exact per-tick hashes for a settled range of the global tick grid:
  // hs[j] hashes poses/velocities at the start of tick start+j; 0 = not yet
  // known. Whole-snapshot bytes are NOT exchanged: Rapier serialises a
  // per-step counter, and a folding peer steps more times than a live one,
  // so peers' snapshot bytes legitimately never match.
  | { kind: 'hashes'; start: number; hs: number[] }

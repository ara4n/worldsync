export interface Vec3 { x: number; y: number; z: number }
export interface Quat { x: number; y: number; z: number; w: number }

export type InteractionType = 'spawn' | 'grab' | 'move' | 'release'

export interface Interaction {
  peer: string
  order: number // join order of the sender, used as a deterministic tie-break
  seq: number   // per-sender sequence number, used for dedup
  t: number     // sender-local time in ms (performance.now timeline)
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
  | { kind: 'hash'; h: number }

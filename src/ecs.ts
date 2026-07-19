import { createWorld, defineComponent, Types, addEntity, addComponent, defineQuery, enterQuery } from 'bitecs'

export const Position = defineComponent({ x: Types.f32, y: Types.f32, z: Types.f32 })
export const Rotation = defineComponent({ x: Types.f32, y: Types.f32, z: Types.f32, w: Types.f32 })
export const Tint = defineComponent({ value: Types.ui32 })
export const Box = defineComponent()

export const ecs = createWorld()
export const boxes = defineQuery([Box])
export const newBoxes = enterQuery(boxes)

// Entities are identified across the network by a string netId ("peerid-n").
// bitECS eids are local only; these maps bridge the two.
const netToEid = new Map<string, number>()
const eidToNet = new Map<number, string>()

export function entityFor(netId: string): number | undefined { return netToEid.get(netId) }
export function netIdFor(eid: number): string { return eidToNet.get(eid)! }

export function ensureEntity(netId: string, color: number): number {
  const existing = netToEid.get(netId)
  if (existing !== undefined) return existing
  const eid = addEntity(ecs)
  addComponent(ecs, Box, eid)
  addComponent(ecs, Position, eid)
  addComponent(ecs, Rotation, eid)
  addComponent(ecs, Tint, eid)
  Rotation.w[eid] = 1
  Tint.value[eid] = color
  netToEid.set(netId, eid)
  eidToNet.set(eid, netId)
  return eid
}

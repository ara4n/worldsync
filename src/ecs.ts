import { createWorld, defineComponent, Types, addEntity, addComponent, defineQuery, enterQuery } from 'bitecs'

// One ECS universe per Sim. bitECS component data lives in per-component
// arrays indexed by eid, so two sims in one process (the headless hub runs
// several peers side by side) need their own component instances as well as
// their own world, or they would write over each other's stores.
export type EcsStore = ReturnType<typeof createEcsStore>

export function createEcsStore() {
  const Position = defineComponent({ x: Types.f32, y: Types.f32, z: Types.f32 })
  const Rotation = defineComponent({ x: Types.f32, y: Types.f32, z: Types.f32, w: Types.f32 })
  // Pose one tick earlier, for fixed-timestep render interpolation.
  const PrevPosition = defineComponent({ x: Types.f32, y: Types.f32, z: Types.f32 })
  const PrevRotation = defineComponent({ x: Types.f32, y: Types.f32, z: Types.f32, w: Types.f32 })
  const Tint = defineComponent({ value: Types.ui32 })
  const Box = defineComponent()

  const world = createWorld()
  const boxes = defineQuery([Box])
  const newBoxes = enterQuery(boxes)

  // Entities are identified across the network by a string netId ("peerid-n").
  // bitECS eids are local only; these maps bridge the two.
  const netToEid = new Map<string, number>()
  const eidToNet = new Map<number, string>()

  return {
    world, Position, Rotation, PrevPosition, PrevRotation, Tint, Box, boxes,
    newBoxes: () => newBoxes(world),
    entityFor: (netId: string): number | undefined => netToEid.get(netId),
    netIdFor: (eid: number): string => eidToNet.get(eid)!,
    ensureEntity(netId: string, color: number): number {
      const existing = netToEid.get(netId)
      if (existing !== undefined) return existing
      const eid = addEntity(world)
      addComponent(world, Box, eid)
      addComponent(world, Position, eid)
      addComponent(world, Rotation, eid)
      addComponent(world, PrevPosition, eid)
      addComponent(world, PrevRotation, eid)
      addComponent(world, Tint, eid)
      Rotation.w[eid] = 1
      PrevRotation.w[eid] = 1
      Tint.value[eid] = color
      netToEid.set(netId, eid)
      eidToNet.set(eid, netId)
      return eid
    },
  }
}

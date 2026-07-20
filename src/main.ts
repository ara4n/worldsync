import { Sim, TICK_MS } from './sim'
import { Net, type Peer } from './net'
import { View } from './render'
import { Input, type Emitter } from './input'
import { UI } from './ui'
import { entityFor } from './ecs'
import { wallNow, type Interaction } from './types'

const HASH_EVERY_TICKS = 30

async function main() {
  const room = new URLSearchParams(location.search).get('room') ?? 'default'
  const sim = new Sim()
  await sim.init()
  const view = new View(document.body)
  const net = new Net()
  const ui = new UI(document.getElementById('panel')!, {
    onLatency: v => { net.sendDelayMs = v },
    onLagPings: v => { net.lagPings = v },
    onRubber: v => { view.rubberMs = v },
  })
  net.onLog = l => ui.log(l)

  let seq = 0
  let spawnCount = 0
  let ownHash = 0
  let bootAsked = false

  const out: Emitter = {
    ready: () => net.id !== '',
    nextNetId: () => `${net.id}-${spawnCount++}`,
    emit(type, netId, data) {
      const i: Interaction = {
        peer: net.id, order: net.order, seq: seq++, t: wallNow(),
        type, netId, pos: data.pos, vel: data.vel, color: data.color,
      }
      sim.insert(i)
      net.broadcast({ kind: 'i', i })
    },
  }
  const input = new Input(view, out)

  // "Too old" means significantly older than the round trip should allow.
  const staleLimit = (peer: Peer) => Math.max(250, peer.rtt * 1.5 + 120)

  function strike(peer: Peer, detail: string) {
    peer.strikes++
    ui.log(`dropped stale interaction from ${peer.id} (${detail})`)
    if (peer.strikes >= 10 && !peer.excluded) {
      peer.excluded = true
      ui.log(`${peer.id} excluded from sim, an admin should kick them`)
    }
  }

  net.onMessage = (peer, msg) => {
    switch (msg.kind) {
      case 'i': {
        if (peer.excluded) return
        // The claimed timestamp is trusted as-is; age against our own wall
        // clock decides staleness (peer.offset is reported, not applied).
        const age = wallNow() - msg.i.t
        const limit = staleLimit(peer)
        if (age > limit) { strike(peer, `${age.toFixed(0)}ms old, limit ${limit.toFixed(0)}ms`); return }
        sim.insert(msg.i)
        break
      }
      case 'boot-req':
        net.sendTo(peer, { kind: 'boot', entities: sim.dump() })
        break
      case 'boot':
        sim.applyBoot(msg.entities)
        sim.mirror()
        ui.log(`bootstrapped ${msg.entities.length} entities from ${peer.id}`)
        break
      case 'hash':
        peer.hashMatch = msg.h === ownHash
        break
    }
  }

  // Late joiners pull a state snapshot from the first senior peer they reach.
  net.onPeerConnected = peer => {
    if (!bootAsked && peer.order < net.order) {
      bootAsked = true
      net.sendTo(peer, { kind: 'boot-req' })
    }
  }

  net.connect(room)

  // Coarse FNV-style hash of quantised body positions, broadcast every second.
  // Sims in flight rarely match (they run out of phase); matching at rest is
  // the "have we diverged" signal shown in the peer table.
  function stateHash(): number {
    let h = 0x811c9dc5
    const mix = (n: number) => { h = Math.imul(h ^ (n & 0xffff), 0x01000193) }
    for (const id of [...sim.bodies.keys()].sort()) {
      for (let i = 0; i < id.length; i++) mix(id.charCodeAt(i))
      const b = sim.body(id)
      if (!b) continue
      const p = b.translation()
      mix(Math.round(p.x * 10)); mix(Math.round(p.y * 10)); mix(Math.round(p.z * 10))
    }
    return h >>> 0
  }

  const startTick = sim.tick // global grid ticks are huge; display relative
  let nextHashTick = sim.tick + HASH_EVERY_TICKS
  function frame() {
    const now = wallNow()
    if (sim.needsResim) {
      const presented = view.capture()
      if (sim.fold()) {
        sim.mirror()
        view.applyCorrections(presented, now, input.draggedEid)
      }
    }
    sim.advance(now)
    sim.mirror()
    const alpha = Math.min(Math.max((now - sim.tick * TICK_MS) / TICK_MS, 0), 1)
    view.frame(now, alpha)
    if (sim.tick >= nextHashTick) {
      nextHashTick = sim.tick + HASH_EVERY_TICKS
      ownHash = stateHash()
      net.broadcast({ kind: 'hash', h: ownHash })
    }
    ui.maybe(now, () => ({
      room, id: net.id, order: net.order,
      entities: sim.bodies.size, tick: sim.tick - startTick,
      rollbacks: sim.rollbacks, lastDepth: sim.lastReplayDepth,
      peers: [...net.peers.values()].map(p => ({
        id: p.id, order: p.order, connected: p.connected, rtt: p.rtt,
        offset: p.offset, strikes: p.strikes, excluded: p.excluded, hashMatch: p.hashMatch,
      })),
    }))
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)

  // Hooks for automated smoke tests and console poking.
  ;(window as any).__jig = {
    sim, net, view,
    pos: (netId: string) => {
      const b = sim.body(netId)
      if (!b) return null
      const p = b.translation()
      return { x: p.x, y: p.y, z: p.z }
    },
    screenPos: (netId: string) => {
      const eid = entityFor(netId)
      const m = eid === undefined ? undefined : view.meshes.get(eid)
      if (!m) return null
      const v = m.position.clone().project(view.camera)
      const el = view.renderer.domElement
      return { x: ((v.x + 1) / 2) * el.clientWidth, y: ((1 - v.y) / 2) * el.clientHeight }
    },
  }
}

main()

import { Vector3 } from 'three'
import { Sim, TICK_MS } from './sim'
import { Net, type Peer } from './net'
import { View } from './render'
import { Input, type Emitter } from './input'
import { UI } from './ui'
import { entityFor } from './ecs'
import { wallNow, type Interaction } from './types'

const HASH_EVERY_TICKS = 60
// Only exchange tick hashes older than this. A fold can rewrite any tick in
// the snapshot window (HISTORY_TICKS back), so anything younger can still
// change after being sent, false-positiving the divergence latch; beyond the
// window a rewrite is impossible without a clamp ANOMALY being logged.
const SETTLE_TICKS = 330

async function main() {
  const params = new URLSearchParams(location.search)
  const room = params.get('room') ?? 'default'
  const sim = new Sim()
  // ?norm=pipeline swaps per-tick world restore for per-tick solver reset
  // (refuted, kept as a demo); ?cad=K snapshots/normalises every K
  // grid-aligned ticks. Every peer in a room must use the same settings.
  if (params.get('norm') === 'pipeline') sim.normalizeMode = 'pipeline'
  const cad = Math.floor(Number(params.get('cad') ?? '0'))
  if (cad >= 1) sim.cadence = cad
  await sim.init()
  const view = new View(document.body)
  const net = new Net()
  // Off by default so arbitrary fake latency folds instead of dropping;
  // dropped interactions are a guaranteed permanent divergence.
  let enforceStale = false
  const ui = new UI(document.getElementById('panel')!, {
    onLatency: v => { net.sendDelayMs = v },
    onLagPings: v => { net.lagPings = v },
    onRubber: v => { view.rubberMs = v },
    onEnforceStale: v => { enforceStale = v },
    onVerify: () => ui.log(`replay self-check: ${JSON.stringify(sim.verifyReplay(60))}`),
    onDumpInputs: () => {
      const blob = new Blob(
        [JSON.stringify({ peer: net.id, order: net.order, tick: sim.tick, log: sim.inputLog }, null, 1)],
        { type: 'application/json' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `inputs-${net.id}.json`
      a.click()
      URL.revokeObjectURL(a.href)
    },
  })
  net.onLog = l => ui.log(l)
  sim.onAnomaly = m => ui.log(`ANOMALY: ${m}`)

  let seq = 0
  let spawnCount = 0
  let bootAsked = false
  // Ticks below this are excluded from the cross-peer hash exchange, in both
  // directions. A late joiner's hashes before its boot seam describe a world
  // the other peers never had (empty, then partially bootstrapped), so
  // comparing them latches a false-positive divergence.
  let compareFloor = 0

  // JSON round-trips doubles exactly except that -0 becomes 0, so normalise
  // negative zeros at the source to keep local and remote inputs bit-equal.
  const z = (n: number) => n + 0 === 0 ? 0 : n
  const zv = (v: { x: number; y: number; z: number }) => ({ x: z(v.x), y: z(v.y), z: z(v.z) })
  const zq = (q: { x: number; y: number; z: number; w: number }) => ({ x: z(q.x), y: z(q.y), z: z(q.z), w: z(q.w) })

  const out: Emitter = {
    ready: () => net.id !== '',
    nextNetId: () => `${net.id}-${spawnCount++}`,
    emit(type, netId, data) {
      const i: Interaction = {
        peer: net.id, order: net.order, seq: seq++, t: wallNow(),
        type, netId, pos: zv(data.pos), vel: data.vel && zv(data.vel),
        rot: data.rot && zq(data.rot), angvel: data.angvel && zv(data.angvel),
        grab: data.grab && { holder: data.grab.holder, order: data.grab.order, target: zv(data.grab.target) },
        color: data.color,
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
        if (enforceStale) {
          const age = wallNow() - msg.i.t
          const limit = staleLimit(peer)
          if (age > limit) { strike(peer, `${age.toFixed(0)}ms old, limit ${limit.toFixed(0)}ms`); return }
        }
        const k = sim.insert(msg.i)
        // A boot seam folded into our timeline: hashes for anything older
        // describe pre-seam worlds and are not comparable across peers.
        if (msg.i.type === 'boot' && k !== null && k + 1 > compareFloor) {
          compareFloor = k + 1
          ui.log(`boot seam from ${peer.id} at tick ${k - startTick}`)
        }
        break
      }
      case 'boot-req':
        // Dump our world as ordinary interactions so every peer (us
        // included, via emit) folds the identical seam at the same tick.
        for (const e of sim.dump()) {
          out.emit('boot', e.netId, { pos: e.pos, rot: e.rot, vel: e.linvel, angvel: e.angvel, grab: e.grab, color: e.color })
        }
        break
      case 'hashes': {
        for (let j = 0; j < msg.hs.length; j++) {
          const t = msg.start + j
          if (t < compareFloor) continue
          const theirs = msg.hs[j]
          if (!theirs) continue
          const ours = sim.hashes.get(t)
          if (ours === undefined) continue
          peer.checked = true
          if (ours !== theirs && peer.divergedAt === null) {
            peer.divergedAt = t
            ui.log(`DIVERGED from ${peer.id} at tick ${t - startTick}`)
            ui.log(`replay self-check: ${JSON.stringify(sim.verifyReplay(60))}`)
            // Stash bit-level dumps of our state at (and just before) the
            // divergent tick for cross-peer post-mortem diffing.
            const b64 = (u: Uint8Array | null) => {
              if (!u) return null
              let s = ''
              for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000))
              return btoa(s)
            }
            ;(window as any).__divergence = {
              peer: peer.id, tick: t,
              state: sim.stateAt(t), statePrev: sim.stateAt(t - 1),
              snapPrev: b64(sim.snapshotAt(t - 1)), snap: b64(sim.snapshotAt(t)),
              inputsAt: sim.inputLog.filter(e => e.tick >= t - 1 && e.tick <= t),
            }
            break
          }
        }
        break
      }
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
      const start = sim.tick - SETTLE_TICKS - 2 * HASH_EVERY_TICKS
      const hs: number[] = []
      for (let t = start; t < sim.tick - SETTLE_TICKS; t++) {
        hs.push(t < compareFloor ? 0 : sim.hashes.get(t) ?? 0)
      }
      net.broadcast({ kind: 'hashes', start, hs })
    }
    ui.maybe(now, () => ({
      room, id: net.id, order: net.order,
      entities: sim.bodies.size, tick: sim.tick - startTick, stepMs: sim.stepMs,
      perf: sim.perf, norm: sim.cadence > 1 ? `${sim.normalizeMode}/${sim.cadence}` : sim.normalizeMode,
      rollbacks: sim.rollbacks, lastDepth: sim.lastReplayDepth,
      peers: [...net.peers.values()].map(p => ({
        id: p.id, order: p.order, connected: p.connected, rtt: p.rtt,
        offset: p.offset, strikes: p.strikes, excluded: p.excluded,
        sync: p.divergedAt !== null ? `≠@${p.divergedAt - startTick}` : p.checked ? '=' : '-',
      })),
    }))
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)

  // Hidden tabs get no rAF, and throttled timers alone would eventually trip
  // the tick-jump anomaly; worker messages are not throttled, so a worker
  // heartbeat keeps the sim stepping (without rendering) in the background.
  const ticker = new Worker(URL.createObjectURL(new Blob(
    ['setInterval(() => postMessage(0), 100)'], { type: 'application/javascript' })))
  ticker.onmessage = () => {
    if (!document.hidden) return
    sim.fold()
    sim.advance(wallNow())
    sim.mirror()
  }

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
    screenOfGround: (x: number, zz: number) => {
      const v = new Vector3(x, 0, zz).project(view.camera)
      const el = view.renderer.domElement
      return { x: ((v.x + 1) / 2) * el.clientWidth, y: ((1 - v.y) / 2) * el.clientHeight }
    },
    screenOfWorld: (x: number, y: number, zz: number) => {
      const v = new Vector3(x, y, zz).project(view.camera)
      const el = view.renderer.domElement
      return { x: ((v.x + 1) / 2) * el.clientWidth, y: ((1 - v.y) / 2) * el.clientHeight }
    },
    verify: (depth?: number) => sim.verifyReplay(depth ?? 60),
    roundTrip: () => sim.roundTrip(),
  }
}

main()

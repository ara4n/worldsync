import { Vector3 } from 'three'
import { Sim } from './sim'
import { Net } from './net'
import { Session } from './session'
import { View } from './render'
import { Input, type Emitter } from './input'
import { UI } from './ui'
import { wallNow } from './types'

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
  const view = new View(document.body, sim.ecs)
  const net = new Net()
  const session = new Session(
    sim,
    (to, msg) => to === null ? net.broadcast(msg) : net.sendToId(to, msg),
    wallNow)

  const ui = new UI(document.getElementById('panel')!, {
    onLatency: v => { net.sendDelayMs = v },
    onLagPings: v => { net.lagPings = v },
    onRubber: v => { view.rubberMs = v },
    onVerify: () => ui.log(`replay self-check: ${JSON.stringify(sim.verifyReplay(60))}`),
    onDumpInputs: () => {
      const blob = new Blob(
        [JSON.stringify({ peer: session.id, order: session.order, tick: sim.tick, log: sim.inputLog }, null, 1)],
        { type: 'application/json' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `inputs-${session.id}.json`
      a.click()
      URL.revokeObjectURL(a.href)
    },
  })
  net.onLog = l => ui.log(l)
  session.onLog = l => ui.log(l)
  sim.onAnomaly = m => ui.log(`ANOMALY: ${m}`)
  // Stash bit-level dumps of our state at (and just before) the divergent
  // tick for cross-peer post-mortem diffing.
  session.onDiverged = (peerId, t) => {
    const b64 = (u: Uint8Array | null) => {
      if (!u) return null
      let s = ''
      for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000))
      return btoa(s)
    }
    ;(window as any).__divergence = {
      peer: peerId, tick: t,
      state: sim.stateAt(t), statePrev: sim.stateAt(t - 1),
      snapPrev: b64(sim.snapshotAt(t - 1)), snap: b64(sim.snapshotAt(t)),
      inputsAt: sim.inputLog.filter(e => e.tick >= t - 1 && e.tick <= t),
    }
  }

  net.onJoined = (id, order, alone) => session.identity(id, order, alone)
  net.onMessage = (peer, msg) => session.receive(peer.id, msg)
  net.onPeerConnected = peer => session.peerConnected(peer.id, peer.order)
  net.onPeerLeft = id => session.peerLeft(id)

  const out: Emitter = {
    ready: () => session.ready(),
    nextNetId: () => session.nextNetId(),
    emit: (type, netId, data) => session.emit(type, netId, data),
    streamPose: (netId, pos) => session.streamPose(netId, pos),
  }
  const input = new Input(view, out)

  net.connect(room)

  function frame() {
    const now = wallNow()
    if (sim.needsResim) {
      const presented = view.capture()
      if (session.foldIfNeeded()) {
        sim.mirror()
        view.applyCorrections(presented, now, input.draggedEid)
      }
    }
    session.advance()
    sim.mirror()
    const alpha = session.calibrated
      ? Math.min(Math.max(session.tickTimeNow(now) - sim.tick, 0), 1)
      : 0
    view.frame(now, alpha)
    ui.maybe(now, () => ({
      room, id: session.id, order: session.order,
      entities: sim.bodies.size, tick: sim.tick - session.startTick, stepMs: sim.stepMs,
      perf: sim.perf, norm: sim.cadence > 1 ? `${sim.normalizeMode}/${sim.cadence}` : sim.normalizeMode,
      rollbacks: sim.rollbacks, lastDepth: sim.lastReplayDepth,
      peers: [...session.peers.values()].map(p => ({
        id: p.id, order: p.order,
        connected: net.peers.get(p.id)?.connected ?? false,
        rtt: p.rtt, offset: p.offset, strikes: p.strikes, excluded: p.excluded,
        sync: p.divergedAt !== null ? `≠@${p.divergedAt - session.startTick}` : p.checked ? '=' : '-',
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
    session.foldIfNeeded()
    session.advance()
    sim.mirror()
  }

  // Hooks for automated smoke tests and console poking.
  ;(window as any).__jig = {
    sim, net, session, view,
    pos: (netId: string) => {
      const b = sim.body(netId)
      if (!b) return null
      const p = b.translation()
      return { x: p.x, y: p.y, z: p.z }
    },
    screenPos: (netId: string) => {
      const eid = sim.ecs.entityFor(netId)
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

// Headless convergence suite on the hub's virtual clock: no browser, no
// sockets, fully deterministic. Run with: npm run test:headless
import { createHub } from '../src/hub'
import { TICK_MS } from '../src/sim'
import { WorldScript, type ScriptHost } from '../src/websg'

let failures = 0
const check = (cond: boolean, what: string) => {
  console.log(`${cond ? 'ok' : 'FAIL'}: ${what}`)
  if (!cond) { failures++; process.exitCode = 1 }
}

import type { HubPeer } from '../src/hub'

/** shared ticks whose hashes disagree between two peers, respecting each
 * side's boot-seam compare floor (pre-seam hashes are not comparable) */
const hashDiff = (x: HubPeer, y: HubPeer, upTo: number) => {
  const floor = Math.max(x.session.compareFloor, y.session.compareFloor)
  const bad: number[] = []
  for (const [t, h] of x.sim.hashes) {
    if (t >= floor && t <= upTo && y.sim.hashes.has(t) && y.sim.hashes.get(t) !== h) bad.push(t)
  }
  return bad.sort((p, q) => p - q)
}

const S = 1000 // virtual milliseconds per second, for readability

async function laggySpawnAndDrag() {
  console.log('\n-- laggy spawn and drag converge bit-exactly --')
  const hub = createHub(30)
  const a = await hub.join('a')
  const b = await hub.join('b')
  hub.link('a', 'b', 250) // one-sided half-second round trip

  a.session.emit('spawn', a.session.nextNetId(), { pos: { x: 0, y: 2.5, z: 0 } })
  a.session.emit('spawn', a.session.nextNetId(), { pos: { x: 0.4, y: 4, z: 0.1 } })
  const target = a.session.nextNetId()
  a.session.emit('spawn', target, { pos: { x: -0.3, y: 5.5, z: -0.2 } })
  hub.run(2 * S)

  // b drags the top box through the pilelet while a keeps receiving late
  b.session.emit('grab', target, { pos: b.sim.body(target)!.translation() })
  hub.run(0.2 * S)
  for (let i = 0; i < 30; i++) {
    b.session.streamPose(target, { x: -0.3 + i * 0.05, y: 1.2, z: -0.2 + i * 0.02 })
    hub.run(TICK_MS)
  }
  b.session.emit('release', target, { pos: { x: 1.2, y: 1.2, z: 0.4 }, vel: { x: 3, y: 0, z: 1 } })
  hub.run(8 * S)

  const settled = a.sim.tick - 400 // clear of both peers' unsettled frontier
  const bad = hashDiff(a, b, settled)
  check(bad.length === 0, `no divergent settled ticks (found ${bad.length}${bad.length ? `, first ${bad[0]}` : ''})`)
  check(a.sim.hashes.get(settled) === b.sim.hashes.get(settled), 'state hashes bit-equal at a common tick')
  check([...a.session.peers.values()].every(p => p.checked && p.divergedAt === null), 'a: hash exchange clean')
  check([...b.session.peers.values()].every(p => p.checked && p.divergedAt === null), 'b: hash exchange clean')
  // b's laggy drag ops reach a a quarter second late, so a is the folder
  check(a.sim.rollbacks > 0, `laggy path actually folded (a rolled back ${a.sim.rollbacks}x)`)
  check(a.sim.anomalies.length === 0 && b.sim.anomalies.length === 0, 'no anomalies')
}

async function lateJoin() {
  console.log('\n-- late joiner boots into a settled pile and bit-converges --')
  const hub = createHub(40)
  const a = await hub.join('a')
  for (let k = 0; k < 6; k++) {
    a.session.emit('spawn', a.session.nextNetId(), { pos: { x: (k % 3) * 1.2 - 1.2, y: 2 + Math.floor(k / 3), z: 0 } })
  }
  hub.run(3 * S)

  const b = await hub.join('b')
  hub.run(1 * S)
  b.session.emit('spawn', b.session.nextNetId(), { pos: { x: -0.6, y: 3, z: 0.3 } })
  hub.run(10 * S)

  check(b.sim.bodies.size === 7, `joiner has all entities (${b.sim.bodies.size}/7)`)
  const settled = a.sim.tick - 400
  const bad = hashDiff(a, b, settled)
  check(bad.length === 0, `no divergent settled ticks (found ${bad.length})`)
  check([...a.session.peers.values()].every(p => p.checked && p.divergedAt === null), 'a: hash exchange clean')
  check([...b.session.peers.values()].every(p => p.checked && p.divergedAt === null), 'b: hash exchange clean')
}

async function threePeerMesh() {
  console.log('\n-- three peers, mixed latency, interleaved edits --')
  const hub = createHub(20)
  const a = await hub.join('a')
  const b = await hub.join('b')
  const c = await hub.join('c')
  hub.link('a', 'c', 180)
  hub.link('b', 'c', 90)

  const ids: string[] = []
  for (const [p, n] of [[a, 3], [b, 3], [c, 2]] as const) {
    for (let k = 0; k < n; k++) {
      const id = p.session.nextNetId()
      ids.push(id)
      p.session.emit('spawn', id, { pos: { x: ids.length * 0.9 - 4, y: 2 + (k % 2), z: (k % 2) * 0.5 } })
      hub.run(0.2 * S)
    }
  }
  c.session.emit('grab', ids[0], { pos: c.sim.body(ids[0])!.translation() })
  for (let i = 0; i < 20; i++) {
    c.session.streamPose(ids[0], { x: -4 + i * 0.1, y: 1.5, z: 0.5 })
    hub.run(TICK_MS)
  }
  c.session.emit('release', ids[0], { pos: { x: -2, y: 1.5, z: 0.5 }, vel: { x: 0, y: 0, z: 0 } })
  hub.run(10 * S)

  const settled = a.sim.tick - 400
  for (const [x, y, name] of [[a, b, 'a/b'], [a, c, 'a/c'], [b, c, 'b/c']] as const) {
    const bad = hashDiff(x, y, settled)
    check(bad.length === 0, `${name}: no divergent settled ticks (found ${bad.length})`)
  }
  for (const p of [a, b, c]) {
    check([...p.session.peers.values()].every(q => q.checked && q.divergedAt === null), `${p.id}: hash exchange clean`)
  }
}

async function skewedClocks() {
  console.log('\n-- wildly skewed and drifting local clocks calibrate away --')
  const hub = createHub(35)
  const a = await hub.join('a')
  // b's local clock is 47s ahead and runs 200ppm fast; c's is 12s behind.
  // Tick stamps + calibration must keep the grid shared regardless.
  const b = await hub.join('b', n => n + 47_000 + n * 200e-6)
  const c = await hub.join('c', n => n - 12_000)
  hub.run(2 * S)

  a.session.emit('spawn', a.session.nextNetId(), { pos: { x: 0, y: 2.5, z: 0 } })
  hub.run(1 * S)
  const target = b.session.nextNetId()
  b.session.emit('spawn', target, { pos: { x: 0.3, y: 4, z: 0.1 } })
  hub.run(1 * S)
  c.session.emit('grab', target, { pos: c.sim.body(target)!.translation() })
  for (let i = 0; i < 15; i++) {
    c.session.streamPose(target, { x: 0.3 + i * 0.1, y: 1.5, z: 0.1 })
    hub.run(TICK_MS)
  }
  c.session.emit('release', target, { pos: { x: 1.8, y: 1.5, z: 0.1 }, vel: { x: 0, y: 0, z: 0 } })
  hub.run(12 * S)

  const drift = (p: HubPeer) => Math.abs(p.session.tickTimeNow() - a.session.tickTimeNow())
  check(drift(b) < 1 && drift(c) < 1, `grids agree within a tick (b ${drift(b).toFixed(2)}, c ${drift(c).toFixed(2)})`)
  const settled = a.sim.tick - 400
  for (const [x, y, name] of [[a, b, 'a/b'], [a, c, 'a/c'], [b, c, 'b/c']] as const) {
    check(hashDiff(x, y, settled).length === 0, `${name}: no divergent settled ticks`)
  }
  for (const p of [a, b, c]) {
    check(p.sim.anomalies.length === 0, `${p.id}: no anomalies`)
    check([...p.session.peers.values()].every(q => q.checked && q.divergedAt === null), `${p.id}: hash exchange clean`)
  }
}

async function spawnRacesJoin() {
  console.log('\n-- ops racing a join survive the boot seam on every peer --')
  const hub = createHub(15)
  const a = await hub.join('a')
  hub.run(0.5 * S)
  const b = await hub.join('b')
  // spawn immediately, before b has calibrated or booted: the op's tick
  // precedes b's start and postdates the dump snapshot
  const raced = a.session.nextNetId()
  a.session.emit('spawn', raced, { pos: { x: 0, y: 2.5, z: 0 } })
  hub.run(TICK_MS * 2)
  a.session.emit('spawn', a.session.nextNetId(), { pos: { x: 0.4, y: 3.5, z: 0.1 } })
  hub.run(10 * S)

  check(a.sim.bodies.size === 2 && b.sim.bodies.size === 2,
    `both peers keep the raced spawns (a ${a.sim.bodies.size}, b ${b.sim.bodies.size})`)
  const settled = a.sim.tick - 400
  check(hashDiff(a, b, settled).length === 0, 'no divergent settled ticks')
  for (const p of [a, b]) {
    check(p.sim.anomalies.length === 0, `${p.id}: no anomalies`)
    check([...p.session.peers.values()].every(q => q.checked && q.divergedAt === null), `${p.id}: hash exchange clean`)
  }
}

async function glbSceneConverges() {
  console.log('\n-- glTF scene colliders: op swap, slow-download heal, late joiner --')
  const hub = createHub(30)
  // a synthetic "GLB": a 4x4 horizontal shelf at y=1 (two triangles), the
  // geometry every peer would get by parsing the same bytes
  const geom = {
    vertices: new Float32Array([-2, 1, -2, 2, 1, -2, 2, 1, 2, -2, 1, 2]),
    indices: new Uint32Array([0, 2, 1, 0, 3, 2]),
  }
  const url = 'mxc://test/scene'
  const a = await hub.join('a')
  const b = await hub.join('b')
  hub.run(1 * S)
  a.sim.registerSceneGeometry(url, geom)
  a.session.emit('scene', url, { pos: { x: 0, y: 0, z: 0 } }, a.sim.tick + 12)
  // b's "download" completes half a second after the op applied: the op ran
  // without geometry (anomaly logged), then registerSceneGeometry schedules
  // the healing fold that replays it with the trimesh present
  hub.run(0.5 * S)
  b.sim.registerSceneGeometry(url, geom)
  hub.run(0.5 * S)
  const id = a.session.nextNetId()
  a.session.emit('spawn', id, { pos: { x: 0, y: 3, z: 0 } })
  hub.run(3 * S)
  const y = a.sim.body(id)!.translation().y
  check(Math.abs(y - 1.5) < 0.05, `box rests on the scene shelf, not the ground (y=${y.toFixed(3)})`)

  // late joiner adopts the scene from "room state" before calibrating, so
  // its boot-seam world matches the seniors' from the first snapshot
  const c = await hub.join('c')
  c.sim.registerSceneGeometry(url, geom)
  c.sim.adoptScene(url)
  hub.run(8 * S)
  const cy = c.sim.body(id)!.translation().y
  check(Math.abs(cy - 1.5) < 0.05, `joiner sees the box on the shelf too (y=${cy.toFixed(3)})`)
  const settled = a.sim.tick - 400
  for (const [x, z, name] of [[a, b, 'a/b'], [a, c, 'a/c'], [b, c, 'b/c']] as const) {
    check(hashDiff(x, z, settled).length === 0, `${name}: no divergent settled ticks`)
  }
  for (const p of [a, b, c]) {
    check([...p.session.peers.values()].every(q => q.checked && q.divergedAt === null), `${p.id}: hash exchange clean`)
  }
  check(a.sim.anomalies.length === 0 && c.sim.anomalies.length === 0, 'a and c: no anomalies')
  check(b.sim.anomalies.every(m => m.includes('scene')) && b.sim.anomalies.length > 0,
    `b: exactly the expected missing-geometry anomaly (${b.sim.anomalies.length})`)
}

/** the same op mapping main.ts gives the sandbox, wired to a hub peer */
const hostFor = (p: HubPeer): ScriptHost => ({
  log: () => {},
  boxes: () => [...p.sim.bodies.keys()].map(id => {
    const t = p.sim.body(id)!.translation()
    const g = p.sim.grabs.get(id)
    return { id, x: t.x, y: t.y, z: t.z, grabbed: !!g, mine: g?.holder === p.id }
  }),
  box: id => {
    const b = p.sim.body(id)
    if (!b) return null
    const t = b.translation()
    const g = p.sim.grabs.get(id)
    return { x: t.x, y: t.y, z: t.z, grabbed: !!g, mine: g?.holder === p.id }
  },
  sceneNode: () => null,
  spawn: (x, y, z, color) => {
    const id = p.session.nextNetId()
    p.session.emit('spawn', id, { pos: { x, y, z }, color })
    return id
  },
  grab: id => {
    const b = p.sim.body(id)
    if (!b || p.sim.grabs.has(id)) return false
    const t = b.translation()
    p.session.emit('grab', id, { pos: { x: t.x, y: t.y, z: t.z } })
    return true
  },
  moveTo: (id, x, y, z) => {
    const g = p.sim.grabs.get(id)
    if (!g || g.holder !== p.id) return false
    p.session.streamPose(id, { x, y, z })
    return true
  },
  release: (id, vx, vy, vz) => {
    const g = p.sim.grabs.get(id)
    if (!g || g.holder !== p.id) return false
    const b = p.sim.body(id)
    const t = b ? b.translation() : { x: 0, y: 0, z: 0 }
    p.session.emit('release', id, { pos: { x: t.x, y: t.y, z: t.z }, vel: { x: vx, y: vy, z: vz } })
    return true
  },
})

async function sandboxedScriptConverges() {
  console.log('\n-- sandboxed WebSG script drives the world through ops only --')
  const hub = createHub(40)
  const a = await hub.join('a')
  const b = await hub.join('b')
  hub.run(1 * S)
  // spawn, wait for the op to apply, grab, wave for 1.5s, throw
  const script = await WorldScript.create(`
    let phase = 'spawn', box = null, t0 = 0
    world.onenter = () => console.log('entered')
    world.onupdate = (dt, time) => {
      if (phase === 'spawn') { box = world.createNode({ translation: [0, 3, 0], color: 0xff8800 }); phase = 'grab' }
      else if (phase === 'grab') { if (box.grab()) { t0 = time; phase = 'drag' } }
      else if (phase === 'drag') {
        if (time - t0 < 1.5) box.moveTo(Math.sin((time - t0) * 4) * 2, 1.2, 0)
        else { box.release([1, 2, 0]); phase = 'done' }
      }
    }
  `, hostFor(a))
  script.enter()
  let last = a.sim.tick
  hub.run(6 * S, () => {
    if (a.sim.tick > last) {
      const dt = (a.sim.tick - last) / 60
      last = a.sim.tick
      script.update(dt, (a.sim.tick - a.session.startTick) / 60)
    }
  })
  check(!script.dead, 'script survived (no dispatch errors)')
  script.dispose()
  hub.run(4 * S)

  check(a.sim.bodies.size === 1 && b.sim.bodies.size === 1,
    `script box replicated (a ${a.sim.bodies.size}, b ${b.sim.bodies.size})`)
  const id = [...a.sim.bodies.keys()][0]
  const t = a.sim.body(id)!.translation()
  check(Math.abs(t.x) > 0.3, `box was dragged and thrown off origin (x=${t.x.toFixed(2)})`)
  check(!a.sim.grabs.has(id), 'box was released')
  const settled = a.sim.tick - 400
  check(hashDiff(a, b, settled).length === 0, 'no divergent settled ticks')
  for (const p of [a, b]) {
    check(p.sim.anomalies.length === 0, `${p.id}: no anomalies`)
    check([...p.session.peers.values()].every(q => q.checked && q.divergedAt === null), `${p.id}: hash exchange clean`)
  }
}

async function backdaterStruck() {
  console.log('\n-- an op stamped before its author\'s own beat earns a strike --')
  const hub = createHub(10)
  const a = await hub.join('a')
  const b = await hub.join('b')
  hub.run(3 * S)
  // b backdates a spawn 40 ticks: b's beats have already attested past that
  // tick, so receivers must treat it as a provable history rewrite.
  b.session.emit('spawn', b.session.nextNetId(), { pos: { x: 0, y: 2.5, z: 0 } }, b.sim.tick - 40)
  hub.run(2 * S)
  const bOnA = a.session.peers.get('b')!
  check(bOnA.strikes === 1, `a struck the backdater (${bOnA.strikes} strike)`)
  check(a.sim.bodies.size === 0, `a refused the rewrite (${a.sim.bodies.size} entities)`)
}

const t0 = Date.now()
await laggySpawnAndDrag()
await lateJoin()
await threePeerMesh()
await skewedClocks()
await spawnRacesJoin()
await glbSceneConverges()
await sandboxedScriptConverges()
await backdaterStruck()
console.log(`\n${failures === 0 ? 'HEADLESS SUITE PASSED' : `${failures} FAILURES`} (${((Date.now() - t0) / 1000).toFixed(1)}s real for ~72s virtual)`)

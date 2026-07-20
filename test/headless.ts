// Headless convergence suite on the hub's virtual clock: no browser, no
// sockets, fully deterministic. Run with: npm run test:headless
import { createHub } from '../src/hub'
import { TICK_MS } from '../src/sim'

let failures = 0
const check = (cond: boolean, what: string) => {
  console.log(`${cond ? 'ok' : 'FAIL'}: ${what}`)
  if (!cond) { failures++; process.exitCode = 1 }
}

/** shared ticks whose hashes disagree between two sims (settled range only) */
const hashDiff = (a: Map<number, number>, b: Map<number, number>, upTo: number) => {
  const bad: number[] = []
  for (const [t, h] of a) if (t <= upTo && b.has(t) && b.get(t) !== h) bad.push(t)
  return bad.sort((x, y) => x - y)
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
    b.session.emit('move', target, { pos: { x: -0.3 + i * 0.05, y: 1.2, z: -0.2 + i * 0.02 } })
    hub.run(TICK_MS)
  }
  b.session.emit('release', target, { pos: { x: 1.2, y: 1.2, z: 0.4 }, vel: { x: 3, y: 0, z: 1 } })
  hub.run(8 * S)

  const settled = a.sim.tick - 400 // clear of both peers' unsettled frontier
  const bad = hashDiff(a.sim.hashes, b.sim.hashes, settled)
  check(bad.length === 0, `no divergent settled ticks (found ${bad.length}${bad.length ? `, first ${bad[0]}` : ''})`)
  check(a.sim.hashes.get(settled) === b.sim.hashes.get(settled), 'state hashes bit-equal at a common tick')
  check([...a.session.peers.values()].every(p => p.checked && p.divergedAt === null), 'a: hash exchange clean')
  check([...b.session.peers.values()].every(p => p.checked && p.divergedAt === null), 'b: hash exchange clean')
  check(b.sim.rollbacks > 0, `laggy path actually folded (b rolled back ${b.sim.rollbacks}x)`)
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
  const bad = hashDiff(a.sim.hashes, b.sim.hashes, settled)
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
    c.session.emit('move', ids[0], { pos: { x: -4 + i * 0.1, y: 1.5, z: 0.5 } })
    hub.run(TICK_MS)
  }
  c.session.emit('release', ids[0], { pos: { x: -2, y: 1.5, z: 0.5 }, vel: { x: 0, y: 0, z: 0 } })
  hub.run(10 * S)

  const settled = a.sim.tick - 400
  for (const [x, y, name] of [[a, b, 'a/b'], [a, c, 'a/c'], [b, c, 'b/c']] as const) {
    const bad = hashDiff(x.sim.hashes, y.sim.hashes, settled)
    check(bad.length === 0, `${name}: no divergent settled ticks (found ${bad.length})`)
  }
  for (const p of [a, b, c]) {
    check([...p.session.peers.values()].every(q => q.checked && q.divergedAt === null), `${p.id}: hash exchange clean`)
  }
}

const t0 = Date.now()
await laggySpawnAndDrag()
await lateJoin()
await threePeerMesh()
console.log(`\n${failures === 0 ? 'HEADLESS SUITE PASSED' : `${failures} FAILURES`} (${((Date.now() - t0) / 1000).toFixed(1)}s real for ~54s virtual)`)

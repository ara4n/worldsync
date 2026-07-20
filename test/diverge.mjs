// Divergence stress shaped like the observed repro: one peer with 500ms send
// latency spawns dozens of boxes with tightly packed clicks (later clicks hit
// existing boxes, becoming quick grab+release pairs), plus a few drags. The
// other peer folds everything via rollback. Reports the first divergent tick
// and bit-level state diffs if the peers disagree.
// Run the dev server first: npm run dev
import { chromium } from 'playwright'

const base = process.env.URL ?? 'http://localhost:5173'
const room = 'div-' + Math.random().toString(36).slice(2, 8)
const minutes = Number(process.env.MINUTES ?? 1.5)
const targetBoxes = Number(process.env.BOXES ?? 150)
const norm = process.env.NORM ?? 'restore'
const cad = Number(process.env.CAD ?? 0) // 0 = app default
const browser = await chromium.launch({ headless: false })

async function open(name) {
  const page = await browser.newPage()
  page.on('pageerror', e => console.error(`${name} pageerror:`, String(e)))
  await page.goto(`${base}/?room=${room}&norm=${norm}&cad=${cad}`)
  await page.waitForFunction(() => window.__jig && window.__jig.session && window.__jig.session.ready(), null, { timeout: 15000 })
  return page
}

const a = await open('a')
const b = await open('b')
const peered = p =>
  p.waitForFunction(() => [...window.__jig.net.peers.values()].some(x => x.connected), null, { timeout: 20000 })
await Promise.all([peered(a), peered(b)])
console.log(`peered; 500ms send latency on a; norm=${norm} cad=${cad}; running for`, minutes, 'min')
await a.evaluate(() => { window.__jig.net.sendDelayMs = 500 })

const diverged = () => a.evaluate(() =>
  [...window.__jig.session.peers.values()].some(x => x.divergedAt !== null) ? true :
  undefined) // waitForFunction-style truthiness

const deadline = Date.now() + minutes * 60_000
let round = 0
outer: while (Date.now() < deadline) {
  round++
  // Tight grid of clicks; whatever lands on an existing box becomes a quick
  // grab+release instead of a spawn, like the manual repro. Keep going until
  // the target box count is reached, then just keep poking the pile.
  if (await a.evaluate(() => window.__jig.sim.bodies.size) < targetBoxes) {
    for (let gx = -4; gx <= 4; gx++) {
      for (let gz = -3; gz <= 3; gz++) {
        const s = await a.evaluate(([x, z]) => window.__jig.screenOfGround(x, z),
          [gx * 1.7 + (round % 3) * 0.6, gz * 1.7 + (round % 2) * 0.9])
        await a.mouse.click(s.x, s.y)
        await a.waitForTimeout(45)
        if (await a.evaluate(() => [...window.__jig.session.peers.values()].some(x => x.divergedAt !== null))) break outer
      }
    }
  }
  // Drag a box THROUGH the pile: world-space waypoints criss-crossing the
  // grid at grab height, so the held box plows through the others.
  const netId = await a.evaluate(r =>
    [...window.__jig.sim.bodies.keys()][r % window.__jig.sim.bodies.size], round * 7)
  const pt = await a.evaluate(id => window.__jig.screenPos(id), netId)
  if (pt) {
    await a.mouse.move(pt.x, pt.y)
    await a.mouse.down()
    const path = [[-5, 0], [5, 1], [0, -4], [0, 4], [-4, -3], [4, 3]]
    for (const [wx, wz] of path) {
      const s = await a.evaluate(([x, z]) => window.__jig.screenOfWorld(x, 0.6, z), [wx, wz])
      await a.mouse.move(s.x, s.y, { steps: 8 })
      await a.waitForTimeout(250)
    }
    await a.mouse.up()
  }
  console.log(`round ${round}: entities`, await a.evaluate(() => window.__jig.sim.bodies.size))
  await a.waitForTimeout(1500)
}

console.log('settling 8s...')
await a.waitForTimeout(8000)

const stats = p => p.evaluate(() => ({
  id: window.__jig.net.id,
  entities: window.__jig.sim.bodies.size,
  rollbacks: window.__jig.sim.rollbacks,
  stepMs: window.__jig.sim.stepMs,
  verify: window.__jig.sim.verifyReplay(60),
  anomalies: window.__jig.sim.anomalies,
  divergedAt: [...window.__jig.session.peers.values()].map(x => x.divergedAt),
  divergence: window.__divergence ?? null,
  poseHashes: [...window.__jig.sim.hashes.entries()],
}))
const [sa, sb] = await Promise.all([stats(a), stats(b)])
for (const [name, s] of [['a', sa], ['b', sb]]) {
  console.log(name, s.id, 'entities', s.entities, 'rollbacks', s.rollbacks,
    'stepMs', s.stepMs.toFixed(2),
    'verify', JSON.stringify(s.verify), 'divergedAt', s.divergedAt,
    'anomalies', s.anomalies.length ? s.anomalies : 'none')
}

// Compare the peers' final (settled) pose-hash maps directly, catching any
// divergence the in-app exchange has not latched yet.
{
  const ma = new Map(sa.poseHashes), mb = new Map(sb.poseHashes)
  const shared = [...ma.keys()].filter(t => mb.has(t)).sort((x, y) => x - y)
  const bad = shared.filter(t => ma.get(t) !== mb.get(t))
  console.log(`final pose hashes: ${shared.length} shared ticks, ${bad.length} differ`
    + (bad.length ? ` (first ${bad[0]}, last ${bad[bad.length - 1]})` : ''))
}

if (sa.divergence && sb.divergence) {
  const ta = sa.divergence.tick, tb = sb.divergence.tick
  console.log('divergence latched: a@', ta, 'b@', tb)
  const [da, db] = [sa.divergence, sb.divergence]
  console.log('roundTrip a:', JSON.stringify(await a.evaluate(() => window.__jig.roundTrip())))
  console.log('roundTrip b:', JSON.stringify(await b.evaluate(() => window.__jig.roundTrip())))
  for (const phase of ['snapPrev', 'snap']) {
    if (!da[phase] || !db[phase]) { console.log(phase, 'bytes missing'); continue }
    const na = Buffer.from(da[phase], 'base64'), nb = Buffer.from(db[phase], 'base64')
    let diffs = 0, first = -1
    for (let i = 0; i < Math.min(na.length, nb.length); i++) {
      if (na[i] !== nb[i]) { diffs++; if (first < 0) first = i }
    }
    console.log(`${phase}: cross-peer snapshot lens ${na.length}/${nb.length}, differing bytes ${diffs}, first at ${first}`)
  }
  for (const phase of ['statePrev', 'state']) {
    const xa = da[phase], xb = db[phase]
    if (!xa || !xb) { console.log(phase, 'missing on one side'); continue }
    const bad = Object.keys(xa).filter(k => xa[k] !== xb[k])
    console.log(`${phase}: ${bad.length} bodies differ`)
    for (const k of bad.slice(0, 4)) {
      console.log(' ', k, '\n   a:', xa[k]?.slice(0, 130), '\n   b:', xb[k]?.slice(0, 130))
    }
  }
  console.log('inputs at divergent tick (a):', JSON.stringify(da.inputsAt))
} else {
  const poses = p => p.evaluate(() =>
    Object.fromEntries([...window.__jig.sim.bodies.keys()].map(id => [id, window.__jig.pos(id)])))
  const [pa, pb] = await Promise.all([poses(a), poses(b)])
  let worst = 0, worstId = ''
  for (const id of Object.keys(pa)) {
    if (!pb[id]) continue
    const d = Math.hypot(pa[id].x - pb[id].x, pa[id].y - pb[id].y, pa[id].z - pb[id].z)
    if (d > worst) { worst = d; worstId = id }
  }
  console.log(`no divergence latched; worst pose delta ${worst.toFixed(9)}m (${worstId})`)
}

await browser.close()

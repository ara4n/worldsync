// Late-join seam test: page A settles a pile alone, page B joins afterwards.
// The boot must fold as a shared timeline seam: both peers reach checked=true
// with no divergence latch, and their per-tick state hashes bit-match at a
// common tick. LAT=500 delays A's sends so the boot folds into B's past.
// Run the dev server first: npm run dev
import { chromium } from 'playwright'

const base = process.env.URL ?? 'http://localhost:5173'
const room = 'latejoin-' + Math.random().toString(36).slice(2, 8)
const browser = await chromium.launch({ headless: false })

async function open() {
  const page = await browser.newPage()
  await page.goto(`${base}/?room=${room}`)
  await page.waitForFunction(() => window.__jig && window.__jig.net.id !== '', null, { timeout: 15000 })
  return page
}

function fail(msg) {
  console.error('FAIL:', msg)
  process.exitCode = 1
}

const a = await open()
await a.evaluate(() => {
  const { sim, net } = window.__jig
  for (let k = 0; k < 8; k++) sim.insert({
    peer: net.id, order: net.order, seq: 90000 + k,
    t: performance.timeOrigin + performance.now(),
    type: 'spawn', netId: `lj-${k}`,
    pos: { x: (k % 4) * 1.2 - 2, y: 2 + Math.floor(k / 4), z: 0 },
    color: 0x888888,
  })
})
console.log('A spawned 8 boxes, settling 6s...')
await a.waitForTimeout(6000)

const LAT = Number(process.env.LAT ?? 0)
if (LAT) {
  await a.evaluate(ms => { window.__jig.net.sendDelayMs = ms }, LAT)
  console.log(`A send latency ${LAT}ms: boot will fold into B's past`)
}

console.log('B joining late...')
const b = await open()
await b.waitForFunction(() => [...window.__jig.net.peers.values()].some(p => p.connected), null, { timeout: 20000 })

// Post-seam activity: B drops a box onto the pile.
await b.waitForTimeout(1500)
await b.evaluate(() => {
  const { sim, net } = window.__jig
  const i = {
    peer: net.id, order: net.order, seq: 91000,
    t: performance.timeOrigin + performance.now(),
    type: 'spawn', netId: `${net.id}-lj`, pos: { x: -1.4, y: 3, z: 0.3 }, color: 0x22cc88,
  }
  sim.insert(i)
  net.broadcast({ kind: 'i', i })
})
console.log('waiting for settled-hash comparison on both sides...')

for (const [name, page] of [['a', a], ['b', b]]) {
  const compared = await page.waitForFunction(
    () => [...window.__jig.session.peers.values()].every(q => q.checked),
    null, { timeout: 30000 }).then(() => true).catch(() => false)
  if (!compared) fail(`${name} never compared settled hashes`)
}
await b.waitForTimeout(8000) // several more hash exchanges to catch a late latch

for (const [name, page] of [['a', a], ['b', b]]) {
  const s = await page.evaluate(() => ({
    entities: window.__jig.sim.bodies.size,
    peers: [...window.__jig.session.peers.values()].map(p => ({ id: p.id, checked: p.checked, divergedAt: p.divergedAt })),
    anomalies: window.__jig.sim.anomalies,
    verify: window.__jig.sim.verifyReplay(60),
  }))
  console.log(name, JSON.stringify(s))
  if (s.entities !== 9) fail(`${name} has ${s.entities} entities, expected 9`)
  for (const p of s.peers) if (p.divergedAt !== null) fail(`${name} latched divergence vs ${p.id}`)
  if (s.verify.posesMatch === false) fail(`${name} replay self-check failed`)
}

// Bit-exact convergence at one common tick (sampling live poses from two
// pages compares different ticks while the pile still micro-settles).
const target = await a.evaluate(() => window.__jig.sim.tick) + 30
const [ha, hb] = await Promise.all([a, b].map(p => p.evaluate(async T => {
  const { sim } = window.__jig
  while (sim.tick <= T + 1) await new Promise(r => setTimeout(r, 50))
  return sim.hashes.get(T)
}, target)))
console.log(`state hash at common tick: a=${ha} b=${hb}`)
if (ha === undefined || ha !== hb) fail('state hashes differ at common tick')

if (process.exitCode !== 1) console.log('LATE JOIN TEST PASSED')
await browser.close()

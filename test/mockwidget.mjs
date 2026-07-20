// Matryoshka widget test: two mock-host tabs (real matrix-widget-api +
// RoomWidgetClient + MatrixRTC membership against the in-memory driver,
// BroadcastChannel standing in for LiveKit), late join included, asserting
// the same bit-exact convergence as the classic demo. Pages must share one
// browser context or BroadcastChannel cannot cross tabs.
// Run the dev server first: npm run dev
import { chromium } from 'playwright'

const base = process.env.URL ?? 'http://localhost:5173'
const room = 'mw' + Math.random().toString(36).slice(2, 8)
const browser = await chromium.launch({ headless: false })
const ctx = await browser.newContext()

function fail(msg) {
  console.error('FAIL:', msg)
  process.exitCode = 1
}

async function open(name) {
  const page = await ctx.newPage()
  page.on('pageerror', e => console.error(`${name} pageerror:`, String(e).slice(0, 200)))
  await page.goto(`${base}/mock.html?room=${room}`)
  await page.waitForFunction(() => {
    const f = document.getElementById('widget')
    const w = f && f.contentWindow
    return !!(w && w.__jig && w.__jig.session && w.__jig.session.ready())
  }, null, { timeout: 30000 })
  return page.frames().find(f => f !== page.mainFrame())
}

const a = await open('a')
await a.evaluate(() => {
  const { session } = window.__jig
  for (let k = 0; k < 6; k++) session.emit('spawn', session.nextNetId(), {
    pos: { x: (k % 3) * 1.2 - 1.2, y: 2 + Math.floor(k / 3), z: 0 }, color: 0x888888,
  })
})
console.log('a up and spawned 6; settling before late join...')
await a.page().waitForTimeout(4000)

const b = await open('b')
await b.page().waitForTimeout(1500)
await b.evaluate(() => {
  const { session } = window.__jig
  session.emit('spawn', `${session.id.replace(/[^a-z0-9]/gi, '')}-lj`, { pos: { x: -0.6, y: 3, z: 0.3 }, color: 0x22cc88 })
})
console.log('b joined late and spawned; waiting for settled-hash comparison...')

for (const [name, f] of [['a', a], ['b', b]]) {
  const ok = await f.waitForFunction(
    () => [...window.__jig.session.peers.values()].every(p => p.checked),
    null, { timeout: 40000 }).then(() => true).catch(() => false)
  if (!ok) fail(`${name} never compared settled hashes`)
}
await b.page().waitForTimeout(6000)

for (const [name, f] of [['a', a], ['b', b]]) {
  const s = await f.evaluate(() => ({
    entities: window.__jig.sim.bodies.size,
    peers: [...window.__jig.session.peers.values()].map(p => ({ id: p.id, checked: p.checked, divergedAt: p.divergedAt })),
    anomalies: window.__jig.sim.anomalies,
    verify: window.__jig.sim.verifyReplay(60),
  }))
  console.log(name, JSON.stringify(s))
  if (s.entities !== 7) fail(`${name} has ${s.entities} entities, expected 7`)
  for (const p of s.peers) if (p.divergedAt !== null) fail(`${name} latched divergence vs ${p.id}`)
  if (s.verify.posesMatch === false) fail(`${name} replay self-check failed`)
}

const target = await a.evaluate(() => window.__jig.sim.tick) + 30
const [ha, hb] = await Promise.all([a, b].map(f => f.evaluate(async T => {
  const { sim } = window.__jig
  while (sim.tick <= T + 1) await new Promise(r => setTimeout(r, 50))
  return sim.hashes.get(T)
}, target)))
console.log(`state hash at common tick: a=${ha} b=${hb}`)
if (ha === undefined || ha !== hb) fail('state hashes differ at common tick')

if (process.exitCode !== 1) console.log('MOCK WIDGET TEST PASSED')
await browser.close()

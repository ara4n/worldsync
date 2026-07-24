// MSC3815 script_url e2e under the mock widget host: tab a uploads a
// WebSG-subset JS script. EVERY peer runs it, but its ambient loop is
// guarded by world.me.primary, so only the primary (a) emits ops; when a
// closes, primacy hands over and b's already-running instance takes up the
// loop from its own state. Run the dev server first: npm run dev
import { chromium } from 'playwright'

const base = process.env.URL ?? 'http://localhost:5173'
const room = 'ws' + Math.random().toString(36).slice(2, 8)
const browser = await chromium.launch({ headless: false })
const ctx = await browser.newContext()

function fail(msg) {
  console.error('FAIL:', msg)
  process.exitCode = 1
}

// Spawns a box every ~2.5s (up to 5), grabbing and waving each before a
// throw. Restarts from scratch on whichever peer is root.
const SCRIPT = `
let phase = 'spawn', box = null, t0 = 0, n = 0
world.onenter = () => console.log('script entered')
world.onupdate = (dt, time) => {
  if (!world.me.primary) return
  if (phase === 'spawn') {
    if (n >= 5) { phase = 'idle'; return }
    box = world.createNode({ translation: [(n % 3) - 1, 3, 0], color: 0x22ccff })
    n++
    phase = 'grab'
  } else if (phase === 'grab') {
    if (box.grab()) { t0 = time; phase = 'drag' }
  } else if (phase === 'drag') {
    if (time - t0 < 1.2) box.moveTo(Math.sin((time - t0) * 4) * 2, 1.2, 0)
    else { box.release([1, 2, 0]); t0 = time; phase = 'wait' }
  } else if (phase === 'wait') {
    if (time - t0 > 1) phase = 'spawn'
  }
}
`

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
const b = await open('b')
await a.page().waitForTimeout(1000)

await a.setInputFiles('#scriptfile', {
  name: 'wave.js', mimeType: 'text/javascript', buffer: Buffer.from(SCRIPT),
})
console.log('a uploaded the script; both run it, only the primary (a) should emit ops...')

for (const [name, f] of [['a', a], ['b', b]]) {
  const ok = await f.waitForFunction(
    () => window.__jig.sim.bodies.size >= 2,
    null, { timeout: 20000 }).then(() => true).catch(() => false)
  if (!ok) fail(`${name} never saw script-spawned boxes`)
}

const aId = await a.evaluate(() => window.__jig.session.id)
const bIds = await b.evaluate(() => [...window.__jig.sim.bodies.keys()])
console.log(`boxes on b: ${JSON.stringify(bIds)}`)
if (!bIds.every(id => id.startsWith(aId))) fail(`non-root spawned boxes: ${bIds.filter(id => !id.startsWith(aId))}`)

console.log('waiting for settled-hash comparison before handover...')
for (const [name, f] of [['a', a], ['b', b]]) {
  const ok = await f.waitForFunction(
    () => [...window.__jig.session.peers.values()].every(p => p.checked),
    null, { timeout: 40000 }).then(() => true).catch(() => false)
  if (!ok) fail(`${name} never compared settled hashes`)
  const s = await f.evaluate(() => ({
    peers: [...window.__jig.session.peers.values()].map(p => ({ id: p.id, divergedAt: p.divergedAt })),
    anomalies: window.__jig.sim.anomalies,
  }))
  for (const p of s.peers) if (p.divergedAt !== null) fail(`${name} latched divergence vs ${p.id}`)
  if (s.anomalies.length) fail(`${name} anomalies: ${JSON.stringify(s.anomalies)}`)
}

const before = await b.evaluate(() => window.__jig.sim.bodies.size)
console.log(`closing a (root) with ${before} boxes; b should take over the script...`)
await a.page().close()

const bId = await b.evaluate(() => window.__jig.session.id)
const took = await b.waitForFunction(
  (n) => [...window.__jig.sim.bodies.keys()].length > n,
  before, { timeout: 30000 }).then(() => true).catch(() => false)
if (!took) fail('b never spawned boxes after taking over as root')
else {
  const ids = await b.evaluate(() => [...window.__jig.sim.bodies.keys()])
  const fresh = ids.filter(id => id.startsWith(bId))
  console.log(`b took over and spawned: ${JSON.stringify(fresh)}`)
  if (fresh.length === 0) fail('post-handover boxes not authored by b')
}

if (process.exitCode !== 1) console.log('SCRIPT TEST PASSED')
await browser.close()

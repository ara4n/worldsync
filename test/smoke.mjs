// End-to-end smoke test: two headless pages join the same room over real
// WebRTC, one spawns a box, the other must see it; then a laggy drag must
// converge on both sides (exercising rollback + replay + rubber-banding).
// Run the dev server first: npm run dev
import { chromium } from 'playwright'

const base = process.env.URL ?? 'http://localhost:5173'
const room = 'smoke-' + Math.random().toString(36).slice(2, 8)
const errors = []

const browser = await chromium.launch({ headless: false })

async function open(name) {
  const page = await browser.newPage()
  page.on('pageerror', e => errors.push(`${name}: ${e}`))
  page.on('console', m => {
    if (m.type() !== 'error') return
    const url = m.location()?.url ?? ''
    if (/favicon/.test(url) || /favicon/.test(m.text())) return
    errors.push(`${name}: ${m.text()} (${url})`)
  })
  await page.goto(`${base}/?room=${room}`)
  await page.waitForFunction(() => window.__jig && window.__jig.session && window.__jig.session.ready(), null, { timeout: 15000 })
  return page
}

function fail(msg) {
  console.error('FAIL:', msg)
  process.exitCode = 1
}

const a = await open('a')
const b = await open('b')

const peered = page =>
  page.waitForFunction(() => [...window.__jig.net.peers.values()].some(p => p.connected), null, { timeout: 20000 })
await Promise.all([peered(a), peered(b)])
console.log('peers connected')

// Spawn a box from page A by clicking the middle of the ground.
const vp = a.viewportSize()
await a.mouse.click(vp.width / 2, vp.height / 2)
await a.waitForFunction(() => window.__jig.sim.bodies.size === 1, null, { timeout: 5000 })
await b.waitForFunction(() => window.__jig.sim.bodies.size === 1, null, { timeout: 5000 })
console.log('spawn replicated')

await a.waitForTimeout(1200) // let the box land and settle

// Add artificial latency on A so its drag arrives late at B, forcing rollbacks.
await a.evaluate(() => { window.__jig.net.sendDelayMs = 120 })
const netId = await a.evaluate(() => [...window.__jig.sim.bodies.keys()][0])
const pt = await a.evaluate(id => window.__jig.screenPos(id), netId)
await a.mouse.move(pt.x, pt.y)
await a.mouse.down()
for (let i = 1; i <= 12; i++) {
  await a.mouse.move(pt.x + i * 12, pt.y - i * 3, { steps: 2 })
  await a.waitForTimeout(40)
}
await a.mouse.up()
await a.waitForTimeout(2500) // settle plus latency drain

const pa = await a.evaluate(id => window.__jig.pos(id), netId)
const pb = await b.evaluate(id => window.__jig.pos(id), netId)
const rollbacksB = await b.evaluate(() => window.__jig.sim.rollbacks)
const dist = Math.hypot(pa.x - pb.x, pa.y - pb.y, pa.z - pb.z)
console.log(`a pos ${JSON.stringify(pa)}`)
console.log(`b pos ${JSON.stringify(pb)}`)
console.log(`divergence ${dist.toFixed(3)}m, rollbacks on b: ${rollbacksB}`)

const getLog = page => page.evaluate(() =>
  JSON.stringify([...window.__jig.sim.inputLog].sort((x, y) =>
    x.tick - y.tick || x.order - y.order || x.seq - y.seq)))
const [logA, logB] = await Promise.all([getLog(a), getLog(b)])
console.log(`input logs ${logA === logB ? 'identical' : 'DIFFER'} (${JSON.parse(logA).length} entries)`)

if (dist > 1.0) fail(`sims diverged by ${dist.toFixed(3)}m after drag`)
if (logA !== logB) fail('peers fed different inputs to their sims')
if (rollbacksB < 1) fail('expected the laggy drag to force rollbacks on b')
const moved = Math.hypot(pa.x, pa.z) > 0.5
if (!moved) fail('drag did not move the box')
const realErrors = errors.filter(e => !/favicon/.test(e))
if (realErrors.length) fail(`console/page errors:\n${realErrors.join('\n')}`)

await browser.close()
console.log(process.exitCode ? 'SMOKE TEST FAILED' : 'SMOKE TEST PASSED')

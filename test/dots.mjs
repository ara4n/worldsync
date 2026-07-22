// dots-3d e2e under the mock widget host: tab a uploads examples/dots.js,
// the primary seeds a 3x3x3 board of prop spheres, and a real mouse drag
// chains two adjacent same-coloured dots. While the chain is live, b must
// see a's claims (and a's chain line); on release both dots despawn and
// refills bring the board back to 27 on BOTH tabs, bit-converged.
// Run the dev server first: npm run dev
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'

const base = process.env.URL ?? 'http://localhost:5173'
const room = 'dots' + Math.random().toString(36).slice(2, 8)
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
  const frame = page.frames().find(f => f !== page.mainFrame())
  const box = await page.locator('#widget').boundingBox()
  return { page, frame, off: { x: box.x, y: box.y } }
}

const a = await open('a')
const b = await open('b')
await a.page.waitForTimeout(1000)

await a.frame.setInputFiles('#scriptfile', {
  name: 'dots.js', mimeType: 'text/javascript',
  buffer: readFileSync(new URL('../examples/dots.js', import.meta.url)),
})
console.log('a uploaded dots.js; waiting for the board...')

// board dots only: the script also parks hidden score/timer props far
// below the board, so count props above the floor, not sim.props.size
for (const [name, t] of [['a', a], ['b', b]]) {
  const ok = await t.frame.waitForFunction(
    () => window.__jig.props().filter(p => p.y > -1).length === 27,
    null, { timeout: 30000 }).then(() => true).catch(() => false)
  if (!ok) fail(`${name} never saw the 27-dot board (has ${await t.frame.evaluate(() => window.__jig.props().filter(p => p.y > -1).length)})`)
}
console.log('board seeded and replicated (27 dots on both tabs)')
await a.page.waitForTimeout(500) // camera repose + fade-ins

// find an adjacent same-coloured pair, preferring pairs whose straight
// screen path does not graze a third dot
const pair = await a.frame.evaluate(() => {
  const props = window.__jig.props().filter(p => p.y > -1) // dots, not HUD props
  const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z)
  const pairs = []
  for (const p of props) {
    for (const q of props) {
      if (p.id >= q.id || p.color !== q.color || dist(p, q) > 1.1) continue
      const sp = window.__jig.screenOfProp(p.id), sq = window.__jig.screenOfProp(q.id)
      let graze = 0
      for (const r of props) {
        if (r === p || r === q) continue
        const sr = window.__jig.screenOfProp(r.id)
        // distance from r to the p-q screen segment
        const dx = sq.x - sp.x, dy = sq.y - sp.y
        const t = Math.max(0, Math.min(1, ((sr.x - sp.x) * dx + (sr.y - sp.y) * dy) / (dx * dx + dy * dy)))
        if (Math.hypot(sr.x - (sp.x + t * dx), sr.y - (sp.y + t * dy)) < 25) graze++
      }
      pairs.push({ p: p.id, q: q.id, graze })
    }
  }
  pairs.sort((x, y) => x.graze - y.graze)
  return pairs[0] ?? null
})
if (!pair) { fail('no adjacent same-coloured pair on the board'); process.exit(1) }
console.log(`chaining ${pair.p} -> ${pair.q} (graze ${pair.graze})`)

const s1 = await a.frame.evaluate(id => window.__jig.screenOfProp(id), pair.p)
const s2 = await a.frame.evaluate(id => window.__jig.screenOfProp(id), pair.q)
await a.page.mouse.move(a.off.x + s1.x, a.off.y + s1.y)
await a.page.mouse.down()
await a.page.waitForTimeout(150)
await a.page.mouse.move(a.off.x + s2.x, a.off.y + s2.y, { steps: 10 })

// mid-drag: b must see a's claims on both dots, and a's chain line
const aId = await a.frame.evaluate(() => window.__jig.session.id)
const claimed = await b.frame.waitForFunction(
  ([p, q, id]) => {
    const props = window.__jig.props()
    const cp = props.find(x => x.id === p), cq = props.find(x => x.id === q)
    return cp && cq && cp.claim === id && cq.claim === id
  }, [pair.p, pair.q, aId], { timeout: 10000 }).then(() => true).catch(() => false)
if (!claimed) fail('b never saw a\'s claims on the chained dots')
else console.log('b sees both dots claimed by a')
const lineSeen = await b.frame.waitForFunction(
  id => {
    const lines = window.__jig.view.lines
    if (!lines) return false
    for (const key of lines.keys()) if (key.startsWith(id + '/')) return true
    return false
  }, aId, { timeout: 5000 }).then(() => true).catch(() => false)
if (!lineSeen) fail('b never saw a\'s chain line')
else console.log('b sees a\'s chain line')

await a.page.mouse.up()

// the chain clears: both chained dots despawn, refills restore 27
for (const [name, t] of [['a', a], ['b', b]]) {
  const ok = await t.frame.waitForFunction(
    ([p, q]) => {
      const props = window.__jig.props().filter(x => x.y > -1)
      return props.length === 27 && !props.some(x => x.id === p || x.id === q)
    }, [pair.p, pair.q], { timeout: 15000 }).then(() => true).catch(() => false)
  if (!ok) {
    const state = await t.frame.evaluate(([p, q]) => {
      const props = window.__jig.props().filter(x => x.y > -1)
      return { n: props.length, hasP: props.some(x => x.id === p), hasQ: props.some(x => x.id === q) }
    }, [pair.p, pair.q])
    fail(`${name}: chain did not clear cleanly (${JSON.stringify(state)})`)
  }
}
console.log('chain cleared, refills landed: 27 dots on both tabs')

// convergence: wait for a settled-hash comparison, no divergence latched
for (const [name, t] of [['a', a], ['b', b]]) {
  const ok = await t.frame.waitForFunction(
    () => [...window.__jig.session.peers.values()].every(p => p.checked),
    null, { timeout: 40000 }).then(() => true).catch(() => false)
  if (!ok) fail(`${name} never compared settled hashes`)
  const s = await t.frame.evaluate(() => ({
    peers: [...window.__jig.session.peers.values()].map(p => ({ id: p.id, divergedAt: p.divergedAt })),
    anomalies: window.__jig.sim.anomalies,
  }))
  for (const p of s.peers) if (p.divergedAt !== null) fail(`${name} latched divergence vs ${p.id}`)
  if (s.anomalies.length) fail(`${name} anomalies: ${JSON.stringify(s.anomalies)}`)
}

if (process.exitCode !== 1) console.log('DOTS TEST PASSED')
await browser.close()

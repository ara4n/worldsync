// Echo-loss e2e: the mock host withholds our own m.call.member echo
// (?dropOwnEcho=1) while still storing the state, exactly like hosts in
// the wild that acknowledge the send but lose the push. Two scenarios:
// alone, the session must self-root after the grace period (lone-boot
// fallback); with a live peer present the fallback must NOT fire -
// instead the widget re-reads room state from the host directly and
// injects the missing membership (state-push recovery), then meshes.
// Run the dev server first: npm run dev
import { chromium } from 'playwright'

const base = process.env.URL ?? 'http://localhost:5173'
const room = 'lb' + Math.random().toString(36).slice(2, 8)
const browser = await chromium.launch({ headless: false })
const page = await browser.newPage()

function fail(msg) {
  console.error('FAIL:', msg)
  process.exitCode = 1
}

const logs = []
page.on('console', m => { if (m.text().includes('[worldsync]')) logs.push(m.text()) })
await page.goto(`${base}/mock.html?room=${room}&dropOwnEcho=1`)
const ok = await page.waitForFunction(() => {
  const w = document.getElementById('widget')?.contentWindow
  return !!(w && w.__jig && w.__jig.session && w.__jig.session.ready())
}, null, { timeout: 15000 }).then(() => true).catch(() => false)
if (!ok) fail('session never started with the membership echo withheld')

if (ok) {
  if (!logs.some(l => l.includes('starting alone'))) {
    fail(`lone-boot fallback log missing (did the echo sneak through?): ${logs.join(' | ')}`)
  }
  const bodies = await page.evaluate(() => {
    const w = document.getElementById('widget').contentWindow
    const { session } = w.__jig
    session.emit('spawn', session.nextNetId(), { pos: { x: 0, y: 3, z: 0 }, color: 0x33cc66 })
    return new Promise(r => setTimeout(() => r(w.__jig.sim.bodies.size), 2000))
  })
  if (bodies < 1) fail('spawn did not land in the lone-booted sim')
}

// --- scenario 2: echo lost WITH a live peer -> state-push recovery ---
{
  const room2 = 'lb' + Math.random().toString(36).slice(2, 8)
  // one shared context: BroadcastChannel (the mock transport and state
  // gossip) does not cross browser contexts, and browser.newPage() makes
  // a fresh context each call
  const ctx2 = await browser.newContext()
  const open = async (params) => {
    const p = await ctx2.newPage()
    await p.goto(`${base}/mock.html?room=${room2}${params}`)
    await p.waitForFunction(() => {
      const w = document.getElementById('widget')?.contentWindow
      return !!(w && w.__jig && w.__jig.session)
    }, null, { timeout: 30000 })
    return { page: p, frame: p.frames().find((f) => f !== p.mainFrame()) }
  }
  const a = await open('')
  await a.frame.waitForFunction(() => window.__jig.session.ready(), null, { timeout: 15000 })
  const b = await open('&dropOwnEcho=1')
  const logs = []
  b.page.on('console', (m) => { if (m.text().includes('[worldsync]')) logs.push(m.text()) })
  const ready = await b.frame.waitForFunction(() => window.__jig.session.ready(), null, { timeout: 25000 })
    .then(() => true).catch(() => false)
  if (!ready) fail('recovery: b never started with a peer present and the echo withheld')
  const blogs = await b.frame.evaluate(() =>
    [...document.querySelectorAll('#log div')].map((d) => d.textContent))
  if (!blogs.some((l) => l.includes('recovering org.matrix.msc3401.call.member'))) {
    fail(`recovery: state-push recovery never ran: ${blogs.slice(-8).join(' | ')}`)
  }
  if (blogs.some((l) => l.includes('starting alone'))) {
    fail('recovery: lone-boot fallback fired despite a live peer')
  }
  // and they actually mesh: a sees b as a connected peer
  const meshed = await a.frame.waitForFunction(() =>
    [...window.__jig.net.peers.values()].some((p) => p.connected), null, { timeout: 15000 })
    .then(() => true).catch(() => false)
  if (!meshed) fail('recovery: a never connected to the recovered b')
  else console.log('state-push recovery with a live peer: ok')
  await a.page.close()
  await b.page.close()
}

// --- scenario 3: a stale expired own membership must be cleared, not
// inherited (the sdk preserves created_ts on rejoin, so without the
// pre-join cleanup every fresh membership is born expired and the
// device can never rejoin) ---
{
  const page = await browser.newPage()
  await page.goto(`${base}/mock.html?room=lb${Math.random().toString(36).slice(2, 8)}&staleOwnMembership=1`)
  await page.waitForFunction(() => {
    const w = document.getElementById('widget')?.contentWindow
    return !!(w && w.__jig && w.__jig.session)
  }, null, { timeout: 30000 })
  const frame = page.frames().find((f) => f !== page.mainFrame())
  const ready = await frame.waitForFunction(() => window.__jig.session.ready(), null, { timeout: 20000 })
    .then(() => true).catch(() => false)
  const logs = await frame.evaluate(() =>
    [...document.querySelectorAll('#log div')].map((d) => d.textContent))
  if (!logs.some((l) => l.includes('clearing our stale rtc membership'))) {
    fail(`stale membership was not cleared before joining: ${logs.slice(-6).join(' | ')}`)
  }
  if (!ready) fail('session never started with a stale own membership seeded')
  else console.log('stale expired membership cleared before rejoin: ok')
  await page.close()
}

if (process.exitCode !== 1) console.log('LONEBOOT TEST PASSED')
await browser.close()

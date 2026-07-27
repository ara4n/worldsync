// World persistence e2e under the mock widget host. Persistence is OFF by
// default: a world whose sessions all die comes back empty. Flipping the
// panel's "persist world" checkbox makes the root peer checkpoint the
// settled sim into org.worldsync.checkpoint room state - INLINE in the
// event under the size budget, a media-repo CBOR blob with a pointer
// event over it - and the next peer to ROOT a fresh tick grid restores
// the world from it as a boot seam.
//
// The mock host's room state lives in the PARENT pages (BroadcastChannel
// gossip), so a tab whose widget iframe is removed keeps serving state as
// a "homeserver" while its dead widget's membership lingers as a ghost -
// exactly the shape a fresh joiner roots through (3s ghost grace).
// Run the dev server first: npm run dev
import { chromium } from 'playwright'

const base = process.env.URL ?? 'http://localhost:5173'
const room = 'ps' + Math.random().toString(36).slice(2, 8)
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
  return { page, frame: page.frames().find(f => f !== page.mainFrame()) }
}

/** kill the widget but keep the parent alive as the room's state keeper */
const killWidget = t => t.page.evaluate(() => document.getElementById('widget').remove())

const checkpoint = t => t.page.evaluate(() => {
  const ev = window.__mockhost.driver.state.get('org.worldsync.checkpoint|')
  return ev ? ev.content : null
})

const spawnGrid = (t, n, x0) => t.frame.evaluate(([count, ox]) => {
  const s = window.__jig.session
  const ids = []
  for (let i = 0; i < count; i++) {
    const id = s.nextNetId()
    // resting height, spread so nothing piles: poses settle immediately
    s.emit('spawn', id, {
      pos: { x: ox + (i % 13) * 1.4, y: 0.5, z: Math.floor(i / 13) * 1.4 },
      color: 0xff8800,
    })
    ids.push(id)
  }
  return ids
}, [n, x0])

const positions = (t, ids) => t.frame.evaluate(ns =>
  Object.fromEntries(ns.map(n => [n, window.__jig.pos(n)])), ids)

const bodyCount = t => t.frame.evaluate(() => [...window.__jig.sim.bodies.keys()].filter(k => !k.startsWith("avatar:")).length)

// --- default off: a world with no checkpoint dies with its sessions ---
const a = await open('a')
await spawnGrid(a, 3, 0)
await a.page.waitForTimeout(2000)
const b = await open('b') // state keeper; its widget adopts a's world
await b.frame.waitForFunction(() => [...window.__jig.sim.bodies.keys()].filter(k => !k.startsWith("avatar:")).length === 3, null, { timeout: 10000 })
  .catch(async () => fail(`b never saw a's boxes (${await bodyCount(b)})`))
await a.page.close()
await killWidget(b)
const c = await open('c') // roots through the ghosts after the 3s grace
await c.page.waitForTimeout(3000)
if (await bodyCount(c) !== 0) fail(`world persisted without opt-in: c has ${await bodyCount(c)} bodies`)
if (await checkpoint(c) !== null) fail('a checkpoint event exists but persistence was never enabled')

// --- opt in: inline checkpoint, restored by the next rooter ---
const cIds = await spawnGrid(c, 3, 0)
await c.frame.check('#persist')
await c.page.waitForFunction(() => {
  const ev = window.__mockhost.driver.state.get('org.worldsync.checkpoint|')
  const ct = ev && ev.content
  return !!(ct && ct.persist === true && Array.isArray(ct.entities) && ct.entities.length === 3)
}, null, { timeout: 30000 })
  .catch(async () => fail(`inline checkpoint never appeared: ${JSON.stringify(await checkpoint(c))?.slice(0, 200)}`))
const cpInline = await checkpoint(c)
if (cpInline && cpInline.url) fail('small checkpoint went to the media repo instead of inline')
const cPos = await positions(c, cIds)
await killWidget(c)

const d = await open('d')
await d.frame.waitForFunction(() => [...window.__jig.sim.bodies.keys()].filter(k => !k.startsWith("avatar:")).length === 3, null, { timeout: 15000 })
  .catch(async () => fail(`d never restored the checkpoint (${await bodyCount(d)} bodies)`))
if (!await d.frame.evaluate(() => document.getElementById('persist').checked)) {
  fail('d: persist checkbox does not reflect the room flag')
}
const dPos = await positions(d, cIds)
for (const id of cIds) {
  const p0 = cPos[id], p1 = dPos[id]
  if (!p0 || !p1) { fail(`restored box ${id} missing (${JSON.stringify(p1)})`); continue }
  const dd = Math.hypot(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z)
  if (dd > 0.05) fail(`restored box ${id} moved ${dd.toFixed(3)}m from its checkpointed pose`)
}
console.log('inline checkpoint restored: 3 boxes, poses within tolerance')

// --- a dump too big for the event goes to the media repo by pointer ---
// clear of the ground slab's edge (x=-20) AND of the restored phase-2 grid
const dIds = await spawnGrid(d, 150, -19)
await d.page.waitForFunction(() => {
  const ev = window.__mockhost.driver.state.get('org.worldsync.checkpoint|')
  const ct = ev && ev.content
  return !!(ct && typeof ct.url === 'string' && ct.url.startsWith('mxc://') && !ct.entities)
}, null, { timeout: 45000 })
  .catch(async () => fail(`offloaded checkpoint never appeared: ${JSON.stringify(await checkpoint(d))?.slice(0, 200)}`))
const dAll = await positions(d, dIds.slice(0, 5))
await killWidget(d)

const e = await open('e')
await e.frame.waitForFunction(() => [...window.__jig.sim.bodies.keys()].filter(k => !k.startsWith("avatar:")).length === 153, null, { timeout: 20000 })
  .catch(async () => fail(`e never restored the mxc checkpoint (${await bodyCount(e)} bodies)`))
const ePos = await positions(e, dIds.slice(0, 5))
for (const id of dIds.slice(0, 5)) {
  const p0 = dAll[id], p1 = ePos[id]
  const dd = p0 && p1 ? Math.hypot(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z) : Infinity
  if (dd > 0.05) fail(`mxc-restored box ${id} off by ${dd === Infinity ? 'missing' : dd.toFixed(3) + 'm'}`)
}
console.log('mxc checkpoint restored: 153 boxes')

// --- opting back out clears everything ---
await e.frame.uncheck('#persist')
await e.page.waitForFunction(() => {
  const ev = window.__mockhost.driver.state.get('org.worldsync.checkpoint|')
  return !!ev && Object.keys(ev.content).length === 0
}, null, { timeout: 10000 })
  .catch(async () => fail(`persist-off left data behind: ${JSON.stringify(await checkpoint(e))?.slice(0, 200)}`))
console.log('persist off: checkpoint cleared')

await browser.close()
console.log(process.exitCode ? 'persist test FAILED' : 'persist test PASSED')

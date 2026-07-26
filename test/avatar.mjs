// End-to-end avatar test (headed): two pages join the same room in the
// DEFAULT nav mode (walk), grow avatar collider bodies + figures on both
// sims, and the cosmetic avatar plane drives the remote figure: locomotion
// clips from velocity (Idle -> Walk -> Run, Fall1 mid-jump), head pitch
// tracking the walker's view, the left arm aiming at a selection. The
// collider is real: walking into a box shoves it identically on both
// peers. Run the dev server first: npm run dev
import { chromium } from 'playwright'

const base = process.env.URL ?? 'http://localhost:5173'
const room = 'avatar-' + Math.random().toString(36).slice(2, 8)
const errors = []

const browser = await chromium.launch({ headless: false })

async function open(name) {
  const page = await browser.newPage({ viewport: { width: 900, height: 640 } })
  page.on('pageerror', e => errors.push(`${name}: ${e}`))
  page.on('console', m => {
    if (m.type() !== 'error') return
    const url = m.location()?.url ?? ''
    if (/favicon/.test(url) || /favicon/.test(m.text())) return
    errors.push(`${name}: ${m.text()} (${url})`)
  })
  await page.goto(`${base}/?room=${room}`)
  await page.waitForFunction(() => window.__jig?.session?.ready(), null, { timeout: 15000 })
  return page
}

function fail(msg) {
  console.error('FAIL:', msg)
  process.exitCode = 1
}

const a = await open('a')
const b = await open('b')
const peered = p =>
  p.waitForFunction(() => [...window.__jig.net.peers.values()].some(x => x.connected), null, { timeout: 20000 })
await Promise.all([peered(a), peered(b)])
console.log('peers connected')

// -- walk is the default; both peers grow avatar bodies + figures --
if (await a.evaluate(() => window.__jig.nav.effective()) !== 'walk') fail('default nav mode is not walk')
for (const [name, p] of [['a', a], ['b', b]]) {
  const ok = await p.waitForFunction(() =>
    [...window.__jig.sim.bodies.keys()].filter(k => k.startsWith('avatar:')).length === 2
    && Object.keys(window.__jig.avatars()).length === 2, null, { timeout: 20000 })
    .then(() => true).catch(() => false)
  if (!ok) fail(`${name}: avatar bodies/figures never appeared`)
}
const aId = await a.evaluate(() => window.__jig.session.id)
const bId = await b.evaluate(() => window.__jig.session.id)
const dims = await a.evaluate(id => window.__jig.sim.boxDims(`avatar:${id}`), aId)
if (!dims || Math.abs(dims.y - 1.7) > 1e-6) fail(`avatar collider dims wrong: ${JSON.stringify(dims)}`)
console.log('avatar bodies + figures on both peers')

// -- spawn slots: similar but non-overlapping --
const spots = await a.evaluate(() => Object.values(window.__jig.avatars()).map(v => v.pos))
const gap = Math.hypot(spots[0].x - spots[1].x, spots[0].z - spots[1].z)
if (gap < 1 || gap > 4) fail(`spawn spacing ${gap.toFixed(2)}m (wanted ~1.4m apart)`)
console.log(`spawn slots ${gap.toFixed(2)}m apart`)

// -- own figure hides in first person, shows out of body --
await a.waitForTimeout(1500) // let the GLB land
if (await a.evaluate(id => window.__jig.avatars()[id].visible, aId)) fail('own figure visible in first person')
if (!await a.evaluate(id => window.__jig.avatars()[id].visible, bId)) fail("peer's figure hidden on a")

// -- locomotion: b watches a walk, then run --
const clipOn = (p, id) => p.evaluate(pid => window.__jig.avatars()[pid]?.clip, id)
await a.bringToFront()
await a.keyboard.down('w')
const sawWalk = await b.waitForFunction(pid => window.__jig.avatars()[pid]?.clip === 'Walk', aId, { timeout: 3000 })
  .then(() => true).catch(() => false)
if (!sawWalk) fail(`b never saw a Walk (saw ${await clipOn(b, aId)})`)
await a.keyboard.down('Shift')
const sawRun = await b.waitForFunction(pid => window.__jig.avatars()[pid]?.clip === 'Run', aId, { timeout: 3000 })
  .then(() => true).catch(() => false)
if (!sawRun) fail(`b never saw a Run (saw ${await clipOn(b, aId)})`)
await a.keyboard.up('Shift')
await a.keyboard.up('w')
const sawIdle = await b.waitForFunction(pid => window.__jig.avatars()[pid]?.clip === 'Idle', aId, { timeout: 3000 })
  .then(() => true).catch(() => false)
if (!sawIdle) fail(`b never saw a return to Idle (saw ${await clipOn(b, aId)})`)
console.log('locomotion clips replicate: Walk, Run, Idle')

// -- jump reads as airborne --
await a.keyboard.press('Space')
const sawFall = await b.waitForFunction(pid => window.__jig.avatars()[pid]?.clip === 'Fall1', aId, { timeout: 2000 })
  .then(() => true).catch(() => false)
if (!sawFall) fail('b never saw a airborne (Fall1) during the jump')
console.log('jump replicates as Fall1')

// -- the remote figure's position tracks the walker --
const posA = await a.evaluate(() => window.__jig.nav.avatarState.pos)
const posOnB = await b.evaluate(pid => window.__jig.avatars()[pid].pos, aId)
await b.waitForTimeout(400) // smoothing tail
const posOnB2 = await b.evaluate(pid => window.__jig.avatars()[pid].pos, aId)
if (Math.hypot(posOnB2.x - posA.x, posOnB2.z - posA.z) > 0.5) {
  fail(`remote figure ${JSON.stringify(posOnB2)} far from walker ${JSON.stringify(posA)}`)
}
void posOnB
console.log('remote figure tracks the walker')

// -- head pitch: a looks up, b's copy of a tilts its head --
await a.keyboard.down('ArrowUp')
await a.waitForTimeout(700)
await a.keyboard.up('ArrowUp')
const pitched = await b.waitForFunction(pid =>
  (window.__jig.avatars()[pid]?.headPitch ?? 0) > 0.4, aId, { timeout: 2000 })
  .then(() => true).catch(() => false)
if (!pitched) fail('remote head never pitched up')
await a.keyboard.down('ArrowDown')
await a.waitForTimeout(700)
await a.keyboard.up('ArrowDown')
console.log('head pitch replicates')

// -- left arm aims at the selection, for as long as it lasts --
await a.evaluate(() => {
  window.__jig.session.emit('spawn', 'aim-box', { pos: { x: 4, y: 1.5, z: 4 }, color: 0xff5533 })
})
await a.waitForFunction(() => window.__jig.sim.bodies.has('aim-box'), null, { timeout: 3000 })
await a.evaluate(() => {
  const eid = window.__jig.sim.ecs.entityFor('aim-box')
  window.__jig.nav.clickedBox(eid, 'aim-box', window.__jig.view.meshes.get(eid))
})
const aimed = await b.waitForFunction(pid =>
  (window.__jig.avatars()[pid]?.aimWeight ?? 0) > 0.5, aId, { timeout: 3000 })
  .then(() => true).catch(() => false)
if (!aimed) fail('remote left arm never aimed at the selection')
await a.evaluate(() => window.__jig.nav.deselect())
const unaimed = await b.waitForFunction(pid =>
  (window.__jig.avatars()[pid]?.aimWeight ?? 0) < 0.2, aId, { timeout: 3000 })
  .then(() => true).catch(() => false)
if (!unaimed) fail('remote left arm kept aiming after deselect')
console.log('left-arm aim follows the selection')

// -- the collider is real: walking into a box shoves it, identically --
await a.evaluate(() => {
  const st = window.__jig.nav.avatarState
  // a faces its spawn yaw; put the box 2m along that facing at rest height
  const dx = -Math.sin(st.yaw) * 2, dz = -Math.cos(st.yaw) * 2
  window.__jig.session.emit('spawn', 'push-box',
    { pos: { x: st.pos.x + dx, y: 0.5, z: st.pos.z + dz }, color: 0x44bbee })
})
await b.waitForFunction(() => window.__jig.sim.bodies.has('push-box'), null, { timeout: 3000 })
await a.waitForTimeout(800) // let it settle on the floor
const boxBefore = await a.evaluate(() => window.__jig.pos('push-box'))
await a.keyboard.down('w')
await a.waitForTimeout(1400)
await a.keyboard.up('w')
await a.waitForTimeout(2500) // settle + latency drain
const [boxA, boxB] = await Promise.all(
  [a, b].map(p => p.evaluate(() => window.__jig.pos('push-box'))))
const pushed = Math.hypot(boxA.x - boxBefore.x, boxA.z - boxBefore.z)
if (pushed < 0.4) fail(`walking into the box only moved it ${pushed.toFixed(2)}m`)
const skew = Math.hypot(boxA.x - boxB.x, boxA.y - boxB.y, boxA.z - boxB.z)
if (skew > 1e-6) fail(`peers disagree about the pushed box by ${skew}m`)
console.log(`avatar collider shoved the box ${pushed.toFixed(2)}m, peers bit-equal`)

// -- convergence: settled hashes agree, replay self-checks pass --
for (const [name, p] of [['a', a], ['b', b]]) {
  const ok = await p.waitForFunction(() =>
    [...window.__jig.session.peers.values()].every(q => q.checked), null, { timeout: 40000 })
    .then(() => true).catch(() => false)
  if (!ok) fail(`${name} never compared settled hashes`)
  const s = await p.evaluate(() => ({
    diverged: [...window.__jig.session.peers.values()].map(q => q.divergedAt),
    verify: window.__jig.sim.verifyReplay(60),
    anomalies: window.__jig.sim.anomalies,
  }))
  if (s.diverged.some(d => d !== null)) fail(`${name} latched divergence: ${JSON.stringify(s.diverged)}`)
  if (s.verify.posesMatch === false) fail(`${name} replay self-check failed`)
  if (s.anomalies.length) fail(`${name} anomalies: ${JSON.stringify(s.anomalies)}`)
}
console.log('hashes agree; replay self-checks pass')

// -- a departed peer takes its figure and collider with it --
await b.close()
const gone = await a.waitForFunction(id =>
  !window.__jig.avatars()[id] && !window.__jig.sim.bodies.has(`avatar:${id}`), bId, { timeout: 15000 })
  .then(() => true).catch(() => false)
if (!gone) fail("b's figure or collider survived its departure")
console.log('departed peer cleaned up (figure + collider)')

const realErrors = errors.filter(e => !/favicon/.test(e))
if (realErrors.length) fail(`console/page errors:\n${realErrors.join('\n')}`)

await browser.close()
console.log(process.exitCode ? 'AVATAR TEST FAILED' : 'AVATAR TEST PASSED')

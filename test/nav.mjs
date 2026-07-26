// End-to-end navigation test (headed): selection + HUD + edit gizmo on one
// page, resize/rotate protocol convergence across two, and the walk-mode
// avatar (WASD, jump, arrow look). Pointer-lock carrying is left to manual
// testing: synthetic CDP events carry no movementX/Y, so locked mouselook
// cannot be driven from here.
// Run the dev server first: npm run dev
import { chromium } from 'playwright'

const base = process.env.URL ?? 'http://localhost:5173'
const room = 'nav-' + Math.random().toString(36).slice(2, 8)
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

// -- spawn a box and let it settle --
const vp = a.viewportSize()
await a.mouse.click(vp.width / 2, vp.height / 2)
await a.waitForFunction(() => window.__jig.sim.bodies.size === 1, null, { timeout: 5000 })
await b.waitForFunction(() => window.__jig.sim.bodies.size === 1, null, { timeout: 5000 })
const netId = await a.evaluate(() => [...window.__jig.sim.bodies.keys()][0])
await a.waitForTimeout(1200)

// -- single-click selects (no grab: the box must not move) --
const before = await a.evaluate(id => window.__jig.pos(id), netId)
let pt = await a.evaluate(id => window.__jig.screenPos(id), netId)
await a.mouse.click(pt.x, pt.y)
await a.waitForFunction(() => !!window.__jig.nav.selection, null, { timeout: 2000 })
const selId = await a.evaluate(() => window.__jig.nav.selection.netId)
if (selId !== netId) fail(`selected ${selId}, expected ${netId}`)
await a.waitForTimeout(300)
const after = await a.evaluate(id => window.__jig.pos(id), netId)
if (Math.hypot(after.x - before.x, after.z - before.z) > 0.01) fail('selecting a box disturbed it')
console.log('click selected the box without disturbing it')

// -- click on empty ground deselects and must NOT spawn --
const empty = await a.evaluate(() => window.__jig.screenOfGround(6, 6))
await a.mouse.click(empty.x, empty.y)
await a.waitForFunction(() => !window.__jig.nav.selection, null, { timeout: 2000 })
await a.waitForTimeout(400)
if (await a.evaluate(() => window.__jig.sim.bodies.size) !== 1) fail('deselect click spawned a box')
console.log('empty click deselected without spawning')

// -- the next empty click spawns again --
await a.mouse.click(empty.x, empty.y)
await a.waitForFunction(() => window.__jig.sim.bodies.size === 2, null, { timeout: 3000 })
console.log('spawning still works with nothing selected')

// -- reselect, enable edit, drag the gizmo's center section --
pt = await a.evaluate(id => window.__jig.screenPos(id), netId)
await a.mouse.click(pt.x, pt.y)
await a.waitForFunction(() => !!window.__jig.nav.selection, null, { timeout: 2000 })
await a.click('#navhud >> text=edit')
await a.waitForFunction(() =>
  [...document.querySelectorAll('#navhud button')].some(b => b.textContent === 'rotate'), null, { timeout: 2000 })
console.log('edit HUD shows move/rotate/scale')

pt = await a.evaluate(id => window.__jig.screenPos(id), netId)
await a.mouse.move(pt.x, pt.y) // hover arms the gizmo's center (XYZ) handle
await a.mouse.down()
const gizmoState = await a.evaluate(() => ({
  dragging: window.__jig.nav.gizmo.dragging, axis: window.__jig.nav.gizmo.axis,
}))
if (!gizmoState.dragging) fail(`gizmo did not take the drag (axis ${gizmoState.axis})`)
for (let i = 1; i <= 10; i++) {
  await a.mouse.move(pt.x + i * 14, pt.y, { steps: 2 })
  await a.waitForTimeout(40)
}
await a.mouse.up()
await a.waitForTimeout(2000)
const ga = await a.evaluate(id => window.__jig.pos(id), netId)
const gb = await b.evaluate(id => window.__jig.pos(id), netId)
const gizmoDist = Math.hypot(ga.x - gb.x, ga.y - gb.y, ga.z - gb.z)
const moved = Math.hypot(ga.x - after.x, ga.z - after.z)
console.log(`gizmo translate moved ${moved.toFixed(2)}m (axis ${gizmoState.axis}), peers ${gizmoDist.toFixed(4)}m apart`)
if (moved < 0.5) fail('gizmo drag did not move the box')
if (gizmoDist > 0.05) fail('peers diverged after gizmo translate')

// -- esc deselects --
await a.keyboard.press('Escape')
await a.waitForFunction(() => !window.__jig.nav.selection, null, { timeout: 2000 })
console.log('esc deselected')

// -- resize op: replicated extents on both peers, meshes scaled --
await a.evaluate(id => {
  const p = window.__jig.pos(id)
  window.__jig.session.emit('resize', id, { pos: p, dims: { x: 2, y: 0.5, z: 1 } })
}, netId)
const dimsOk = d => d && Math.abs(d.x - 2) < 1e-9 && Math.abs(d.y - 0.5) < 1e-9 && Math.abs(d.z - 1) < 1e-9
await a.waitForFunction(id => { const d = window.__jig.sim.boxDims(id); return d && d.x === 2 }, netId, { timeout: 3000 })
await b.waitForFunction(id => { const d = window.__jig.sim.boxDims(id); return d && d.x === 2 }, netId, { timeout: 3000 })
const [da, db] = await Promise.all([
  a.evaluate(id => window.__jig.sim.boxDims(id), netId),
  b.evaluate(id => window.__jig.sim.boxDims(id), netId),
])
if (!dimsOk(da) || !dimsOk(db)) fail(`resize dims wrong: a=${JSON.stringify(da)} b=${JSON.stringify(db)}`)
const scaleB = await b.evaluate(id => {
  const eid = window.__jig.sim.ecs.entityFor(id)
  const m = window.__jig.view.meshes.get(eid)
  return { x: m.scale.x, y: m.scale.y, z: m.scale.z }
}, netId)
if (Math.abs(scaleB.x - 2) > 1e-6 || Math.abs(scaleB.y - 0.5) > 1e-6) fail(`mesh scale not applied: ${JSON.stringify(scaleB)}`)
console.log('resize replicated to both sims and meshes')

// -- rotation over the pose plane: grab, stream a 45-degree yaw, release --
await a.waitForTimeout(800) // let the reshaped box settle
await a.evaluate(id => {
  const p = window.__jig.pos(id)
  window.__jig.session.emit('grab', id, { pos: p })
}, netId)
const yaw45 = { x: 0, y: Math.sin(Math.PI / 8), z: 0, w: Math.cos(Math.PI / 8) }
for (let i = 0; i < 8; i++) {
  await a.evaluate(({ id, rot }) => {
    const p = window.__jig.pos(id)
    window.__jig.session.streamPose(id, p, rot)
  }, { id: netId, rot: yaw45 })
  await a.waitForTimeout(50)
}
await a.evaluate(({ id, rot }) => {
  const p = window.__jig.pos(id)
  window.__jig.session.emit('release', id, { pos: p, vel: { x: 0, y: 0, z: 0 }, rot })
}, { id: netId, rot: yaw45 })
await a.waitForTimeout(2000)
const rot = page => page.evaluate(id => {
  const r = window.__jig.sim.body(id).rotation()
  return { x: r.x, y: r.y, z: r.z, w: r.w }
}, netId)
const [ra, rb] = await Promise.all([rot(a), rot(b)])
const rotDiff = Math.hypot(ra.x - rb.x, ra.y - rb.y, ra.z - rb.z, ra.w - rb.w)
console.log(`rotation a=${JSON.stringify(ra)} (peers differ by ${rotDiff.toExponential(2)})`)
if (Math.abs(Math.abs(ra.y) - Math.sin(Math.PI / 8)) > 0.08) fail('streamed rotation did not take (yaw not ~45deg)')
if (rotDiff > 1e-6) fail('peers diverged on streamed rotation')

// -- walk mode on page B: fall to eye height, WASD, jump, arrow look --
await b.evaluate(() => window.__jig.nav.setUserMode('walk'))
await b.waitForFunction(() => Math.abs(window.__jig.view.camera.position.y - 1.6) < 0.05, null, { timeout: 4000 })
console.log('walker landed at eye height')

const camXZ = page => page.evaluate(() => {
  const c = window.__jig.view.camera.position
  return { x: c.x, z: c.z }
})
const w0 = await camXZ(b)
await b.keyboard.down('KeyW')
await b.waitForTimeout(600)
await b.keyboard.up('KeyW')
const w1 = await camXZ(b)
const walked = Math.hypot(w1.x - w0.x, w1.z - w0.z)
console.log(`walked ${walked.toFixed(2)}m in 0.6s`)
if (walked < 1 || walked > 4) fail(`WASD walk moved ${walked.toFixed(2)}m, expected ~2.4`)

await b.keyboard.down('ShiftLeft')
await b.keyboard.down('KeyS')
await b.waitForTimeout(400)
await b.keyboard.up('KeyS')
await b.keyboard.up('ShiftLeft')
const w2 = await camXZ(b)
const ran = Math.hypot(w2.x - w1.x, w2.z - w1.z)
console.log(`ran ${ran.toFixed(2)}m in 0.4s`)
// walking covers ~1.6m in 0.4s, running ~3.6m: demand clearly more than a
// walk (a lenient bound here once masked shift never registering at all)
if (ran < 2.2) fail(`shift-run covered ${ran.toFixed(2)}m in 0.4s, expected ~3.6 (run), not ~1.6 (walk)`)

// -- strafe must be relative to facing: look down -x, D must move -z
// (right vector (cos yaw, 0, -sin yaw); a sign slip here once mirrored
// strafing over half the compass) --
await b.evaluate(() => {
  const c = window.__jig.view.camera.position
  window.__jig.nav.setCameraPose({ x: c.x, y: c.y, z: c.z }, { x: c.x - 5, y: c.y, z: c.z })
})
await b.waitForTimeout(150)
const s0 = await camXZ(b)
await b.keyboard.down('KeyD')
await b.waitForTimeout(400)
await b.keyboard.up('KeyD')
const s1 = await camXZ(b)
console.log(`strafe D while facing -x: dx=${(s1.x - s0.x).toFixed(2)} dz=${(s1.z - s0.z).toFixed(2)}`)
if (s1.z - s0.z > -1 || Math.abs(s1.x - s0.x) > 0.5) {
  fail(`strafe is not facing-relative (expected dz ~ -1.6, dx ~ 0)`)
}

await b.keyboard.press('Space')
let apex = 0
for (let i = 0; i < 14; i++) {
  apex = Math.max(apex, await b.evaluate(() => window.__jig.view.camera.position.y))
  await b.waitForTimeout(60)
}
console.log(`jump apex ${apex.toFixed(2)}m`)
if (apex < 2.1) fail(`jump apex ${apex.toFixed(2)}m, expected > 2.1`)
await b.waitForFunction(() => Math.abs(window.__jig.view.camera.position.y - 1.6) < 0.05, null, { timeout: 3000 })

const yaw0 = await b.evaluate(() => window.__jig.view.camera.rotation.y)
await b.keyboard.down('ArrowLeft')
await b.waitForTimeout(400)
await b.keyboard.up('ArrowLeft')
const yaw1 = await b.evaluate(() => window.__jig.view.camera.rotation.y)
if (Math.abs(yaw1 - yaw0) < 0.3) fail(`arrow look turned ${(yaw1 - yaw0).toFixed(2)}rad, expected ~0.7`)
console.log(`arrow look turned ${(yaw1 - yaw0).toFixed(2)}rad`)

// -- drag-look fallback: hosts whose iframe cannot pointer-lock (Element
// Web today) still get mouselook by dragging empty space --
await b.evaluate(() => { window.__jig.nav.lockBroken = true })
const dl0 = await b.evaluate(() => window.__jig.view.camera.rotation.y)
await b.mouse.move(250, 120) // sky: safely above the horizon, no boxes
await b.mouse.down()
await b.mouse.move(550, 120, { steps: 8 })
await b.mouse.up()
const dl1 = await b.evaluate(() => window.__jig.view.camera.rotation.y)
if (Math.abs(dl1 - dl0) < 0.3) fail(`drag-look turned ${(dl1 - dl0).toFixed(2)}rad, expected ~0.66`)
console.log(`drag-look turned ${(dl1 - dl0).toFixed(2)}rad`)

// -- selecting while walking must NOT pop the camera (and deselecting
// must hand back to walk equally seamlessly) --
await b.evaluate(id => {
  const cam = window.__jig.view.camera.position
  window.__jig.nav.setCameraPose({ x: cam.x, y: cam.y, z: cam.z }, window.__jig.pos(id))
}, netId)
await b.waitForTimeout(200)
const camPose = () => b.evaluate(() => ({
  p: window.__jig.view.camera.position.toArray(),
  q: window.__jig.view.camera.quaternion.toArray(),
}))
const poseDelta = (u, v) => Math.max(
  Math.hypot(...u.p.map((n, i) => n - v.p[i])),
  1 - Math.abs(u.q.reduce((s, n, i) => s + n * v.q[i], 0)))
const c0 = await camPose()
const spt = await b.evaluate(id => window.__jig.screenPos(id), netId)
await b.mouse.click(spt.x, spt.y)
await b.waitForFunction(() => !!window.__jig.nav.selection, null, { timeout: 2000 })
await b.waitForTimeout(500) // damping and clamps get a chance to misbehave
const c1 = await camPose()
if (poseDelta(c0, c1) > 0.01) fail(`selecting while walking popped the camera (delta ${poseDelta(c0, c1).toFixed(4)})`)
await b.keyboard.press('Escape')
await b.waitForFunction(() => !window.__jig.nav.selection, null, { timeout: 2000 })
await b.waitForTimeout(300)
const c2 = await camPose()
if (poseDelta(c0, c2) > 0.01) fail(`deselecting popped the camera (delta ${poseDelta(c0, c2).toFixed(4)})`)
console.log('select and deselect left the camera untouched')
await b.evaluate(() => { window.__jig.nav.lockBroken = false })

await b.evaluate(() => window.__jig.nav.setUserMode('orbit'))
await b.waitForFunction(() => window.__jig.view.controls.enabled, null, { timeout: 2000 })
console.log('back to orbit')

// -- the sims must still agree after all of it --
await a.waitForTimeout(1000)
const getLog = page => page.evaluate(() =>
  JSON.stringify([...window.__jig.sim.inputLog].sort((x, y) =>
    x.tick - y.tick || x.order - y.order || x.seq - y.seq)))
const [logA, logB] = await Promise.all([getLog(a), getLog(b)])
if (logA !== logB) fail('peers fed different inputs to their sims')
console.log(`input logs identical (${JSON.parse(logA).length} entries)`)

const realErrors = errors.filter(e => !/favicon/.test(e))
if (realErrors.length) fail(`console/page errors:\n${realErrors.join('\n')}`)

await browser.close()
console.log(process.exitCode ? 'NAV TEST FAILED' : 'NAV TEST PASSED')

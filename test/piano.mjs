// Pianola e2e under the mock widget host: tab a uploads the rigged
// piano.glb world plus examples/piano.js, and both tabs' scripts must
// find the key nodes in the scene. MIDI injected on a (__jig.midi, the
// hardware-free path through the exact hardware pipe) must dip the
// matching key NODES on both tabs - locally via direct delivery, on b
// via the cosmetic 'midi' broadcast - and SOUND on both: the glb
// carries the Salamander samples as KHR_audio, so the engine must
// decode all 30 and hold voices while the chord is down. Clicking a
// key must perform it (world.sendMidi): dip + sound on BOTH tabs,
// still capturing the gesture away from box spawning. Nothing folds:
// the world needs no script-seeded collider (the scene trimesh is the
// case).
// Run the dev server first: npm run dev
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'

const base = process.env.URL ?? 'http://localhost:5173'
const room = 'pn' + Math.random().toString(36).slice(2, 8)
const browser = await chromium.launch({
  headless: false,
  // let AudioContext run without a user gesture: the audio assertions
  // must hear the injected chord before any click happens
  args: ['--autoplay-policy=no-user-gesture-required'],
})
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

const rotX = (f, name) => f.evaluate(n => {
  const o = window.__jig.view.scene.getObjectByName(n)
  return o ? o.rotation.x : null
}, name)
const waitDown = (f, note, why) =>
  f.waitForFunction(n => {
    const o = window.__jig.view.scene.getObjectByName(`key_${n}`)
    return !!o && o.rotation.x > 0.03
  }, note, { timeout: 10000 })
    .catch(async () => fail(`${why}: key_${note} never dipped (rot ${await rotX(f, `key_${note}`)})`))
const waitUp = (f, note, why) =>
  f.waitForFunction(n => {
    const o = window.__jig.view.scene.getObjectByName(`key_${n}`)
    return !!o && o.rotation.x < 0.005
  }, note, { timeout: 10000 })
    .catch(async () => fail(`${why}: key_${note} never released (rot ${await rotX(f, `key_${note}`)})`))

const a = await open('a')
const b = await open('b')
await a.page.waitForTimeout(1000)

// the world: rigged glb scene first, then the pianola script
await a.frame.setInputFiles('#scenefile', {
  name: 'piano.glb', mimeType: 'model/gltf-binary', buffer: readFileSync('examples/piano.glb'),
})
for (const [t, name] of [[a, 'a'], [b, 'b']]) {
  await t.frame.waitForFunction(() =>
    !!window.__jig.view.scene.getObjectByName('key_60'), null, { timeout: 20000 })
    .catch(() => fail(`${name}: scene never showed the key rig`))
}
// the scene's KHR_audio samples must all decode before notes can sound
for (const [t, name] of [[a, 'a'], [b, 'b']]) {
  await t.frame.waitForFunction(() => {
    const s = window.__jig.audio()
    return s.context === 'running' && s.samples === 30
  }, null, { timeout: 20000 })
    .catch(async () => fail(`${name}: scene audio never came up `
      + `(${JSON.stringify(await t.frame.evaluate(() => window.__jig.audio()))})`))
}
console.log('piano.glb world up on both tabs (30 samples decoded); uploading pianola script...')
await a.frame.setInputFiles('#scriptfile', {
  name: 'piano.js', mimeType: 'text/javascript', buffer: readFileSync('examples/piano.js'),
})
// the script's rig() bakes the HUD once every key node is found
for (const [t, name] of [[a, 'a'], [b, 'b']]) {
  await t.frame.waitForFunction(() =>
    (document.getElementById('hud')?.textContent ?? '').includes('pianola'), null, { timeout: 20000 })
    .catch(() => fail(`${name}: script never rigged the keys`))
}

// a C-major chord injected on a: both tabs' key nodes must dip
console.log('injecting C-major on a...')
await a.frame.evaluate(() => {
  window.__jig.midi(0x90, 60, 100)
  window.__jig.midi(0x90, 64, 90)
  window.__jig.midi(0x90, 67, 110)
})
for (const n of [60, 64, 67]) {
  await waitDown(a.frame, n, 'a chord down (local delivery)')
  await waitDown(b.frame, n, 'b chord down (midi broadcast)')
}
// ...and sound on both: three voices sounding while the chord is held
for (const [t, name] of [[a, 'a'], [b, 'b']]) {
  await t.frame.waitForFunction(() => window.__jig.audio().sounding >= 3, null, { timeout: 5000 })
    .catch(async () => fail(`${name}: chord never sounded `
      + `(${JSON.stringify(await t.frame.evaluate(() => window.__jig.audio()))})`))
}

// release two ways: explicit noteoff and the noteon-velocity-0 idiom
await a.frame.evaluate(() => {
  window.__jig.midi(0x80, 60, 0)
  window.__jig.midi(0x90, 64, 0)
  window.__jig.midi(0x80, 67, 0)
})
for (const n of [60, 64, 67]) {
  await waitUp(a.frame, n, 'a chord up')
  await waitUp(b.frame, n, 'b chord up')
}
// released voices ramp out and end; nothing may keep sounding
for (const [t, name] of [[a, 'a'], [b, 'b']]) {
  await t.frame.waitForFunction(() => window.__jig.audio().sounding === 0, null, { timeout: 5000 })
    .catch(() => fail(`${name}: voices kept sounding after noteoff`))
}

// clicking a key performs it (world.sendMidi): interactable scene-node
// picking must capture the gesture (no box spawns), dip the clicked key
// while held, and sound + dip on b too via the broadcast
console.log('clicking key_84 on a...')
await a.frame.evaluate(() => {
  const v = window.__jig.view
  v.camera.position.set(0.9, 1.6, 1.3)
  v.controls.target.set(0.45, 0.74, 0.2)
  v.controls.update()
})
await a.page.waitForTimeout(300)
const off = await a.page.locator('#widget').boundingBox()
const s = await a.frame.evaluate(() => {
  const key = window.__jig.view.scene.getObjectByName('key_84')
  const p = key.getWorldPosition(key.position.clone())
  return window.__jig.screenOfWorld(p.x, 0.745, 0.3) // the key's front, top face
})
await a.page.mouse.move(off.x + s.x, off.y + s.y)
await a.page.mouse.down()
await waitDown(a.frame, 84, 'a clicked key down')
await waitDown(b.frame, 84, 'b clicked key down (sendMidi broadcast)')
for (const [t, name] of [[a, 'a'], [b, 'b']]) {
  await t.frame.waitForFunction(() => window.__jig.audio().sounding >= 1, null, { timeout: 5000 })
    .catch(() => fail(`${name}: clicked key never sounded`))
}
await a.page.mouse.up()
await waitUp(a.frame, 84, 'a clicked key up')
await waitUp(b.frame, 84, 'b clicked key up')
const spawned = await a.frame.evaluate(() => window.__jig.sim.bodies.size)
if (spawned !== 0) fail(`click was not captured: ${spawned} box(es) spawned`)

// nothing folds in this world: no props, no script-seeded colliders
const props = await a.frame.evaluate(() => window.__jig.sim.props.size)
if (props !== 0) fail(`expected no folded props, found ${props}`)

console.log(process.exitCode ? 'PIANO TEST FAILED' : 'PIANO TEST PASSED')
await browser.close()
process.exit()

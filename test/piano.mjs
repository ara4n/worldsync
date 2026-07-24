// Pianola e2e under the mock widget host: tab a uploads examples/piano.js,
// both tabs place the cosmetic grand piano, then MIDI injected on a
// (__jig.midi, the hardware-free path through the exact same pipe) must
// dip the matching keys on BOTH tabs - locally via direct delivery, on b
// via the cosmetic 'midi' broadcast. Note-off must release them, and the
// primary must seed exactly one case collider as folded sim state.
// Run the dev server first: npm run dev
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'

const base = process.env.URL ?? 'http://localhost:5173'
const room = 'pn' + Math.random().toString(36).slice(2, 8)
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

const pianoCount = f => f.evaluate(() => window.__jig.view.pianos.size)
const waitPiano = (f, why) =>
  f.waitForFunction(() => window.__jig.view.pianos.size === 1, null, { timeout: 15000 })
    .catch(async () => fail(`${why}: expected 1 piano, have ${await pianoCount(f)}`))
const pressed = f => f.evaluate(() =>
  [...[...window.__jig.view.pianos.values()][0].pressed].sort((a, b) => a - b))
const waitPressed = (f, want, why) =>
  f.waitForFunction(w =>
    JSON.stringify([...[...window.__jig.view.pianos.values()][0].pressed].sort((a, b) => a - b)) === w,
  JSON.stringify(want), { timeout: 10000 })
    .catch(async () => fail(`${why}: expected pressed ${JSON.stringify(want)}, have ${JSON.stringify(await pressed(f))}`))

const a = await open('a')
const b = await open('b')
await a.page().waitForTimeout(1000)

await a.setInputFiles('#scriptfile', {
  name: 'piano.js', mimeType: 'text/javascript', buffer: readFileSync('examples/piano.js'),
})
console.log('a uploaded piano.js; each tab should place its own grand piano...')

await waitPiano(a, 'a after upload')
await waitPiano(b, 'b after upload')

// the primary seeds exactly one case collider (folded sim state, replicated)
for (const [f, name] of [[a, 'a'], [b, 'b']]) {
  await f.waitForFunction(() =>
    [...window.__jig.sim.props.values()].filter(p => p.kind === 'collider').length === 1,
  null, { timeout: 15000 })
    .catch(() => fail(`${name}: expected exactly 1 case collider`))
}

// a C-major chord injected on a: both tabs' pianos must dip those keys
console.log('injecting C-major on a...')
await a.evaluate(() => {
  window.__jig.midi(0x90, 60, 100)
  window.__jig.midi(0x90, 64, 90)
  window.__jig.midi(0x90, 67, 110)
})
await waitPressed(a, [60, 64, 67], 'a chord down (local delivery)')
await waitPressed(b, [60, 64, 67], 'b chord down (midi broadcast)')

// release two ways: explicit noteoff and the noteon-velocity-0 idiom
await a.evaluate(() => {
  window.__jig.midi(0x80, 60, 0)
  window.__jig.midi(0x90, 64, 0)
  window.__jig.midi(0x80, 67, 0)
})
await waitPressed(a, [], 'a chord up')
await waitPressed(b, [], 'b chord up')

// keys must actually rotate: hold a note and check the mesh angle moved
await a.evaluate(() => window.__jig.midi(0x90, 108, 127))
await a.waitForFunction(() => {
  const piano = [...window.__jig.view.pianos.values()][0]
  return piano.keys.get(108).mesh.rotation.x > 0.03
}, null, { timeout: 5000 }).catch(() => fail('a: key 108 mesh never rotated'))
await a.evaluate(() => window.__jig.midi(0x80, 108, 0))

console.log(process.exitCode ? 'PIANO TEST FAILED' : 'PIANO TEST PASSED')
await browser.close()
process.exit()

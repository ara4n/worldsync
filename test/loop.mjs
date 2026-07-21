// Loop e2e: paint a same-colour square on the board's front face via ops,
// drag around it, and assert the chain snaps back through its starting dot
// (a loop) and that release clears the whole colour, not just the square.
// Run the dev server first: npm run dev
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'

const base = process.env.URL ?? 'http://localhost:5173'
const room = 'loop' + Math.random().toString(36).slice(2, 8)
const browser = await chromium.launch({ headless: false })
const ctx = await browser.newContext()

function fail(msg) {
  console.error('FAIL:', msg)
  process.exitCode = 1
}

const page = await ctx.newPage()
page.on('pageerror', e => console.error('pageerror:', String(e).slice(0, 200)))
await page.goto(`${base}/mock.html?room=${room}`)
await page.waitForFunction(() => {
  const f = document.getElementById('widget')
  const w = f && f.contentWindow
  return !!(w && w.__jig && w.__jig.session && w.__jig.session.ready())
}, null, { timeout: 30000 })
const frame = page.frames().find(f => f !== page.mainFrame())
const box = await page.locator('#widget').boundingBox()
const off = { x: box.x, y: box.y }

await frame.setInputFiles('#scriptfile', {
  name: 'dots.js', mimeType: 'text/javascript',
  buffer: readFileSync(new URL('../examples/dots.js', import.meta.url)),
})
await frame.waitForFunction(() => window.__jig.sim.props.size === 27, null, { timeout: 20000 })
console.log('board up')

// Paint the front-face square (z=2) colour C, the dots directly behind it
// colour D (so a grazed pick behind the face can never colour-match), and
// one far dot colour C to prove the loop clears colour-wide.
const C = 0xda664f, D = 0x9060b0
const SQUARE = [[0, 0], [1, 0], [1, 1], [0, 1]]
await frame.evaluate(([C, D, SQUARE]) => {
  const at = g => window.__jig.props().find(p =>
    Math.round(p.x + 1) === g[0] && Math.round(p.y - 1.4) === g[1] && Math.round(p.z + 1) === g[2])
  window.__loopIds = { square: [], extra: null }
  for (const [x, y] of SQUARE) {
    const p = at([x, y, 2])
    window.__loopIds.square.push(p.id)
    window.__jig.session.emit('paint', p.id, { pos: { x: 0, y: 0, z: 0 }, color: C })
    const behind = at([x, y, 1])
    window.__jig.session.emit('paint', behind.id, { pos: { x: 0, y: 0, z: 0 }, color: D })
  }
  const extra = at([2, 2, 2])
  window.__loopIds.extra = extra.id
  window.__jig.session.emit('paint', extra.id, { pos: { x: 0, y: 0, z: 0 }, color: C })
}, [C, D, SQUARE])
await page.waitForTimeout(500) // let the paints fold

const corner = async g => {
  const s = await frame.evaluate(([x, y]) => {
    const p = window.__jig.props().find(p =>
      Math.round(p.x + 1) === x && Math.round(p.y - 1.4) === y && Math.round(p.z + 1) === 2)
    return window.__jig.screenOfProp(p.id)
  }, g)
  return { x: off.x + s.x, y: off.y + s.y }
}

// drag the square: a -> b -> c -> d -> a
const path = [...SQUARE, SQUARE[0]]
const start = await corner(path[0])
await page.mouse.move(start.x, start.y)
await page.mouse.down()
await page.waitForTimeout(150)
for (const g of path.slice(1)) {
  const s = await corner(g)
  await page.mouse.move(s.x, s.y, { steps: 10 })
  await page.waitForTimeout(150)
}

// mid-drag: the shared chain line must have >= 5 chained points (the wire
// re-entered the starting dot), proving reselection snapped
const points = await frame.evaluate(() => {
  const mine = window.__jig.session.id + '/'
  for (const [key, l] of window.__jig.view.lines) {
    if (key.startsWith(mine) && l.obj.material.worldUnits) return JSON.parse(l.pointsKey).length
  }
  return 0
})
if (points < 5) fail(`chain line has ${points} points mid-loop; expected >= 5 (loop did not snap)`)
else console.log(`loop snapped: chain line has ${points} points`)

await page.mouse.up()

// the whole colour clears: square AND the far extra dot despawn, refills
// restore 27
const cleared = await frame.waitForFunction(() => {
  const gone = id => !window.__jig.sim.props.has(id)
  return window.__jig.props().length === 27
    && window.__loopIds.square.every(gone) && gone(window.__loopIds.extra)
}, null, { timeout: 15000 }).then(() => true).catch(() => false)
if (!cleared) {
  const state = await frame.evaluate(() => ({
    n: window.__jig.props().length,
    squareLeft: window.__loopIds.square.filter(id => window.__jig.sim.props.has(id)).length,
    extraLeft: window.__jig.sim.props.has(window.__loopIds.extra),
  }))
  fail(`loop did not clear the colour: ${JSON.stringify(state)}`)
} else {
  console.log('loop cleared the whole colour (square + far dot), board refilled to 27')
}

await browser.close()
if (process.exitCode) process.exit(process.exitCode)
console.log('LOOP TEST PASSED')

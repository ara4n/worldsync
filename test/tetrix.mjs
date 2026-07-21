// tetrix e2e under the mock widget host: a solo piece spawns claimed in
// lane 0 and falls under gravity; space hard-drops and locks it (cells
// become unclaimed at the bottom); a second tab widens the well and
// spawns in lane 1; then tab a hard-drops until the lane tops out and
// the well wipes.
// Run the dev server first: npm run dev
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'

const base = process.env.URL ?? 'http://localhost:5173'
const room = 'tx' + Math.random().toString(36).slice(2, 8)
const browser = await chromium.launch({
  headless: false,
  args: ['--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding'],
})
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })

function fail(msg) {
  console.error('FAIL:', msg)
  process.exitCode = 1
}

async function open() {
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.error('pageerror:', String(e).slice(0, 200)))
  await page.goto(`${base}/mock.html?room=${room}`)
  await page.waitForFunction(() => {
    const f = document.getElementById('widget')
    const w = f && f.contentWindow
    return !!(w && w.__jig && w.__jig.session && w.__jig.session.ready())
  }, null, { timeout: 30000 })
  return { page, frame: page.frames().find((f) => f !== page.mainFrame()) }
}

const CELL = 0.6, X0 = -9
const cellsOf = (ps) => ps.filter((p) => Math.abs(p.z) < 0.01 && p.y > 0 && p.y < 15 && p.x >= X0 - 1)
const colOf = (p) => Math.round((p.x - X0) / CELL)
const props = (f) => f.evaluate(() => window.__jig.props())

const a = await open()
await a.frame.setInputFiles('#scriptfile', {
  name: 'tetrix.js', mimeType: 'text/javascript', buffer: readFileSync('examples/tetrix.js'),
})
await a.frame.waitForFunction(
  () => [...document.querySelectorAll('#log div')].some((d) => d.textContent.includes('world script running')),
  null, { timeout: 20000 })

// a claimed 4-cell piece appears in lane 0 and falls
await a.frame.waitForFunction(() => window.__jig.props().filter((p) => p.claim).length === 4,
  null, { timeout: 15000 }).catch(() => fail('no claimed 4-cell piece appeared'))
let ps = cellsOf(await props(a.frame)).filter((p) => p.claim)
if (ps.some((p) => colOf(p) < 0 || colOf(p) > 4)) fail(`piece outside lane 0: cols ${ps.map(colOf)}`)
const y0 = Math.max(...ps.map((p) => p.y))
await a.page.waitForTimeout(2200)
ps = cellsOf(await props(a.frame)).filter((p) => p.claim)
if (!ps.length || Math.max(...ps.map((p) => p.y)) >= y0) fail('piece did not fall under gravity')
else console.log('spawn + gravity: ok')

// hard drop: the four cells land unclaimed at the bottom
await a.frame.click('canvas', { position: { x: 40, y: 40 } })
await a.page.keyboard.press(' ')
const locked = await a.frame.waitForFunction(() => {
  const cells = window.__jig.props().filter((p) => Math.abs(p.z) < 0.01 && p.y > 0 && p.y < 15)
  return cells.length >= 4 && cells.filter((p) => !p.claim).length >= 4
}, null, { timeout: 10000 }).then(() => true).catch(() => false)
if (!locked) fail('hard drop did not lock the piece')
else console.log('hard drop + lock: ok')

// second player: spawns in lane 1 of the widened well
const b = await open()
await b.frame.waitForFunction(
  () => [...document.querySelectorAll('#log div')].some((d) => d.textContent.includes('world script running')),
  null, { timeout: 20000 })
const laned = await b.frame.waitForFunction(() => {
  const mine = window.__jig.props().filter((p) => p.claim === window.__jig.session.id)
  return mine.length === 4 && mine.every((p) => {
    const c = Math.round((p.x - -9) / 0.6)
    return c >= 5 && c <= 9
  })
}, null, { timeout: 15000 }).then(() => true).catch(() => false)
if (!laned) fail('second player piece not confined to lane 1')
else console.log('two players, lane assignment: ok')

// line clear: fabricate a full unclaimed row mid-air (r=10) plus one
// cell above it (r=9); the primary must flash-clear the row and drop
// the straggler into it. Random pieces cannot be steered into a full
// row deterministically; the session API can.
const wy = (r) => 0.4 + (23 - r) * 0.6
await b.frame.evaluate(([X0, CELL]) => {
  const { session } = window.__jig
  const wyIn = (r) => 0.4 + (23 - r) * 0.6
  for (let c = 0; c < 15; c++) {
    session.emit('prop', session.nextNetId(),
      { pos: { x: X0 + c * CELL, y: wyIn(10), z: 0 }, color: 0x888888, shape: 'box', size: 0.29, unlit: true })
  }
  session.emit('prop', session.nextNetId(),
    { pos: { x: X0 + 3 * CELL, y: wyIn(9), z: 0 }, color: 0x33cc66, shape: 'box', size: 0.29, unlit: true })
}, [X0, CELL])
const clearedRow = await a.frame.waitForFunction(([yRow, yAbove]) => {
  const ps = window.__jig.props()
  const inRow = ps.filter((p) => Math.abs(p.y - yRow) < 0.01 && !p.claim)
  const above = ps.filter((p) => Math.abs(p.y - yAbove) < 0.01 && p.color === 0x33cc66)
  // the row is gone except the dropped green cell now sitting in it
  return above.length === 0 && inRow.length === 1 && inRow[0].color === 0x33cc66
}, [wy(10), wy(9)], { timeout: 15000 }).then(() => true).catch(() => false)
if (!clearedRow) fail('full row was not cleared (or the cell above did not drop)')
else console.log('line clear + stack drop: ok')

// stack lane 0 to the top: repeated hard drops must end in a wipe
await a.page.bringToFront()
await a.frame.click('canvas', { position: { x: 40, y: 40 } })
let wiped = false
for (let i = 0; i < 30 && !wiped; i++) {
  await a.frame.waitForFunction(() =>
    window.__jig.props().some((p) => p.claim === window.__jig.session.id),
    null, { timeout: 8000 }).catch(() => {})
  await a.page.keyboard.press(' ')
  await a.page.waitForTimeout(700)
  wiped = await a.frame.evaluate(() =>
    [...document.querySelectorAll('#log div')].some((d) => d.textContent.includes('TOP OUT')))
}
if (!wiped) fail('never topped out after 30 hard drops')
else {
  const cleared = await a.frame.waitForFunction(() =>
    window.__jig.props().filter((p) => !p.claim && Math.abs(p.z) < 0.01 && p.y > 0 && p.y < 15).length <= 4,
    null, { timeout: 10000 }).then(() => true).catch(() => false)
  if (!cleared) fail('well did not wipe after top out')
  else console.log('top out wipes the well: ok')
}

if (process.exitCode !== 1) console.log('TETRIX TEST PASSED')
await browser.close()

// Snake e2e under the mock widget host, two tabs: a parks until the
// first arrow key, then is steered into a number (must grow by its
// value), then into the wall (must crash and respawn parked). Tab b
// joins mid-race and must see a's segments in a's color.
// Run the dev server first: npm run dev
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'

const base = process.env.URL ?? 'http://localhost:5173'
const room = 'sn' + Math.random().toString(36).slice(2, 8)
// A backgrounded tab's snake keeps auto-moving but its ops get stamped
// late once the browser throttles it, tripping the sim's divergence
// detector; keep both racers at full speed like two visible windows.
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

async function open(name) {
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.error(`${name} pageerror:`, String(e).slice(0, 200)))
  await page.goto(`${base}/mock.html?room=${room}`)
  await page.waitForFunction(() => {
    const f = document.getElementById('widget')
    const w = f && f.contentWindow
    return !!(w && w.__jig && w.__jig.session && w.__jig.session.ready())
  }, null, { timeout: 30000 })
  return { page, frame: page.frames().find((f) => f !== page.mainFrame()) }
}

const CELL = 0.45, SEG = 0.21
const cellOf = (p) => ({ c: Math.round(p.x / CELL + 15.5), r: Math.round(p.z / CELL + 15.5) })
// the jig's props() has no size, so tell snakes from food by color: food
// is white (0xffffff); every peer accent color is something else
const state = (f) => f.evaluate(() => ({
  props: window.__jig.props(),
  color: window.__jig.session ? null : null,
}))
const snakes = (ps) => ps.filter((p) => p.color !== 0xffffff && p.y > 0.2 && p.y < 0.4)
const foods = (ps) => ps.filter((p) => p.color === 0xffffff && p.y > 0.2 && p.y < 0.4)

const a = await open('a')
await a.frame.setInputFiles('#scriptfile', {
  name: 'snake.js', mimeType: 'text/javascript', buffer: readFileSync('examples/snake.js'),
})
await a.frame.waitForFunction(
  () => [...document.querySelectorAll('#log div')].some((d) => d.textContent.includes('world script running')),
  null, { timeout: 20000 })

// parked: one segment, and it must not move without a key
await a.frame.waitForFunction(() => window.__jig.props().length >= 2, null, { timeout: 15000 })
let ps = (await state(a.frame)).props
const before = snakes(ps)
if (before.length !== 1) fail(`expected 1 parked segment, got ${before.length}`)
await a.page.waitForTimeout(1500)
ps = (await state(a.frame)).props
const still = snakes(ps)
if (still.length !== 1 || still[0].x !== before[0].x || still[0].z !== before[0].z) {
  fail('snake moved before any key was pressed')
}
console.log('parked until first key: ok')

// keys reach the widget's window only once the iframe has focus, exactly
// like a real user clicking into the world before steering (the click
// spawns a stray physics box; snake ignores boxes)
await a.frame.click('canvas', { position: { x: 40, y: 40 } })

// steer to a food with arrow keys; watch length grow by the value.
// values are not in the jig view, so read growth from segment count.
const myColor = still[0].color
const steer = async () => {
  const ps2 = (await state(a.frame)).props
  const segs = snakes(ps2).filter((p) => p.color === myColor)
  const fs = foods(ps2)
  if (!segs.length || !fs.length) return null
  // the head is unknowable from the table alone; aim the whole cloud:
  // steer from the segment nearest the target food
  let target = fs[0], head = segs[0], bd = 1e9
  for (const f of fs) for (const s of segs) {
    const fc = cellOf(f), sc = cellOf(s)
    const d = Math.abs(fc.c - sc.c) + Math.abs(fc.r - sc.r)
    if (d < bd) { bd = d; target = f; head = s }
  }
  const fc = cellOf(target), hc = cellOf(head)
  if (fc.c !== hc.c) await a.page.keyboard.press(fc.c > hc.c ? 'ArrowRight' : 'ArrowLeft')
  else if (fc.r !== hc.r) await a.page.keyboard.press(fc.r > hc.r ? 'ArrowDown' : 'ArrowUp')
  return { segs: segs.length, foods: fs.length }
}
const f0 = foods((await state(a.frame)).props).length
let grew = false
for (let i = 0; i < 120 && !grew; i++) {
  await steer()
  await a.page.waitForTimeout(300)
  const s = snakes((await state(a.frame)).props).filter((p) => p.color === myColor)
  if (s.length >= 4) grew = true // parked 1 grows to 3 while moving; >3 means it ate
}
if (!grew) fail('snake never grew past 3: no number was eaten')
else console.log('ate a number and grew: ok')

// b joins mid-race and sees a's snake
const b = await open('b')
await b.frame.waitForFunction(
  () => [...document.querySelectorAll('#log div')].some((d) => d.textContent.includes('world script running')),
  null, { timeout: 20000 })
const seen = await b.frame.waitForFunction((color) =>
  window.__jig.props().filter((p) => p.color === color).length >= 3,
  myColor, { timeout: 15000 }).then(() => true).catch(() => false)
if (!seen) fail('b does not see a\'s snake segments')
else console.log('late joiner sees the race: ok')

// drive a into the wall: hold one direction long enough to cross the grid
await a.page.bringToFront() // tab b stole the foreground; keys need a's
for (let i = 0; i < 40; i++) {
  await a.page.keyboard.press('ArrowRight')
  await a.page.waitForTimeout(250)
  const logs = await a.frame.evaluate(() =>
    [...document.querySelectorAll('#log div')].map((d) => d.textContent).join('\n'))
  if (logs.includes('crashed at length')) break
}
const crashed = await a.frame.evaluate(() =>
  [...document.querySelectorAll('#log div')].some((d) => d.textContent.includes('crashed at length')))
if (!crashed) fail('snake never crashed into the wall')
const respawned = await a.frame.waitForFunction((color) => {
  const segs = window.__jig.props().filter((p) => p.color === color)
  return segs.length === 1
}, myColor, { timeout: 10000 }).then(() => true).catch(() => false)
if (!respawned) fail('snake did not respawn parked after the crash')
else console.log('wall crash and respawn: ok')

if (process.exitCode !== 1) console.log('SNAKE TEST PASSED')
await browser.close()

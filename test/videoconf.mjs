// Video screens e2e under the mock widget host: tab a uploads the
// videoconf example, both tabs run it, and each lays out one screen per
// participant (mock transport = placeholder screens, no camera button).
// Closing b must collapse a's layout back to a single screen.
// Run the dev server first: npm run dev
import { chromium } from 'playwright'
import { readFile } from 'node:fs/promises'

const base = process.env.URL ?? 'http://localhost:5173'
const room = 'vc' + Math.random().toString(36).slice(2, 8)
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

const screenCount = f => f.evaluate(() => window.__jig.view.screens.size)
const waitScreens = (f, n, why) =>
  f.waitForFunction(want => window.__jig.view.screens.size === want, n, { timeout: 15000 })
    .catch(async () => fail(`${why}: expected ${n} screens, have ${await screenCount(f)}`))
const colliderCount = f => f.evaluate(() =>
  [...window.__jig.sim.props.values()].filter(p => p.kind === 'collider').length)
const waitColliders = (f, n, why) =>
  f.waitForFunction(want =>
    [...window.__jig.sim.props.values()].filter(p => p.kind === 'collider').length === want,
  n, { timeout: 15000 })
    .catch(async () => fail(`${why}: expected ${n} colliders, have ${await colliderCount(f)}`))

const a = await open('a')
const b = await open('b')
await a.page().waitForTimeout(1000)

const src = await readFile(new URL('../examples/videoconf.js', import.meta.url))
await a.setInputFiles('#scriptfile', { name: 'videoconf.js', mimeType: 'text/javascript', buffer: src })
console.log('a uploaded videoconf; each tab should lay out one screen per participant...')

await waitScreens(a, 2, 'a after upload')
await waitScreens(b, 2, 'b after upload')

// The screens are solid: the primary emits one collider prop per screen,
// and they replicate as sim state to both tabs.
await waitColliders(a, 2, 'a colliders')
await waitColliders(b, 2, 'b colliders')

// The mock transport has no media path: the camera button must stay hidden
// even though the script requested video.
for (const [f, name] of [[a, 'a'], [b, 'b']]) {
  const camVisible = await f.evaluate(() =>
    [...document.querySelectorAll('button')].some(el =>
      el.textContent.includes('camera') && el.style.display !== 'none'))
  if (camVisible) fail(`${name}: camera button visible on a transport with no media path`)
}

await b.page().close()
console.log('b closed; a should drop to one screen and one collider...')
await waitScreens(a, 1, 'a after b left')
await waitColliders(a, 1, 'a colliders after b left')

console.log(process.exitCode ? 'VIDEOCONF TEST FAILED' : 'VIDEOCONF TEST PASSED')
await browser.close()
process.exit()

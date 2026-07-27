// world.hud sanitizer e2e: a script pushes hostile HTML at the HUD; the
// harmless markup must render and every script-execution vector must be
// stripped (the sandbox exists so scripts cannot touch the page).
// Run the dev server first: npm run dev
import { chromium } from 'playwright'

const base = process.env.URL ?? 'http://localhost:5173'
const browser = await chromium.launch({ headless: false })
const page = await browser.newPage()

function fail(msg) {
  console.error('FAIL:', msg)
  process.exitCode = 1
}

await page.goto(`${base}/mock.html?room=hud${Math.random().toString(36).slice(2, 8)}`)
await page.waitForFunction(() => {
  const w = document.getElementById('widget')?.contentWindow
  return !!(w && w.__jig && w.__jig.session && w.__jig.session.ready())
}, null, { timeout: 30000 })
const frame = page.frames().find((f) => f !== page.mainFrame())

const script = [
  'world.onenter = () => world.hud(',
  ` '<b onclick="window.__pwn=1">hi</b>'`,
  ` + '<span style="color:red;position:fixed">styled</span>'`,
  ` + '<scr' + 'ipt>window.__pwn=2</scr' + 'ipt>'`,
  ` + '<iframe src="https://example.com"></iframe>'`,
  ` + '<img src="data:text/html,x"><form action="https://x"></form>'`,
  ` + '<a href="javascript:window.__pwn=3">link</a>')`,
].join('')
await frame.setInputFiles('#scriptfile', {
  name: 'evil.js', mimeType: 'text/javascript', buffer: Buffer.from(script),
})
const shown = await frame.waitForFunction(() =>
  document.getElementById('hud')?.textContent?.includes('hi'), null, { timeout: 20000 })
  .then(() => true).catch(() => false)
if (!shown) fail('HUD never rendered the benign markup')

const r = await frame.evaluate(() => {
  const hud = document.getElementById('hud')
  return {
    html: hud.innerHTML,
    ok: !!hud.querySelector('b'),
    spanStyle: hud.querySelector('span')?.getAttribute('style') ?? '',
    aHref: hud.querySelector('a')?.getAttribute('href'),
    pwn: window.__pwn,
  }
})
if (!r.ok) fail('benign <b> did not survive sanitizing')
if (/onclick|<script|<iframe|<form|<img|javascript:/i.test(r.html)) fail(`hostile markup survived: ${r.html}`)
if (!r.spanStyle.includes('red')) fail('allowlisted span color style should survive')
if (r.spanStyle.includes('fixed')) fail('non-allowlisted style property survived')
if (r.aHref) fail('javascript: href survived on the link')
if (r.pwn !== undefined) fail('script escaped the sandbox via the HUD')
if (process.exitCode !== 1) console.log('HUD TEST PASSED')
await browser.close()

// Lone-boot fallback e2e: the mock host withholds our own m.call.member
// echo (?dropOwnEcho=1), simulating hosts that lose it. The session must
// still start alone after the grace period (nobody else on the transport)
// and be playable - a spawned box lands in the sim.
// Run the dev server first: npm run dev
import { chromium } from 'playwright'

const base = process.env.URL ?? 'http://localhost:5173'
const room = 'lb' + Math.random().toString(36).slice(2, 8)
const browser = await chromium.launch({ headless: false })
const page = await browser.newPage()

function fail(msg) {
  console.error('FAIL:', msg)
  process.exitCode = 1
}

const logs = []
page.on('console', m => { if (m.text().includes('[worldsync]')) logs.push(m.text()) })
await page.goto(`${base}/mock.html?room=${room}&dropOwnEcho=1`)
const ok = await page.waitForFunction(() => {
  const w = document.getElementById('widget')?.contentWindow
  return !!(w && w.__jig && w.__jig.session && w.__jig.session.ready())
}, null, { timeout: 15000 }).then(() => true).catch(() => false)
if (!ok) fail('session never started with the membership echo withheld')

if (ok) {
  if (!logs.some(l => l.includes('starting alone'))) {
    fail(`lone-boot fallback log missing (did the echo sneak through?): ${logs.join(' | ')}`)
  }
  const bodies = await page.evaluate(() => {
    const w = document.getElementById('widget').contentWindow
    const { session } = w.__jig
    session.emit('spawn', session.nextNetId(), { pos: { x: 0, y: 3, z: 0 }, color: 0x33cc66 })
    return new Promise(r => setTimeout(() => r(w.__jig.sim.bodies.size), 2000))
  })
  if (bodies < 1) fail('spawn did not land in the lone-booted sim')
}

if (process.exitCode !== 1) console.log('LONEBOOT TEST PASSED')
await browser.close()

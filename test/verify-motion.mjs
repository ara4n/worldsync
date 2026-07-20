import { chromium } from 'playwright'
const base = 'http://localhost:5173'
const browser = await chromium.launch({ headless: false })
const page = await browser.newPage()
await page.goto(`${base}/?room=vm-${Math.random().toString(36).slice(2,8)}`)
await page.waitForFunction(() => window.__jig && window.__jig.session && window.__jig.session.ready(), null, { timeout: 15000 })
for (let gx = -2; gx <= 2; gx++) for (let gz = -1; gz <= 1; gz++) {
  const s = await page.evaluate(([x, z]) => window.__jig.screenOfGround(x, z), [gx * 1.6, gz * 1.6])
  await page.mouse.click(s.x, s.y)
  await page.waitForTimeout(40)
}
// pile is mid-fall / settling right now: verify replay against live
for (let i = 0; i < 5; i++) {
  console.log('mid-motion verify:', JSON.stringify(await page.evaluate(() => window.__jig.verify(20))))
  await page.waitForTimeout(400)
}
await page.waitForTimeout(4000)
console.log('at-rest verify:  ', JSON.stringify(await page.evaluate(() => window.__jig.verify(20))))
await browser.close()

// Per-tick cost breakdown at scale: spawns BOXES boxes into a settling pile
// and reports the step-phase EMAs (snapshot / normalise / physics / hashes)
// for each normalisation mode, plus a replay self-check.
// Run the dev server first: npm run dev
import { chromium } from 'playwright'

const base = process.env.URL ?? 'http://localhost:5173'
const boxes = Number(process.env.BOXES ?? 150)
const browser = await chromium.launch({ headless: false })

async function measure(query) {
  const page = await browser.newPage()
  const room = 'perf-' + Math.random().toString(36).slice(2, 8)
  await page.goto(`${base}/?room=${room}&${query}`)
  await page.waitForFunction(() => window.__jig && window.__jig.session && window.__jig.session.ready(), null, { timeout: 15000 })
  // Inject spawns straight into the sim (no peer, no pointer): a 1.05m grid
  // at three heights collapses into one contact-rich resting pile.
  await page.evaluate(n => {
    const { session } = window.__jig
    // Square-ish grid sized to n, capped at the 40x40 ground; overflow goes
    // into extra height layers.
    const side = Math.min(Math.ceil(Math.sqrt(n)), 36)
    let k = 0
    while (k < n) {
      const gx = k % side, gz = Math.floor(k / side) % side, layer = Math.floor(k / (side * side))
      session.emit('spawn', `perf-${k}`, {
        pos: { x: (gx - side / 2) * 1.05, y: 2.5 + (k % 3) + layer * 1.5, z: (gz - side / 2) * 1.05 },
        color: 0x888888,
      })
      k++
    }
  }, boxes)
  await page.waitForTimeout(12000) // land, settle, let the EMAs converge
  const s = await page.evaluate(() => ({
    entities: window.__jig.sim.bodies.size,
    stepMs: window.__jig.sim.stepMs,
    perf: window.__jig.sim.perf,
    verify: window.__jig.sim.verifyReplay(60),
    snapshotBytes: window.__jig.sim.world.takeSnapshot().length,
  }))
  await page.close()
  return s
}

for (const mode of ['norm=restore&cad=1', 'norm=restore&cad=10', 'norm=pipeline&cad=1']) {
  const s = await measure(mode)
  const p = s.perf
  console.log(`${mode}: ${s.entities} boxes, snapshot ${(s.snapshotBytes / 1024).toFixed(0)}KB`)
  console.log(`  step ${s.stepMs.toFixed(2)}ms = snap ${p.snap.toFixed(2)} + norm ${p.norm.toFixed(2)} + phys ${p.phys.toFixed(2)} + hash ${p.hash.toFixed(2)}`)
  console.log(`  verify: ${JSON.stringify(s.verify)}`)
}
await browser.close()

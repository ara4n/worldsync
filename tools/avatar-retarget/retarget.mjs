// Retarget the worldsync locomotion clip set onto a foreign humanoid GLB
// (a Mixamo-auto-rigged character exported from elsewhere, e.g. Unity via
// the thirdroom exporter) and bake a drop-in avatar asset. See
// the README beside this file for the full logic and the gotchas.
//
//   node tools/avatar-retarget/retarget.mjs <character.glb> [out.glb]
//
// Loads the character and public/avatar-default.glb (the clip source) in
// headless Chromium so the retarget runs on the same three.js worldsync
// renders with, writes out.glb (default: <character>-avatar.glb), then
// renders a pose-grid screenshot and runs the loop-wrap override check.
// Playwright is the only extra dependency: `npm i -D playwright` if absent.
import { chromium } from 'playwright'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.join(here, '..', '..')
const input = process.argv[2]
if (!input) { console.error('usage: node tools/avatar-retarget/retarget.mjs <character.glb> [out.glb]'); process.exit(1) }
const output = process.argv[3] ?? input.replace(/\.glb$/i, '') + '-avatar.glb'

const MIME = { '.js': 'text/javascript', '.html': 'text/html', '.glb': 'model/gltf-binary' }
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0])
  let f
  if (url === '/input.glb') f = path.resolve(input)
  else if (url === '/output.glb') f = path.resolve(output)
  else if (url.startsWith('/nm/')) f = path.join(repo, 'node_modules', url.slice(4))
  else if (url.startsWith('/ws/')) f = path.join(repo, 'public', url.slice(4))
  else f = path.join(here, url.slice(1))
  try {
    res.setHeader('Content-Type', MIME[path.extname(f)] ?? 'application/octet-stream')
    res.end(fs.readFileSync(f))
  } catch { res.statusCode = 404; res.end() }
}).listen(0)
const port = server.address().port

const browser = await chromium.launch({ args: ['--use-angle=metal'] })
const page = await browser.newPage({ viewport: { width: 1600, height: 500 } })
page.on('console', m => console.log('  page:', m.text().slice(0, 200)))

// -- 1. retarget + export --
await page.goto(`http://localhost:${port}/retarget.html`)
await page.waitForFunction('window.__done === true || window.__error', { timeout: 120000 })
let err = await page.evaluate('window.__error')
if (err) { console.error('retarget failed:', err); process.exit(1) }
fs.writeFileSync(output, Buffer.from(await page.evaluate('Array.from(window.__glb)')))
console.log('wrote', output, fs.statSync(output).size, 'bytes')

// -- 2. pose grid: eyeball that no clip folds limbs or floats feet --
await page.goto(`http://localhost:${port}/verify.html`)
await page.waitForFunction('window.__done === true || window.__error', { timeout: 60000 })
err = await page.evaluate('window.__error')
if (err) { console.error('verify failed:', err); process.exit(1) }
const unbound = await page.evaluate('window.__unbound')
if (unbound.length) console.warn('TRACK BINDING WARNINGS:', unbound.slice(0, 5))
const shot = output.replace(/\.glb$/i, '') + '-poses.png'
await page.screenshot({ path: shot })
console.log('pose grid:', shot, '- binding warnings:', unbound.length)

// -- 3. loop-wrap override check: replays avatar.ts's post-mixer head
// override at 120Hz across several wraps; any spike after frame 0 means
// the mixer skipped writes (duplicate leading keys) and heads will snap --
let clean = true
for (const clip of ['Fall1', 'Run', 'Walk', 'Idle']) {
  await page.goto(`http://localhost:${port}/wrapcheck.html?u=/output.glb&clip=${clip}`)
  await page.waitForFunction('window.__done === true || window.__error', { timeout: 60000 })
  err = await page.evaluate('window.__error')
  if (err) { console.error('wrapcheck failed:', err); process.exit(1) }
  const out = await page.evaluate('window.__out')
  const bad = out.spikes.filter(s => s.f > 0)
  if (bad.length) { clean = false; console.error(`WRAP GLITCH in ${clip}:`, JSON.stringify(bad.slice(0, 4))) }
  else console.log(`wrapcheck ${clip}: clean`)
}
await browser.close()
server.close()
if (!clean) process.exit(1)
console.log('done. Consider thirdroom.io/pipeline for KTX2 compression (see the README).')

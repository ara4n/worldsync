// MSC3815 world scene e2e under the mock widget host: tab a uploads a GLB
// (a 4x4 shelf at y=1) through the MSC4039 driver actions, tab b (already
// in session) fetches it when the scene op lands, tab c joins late and
// preloads it from room state before calibrating. A box spawned above must
// rest ON the shelf, bit-identically, on all three peers.
// Run the dev server first: npm run dev
import { chromium } from 'playwright'

const base = process.env.URL ?? 'http://localhost:5173'
const room = 'sc' + Math.random().toString(36).slice(2, 8)
const browser = await chromium.launch({ headless: false })
const ctx = await browser.newContext()

function fail(msg) {
  console.error('FAIL:', msg)
  process.exitCode = 1
}

/** Minimal valid GLB: one mesh, 4 verts, 2 triangles, flat at y=1. */
function shelfGlb() {
  const positions = new Float32Array([-2, 1, -2, 2, 1, -2, 2, 1, 2, -2, 1, 2])
  const indices = new Uint16Array([0, 2, 1, 0, 3, 2])
  const bin = Buffer.concat([Buffer.from(indices.buffer), Buffer.from(positions.buffer)])
  const json = Buffer.from(JSON.stringify({
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 1 }, indices: 0 }] }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: indices.byteLength, target: 34963 },
      { buffer: 0, byteOffset: indices.byteLength, byteLength: positions.byteLength, target: 34962 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5123, count: 6, type: 'SCALAR' },
      { bufferView: 1, componentType: 5126, count: 4, type: 'VEC3', min: [-2, 1, -2], max: [2, 1, 2] },
    ],
  }))
  const pad = n => (4 - (n % 4)) % 4
  const jsonPadded = Buffer.concat([json, Buffer.alloc(pad(json.length), 0x20)])
  const binPadded = Buffer.concat([bin, Buffer.alloc(pad(bin.length))])
  const chunk = (type, body) => {
    const h = Buffer.alloc(8)
    h.writeUInt32LE(body.length, 0)
    h.writeUInt32LE(type, 4)
    return Buffer.concat([h, body])
  }
  const chunks = Buffer.concat([chunk(0x4e4f534a, jsonPadded), chunk(0x004e4942, binPadded)])
  const header = Buffer.alloc(12)
  header.writeUInt32LE(0x46546c67, 0)
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(12 + chunks.length, 8)
  return Buffer.concat([header, chunks])
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

const sceneState = f => f.evaluate(() => ({
  url: window.__jig.sim.sceneUrl,
  solid: window.__jig.sim.scene ? window.__jig.sim.scene.body !== -1 : false,
}))

const a = await open('a')
const b = await open('b')
await a.page().waitForTimeout(1000)

await a.setInputFiles('#scenefile', { name: 'shelf.glb', mimeType: 'model/gltf-binary', buffer: shelfGlb() })
console.log('a uploaded the shelf; waiting for the scene op to land on both peers...')
for (const [name, f] of [['a', a], ['b', b]]) {
  const ok = await f.waitForFunction(
    () => window.__jig.sim.sceneUrl !== null && window.__jig.sim.scene.body !== -1,
    null, { timeout: 15000 }).then(() => true).catch(() => false)
  if (!ok) fail(`${name} never got solid scene colliders (${JSON.stringify(await sceneState(f))})`)
}

await a.evaluate(() => {
  const { session } = window.__jig
  session.emit('spawn', session.nextNetId(), { pos: { x: 0, y: 3, z: 0 }, color: 0xcc8822 })
})
await a.page().waitForTimeout(3000)

console.log('c joining late; scene must preload from room state before calibration...')
const c = await open('c')
await c.page().waitForTimeout(2000)

for (const [name, f] of [['a', a], ['b', b], ['c', c]]) {
  const s = await f.evaluate(() => {
    const { sim } = window.__jig
    const id = [...sim.bodies.keys()].find(k => k.endsWith('-0'))
    const p = id ? sim.body(id).translation() : null
    return { scene: sim.sceneUrl, solid: sim.scene?.body !== -1, y: p && p.y, anomalies: sim.anomalies }
  })
  console.log(name, JSON.stringify(s))
  if (!s.scene || !s.scene.startsWith('mxc://mock.localhost/')) fail(`${name} scene url wrong: ${s.scene}`)
  if (!s.solid) fail(`${name} scene has no colliders`)
  if (s.y === null || Math.abs(s.y - 1.5) > 0.05) fail(`${name} box not resting on the shelf (y=${s.y})`)
}

console.log('waiting for settled-hash comparison across all peers...')
for (const [name, f] of [['a', a], ['b', b], ['c', c]]) {
  const ok = await f.waitForFunction(
    () => [...window.__jig.session.peers.values()].every(p => p.checked),
    null, { timeout: 40000 }).then(() => true).catch(() => false)
  if (!ok) fail(`${name} never compared settled hashes`)
  const s = await f.evaluate(() => ({
    peers: [...window.__jig.session.peers.values()].map(p => ({ id: p.id, divergedAt: p.divergedAt })),
    verify: window.__jig.sim.verifyReplay(60),
  }))
  for (const p of s.peers) if (p.divergedAt !== null) fail(`${name} latched divergence vs ${p.id}`)
  if (s.verify.posesMatch === false) fail(`${name} replay self-check failed: ${JSON.stringify(s.verify)}`)
}

if (process.exitCode !== 1) console.log('SCENE TEST PASSED')
await browser.close()

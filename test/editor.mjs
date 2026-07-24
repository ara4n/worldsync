// Monaco script editor + glTF inspector e2e under the mock widget host:
// upload a GLB, open the inspector and check the tree shows the scene
// graph; open the editor, Save & Run the starter script, and watch it
// come up ("world script running") and spawn its boxes on a second peer
// too (proof the upload went through room state, not just locally).
// Run the dev server first: npm run dev
import { chromium } from 'playwright'

const base = process.env.URL ?? 'http://localhost:5173'
const room = 'ed' + Math.random().toString(36).slice(2, 8)
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
    nodes: [{ mesh: 0, name: 'shelf' }],
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

const logged = (f, needle) =>
  f.waitForFunction(n => [...document.querySelectorAll('#log div')].some(d => d.textContent.includes(n)),
    needle, { timeout: 30000 }).then(() => true).catch(() => false)

const a = await open('a')
const b = await open('b')
await a.page().waitForTimeout(1000)

// --- inspector: needs a scene, so upload the shelf first ---
await a.setInputFiles('#scenefile', { name: 'shelf.glb', mimeType: 'model/gltf-binary', buffer: shelfGlb() })
await a.waitForFunction(() => window.__jig.sim.sceneUrl !== null, null, { timeout: 15000 })
  .catch(() => fail('a never adopted the uploaded scene'))

await a.click('#inspect')
const row = await a.waitForSelector('#inspector .row', { timeout: 30000 }).catch(() => null)
if (!row) fail('inspector never showed the scene tree')
// expand down to the named mesh and select it; props must show the geometry
const shelf = await a.evaluate(() => {
  // expanding rebuilds the tree DOM, so re-query until nothing is collapsed
  for (let i = 0; i < 50; i++) {
    const t = [...document.querySelectorAll('#inspector .row .twist')].find(x => x.textContent === '▸')
    if (!t) break
    t.click()
  }
  return [...document.querySelectorAll('#inspector .row')].map(r => r.textContent)
})
if (!shelf.some(t => t.includes('shelf'))) fail(`inspector tree missing the shelf node: ${JSON.stringify(shelf)}`)
await a.evaluate(() => {
  const r = [...document.querySelectorAll('#inspector .row')].find(x => x.textContent.includes('shelf'))
  r.click()
})
const props = await a.evaluate(() => document.querySelector('#inspector .props').textContent)
if (!props.includes('triangles2')) fail(`inspector props missing triangle count: ${props.slice(0, 200)}`)
console.log('inspector shows the shelf mesh and its properties')

// --- editor: open, wait for monaco, save & run the starter script ---
await a.click('#editscript')
const monacoUp = await a.waitForSelector('#editor .monaco-editor', { timeout: 60000 }).then(() => true).catch(() => false)
if (!monacoUp) fail('monaco never came up')
await a.page().waitForTimeout(1000)
await a.click('#edsave')
if (!await logged(a, 'world script running')) fail('a: script never ran after save & run')
if (!await logged(b, 'world script running')) fail('b: script never started on the other peer')
// the starter script (primary-only) spawns boxes; both sims must agree
for (const [name, f] of [['a', a], ['b', b]]) {
  const ok = await f.waitForFunction(() => window.__jig.sim.bodies.size >= 1, null, { timeout: 20000 })
    .then(() => true).catch(() => false)
  if (!ok) fail(`${name}: the saved script never spawned a box`)
}
console.log('editor saved the script; it runs and replicates on both peers')

if (process.exitCode !== 1) console.log('EDITOR TEST PASSED')
await browser.close()

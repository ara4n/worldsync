// Build examples/arch.glb: the worldsync architecture as a 3D WORLD -
// the codebase rendered as a machine, at MEMBER granularity. The
// dependency data is not curated: this tool parses src/ with the
// TypeScript compiler API. Every module is a slab carrying blocks for
// its major members (top-level classes/functions/consts; when one
// class or function dominates the file - Sim, main() - the tool
// descends into it and its methods/fields become the blocks). Member
// footprint ~ lines of code; member height ~ how many modules import
// that symbol, so load-bearing API surfaces read as towers.
//
// LAYOUT comes from two cooperating sources:
//  - DISTRICTS are discovered, not hand-assigned: label propagation
//    over the weighted import graph (weights = symbols per edge; main
//    is excluded so the chassis cannot glue everything into one blob),
//    with small clusters merged into their hint-nearest neighbour.
//  - GEOGRAPHY is authored: the ASCII diagram below is the layout
//    hint, exactly the 2D architecture sketch you would draw by hand -
//    dataflow runs west to east (transports -> session/timeline ->
//    sim -> presentation), main is the central chassis everything
//    bolts onto, the script sandbox hangs south, vendors sit outboard
//    of their consumers. Token positions in the diagram become slab
//    anchors; a relaxation pass then spaces the packed slabs apart.
//
// PIPES are import edges routed MANHATTAN-style: a vertical riser from
// the consumer, orthogonal feeder legs at the bus height, then a shared
// L-shaped tray between district masts - one tray per district pair,
// each at its own reserved height, member pipes running side by side in
// cable-tray slots. Every pipe carries flow cones (consumer -> provider)
// on its longest leg and a down-cone where it plugs into the provider's
// slab, where thin traces fan out to the exact members imported.
// Dynamic import() seams are thin and pale; net -> vite /signal is the
// one runtime (non-import) wire.
//
// Built for telemetry overlay and scripting: every slab, member and
// pipe is a named node (mod_sim, mod_sim__rollback, dep_three__Mesh,
// pipe_main__sim) with {module, member, kind, district, loc, consumers,
// symbols} extras, and an 'arch_index' node carries a manifest of the
// collapsible detail nodes - examples/arch.js uses it to toggle the
// city between full detail and the module-dependency skeleton.
//
// Run: node tools/arch-glb.mjs
// View: upload with "load glTF scene (.glb)" (it is a world with its
// own floor + collider), plus examples/arch.js as the world script.
import { writeFileSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import ts from 'typescript'
import * as THREE from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { FontLoader } from 'three/examples/jsm/loaders/FontLoader.js'

class FileReaderShim {
  readAsArrayBuffer(blob) {
    void blob.arrayBuffer().then(buf => { this.result = buf; this.onloadend?.() })
  }
  readAsDataURL(blob) {
    void blob.arrayBuffer().then(buf => {
      this.result = `data:${blob.type};base64,` + Buffer.from(buf).toString('base64')
      this.onloadend?.()
    })
  }
}
globalThis.FileReader ??= FileReaderShim

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// ---------------------------------------------------------- the model
/** app modules: id -> [file] (positions come from the hint diagram) */
const MODULES = {
  main: ['src/main.ts'],
  sim: ['src/sim.ts'],
  session: ['src/session.ts'],
  ecs: ['src/ecs.ts'],
  types: ['src/types.ts'],
  color: ['src/color.ts'],
  wire: ['src/wire.ts'],
  input: ['src/input.ts'],
  hub: ['src/hub.ts'],
  render: ['src/render.ts'],
  props: ['src/props.ts'],
  scene: ['src/scene.ts'],
  audio: ['src/audio.ts'],
  inspector: ['src/inspector.ts'],
  websg: ['src/websg.ts'],
  websg_dts: ['src/websg-dts.ts'],
  editor: ['src/editor.ts'],
  ui: ['src/ui.ts'],
  net: ['src/net.ts'],
  vite_signal: ['vite.config.ts'],
  matrix_net: ['src/matrix/net.ts'],
  matrix_transport: ['src/matrix/transport.ts'],
  matrix_widget: ['src/matrix/widget.ts'],
  matrix_world: ['src/matrix/world.ts'],
  matrix_params: ['src/matrix/params.ts'],
  mock_host: ['src/mock/host.ts'],
}
const INFRA = new Set(['hub', 'vite_signal', 'mock_host'])

/** vendor packages (one layer deep): id -> [label, specifier match] */
const VENDORS = {
  three: ['three', /^three(\/|$)/],
  rapier: ['@dimforge/rapier3d', /^@dimforge\//],
  bitecs: ['bitecs', /^bitecs$/],
  cbor_x: ['cbor-x', /^cbor-x$/],
  quickjs: ['quickjs-emscripten', /^(quickjs-emscripten|@jitl\/)/],
  monaco: ['monaco-editor', /^monaco-editor(\/|$)/],
  sanitize_html: ['sanitize-html', /^sanitize-html$/],
  livekit: ['livekit-client', /^livekit-client$/],
  matrix_js_sdk: ['matrix-js-sdk', /^matrix-js-sdk(\/|$)/],
  matrix_widget_api: ['matrix-widget-api', /^matrix-widget-api$/],
}

// THE LAYOUT HINT: the architecture as I would sketch it in ASCII.
// West -> east is dataflow: the transport stacks feed the shared
// timeline (wire/session), which drives the deterministic sim, which
// the presentation layer draws; main is the chassis in the middle of
// it all; the script sandbox and authoring tools hang south; every
// vendor sits outboard of the district that consumes it. Token
// positions (column, row) become slab anchor coordinates.
const DIAGRAM = `
.                                   cbor_x          rapier       bitecs
.
.  livekit             hub                 wire        sim    ecs   types
.
.  matrix_js_sdk    matrix_transport   session                              props      three
.
.  matrix_widget_api   matrix_net                                    render
.                                        net
.  mock_host   matrix_widget                       input                    scene    audio
.                            matrix_params        main
.        matrix_world                                        color
.                     vite_signal                                       inspector
.
.  sanitize_html     ui           websg      websg_dts     editor
.
.                              quickjs                  monaco
`
const CHAR_W = 0.48
const ROW_D = 1.55
const hint = {}
{
  const rows = DIAGRAM.split('\n')
  for (const [r, line] of rows.entries()) {
    for (const m of line.matchAll(/[a-z][a-z0-9_]*/g)) {
      hint[m[0]] = { x: (m.index + m[0].length / 2) * CHAR_W, z: r * ROW_D }
    }
  }
  const ids = [...Object.keys(MODULES), ...Object.keys(VENDORS)]
  for (const id of ids) if (!hint[id]) throw new Error(`no diagram position for ${id}`)
  // center on main
  const c = hint.main
  for (const id of ids) { hint[id] = { x: hint[id].x - c.x, z: hint[id].z - c.z } }
}

const TRUNKS = new Set(['main sim', 'main session', 'main render', 'session sim',
  'sim rapier', 'render three', 'matrix_net matrix_transport', 'net wire'])

// ------------------------------------------------------------- analysis
const fileFor = Object.fromEntries(Object.entries(MODULES).map(([id, [f]]) => [id, f]))
const idForFile = Object.fromEntries(Object.entries(fileFor).map(([id, f]) =>
  [f.replace(/\.ts$/, ''), id]))

const resolveSpec = (fromId, spec) => {
  if (spec.startsWith('.')) {
    const dir = dirname(fileFor[fromId])
    const norm = join(dir, spec).replace(ROOT + '/', '').replace(/\\/g, '/')
    return idForFile[norm] ?? null
  }
  for (const [id, [, match]] of Object.entries(VENDORS)) if (match.test(spec)) return id
  return null
}

const lineSpan = (sf, node) => {
  const a = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line
  const b = sf.getLineAndCharacterOfPosition(node.end).line
  return b - a + 1
}
const isExported = (node) =>
  (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export) !== 0

const declsOf = (sf, statements, container) => {
  const out = []
  for (const st of statements) {
    if (ts.isFunctionDeclaration(st) && st.name) {
      out.push({ name: st.name.text, lines: lineSpan(sf, st), kind: 'function',
        pub: isExported(st), container, node: st })
    } else if (ts.isClassDeclaration(st) && st.name) {
      out.push({ name: st.name.text, lines: lineSpan(sf, st), kind: 'class',
        pub: isExported(st), container, node: st })
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) continue
        const fn = d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))
        out.push({ name: d.name.text, lines: lineSpan(sf, st) / st.declarationList.declarations.length,
          kind: fn ? 'function' : 'const', pub: isExported(st), container, node: st })
      }
    } else if (ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isEnumDeclaration(st)) {
      out.push({ name: st.name.text, lines: lineSpan(sf, st), kind: 'type',
        pub: isExported(st), container, node: st })
    }
  }
  return out
}

const classMembers = (sf, cls, container) => {
  const out = []
  for (const m of cls.members) {
    let name = null
    if ((ts.isMethodDeclaration(m) || ts.isPropertyDeclaration(m) || ts.isGetAccessor(m))
      && m.name && (ts.isIdentifier(m.name) || ts.isPrivateIdentifier(m.name))) name = m.name.text
    else if (ts.isConstructorDeclaration(m)) name = 'constructor'
    if (!name) continue
    const priv = ts.getCombinedModifierFlags(m) & ts.ModifierFlags.Private || name.startsWith('#')
    out.push({ name, lines: lineSpan(sf, m),
      kind: ts.isPropertyDeclaration(m) ? 'field' : 'method', pub: !priv, container })
  }
  return out
}

const MEMBER_MIN_LINES = 6
const MEMBER_CAP = 14

const analyzed = {}
for (const [id, [file]] of Object.entries(MODULES)) {
  const text = readFileSync(join(ROOT, file), 'utf8')
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true)
  const loc = text.split('\n').length
  const imports = new Map()
  const edge = (provider, dynamic) => {
    if (!imports.has(provider)) imports.set(provider, { symbols: new Set(), dynamic })
    const e = imports.get(provider)
    e.dynamic = e.dynamic && dynamic
    return e
  }
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue
    const provider = resolveSpec(id, st.moduleSpecifier.text)
    if (!provider || provider === id) continue
    const e = edge(provider, false)
    const b = st.importClause?.namedBindings
    if (b && ts.isNamedImports(b)) for (const s of b.elements) e.symbols.add(s.name.text)
    if (b && ts.isNamespaceImport(b)) {
      for (const m of text.matchAll(new RegExp(`\\b${b.name.text}\\.([A-Za-z_$][\\w$]*)`, 'g'))) {
        e.symbols.add(m[1])
      }
    }
    if (st.importClause?.name) e.symbols.add('default')
  }
  for (const m of text.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const provider = resolveSpec(id, m[1])
    if (provider && provider !== id) edge(provider, !imports.has(provider) || imports.get(provider).dynamic)
  }
  let decls = declsOf(sf, sf.statements, null)
  const dominant = decls.find(d => d.lines > 0.55 * loc && (d.kind === 'class' || d.kind === 'function'))
  if (dominant) {
    const rest = decls.filter(d => d !== dominant)
    const inner = dominant.kind === 'class'
      ? classMembers(sf, dominant.node, dominant.name)
      : declsOf(sf, dominant.node.body?.statements ?? [], dominant.name)
    decls = [...inner, ...rest]
  }
  decls = decls.filter(d => d.lines >= MEMBER_MIN_LINES).sort((a, b) => b.lines - a.lines)
  const kept = decls.slice(0, MEMBER_CAP)
  const rest = decls.slice(MEMBER_CAP)
  const members = kept.map(({ name, lines, kind, pub, container }) =>
    ({ name, lines: Math.round(lines), kind, pub, container }))
  if (rest.length) {
    members.push({ name: `+${rest.length}`, lines: Math.round(rest.reduce((n, d) => n + d.lines, 0)),
      kind: 'misc', pub: false, container: null })
  }
  if (!members.length) members.push({ name: id, lines: loc, kind: 'module', pub: true, container: null })
  analyzed[id] = { loc, members, imports }
}
analyzed.net.imports.set('vite_signal', { symbols: new Set(['/signal']), dynamic: false, runtime: true })
analyzed.vite_signal = {
  loc: readFileSync(join(ROOT, 'vite.config.ts'), 'utf8').split('\n').length,
  members: [{ name: 'signaling ws', lines: 100, kind: 'function', pub: true, container: null }],
  imports: new Map(),
}

const vendorUse = Object.fromEntries(Object.keys(VENDORS).map(k => [k, new Map()]))
for (const a of Object.values(analyzed)) {
  for (const [provider, e] of a.imports) {
    if (!vendorUse[provider]) continue
    for (const s of e.symbols) vendorUse[provider].set(s, (vendorUse[provider].get(s) ?? 0) + 1)
  }
}
const symbolConsumers = Object.fromEntries(Object.keys(MODULES).map(k => [k, new Map()]))
for (const a of Object.values(analyzed)) {
  for (const [provider, e] of a.imports) {
    if (!symbolConsumers[provider]) continue
    for (const s of e.symbols) symbolConsumers[provider].set(s, (symbolConsumers[provider].get(s) ?? 0) + 1)
  }
}
const ALL_IDS = [...Object.keys(MODULES), ...Object.keys(VENDORS)]
const indeg = Object.fromEntries(ALL_IDS.map(k => [k, 0]))
for (const a of Object.values(analyzed)) for (const p of a.imports.keys()) indeg[p]++

// -------------------------------------------- districts by clustering
// Label propagation over the undirected import graph, weighted by
// symbols-per-edge. main is excluded (the chassis touches everything
// and would glue the graph into one community); it becomes its own
// routing hub. Clusters under 3 members merge into the hint-nearest
// cluster, so singletons like ui land with their neighbours.
const adj = Object.fromEntries(ALL_IDS.map(k => [k, new Map()]))
for (const [from, a] of Object.entries(analyzed)) {
  for (const [to, e] of a.imports) {
    if (from === 'main' || to === 'main') continue
    const w = Math.max(1, e.symbols.size)
    adj[from].set(to, (adj[from].get(to) ?? 0) + w)
    adj[to].set(from, (adj[to].get(from) ?? 0) + w)
  }
}
const clusterNodes = ALL_IDS.filter(id => id !== 'main').sort()
const label = Object.fromEntries(clusterNodes.map(n => [n, n]))
for (let iter = 0; iter < 60; iter++) {
  let changed = false
  for (const n of clusterNodes) {
    const counts = new Map()
    for (const [nb, w] of adj[n]) {
      if (nb === 'main') continue
      counts.set(label[nb], (counts.get(label[nb]) ?? 0) + w)
    }
    if (!counts.size) continue
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0]
    if (best !== label[n]) { label[n] = best; changed = true }
  }
  if (!changed) break
}
let clusters = new Map()
for (const n of clusterNodes) {
  if (!clusters.has(label[n])) clusters.set(label[n], [])
  clusters.get(label[n]).push(n)
}
const centroidOf = (ids) => ({
  x: ids.reduce((s, i) => s + hint[i].x, 0) / ids.length,
  z: ids.reduce((s, i) => s + hint[i].z, 0) / ids.length,
})
for (let guard = 0; guard < 40; guard++) {
  const small = [...clusters.entries()].filter(([, m]) => m.length < 3)
    .sort((a, b) => a[1].length - b[1].length)[0]
  if (!small) break
  const [key, membersOf] = small
  clusters.delete(key)
  const c = centroidOf(membersOf)
  const nearest = [...clusters.entries()].sort((a, b) => {
    const ca = centroidOf(a[1]), cb = centroidOf(b[1])
    return Math.hypot(ca.x - c.x, ca.z - c.z) - Math.hypot(cb.x - c.x, cb.z - c.z)
  })[0]
  nearest[1].push(...membersOf)
}
// name each district after its biggest app module; main is its own
const districtOf = { main: 'main' }
const districtName = { main: 'main' }
for (const membersOf of clusters.values()) {
  const dominant = membersOf.filter(m => m in MODULES).sort((a, b) =>
    (analyzed[b]?.loc ?? 0) - (analyzed[a]?.loc ?? 0))[0] ?? membersOf[0]
  for (const m of membersOf) districtOf[m] = dominant
  districtName[dominant] = dominant
}
const DISTRICTS = [...new Set(Object.values(districtOf))]
const PALETTE = [0x4f7cac, 0xc9913d, 0x8a6fc9, 0x3d9ba0, 0x5da06b, 0xb0637a, 0x958f4e]
const districtColor = { main: 0x46536b }
{
  const sized = DISTRICTS.filter(d => d !== 'main').sort((a, b) =>
    Object.values(districtOf).filter(x => x === b).length
    - Object.values(districtOf).filter(x => x === a).length || a.localeCompare(b))
  sized.forEach((d, i) => { districtColor[d] = PALETTE[i % PALETTE.length] })
}

// ------------------------------------------------------------- layout
const pack = (items, gap) => {
  const targetW = Math.max(Math.sqrt(items.reduce((n, i) => n + (i.w + gap) * (i.d + gap), 0)) * 1.12,
    Math.max(...items.map(i => i.w)) + gap)
  let x = 0, z = 0, rowD = 0, maxW = 0
  for (const it of items) {
    if (x > 0 && x + it.w > targetW) { z += rowD + gap; x = 0; rowD = 0 }
    it.x = x + it.w / 2; it.z = z + it.d / 2
    x += it.w + gap
    rowD = Math.max(rowD, it.d)
    maxW = Math.max(maxW, it.x + it.w / 2)
  }
  const maxD = z + rowD
  for (const it of items) { it.x -= maxW / 2; it.z -= maxD / 2 }
  return { hw: maxW / 2, hd: maxD / 2 }
}

const SLAB_H = 0.16
const memberDims = (m, consumers) => {
  const side = Math.min(0.42 + Math.sqrt(m.lines) * 0.115, 1.9)
  const h = Math.min(0.28 + Math.sqrt(m.lines) * 0.05 + 0.34 * consumers, 2.6)
  return { w: side, d: side, h }
}
const vendorMemberDims = (uses) =>
  ({ w: Math.min(0.55 + 0.14 * uses, 1.3), d: Math.min(0.55 + 0.14 * uses, 1.3),
    h: Math.min(0.35 + 0.22 * uses, 1.9) })

const layout = {}
for (const [id, [file]] of Object.entries(MODULES)) {
  const a = analyzed[id]
  const items = a.members.map(m => ({
    ...m, ...memberDims(m, symbolConsumers[id].get(m.name) ?? 0),
    consumers: symbolConsumers[id].get(m.name) ?? 0,
  }))
  const { hw, hd } = pack(items, 0.22)
  layout[id] = { id, x: hint[id].x, z: hint[id].z, hw: hw + 0.42, hd: hd + 0.42, items,
    kind: INFRA.has(id) ? 'infra' : 'app', module: file, loc: a.loc }
}
for (const [id, [pkg]] of Object.entries(VENDORS)) {
  const uses = [...vendorUse[id].entries()].sort((a, b) => b[1] - a[1])
  const kept = uses.slice(0, 10)
  const items = kept.map(([name, n]) => ({ name, lines: 0, kind: 'symbol', pub: true,
    container: null, consumers: n, ...vendorMemberDims(n) }))
  if (uses.length > 10) {
    items.push({ name: `+${uses.length - 10}`, lines: 0, kind: 'misc', pub: false,
      container: null, consumers: 0, ...vendorMemberDims(1) })
  }
  if (!items.length) items.push({ name: pkg, lines: 0, kind: 'symbol', pub: true,
    container: null, consumers: 1, ...vendorMemberDims(1) })
  const { hw, hd } = pack(items, 0.2)
  layout[id] = { id, x: hint[id].x, z: hint[id].z, hw: hw + 0.38, hd: hd + 0.38, items,
    kind: 'vendor', module: pkg, loc: undefined }
}
for (let iter = 0; iter < 400; iter++) {
  let moved = false
  const ids = Object.keys(layout)
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const A = layout[ids[i]], B = layout[ids[j]]
      const gap = 0.9
      const ox = A.hw + B.hw + gap - Math.abs(A.x - B.x)
      const oz = A.hd + B.hd + gap - Math.abs(A.z - B.z)
      if (ox <= 0 || oz <= 0) continue
      moved = true
      const push = (P, dx, dz) => { if (P.id !== 'main') { P.x += dx; P.z += dz } }
      if (ox < oz) {
        const s = Math.sign(A.x - B.x) || 1
        push(A, s * ox / 2, 0); push(B, -s * ox / 2, 0)
        if (A.id === 'main') push(B, -s * ox / 2, 0)
        if (B.id === 'main') push(A, s * ox / 2, 0)
      } else {
        const s = Math.sign(A.z - B.z) || 1
        push(A, 0, s * oz / 2); push(B, 0, -s * oz / 2)
        if (A.id === 'main') push(B, 0, -s * oz / 2)
        if (B.id === 'main') push(A, 0, s * oz / 2)
      }
    }
  }
  if (!moved) break
}

// ---------------------------------------------------------------- build
const font = new FontLoader().parse(JSON.parse(readFileSync(
  join(ROOT, 'node_modules/three/examples/fonts/helvetiker_regular.typeface.json'), 'utf8')))

const world = new THREE.Group()
world.name = 'world'

const mats = new Map()
const matFor = (color, opts = {}) => {
  const key = `${color} ${JSON.stringify(opts)}`
  let m = mats.get(key)
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.1, ...opts })
    m.name = `m${mats.size}`
    mats.set(key, m)
  }
  return m
}
const dim = (c, f) => {
  const r = Math.round(((c >> 16) & 255) * f), g = Math.round(((c >> 8) & 255) * f)
  const b = Math.round((c & 255) * f)
  return (r << 16) | (g << 8) | b
}

const textMesh = (text, size, maxW, mat) => {
  const g = new THREE.ShapeGeometry(font.generateShapes(text, size), 2)
  g.computeBoundingBox()
  const bb = g.boundingBox
  const w = bb.max.x - bb.min.x
  const s = Math.min(1, maxW / w)
  g.translate(-(bb.min.x + w / 2), -(bb.min.y + (bb.max.y - bb.min.y) / 2), 0)
  g.scale(s, s, s)
  g.rotateX(-Math.PI / 2)
  return new THREE.Mesh(g, mat)
}
const labelLight = matFor(0xe8ebef, { roughness: 0.4 })
const labelDark = matFor(0x0d1015, { roughness: 0.8 })

const collapsibles = [] // [name, worldX+worldZ] for the toggle sweep
for (const L of Object.values(layout)) {
  const d = districtOf[L.id]
  const zone = districtColor[d]
  const group = new THREE.Group()
  group.name = (L.kind === 'vendor' ? 'dep_' : 'mod_') + L.id
  group.position.set(L.x, 0, L.z)
  group.userData = {
    module: L.module, kind: L.kind, district: d, loc: L.loc,
    deps: [...(analyzed[L.id]?.imports.keys() ?? [])],
    dependents: indeg[L.id],
  }
  // 1st-party modules wear their district colour; external packages are
  // unmistakable: a uniform near-black slab with a bright rim frame and
  // a pkg: nameplate, whatever district consumes them
  const slab = new THREE.Mesh(new THREE.BoxGeometry(L.hw * 2, SLAB_H, L.hd * 2),
    matFor(L.kind === 'vendor' ? 0x1d2127 : dim(zone, 0.45)))
  slab.name = group.name + '_slab'
  slab.position.y = SLAB_H / 2
  group.add(slab)
  if (L.kind === 'vendor') {
    const rimMat = matFor(0xaab4c0, { roughness: 0.4, metalness: 0.5 })
    const rims = [
      [L.hw * 2, 0.07, 0, -(L.hd - 0.035)], [L.hw * 2, 0.07, 0, L.hd - 0.035],
      [0.07, L.hd * 2 - 0.14, -(L.hw - 0.035), 0], [0.07, L.hd * 2 - 0.14, L.hw - 0.035, 0],
    ]
    for (const [w, d, x, z] of rims) {
      const rim = new THREE.Mesh(new THREE.BoxGeometry(w, 0.06, d), rimMat)
      rim.position.set(x, SLAB_H + 0.03, z)
      group.add(rim)
    }
  }
  for (const it of L.items) {
    const color = L.kind === 'vendor' ? 0x4a5058
      : it.kind === 'misc' ? dim(zone, 0.5)
      : it.pub ? zone : dim(zone, 0.62)
    // shape codes the member kind: box = function/class machinery,
    // tank (cylinder) = state/consts, thin upright panel = types
    const isTank = L.kind !== 'vendor' && (it.kind === 'field' || it.kind === 'const')
    const isPanel = L.kind !== 'vendor' && it.kind === 'type'
    const ah = isPanel ? it.h * 0.8 : it.h
    const geo = isTank ? new THREE.CylinderGeometry(it.w * 0.48, it.w * 0.48, ah, 14)
      : isPanel ? new THREE.BoxGeometry(it.w, ah, 0.09)
      : new THREE.BoxGeometry(it.w, ah, it.d)
    const box = new THREE.Mesh(geo, matFor(color))
    const safe = it.name.replace(/[^\w+]/g, '_')
    box.name = `${group.name}__${safe}`
    box.position.set(it.x, SLAB_H + ah / 2, it.z)
    box.userData = {
      member: it.name, of: L.module, in: it.container ?? undefined, kind: it.kind,
      loc: it.lines || undefined, consumers: it.consumers || undefined, exported: it.pub,
    }
    group.add(box)
    const lbl = textMesh(it.name, 0.16, it.w * 0.94, L.kind === 'vendor' || !it.pub ? labelLight : labelDark)
    lbl.name = `${group.name}__${safe}_label`
    lbl.position.set(it.x, SLAB_H + ah + 0.015, it.z)
    group.add(lbl)
    collapsibles.push([box.name, L.x + it.x + L.z + it.z])
    collapsibles.push([lbl.name, L.x + it.x + L.z + it.z])
  }
  const plate = textMesh(
    L.kind === 'vendor' ? `pkg: ${L.module}` : L.id.replace(/_/g, L.id.startsWith('matrix') ? '/' : '-'),
    0.34, L.hw * 1.8, L.kind === 'vendor' ? labelLight : matFor(0xf2f4f7, { roughness: 0.4 }))
  plate.name = group.name + '_plate'
  plate.position.set(0, SLAB_H + 0.015, L.hd - 0.24)
  group.add(plate)
  world.add(group)
}

// -- pipes: Manhattan trays between district masts --
const hash01 = (s) => {
  let h = 2166136261
  for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) }
  return ((h >>> 0) % 1000) / 1000
}
const pipes = new THREE.Group()
pipes.name = 'pipes'
world.add(pipes)

const cityX = layout.main.x, cityZ = layout.main.z
const mastPos = {}
for (const dst of DISTRICTS) {
  if (dst === 'main') { mastPos.main = { x: layout.main.x, z: layout.main.z }; continue }
  const Ds = Object.values(layout).filter(L => districtOf[L.id] === dst)
  let mx = Ds.reduce((n, L) => n + L.x, 0) / Ds.length
  let mz = Ds.reduce((n, L) => n + L.z, 0) / Ds.length
  mx += (cityX - mx) * 0.26; mz += (cityZ - mz) * 0.26
  const dirx = mx - cityX, dirz = mz - cityZ
  const mag = Math.hypot(dirx, dirz) || 1
  for (let step = 0; step < 40; step++) {
    if (!Object.values(layout).some(L =>
      Math.abs(mx - L.x) < L.hw + 0.35 && Math.abs(mz - L.z) < L.hd + 0.35)) break
    mx += (dirx / mag) * 0.5; mz += (dirz / mag) * 0.5
  }
  mastPos[dst] = { x: mx, z: mz }
}

const allEdges = []
for (const [from, a] of Object.entries(analyzed)) {
  for (const [to, e] of a.imports) {
    if (!layout[from] || !layout[to]) continue
    const d1 = districtOf[from], d2 = districtOf[to]
    allEdges.push({ from, to, e, local: d1 === d2, pair: d1 === d2 ? null : [d1, d2].sort().join('|') })
  }
}
const pairs = [...new Set(allEdges.filter(x => x.pair).map(x => x.pair))].sort()
const busHeight = Object.fromEntries(pairs.map((p, i) => [p, 3.2 + 0.42 * i]))
const slots = {}
for (const p of pairs) {
  const es = allEdges.filter(x => x.pair === p).sort((a, b) =>
    `${a.from} ${a.to}`.localeCompare(`${b.from} ${b.to}`))
  es.forEach((x, i) => { slots[`${x.from} ${x.to}`] = i - (es.length - 1) / 2 })
}

const Y = new THREE.Vector3(0, 1, 0)
/** orthogonal pipe: cylinders between points, sphere elbows, flow cones */
const pipeRun = (group, pts, r, mat) => {
  const clean = pts.filter((p, i) => i === 0 || p.distanceTo(pts[i - 1]) > 0.06)
  let longest = null
  for (let i = 0; i < clean.length - 1; i++) {
    const p = clean[i], q = clean[i + 1]
    const d = q.clone().sub(p)
    const len = d.length()
    const cyl = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 10), mat)
    cyl.position.copy(p).add(q).multiplyScalar(0.5)
    cyl.quaternion.setFromUnitVectors(Y, d.clone().normalize())
    group.add(cyl)
    if (i > 0) {
      const elbow = new THREE.Mesh(new THREE.SphereGeometry(r * 1.25, 10, 8), mat)
      elbow.position.copy(p)
      group.add(elbow)
    }
    if (Math.abs(d.y) < 0.01 && (!longest || len > longest.len)) longest = { p, q, len }
  }
  return longest
}
const flowCone = (group, at, dir, r, mat) => {
  const cone = new THREE.Mesh(new THREE.ConeGeometry(r * 2.6, r * 7, 12), mat)
  cone.position.copy(at)
  cone.quaternion.setFromUnitVectors(Y, dir)
  group.add(cone)
}

let pipeCount = 0
for (const { from, to, e, local, pair } of allEdges) {
  const A = layout[from], B = layout[to]
  const name = `pipe_${from}__${to}`
  const j = hash01(name)
  const ax = A.x + (j - 0.5) * A.hw, az = A.z + (hash01(name + 'z') - 0.5) * A.hd
  const dirx = A.x - B.x, dirz = A.z - B.z
  const mag = Math.hypot(dirx, dirz) || 1
  const jx = B.x + (dirx / mag) * (Math.abs(dirx / mag) * B.hw) * 0.82
  const jz = B.z + (dirz / mag) * (Math.abs(dirz / mag) * B.hd) * 0.82
  const aTop = Math.max(...A.items.map(i => i.h)) + SLAB_H
  const r = e.dynamic ? 0.03 : e.runtime ? 0.033 : TRUNKS.has(`${from} ${to}`) ? 0.075 : 0.045
  const color = e.dynamic ? 0xaab2bc : e.runtime ? 0xd8dce2 : districtColor[districtOf[from]]
  const mat = matFor(color, { roughness: 0.35, metalness: 0.6 })
  const group = new THREE.Group()
  group.name = name
  group.userData = { from, to, symbols: [...e.symbols].sort(), bus: pair ?? undefined,
    ...(e.dynamic ? { dynamic: true } : {}), ...(e.runtime ? { runtime: true } : {}) }
  const P = (x, y, z) => new THREE.Vector3(x, y, z)
  // L between two points at height H, longer axis first
  const legs = (x0, z0, x1, z1, H) =>
    Math.abs(x1 - x0) > Math.abs(z1 - z0)
      ? [P(x1, H, z0), P(x1, H, z1)]
      : [P(x0, H, z1), P(x1, H, z1)]
  let pts
  if (local) {
    const H = Math.max(aTop, ...B.items.map(i => i.h + SLAB_H)) + 0.35 + 0.5 * j
    pts = [P(ax, aTop, az), P(ax, H, az), ...legs(ax, az, jx, jz, H), P(jx, SLAB_H + 0.1, jz)]
  } else {
    const [pa, pb] = pair.split('|')
    const H = busHeight[pair]
    const o = slots[`${from} ${to}`] * 0.16
    const fa = mastPos[pa], fb = mastPos[pb]
    // shared L-tray in the sorted-pair frame: x-leg at z=fa.z+o, then
    // z-leg at x=fb.x+o; both directions of travel use the same rails
    const C1 = P(fa.x, H, fa.z + o), C2 = P(fb.x + o, H, fa.z + o), C3 = P(fb.x + o, H, fb.z)
    const corridor = districtOf[from] === pa ? [C1, C2, C3] : [C3, C2, C1]
    const entry = corridor[0], exit = corridor[corridor.length - 1]
    pts = [
      P(ax, aTop, az), P(ax, H, az),
      ...legs(ax, az, entry.x, entry.z, H),
      ...corridor,
      ...legs(exit.x, exit.z, jx, jz, H),
      P(jx, SLAB_H + 0.1, jz),
    ]
  }
  const longest = pipeRun(group, pts, r, mat)
  // flow cones: along the longest horizontal leg, and down into the socket
  if (longest) {
    const d = longest.q.clone().sub(longest.p).normalize()
    flowCone(group, longest.p.clone().add(longest.q).multiplyScalar(0.5), d, r, mat)
  }
  flowCone(group, P(jx, SLAB_H + 0.42, jz), P(0, -1, 0), r, mat)
  const collar = new THREE.Mesh(new THREE.CylinderGeometry(r * 2.0, r * 2.5, 0.1, 12), mat)
  collar.name = name + '_socket'
  collar.position.set(jx, SLAB_H + 0.05, jz)
  group.add(collar)
  const traceMat = matFor(dim(color, 0.85), { roughness: 0.4, metalness: 0.5 })
  for (const it of B.items) {
    if (!e.symbols.has(it.name)) continue
    const mx = B.x + it.x, mz = B.z + it.z
    const trace = new THREE.Group()
    trace.name = `${name}__${it.name.replace(/[^\w+]/g, '_')}`
    pipeRun(trace, [P(jx, SLAB_H + 0.04, jz),
      ...legs(jx, jz, mx, mz, SLAB_H + 0.04), P(mx, SLAB_H + Math.min(0.3, it.h * 0.55), mz)],
    0.018, traceMat)
    group.add(trace)
    collapsibles.push([trace.name, mx + mz])
  }
  pipes.add(group)
  pipeCount++
}

// masts: a pylon per district with a collar at each bus height it serves
const mastMat = matFor(0x596270, { roughness: 0.35, metalness: 0.8 })
for (const [d, m] of Object.entries(mastPos)) {
  const served = pairs.filter(p => p.split('|').includes(d)).map(p => busHeight[p])
  if (!served.length) continue
  const top = Math.max(...served) + 0.3
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.1, top, 10), mastMat)
  mast.name = `mast_${d}`
  mast.position.set(m.x, top / 2, m.z)
  mast.userData = { district: d, buses: pairs.filter(p => p.split('|').includes(d)) }
  pipes.add(mast)
  for (const h of served) {
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.1, 12), mastMat)
    ring.position.set(m.x, h, m.z)
    pipes.add(ring)
  }
}

// the manifest for examples/arch.js: what to collapse in skeleton mode,
// swept across the city in (x+z) order
const index = new THREE.Object3D()
index.name = 'arch_index'
index.userData = {
  version: 2,
  modules: Object.values(layout).map(L => (L.kind === 'vendor' ? 'dep_' : 'mod_') + L.id),
  collapse: collapsibles.sort((a, b) => a[1] - b[1]).map(([n]) => n),
}
world.add(index)

// -- floor + district labels + title --
const Ls = Object.values(layout)
const minX = Math.min(...Ls.map(L => L.x - L.hw)), maxX = Math.max(...Ls.map(L => L.x + L.hw))
const minZ = Math.min(...Ls.map(L => L.z - L.hd)), maxZ = Math.max(...Ls.map(L => L.z + L.hd))
const cx0 = (minX + maxX) / 2, cz0 = (minZ + maxZ) / 2
const ext = Math.max(maxX - minX, maxZ - minZ) / 2 + 4
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(ext * 2, ext * 2),
  new THREE.MeshStandardMaterial({ color: 0x232936, roughness: 1, name: 'ground' }))
floor.name = 'floor'
floor.rotation.x = -Math.PI / 2
floor.position.set(cx0, 0, cz0)
world.add(floor)
const floorText = (text, x, z, size) => {
  const t = textMesh(text, size, 100, matFor(0x434c5e, { roughness: 0.9 }))
  t.position.set(x, 0.012, z)
  world.add(t)
  return t
}
for (const dst of DISTRICTS) {
  if (dst === 'main') continue
  const Zs = Ls.filter(L => districtOf[L.id] === dst)
  const cx = Zs.reduce((n, L) => n + L.x, 0) / Zs.length, cz = Zs.reduce((n, L) => n + L.z, 0) / Zs.length
  const dx = cx - cx0, dz = cz - cz0
  const mag = Math.hypot(dx, dz) || 1
  let px = cx, pz = cz
  for (let step = 0; step < 40; step++) {
    if (!Ls.some(L => Math.abs(px - L.x) < L.hw + 1.2 && Math.abs(pz - L.z) < L.hd + 1.2)) break
    px += (dx / mag) * 0.8; pz += (dz / mag) * 0.8
  }
  floorText(districtName[dst].replace(/_/g, '/').toUpperCase(), px, pz + 0.6, 1.0)
}
floorText('worldsync', cx0 + ext - 5.5, cz0 + ext - 2, 1.3)
// the model explains itself: a legend etched into the floor south of
// the city
{
  const lines = [
    ['LEGEND', 0.7],
    ['slab = one src module in its district colour - dark rim-framed slab = external package', 0.5],
    ['box = function/class - tank = state/const - upright panel = type', 0.5],
    ['footprint = lines of code - height = how many modules consume it', 0.5],
    ['pipe = an import between two modules, riding its district-pair tray - cones point at the dependency', 0.5],
    ['slab traces = the exact symbols that import pulls - thin pale pipe = lazy import()', 0.5],
  ]
  let z = maxZ + 2.2
  for (const [text, size] of lines) {
    floorText(text, cx0, z, size)
    z += size + 0.42
  }
}

// --------------------------------------------------------------- export
const exporter = new GLTFExporter()
exporter.parse(world, result => {
  const out = join(ROOT, 'examples', 'arch.glb')
  writeFileSync(out, Buffer.from(result))
  const view = new DataView(result)
  const jsonLen = view.getUint32(12, true)
  const json = JSON.parse(Buffer.from(result, 20, jsonLen).toString('utf8'))
  const slabs = json.nodes.filter(n => /^(mod|dep)_[^_]/.test(n.name ?? '') && n.extras?.module)
  const memberNodes = json.nodes.filter(n => n.extras?.member)
  const pipeNodes = json.nodes.filter(n => n.extras?.from)
  const idx = json.nodes.find(n => n.name === 'arch_index')
  console.log(`wrote ${out}`)
  console.log(`  ${(result.byteLength / 1024).toFixed(0)} kB, ${json.nodes.length} nodes: `
    + `${slabs.length} modules, ${memberNodes.length} members, ${pipeNodes.length} pipes, `
    + `${pairs.length} buses, districts: ${DISTRICTS.filter(d => d !== 'main').join(', ')}`)
  const expected = Object.keys(layout).length
  if (slabs.length !== expected) { console.error(`FAIL: ${slabs.length} slabs, expected ${expected}`); process.exit(1) }
  if (pipeNodes.length !== pipeCount) { console.error('FAIL: pipe count mismatch'); process.exit(1) }
  if (!idx?.extras?.collapse?.length) { console.error('FAIL: arch_index manifest missing'); process.exit(1) }
  if (DISTRICTS.length < 4) { console.error('FAIL: clustering degenerated'); process.exit(1) }
}, err => { console.error(err); process.exit(1) }, { binary: true })

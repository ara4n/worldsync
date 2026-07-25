// Build examples/arch.glb: the worldsync architecture as a 3D WORLD -
// the codebase rendered as a machine, at MEMBER granularity. The
// dependency data is not curated: this tool parses src/ with the
// TypeScript compiler API. Every module is a district slab carrying
// blocks for its major members (top-level classes/functions/consts;
// when one class or function dominates the file - Sim, Session, View,
// main() - the tool descends into it and its methods/fields become the
// blocks). Member footprint ~ lines of code; member height ~ how many
// modules import that symbol, so load-bearing API surfaces read as
// towers. Modules cluster into districts (deterministic core north,
// rendering east, scripting south, transports west) with third-party
// dependencies (one layer deep, graphite, sub-blocks for just the
// symbols we consume) on each district's outer edge.
//
// Pipes are import edges, colored by the consuming district: a trunk
// rises from the consumer slab, drops onto a collared junction at the
// provider slab's near edge, and thin traces fan out PCB-style from
// the junction to the exact member blocks that edge imports. Dynamic
// import() seams get thin pale pipes; the ws /signal wire to the vite
// dev server is the one runtime (non-import) pipe.
//
// Built for telemetry overlay: every slab, member and pipe is a named
// node (mod_sim, mod_sim__rollback, dep_three__Mesh, pipe_main__sim)
// carrying {module, member, kind, zone, loc, symbols, ...} in its glTF
// extras - the same rig pattern as the piano keys - so a world script
// (or any glTF tool) can find a function by name and scale/raise it
// from profiling data.
//
// Run: node tools/arch-glb.mjs
// View: upload with "load glTF scene (.glb)" (it is a world with its
// own floor + collider), or any glTF viewer.
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

// ---------------------------------------------------------------- model
const ZONES = {
  core: 0x4f7cac, // the deterministic netcode heart
  render: 0xc9913d,
  script: 0x8a6fc9, // the QuickJS sandbox + authoring
  transport: 0x3d9ba0, // ws demo mesh + the Matrix/LiveKit stack
  vendor: 0x2e333b,
  infra: 0x78828e, // dev harness: signaling plugin, mock host, headless hub
}

/** app modules: id -> [file, zone, district anchor x, z] */
const MODULES = {
  main: ['src/main.ts', 'core', 0, 0],
  sim: ['src/sim.ts', 'core', 0.4, -7.6],
  session: ['src/session.ts', 'core', -4.6, -6.2],
  ecs: ['src/ecs.ts', 'core', 3.4, -5.6],
  types: ['src/types.ts', 'core', 5.6, -7.4],
  color: ['src/color.ts', 'core', 3.6, -3.4],
  wire: ['src/wire.ts', 'core', -7.6, -7.0],
  input: ['src/input.ts', 'core', -3.6, -3.0],
  hub: ['src/hub.ts', 'infra', -10.4, -8.4],
  render: ['src/render.ts', 'render', 8.2, -1.6],
  props: ['src/props.ts', 'render', 10.6, -4.4],
  scene: ['src/scene.ts', 'render', 8.0, 2.6],
  audio: ['src/audio.ts', 'render', 11.2, 1.0],
  inspector: ['src/inspector.ts', 'render', 11.0, 4.6],
  websg: ['src/websg.ts', 'script', 0.8, 7.0],
  websg_dts: ['src/websg-dts.ts', 'script', 4.8, 7.6],
  editor: ['src/editor.ts', 'script', 8.0, 8.4],
  ui: ['src/ui.ts', 'script', -2.8, 6.4],
  net: ['src/net.ts', 'transport', -7.8, -2.4],
  vite_signal: ['vite.config.ts', 'infra', -11.4, -4.0],
  matrix_net: ['src/matrix/net.ts', 'transport', -9.4, 2.0],
  matrix_transport: ['src/matrix/transport.ts', 'transport', -13.0, -0.6],
  matrix_widget: ['src/matrix/widget.ts', 'transport', -11.6, 4.8],
  matrix_world: ['src/matrix/world.ts', 'transport', -8.2, 5.6],
  matrix_params: ['src/matrix/params.ts', 'transport', -6.2, 3.6],
  mock_host: ['src/mock/host.ts', 'infra', -13.6, 7.4],
}

/** vendor packages (one layer deep): id -> [label, match, x, z] */
const VENDORS = {
  three: ['three', /^three(\/|$)/, 16.4, -1.0],
  rapier: ['@dimforge/rapier3d', /^@dimforge\//, 0.4, -12.4],
  bitecs: ['bitecs', /^bitecs$/, 4.0, -11.4],
  cbor_x: ['cbor-x', /^cbor-x$/, -7.6, -10.6],
  quickjs: ['quickjs-emscripten', /^(quickjs-emscripten|@jitl\/)/, 0.8, 11.6],
  monaco: ['monaco-editor', /^monaco-editor(\/|$)/, 8.0, 12.4],
  sanitize_html: ['sanitize-html', /^sanitize-html$/, -5.6, 10.4],
  livekit: ['livekit-client', /^livekit-client$/, -17.0, -3.0],
  matrix_js_sdk: ['matrix-js-sdk', /^matrix-js-sdk(\/|$)/, -17.4, 2.2],
  matrix_widget_api: ['matrix-widget-api', /^matrix-widget-api$/, -16.6, 6.6],
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

/** top-level (or descended) named declarations with line spans */
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

const analyzed = {} // id -> { loc, members[], imports: Map(provider -> {symbols:Set, dynamic}) }
for (const [id, [file]] of Object.entries(MODULES)) {
  const text = readFileSync(join(ROOT, file), 'utf8')
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true)
  const loc = text.split('\n').length
  // imports (static + dynamic), symbol-accurate for named bindings
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
      // namespace import: harvest actual member usage (THREE.Mesh, ...)
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
  // members: top-level decls; descend when one class/function dominates
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
// the one runtime (non-import) wire: the ws demo signaling to the vite plugin
analyzed.net.imports.set('vite_signal', { symbols: new Set(['/signal']), dynamic: false, runtime: true })
analyzed.vite_signal = {
  loc: readFileSync(join(ROOT, 'vite.config.ts'), 'utf8').split('\n').length,
  members: [{ name: 'signaling ws', lines: 100, kind: 'function', pub: true, container: null }],
  imports: new Map(),
}

// vendor members: the symbols the app actually pulls, weighted by how
// many modules pull them
const vendorUse = Object.fromEntries(Object.keys(VENDORS).map(k => [k, new Map()]))
for (const a of Object.values(analyzed)) {
  for (const [provider, e] of a.imports) {
    if (!vendorUse[provider]) continue
    for (const s of e.symbols) vendorUse[provider].set(s, (vendorUse[provider].get(s) ?? 0) + 1)
  }
}

// symbol -> consumer-module count per app provider (member load-bearing)
const symbolConsumers = Object.fromEntries(Object.keys(MODULES).map(k => [k, new Map()]))
for (const a of Object.values(analyzed)) {
  for (const [provider, e] of a.imports) {
    if (!symbolConsumers[provider]) continue
    for (const s of e.symbols) symbolConsumers[provider].set(s, (symbolConsumers[provider].get(s) ?? 0) + 1)
  }
}
const indeg = Object.fromEntries([...Object.keys(MODULES), ...Object.keys(VENDORS)].map(k => [k, 0]))
for (const a of Object.values(analyzed)) for (const p of a.imports.keys()) indeg[p]++

// ------------------------------------------------------------- geometry
/** shelf-pack member footprints onto a slab; returns placed rects and
 * the slab half-extents */
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

// build per-block layouts
const layout = {} // id -> { x, z, hw, hd, items[], zone, kind, module, loc }
for (const [id, [file, zone, x, z]] of Object.entries(MODULES)) {
  const a = analyzed[id]
  const items = a.members.map(m => ({
    ...m, ...memberDims(m, symbolConsumers[id].get(m.name) ?? 0),
    consumers: symbolConsumers[id].get(m.name) ?? 0,
  }))
  const { hw, hd } = pack(items, 0.22)
  layout[id] = { id, x, z, hw: hw + 0.42, hd: hd + 0.42, items, zone,
    kind: zone === 'infra' ? 'infra' : 'app', module: file, loc: a.loc }
}
for (const [id, [label, , x, z]] of Object.entries(VENDORS)) {
  const uses = [...vendorUse[id].entries()].sort((a, b) => b[1] - a[1])
  const kept = uses.slice(0, 10)
  const items = kept.map(([name, n]) => ({ name, lines: 0, kind: 'symbol', pub: true,
    container: null, consumers: n, ...vendorMemberDims(n) }))
  if (uses.length > 10) {
    items.push({ name: `+${uses.length - 10}`, lines: 0, kind: 'misc', pub: false,
      container: null, consumers: 0, ...vendorMemberDims(1) })
  }
  if (!items.length) items.push({ name: label, lines: 0, kind: 'symbol', pub: true,
    container: null, consumers: 1, ...vendorMemberDims(1) })
  const { hw, hd } = pack(items, 0.2)
  layout[id] = { id, x, z, hw: hw + 0.38, hd: hd + 0.38, items, zone: 'vendor',
    kind: 'vendor', module: label, loc: undefined }
}

// relax slab positions so nothing overlaps (main stays pinned)
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

// flat ShapeGeometry text (no extrusion): an order of magnitude lighter
// than TextGeometry across ~280 labels
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

for (const L of Object.values(layout)) {
  const group = new THREE.Group()
  group.name = (L.kind === 'vendor' ? 'dep_' : 'mod_') + L.id
  group.position.set(L.x, 0, L.z)
  group.userData = {
    module: L.module, kind: L.kind, zone: L.zone, loc: L.loc,
    deps: [...(analyzed[L.id]?.imports.keys() ?? [])],
    dependents: indeg[L.id],
  }
  const slab = new THREE.Mesh(new THREE.BoxGeometry(L.hw * 2, SLAB_H, L.hd * 2),
    matFor(dim(ZONES[L.zone], L.kind === 'vendor' ? 1 : 0.45)))
  slab.name = group.name + '_slab'
  slab.position.y = SLAB_H / 2
  group.add(slab)
  for (const it of L.items) {
    const color = L.kind === 'vendor' ? 0x4a5058
      : it.kind === 'misc' ? dim(ZONES[L.zone], 0.5)
      : it.pub ? ZONES[L.zone] : dim(ZONES[L.zone], 0.62)
    const box = new THREE.Mesh(new THREE.BoxGeometry(it.w, it.h, it.d), matFor(color))
    box.name = `${group.name}__${it.name.replace(/[^\w+]/g, '_')}`
    box.position.set(it.x, SLAB_H + it.h / 2, it.z)
    box.userData = {
      member: it.name, of: L.module, in: it.container ?? undefined, kind: it.kind,
      loc: it.lines || undefined, consumers: it.consumers || undefined, exported: it.pub,
    }
    group.add(box)
    const lbl = textMesh(it.name, 0.16, it.w * 0.94, L.kind === 'vendor' || !it.pub ? labelLight : labelDark)
    lbl.position.set(it.x, SLAB_H + it.h + 0.015, it.z)
    group.add(lbl)
  }
  // module nameplate on the slab's south margin
  const plate = textMesh(L.id.replace(/_/g, L.module.startsWith('src/m') && L.id.startsWith('matrix') ? '/' : '-'),
    0.34, L.hw * 1.8, L.kind === 'vendor' ? labelLight : matFor(0xf2f4f7, { roughness: 0.4 }))
  plate.name = group.name + '_plate'
  plate.position.set(0, SLAB_H + 0.015, L.hd - 0.24)
  group.add(plate)
  world.add(group)
}

// -- pipes + traces --
const hash01 = (s) => {
  let h = 2166136261
  for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) }
  return ((h >>> 0) % 1000) / 1000
}
const pipes = new THREE.Group()
pipes.name = 'pipes'
world.add(pipes)
let pipeCount = 0
for (const [from, a] of Object.entries(analyzed)) {
  for (const [to, e] of a.imports) {
    const A = layout[from], B = layout[to]
    if (!A || !B) continue
    const name = `pipe_${from}__${to}`
    const j = hash01(name)
    // trunk: consumer slab top -> overhead lane -> junction inside the
    // provider slab's edge nearest the consumer
    const ax = A.x + (j - 0.5) * A.hw, az = A.z + (hash01(name + 'z') - 0.5) * A.hd
    const dirx = A.x - B.x, dirz = A.z - B.z
    const mag = Math.hypot(dirx, dirz) || 1
    const jx = B.x + (dirx / mag) * (Math.abs(dirx / mag) * B.hw) * 0.82
    const jz = B.z + (dirz / mag) * (Math.abs(dirz / mag) * B.hd) * 0.82
    const dist = Math.hypot(jx - ax, jz - az)
    const aTop = Math.max(...A.items.map(i => i.h)) + SLAB_H
    const lane = Math.max(1.1 + 2.2 * j + dist * 0.06, aTop + 0.5)
    const r = e.dynamic ? 0.034 : e.runtime ? 0.036 : TRUNKS.has(`${from} ${to}`) ? 0.1 : 0.055
    const color = e.dynamic ? 0xaab2bc : e.runtime ? 0xd8dce2 : ZONES[A.zone]
    const mat = matFor(color, { roughness: 0.35, metalness: 0.6 })
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(ax, aTop, az),
      new THREE.Vector3(ax, lane, az),
      new THREE.Vector3((ax + jx) / 2, lane + dist * 0.02, (az + jz) / 2),
      new THREE.Vector3(jx, lane * 0.55, jz),
      new THREE.Vector3(jx, SLAB_H, jz),
    ])
    const pipe = new THREE.Mesh(new THREE.TubeGeometry(curve, 48, r, 10), mat)
    pipe.name = name
    pipe.userData = { from, to, symbols: [...e.symbols].sort(),
      ...(e.dynamic ? { dynamic: true } : {}), ...(e.runtime ? { runtime: true } : {}) }
    pipes.add(pipe)
    pipeCount++
    const collar = new THREE.Mesh(new THREE.CylinderGeometry(r * 2.0, r * 2.5, 0.1, 12), mat)
    collar.name = name + '_socket'
    collar.position.set(jx, SLAB_H + 0.05, jz)
    pipes.add(collar)
    // traces: junction -> each imported member present on the slab
    const traceMat = matFor(dim(color, 0.85), { roughness: 0.4, metalness: 0.5 })
    for (const it of B.items) {
      if (!e.symbols.has(it.name)) continue
      const mx = B.x + it.x, mz = B.z + it.z
      const tc = new THREE.CatmullRomCurve3([
        new THREE.Vector3(jx, SLAB_H + 0.02, jz),
        new THREE.Vector3((jx + mx) / 2, SLAB_H + 0.22, (jz + mz) / 2),
        new THREE.Vector3(mx, SLAB_H + Math.min(0.3, it.h * 0.55), mz),
      ])
      const trace = new THREE.Mesh(new THREE.TubeGeometry(tc, 12, 0.02, 8), traceMat)
      trace.name = `${name}__${it.name.replace(/[^\w+]/g, '_')}`
      pipes.add(trace)
    }
  }
}

// -- floor centered on the relaxed city's bounding box, district
// labels pushed just past each district's outer edge --
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
for (const [zone, label] of [['core', 'CORE'], ['render', 'RENDER'], ['script', 'SCRIPTING'], ['transport', 'TRANSPORT']]) {
  const Zs = Ls.filter(L => L.zone === zone)
  const cx = Zs.reduce((n, L) => n + L.x, 0) / Zs.length, cz = Zs.reduce((n, L) => n + L.z, 0) / Zs.length
  const dx = cx - cx0, dz = cz - cz0
  const mag = Math.hypot(dx, dz) || 1
  // walk outward from the district centroid until clear of every slab
  let px = cx, pz = cz
  for (let step = 0; step < 40; step++) {
    if (!Ls.some(L => Math.abs(px - L.x) < L.hw + 1.2 && Math.abs(pz - L.z) < L.hd + 1.2)) break
    px += (dx / mag) * 0.8; pz += (dz / mag) * 0.8
  }
  floorText(label, px, pz + 0.6, 1.0)
}
floorText('worldsync', cx0 + ext - 5.5, cz0 + ext - 2, 1.3)

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
  console.log(`wrote ${out}`)
  console.log(`  ${(result.byteLength / 1024).toFixed(0)} kB, ${json.nodes.length} nodes: `
    + `${slabs.length} modules, ${memberNodes.length} members, ${pipeNodes.length} pipes; `
    + `floor ${Math.round(ext * 2)}m`)
  const expected = Object.keys(layout).length
  if (slabs.length !== expected) { console.error(`FAIL: ${slabs.length} slabs, expected ${expected}`); process.exit(1) }
  if (pipeNodes.length !== pipeCount) { console.error('FAIL: pipe count mismatch'); process.exit(1) }
  if (!memberNodes.every(n => n.extras.of)) { console.error('FAIL: member extras missing provenance'); process.exit(1) }
}, err => { console.error(err); process.exit(1) }, { binary: true })

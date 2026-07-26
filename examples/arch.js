// Architecture explorer: the world script for examples/arch.glb (built
// by tools/arch-glb.mjs). The glb carries an 'arch_index' node whose
// extras list every collapsible detail node (member blocks, member
// labels, per-symbol traces) in a city-sweep order, plus every module
// slab. This script:
//  - SPACE toggles between full member detail and the module-dependency
//    skeleton (slabs + pipes + buses only), collapsing detail in a wave
//    that sweeps across the city (scale is the safe cosmetic channel).
//  - Hovering a pipe lights it up (world.highlight) along with the two
//    modules it connects; hovering a module lights the module and its
//    whole loom of pipes, in and out.
//  - Clicking a module slab reads its glTF extras and shows the module,
//    its size, district, dependencies and dependents on the HUD.
// Everything here is local cosmetics: nothing folds, nothing syncs.

let manifest = null
let mode = 'full' // 'full' | 'skeleton'
let queue = [] // node names still to (un)collapse this sweep
let target = 1
let selected = null
let hovered = null // entity name under the pointer
let hoverInfo = ''
const PER_UPDATE = 60

function rig() {
  if (manifest) return true
  const idx = world.findNodeByName('arch_index')
  if (!idx || !idx.extras || !idx.extras.collapse) return false
  manifest = idx.extras
  for (const name of manifest.modules) {
    const n = world.findNodeByName(name)
    if (n) n.addInteractable()
  }
  for (const name of manifest.pipes || []) {
    const n = world.findNodeByName(name)
    if (n) n.addInteractable()
  }
  hud()
  return true
}

// 'sim' -> 'mod_sim' or 'dep_three', whichever exists
function moduleNode(id) {
  if (world.findNodeByName('mod_' + id)) return 'mod_' + id
  if (world.findNodeByName('dep_' + id)) return 'dep_' + id
  return null
}

world.onpointermove = (ev) => {
  if (!rig()) return
  const ent = ev.entity && (ev.entity.startsWith('pipe_') || ev.entity.startsWith('mod_')
    || ev.entity.startsWith('dep_')) ? ev.entity : null
  // the avatar's hand tracks the hovered pipe/module (guarded: stale
  // host bundles predate world.aim); before the ent===hovered return,
  // so the point follows the pointer ALONG a pipe too
  if (world.aim) world.aim(ent ? ev.point : null)
  if (ent === hovered) return
  hovered = ent
  if (!ent) {
    world.highlight([])
    hoverInfo = ''
  } else if (ent.startsWith('pipe_')) {
    const [from, to] = ent.slice(5).split('__')
    world.highlight([ent, moduleNode(from), moduleNode(to)].filter(Boolean))
    const x = world.findNodeByName(ent)
    const syms = (x && x.extras && x.extras.symbols) || []
    hoverInfo = `<b>${from}</b> imports <b>${to}</b>`
      + (syms.length ? `: ${syms.slice(0, 8).join(', ')}${syms.length > 8 ? ', ...' : ''}` : '')
  } else {
    // a module: light it plus its whole loom, both directions
    const id = ent.replace(/^(mod|dep)_/, '')
    const loom = (manifest.pipes || []).filter((p) => {
      const [from, to] = p.slice(5).split('__')
      return from === id || to === id
    })
    world.highlight([ent, ...loom])
    hoverInfo = `<b>${id}</b>: ${loom.length} pipe(s)`
  }
  hud()
}

world.onload = () => {
  world.env({ background: 0x0b0d12, fog: { color: 0x0b0d12, near: 40, far: 110 } })
  world.camera({ x: 26, y: 24, z: 30 }, { x: 0, y: 0, z: 0 })
}

world.onkeydown = (ev) => {
  if (ev.key !== ' ' || !rig()) return
  mode = mode === 'full' ? 'skeleton' : 'full'
  target = mode === 'skeleton' ? 0.001 : 1
  // re-sweep from the far corner every time; mid-flight toggles just
  // reverse the wave over whatever is left plus everything again
  queue = manifest.collapse.slice()
  hud()
}

world.onpointerdown = (ev) => {
  if (!ev.entity || !rig()) return
  if (!ev.entity.startsWith('mod_') && !ev.entity.startsWith('dep_')) return
  const n = world.findNodeByName(ev.entity)
  selected = n && n.extras ? { name: ev.entity, ...n.extras } : null
  hud()
}

world.onupdate = () => {
  if (!rig() || !queue.length) return
  for (const name of queue.splice(0, PER_UPDATE)) {
    const n = world.findNodeByName(name)
    if (n) n.scale = { x: target, y: target, z: target }
  }
  if (!queue.length) hud()
}

function hud() {
  let sel = ''
  if (selected) {
    const deps = (selected.deps || []).join(', ') || 'none'
    sel = `<p style="margin:4px 0 0 0"><b>${selected.name}</b> - ${selected.module}`
      + (selected.loc ? ` (${selected.loc} lines)` : '')
      + `<br>district: ${selected.district} &middot; dependents: ${selected.dependents}`
      + `<br>imports: ${deps}</p>`
  }
  world.hud(
    '<h3 style="margin:0">worldsync architecture '
    + `<span style="font-size:11px;opacity:0.6">script v4 / glb v${(manifest && manifest.version) || '?'}</span></h3>`
    + `<p style="margin:2px 0">SPACE: ${mode === 'full' ? 'collapse to module skeleton' : 'expand member detail'}`
    + (queue.length ? ' (sweeping...)' : '')
    + '<br>slab = module (rim-framed = external pkg), blocks = its functions/state/types'
    + '<br>pipes = imports between modules, cones point at the dependency'
    + '<br>hover a pipe or module to light it up; click a slab for info</p>'
    + (hoverInfo ? `<p style="margin:2px 0">${hoverInfo}</p>` : '')
    + sel)
}

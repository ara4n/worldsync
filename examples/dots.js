// dots-3d, multiplayer, as a worldsync WebSG script. Every peer runs this
// sandboxed; nobody talks to the network. The board is sim state (props),
// so it is identical on every peer; claims are the coordination primitive:
// you chain dots by claiming them one at a time, racing rivals dot-by-dot,
// and claim races resolve deterministically in timeline order. Your chain
// line (and everyone else's, in their own colour) is ephemeral cosmetic
// state that rides beside the sim. Outcomes (clears, drops, refills,
// reshuffles) are computed by the acting peer and shipped as ops, so no
// shared randomness is ever needed.
//
// Upload with "load world script (.js)". Drag same-coloured adjacent dots
// to chain them; release to clear chains of 2+; close a loop to clear the
// whole colour. Backtrack through the previous dot to unwind a link.

const W = 3, H = 3, D = 3
const COLORS = [0xda664f, 0x9060b0, 0xe3db50, 0x94baf9, 0xa0e699]
const R = 0.16
const ORG = { x: -(W - 1) / 2, y: 1.4, z: -(D - 1) / 2 }

const at = (x, y, z) => ({ x: ORG.x + x, y: ORG.y + y, z: ORG.z + z })
const gridOf = (p) => ({ x: Math.round(p.x - ORG.x), y: Math.round(p.y - ORG.y), z: Math.round(p.z - ORG.z) })
const key = (x, y, z) => x + ',' + y + ',' + z
const rnd = (n) => Math.floor(Math.random() * n)
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

let sel = []          // netIds of my chain, in selection order
let drawing = false
let cycleColor = null // set when the chain closes a loop
let anchor = null     // world position of the chain's last dot
let planeN = null     // preview plane normal: pointer ray at chain start
let preview = null    // current preview endpoint on that plane
let seeded = false

world.onload = () => {
  world.env({ background: 0xffffff, fog: { color: 0xffffff, near: 4.5, far: 11 }, ground: false })
  world.camera({ x: 0, y: ORG.y + 1, z: 5.2 }, { x: 0, y: ORG.y + 1, z: 0 })
  lattice(0.25)
}

function lattice(opacity) {
  const segs = []
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) segs.push([at(x, y, 0), at(x, y, D - 1)])
    for (let z = 0; z < D; z++) segs.push([at(x, 0, z), at(x, H - 1, z)])
  }
  for (let y = 0; y < H; y++) for (let z = 0; z < D; z++) segs.push([at(0, y, z), at(W - 1, y, z)])
  world.decorLines('lattice', segs, 0xdddddd, opacity)
}

/** does any adjacent same-colour pair exist in a full board colour map? */
function solvable(cols) {
  for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) for (let z = 0; z < D; z++) {
    const c = cols[key(x, y, z)]
    if (x + 1 < W && cols[key(x + 1, y, z)] === c) return true
    if (y + 1 < H && cols[key(x, y + 1, z)] === c) return true
    if (z + 1 < D && cols[key(x, y, z + 1)] === c) return true
  }
  return false
}

world.onupdate = () => {
  // Board init is single-runner logic: only the primary seeds, and only
  // into an empty world. The colours are the primary's dice, shipped in
  // the spawn ops; solvability is checked before anything is spawned.
  if (!seeded && world.props().length > 0) seeded = true
  if (!seeded && world.me.primary) {
    seeded = true
    let cols
    do {
      cols = {}
      for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) for (let z = 0; z < D; z++) {
        cols[key(x, y, z)] = COLORS[rnd(COLORS.length)]
      }
    } while (!solvable(cols))
    for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) for (let z = 0; z < D; z++) {
      world.createSphere({ position: at(x, y, z), color: cols[key(x, y, z)], radius: R, unlit: true })
    }
    console.log('board seeded')
  }
  if (drawing) {
    revalidate()
    updateLine()
  }
}

world.onpointerdown = (ev) => {
  if (!ev.entity) return
  const p = world.prop(ev.entity)
  if (!p || p.claimedBy) return
  if (!world.claim(p.id)) return
  sel = [p.id]
  drawing = true
  cycleColor = null
  planeN = ev.dir
  anchor = { x: p.x, y: p.y, z: p.z }
  preview = null
  lattice(1.0)
}

world.onpointermove = (ev) => {
  if (!drawing) return
  if (ev.entity && sel.length) {
    const q = world.prop(ev.entity)
    if (q) extend(q)
  }
  preview = anchor && planeN ? WebSG.rayPlane(ev.origin, ev.dir, anchor, planeN) : null
  updateLine()
}

function extend(q) {
  const lastId = sel[sel.length - 1]
  if (q.id === lastId) return
  const last = world.prop(lastId)
  if (!last) return
  if (q.id === sel[sel.length - 2]) {
    // slid back into the previous dot: unwind the newest link
    world.unclaim(lastId)
    sel.pop()
    anchor = { x: q.x, y: q.y, z: q.z }
    return
  }
  if (q.color !== last.color) return
  if (dist(q, last) > 1.1) return
  if (sel.indexOf(q.id) !== -1) { cycleColor = q.color; return } // closed a loop
  if (q.claimedBy) return // a rival got this dot first
  if (!world.claim(q.id)) return
  sel.push(q.id)
  anchor = { x: q.x, y: q.y, z: q.z }
}

world.onpointerup = () => {
  if (!drawing) return
  drawing = false
  lattice(0.25)
  revalidate()
  if (sel.length > 1 || (cycleColor !== null && sel.length > 0)) clearChain()
  else for (const id of sel) world.unclaim(id)
  sel = []
  cycleColor = null
  preview = null
  world.chainLine([])
}

/** Rollback folds can hand a raced dot to a rival after we optimistically
 * chained it: truncate at the first dot that is no longer ours and free
 * anything ours beyond the break. */
function revalidate() {
  const me = world.me.id
  let bad = -1
  for (let i = 0; i < sel.length; i++) {
    const p = world.prop(sel[i])
    if (!p || (p.claimedBy && p.claimedBy !== me)) { bad = i; break }
  }
  if (bad !== -1) {
    for (let i = bad; i < sel.length; i++) {
      const p = world.prop(sel[i])
      if (p && p.claimedBy === me) world.unclaim(sel[i])
    }
    sel = sel.slice(0, bad)
  }
  if (sel.length) {
    const a = world.prop(sel[sel.length - 1])
    if (a) anchor = { x: a.x, y: a.y, z: a.z }
  } else if (drawing) {
    drawing = false
    lattice(0.25)
    world.chainLine([])
  }
}

function updateLine() {
  const pts = []
  for (const id of sel) {
    const p = world.prop(id)
    if (p) pts.push({ x: p.x, y: p.y, z: p.z })
  }
  if (preview) pts.push(preview)
  world.chainLine(pts.length >= 2 ? pts : [])
}

/** The acting peer computes the whole outcome (clears, drops, refills, a
 * reshuffle if the result is dead) and ships it as ops; everyone else just
 * folds them. Board-structure edits win over rivals' in-flight chains,
 * whose scripts revalidate against the moved dots. */
function clearChain() {
  const me = world.me.id
  const ids = sel.slice()
  if (cycleColor !== null) {
    // a closed loop clears every dot of its colour not held by a rival
    for (const p of world.props()) {
      if (p.color === cycleColor && (!p.claimedBy || p.claimedBy === me) && ids.indexOf(p.id) === -1) ids.push(p.id)
    }
  }
  const remove = {}
  for (const id of ids) remove[id] = true
  const columns = {} // "x,z" -> surviving dots, sorted low-to-high
  for (const p of world.props()) {
    if (remove[p.id]) continue
    const g = gridOf(p)
    if (g.x < 0 || g.x >= W || g.y < 0 || g.y >= H || g.z < 0 || g.z >= D) continue
    const ck = g.x + ',' + g.z
    ;(columns[ck] = columns[ck] || []).push({ id: p.id, y: g.y, color: p.color })
  }
  for (const id of ids) world.despawn(id)
  const cells = [] // resulting board: { id, key, color }
  for (let x = 0; x < W; x++) {
    for (let z = 0; z < D; z++) {
      const list = (columns[x + ',' + z] || []).sort((a, b) => a.y - b.y)
      for (let i = 0; i < list.length; i++) {
        if (list[i].y !== i) world.move(list[i].id, at(x, i, z))
        cells.push({ id: list[i].id, key: key(x, i, z), color: list[i].color })
      }
      for (let y = list.length; y < H; y++) {
        const c = COLORS[rnd(COLORS.length)]
        const id = world.createSphere({ position: at(x, y, z), color: c, radius: R, unlit: true })
        cells.push({ id, key: key(x, y, z), color: c })
      }
    }
  }
  const board = {}
  for (const cell of cells) board[cell.key] = cell.color
  if (!solvable(board)) {
    console.log('stalemate: reshuffling')
    let fresh
    do {
      fresh = {}
      for (const cell of cells) fresh[cell.key] = COLORS[rnd(COLORS.length)]
    } while (!solvable(fresh))
    for (const cell of cells) {
      if (fresh[cell.key] !== cell.color) world.paint(cell.id, fresh[cell.key])
    }
  }
}

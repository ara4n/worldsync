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
// whole colour. Backtrack through the previous dot to unwind a link. The
// chain may revisit its own dots (that is how loops close), but each
// SEGMENT is unique: a link already in the chain can never be re-added,
// in either direction.

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
let chain = null      // shared line entity: my chain, everyone sees it
let latticeLines = [] // local line entities, one per grid guide
let latticeTarget = 0.25
let pendingDrops = [] // refills spawned above the board, dropped a beat later
let dropWait = 0

world.onload = () => {
  world.env({ background: 0xffffff, fog: { color: 0xffffff, near: 4.5, far: 11 }, ground: false })
  world.camera({ x: 0, y: ORG.y + 1, z: 5.2 }, { x: 0, y: ORG.y + 1, z: 0 })
  const segs = []
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) segs.push([at(x, y, 0), at(x, y, D - 1)])
    for (let z = 0; z < D; z++) segs.push([at(x, 0, z), at(x, H - 1, z)])
  }
  for (let y = 0; y < H; y++) for (let z = 0; z < D; z++) segs.push([at(0, y, z), at(W - 1, y, z)])
  latticeLines = segs.map((s) => world.createLine({ points: s, color: 0xdddddd, opacity: 0, width: 1 }))
  // the wire: world-units width after the original's cylinder segments
  // (radius 0.0286 at dot radius 0.15), recolored per drag to the chained
  // dots' color
  chain = world.createLine({ points: [], color: world.me.color, width: 0.06, worldUnits: true, shared: true })
}

/** ease the lattice toward its target opacity; called every update */
function fadeLattice() {
  for (const l of latticeLines) {
    const d = latticeTarget - l.opacity
    if (Math.abs(d) > 0.01) l.opacity += d * 0.12
    else if (l.opacity !== latticeTarget) l.opacity = latticeTarget
  }
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
  // Refills spawn above the board and settle a couple of ticks later: the
  // spawn and the move must land on different ticks for every renderer to
  // see the drop (a same-tick move would just create them in place).
  if (pendingDrops.length && ++dropWait >= 2) {
    for (const d of pendingDrops) world.move(d.id, d.pos)
    pendingDrops = []
    dropWait = 0
  }
  fadeLattice()
}

world.onpointerdown = (ev) => {
  if (!ev.entity) return
  const p = world.prop(ev.entity)
  if (!p || p.claimedBy) return
  if (!world.claim(p.id)) return
  sel = [p.id]
  drawing = true
  cycleColor = null
  chain.color = p.color
  planeN = ev.dir
  anchor = { x: p.x, y: p.y, z: p.z }
  preview = null
  latticeTarget = 1.0
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

/** does the chain revisit any dot? (a dot appearing twice = a loop) */
const hasLoop = () => new Set(sel).size !== sel.length

function extend(q) {
  const lastId = sel[sel.length - 1]
  if (q.id === lastId) return
  const last = world.prop(lastId)
  if (!last) return
  if (q.id === sel[sel.length - 2]) {
    // slid back into the previous dot: unwind the newest link (keep the
    // claim when the dot still appears earlier in the chain - a loop)
    const popped = sel.pop()
    if (sel.indexOf(popped) === -1) world.unclaim(popped)
    if (!hasLoop()) cycleColor = null
    anchor = { x: q.x, y: q.y, z: q.z }
    return
  }
  if (q.color !== last.color) return
  if (dist(q, last) > 1.1) return
  // a segment may only ever be added once, in either direction: revisiting
  // our own dots through FRESH segments is what defines a loop, while
  // retracing an existing link (or backtracking) is never an extension
  for (let i = 1; i < sel.length; i++) {
    if ((sel[i - 1] === lastId && sel[i] === q.id) || (sel[i - 1] === q.id && sel[i] === lastId)) return
  }
  if (sel.indexOf(q.id) !== -1) {
    // revisiting a dot we already hold via a new segment: a loop closed
    if (q.claimedBy !== world.me.id) return
    cycleColor = q.color
  } else {
    if (q.claimedBy) return // a rival got this dot first
    if (!world.claim(q.id)) return
  }
  sel.push(q.id)
  anchor = { x: q.x, y: q.y, z: q.z }
}

world.onpointerup = () => {
  if (!drawing) return
  drawing = false
  latticeTarget = 0.25
  revalidate()
  if (sel.length > 1 || (cycleColor !== null && sel.length > 0)) clearChain()
  else for (const id of sel) world.unclaim(id)
  sel = []
  cycleColor = null
  preview = null
  chain.points = []
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
    const keep = sel.slice(0, bad)
    for (let i = bad; i < sel.length; i++) {
      if (keep.indexOf(sel[i]) !== -1) continue // still chained via a loop
      const p = world.prop(sel[i])
      if (p && p.claimedBy === me) world.unclaim(sel[i])
    }
    sel = keep
    if (!hasLoop()) cycleColor = null
  }
  if (sel.length) {
    const a = world.prop(sel[sel.length - 1])
    if (a) anchor = { x: a.x, y: a.y, z: a.z }
  } else if (drawing) {
    drawing = false
    latticeTarget = 0.25
    chain.points = []
  }
}

function updateLine() {
  const pts = []
  for (const id of sel) {
    const p = world.prop(id)
    if (p) pts.push({ x: p.x, y: p.y, z: p.z })
  }
  if (preview) pts.push(preview)
  chain.points = pts.length >= 2 ? pts : []
}

/** The acting peer computes the whole outcome (clears, drops, refills, a
 * reshuffle if the result is dead) and ships it as ops; everyone else just
 * folds them. Board-structure edits win over rivals' in-flight chains,
 * whose scripts revalidate against the moved dots. */
function clearChain() {
  const me = world.me.id
  const ids = [] // sel deduped: loops list a dot twice but it clears once
  for (const id of sel) if (ids.indexOf(id) === -1) ids.push(id)
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
      // new dots fall in from above the board, like the original: spawn
      // them a column-gap up (fading in), then drop them onto their cells
      const gap = H - list.length
      for (let y = list.length; y < H; y++) {
        const c = COLORS[rnd(COLORS.length)]
        const id = world.createSphere({ position: at(x, y + gap, z), color: c, radius: R, unlit: true })
        pendingDrops.push({ id, pos: at(x, y, z) })
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

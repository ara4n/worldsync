// tetrix: multiplayer tetris as a worldsync WebSG script, engine ported
// from tetroji (shapes, SRS-ish rotation and wall-kick tables, line
// logic). One shared well; its width is 5 + 5 per player in the room,
// growing rightward from a fixed left edge as people join (landed cells
// never move when the board widens). Everyone plays simultaneously:
// each player's piece spawns centered in their own join-order lane, so
// placement is deterministic and starts collision-free.
//
// Sync model: THE WELL IS THE PROPS TABLE. Every block cell is one box
// prop; CLAIMED cells are falling pieces (claimedBy names the driver),
// UNCLAIMED cells are landed. Locking a piece is just unclaiming its
// four cells. The tetroji engine runs locally per player - rotation
// state never crosses the wire, others only see four cells move - and
// collision is the engine's constraints, not rapier: walls + landed
// cells + other players' claimed cells. Two pieces racing into the same
// cells within the fold window can overlap (photo finishes are not
// refereed); the primary sweeps duplicate cells after the fact. Line
// clears are PRIMARY-ONLY, so two simultaneous completions cannot race
// the row shifts: full rows flash white, then vanish and the stack
// above drops. A blocked spawn tops the board out and wipes the well.
//
// Upload with "load world script (.js)". Click the world once so keys
// focus, then: left/right move, up rotates, down soft-drops, space
// hard-drops. Foreground game, like snake: a throttled hidden tab
// stamps its ops late and trips the divergence detector.

const H = 24, LANE = 5
const CELL = 0.6, CB = 0.29 // cell prop half-size: the "tetrix cell" tag
const X0 = -9, Y0 = 0.4     // world pos of column 0, bottom row
const GRAVITY_S = 0.9
const COLORS = [0, 0xd94f4f, 0x5a79e8, 0xe89a4f, 0xe3d84f, 0x58d977, 0xb45ae8, 0x4fc9d9]
// tetroji types 1..7 = Z J L O S T I; [0,0] is top left of the bounding box
const SHAPES = [
  { blocks: [[0, 0], [1, 0], [1, 1], [2, 1]], w: 3, h: 3 }, // Z
  { blocks: [[0, 1], [1, 1], [2, 1], [0, 0]], w: 3, h: 3 }, // J
  { blocks: [[0, 1], [1, 1], [2, 1], [2, 0]], w: 3, h: 3 }, // L
  { blocks: [[0, 0], [1, 0], [0, 1], [1, 1]], w: 2, h: 2 }, // O
  { blocks: [[0, 1], [1, 1], [1, 0], [2, 0]], w: 3, h: 3 }, // S
  { blocks: [[0, 1], [1, 1], [2, 1], [1, 0]], w: 3, h: 3 }, // T
  { blocks: [[1, 2], [2, 2], [3, 2], [4, 2]], w: 5, h: 5 }, // I - SRS
]
// offsets to test 3x3 pieces after N rotations, and the 5x5 I bar
const KICK = [
  [[0, 0], [0, 0], [0, 0], [0, 0], [0, 0]],      // 0
  [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],     // R
  [[0, 0], [0, 0], [0, 0], [0, 0], [0, 0]],      // 2
  [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],  // L
]
const KICK_I = [
  [[0, 0], [-1, 0], [2, 0], [-1, 0], [2, 0]],    // 0
  [[-1, 0], [0, 0], [0, 0], [0, 1], [0, -2]],    // R
  [[-1, 1], [1, 1], [-2, 1], [1, 0], [-2, 0]],   // 2
  [[0, 1], [0, 1], [0, 1], [0, -1], [0, 2]],     // L
]

/** the four cells of a piece: tetroji's getBlocks, verbatim rotation math */
const blocksFor = (type, x, y, rot) => {
  const shape = SHAPES[type - 1]
  const out = []
  for (let i = 0; i < 4; i++) {
    const b = shape.blocks[i]
    let c, r
    switch (rot) {
      case 0: c = b[0]; r = b[1]; break
      case 1: c = shape.h - 1 - b[1]; r = b[0]; break
      case 2: c = shape.h - 1 - b[0]; r = shape.w - 1 - b[1]; break
      case 3: c = b[1]; r = shape.w - 1 - b[0]; break
    }
    out.push([c + x, r + y])
  }
  return out
}

const wx = (c) => X0 + c * CELL
const wy = (r) => Y0 + (H - 1 - r) * CELL

let me, W = 10
let cells = [] // this frame's cell props: {id, c, r, claimedBy, color}
let piece = null // { type, x, y, rot, ids: [4] }
let pendingClaims = [] // {id, t}
let lockQueue = []     // {id, cancelled, t}
let respawnAt = 0, gravAcc = 0, now = 0
let pendingClear = null // primary: { rows, t } mid-flash
const orphanSince = {}
let borderLines = [], borderFor = -1

world.onload = () => {
  world.env({ background: 0x1a212c, ground: false })
}

world.onenter = () => { me = world.me }

// -- derived state --

const scan = () => {
  cells = []
  for (const p of world.props()) {
    if (p.kind !== 'box' || p.size !== CB) continue
    cells.push({
      id: p.id,
      c: Math.round((p.x - X0) / CELL),
      r: H - 1 - Math.round((p.y - Y0) / CELL),
      claimedBy: p.claimedBy,
      color: p.color,
    })
  }
}

const myIds = () => new Set(piece ? piece.ids : [])

/** the engine's collision world: walls, landed cells, other falling
 * pieces - everything except the piece being moved */
const occupied = (c, r) => {
  if (c < 0 || c >= W || r >= H) return true
  if (r < 0) return false // free air above the well, like tetroji
  const mine = myIds()
  for (const cell of cells) {
    if (!mine.has(cell.id) && cell.c === c && cell.r === r) return true
  }
  return false
}

// -- the piece: tetroji's move(), kicks and all, emitting prop moves --

const emitPos = () => {
  const blocks = blocksFor(piece.type, piece.x, piece.y, piece.rot)
  for (let i = 0; i < 4; i++) {
    world.move(piece.ids[i], { x: wx(blocks[i][0]), y: wy(blocks[i][1]), z: 0 })
  }
}

const collides = (x, y, rot) =>
  blocksFor(piece.type, x, y, rot).some(([c, r]) => occupied(c, r))

const tryMove = (x, y, rot) => {
  let collided
  if (rot !== piece.rot && piece.type !== 4 /* O never kicks */) {
    const tests = piece.type === 7 ? KICK_I : KICK
    const before = tests[piece.rot], after = tests[rot]
    const oldX = x, oldY = y
    for (let i = 0; i < before.length; i++) {
      // tetroji flips the x offset here; preserved as ported
      x = oldX - (after[i][0] - before[i][0])
      y = oldY + (after[i][1] - before[i][1])
      collided = collides(x, y, rot)
      if (!collided) break
      x = oldX; y = oldY
    }
  } else {
    collided = collides(x, y, rot)
  }
  if (collided) return false
  piece.x = x; piece.y = y; piece.rot = rot
  emitPos()
  return true
}

const lock = () => {
  for (const id of piece.ids) {
    const pc = pendingClaims.find((p) => p.id === id)
    if (pc) {
      // claim never sent: the cell is already unclaimed = landed
      pendingClaims = pendingClaims.filter((p) => p !== pc)
      lockQueue.push({ id, cancelled: true, t: now })
    } else {
      lockQueue.push({ id, cancelled: false, t: now })
    }
  }
  piece = null
  respawnAt = now + 0.4
}

const myLane = () => {
  const peers = world.peers()
  for (let i = 0; i < peers.length; i++) if (peers[i].me) return i
  return 0
}

const spawnPiece = () => {
  const type = Math.floor(Math.random() * 7) + 1
  const x = LANE * myLane() + (type === 7 ? 0 : 1)
  const blocks = blocksFor(type, x, 0, 0)
  // blocked by the LANDED stack = topped out, wipe the well for everyone;
  // blocked by someone's falling piece passing through = just wait
  const landedAt = (c, r) => cells.some((x2) => x2.claimedBy === '' && x2.c === c && x2.r === r)
  if (blocks.some(([c, r]) => landedAt(c, r))) {
    console.log('TOP OUT - clearing the well')
    for (const cell of cells) if (cell.claimedBy === '') world.despawn(cell.id)
    respawnAt = now + 2
    return
  }
  if (blocks.some(([c, r]) => occupied(c, r))) {
    respawnAt = now + 1
    return
  }
  const ids = blocks.map(([c, r]) => {
    const id = world.createBox({ position: { x: wx(c), y: wy(r), z: 0 }, color: COLORS[type], size: CB, unlit: true })
    pendingClaims.push({ id, t: now })
    return id
  })
  piece = { type, x, y: 0, rot: 0, ids }
  gravAcc = 0
}

world.onkeydown = (ev) => {
  if (!piece) return
  switch (ev.key) {
    case 'ArrowUp': tryMove(piece.x, piece.y, (piece.rot + 1) % 4); break
    case 'ArrowLeft': tryMove(piece.x - 1, piece.y, piece.rot); break
    case 'ArrowRight': tryMove(piece.x + 1, piece.y, piece.rot); break
    case 'ArrowDown': if (!tryMove(piece.x, piece.y + 1, piece.rot)) lock(); break
    case ' ': {
      while (piece.y < H && collides(piece.x, piece.y + 1, piece.rot) === false) piece.y++
      emitPos()
      lock()
      break
    }
  }
}

// -- cosmetics: the well outline and lane separators, local lines --

const drawBorder = () => {
  if (borderFor === W) return
  borderFor = W
  for (const l of borderLines) l.despawn()
  borderLines = []
  const xL = wx(0) - CELL / 2, xR = wx(W - 1) + CELL / 2
  const yT = wy(0) + CELL / 2, yB = wy(H - 1) - CELL / 2
  const line = (pts, color, width) =>
    borderLines.push(world.createLine({ points: pts, color, width, worldUnits: true }))
  line([{ x: xL, y: yT, z: 0 }, { x: xL, y: yB, z: 0 }, { x: xR, y: yB, z: 0 }, { x: xR, y: yT, z: 0 }],
    0x8b98a8, 0.06)
  for (let c = LANE; c < W - LANE + 1; c += LANE) {
    const x = wx(c) - CELL / 2
    line([{ x, y: yT, z: 0 }, { x, y: yB, z: 0 }], 0x39424f, 0.03)
  }
  const cx = (xL + xR) / 2, cy = (yT + yB) / 2
  world.camera({ x: cx, y: cy, z: Math.max(15, (xR - xL) * 1.15) }, { x: cx, y: cy, z: 0 })
}

// -- per-frame --

world.onupdate = (dt, time) => {
  if (!me) return
  now = time
  scan()
  W = 5 + 5 * world.peers().length
  drawBorder()

  // claims trail spawns by a fold (a same-dispatch claim is refused)
  pendingClaims = pendingClaims.filter((pc) => {
    const cell = cells.find((x) => x.id === pc.id)
    if (!cell) return now - pc.t < 3
    if (cell.claimedBy === '') world.claim(pc.id)
    return false
  })
  // unclaims for locked pieces likewise wait until the claim has landed
  lockQueue = lockQueue.filter((lq) => {
    if (lq.cancelled) return false
    const cell = cells.find((x) => x.id === lq.id)
    if (!cell) return false
    if (cell.claimedBy === me.id) { world.unclaim(lq.id); return false }
    return now - lq.t < 5
  })

  if (!piece && now >= respawnAt) spawnPiece()
  if (piece) {
    gravAcc += dt
    if (gravAcc >= GRAVITY_S) {
      gravAcc = 0
      if (!tryMove(piece.x, piece.y + 1, piece.rot)) lock()
    }
  }

  // -- primary duties: line clears, duplicate cells, orphans --
  if (!world.me.primary) { pendingClear = null; return }
  const landed = cells.filter((c) => c.claimedBy === '')
  if (pendingClear) {
    if (now - pendingClear.t < 0.35) return
    // execute against a fresh scan: despawn the full rows, drop the rest
    const rows = pendingClear.rows
    for (const cell of landed) {
      if (rows.includes(cell.r)) world.despawn(cell.id)
      else {
        const drop = rows.filter((r) => r > cell.r).length
        if (drop > 0) world.move(cell.id, { x: wx(cell.c), y: wy(cell.r + drop), z: 0 })
      }
    }
    pendingClear = null
    return
  }
  const byRow = {}
  for (const cell of landed) {
    if (cell.c < 0 || cell.c >= W || cell.r < 0 || cell.r >= H) continue
    ;(byRow[cell.r] ??= new Set()).add(cell.c)
  }
  const full = Object.keys(byRow).map(Number).filter((r) => byRow[r].size >= W)
  if (full.length) {
    for (const cell of landed) if (full.includes(cell.r)) world.paint(cell.id, 0xffffff)
    pendingClear = { rows: full.sort((a, b) => a - b), t: now }
    console.log(`clearing ${full.length} line${full.length > 1 ? 's' : ''}`)
  }
  // duplicate cells (photo-finish locks) and out-of-well cells (the
  // board shrank when someone left): sweep to the deterministic survivor
  const seen = {}
  for (const cell of landed) {
    if (cell.c >= W) { world.despawn(cell.id); continue }
    const k = cell.c + ',' + cell.r
    if (seen[k] && seen[k] < cell.id) world.despawn(cell.id)
    else if (seen[k]) { world.despawn(seen[k]); seen[k] = cell.id }
    else seen[k] = cell.id
  }
  // falling cells whose driver left: nobody will ever land them
  const live = new Set(world.peers().map((p) => p.id))
  for (const cell of cells) {
    if (cell.claimedBy === '' || live.has(cell.claimedBy)) { delete orphanSince[cell.id]; continue }
    if (orphanSince[cell.id] === undefined) orphanSince[cell.id] = time
    else if (time - orphanSince[cell.id] > 5) { world.despawn(cell.id); delete orphanSince[cell.id] }
  }
}

// chess, multiplayer, as a worldsync WebSG script. The LOGICAL game is
// sim state built from props: every piece is a marker sphere floating
// over its square (color = side, radius = piece type), the board is box
// props, seats are claimed props, and a turn prop is painted with the
// side to move - so every peer (and every late joiner) derives the same
// position from the same table, and moves are constrained to legal ones
// by the script before any op is emitted. The PHYSICAL pieces are
// dynamic cubes: a legal move grabs the mover's cube and slides it
// kinematically through the board, so it plows into and knocks over
// anything in its path (including a captured piece, whose cube is then
// cleaned up). You can also just grab a cube and fling it - that only
// moves atoms, not the game: the marker keeps the square, and the next
// legal move slides the cube back from wherever it landed.
//
// Rules: full piece movement incl. pawn double-step and auto-queen
// promotion; captures only of the enemy. Simplifications: no check
// rules, castling or en passant - the game ends when a KING IS TAKEN,
// so moving into check is legal and punished naturally.
//
// Upload with "load world script (.js)". Click a side's seat sphere to
// sit (again to stand; claim both to test solo). On your turn click one
// of your markers, then a highlighted square. When a king falls, any
// seated player clicks the turn sphere to reset.

const N = 8, CELL = 1.2
const sqX = (c) => (c - 3.5) * CELL
const sqZ = (r) => (3.5 - r) * CELL // white home r=0 sits near the camera
const TILE = 0.55, MARKER_Y = 1.7, SEAT = 0.32, TURN = 0.4
const W = 0xf3ead6, B = 0x241d16 // marker/seat colors double as side ids
const WBODY = 0xd9cdb4, BBODY = 0x2c2620
const SIZES = { p: 0.1, n: 0.13, b: 0.15, r: 0.17, q: 0.21, k: 0.25 }
const TYPE_OF = {}
for (const t of Object.keys(SIZES)) TYPE_OF[SIZES[t]] = t
const BACK = ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r']
const KNIGHT = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]]
const RAYS = {
  r: [[1, 0], [-1, 0], [0, 1], [0, -1]],
  b: [[1, 1], [1, -1], [-1, 1], [-1, -1]],
}
RAYS.q = RAYS.r.concat(RAYS.b)

let pieces, board, tiles, tileCell, seats, turnProp, gameOver, now = 0
let selected = null
let localLatch = -10 // our move's ops have not folded yet: hold fire
let seedWait = -10
// marker id -> physics cube id. Script-local best effort: exact for
// pieces we spawned or moved, proximity-adopted otherwise (a late-joining
// mover may pair a well-flung cube wrong - cosmetic only, the markers
// stay correct).
const boxOf = {}
const boxOfAt = {} // when each pairing was made: fresh ones survive the
// cleanup below while their marker's spawn op is still folding
let slides = [] // the physical move animations this peer is driving
const glyphs = new Map()
let selLines = []
let seatRing = null, winRing = null, winShown = false

world.onload = () => {
  world.env({ background: 0x2b3440 })
  world.camera({ x: 0, y: 9.5, z: 10.8 }, { x: 0, y: 0, z: 0.5 })
}

// -- derived state --

const scan = () => {
  pieces = []; tiles = new Map(); tileCell = new Map(); seats = {}; turnProp = null
  board = Array.from({ length: N }, () => Array(N).fill(null))
  for (const p of world.props()) {
    if (p.kind === 'box' && p.size === TILE) {
      const c = Math.round(p.x / CELL + 3.5), r = Math.round(3.5 - p.z / CELL)
      tiles.set(c + ',' + r, p)
      tileCell.set(p.id, { c, r })
    } else if (p.kind === 'sphere' && Math.abs(p.y - MARKER_Y) < 0.01 && TYPE_OF[p.size]) {
      const c = Math.round(p.x / CELL + 3.5), r = Math.round(3.5 - p.z / CELL)
      const piece = { id: p.id, type: TYPE_OF[p.size], side: p.color, c, r, x: p.x, z: p.z }
      pieces.push(piece)
      if (c >= 0 && c < N && r >= 0 && r < N) board[c][r] = piece
    } else if (p.kind === 'sphere' && p.size === SEAT) {
      seats[p.color] = p
    } else if (p.kind === 'sphere' && p.size === TURN) {
      turnProp = p
    }
  }
  const kings = pieces.filter((p) => p.type === 'k')
  gameOver = pieces.length > 0 && kings.length === 1 ? kings[0].side : null
}

const pair = () => {
  for (const id of Object.keys(boxOf)) {
    if (!pieces.some((p) => p.id === id) && now - (boxOfAt[id] ?? 0) > 3) {
      delete boxOf[id]
      delete boxOfAt[id]
    }
  }
  const used = new Set(Object.values(boxOf))
  const free = world.boxes().filter((b) => !used.has(b.name))
  for (const p of pieces) {
    if (boxOf[p.id]) continue
    let best = null, bd = 0.9
    for (const b of free) {
      const t = b.translation
      const d = Math.hypot(t.x - p.x, t.z - p.z)
      if (d < bd) { bd = d; best = b }
    }
    if (best) { boxOf[p.id] = best.name; boxOfAt[p.id] = now; free.splice(free.indexOf(best), 1) }
  }
}

const inb = (c, r) => c >= 0 && c < N && r >= 0 && r < N

/** every square this piece may move to (pseudo-legal; see header) */
const targets = (p) => {
  const out = []
  const occ = (c, r) => board[c][r]
  const add = (c, r) => { if (inb(c, r) && (!occ(c, r) || occ(c, r).side !== p.side)) out.push([c, r]) }
  if (p.type === 'p') {
    const d = p.side === W ? 1 : -1, home = p.side === W ? 1 : 6
    if (inb(p.c, p.r + d) && !occ(p.c, p.r + d)) {
      out.push([p.c, p.r + d])
      if (p.r === home && !occ(p.c, p.r + 2 * d)) out.push([p.c, p.r + 2 * d])
    }
    for (const dc of [-1, 1]) {
      const q = inb(p.c + dc, p.r + d) && occ(p.c + dc, p.r + d)
      if (q && q.side !== p.side) out.push([p.c + dc, p.r + d])
    }
  } else if (p.type === 'n') {
    for (const [dc, dr] of KNIGHT) add(p.c + dc, p.r + dr)
  } else if (p.type === 'k') {
    for (let dc = -1; dc <= 1; dc++) for (let dr = -1; dr <= 1; dr++) {
      if (dc || dr) add(p.c + dc, p.r + dr)
    }
  } else {
    for (const [dc, dr] of RAYS[p.type]) {
      for (let k = 1; k < N; k++) {
        const c = p.c + dc * k, r = p.r + dr * k
        if (!inb(c, r)) break
        add(c, r)
        if (occ(c, r)) break
      }
    }
  }
  return out
}

// -- moving --

const doMove = (p, c, r) => {
  const victim = board[c][r] // targets() guarantees enemy or empty
  world.move(p.id, { x: sqX(c), y: MARKER_Y, z: sqZ(r) })
  if (victim) world.despawn(victim.id)
  const myBox = boxOf[p.id]
  if (p.type === 'p' && (r === 0 || r === N - 1)) { // auto-queen
    world.despawn(p.id)
    const q = world.createSphere({ position: { x: sqX(c), y: MARKER_Y, z: sqZ(r) }, color: p.side, radius: SIZES.q })
    if (myBox) { boxOf[q] = myBox; boxOfAt[q] = now }
  }
  if (turnProp) world.paint(turnProp.id, p.side === W ? B : W)
  const victimBox = victim ? boxOf[victim.id] : null
  if (myBox) {
    slides.push({ boxId: myBox, to: { x: sqX(c), z: sqZ(r) }, arc: p.type === 'n', from: null, t: 0, wait: 0, tried: -1, victimBox })
  } else if (victimBox) {
    world.despawn(victimBox)
  }
  localLatch = now
  setSelection(null)
}

const runSlides = (dt) => {
  for (const s of slides) {
    const n = world.findNodeByName(s.boxId)
    if (!n) { s.done = true; continue }
    if (!s.from) {
      // wait for our grab op to fold; give up if someone is holding it
      s.wait += dt
      if (s.wait > 2.5) { s.done = true; if (s.victimBox) world.despawn(s.victimBox); continue }
      if (n.held) { s.from = n.translation }
      else if (s.wait - s.tried > 0.6) { n.grab(); s.tried = s.wait }
      continue
    }
    s.t = Math.min(1, s.t + dt / 0.7)
    const k = s.t * s.t * (3 - 2 * s.t)
    const y = 0.55 + (s.arc ? Math.sin(Math.PI * k) * 1.6 : 0) // knights jump
    n.moveTo(s.from.x + (s.to.x - s.from.x) * k, y, s.from.z + (s.to.z - s.from.z) * k)
    if (s.t >= 1) {
      n.release({ x: 0, y: 0, z: 0 })
      if (s.victimBox) world.despawn(s.victimBox) // bashed aside during the slide; now gone
      s.done = true
    }
  }
  slides = slides.filter((s) => !s.done)
}

// -- input --

world.onpointerdown = (ev) => {
  if (!ev.entity) return
  scan()
  pair()
  for (const color of [W, B]) {
    const s = seats[color]
    if (s && s.id === ev.entity) {
      if (s.mine) world.unclaim(s.id)
      else if (s.claimedBy === '') world.claim(s.id)
      else console.log('that seat is taken by', s.claimedBy)
      return
    }
  }
  if (turnProp && ev.entity === turnProp.id) {
    const seated = (seats[W] && seats[W].mine) || (seats[B] && seats[B].mine)
    if (gameOver && seated) {
      for (const p of pieces) world.despawn(p.id)
      for (const b of world.boxes()) world.despawn(b.name) // strays too
      setSelection(null)
    }
    return
  }
  if (gameOver || now < localLatch + 1.5 || !turnProp) return
  const turn = turnProp.color
  const mySeat = seats[turn] && seats[turn].mine
  const piece = pieces.find((p) => p.id === ev.entity)
  if (piece && piece.side === turn) {
    if (!mySeat) { console.log('claim the', turn === W ? 'white' : 'black', 'seat to play'); return }
    setSelection(piece.id)
    return
  }
  if (!selected || !mySeat) return
  const sp = pieces.find((p) => p.id === selected)
  if (!sp || sp.side !== turn) { setSelection(null); return }
  const cell = tileCell.get(ev.entity) ?? (piece ? { c: piece.c, r: piece.r } : null)
  if (!cell) return
  if (!targets(sp).some(([c, r]) => c === cell.c && r === cell.r)) {
    console.log('not a legal move for that piece')
    return
  }
  doMove(sp, cell.c, cell.r)
}

// -- cosmetics: local lines only --

const circle = (x, z, rad, y) => {
  const pts = []
  for (let k = 0; k <= 24; k++) {
    const a = (k / 24) * Math.PI * 2
    pts.push({ x: x + Math.cos(a) * rad, y, z: z + Math.sin(a) * rad })
  }
  return pts
}

const setSelection = (id) => {
  selected = id
  for (const l of selLines) l.despawn()
  selLines = []
  if (!id) return
  const sp = pieces.find((p) => p.id === id)
  if (!sp) { selected = null; return }
  selLines.push(world.createLine({ points: circle(sqX(sp.c), sqZ(sp.r), 0.52, 0.1), color: 0x86d3ff, width: 0.06, worldUnits: true }))
  for (const [c, r] of targets(sp)) {
    selLines.push(world.createLine({ points: circle(sqX(c), sqZ(r), 0.3, 0.1), color: 0x7fe0a0, width: 0.05, worldUnits: true }))
  }
}

/** flat glyph outline per piece type, drawn in the XZ plane (2d points) */
const shape = (t) => {
  const s = 0.3
  switch (t) {
    case 'p': return [[0, -s * 0.7], [s * 0.6, s * 0.6], [-s * 0.6, s * 0.6], [0, -s * 0.7]]
    case 'r': return [[-s, -s], [s, -s], [s, s], [-s, s], [-s, -s]]
    case 'n': return [[-s, s], [-s, -s], [s * 0.8, -s]]
    case 'b': return [[-s, -s], [s, s], [-s, s], [s, -s]]
    case 'q': {
      const pts = []
      for (let k = 0; k <= 10; k++) {
        const a = (k / 10) * Math.PI * 2 - Math.PI / 2
        const rad = k % 2 === 0 ? s : s * 0.45
        pts.push([Math.cos(a) * rad, Math.sin(a) * rad])
      }
      return pts
    }
    case 'k': {
      const w = s * 0.35
      return [[-w, -s], [w, -s], [w, -w], [s, -w], [s, w], [w, w], [w, s], [-w, s], [-w, w], [-s, w], [-s, -w], [-w, -w], [-w, -s]]
    }
  }
}

const drawGlyphs = () => {
  const seen = new Set()
  for (const p of pieces) {
    seen.add(p.id)
    const sig = p.c + ',' + p.r
    const g = glyphs.get(p.id)
    if (g && g.sig === sig) continue
    const pts = shape(p.type).map(([dx, dz]) => ({ x: sqX(p.c) + dx, y: MARKER_Y - 0.35, z: sqZ(p.r) + dz }))
    if (g) { g.line.points = pts; g.sig = sig }
    else glyphs.set(p.id, { line: world.createLine({ points: pts, color: 0xffc45e, width: 0.035, worldUnits: true }), sig })
  }
  for (const [id, g] of [...glyphs]) {
    if (!seen.has(id)) { g.line.despawn(); glyphs.delete(id) }
  }
}

// -- per-frame --

world.onupdate = (dt, time) => {
  now = time
  scan()
  pair()
  runSlides(dt)
  drawGlyphs()
  // the primary seeds missing furniture in stages (tiles, then seats and
  // the turn sphere, then the pieces), pausing between attempts so its
  // own ops can fold before it judges them missing
  if (world.me.primary && time > seedWait + 2) {
    let spawned = false
    for (let c = 0; c < N; c++) for (let r = 0; r < N; r++) {
      if (!tiles.has(c + ',' + r)) {
        world.createBox({ position: { x: sqX(c), y: -0.53, z: sqZ(r) }, color: (c + r) % 2 ? 0xc9ad7f : 0x6b4f33, size: TILE })
        spawned = true
      }
    }
    if (!spawned) {
      if (!seats[W]) { world.createSphere({ position: { x: -6.2, y: 0.6, z: 3 }, color: W, radius: SEAT }); spawned = true }
      if (!seats[B]) { world.createSphere({ position: { x: -6.2, y: 0.6, z: -3 }, color: B, radius: SEAT }); spawned = true }
      if (!turnProp) { world.createSphere({ position: { x: 6.2, y: 1.4, z: 0 }, color: W, radius: TURN, unlit: true }); spawned = true }
    }
    if (!spawned && pieces.length === 0) {
      for (let c = 0; c < N; c++) {
        for (const [t, side, r] of [[BACK[c], W, 0], ['p', W, 1], ['p', B, 6], [BACK[c], B, 7]]) {
          const id = world.createSphere({ position: { x: sqX(c), y: MARKER_Y, z: sqZ(r) }, color: side, radius: SIZES[t] })
          const box = world.createNode({ translation: [sqX(c), 0.5, sqZ(r)], color: side === W ? WBODY : BBODY })
          boxOf[id] = box.name
          boxOfAt[id] = time
        }
      }
      spawned = true
    }
    if (spawned) seedWait = time
  }
  // local ring under the seat whose turn it is (or the winner's, big)
  if (turnProp && !gameOver) {
    const seat = seats[turnProp.color]
    if (seat) {
      const pts = circle(seat.x, seat.z, 0.55, 0.12)
      const color = turnProp.color === W ? 0xffffff : 0xffc45e
      if (!seatRing) seatRing = world.createLine({ points: pts, color, width: 0.05, worldUnits: true })
      else { seatRing.points = pts; seatRing.color = color }
    }
  } else if (seatRing) { seatRing.despawn(); seatRing = null }
  if (gameOver && !winRing) {
    winRing = world.createLine({ points: circle(0, 0, 5.6, 0.15), color: gameOver === W ? 0xffffff : 0xffc45e, width: 0.12, worldUnits: true })
    if (!winShown) { winShown = true; console.log(gameOver === W ? 'white' : 'black', 'took the king! click the turn sphere to reset') }
  } else if (!gameOver && winRing) { winRing.despawn(); winRing = null; winShown = false }
}

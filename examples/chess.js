// chess, multiplayer, as a worldsync WebSG script. The game is sim state
// built from props: every piece is a prop whose KIND is its type (the
// client renders 'pawn'..'king' as built-in low-poly models), color =
// side, cell = its position rounded to the grid; the board is box props,
// seats are claimed props, and a turn prop is painted with the side to
// move (and nudged to carry the castling/en-passant meta) - so every
// peer (and every late joiner) derives the same position from the same
// table, and moves are constrained to legal ones by the script before
// any op is emitted.
//
// Moving is a DRAG: press your piece and it lifts off the board and
// follows the pointer (streamed as throttled move ops, so everyone
// watches the piece wander); release it over a highlighted square and it
// eases into the center (the render layer's move ease), release it
// anywhere else and it eases home. Legality is frozen when the piece
// lifts; only the side to move can drag, so the board cannot change
// under a drag.
//
// Rules: full piece movement incl. pawn double-step, auto-queen
// promotion, castling and en passant; captures only of the enemy, and
// moves that leave your own king in check are refused. Check paints a
// warning ring under the threatened king; checkmate and stalemate
// conclude the game (and, as a desync fallback, a king actually
// captured still ends it).
//
// Upload with "load world script (.js)". Click a side's seat sphere to
// sit (again to stand; claim both to test solo). On your turn drag one
// of your pieces to a highlighted square. When the game ends, any
// seated player clicks the turn sphere to reset.

const N = 8, CELL = 1.2
const sqX = (c) => (c - 3.5) * CELL
const sqZ = (r) => (3.5 - r) * CELL // white home r=0 sits near the camera
const TILE = 0.55, SEAT = 0.32, TURN = 0.4
const BOARD_Y = 0.02 // the tiles' top face; pieces stand on it
const LIFT = 0.5 // how high a dragged piece rides
const W = 0xf3ead6, B = 0x241d16 // piece/seat colors double as side ids
const KINDS = { p: 'pawn', r: 'rook', n: 'knight', b: 'bishop', q: 'queen', k: 'king' }
const TYPE_OF = {}
for (const t of Object.keys(KINDS)) TYPE_OF[KINDS[t]] = t
const HEIGHTS = { p: 0.5, r: 0.55, n: 0.62, b: 0.68, q: 0.8, k: 0.9 }
const BACK = ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r']
const KNIGHT = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]]
const RAYS = {
  r: [[1, 0], [-1, 0], [0, 1], [0, -1]],
  b: [[1, 1], [1, -1], [-1, 1], [-1, -1]],
}
RAYS.q = RAYS.r.concat(RAYS.b)

// Castling rights and the en passant file are game state the piece props
// cannot carry, so they ride in the TURN SPHERE'S POSITION as tiny
// offsets from its home - invisible at its size, exact on the wire
// (positions are JSON doubles), and scanned by late joiners like
// everything else. x offsets encode LOST castle rights as a bitmask
// (the freshly seeded sphere sits at exactly TURN_X: nothing lost yet),
// z encodes en-passant-file-plus-one (home z: no ep window).
const TURN_X = 6.2, TURN_Y = 1.4, META = 0.01
const CASTLE_BIT = { '7,0': 1, '0,0': 2, '7,7': 4, '0,7': 8 } // rook home square -> the right it anchors
const meta = () => {
  if (!turnProp) return { lost: 15, ep: -1 }
  const lost = Math.round((turnProp.x - TURN_X) / META) & 15
  const ep = Math.round(turnProp.z / META) - 1
  return { lost, ep: ep >= 0 && ep < N ? ep : -1 }
}

let pieces, board, tiles, seats, turnProp, gameOver, captured, now = 0
let drag = null // the piece we are dragging, with legality frozen at lift
let localLatch = -10 // our move's ops have not folded yet: hold fire
let seedWait = -10
let selLines = [], hoverLine = null, hoverCell = null
let seatRing = null, winRing = null, winShown = false
let checkRing = null, checkedKing = null // local warning under a checked king
let mateOver = null, posSig = '' // mate/stalemate verdict, sticky between settled boards

world.onload = () => {
  world.env({ background: 0x2b3440 })
  world.camera({ x: 0, y: 9.5, z: 10.8 }, { x: 0, y: 0, z: 0.5 })
}

// -- derived state --

const scan = () => {
  pieces = []; tiles = new Map(); seats = {}; turnProp = null
  board = Array.from({ length: N }, () => Array(N).fill(null))
  for (const p of world.props()) {
    if (p.kind === 'box' && p.size === TILE) {
      tiles.set(Math.round(p.x / CELL + 3.5) + ',' + Math.round(3.5 - p.z / CELL), p)
    } else if (TYPE_OF[p.kind]) {
      const c = Math.round(p.x / CELL + 3.5), r = Math.round(3.5 - p.z / CELL)
      const piece = { id: p.id, type: TYPE_OF[p.kind], side: p.color, c, r, x: p.x, y: p.y, z: p.z }
      pieces.push(piece)
      // the piece we are dragging must not shadow the board: its hover
      // position rounds onto whatever square it floats over (the capture
      // TARGET at release, hiding the victim behind the own-piece guard);
      // its logical square was frozen at lift
      if (drag && p.id === drag.id) continue
      if (c >= 0 && c < N && r >= 0 && r < N) board[c][r] = piece
    } else if (p.kind === 'sphere' && p.size === SEAT) {
      seats[p.color] = p
    } else if (p.kind === 'sphere' && p.size === TURN) {
      turnProp = p
    }
  }
  // only kings still ON the board count: a captured king stands in the
  // graveyard, it does not keep the game alive. Capture is the desync
  // FALLBACK ending; the legitimate ones (checkmate, stalemate) are
  // judged in onupdate on settled boards and held in mateOver
  const kings = pieces.filter((p) => p.type === 'k' && inb(p.c, p.r))
  captured = pieces.length > 0 && kings.length === 1 ? kings[0].side : null
  gameOver = captured ?? mateOver
}

const inb = (c, r) => c >= 0 && c < N && r >= 0 && r < N

/** every square this piece may move to, pseudo-legally: geometry and
 * occupancy only - self-check, castling and en passant are layered on
 * in legalTargets() */
const targets = (p, bd = board) => {
  const out = []
  const occ = (c, r) => bd[c][r]
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

// -- rules: attack maps, legality, check --

/** is (c, r) attacked by side `by` on board bd? Scans outward from the
 * square, so it costs the same however many attackers exist. */
const attacked = (bd, by, c, r) => {
  const d = by === W ? 1 : -1 // `by` pawns attack one rank along d
  for (const s of [-1, 1]) {
    const p = inb(c + s, r - d) && bd[c + s][r - d]
    if (p && p.side === by && p.type === 'p') return true
  }
  for (const [dc, dr] of KNIGHT) {
    const p = inb(c + dc, r + dr) && bd[c + dc][r + dr]
    if (p && p.side === by && p.type === 'n') return true
  }
  for (let dc = -1; dc <= 1; dc++) for (let dr = -1; dr <= 1; dr++) {
    const p = (dc || dr) && inb(c + dc, r + dr) && bd[c + dc][r + dr]
    if (p && p.side === by && p.type === 'k') return true
  }
  for (const t of ['r', 'b']) {
    for (const [dc, dr] of RAYS[t]) {
      for (let k = 1; k < N; k++) {
        const cc = c + dc * k, rr = r + dr * k
        if (!inb(cc, rr)) break
        const p = bd[cc][rr]
        if (p) {
          if (p.side === by && (p.type === t || p.type === 'q')) return true
          break
        }
      }
    }
  }
  return false
}

const inCheck = (bd, side) => {
  for (let c = 0; c < N; c++) for (let r = 0; r < N; r++) {
    const p = bd[c][r]
    if (p && p.type === 'k' && p.side === side) return attacked(bd, side === W ? B : W, c, r)
  }
  return false // kingless (mid-seed, desync): nothing to defend
}

/** the board after p (standing at p.c,p.r) moves to (c, r): a fresh 8x8
 * sharing the untouched piece objects. Handles the specials: the en
 * passant victim vanishes from BESIDE the landing square, a castling
 * king brings its rook across, a promoting pawn queens. */
const after = (bd, p, c, r) => {
  const bd2 = bd.map((col) => col.slice())
  bd2[p.c][p.r] = null
  if (p.type === 'p' && c !== p.c && !bd[c][r]) bd2[c][p.r] = null // en passant
  if (p.type === 'k' && Math.abs(c - p.c) === 2) { // castling
    const rc = c > p.c ? N - 1 : 0
    bd2[(c + p.c) / 2][r] = bd2[rc][r]
    bd2[rc][r] = null
  }
  const promoted = p.type === 'p' && (r === 0 || r === N - 1)
  bd2[c][r] = { ...p, c, r, type: promoted ? 'q' : p.type }
  return bd2
}

/** every square p may LEGALLY move to: pseudo-legal targets plus
 * castling and en passant (both consult the meta m), minus anything
 * that leaves our own king attacked. */
const legalTargets = (p, bd, m) => {
  const out = targets(p, bd)
  if (p.type === 'p' && m.ep >= 0 && p.r === (p.side === W ? 4 : 3) && Math.abs(p.c - m.ep) === 1) {
    out.push([m.ep, p.side === W ? 5 : 2]) // take the double-pusher standing beside us
  }
  if (p.type === 'k' && p.c === 4 && p.r === (p.side === W ? 0 : N - 1) && !inCheck(bd, p.side)) {
    for (const rc of [N - 1, 0]) { // kingside, queenside
      if (m.lost & CASTLE_BIT[rc + ',' + p.r]) continue
      const rook = bd[rc][p.r]
      if (!rook || rook.type !== 'r' || rook.side !== p.side) continue
      const step = rc ? 1 : -1
      let clear = true
      for (let cc = p.c + step; cc !== rc; cc += step) if (bd[cc][p.r]) { clear = false; break }
      // the king's transit square must be safe too; the landing square
      // goes through the same self-check filter as every other move
      if (clear && !attacked(bd, p.side === W ? B : W, p.c + step, p.r)) out.push([p.c + 2 * step, p.r])
    }
  }
  return out.filter(([c, r]) => !inCheck(after(bd, p, c, r), p.side))
}

/** does side have ANY legal move? none = checkmate or stalemate */
const anyMove = (bd, side, m) => {
  for (let c = 0; c < N; c++) for (let r = 0; r < N; r++) {
    const p = bd[c][r]
    if (p && p.side === side && legalTargets({ ...p, c, r }, bd, m).length) return true
  }
  return false
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

const clearDragLines = () => {
  for (const l of selLines) l.despawn()
  selLines = []
  if (hoverLine) { hoverLine.despawn(); hoverLine = null; hoverCell = null }
}

const drawDragLines = (d) => {
  selLines.push(world.createLine({ points: circle(sqX(d.c0), sqZ(d.r0), 0.52, 0.1), color: 0x86d3ff, width: 0.06, worldUnits: true }))
  for (const [c, r] of d.targets) {
    selLines.push(world.createLine({ points: circle(sqX(c), sqZ(r), 0.3, 0.1), color: 0x7fe0a0, width: 0.05, worldUnits: true }))
  }
}

// ring under the square the dragged piece is hovering: green = droppable
const updateHover = (d) => {
  const c = Math.round(d.x / CELL + 3.5), r = Math.round(3.5 - d.z / CELL)
  const key = c + ',' + r
  if (key === hoverCell) return
  hoverCell = key
  const legal = d.targets.some(([tc, tr]) => tc === c && tr === r)
  const pts = circle(sqX(c), sqZ(r), 0.52, 0.11)
  const color = legal ? 0x7fe0a0 : 0xe06a6a
  if (!hoverLine) hoverLine = world.createLine({ points: pts, color, width: 0.07, worldUnits: true })
  else { hoverLine.points = pts; hoverLine.color = color }
}

// -- moving --

// each move is narrated into the Matrix room by its mover (world.say
// posts as that user) in standard algebraic notation: pawns are bare
// squares (e4, exd5 - en passant reads like any capture), pieces get
// letters (Nf3, Bxe5), ambiguous movers their departure file/rank
// (Rad1), promotion =Q, castling O-O/O-O-O, check +, mate # with the
// result (Qh7# 1-0), stalemate a bare 1/2-1/2. The first move out of
// the start position additionally announces the new game, so the
// timeline records who began it.
const FILE = 'abcdefgh'
const sqName = (c, r) => FILE[c] + (r + 1)
const LETTER = { p: '', r: 'R', n: 'N', b: 'B', q: 'Q', k: 'K' }

const san = (d, c, r, victim, promoted) => {
  if (d.type === 'p') {
    return (victim ? FILE[d.c0] + 'x' : '') + sqName(c, r) + (promoted ? '=Q' : '')
  }
  // disambiguate against same-side same-type pieces that also reach the
  // square: departure file first, then rank, then both (SAN preference).
  // The mover is cleared off the board first - mid-drag its prop hovers
  // at an arbitrary cell and must not block a rival's sliding path.
  for (let cc = 0; cc < N; cc++) for (let rr = 0; rr < N; rr++) {
    if (board[cc][rr] && board[cc][rr].id === d.id) board[cc][rr] = null
  }
  const rivals = pieces.filter((p) => p.id !== d.id && p.side === d.side && p.type === d.type
    && inb(p.c, p.r) // a captured twin in the graveyard forces nothing
    && targets(p).some(([tc, tr]) => tc === c && tr === r))
  let dis = ''
  if (rivals.length) {
    if (!rivals.some((p) => p.c === d.c0)) dis = FILE[d.c0]
    else if (!rivals.some((p) => p.r === d.r0)) dis = String(d.r0 + 1)
    else dis = sqName(d.c0, d.r0)
  }
  return LETTER[d.type] + dis + (victim ? 'x' : '') + sqName(c, r)
}

// Captured pieces are not despawned: they ease off to stand in a line
// beside the board, on the TAKER'S LEFT (white faces -z so its left is
// the -x side; black's is +x), filling from the taker's home edge
// outward. Off-board pieces fall out of board[] naturally (their cell
// rounds out of range), so they stop playing but survive for the eye;
// reset despawns them with everything else.
const GRAVE_X = 5.4
const graveSpot = (taker) => {
  const sign = taker === W ? -1 : 1
  const count = pieces.filter((p) => !inb(p.c, p.r) && Math.sign(p.x) === sign).length
  return { x: sign * GRAVE_X, y: BOARD_Y, z: (taker === W ? 1 : -1) * (4.2 - count * 0.55) }
}

/** is the standing position the untouched start position? Then the move
 * being made is a new game's first. The mover's own square comes from
 * the drag (its prop hovers mid-air at an arbitrary cell); everyone
 * else's from the scan. */
const freshBoard = (d) => {
  if (pieces.length !== 32) return false
  for (const p of pieces) {
    const c = p.id === d.id ? d.c0 : p.c
    const r = p.id === d.id ? d.r0 : p.r
    if (!inb(c, r)) return false
    const home = p.side === W ? (p.type === 'p' ? 1 : 0) : (p.type === 'p' ? 6 : 7)
    if (r !== home) return false
    if (p.type !== 'p' && BACK[c] !== p.type) return false
  }
  return true
}

const doMove = (d, c, r) => {
  const opening = freshBoard(d)
  const m0 = opening ? { lost: 0, ep: -1 } : meta()
  const castled = d.type === 'k' && Math.abs(c - d.c0) === 2
  // a pawn landing diagonally on an EMPTY square is en passant: the
  // victim stands beside the departure rank, not on the landing square
  const epTaken = d.type === 'p' && c !== d.c0 && !board[c][r]
  const victim = epTaken ? board[c][d.r0]
    : board[c][r] && board[c][r].id !== d.id ? board[c][r] : null
  if (victim) world.move(victim.id, graveSpot(d.side)) // legalTargets() guarantees enemy or empty
  const promoted = d.type === 'p' && (r === 0 || r === N - 1)
  if (promoted) { // auto-queen
    world.despawn(d.id)
    world.createProp({ kind: KINDS.q, position: { x: sqX(c), y: BOARD_Y, z: sqZ(r) }, color: d.side, size: HEIGHTS.q, bounce: false })
  } else {
    world.move(d.id, { x: sqX(c), y: BOARD_Y, z: sqZ(r) })
  }
  if (castled) { // the rook crosses to the king's other side
    const rook = board[c > d.c0 ? N - 1 : 0][r]
    world.move(rook.id, { x: sqX((c + d.c0) / 2), y: BOARD_Y, z: sqZ(r) })
  }
  // pass the meta forward: castle rights fall when a king or rook leaves
  // home (or a rook dies at home); the ep window opens on a double push
  // and closes on anything else
  let lost = m0.lost
  if (d.type === 'k') lost |= d.side === W ? 3 : 12
  if (d.type === 'r') lost |= CASTLE_BIT[d.c0 + ',' + d.r0] ?? 0
  if (victim && victim.type === 'r') lost |= CASTLE_BIT[victim.c + ',' + victim.r] ?? 0
  const ep = d.type === 'p' && Math.abs(r - d.r0) === 2 ? c : -1
  if (turnProp) {
    world.paint(turnProp.id, d.side === W ? B : W)
    world.move(turnProp.id, { x: TURN_X + lost * META, y: TURN_Y, z: (ep + 1) * META })
  }
  // judge the position our ops will produce, so the mover already
  // narrates the opponent's plight (+, #, or the stalemate draw)
  const bd2 = after(board, { type: d.type, side: d.side, c: d.c0, r: d.r0 }, c, r)
  const opp = d.side === W ? B : W
  const check = inCheck(bd2, opp)
  const stuck = !anyMove(bd2, opp, { lost, ep })
  let msg = castled ? (c > d.c0 ? 'O-O' : 'O-O-O') : san(d, c, r, victim, promoted)
  if (check) msg += stuck ? '#' : '+'
  if (victim && victim.type === 'k') msg += d.side === W ? ' 1-0' : ' 0-1' // desync fallback
  else if (stuck) msg += check ? (d.side === W ? ' 1-0' : ' 0-1') : ' 1/2-1/2'
  // a new game's first move announces the game as it opens - said by its
  // mover, so the timeline records who began. One combined message: the
  // host rate-limits say to ~1/s, a separate line would be dropped.
  if (opening) msg = 'a new game begins: ' + msg
  world.say(msg)
  localLatch = now
}

// -- input: press a piece to lift it, drag, release to drop --

world.onpointerdown = (ev) => {
  if (!ev.entity) return
  scan()
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
      // meta home: full castle rights, no en passant window
      world.move(turnProp.id, { x: TURN_X, y: TURN_Y, z: 0 })
      posSig = ''
      mateOver = null
    }
    return
  }
  if (drag || gameOver || now < localLatch + 1.5 || !turnProp) return
  const turn = turnProp.color
  const piece = pieces.find((p) => p.id === ev.entity)
  if (!piece || piece.side !== turn) return
  if (!inb(piece.c, piece.r)) return // captured pieces rest in peace
  if (!(seats[turn] && seats[turn].mine)) {
    console.log('claim the', turn === W ? 'white' : 'black', 'seat to play')
    return
  }
  drag = {
    id: piece.id, type: piece.type, side: piece.side,
    c0: piece.c, r0: piece.r, targets: legalTargets(piece, board, meta()),
    x: piece.x, z: piece.z, last: -1,
  }
  drawDragLines(drag)
  world.move(piece.id, { x: piece.x, y: LIFT, z: piece.z }) // lift off
}

world.onpointermove = (ev) => {
  if (!drag) return
  const p = WebSG.rayPlane(ev.origin, ev.dir, { x: 0, y: LIFT, z: 0 }, { x: 0, y: 1, z: 0 })
  if (!p) return
  // roam free, but stay over the board
  const e = (N / 2) * CELL - 0.15
  drag.x = Math.max(-e, Math.min(e, p.x))
  drag.z = Math.max(-e, Math.min(e, p.z))
  updateHover(drag)
  // throttled move ops: everyone watches the piece wander mid-drag
  if (now - drag.last > 0.07) {
    drag.last = now
    world.move(drag.id, { x: drag.x, y: LIFT, z: drag.z })
  }
}

world.onpointerup = (ev) => {
  if (!drag) return
  const d = drag
  // scan while drag is still set: the dropped piece's prop is parked at
  // its hover position, and only the drag-exclusion keeps it from
  // shadowing the destination square (hiding the capture victim)
  scan()
  drag = null
  clearDragLines()
  const p = WebSG.rayPlane(ev.origin, ev.dir, { x: 0, y: LIFT, z: 0 }, { x: 0, y: 1, z: 0 })
  const x = p ? p.x : d.x, z = p ? p.z : d.z
  const c = Math.round(x / CELL + 3.5), r = Math.round(3.5 - z / CELL)
  if (!pieces.some((pp) => pp.id === d.id)) return
  if (d.targets.some(([tc, tr]) => tc === c && tr === r) && !(c === d.c0 && r === d.r0)) {
    doMove(d, c, r) // eases into the center of the square
  } else {
    world.move(d.id, { x: sqX(d.c0), y: BOARD_Y, z: sqZ(d.r0) }) // eases home
  }
}

// -- per-frame --

world.onupdate = (dt, time) => {
  now = time
  scan()
  // a reset (or a lost race) can despawn the piece mid-drag: let go
  if (drag && (gameOver || !pieces.some((p) => p.id === drag.id))) {
    drag = null
    clearDragLines()
  }
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
      if (!turnProp) { world.createSphere({ position: { x: TURN_X, y: TURN_Y, z: 0 }, color: W, radius: TURN, unlit: true }); spawned = true }
    }
    if (!spawned && pieces.length === 0) {
      for (let c = 0; c < N; c++) {
        for (const [t, side, r] of [[BACK[c], W, 0], ['p', W, 1], ['p', B, 6], [BACK[c], B, 7]]) {
          world.createProp({
            kind: KINDS[t], position: { x: sqX(c), y: BOARD_Y, z: sqZ(r) },
            color: side, size: HEIGHTS[t], bounce: false,
          })
        }
      }
      spawned = true
    }
    if (spawned) seedWait = time
  }
  // check / mate / stalemate are judged only when the board is SETTLED:
  // no local drag, nothing riding at lift height (a dragged piece is
  // absent from board[] - here locally by exclusion, remotely because
  // its streamed cell is arbitrary - and judging a board with a piece
  // missing invents mates). The verdict then sticks until the position
  // actually changes, so mid-move frames cannot flicker it.
  const settled = turnProp && !drag && pieces.every((p) => p.y < LIFT / 2)
  if (settled && !pieces.length) { posSig = ''; mateOver = null; checkedKing = null } // reset wiped the board
  if (settled && pieces.length) {
    const sig = turnProp.color + '|' + Math.round(turnProp.x * 1000) + ',' + Math.round(turnProp.z * 1000) + '|'
      + pieces.filter((p) => inb(p.c, p.r)).map((p) => p.type + (p.side === W ? 'w' : 'b') + p.c + p.r).sort().join(' ')
    if (sig !== posSig) {
      posSig = sig
      const side = turnProp.color
      const chk = inCheck(board, side)
      mateOver = anyMove(board, side, meta()) ? null : chk ? (side === W ? B : W) : 'draw'
      checkedKing = chk && !mateOver ? pieces.find((p) => p.type === 'k' && p.side === side && inb(p.c, p.r)) : null
      gameOver = captured ?? mateOver
      if (checkedKing) console.log((side === W ? 'white' : 'black') + ' is in check')
    }
  }
  // red warning ring under a checked king (the chat line carries the +)
  if (checkedKing && !gameOver) {
    const pts = circle(sqX(checkedKing.c), sqZ(checkedKing.r), 0.52, 0.1)
    if (!checkRing) checkRing = world.createLine({ points: pts, color: 0xe06a6a, width: 0.07, worldUnits: true })
    else checkRing.points = pts
  } else if (checkRing) { checkRing.despawn(); checkRing = null }
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
    const col = gameOver === 'draw' ? 0x8b98a8 : gameOver === W ? 0xffffff : 0xffc45e
    winRing = world.createLine({ points: circle(0, 0, 5.6, 0.15), color: col, width: 0.12, worldUnits: true })
    if (!winShown) {
      winShown = true
      console.log(gameOver === 'draw' ? 'stalemate - a draw! click the turn sphere to reset'
        : (gameOver === W ? 'white' : 'black') + ' wins! click the turn sphere to reset')
    }
  } else if (!gameOver && winRing) { winRing.despawn(); winRing = null; winShown = false }
}

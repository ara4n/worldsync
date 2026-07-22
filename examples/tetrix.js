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
// above drops. A blocked spawn tops the board out and wipes the well,
// zeroing every score and the shared level with it.
//
// Upload with "load world script (.js)". Click the world once so keys
// focus, then: left/right move, up rotates, down soft-drops, space
// hard-drops. Foreground game, like snake: a throttled hidden tab
// stamps its ops late and trips the divergence detector.

const H = 24, LANE = 5
const CELL = 0.6, CB = 0.29 // cell prop half-size: the "tetrix cell" tag
const X0 = -9, Y0 = 0.3     // world pos of column 0, bottom row (resting on the ground)
// Shared score/level state rides in hidden props (parked below the
// floor), identified by size: the LINES prop (unclaimed, primary-painted
// color = total lines cleared) drives the level for everyone; each
// player's SCORE prop (claimed by them, color = score) survives reloads
// via its claim and feeds every peer's HUD.
// At game over (top out) each player's final score also lands in an
// all-time top-5 board on the HUD, kept as per-user top-10 lists in
// io.element.highscores room state events (self-reported: nothing
// witnesses them yet).
const SCORE = 0.27, LINES = 0.24
const HIDE_Y = -4
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
let scoreProps = [], linesProp = null
let scoreId = null, scoreWait = -10, linesWait = -10, myScore = 0, hadLines = false
let prevScore = null // last game's score, captured at the wipe; local
                     // only, so just our own HUD row shows it
let softDrops = 0, hardCells = 0 // this piece's drop points
let hudLast = ''
let piece = null // { type, x, y, rot, ids: [4] }
let pendingClaims = [] // {id, t}
let lockQueue = []     // {id, cancelled, t}
let respawnAt = 0, gravAcc = 0, now = 0
let pendingClear = null // primary: { rows, t } mid-flash
const orphanSince = {}
let borderLines = [], borderFor = -1

world.onload = () => {
  // lit cells + the default ground: the CSM sun gives the stacks their
  // self-shadowing and drops the well's shadow on the floor
  world.env({ background: 0x1a212c })
}

world.onenter = () => { me = world.me }

// -- derived state --

const scan = () => {
  cells = []; scoreProps = []; linesProp = null
  for (const p of world.props()) {
    if (p.kind === 'box' && p.size === CB) {
      cells.push({
        id: p.id,
        c: Math.round((p.x - X0) / CELL),
        r: H - 1 - Math.round((p.y - Y0) / CELL),
        claimedBy: p.claimedBy,
        color: p.color,
      })
    } else if (p.kind === 'sphere' && p.size === SCORE) {
      scoreProps.push(p)
    } else if (p.kind === 'sphere' && p.size === LINES) {
      linesProp = p
    }
  }
}

// Real-game pacing: the marathon guideline curve, one level per 10
// cleared lines, shared by everyone via the lines prop. Capped at level
// 10 (~15 rows/s) - each gravity step is 4 move ops per player, and the
// guideline's deeper levels would be all netcode and no game.
const level = () => Math.floor((linesProp ? linesProp.color : 0) / 10) + 1
const gravityS = () => {
  const l = Math.min(level(), 10)
  return Math.pow(0.8 - (l - 1) * 0.007, l - 1)
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

/** would the piece, resting at (x, y), be sitting on another player's
 * piece that is still IN FLIGHT (claimed)? Resting there is forbidden:
 * the flyer moves on and the locked piece is left floating mid-air.
 * Hard drops refuse outright; gravity just hovers and retries. */
const restingOnFlight = (x, y, rot) => {
  const mine = myIds()
  for (const [c, r] of blocksFor(piece.type, x, y + 1, rot)) {
    if (c < 0 || c >= W || r >= H || r < 0) continue // walls and floor are solid ground
    for (const cell of cells) {
      if (!mine.has(cell.id) && cell.claimedBy !== '' && cell.c === c && cell.r === r) return true
    }
  }
  return false
}

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

/** guideline scoring at lock: whoever places the completing piece gets
 * the clear (100/300/500/800 x level), plus 1/cell soft and 2/cell hard
 * drop points banked while steering this piece */
const lockScore = () => {
  const blocks = blocksFor(piece.type, piece.x, piece.y, piece.rot)
  const occ = new Set()
  for (const cell of cells) {
    if (cell.claimedBy === '' && cell.c >= 0 && cell.c < W && cell.r >= 0 && cell.r < H) {
      occ.add(cell.c + ',' + cell.r)
    }
  }
  for (const [c, r] of blocks) occ.add(c + ',' + r)
  let full = 0
  for (const r of new Set(blocks.map((b) => b[1]))) {
    if (r < 0 || r >= H) continue
    let ok = true
    for (let c = 0; c < W && ok; c++) if (!occ.has(c + ',' + r)) ok = false
    if (ok) full++
  }
  return [0, 100, 300, 500, 800][full] * level()
}

const lock = () => {
  myScore += softDrops + 2 * hardCells + lockScore()
  softDrops = 0
  hardCells = 0
  if (scoreId) world.paint(scoreId, myScore)
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
    // game over for everyone: zero every score prop (paint has no claim
    // gate) and despawn the lines counter. Its disappearance is the
    // reset signal each peer watches for - nothing else ever removes it
    for (const p of scoreProps) world.paint(p.id, 0)
    if (linesProp) world.despawn(linesProp.id)
    respawnAt = now + 2
    return
  }
  if (blocks.some(([c, r]) => occupied(c, r))) {
    respawnAt = now + 1
    return
  }
  const ids = blocks.map(([c, r]) => {
    // lit (so the sun shades and shadows them) and bounce-free (pieces
    // slide on the grid; the dots drop-bounce reads wrong here)
    const id = world.createBox({ position: { x: wx(c), y: wy(r), z: 0 }, color: COLORS[type], size: CB, bounce: false })
    pendingClaims.push({ id, t: now })
    return id
  })
  piece = { type, x, y: 0, rot: 0, ids }
  gravAcc = 0
  softDrops = 0
  hardCells = 0
}

world.onkeydown = (ev) => {
  if (!piece) return
  switch (ev.key) {
    case 'ArrowUp': tryMove(piece.x, piece.y, (piece.rot + 1) % 4); break
    case 'ArrowLeft': tryMove(piece.x - 1, piece.y, piece.rot); break
    case 'ArrowRight': tryMove(piece.x + 1, piece.y, piece.rot); break
    case 'ArrowDown':
      if (tryMove(piece.x, piece.y + 1, piece.rot)) softDrops++
      else if (!restingOnFlight(piece.x, piece.y, piece.rot)) lock()
      break
    case ' ': {
      let y = piece.y
      while (y < H && collides(piece.x, y + 1, piece.rot) === false) y++
      if (restingOnFlight(piece.x, y, piece.rot)) {
        console.log('cannot drop onto a piece still in flight - wait for it to pass')
        break
      }
      hardCells = y - piece.y
      piece.y = y
      emitPos()
      lock()
      break
    }
  }
}

// -- shared highscores helper (identical in every example that keeps
// scores; world scripts have no imports, so keep the copies in sync).
// One io.element.highscores state event per user, state_key = their
// MXID (Matrix auth rules make it writable only by them): { scores:
// { [game]: [{ score, ts }, ...] } }, each list capped script-side to
// the user's 10 best to bound the event size. Self-reported: nothing
// witnesses these yet. --

const HIGHSCORES_TYPE = 'io.element.highscores'

/** merge a finished game's score into our own room-state top-10 (the
 * host drops the write when we lack permission to send room state) */
function submitScore(game, score) {
  const mine = world.getStateEvents(HIGHSCORES_TYPE, world.me.user)
  const content = mine && mine.content && typeof mine.content === 'object' ? mine.content : {}
  const scores = content.scores && typeof content.scores === 'object' ? content.scores : {}
  const list = Array.isArray(scores[game]) ? scores[game].filter((e) => e && typeof e.score === 'number') : []
  const entry = { score, ts: Date.now() }
  list.push(entry)
  list.sort((a, b) => b.score - a.score) // stable: standing entries win ties
  const top = list.slice(0, 10)
  if (top.indexOf(entry) === -1) return // didn't make our own top 10
  scores[game] = top
  content.scores = scores
  world.setStateEvent(HIGHSCORES_TYPE, content)
}

/** the all-time top 5 as a HUD table: one row per user (their best),
 * distilled from every user's top-10 list in room state */
function bestTable(game) {
  const rows = []
  for (const ev of world.getStateEvents(HIGHSCORES_TYPE)) {
    const scores = ev.content && ev.content.scores ? ev.content.scores : {}
    const list = Array.isArray(scores[game]) ? scores[game] : []
    let best = 0
    for (const e of list) if (e && typeof e.score === 'number' && e.score > best) best = e.score
    if (best > 0) rows.push({ who: ev.stateKey.split(':')[0], score: best })
  }
  const top = rows.sort((a, b) => b.score - a.score).slice(0, 5)
  if (!top.length) return ''
  const esc = (x) => String(x).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]))
  let html = '<span style="color:#8b98a8">all-time</span><table>'
  for (const r of top) html += `<tr><td>${esc(r.who)}</td><td>${r.score}</td></tr>`
  return html + '</table>'
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

  // a vanished lines prop means someone topped out: forget the local
  // tally too, or our next lock would repaint the old score right over
  // the zero the wiper painted. Pushing linesWait holds the primary's
  // recreate for 2s, so even a throttled tab sees the gap
  if (hadLines && !linesProp) {
    prevScore = myScore
    // game over for us too: file the final score into our per-user
    // room-state top-10 (self-reported; no witnessing yet)
    if (myScore > 0) submitScore('tetrix', myScore)
    myScore = 0; softDrops = 0; hardCells = 0
    if (scoreId) world.paint(scoreId, 0)
    linesWait = now
  }
  hadLines = !!linesProp

  // claims trail spawns by a fold (a same-dispatch claim is refused);
  // looked up directly, since we claim cells AND our score prop
  pendingClaims = pendingClaims.filter((pc) => {
    const p = world.prop(pc.id)
    if (!p) return now - pc.t < 3
    if (p.claimedBy === '') world.claim(pc.id)
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
    if (gravAcc >= gravityS()) {
      gravAcc = 0
      // blocked by a piece still in flight: hover and retry, never lock
      // onto a support that is about to move away
      if (!tryMove(piece.x, piece.y + 1, piece.rot) && !restingOnFlight(piece.x, piece.y, piece.rot)) lock()
    }
  }

  // our score prop: adopt a survivor from a previous session (the claim
  // is ours across reloads, keeping the score), else spawn one; if ours
  // vanished (a sweep race), let it respawn
  if (scoreId && now > scoreWait + 4 && !scoreProps.some((p) => p.id === scoreId)) scoreId = null
  if (!scoreId) {
    const existing = scoreProps.find((p) => p.claimedBy === me.id)
    if (existing) {
      scoreId = existing.id
      scoreWait = now
      myScore = Math.max(myScore, existing.color)
    } else if (now > scoreWait + 2) {
      scoreWait = now
      scoreId = world.createSphere({ position: { x: 0, y: HIDE_Y, z: 0 }, color: 0, radius: SCORE, unlit: true, bounce: false })
      pendingClaims.push({ id: scoreId, t: now })
    }
  }

  // the scoreboard HUD, rebuilt from the shared props so every peer
  // (and any late joiner) shows the same table
  const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]))
  const board = scoreProps
    .filter((p) => p.claimedBy !== '')
    .map((p) => ({ who: p.claimedBy.split(':')[0], mine: p.mine, score: p.color }))
    .sort((a, b) => b.score - a.score)
  // markup stays inside the HUD's Matrix-subset allowlist: styles only
  // ride on span/font, so the highlight wraps the cells
  let html = `<b>tetrix</b> · level ${level()} · ${linesProp ? linesProp.color : 0} lines<table>`
  for (const r of board) {
    const cell = (s) => (r.mine ? `<span style="color:#7fe0a0">${s}</span>` : s)
    const score = r.mine && prevScore !== null ? `${r.score} (prev ${prevScore})` : r.score
    html += `<tr><td>${cell(esc(r.who))}</td><td>${cell(score)}</td></tr>`
  }
  html += '</table>'
  html += bestTable('tetrix')
  if (html !== hudLast) { hudLast = html; world.hud(html) }

  // -- primary duties: the lines counter, line clears, duplicates, orphans --
  if (!world.me.primary) { pendingClear = null; return }
  if (!linesProp && now > linesWait + 2) {
    linesWait = now
    world.createSphere({ position: { x: 1, y: HIDE_Y, z: 0 }, color: 0, radius: LINES, unlit: true, bounce: false })
  }
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
    if (linesProp) world.paint(linesProp.id, linesProp.color + rows.length) // levels for everyone
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
  // sweep what nobody will ever drive again. Cells: claimed by a dead
  // peer (unclaimed cells are landed blocks, sacred). Score props: any
  // without a LIVE owner - departure force-unclaims them, so ownerless
  // ones are dead weight; the grace covers a fresh spawn's claim window.
  const live = new Set(world.peers().map((p) => p.id))
  const doomed = (id, cond) => {
    if (!cond) { delete orphanSince[id]; return }
    if (orphanSince[id] === undefined) orphanSince[id] = time
    else if (time - orphanSince[id] > 5) { world.despawn(id); delete orphanSince[id] }
  }
  for (const cell of cells) doomed(cell.id, cell.claimedBy !== '' && !live.has(cell.claimedBy))
  for (const p of scoreProps) doomed(p.id, !live.has(p.claimedBy))
}

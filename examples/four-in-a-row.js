// four-in-a-row, multiplayer, as a worldsync WebSG script. The board is
// sim state (disc props), identical on every peer; seats are claimed
// props, so who plays which color resolves deterministically even when
// two peers grab the same seat. Turn order needs no extra state: side to
// move is just the disc-count parity, which every peer derives from the
// same props. Everything cosmetic (frame, turn ring, win line) is local
// line entities each peer draws for itself.
//
// Upload with "load world script (.js)" (or paste into the monaco
// editor and Save & Run). Click a seat sphere to sit (click again to
// stand; claim both to test solo). On your turn, click one of the small
// gray selectors above a column to drop a disc. Four in a row wins;
// when the game is over, clicking any selector clears the board.

const COLS = 7, ROWS = 6, CELL = 0.8
const X0 = -(COLS - 1) / 2 * CELL
const Y0 = 0.9
const DISC = 0.35, SEL = 0.18, SEAT = 0.32 // prop sizes double as type tags
const RED = 0xda664f, YEL = 0xe3db50
const colX = (c) => X0 + c * CELL
const rowY = (r) => Y0 + r * CELL
const DROP_Y = rowY(ROWS - 1) + CELL * 1.4
const SEL_Y = rowY(ROWS - 1) + CELL
const SEAT_X = (COLS / 2) * CELL + 1.2

let board, sels, seats, discCount, allDiscs
// discs we spawned that have not folded into the props table yet: they
// keep parity and occupancy honest between the click and the op landing
let recent = []
let seedWait = -10
let turnRing = null, winLine = null, winShown = false

// -- polylines as glTF data (keep this helper in sync across the example
// worlds; scripts have no imports). The WebSG API deliberately has no
// drawing primitives - it manipulates glTF data - so a "line" here is a
// batch of unit cubes instantiated once via world.loadGltf and stretched
// segment by segment through the scene-node TRS API. Instantiation is
// async: call polyTick() every update so freshly parsed batches catch
// up. width is world units; scale is a cheap thickness multiplier (0
// hides); color/opacity changes reload the batch (fine for discrete
// changes, not per-frame fades). --
const POLY_BOX = 'data:application/octet-stream;base64,AAAAvwAAAL8AAAC/AAAAPwAAAL8AAAC/AAAAPwAAAD8AAAC/AAAAvwAAAD8AAAC/AAAAvwAAAL8AAAA/AAAAPwAAAL8AAAA/AAAAPwAAAD8AAAA/AAAAvwAAAD8AAAA/AAABAAIAAAACAAMABAAGAAUABAAHAAYAAAAEAAUAAAAFAAEAAwACAAYAAwAGAAcAAAADAAcAAAAHAAQAAQAFAAYAAQAGAAIA'
const polys = []
let polySeq = 0
function polyTick() {
  for (const p of polys) if (p._dirty) p._dirty = !p._apply()
}
function createPolyline(opts = {}) {
  const cap = opts.cap || 24 // max segments; unused nodes stay hidden
  const lin = (v) => Math.pow(v / 255, 2.2) // sRGB int -> linear factor
  const self = {
    _id: 'poly' + (++polySeq),
    _color: opts.color === undefined ? 0xffffff : opts.color,
    _opacity: opts.opacity === undefined ? 1 : opts.opacity,
    _width: opts.width === undefined ? 0.05 : opts.width,
    _scale: 1,
    _pts: opts.points || [],
    _dirty: true,
    _load() {
      world.loadGltf(this._id, {
        asset: { version: '2.0' },
        scene: 0,
        scenes: [{ nodes: Array.from({ length: cap }, (_, i) => i) }],
        nodes: Array.from({ length: cap }, (_, i) => ({ name: this._id + '_' + i, mesh: 0, scale: [0, 0, 0] })),
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
        materials: [{
          pbrMetallicRoughness: {
            baseColorFactor: [lin(this._color >> 16 & 255), lin(this._color >> 8 & 255), lin(this._color & 255), this._opacity],
          },
          extensions: { KHR_materials_unlit: {} },
          doubleSided: true,
          alphaMode: this._opacity < 1 ? 'BLEND' : 'OPAQUE',
        }],
        extensionsUsed: ['KHR_materials_unlit'],
        accessors: [
          { bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
          { bufferView: 1, componentType: 5123, count: 36, type: 'SCALAR' },
        ],
        bufferViews: [
          { buffer: 0, byteOffset: 0, byteLength: 96 },
          { buffer: 0, byteOffset: 96, byteLength: 72 },
        ],
        buffers: [{ uri: POLY_BOX, byteLength: 168 }],
      })
    },
    _reload() { world.unloadGltf(this._id); this._load(); this._dirty = true },
    _apply() {
      const w = this._width * this._scale
      for (let i = 0; i < cap; i++) {
        const node = world.findNodeByName(this._id + '_' + i)
        if (!node) return false // still parsing; polyTick retries
        const a = this._pts[i], b = this._pts[i + 1]
        const len = a && b ? Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) : 0
        if (w <= 0 || len < 1e-6) { node.scale = [0, 0, 0]; continue }
        // quaternion turning +z onto the segment direction (half-way trick)
        let qx = -(b.y - a.y) / len, qy = (b.x - a.x) / len, qw = 1 + (b.z - a.z) / len
        const qn = Math.hypot(qx, qy, qw)
        if (qn < 1e-4) { qx = 0; qy = 1; qw = 0 } // segment points exactly -z
        else { qx /= qn; qy /= qn; qw /= qn }
        node.translation = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 }
        node.rotation = { x: qx, y: qy, z: 0, w: qw }
        node.scale = { x: w, y: w, z: len + w / 2 } // tiny overlap closes corners
      }
      return true
    },
    get points() { return this._pts },
    set points(ps) { this._pts = ps || []; this._dirty = true },
    get color() { return this._color },
    set color(c) { if (c !== this._color) { this._color = c; this._reload() } },
    get opacity() { return this._opacity },
    set opacity(o) { if (o !== this._opacity) { this._opacity = o; this._reload() } },
    get scale() { return this._scale },
    set scale(k) { if (k !== this._scale) { this._scale = k; this._dirty = true } },
    despawn() {
      world.unloadGltf(this._id)
      const i = polys.indexOf(this)
      if (i !== -1) polys.splice(i, 1)
    },
  }
  self._load()
  polys.push(self)
  return self
}

world.onload = () => {
  world.env({ background: 0x232b36 })
  world.camera({ x: 0, y: 2.9, z: 8.8 }, { x: 0, y: 2.9, z: 0 })
  const xL = X0 - CELL / 2, xR = colX(COLS - 1) + CELL / 2
  const yB = Y0 - CELL / 2, yT = rowY(ROWS - 1) + CELL / 2
  const seg = (a, b) => createPolyline({ points: [a, b], color: 0x5a6673, width: 0.04, cap: 1 })
  for (let c = 0; c <= COLS; c++) seg({ x: xL + c * CELL, y: yB, z: 0 }, { x: xL + c * CELL, y: yT, z: 0 })
  seg({ x: xL, y: yB, z: 0 }, { x: xR, y: yB, z: 0 })
  seg({ x: xL, y: yT, z: 0 }, { x: xR, y: yT, z: 0 })
}

// -- derived state: everything comes from the shared props table --

const scan = () => {
  board = Array.from({ length: COLS }, () => Array(ROWS).fill(null))
  sels = new Map(); seats = {}; discCount = 0; allDiscs = []
  for (const p of world.props()) {
    if (p.kind !== 'sphere') continue
    if (p.size === DISC) {
      discCount++
      allDiscs.push(p.id)
      const c = Math.round((p.x - X0) / CELL), r = Math.round((p.y - Y0) / CELL)
      if (c >= 0 && c < COLS && r >= 0 && r < ROWS && Math.abs(p.y - rowY(r)) < 0.01) board[c][r] = p
    } else if (p.size === SEL) {
      sels.set(Math.round((p.x - X0) / CELL), p)
    } else if (p.size === SEAT) {
      seats[p.color] = p
    }
  }
  // an in-flight disc that has surfaced (or timed out) leaves the ledger
  recent = recent.filter((d) => !(board[d.c] && board[d.c][d.r]) && d.age < 4)
}

const cellFree = (c, r) => !board[c][r] && !recent.some((d) => d.c === c && d.r === r)
const effCount = () => discCount + recent.filter((d) => !d.counted).length
const turnColor = () => (effCount() % 2 === 0 ? RED : YEL)

const winCells = () => {
  const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]]
  for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) {
    const p = board[c][r]
    if (!p) continue
    for (const [dc, dr] of dirs) {
      const run = [p]
      for (let k = 1; k < 4; k++) {
        const q = (board[c + dc * k] || [])[r + dr * k]
        if (!q || q.color !== p.color) break
        run.push(q)
      }
      if (run.length === 4) return run
    }
  }
  return null
}

const boardFull = () => {
  for (let c = 0; c < COLS; c++) if (cellFree(c, ROWS - 1)) return false
  return true
}

// -- input --

world.onpointerdown = (ev) => {
  if (!ev.entity) return
  scan()
  for (const color of [RED, YEL]) {
    const s = seats[color]
    if (s && s.id === ev.entity) {
      if (s.mine) world.unclaim(s.id)
      else if (s.claimedBy === '') world.claim(s.id)
      else console.log('that seat is taken by', s.claimedBy)
      return
    }
  }
  for (const [c, s] of sels) {
    if (s.id !== ev.entity) continue
    const win = winCells()
    if (win || boardFull()) {
      // game over: any seated player clears the board with a click
      // (allDiscs, not the board cells: a mid-drop disc must go too)
      if ((seats[RED] && seats[RED].mine) || (seats[YEL] && seats[YEL].mine)) {
        for (const id of allDiscs) world.despawn(id)
        recent = []
      }
      return
    }
    const turn = turnColor()
    const seat = seats[turn]
    if (!seat || !seat.mine) {
      console.log(turn === RED ? 'red' : 'yellow', 'to move - claim that seat (click its sphere) to play')
      return
    }
    let r = 0
    while (r < ROWS && !cellFree(c, r)) r++
    if (r >= ROWS) { console.log('column full'); return }
    // spawn at the top; the move op next update makes the prop layer
    // animate it as a bouncing drop into the cell
    const id = world.createSphere({ position: { x: colX(c), y: DROP_Y, z: 0 }, color: turn, radius: DISC })
    recent.push({ id, c, r, counted: false, moved: false, age: 0 })
    return
  }
}

// -- per-frame: seed, settle drops, cosmetics --

world.onupdate = (dt, time) => {
  polyTick() // freshly parsed line batches catch up with their points
  scan()
  for (const d of recent) {
    d.age += dt
    if (!d.moved) { world.move(d.id, { x: colX(d.c), y: rowY(d.r), z: 0 }); d.moved = true; d.counted = true }
  }
  // the primary seeds missing furniture (seats, selectors); the 2s pause
  // between attempts lets its own ops fold before it judges them missing
  if (world.me.primary && time > seedWait + 2) {
    let spawned = false
    if (!seats[RED]) { world.createSphere({ position: { x: -SEAT_X, y: 0.6, z: 0 }, color: RED, radius: SEAT }); spawned = true }
    if (!seats[YEL]) { world.createSphere({ position: { x: SEAT_X, y: 0.6, z: 0 }, color: YEL, radius: SEAT }); spawned = true }
    for (let c = 0; c < COLS; c++) {
      if (!sels.has(c)) { world.createSphere({ position: { x: colX(c), y: SEL_Y, z: 0 }, color: 0x8b98a8, radius: SEL, unlit: true }); spawned = true }
    }
    if (spawned) seedWait = time
  }
  // turn ring: a local circle under the seat whose turn it is
  const turn = turnColor()
  const seat = seats[turn]
  if (seat) {
    const pts = []
    for (let k = 0; k <= 24; k++) {
      const a = (k / 24) * Math.PI * 2
      pts.push({ x: seat.x + Math.cos(a) * 0.55, y: 0.12, z: seat.z + Math.sin(a) * 0.55 })
    }
    if (!turnRing) turnRing = createPolyline({ points: pts, color: turn, width: 0.05 })
    else { turnRing.points = pts; turnRing.color = turn }
  }
  // win line: local, through the four (every peer computes the same four)
  const win = winCells()
  if (win && !winLine) {
    const a = win[0], b = win[3]
    winLine = createPolyline({
      points: [{ x: a.x, y: a.y, z: 0.45 }, { x: b.x, y: b.y, z: 0.45 }],
      color: 0xffffff, width: 0.12, cap: 1,
    })
    if (!winShown) { winShown = true; console.log(win[0].color === RED ? 'red' : 'yellow', 'wins! click a selector to clear') }
  } else if (!win && winLine) {
    winLine.despawn()
    winLine = null
    winShown = false
  }
}

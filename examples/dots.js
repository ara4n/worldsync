// dots-3d, multiplayer, as a worldsync WebSG script. Every peer runs this
// sandboxed; nobody talks to the network. The board is sim state (props),
// so it is identical on every peer; claims are the coordination primitive:
// you chain dots by claiming them one at a time, racing rivals dot-by-dot,
// and claim races resolve deterministically in timeline order. Chains are
// DRAWN locally by every peer from shared data - the app has no line
// primitive: chain order rides the kv table, the live endpoint is a tiny
// "tip" prop the dragger moves (prop data over the datachannel, eased
// client-side like any prop), and each script stretches glTF cubes
// through the dots to render every chain in its owner's colour. Outcomes
// (clears, drops, refills, reshuffles) are computed by the acting peer
// and shipped as ops, so no shared randomness is ever needed.
//
// Upload with "load world script (.js)". Drag same-coloured adjacent dots
// to chain them; release to clear chains of 2+; close a loop to clear the
// whole colour. Backtrack through the previous dot to unwind a link. The
// chain may revisit its own dots (that is how loops close), but each
// SEGMENT is unique: a link already in the chain can never be re-added,
// in either direction.
//
// Scoreboard, tetrix-style: shared state rides in hidden props parked far
// below the fog, identified by radius. Each player's SCORE sphere (claimed
// by them, color = score, 1 point per dot cleared, so loops pay big)
// survives reloads via its claim and feeds every peer's HUD. The TIMER
// sphere (unclaimed, primary-counted, color = seconds left, IDLE = armed)
// runs a 60s round: the countdown starts when someone starts the game by
// chaining the first dot; at 0 play freezes and final scores hold for a
// beat, then the primary repaints a fresh board and rearms the timer.
// Each round's final score also lands in an all-time top-5 board on the
// HUD, kept as per-user top-10 lists in io.element.highscores room
// state events (self-reported: nothing witnesses them yet).

const W = 3, H = 3, D = 3
const COLORS = [0xda664f, 0x9060b0, 0xe3db50, 0x94baf9, 0xa0e699]
const R = 0.16
const ORG = { x: -(W - 1) / 2, y: 1.4, z: -(D - 1) / 2 }
const SCORE = 0.11, TIMER = 0.13 // hidden HUD props: the radius is the tag
const TIP = 0.05                 // chain-tip bead props: radius is the tag
const HIDE_Y = -30               // parked past the fog's far plane
const GAME_S = 60, IDLE = 999, OVER_HOLD = 5

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
let chainLine = null  // my chain, drawn locally (peers draw it from kv+tip)
let chainColor = 0xffffff
let tipId = null      // my chain-tip bead prop, moved with the pointer
let lastTipMove = -1
let peerChains = {}   // peer id -> { line }: rivals' chains, drawn from kv
let latticeLines = [] // local guide wires, one per grid edge: { edge, line }
let latticeTarget = 0.25
let pendingDrops = [] // refills spawned above the board, dropped a beat later
let dropWait = 0
let dotProps = []     // this frame's board dots (size R), from scan()
let scoreProps = [], timerProp = null
let scoreId = null, scoreWait = -10, timerWait = -10, myScore = 0
let prevScore = null  // last round's score; local, so just our own HUD row
let submitted = false // this round's score already sent to room state?
let pendingClaims = [] // {id, t}: claims trail spawns by a fold
let hudLast = ''
let now = 0
let deadline = null, lastPainted = -1, overAt = null // primary countdown state
const orphanSince = {}

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
  world.env({ background: 0xffffff, fog: { color: 0xffffff, near: 4.5, far: 11 }, ground: false })
  world.camera({ x: 0, y: ORG.y + 1, z: 5.2 }, { x: 0, y: ORG.y + 1, z: 0 })
  // one guide per unit edge (not per full row), so the guide under a
  // chained link can hide: the wire is coincident with it and they z-fight
  const segs = []
  for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) for (let z = 0; z < D; z++) {
    if (x + 1 < W) segs.push([{ x, y, z }, { x: x + 1, y, z }])
    if (y + 1 < H) segs.push([{ x, y, z }, { x, y: y + 1, z }])
    if (z + 1 < D) segs.push([{ x, y, z }, { x, y, z: z + 1 }])
  }
  latticeLines = segs.map(([a, b]) => {
    const line = createPolyline({
      points: [at(a.x, a.y, a.z), at(b.x, b.y, b.z)], color: 0xdddddd, width: 0.012, cap: 1,
    })
    line.scale = 0 // faded in by fadeLattice (scale, not opacity: no reload)
    return { edge: edgeKey(a, b), line }
  })
  // the wire: world-units width after the original's cylinder segments
  // (radius 0.0286 at dot radius 0.15), recolored per drag to the chained
  // dots' color
  chainLine = createPolyline({ color: world.me.color, width: 0.06, cap: 40 })
}

/** publish my chain as shared data: the dot order and colour in the kv
 * table, the live endpoint as the tip bead prop. Everything a rival's
 * script needs to draw this chain already replicates over the
 * datachannel; nothing cosmetic is broadcast. */
function shareChain() {
  if (sel.length) world.setData('chain:' + world.me.id, { ids: sel, color: chainColor, tip: tipId })
  else world.deleteData('chain:' + world.me.id)
}

/** drop the tip bead and the shared record (drag over or cancelled) */
function unshareChain() {
  if (tipId) { world.despawn(tipId); tipId = null }
  world.deleteData('chain:' + world.me.id)
}

/** draw every OTHER peer's chain from its shared record: claimed dots by
 * id, then the tip bead's current sim position. The tip moves in the
 * dragger's ~50ms world.move steps - the bead itself eases client-side,
 * the wire follows at op rate. */
function drawPeerChains() {
  const seen = {}
  for (const k of world.dataKeys()) {
    if (k.indexOf('chain:') !== 0) continue
    const peer = k.slice(6)
    if (peer === world.me.id) continue
    const rec = world.getData(k)
    if (!rec || !Array.isArray(rec.ids)) continue
    seen[peer] = true
    let pc = peerChains[peer]
    if (!pc) pc = peerChains[peer] = { line: createPolyline({ color: rec.color, width: 0.06, cap: 40 }) }
    pc.line.color = rec.color // reloads only when their chain colour changed
    const pts = []
    for (const id of rec.ids) {
      const p = world.prop(id)
      if (p) pts.push({ x: p.x, y: p.y, z: p.z })
    }
    const tip = rec.tip ? world.prop(rec.tip) : null
    if (tip) pts.push({ x: tip.x, y: tip.y, z: tip.z })
    pc.line.points = pts.length >= 2 ? pts : []
  }
  for (const peer in peerChains) {
    if (!seen[peer]) { peerChains[peer].line.despawn(); delete peerChains[peer] }
  }
}

/** direction-independent key for the unit edge between grid coords a, b */
function edgeKey(a, b) {
  const ka = key(a.x, a.y, a.z), kb = key(b.x, b.y, b.z)
  return ka < kb ? ka + '|' + kb : kb + '|' + ka
}

/** edge keys currently covered by my chain's links */
function chainedEdges() {
  const covered = {}
  for (let i = 1; i < sel.length; i++) {
    const a = world.prop(sel[i - 1]), b = world.prop(sel[i])
    if (a && b) covered[edgeKey(gridOf(a), gridOf(b))] = true
  }
  return covered
}

/** ease the lattice toward its target weight; called every update. The
 * fade is the wires' SCALE (thickness), which is a cheap TRS write -
 * opacity would rebuild the batch's material every frame. Guides under a
 * chained link snap to 0 instead (the wire replaces them exactly) */
function fadeLattice() {
  const covered = chainedEdges()
  for (const l of latticeLines) {
    if (covered[l.edge]) {
      if (l.line.scale !== 0) l.line.scale = 0
      continue
    }
    const d = latticeTarget - l.line.scale
    if (Math.abs(d) > 0.01) l.line.scale += d * 0.12
    else if (l.line.scale !== latticeTarget) l.line.scale = latticeTarget
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

/** the all-time top 5 GAMES as a HUD table (a hot streak can fill it
 * with one user's rows), distilled from every user's top-10 list in
 * room state */
function bestTable(game) {
  const rows = []
  for (const ev of world.getStateEvents(HIGHSCORES_TYPE)) {
    const scores = ev.content && ev.content.scores ? ev.content.scores : {}
    const list = Array.isArray(scores[game]) ? scores[game] : []
    for (const e of list) {
      if (e && typeof e.score === 'number') {
        rows.push({ who: ev.stateKey.split(':')[0], score: e.score, ts: e.ts })
      }
    }
  }
  const top = rows.sort((a, b) => b.score - a.score).slice(0, 5)
  if (!top.length) return ''
  const esc = (x) => String(x).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]))
  const day = (ts) => (typeof ts === 'number' ? new Date(ts).toISOString().slice(0, 10) : '')
  let html = '<span style="color:#8b98a8">all-time</span><table>'
  for (const r of top) {
    html += `<tr><td>${esc(r.who)}</td><td>${r.score}</td>`
      + `<td><span style="color:#8b98a8">${day(r.ts)}</span></td></tr>`
  }
  return html + '</table>'
}

/** split this frame's props by radius tag: board dots, scores, the timer */
function scan() {
  dotProps = []; scoreProps = []; timerProp = null
  for (const p of world.props()) {
    if (p.size === R) dotProps.push(p)
    else if (p.size === SCORE) scoreProps.push(p)
    else if (p.size === TIMER) timerProp = p
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

world.onupdate = (dt, time) => {
  now = time
  scan()
  // Board init is single-runner logic: only the primary seeds, and only
  // into an empty world. The colours are the primary's dice, shipped in
  // the spawn ops; solvability is checked before anything is spawned.
  if (!seeded && dotProps.length > 0) seeded = true
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
  const t = timerProp ? timerProp.color : IDLE
  // time up: drop any live chain where it stands, uncleared
  if (t === 0 && (drawing || sel.length)) {
    drawing = false
    latticeTarget = 0.25
    for (const id of new Set(sel)) world.unclaim(id)
    sel = []; cycleColor = null; preview = null
    chainLine.points = []
    unshareChain()
  }
  // the round just ended: file our own final score into the per-user
  // room-state top-10 (self-reported; the host drops it if it doesn't
  // make our cut or we lack permission)
  if (t === 0 && !submitted) {
    submitted = true
    if (myScore > 0) submitScore('dots', myScore)
  }
  // a rearmed timer means the primary reset the round: forget the local
  // tally too, or our next clear would repaint the old score right over
  // the zero the reset painted
  if (t === IDLE) {
    submitted = false
    if (myScore > 0) { prevScore = myScore; myScore = 0 }
  }
  if (drawing) {
    revalidate()
    updateLine()
  }
  drawPeerChains()
  // Refills spawn above the board and settle a couple of ticks later: the
  // spawn and the move must land on different ticks for every renderer to
  // see the drop (a same-tick move would just create them in place).
  if (pendingDrops.length && ++dropWait >= 2) {
    for (const d of pendingDrops) world.move(d.id, d.pos)
    pendingDrops = []
    dropWait = 0
  }
  fadeLattice()
  polyTick() // apply this frame's wire/chain writes (and late parses)

  // claims trail spawns by a fold (a same-dispatch claim is refused)
  pendingClaims = pendingClaims.filter((pc) => {
    const p = world.prop(pc.id)
    if (!p) return now - pc.t < 3
    if (p.claimedBy === '') world.claim(pc.id)
    return false
  })
  // our score prop: adopt a survivor from a previous session (the claim
  // is ours across reloads, keeping the score), else spawn one; if ours
  // vanished (an orphan sweep race), let it respawn
  if (scoreId && now > scoreWait + 4 && !scoreProps.some((p) => p.id === scoreId)) scoreId = null
  if (!scoreId) {
    const existing = scoreProps.find((p) => p.claimedBy === world.me.id)
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

  // the scoreboard HUD, rebuilt from the shared props so every peer (and
  // any late joiner) shows the same table
  const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]))
  const board = scoreProps
    .filter((p) => p.claimedBy !== '')
    .map((p) => ({ who: p.claimedBy.split(':')[0], mine: p.mine, score: p.color }))
    .sort((a, b) => b.score - a.score)
  const clock =
    t === IDLE ? `${GAME_S}s · chain a dot to start`
    : t === 0 ? '<span style="color:#e08080">time up</span>'
    : t <= 10 ? `<span style="color:#e08080">${t}s</span>`
    : `${t}s`
  let html = `<b>dots</b> · ${clock}<table>`
  for (const r of board) {
    const cell = (s) => (r.mine ? `<span style="color:#7fe0a0">${s}</span>` : s)
    const score = r.mine && prevScore !== null ? `${r.score} (prev ${prevScore})` : r.score
    html += `<tr><td>${cell(esc(r.who))}</td><td>${cell(score)}</td></tr>`
  }
  html += '</table>'
  html += bestTable('dots')
  if (html !== hudLast) { hudLast = html; world.hud(html) }

  // -- primary duties: the timer prop, the countdown, round resets --
  if (!world.me.primary) { deadline = null; lastPainted = -1; overAt = null; return }
  if (!timerProp && now > timerWait + 2) {
    timerWait = now
    world.createSphere({ position: { x: 1, y: HIDE_Y, z: 0 }, color: IDLE, radius: TIMER, unlit: true, bounce: false })
  }
  if (timerProp) {
    if (t !== IDLE && t > 0) {
      // count against a local deadline, repainting only when the shown
      // second falls behind it: never a double-decrement off a stale fold,
      // and a mid-round primary handoff just resumes from the painted value
      if (deadline === null) deadline = now + t
      const rem = Math.max(0, Math.ceil(deadline - now))
      if (rem < t && rem !== lastPainted) { world.paint(timerProp.id, rem); lastPainted = rem }
    } else { deadline = null; lastPainted = -1 }
    if (t === 0) {
      if (overAt === null) overAt = now
      // hold the final scores a beat, then start a fresh round (once the
      // last refills have settled and the board is whole again)
      else if (now - overAt > OVER_HOLD && dotProps.length === W * H * D) {
        console.log('new round')
        let fresh
        do {
          fresh = {}
          for (const p of dotProps) { const g = gridOf(p); fresh[key(g.x, g.y, g.z)] = COLORS[rnd(COLORS.length)] }
        } while (!solvable(fresh))
        for (const p of dotProps) {
          const g = gridOf(p)
          if (fresh[key(g.x, g.y, g.z)] !== p.color) world.paint(p.id, fresh[key(g.x, g.y, g.z)])
        }
        for (const p of scoreProps) world.paint(p.id, 0) // paint has no claim gate
        world.paint(timerProp.id, IDLE)
        overAt = null
      }
    } else overAt = null
  }
  // sweep score props whose owner is gone: departure force-unclaims, so
  // ownerless ones are dead weight; the grace covers a spawn's claim window
  const live = new Set(world.peers().map((p) => p.id))
  for (const p of scoreProps) {
    if (live.has(p.claimedBy)) { delete orphanSince[p.id]; continue }
    if (orphanSince[p.id] === undefined) orphanSince[p.id] = now
    else if (now - orphanSince[p.id] > 5) { world.despawn(p.id); delete orphanSince[p.id] }
  }
  // sweep chain leftovers of departed peers: their kv record goes, and
  // any tip bead no live chain record references (a peer who died
  // mid-drag leaves both behind; departure already freed their dots)
  const tipRefs = {}
  for (const k of world.dataKeys()) {
    if (k.indexOf('chain:') !== 0) continue
    if (!live.has(k.slice(6))) { world.deleteData(k); continue }
    const rec = world.getData(k)
    if (rec && rec.tip) tipRefs[rec.tip] = true
  }
  for (const p of world.props()) {
    if (p.size !== TIP || tipRefs[p.id]) { if (p.size === TIP) delete orphanSince[p.id]; continue }
    if (orphanSince[p.id] === undefined) orphanSince[p.id] = now
    else if (now - orphanSince[p.id] > 5) { world.despawn(p.id); delete orphanSince[p.id] }
  }
}

world.onpointerdown = (ev) => {
  if (!ev.entity) return
  if (timerProp && timerProp.color === 0) return // time up: wait for the reset
  const p = world.prop(ev.entity)
  if (!p || p.size !== R || p.claimedBy) return
  if (!world.claim(p.id)) return
  // chaining the first dot of an armed round starts the game: any peer may
  // fire the starting gun (paint has no claim gate), the primary counts
  if (timerProp && timerProp.color === IDLE) world.paint(timerProp.id, GAME_S)
  sel = [p.id]
  drawing = true
  cycleColor = null
  chainColor = p.color
  chainLine.color = p.color
  planeN = ev.dir
  anchor = { x: p.x, y: p.y, z: p.z }
  preview = null
  latticeTarget = 1.0
  // the tip bead: a real prop, so the sim replicates my live endpoint to
  // every peer (and eases it client-side) without any cosmetic plane
  tipId = world.createSphere({
    position: anchor, color: p.color, radius: TIP, unlit: true, bounce: false, pop: false,
  })
  lastTipMove = now
  shareChain()
}

world.onpointermove = (ev) => {
  if (!drawing) return
  if (ev.entity && sel.length) {
    const q = world.prop(ev.entity)
    if (q) extend(q)
  }
  preview = anchor && planeN ? WebSG.rayPlane(ev.origin, ev.dir, anchor, planeN) : null
  // stream the tip bead at ~drag-sampler rate: each move is one folded op
  if (tipId && preview && now - lastTipMove > 0.05) {
    lastTipMove = now
    world.move(tipId, preview)
  }
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
    shareChain()
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
  shareChain()
}

world.onpointerup = () => {
  if (!drawing) return
  drawing = false
  latticeTarget = 0.25
  revalidate()
  const over = timerProp && timerProp.color === 0
  if (!over && (sel.length > 1 || (cycleColor !== null && sel.length > 0))) clearChain()
  else for (const id of new Set(sel)) world.unclaim(id)
  sel = []
  cycleColor = null
  preview = null
  chainLine.points = []
  unshareChain()
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
    shareChain()
  }
  if (sel.length) {
    const a = world.prop(sel[sel.length - 1])
    if (a) anchor = { x: a.x, y: a.y, z: a.z }
  } else if (drawing) {
    drawing = false
    latticeTarget = 0.25
    chainLine.points = []
    unshareChain()
  }
}

function updateLine() {
  const pts = []
  for (const id of sel) {
    const p = world.prop(id)
    if (p) pts.push({ x: p.x, y: p.y, z: p.z })
  }
  if (preview) pts.push(preview)
  chainLine.points = pts.length >= 2 ? pts : []
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
      if (p.size !== R) continue // never sweep up a hidden score/timer prop
      if (p.color === cycleColor && (!p.claimedBy || p.claimedBy === me) && ids.indexOf(p.id) === -1) ids.push(p.id)
    }
  }
  // the score: a point per dot this clear removes, loop sweeps included
  myScore += ids.length
  if (scoreId) world.paint(scoreId, myScore)
  const remove = {}
  for (const id of ids) remove[id] = true
  const columns = {} // "x,z" -> surviving dots, sorted low-to-high
  for (const p of world.props()) {
    if (p.size !== R) continue // not a board dot (tip beads sit in-board!)
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

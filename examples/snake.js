// multiplayer snake, as a worldsync WebSG script: race on a 32x32 grid
// to eat numbers - the bigger the number, the more your snake grows.
// Arrow keys steer. You start parked at a random cell and nothing moves
// until your first key; from then on your snake never stops until it
// crashes (wall or any snake, yours included), at which point it flashes
// out and you respawn parked somewhere new. The pace starts leisurely
// and tightens a little with every segment your snake grows. A crash
// files the length you reached into your per-user top-10 in
// io.element.highscores room state; the HUD scores every racer live
// (lengths counted from the claims in the shared props table), shows
// your previous run, and lists the room's all-time top-5 runs
// (self-reported: nothing witnesses them yet).
//
// Sync model: your snake is YOURS. Its body order lives only in your
// script; what everyone shares is the props table - one box per
// segment in your accent color, advanced by spawn-head/despawn-tail ops
// each step (2 ops/step, however long the snake). Ownership rides on
// CLAIMS, not color (accent hues can collide): each segment is claimed
// by its owner as soon as its spawn folds, so cleanup and collision
// exclusion key on claimedBy while color stays cosmetic. Everyone else
// just renders and collides against those props, so late joiners see
// every snake mid-race. Food is props too (radius encodes the number,
// digits are local 7-segment lines), kept stocked by the primary. Two
// heads racing into the same cell on the same tick both survive the
// entry - worldsync ops race deterministically but this script does not
// referee photo finishes; the NEXT step kills whoever is still there.
//
// Upload with "load world script (.js)" and press an arrow key.
// (A hidden tab keeps racing on the background heartbeat, but a browser
// that throttles it will stamp its ops late and the sim will flag
// divergence - snake is a foreground game.)

const N = 32, CELL = 0.45, Y = 0.3
const SEG = 0.21 // segment half-size (boxes render 2*size wide); also the tag that says "snake, not food"
const FOODC = 0xffffff
const foodR = (v) => 0.14 + 0.02 * v // 1..9 -> 0.16..0.32, all distinct
const foodV = (s) => Math.round((s - 0.14) / 0.02)
const isFood = (p) => p.kind === 'sphere' && p.color === FOODC && foodV(p.size) >= 1 && foodV(p.size) <= 9
const FOODS = 4
// pace: leisurely at spawn length, tightening a little with every
// segment eaten, floored well before it outruns netcode (or thumbs)
const STEP0 = 0.24, STEP_MIN = 0.09
const stepS = (len) => Math.max(STEP_MIN, STEP0 * Math.pow(0.985, len - 3))
const cx = (c) => (c - (N - 1) / 2) * CELL
const cz = (r) => (r - (N - 1) / 2) * CELL
const key = (c, r) => c + ',' + r
const DIRS = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }

let me, myColor
let myCells = [] // [tail..head] cell keys, the authoritative body order
let myIds = []   // matching prop ids
let pendingClaims = [] // spawned segments whose claim waits for the fold
// Turns queue rather than overwrite: two keys inside one step interval
// (down then left, say) both take effect, one step each. Each key is
// validated against the direction it will actually FOLLOW - the queue
// tail, not the last step - or a quick second key would read as an
// about-face against a turn that has not happened yet and get dropped.
let dirQueue = []
let dir = null, lastMoved = null, pendingGrowth = 0
let acc = 0, state = 'boot', stateT = 0, now = 0
let seedWait = -10
let hudLast = ''
let prevScore = null // last run's length; local, so just our own HUD row
const orphanSince = {} // prop id -> when it first looked ownerless
const digits = new Map() // food id -> its local digit/pip lines
let border = null

world.onload = () => {
  world.env({ background: 0x151b24, ground: false })
  world.camera({ x: 0, y: 15.5, z: 8.5 }, { x: 0, y: 0, z: 0 })
}

world.onenter = () => { me = world.me; myColor = me.color }

world.onkeydown = (ev) => {
  const d = DIRS[ev.key]
  if (!d) return
  const prev = dirQueue.length ? dirQueue[dirQueue.length - 1] : lastMoved
  // no about-face: a moving snake cannot reverse into its own neck
  if (prev && myCells.length > 1 && d[0] === -prev[0] && d[1] === -prev[1]) return
  if (prev && d[0] === prev[0] && d[1] === prev[1]) return // held key, not a turn
  if (dirQueue.length < 3) dirQueue.push(d)
}

const cellOf = (p) => key(Math.round(p.x / CELL + (N - 1) / 2), Math.round(p.z / CELL + (N - 1) / 2))

const scan = () => {
  const segs = [], foods = []
  for (const p of world.props()) {
    if (p.kind === 'box' && p.size === SEG) segs.push(p)
    else if (isFood(p)) foods.push(p)
  }
  return { segs, foods }
}

const randFree = (occ) => {
  for (let k = 0; k < 200; k++) {
    const c = Math.floor(Math.random() * N), r = Math.floor(Math.random() * N)
    if (!occ.has(key(c, r))) return [c, r]
  }
  return [0, 0]
}

const spawnSeg = (c, r) => {
  // pop:false: head and tail cells appear/vanish instantly - the body
  // reads as one sliding shape, so per-cell fade/pop twinkle is noise.
  // bounce:false: claimed props normally swell 1.25x, which read as the
  // head growing in as its claim landed; segments stay claim-swell-free
  const id = world.createBox({ position: { x: cx(c), y: Y, z: cz(r) }, color: myColor, size: SEG, pop: false, bounce: false })
  pendingClaims.push({ id, t: now })
  return id
}

const mine = (s) => s.claimedBy === me.id || myIds.includes(s.id)

const spawnAt = (c, r) => {
  myCells = [key(c, r)]
  myIds = [spawnSeg(c, r)]
  dir = null
  dirQueue = []
  lastMoved = null
  pendingGrowth = 2 // grow into a length-3 snake as you set off
  console.log('parked - press an arrow key to go')
}

const crash = () => {
  for (const id of myIds) world.paint(id, 0xffffff)
  state = 'dead'
  stateT = now
  dir = null
  // the run's score is the length reached, growth still in the pipe
  // included; a bite-less run (exactly the spawn length 3) stays off the
  // board
  const score = myCells.length + pendingGrowth
  prevScore = score
  if (score > 3) submitScore('snake', score)
  console.log(`crashed at length ${myCells.length}`)
}

const step = (segs, foods) => {
  while (dirQueue.length) {
    const d = dirQueue.shift()
    // re-check the reverse rule: the snake may have grown a neck since
    // this key was accepted (enqueued at length 1, consumed longer)
    if (lastMoved && myCells.length > 1 && d[0] === -lastMoved[0] && d[1] === -lastMoved[1]) continue
    dir = d
    break
  }
  const [hc, hr] = myCells[myCells.length - 1].split(',').map(Number)
  const nc = hc + dir[0], nr = hr + dir[1]
  const nk = key(nc, nr)
  if (nc < 0 || nc >= N || nr < 0 || nr >= N) return crash()
  // occupancy: other snakes from the shared table, my own body from local
  // truth (my table entries lag my ops by the fold, so the freshly
  // vacated tail would read as a false self-collision)
  const occ = new Set()
  for (const s of segs) { if (!mine(s)) occ.add(cellOf(s)) }
  for (const k of myCells) occ.add(k)
  if (pendingGrowth === 0) occ.delete(myCells[0]) // the tail vacates this step
  if (occ.has(nk)) return crash()
  myCells.push(nk)
  myIds.push(spawnSeg(nc, nr))
  if (pendingGrowth > 0) pendingGrowth--
  else { world.despawn(myIds.shift()); myCells.shift() }
  lastMoved = dir
  const bite = foods.find((f) => cellOf(f) === nk)
  if (bite) {
    world.despawn(bite.id)
    pendingGrowth += foodV(bite.size)
    console.log(`ate a ${foodV(bite.size)} - length ${myCells.length + pendingGrowth}`)
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

// 7-segment digit above each food, drawn locally (t,tl,tr,m,bl,br,b)
const SEGDEFS = {
  t: [[-1, 1], [1, 1]], m: [[-1, 0], [1, 0]], b: [[-1, -1], [1, -1]],
  tl: [[-1, 1], [-1, 0]], tr: [[1, 1], [1, 0]], bl: [[-1, 0], [-1, -1]], br: [[1, 0], [1, -1]],
}
const LIT = {
  1: ['tr', 'br'], 2: ['t', 'tr', 'm', 'bl', 'b'], 3: ['t', 'tr', 'm', 'br', 'b'],
  4: ['tl', 'tr', 'm', 'br'], 5: ['t', 'tl', 'm', 'br', 'b'], 6: ['t', 'tl', 'm', 'bl', 'br', 'b'],
  7: ['t', 'tr', 'br'], 8: ['t', 'tl', 'tr', 'm', 'bl', 'br', 'b'], 9: ['t', 'tl', 'tr', 'm', 'br', 'b'],
}
const drawDigits = (foods) => {
  const seen = new Set()
  for (const f of foods) {
    seen.add(f.id)
    if (digits.has(f.id)) continue
    // drawn just in front of the ball (screen-below, given the camera
    // tilt), or the sphere itself would hide the number
    const w = 0.16, h = 0.24
    const lines = LIT[foodV(f.size)].map((name) => world.createLine({
      points: SEGDEFS[name].map(([sx, su]) => ({ x: f.x + sx * w, y: Y + 0.02, z: f.z + 0.72 - su * h })),
      color: 0xffc45e, width: 0.045, worldUnits: true,
    }))
    digits.set(f.id, lines)
  }
  for (const [id, lines] of [...digits]) {
    if (!seen.has(id)) { for (const l of lines) l.despawn(); digits.delete(id) }
  }
}

world.onupdate = (dt, time) => {
  if (!me) return // identity arrives with onenter
  now = time
  const { segs, foods } = scan()
  drawDigits(foods)
  if (!border) {
    const e = (N / 2) * CELL + 0.1
    border = world.createLine({
      points: [{ x: -e, y: Y, z: -e }, { x: e, y: Y, z: -e }, { x: e, y: Y, z: e }, { x: -e, y: Y, z: e }, { x: -e, y: Y, z: -e }],
      color: 0x5a6673, width: 0.06, worldUnits: true,
    })
  }
  // claim each new segment once its spawn has folded (claims are checked
  // against the local sim, so a same-dispatch claim would be refused)
  pendingClaims = pendingClaims.filter((pc) => {
    const s = segs.find((x) => x.id === pc.id)
    if (!s) return now - pc.t < 3
    if (s.claimedBy === '') world.claim(pc.id)
    return false
  })
  if (state === 'boot') {
    // clear our own leftovers from a previous session (same widget id =
    // same claim), then park
    for (const s of segs) if (s.claimedBy === me.id) world.despawn(s.id)
    const occ = new Set(segs.map(cellOf))
    spawnAt(...randFree(occ))
    state = 'alive'
  } else if (state === 'alive') {
    if (dir || dirQueue.length) {
      acc += dt
      // the interval is re-read every step: eating mid-burst quickens
      // the very next step
      while (state === 'alive' && acc >= stepS(myCells.length)) {
        acc -= stepS(myCells.length)
        step(segs, foods)
      }
    } else acc = 0
  } else if (state === 'dead') {
    if (now - stateT > 0.4 && myIds.length) { for (const id of myIds) world.despawn(id); myIds = []; myCells = [] }
    if (now - stateT > 1.4) {
      const occ = new Set(segs.map(cellOf))
      for (const f of foods) occ.add(cellOf(f))
      spawnAt(...randFree(occ))
      state = 'alive'
    }
  }
  // the HUD, tetrix-style: every racer's live length, counted from the
  // shared props table (segments carry their owner's claim, so any peer
  // can score anyone); our own row adds the previous run, and the
  // all-time board from room state follows
  const lens = {}
  for (const s of segs) if (s.claimedBy !== '') lens[s.claimedBy] = (lens[s.claimedBy] ?? 0) + 1
  const board = Object.keys(lens)
    .map((id) => ({ who: id.split(':')[0], mine: id === me.id, len: lens[id] }))
    .sort((a, b) => b.len - a.len)
  const esc = (x) => String(x).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]))
  let html = '<b>snake</b><table>'
  for (const r of board) {
    const cell = (s) => (r.mine ? `<span style="color:#7fe0a0">${s}</span>` : s)
    const len = r.mine && prevScore !== null ? `${r.len} (prev ${prevScore})` : r.len
    html += `<tr><td>${cell(esc(r.who))}</td><td>${cell(len)}</td></tr>`
  }
  html += '</table>' + bestTable('snake')
  if (html !== hudLast) { hudLast = html; world.hud(html) }
  // the primary keeps the grid stocked with numbers and sweeps up snakes
  // whose player left (their script alone drove them; nobody else will).
  // world.me is read live: primacy hands over when the senior peer goes.
  if (world.me.primary && time > seedWait + 1.5) {
    if (foods.length < FOODS) {
      const occ = new Set(segs.map(cellOf))
      for (const f of foods) occ.add(cellOf(f))
      for (let k = foods.length; k < FOODS; k++) {
        const v = 1 + Math.floor(Math.random() * 9)
        const [c, r] = randFree(occ)
        occ.add(key(c, r))
        world.createSphere({ position: { x: cx(c), y: Y, z: cz(r) }, color: FOODC, radius: foodR(v), unlit: true })
      }
      seedWait = time
    }
    // ownerless segments: the player left (their claims were force-cleared
    // on departure) or a claim never landed; either way nobody will ever
    // drive them again. The grace covers the spawn-to-claim window.
    const live = new Set(world.peers().map((p) => p.id))
    for (const s of segs) {
      if (s.claimedBy !== '' && live.has(s.claimedBy)) { delete orphanSince[s.id]; continue }
      if (orphanSince[s.id] === undefined) orphanSince[s.id] = time
      else if (time - orphanSince[s.id] > 5) { world.despawn(s.id); delete orphanSince[s.id] }
    }
  }
}

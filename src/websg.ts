import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSContext, type QuickJSHandle, type QuickJSRuntime, type QuickJSWASMModule,
} from 'quickjs-emscripten-core'
import variant from '@jitl/quickjs-singlefile-browser-release-sync'

/**
 * The MSC3815 script_url runtime: a WebSG-flavoured subset of thirdroom's
 * scripting API, hosted in a QuickJS-in-WASM sandbox (quickjs-emscripten).
 *
 * Execution model: every peer runs its own script instance, uncoordinated
 * and wall-clock, exactly like thirdroom - but where thirdroom hands the
 * script raw netcode (broadcast/listen/replicators), here the script never
 * sees the network at all. The sim IS the network: scripts read the
 * deterministic sim state and every mutation leaves the sandbox as an
 * ordinary op (spawn / grab / pose / release / prop / claim / ...) on the
 * shared tick grid, so peers fold script effects exactly like human input
 * and the sandbox is never part of the rollback state. Claims are the
 * coordination primitive for sustained interactions (racing claims resolve
 * deterministically by timeline order); world.me.primary marks the senior
 * most reachable peer for single-runner logic (board init, ambient logic),
 * which restarts fresh on a handover.
 *
 * Sandboxing follows current quickjs-emscripten practice (tighter than
 * thirdroom's fixed-heap-only approach): a hard memory limit, a bounded
 * stack, and an interrupt-handler deadline per dispatch so a runaway
 * onupdate cannot stall the tick loop. The script sees only what the
 * prelude exposes; there is no ambient authority, no timers, no network.
 */

/** A prop as the script sees it; claimedBy '' means unclaimed. */
export interface PropView {
  id: string
  x: number
  y: number
  z: number
  color: number
  size: number
  kind: string
  claimedBy: string
  mine: boolean
}

/** Everything the sandboxed script can observe or do, mapped by main onto
 * sim reads and session ops. All values are primitives or JSON. */
export interface ScriptHost {
  log(line: string): void
  /** post a chat message into the Matrix room AS THIS USER (rate-limited
   * by the host; a no-op log outside widget mode). Scripts narrate their
   * own player's actions with it - chess announces each move. */
  say(text: string): void
  /** replace the HTML HUD overlay (top-left, over the 3D view). The host
   * sanitizes it (scripts, event handlers, frames stripped) and dedupes
   * identical updates; '' hides it. Local-only cosmetics: each peer's
   * script renders its own HUD from shared state. */
  hud(html: string): void
  /** dynamic boxes: id, translation, grab state ('mine' = held by us) */
  boxes(): { id: string; x: number; y: number; z: number; grabbed: boolean; mine: boolean }[]
  box(id: string): { x: number; y: number; z: number; grabbed: boolean; mine: boolean } | null
  /** world position of a named glTF scene node */
  sceneNode(name: string): { x: number; y: number; z: number } | null
  /** local TRS of a named glTF scene node */
  sceneNodeTransform(name: string): {
    t: { x: number; y: number; z: number }
    r: { x: number; y: number; z: number; w: number }
    s: { x: number; y: number; z: number }
  } | null
  /** overwrite any of a scene node's local translation/rotation/scale
   * (JSON {t?, r?, s?}). Local-only cosmetic, like lines: every peer's
   * script animates its own rendered copy, the baked trimesh collider
   * never moves, and originals are restored when the script stops. */
  setSceneNodeTransform(name: string, json: string): boolean
  /** mark a scene node pickable: pointer events then report its name as
   * ev.entity (and a hit captures the gesture away from box spawning) */
  setInteractable(name: string, on: boolean): void
  spawn(x: number, y: number, z: number, color: number | undefined): string
  grab(id: string): boolean
  moveTo(id: string, x: number, y: number, z: number): boolean
  release(id: string, vx: number, vy: number, vz: number): boolean
  /** who am I: peer id, bare Matrix user id (the peer id minus device;
   * = id outside widget mode), whether this peer is the current primary
   * (senior most reachable: single-runner logic like board init keys off
   * it), and this peer's deterministic accent color */
  me(): { id: string; user: string; primary: boolean; color: number }
  /** every connected participant (self included), in join order */
  peers(): { id: string; order: number; color: number; me: boolean }[]
  // -- Matrix room state, for persistent data like high-score tables.
  // Types are host-allowlisted, and the widget capabilities for them are
  // requested lazily on the first call (so worlds that never use room
  // state never prompt for it); content shape and any logic over it
  // belong to the script. Local cosmetic reads: nothing here folds into
  // the sim --
  /** all current state events of an allowlisted type (others log and
   * return []). Self-reported data: no witnessing keeps anyone honest. */
  getStateEvents(type: string): { type: string; stateKey: string; sender: string; ts: number
    content: unknown }[]
  /** send a state event as this user: allowlisted types only, and the
   * state key must be our own Matrix user id (core auth rules bar
   * anyone else's anyway). JSON-encoded content, rate/size-limited, and
   * dropped with a log when we lack permission to write room state */
  setStateEvent(type: string, json: string, stateKey: string): void
  // -- props: kinematic physics-free entities, claims as coordination --
  props(): PropView[]
  prop(id: string): PropView | null
  /** bounce:false = subdued board-game prop (moves ease, claims don't
   * swell); pop:false = no spawn fade-in or despawn pop, the prop
   * appears and vanishes instantly (snake segments); opacity < 1 =
   * rendered translucent (tetrix next-piece ghosts) */
  spawnProp(kind: string, x: number, y: number, z: number, color: number, size: number, unlit: boolean,
    bounce: boolean, pop: boolean, opacity: number): string
  /** an invisible fixed cuboid collider in the physics world (folded sim
   * state like any prop: boxes bounce off it identically on every peer).
   * yaw rotates about Y; w/h/d are full extents. Despawn/move as a prop. */
  spawnSolid(x: number, y: number, z: number, yaw: number, w: number, h: number, d: number): string
  despawn(id: string): boolean
  claim(id: string): boolean
  unclaim(id: string): boolean
  setPos(id: string, x: number, y: number, z: number): boolean
  paint(id: string, color: number): boolean
  // -- the shared kv table: folded game state that no prop naturally
  // carries (castling rights, round counters). Values are JSON text;
  // last write wins in timeline order; '' deletes. Replicated, hashed
  // and booted like props, so late joiners read the same table. --
  getData(key: string): string | null
  dataKeys(): string[]
  setData(key: string, json: string): boolean
  // -- cosmetics: generic line entities, animated by the script itself --
  /** create/update a cosmetic line entity's full state (fewer than 2
   * points hides it). Shared lines are additionally broadcast latest-wins
   * per (author, id) so every peer draws them; local ones never leave the
   * client. Never folded, never hashed. */
  line(id: string, pointsJson: string, color: number, opacity: number, width: number, worldUnits: boolean,
    shared: boolean): void
  /** remove a line entity (broadcast to everyone if it was shared) */
  removeLine(id: string): void
  /** create/update a cosmetic video screen: a plane at (x,y,z), yawed
   * about Y, w x h world units, showing the given peer's camera when one
   * is live. Local-only (every peer's script builds its own view); the
   * first call marks the world as video-wanting, which reveals the
   * camera toggle. */
  screen(id: string, peer: string, x: number, y: number, z: number, yaw: number, w: number, h: number): void
  removeScreen(id: string): void
  /** create/move a text label: canvas-rendered text on a plane at
   * (x,y,z), yawed about Y, h world-units tall (width follows the text).
   * flat lays it face-up in the XZ plane instead of standing upright.
   * Local-only cosmetic: every peer's script bakes its own labels. */
  label(id: string, text: string, x: number, y: number, z: number, yaw: number, h: number,
    color: number, flat: boolean): void
  removeLabel(id: string): void
  /** create/move a cosmetic grand piano: a client-modelled instrument at
   * (x,y,z), yawed about Y, scaled by size (1 = full-size ~2.2m grand),
   * case tinted by color. Local-only like screens and labels: every
   * peer's script places its own, and animates the keys itself (usually
   * from world.onmidi, which every peer hears identically). */
  piano(id: string, x: number, y: number, z: number, yaw: number, size: number, color: number): void
  /** press (velocity 1-127) or release (velocity 0) one key, MIDI note
   * numbers 21 (A0) to 108 (C8); the client animates the key pianola
   * style. Purely cosmetic, no audio. */
  pianoNote(id: string, note: number, velocity: number): void
  removePiano(id: string): void
  setEnv(json: string): void
  setCamera(x: number, y: number, z: number, tx: number, ty: number, tz: number): void
}

const MEMORY_LIMIT = 32 * 1024 * 1024
const STACK_LIMIT = 1024 * 1024
const DISPATCH_DEADLINE_MS = 20
const MAX_CONSECUTIVE_ERRORS = 3

// The in-sandbox half of the API: wraps the raw __host bridge into the
// WebSG shapes scripts expect (world.*, node.translation, WebSG consts).
// Deliberately small; unsupported WebSG surface is absent, not stubbed,
// so scripts fail loudly rather than silently doing nothing.
const PRELUDE = `
(function () {
  const H = globalThis.__host
  delete globalThis.__host
  const parse = (s) => (s === '' ? null : JSON.parse(s))
  globalThis.console = {
    log: (...a) => H.log(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')),
    warn: (...a) => globalThis.console.log('WARN', ...a),
    error: (...a) => globalThis.console.log('ERROR', ...a),
  }
  class Vector3 {
    constructor(x = 0, y = 0, z = 0) {
      if (Array.isArray(x)) { this.x = x[0] ?? 0; this.y = x[1] ?? 0; this.z = x[2] ?? 0 }
      else { this.x = x; this.y = y; this.z = z }
    }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this }
  }
  const vec = (v) => v instanceof Vector3 ? v
    : Array.isArray(v) ? new Vector3(v)
    : v && typeof v === 'object' ? new Vector3(v.x ?? 0, v.y ?? 0, v.z ?? 0)
    : new Vector3()
  class Quaternion {
    constructor(x = 0, y = 0, z = 0, w = 1) {
      if (Array.isArray(x)) { this.x = x[0] ?? 0; this.y = x[1] ?? 0; this.z = x[2] ?? 0; this.w = x[3] ?? 1 }
      else { this.x = x; this.y = y; this.z = z; this.w = w }
    }
    set(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; return this }
  }
  const quat = (q) => Array.isArray(q)
    ? new Quaternion(q[0] ?? 0, q[1] ?? 0, q[2] ?? 0, q[3] ?? 1)
    : q && typeof q === 'object' ? new Quaternion(q.x ?? 0, q.y ?? 0, q.z ?? 0, q.w ?? 1)
    : new Quaternion()
  const nodes = new Map()
  class Node {
    constructor(id, scene) { this.name = id; this._scene = !!scene }
    // Scene nodes are local cosmetics with a writable local TRS
    // (thirdroom-style: assign a whole vector, or set one component and
    // the change writes through); boxes are sim state, whose translation
    // is the read-only world position (move them via grab/moveTo).
    get translation() {
      if (this._scene) return this._live('t', ['x', 'y', 'z'])
      const s = parse(H.box(this.name))
      return s ? new Vector3(s.x, s.y, s.z) : new Vector3()
    }
    set translation(v) { this._push('t', vec(v)) }
    get rotation() { return this._scene ? this._live('r', ['x', 'y', 'z', 'w']) : new Quaternion() }
    set rotation(q) { this._push('r', quat(q)) }
    get scale() { return this._scene ? this._live('s', ['x', 'y', 'z']) : new Vector3(1, 1, 1) }
    set scale(v) { this._push('s', vec(v)) }
    /** world position (boxes: same as translation) */
    get worldTranslation() {
      const s = this._scene ? parse(H.sceneNode(this.name)) : parse(H.box(this.name))
      return s ? new Vector3(s.x, s.y, s.z) : new Vector3()
    }
    // a snapshot of the node's current local value whose component sets
    // push the whole tuple back to the host
    _live(key, fields) {
      const cur = parse(H.sceneNodeTransform(this.name))
      const store = {}
      for (const f of fields) store[f] = cur ? cur[key][f] : (key === 's' || f === 'w' ? 1 : 0)
      const out = key === 'r' ? new Quaternion() : new Vector3()
      for (const f of fields) Object.defineProperty(out, f, {
        get: () => store[f],
        set: (v) => { store[f] = v; this._push(key, store) },
        enumerable: true,
      })
      return out
    }
    _push(key, val) {
      if (!this._scene) return
      const o = { x: val.x, y: val.y, z: val.z }
      if (key === 'r') o.w = val.w
      H.setSceneNodeTransform(this.name, JSON.stringify({ [key]: o }))
    }
    get grabbed() { const s = parse(H.box(this.name)); return !!(s && s.grabbed) }
    get held() { const s = parse(H.box(this.name)); return !!(s && s.mine) }
    grab() { return this._scene ? false : H.grab(this.name) }
    moveTo(x, y, z) {
      const v = typeof x === 'number' ? new Vector3(x, y, z) : vec(x)
      return H.moveTo(this.name, v.x, v.y, v.z)
    }
    release(vel) { const v = vec(vel); return H.release(this.name, v.x, v.y, v.z) }
    addPhysicsBody() { return this }
    removePhysicsBody() { return this }
    addInteractable() { if (this._scene) H.setInteractable(this.name, true); return this }
    removeInteractable() { if (this._scene) H.setInteractable(this.name, false); return this }
  }
  const nodeFor = (id, scene) => {
    let n = nodes.get(id)
    if (!n) { n = new Node(id, scene); nodes.set(id, n) }
    return n
  }
  // Cosmetic line entity: the script owns and animates it (points, color,
  // opacity, width - screen px by default, world units with
  // worldUnits:true); every mutation ships the full state. shared:true
  // makes it visible to every peer (latest-wins broadcast); animate those
  // sparingly, since each mutation is a network message.
  let lineSeq = 0
  class Line {
    constructor(opts = {}) {
      this._id = 'l' + (++lineSeq)
      this._shared = !!opts.shared
      this._points = (opts.points ?? []).map((p) => { const v = vec(p); return { x: v.x, y: v.y, z: v.z } })
      this._color = typeof opts.color === 'number' ? opts.color : 0xffffff
      this._opacity = typeof opts.opacity === 'number' ? opts.opacity : 1
      this._width = typeof opts.width === 'number' ? opts.width : 2
      this._worldUnits = !!opts.worldUnits
      this._dead = false
      this._sync()
    }
    _sync() {
      if (this._dead) return
      H.line(this._id, JSON.stringify(this._points), this._color, this._opacity, this._width,
        this._worldUnits, this._shared)
    }
    get points() { return this._points.map((p) => new Vector3(p.x, p.y, p.z)) }
    set points(ps) {
      this._points = (ps ?? []).map((p) => { const v = vec(p); return { x: v.x, y: v.y, z: v.z } })
      this._sync()
    }
    get color() { return this._color }
    set color(c) { this._color = c; this._sync() }
    get opacity() { return this._opacity }
    set opacity(o) { this._opacity = o; this._sync() }
    get width() { return this._width }
    set width(w) { this._width = w; this._sync() }
    despawn() { if (!this._dead) { this._dead = true; H.removeLine(this._id) } }
  }
  // Cosmetic video screen: a plane showing a peer's camera stream (dark
  // placeholder until they unmute). Local-only: every peer's script
  // instance lays out its own view. Creating one asks the host for video,
  // which reveals the on-canvas camera toggle.
  // Cosmetic text label: canvas-rendered text on a plane, local-only
  // (every peer's script bakes its own; tetrix captions each lane).
  let labelSeq = 0
  class Label {
    constructor(opts = {}) {
      this._id = 't' + (++labelSeq)
      this._text = String(opts.text ?? '')
      const p = vec(opts.position)
      this._pos = { x: p.x, y: p.y, z: p.z }
      this._yaw = typeof opts.yaw === 'number' ? opts.yaw : 0
      this._h = typeof opts.height === 'number' ? opts.height : 0.4
      this._color = typeof opts.color === 'number' ? opts.color : 0xffffff
      this._flat = opts.flat === true
      this._dead = false
      this._sync()
    }
    _sync() {
      if (this._dead) return
      H.label(this._id, this._text, this._pos.x, this._pos.y, this._pos.z, this._yaw, this._h, this._color, this._flat)
    }
    get text() { return this._text }
    set text(t) { this._text = String(t); this._sync() }
    get position() { return new Vector3(this._pos.x, this._pos.y, this._pos.z) }
    set position(p) { const v = vec(p); this._pos = { x: v.x, y: v.y, z: v.z }; this._sync() }
    get yaw() { return this._yaw }
    set yaw(y) { this._yaw = y; this._sync() }
    get height() { return this._h }
    set height(h) { this._h = h; this._sync() }
    get color() { return this._color }
    set color(c) { this._color = c; this._sync() }
    get flat() { return this._flat }
    set flat(f) { this._flat = f === true; this._sync() }
    despawn() { if (!this._dead) { this._dead = true; H.removeLabel(this._id) } }
  }
  let screenSeq = 0
  class Screen {
    constructor(opts = {}) {
      this._id = 'v' + (++screenSeq)
      this._peer = String(opts.peer ?? '')
      const p = vec(opts.position)
      this._pos = { x: p.x, y: p.y, z: p.z }
      this._yaw = typeof opts.yaw === 'number' ? opts.yaw : 0
      this._w = typeof opts.width === 'number' ? opts.width : 1.6
      this._h = typeof opts.height === 'number' ? opts.height : 0.9
      this._dead = false
      this._sync()
    }
    _sync() {
      if (this._dead) return
      H.screen(this._id, this._peer, this._pos.x, this._pos.y, this._pos.z, this._yaw, this._w, this._h)
    }
    get peer() { return this._peer }
    set peer(id) { this._peer = String(id); this._sync() }
    get position() { return new Vector3(this._pos.x, this._pos.y, this._pos.z) }
    set position(p) { const v = vec(p); this._pos = { x: v.x, y: v.y, z: v.z }; this._sync() }
    get yaw() { return this._yaw }
    set yaw(y) { this._yaw = y; this._sync() }
    get width() { return this._w }
    set width(w) { this._w = w; this._sync() }
    get height() { return this._h }
    set height(h) { this._h = h; this._sync() }
    despawn() { if (!this._dead) { this._dead = true; H.removeScreen(this._id) } }
  }
  // Cosmetic grand piano: client-modelled instrument, local-only like
  // screens (every peer's script places its own and drives the keys,
  // usually from world.onmidi so all views animate identically).
  let pianoSeq = 0
  class GrandPiano {
    constructor(opts = {}) {
      this._id = 'gp' + (++pianoSeq)
      const p = vec(opts.position)
      this._pos = { x: p.x, y: p.y, z: p.z }
      this._yaw = typeof opts.yaw === 'number' ? opts.yaw : 0
      this._size = typeof opts.size === 'number' ? opts.size : 1
      this._color = typeof opts.color === 'number' ? opts.color : 0x080808
      this._dead = false
      this._sync()
    }
    _sync() {
      if (this._dead) return
      H.piano(this._id, this._pos.x, this._pos.y, this._pos.z, this._yaw, this._size, this._color)
    }
    get position() { return new Vector3(this._pos.x, this._pos.y, this._pos.z) }
    set position(p) { const v = vec(p); this._pos = { x: v.x, y: v.y, z: v.z }; this._sync() }
    get yaw() { return this._yaw }
    set yaw(y) { this._yaw = y; this._sync() }
    get size() { return this._size }
    set size(s) { this._size = s; this._sync() }
    get color() { return this._color }
    set color(c) { this._color = c; this._sync() }
    /** press a key (MIDI note 21-108); velocity 1-127 shades the dip */
    noteOn(note, velocity) {
      if (this._dead) return
      const v = typeof velocity === 'number' ? Math.min(127, Math.max(1, velocity)) : 100
      H.pianoNote(this._id, note | 0, v)
    }
    /** release a key */
    noteOff(note) { if (!this._dead) H.pianoNote(this._id, note | 0, 0) }
    despawn() { if (!this._dead) { this._dead = true; H.removePiano(this._id) } }
  }
  globalThis.WebSG = {
    Vector3,
    Quaternion,
    PhysicsBodyType: { Rigid: 'rigid', Static: 'static', Kinematic: 'kinematic' },
    InteractableType: { Interactable: 1, Grabbable: 2 },
    // ray/plane intersection (plane through 'point' with normal 'normal');
    // null when parallel or behind the origin. Scripts use it for drag
    // previews: the dots chain endpoint lives on the camera-facing plane
    // through the last selected dot (normal = the pointer ray direction).
    rayPlane(origin, dir, point, normal) {
      const o = vec(origin), d = vec(dir), p = vec(point), n = vec(normal)
      const denom = d.x * n.x + d.y * n.y + d.z * n.z
      if (Math.abs(denom) < 1e-9) return null
      const t = ((p.x - o.x) * n.x + (p.y - o.y) * n.y + (p.z - o.z) * n.z) / denom
      if (t < 0) return null
      return new Vector3(o.x + d.x * t, o.y + d.y * t, o.z + d.z * t)
    },
  }
  globalThis.world = {
    onload: null, onenter: null, onupdate: null,
    onpointerdown: null, onpointermove: null, onpointerup: null,
    onkeydown: null, onmidi: null,
    get me() { return parse(H.me()) },
    // chat into the Matrix room as this user (host rate-limits it)
    say(text) { H.say(typeof text === 'string' ? text : JSON.stringify(text)) },
    // HTML HUD overlay (sanitized by the host; '' hides it)
    hud(html) { H.hud(String(html ?? '')) },
    props() { return parse(H.props()) },
    prop(id) { return parse(H.prop(id)) },
    createSphere(props = {}) {
      const t = vec(props.position ?? props.translation)
      return H.spawnProp('sphere', t.x, t.y, t.z,
        typeof props.color === 'number' ? props.color : 0xffffff,
        typeof props.radius === 'number' ? props.radius : 0.5,
        !!props.unlit, props.bounce !== false, props.pop !== false,
        typeof props.opacity === 'number' ? props.opacity : 1)
    },
    // any prop kind by name: 'sphere', 'box', or a modelled kind the
    // client renders as built-in geometry - the low-poly chess set
    // 'pawn'|'rook'|'knight'|'bishop'|'queen'|'king', whose size is the
    // piece's height and whose base rests at the prop position. Unknown
    // kinds render as spheres.
    createProp(props = {}) {
      const t = vec(props.position ?? props.translation)
      return H.spawnProp(String(props.kind ?? 'sphere'), t.x, t.y, t.z,
        typeof props.color === 'number' ? props.color : 0xffffff,
        typeof props.size === 'number' ? props.size : 0.5,
        !!props.unlit, props.bounce !== false, props.pop !== false,
        typeof props.opacity === 'number' ? props.opacity : 1)
    },
    // a kinematic cube prop (rendered as a 2*size cube), same lifecycle as
    // spheres: move/paint/claim/despawn; no physics
    createBox(props = {}) {
      const t = vec(props.position ?? props.translation)
      return H.spawnProp('box', t.x, t.y, t.z,
        typeof props.color === 'number' ? props.color : 0xffffff,
        typeof props.size === 'number' ? props.size : 0.5,
        !!props.unlit, props.bounce !== false, props.pop !== false,
        typeof props.opacity === 'number' ? props.opacity : 1)
    },
    despawn(id) { return H.despawn(id) },
    claim(id) { return H.claim(id) },
    unclaim(id) { return H.unclaim(id) },
    move(id, x, y, z) {
      const v = typeof x === 'number' ? new Vector3(x, y, z) : vec(x)
      return H.setPos(id, v.x, v.y, v.z)
    },
    paint(id, color) { return H.paint(id, color) },
    // the shared kv table: synced game state that no prop naturally
    // carries (chess castling rights, round counters). Values survive a
    // JSON round-trip; last write wins in timeline order; deleting and
    // late-join boot both replicate. Reads are local and instant, but a
    // write is visible only once its op folds (typically next update).
    getData(key) {
      const v = H.getData(String(key))
      return v === '' ? undefined : JSON.parse(v)
    },
    setData(key, value) {
      return H.setData(String(key), value === undefined ? '' : JSON.stringify(value))
    },
    deleteData(key) { return H.setData(String(key), '') },
    dataKeys() { return JSON.parse(H.dataKeys()) },
    createLine(props) { return new Line(props) },
    createScreen(props) { return new Screen(props) },
    createLabel(props) { return new Label(props) },
    createGrandPiano(props) { return new GrandPiano(props) },
    // a solid invisible cuboid collider: sim state, so despawn/move it via
    // world.despawn(id) / world.move(id, pos) like any prop
    createSolid(props = {}) {
      const t = vec(props.position)
      const d = props.dims ?? {}
      return H.spawnSolid(t.x, t.y, t.z, typeof props.yaw === 'number' ? props.yaw : 0,
        d.x ?? 1, d.y ?? 1, d.z ?? 0.1)
    },
    peers() { return parse(H.peers()) },
    // Matrix room state (host-allowlisted event types): read any state
    // key, write only under our own user id; the content shape (and any
    // logic over it, like top-10 capping) is the script's business
    getStateEvents(type, stateKey) {
      const evs = parse(H.getStateEvents(String(type)))
      if (stateKey === undefined) return evs
      return evs.find((e) => e.stateKey === String(stateKey)) ?? null
    },
    setStateEvent(type, content, stateKey) {
      H.setStateEvent(String(type), JSON.stringify(content ?? {}),
        stateKey === undefined ? globalThis.world.me.user : String(stateKey))
    },
    env(opts) { H.setEnv(JSON.stringify(opts ?? {})) },
    camera(pos, target) {
      const p = vec(pos), t = vec(target)
      H.setCamera(p.x, p.y, p.z, t.x, t.y, t.z)
    },
    createBoxMesh: (p) => ({ __mesh: p }),
    createCollider: (p) => ({ __collider: p }),
    createMaterial: (p) => ({ __material: p }),
    createNode(props = {}) {
      const t = vec(props.translation)
      return nodeFor(H.spawn(t.x, t.y, t.z, typeof props.color === 'number' ? props.color : -1), false)
    },
    findNodeByName(name) {
      if (nodes.has(name)) return nodes.get(name)
      if (parse(H.box(name))) return nodeFor(name, false)
      if (parse(H.sceneNode(name))) return nodeFor(name, true)
      return undefined
    },
    boxes() { return parse(H.boxes()).map((b) => nodeFor(b.id, false)) },
    get environment() {
      return { addNode: () => {}, findNodeByName: (n) => globalThis.world.findNodeByName(n) }
    },
  }
  globalThis.__dispatch = (name, a, b) => {
    const h = globalThis.world[name]
    if (typeof h !== 'function') return
    // string payloads are JSON events (pointer events); numbers are (dt, time)
    if (typeof a === 'string') h(JSON.parse(a))
    else h(a, b)
  }
})()
`

let modulePromise: Promise<QuickJSWASMModule> | null = null
const getModule = () => (modulePromise ??= newQuickJSWASMModuleFromVariant(variant))

export class WorldScript {
  /** true once the script has been disabled after repeated errors */
  dead = false
  private errors = 0
  private deadline = Infinity
  private disposed = false

  private constructor(
    private rt: QuickJSRuntime,
    private ctx: QuickJSContext,
    private dispatchFn: QuickJSHandle,
    private host: ScriptHost,
  ) {}

  static async create(source: string, host: ScriptHost): Promise<WorldScript> {
    const mod = await getModule()
    const rt = mod.newRuntime()
    rt.setMemoryLimit(MEMORY_LIMIT)
    rt.setMaxStackSize(STACK_LIMIT)
    const ctx = rt.newContext()
    const script = new WorldScript(rt, ctx, null as unknown as QuickJSHandle, host)
    rt.setInterruptHandler(() => performance.now() > script.deadline)
    script.installHost()
    script.mustEval(PRELUDE, 'prelude.js')
    script.dispatchFn = ctx.getProp(ctx.global, '__dispatch')
    script.mustEval(source, 'world-script.js')
    script.dispatch('onload')
    return script
  }

  /** the user just "entered the world": we became root with this script */
  enter() { this.dispatch('onenter') }

  /** drive world.onupdate; dt/time in seconds, derived from sim ticks */
  update(dt: number, time: number) { this.dispatch('onupdate', dt, time) }

  /** deliver a pointer event ('onpointerdown'|'onpointermove'|'onpointerup');
   * the payload crosses as JSON and arrives parsed in the handler */
  pointer(name: string, ev: unknown) { this.dispatch(name, JSON.stringify(ev)) }

  /** deliver a key press to world.onkeydown (same JSON path as pointer) */
  key(ev: unknown) { this.dispatch('onkeydown', JSON.stringify(ev)) }

  /** deliver a MIDI event to world.onmidi (same JSON path as pointer) */
  midi(ev: unknown) { this.dispatch('onmidi', JSON.stringify(ev)) }

  /** does the script define this handler? (pointer capture asks first) */
  handles(name: string): boolean {
    const world = this.ctx.getProp(this.ctx.global, 'world')
    const h = this.ctx.getProp(world, name)
    const isFn = this.ctx.typeof(h) === 'function'
    h.dispose()
    world.dispose()
    return isFn
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.dispatchFn?.dispose()
    this.ctx.dispose()
    this.rt.dispose()
  }

  // Bridge functions live on __host; the prelude consumes and deletes it.
  // Everything crosses as primitives or JSON strings ('' = null), keeping
  // handle lifetimes trivial.
  private installHost() {
    const { ctx, host } = this
    const bridge = ctx.newObject()
    const fn = (name: string, impl: (...args: QuickJSHandle[]) => QuickJSHandle) => {
      const f = ctx.newFunction(name, impl)
      ctx.setProp(bridge, name, f)
      f.dispose()
    }
    const json = (v: unknown) => ctx.newString(v === null ? '' : JSON.stringify(v))
    const bool = (v: boolean) => (v ? ctx.true : ctx.false)
    fn('log', (s) => { host.log(ctx.getString(s)); return ctx.undefined })
    fn('say', (s) => { host.say(ctx.getString(s)); return ctx.undefined })
    fn('hud', (s) => { host.hud(ctx.getString(s)); return ctx.undefined })
    fn('boxes', () => json(host.boxes()))
    fn('box', (id) => json(host.box(ctx.getString(id))))
    fn('sceneNode', (n) => json(host.sceneNode(ctx.getString(n))))
    fn('sceneNodeTransform', (n) => json(host.sceneNodeTransform(ctx.getString(n))))
    fn('setSceneNodeTransform', (n, j) =>
      bool(host.setSceneNodeTransform(ctx.getString(n), ctx.getString(j))))
    fn('setInteractable', (n, on) => {
      host.setInteractable(ctx.getString(n), ctx.dump(on) === true)
      return ctx.undefined
    })
    fn('spawn', (x, y, z, c) => {
      const color = ctx.getNumber(c)
      return ctx.newString(host.spawn(ctx.getNumber(x), ctx.getNumber(y), ctx.getNumber(z),
        color < 0 ? undefined : color))
    })
    fn('grab', (id) => bool(host.grab(ctx.getString(id))))
    fn('moveTo', (id, x, y, z) =>
      bool(host.moveTo(ctx.getString(id), ctx.getNumber(x), ctx.getNumber(y), ctx.getNumber(z))))
    fn('release', (id, x, y, z) =>
      bool(host.release(ctx.getString(id), ctx.getNumber(x), ctx.getNumber(y), ctx.getNumber(z))))
    fn('me', () => json(host.me()))
    fn('props', () => json(host.props()))
    fn('prop', (id) => json(host.prop(ctx.getString(id))))
    fn('spawnProp', (kind, x, y, z, c, size, unlit, bounce, pop, opacity) =>
      ctx.newString(host.spawnProp(ctx.getString(kind), ctx.getNumber(x), ctx.getNumber(y), ctx.getNumber(z),
        ctx.getNumber(c), ctx.getNumber(size), ctx.dump(unlit) === true, ctx.dump(bounce) !== false,
        ctx.dump(pop) !== false, ctx.getNumber(opacity))))
    fn('spawnSolid', (x, y, z, yaw, w, h, d) =>
      ctx.newString(host.spawnSolid(ctx.getNumber(x), ctx.getNumber(y), ctx.getNumber(z),
        ctx.getNumber(yaw), ctx.getNumber(w), ctx.getNumber(h), ctx.getNumber(d))))
    fn('despawn', (id) => bool(host.despawn(ctx.getString(id))))
    fn('claim', (id) => bool(host.claim(ctx.getString(id))))
    fn('unclaim', (id) => bool(host.unclaim(ctx.getString(id))))
    fn('setPos', (id, x, y, z) =>
      bool(host.setPos(ctx.getString(id), ctx.getNumber(x), ctx.getNumber(y), ctx.getNumber(z))))
    fn('paint', (id, c) => bool(host.paint(ctx.getString(id), ctx.getNumber(c))))
    fn('getData', (k) => {
      const v = host.getData(ctx.getString(k))
      return ctx.newString(v ?? '')
    })
    fn('dataKeys', () => ctx.newString(JSON.stringify(host.dataKeys())))
    fn('setData', (k, j) => bool(host.setData(ctx.getString(k), ctx.getString(j))))
    fn('line', (id, pts, c, op, w, wu, shared) => {
      host.line(ctx.getString(id), ctx.getString(pts), ctx.getNumber(c), ctx.getNumber(op),
        ctx.getNumber(w), ctx.dump(wu) === true, ctx.dump(shared) === true)
      return ctx.undefined
    })
    fn('removeLine', (id) => { host.removeLine(ctx.getString(id)); return ctx.undefined })
    fn('peers', () => json(host.peers()))
    fn('getStateEvents', (t) => json(host.getStateEvents(ctx.getString(t))))
    fn('setStateEvent', (t, j, k) => {
      host.setStateEvent(ctx.getString(t), ctx.getString(j), ctx.getString(k))
      return ctx.undefined
    })
    fn('screen', (id, peer, x, y, z, yaw, w, h) => {
      host.screen(ctx.getString(id), ctx.getString(peer), ctx.getNumber(x), ctx.getNumber(y),
        ctx.getNumber(z), ctx.getNumber(yaw), ctx.getNumber(w), ctx.getNumber(h))
      return ctx.undefined
    })
    fn('removeScreen', (id) => { host.removeScreen(ctx.getString(id)); return ctx.undefined })
    fn('label', (id, text, x, y, z, yaw, h, c, flat) => {
      host.label(ctx.getString(id), ctx.getString(text), ctx.getNumber(x), ctx.getNumber(y),
        ctx.getNumber(z), ctx.getNumber(yaw), ctx.getNumber(h), ctx.getNumber(c), ctx.dump(flat) === true)
      return ctx.undefined
    })
    fn('removeLabel', (id) => { host.removeLabel(ctx.getString(id)); return ctx.undefined })
    fn('piano', (id, x, y, z, yaw, size, c) => {
      host.piano(ctx.getString(id), ctx.getNumber(x), ctx.getNumber(y), ctx.getNumber(z),
        ctx.getNumber(yaw), ctx.getNumber(size), ctx.getNumber(c))
      return ctx.undefined
    })
    fn('pianoNote', (id, note, vel) => {
      host.pianoNote(ctx.getString(id), ctx.getNumber(note), ctx.getNumber(vel))
      return ctx.undefined
    })
    fn('removePiano', (id) => { host.removePiano(ctx.getString(id)); return ctx.undefined })
    fn('setEnv', (j) => { host.setEnv(ctx.getString(j)); return ctx.undefined })
    fn('setCamera', (x, y, z, tx, ty, tz) => {
      host.setCamera(ctx.getNumber(x), ctx.getNumber(y), ctx.getNumber(z),
        ctx.getNumber(tx), ctx.getNumber(ty), ctx.getNumber(tz))
      return ctx.undefined
    })
    ctx.setProp(ctx.global, '__host', bridge)
    bridge.dispose()
  }

  /** eval that throws (create-time: a broken script must fail loudly) */
  private mustEval(code: string, filename: string) {
    this.deadline = performance.now() + DISPATCH_DEADLINE_MS * 10
    const r = this.ctx.evalCode(code, filename)
    this.deadline = Infinity
    if (r.error) {
      const detail = this.ctx.dump(r.error)
      r.error.dispose()
      throw new Error(`script error in ${filename}: ${JSON.stringify(detail)}`)
    }
    r.value.dispose()
  }

  private dispatch(name: string, a?: number | string, b?: number) {
    if (this.dead || this.disposed) return
    const { ctx } = this
    const args = [
      ctx.newString(name),
      typeof a === 'string' ? ctx.newString(a) : ctx.newNumber(a ?? 0),
      ctx.newNumber(b ?? 0),
    ]
    this.deadline = performance.now() + DISPATCH_DEADLINE_MS
    const r = ctx.callFunction(this.dispatchFn, ctx.undefined, ...args)
    this.deadline = Infinity
    for (const h of args) h.dispose()
    if (r.error) {
      const detail = this.ctx.dump(r.error)
      r.error.dispose()
      this.host.log(`script ${name} error: ${JSON.stringify(detail)}`)
      if (++this.errors >= MAX_CONSECUTIVE_ERRORS) this.dead = true
    } else {
      r.value.dispose()
      this.errors = 0
    }
  }
}

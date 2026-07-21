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
  /** dynamic boxes: id, translation, grab state ('mine' = held by us) */
  boxes(): { id: string; x: number; y: number; z: number; grabbed: boolean; mine: boolean }[]
  box(id: string): { x: number; y: number; z: number; grabbed: boolean; mine: boolean } | null
  /** world position of a named glTF scene node (read-only, static) */
  sceneNode(name: string): { x: number; y: number; z: number } | null
  spawn(x: number, y: number, z: number, color: number | undefined): string
  grab(id: string): boolean
  moveTo(id: string, x: number, y: number, z: number): boolean
  release(id: string, vx: number, vy: number, vz: number): boolean
  /** who am I: peer id, whether this peer is the current primary (senior
   * most reachable: single-runner logic like board init keys off it), and
   * this peer's deterministic accent color */
  me(): { id: string; primary: boolean; color: number }
  // -- props: kinematic physics-free entities, claims as coordination --
  props(): PropView[]
  prop(id: string): PropView | null
  spawnProp(kind: string, x: number, y: number, z: number, color: number, size: number, unlit: boolean): string
  despawn(id: string): boolean
  claim(id: string): boolean
  unclaim(id: string): boolean
  setPos(id: string, x: number, y: number, z: number): boolean
  paint(id: string, color: number): boolean
  // -- cosmetics: local rendering plus the ephemeral chain-line channel --
  /** broadcast + draw this peer's chain line; empty points clear it.
   * color < 0 means "my accent color". */
  chainLine(pointsJson: string, color: number): void
  /** local persistent guide lines keyed for replace/fade; '' segs remove */
  decorLines(key: string, segsJson: string, color: number, opacity: number): void
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
  const nodes = new Map()
  class Node {
    constructor(id, scene) { this.name = id; this._scene = !!scene }
    get translation() {
      const s = this._scene ? parse(H.sceneNode(this.name)) : parse(H.box(this.name))
      return s ? new Vector3(s.x, s.y, s.z) : new Vector3()
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
    addInteractable() { return this }
    removeInteractable() { return this }
  }
  const nodeFor = (id, scene) => {
    let n = nodes.get(id)
    if (!n) { n = new Node(id, scene); nodes.set(id, n) }
    return n
  }
  globalThis.WebSG = {
    Vector3,
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
    get me() { return parse(H.me()) },
    props() { return parse(H.props()) },
    prop(id) { return parse(H.prop(id)) },
    createSphere(props = {}) {
      const t = vec(props.position ?? props.translation)
      return H.spawnProp('sphere', t.x, t.y, t.z,
        typeof props.color === 'number' ? props.color : 0xffffff,
        typeof props.radius === 'number' ? props.radius : 0.5,
        !!props.unlit)
    },
    despawn(id) { return H.despawn(id) },
    claim(id) { return H.claim(id) },
    unclaim(id) { return H.unclaim(id) },
    move(id, x, y, z) {
      const v = typeof x === 'number' ? new Vector3(x, y, z) : vec(x)
      return H.setPos(id, v.x, v.y, v.z)
    },
    paint(id, color) { return H.paint(id, color) },
    chainLine(points, color) {
      if (!points || points.length === 0) { H.chainLine('', -1); return }
      H.chainLine(JSON.stringify(points.map((p) => { const v = vec(p); return { x: v.x, y: v.y, z: v.z } })),
        typeof color === 'number' ? color : -1)
    },
    decorLines(key, segments, color, opacity) {
      if (!segments) { H.decorLines(key, '', 0, 0); return }
      H.decorLines(key, JSON.stringify(segments.map((s) => {
        const a = vec(s[0]), b = vec(s[1])
        return [{ x: a.x, y: a.y, z: a.z }, { x: b.x, y: b.y, z: b.z }]
      })), color ?? 0xffffff, opacity ?? 1)
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
    fn('boxes', () => json(host.boxes()))
    fn('box', (id) => json(host.box(ctx.getString(id))))
    fn('sceneNode', (n) => json(host.sceneNode(ctx.getString(n))))
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
    fn('spawnProp', (kind, x, y, z, c, size, unlit) =>
      ctx.newString(host.spawnProp(ctx.getString(kind), ctx.getNumber(x), ctx.getNumber(y), ctx.getNumber(z),
        ctx.getNumber(c), ctx.getNumber(size), ctx.dump(unlit) === true)))
    fn('despawn', (id) => bool(host.despawn(ctx.getString(id))))
    fn('claim', (id) => bool(host.claim(ctx.getString(id))))
    fn('unclaim', (id) => bool(host.unclaim(ctx.getString(id))))
    fn('setPos', (id, x, y, z) =>
      bool(host.setPos(ctx.getString(id), ctx.getNumber(x), ctx.getNumber(y), ctx.getNumber(z))))
    fn('paint', (id, c) => bool(host.paint(ctx.getString(id), ctx.getNumber(c))))
    fn('chainLine', (pts, c) => { host.chainLine(ctx.getString(pts), ctx.getNumber(c)); return ctx.undefined })
    fn('decorLines', (key, segs, c, op) => {
      host.decorLines(ctx.getString(key), ctx.getString(segs), ctx.getNumber(c), ctx.getNumber(op))
      return ctx.undefined
    })
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

var w=Object.defineProperty;var _=(o,e,r)=>e in o?w(o,e,{enumerable:!0,configurable:!0,writable:!0,value:r}):o[e]=r;var h=(o,e,r)=>_(o,typeof e!="symbol"?e+"":e,r);import{_ as y}from"./main-BOVA6MYB.js";import"./index-Di7J148-.js";async function v(o){let e=g(await o),[r,i,{QuickJSWASMModule:s}]=await Promise.all([e.importModuleLoader().then(g),e.importFFI(),y(()=>import("./module-ES6BEMUI-CfPOE6xG.js"),[],import.meta.url).then(g)]),a=await r();a.type="sync";let n=new i(a);return new s(a,n)}function g(o){return o&&"default"in o&&o.default?o.default&&"default"in o.default&&o.default.default?o.default.default:o.default:o}var x={type:"sync",importFFI:()=>y(()=>import("./ffi-Boa1QuFa.js"),[],import.meta.url).then(o=>o.QuickJSFFI),importModuleLoader:()=>y(()=>import("./emscripten-module.browser-XIKQQPVU-Cv9W9P6I.js"),[],import.meta.url).then(o=>o.default)},N=x;const S=32*1024*1024,z=1024*1024,f=20,H=3,T=`
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
    createLine(props) { return new Line(props) },
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
`;let M=null;const P=()=>M??(M=v(N));class b{constructor(e,r,i,s){h(this,"dead",!1);h(this,"errors",0);h(this,"deadline",1/0);h(this,"disposed",!1);this.rt=e,this.ctx=r,this.dispatchFn=i,this.host=s}static async create(e,r){const s=(await P()).newRuntime();s.setMemoryLimit(S),s.setMaxStackSize(z);const a=s.newContext(),n=new b(s,a,null,r);return s.setInterruptHandler(()=>performance.now()>n.deadline),n.installHost(),n.mustEval(T,"prelude.js"),n.dispatchFn=a.getProp(a.global,"__dispatch"),n.mustEval(e,"world-script.js"),n.dispatch("onload"),n}enter(){this.dispatch("onenter")}update(e,r){this.dispatch("onupdate",e,r)}pointer(e,r){this.dispatch(e,JSON.stringify(r))}handles(e){const r=this.ctx.getProp(this.ctx.global,"world"),i=this.ctx.getProp(r,e),s=this.ctx.typeof(i)==="function";return i.dispose(),r.dispose(),s}dispose(){var e;this.disposed||(this.disposed=!0,(e=this.dispatchFn)==null||e.dispose(),this.ctx.dispose(),this.rt.dispose())}installHost(){const{ctx:e,host:r}=this,i=e.newObject(),s=(t,p)=>{const d=e.newFunction(t,p);e.setProp(i,t,d),d.dispose()},a=t=>e.newString(t===null?"":JSON.stringify(t)),n=t=>t?e.true:e.false;s("log",t=>(r.log(e.getString(t)),e.undefined)),s("boxes",()=>a(r.boxes())),s("box",t=>a(r.box(e.getString(t)))),s("sceneNode",t=>a(r.sceneNode(e.getString(t)))),s("spawn",(t,p,d,c)=>{const l=e.getNumber(c);return e.newString(r.spawn(e.getNumber(t),e.getNumber(p),e.getNumber(d),l<0?void 0:l))}),s("grab",t=>n(r.grab(e.getString(t)))),s("moveTo",(t,p,d,c)=>n(r.moveTo(e.getString(t),e.getNumber(p),e.getNumber(d),e.getNumber(c)))),s("release",(t,p,d,c)=>n(r.release(e.getString(t),e.getNumber(p),e.getNumber(d),e.getNumber(c)))),s("me",()=>a(r.me())),s("props",()=>a(r.props())),s("prop",t=>a(r.prop(e.getString(t)))),s("spawnProp",(t,p,d,c,l,u,m)=>e.newString(r.spawnProp(e.getString(t),e.getNumber(p),e.getNumber(d),e.getNumber(c),e.getNumber(l),e.getNumber(u),e.dump(m)===!0))),s("despawn",t=>n(r.despawn(e.getString(t)))),s("claim",t=>n(r.claim(e.getString(t)))),s("unclaim",t=>n(r.unclaim(e.getString(t)))),s("setPos",(t,p,d,c)=>n(r.setPos(e.getString(t),e.getNumber(p),e.getNumber(d),e.getNumber(c)))),s("paint",(t,p)=>n(r.paint(e.getString(t),e.getNumber(p)))),s("line",(t,p,d,c,l,u,m)=>(r.line(e.getString(t),e.getString(p),e.getNumber(d),e.getNumber(c),e.getNumber(l),e.dump(u)===!0,e.dump(m)===!0),e.undefined)),s("removeLine",t=>(r.removeLine(e.getString(t)),e.undefined)),s("setEnv",t=>(r.setEnv(e.getString(t)),e.undefined)),s("setCamera",(t,p,d,c,l,u)=>(r.setCamera(e.getNumber(t),e.getNumber(p),e.getNumber(d),e.getNumber(c),e.getNumber(l),e.getNumber(u)),e.undefined)),e.setProp(e.global,"__host",i),i.dispose()}mustEval(e,r){this.deadline=performance.now()+f*10;const i=this.ctx.evalCode(e,r);if(this.deadline=1/0,i.error){const s=this.ctx.dump(i.error);throw i.error.dispose(),new Error(`script error in ${r}: ${JSON.stringify(s)}`)}i.value.dispose()}dispatch(e,r,i){if(this.dead||this.disposed)return;const{ctx:s}=this,a=[s.newString(e),typeof r=="string"?s.newString(r):s.newNumber(r??0),s.newNumber(i??0)];this.deadline=performance.now()+f;const n=s.callFunction(this.dispatchFn,s.undefined,...a);this.deadline=1/0;for(const t of a)t.dispose();if(n.error){const t=this.ctx.dump(n.error);n.error.dispose(),this.host.log(`script ${e} error: ${JSON.stringify(t)}`),++this.errors>=H&&(this.dead=!0)}else n.value.dispose(),this.errors=0}}export{b as WorldScript};

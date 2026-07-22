/**
 * The script editor's view of the sandbox: a .d.ts covering exactly what
 * the QuickJS prelude in websg.ts exposes (world.*, WebSG.*, console).
 * Fed to monaco as an extra lib so world scripts get completions and
 * checkJs diagnostics against the real API surface. Kept by hand, in
 * step with the PRELUDE - unsupported WebSG surface is absent here too,
 * so the editor squiggles what the sandbox would throw on.
 */
export const WEBSG_DTS = `
type Vec3Like = WebSG.Vector3 | { x?: number; y?: number; z?: number } | number[]

declare namespace WebSG {
  /** Plain mutable 3-vector; every API position accepts one (or an
   * {x,y,z} object, or an [x,y,z] array). */
  class Vector3 {
    x: number
    y: number
    z: number
    constructor(x?: number | number[], y?: number, z?: number)
    set(x: number, y: number, z: number): this
  }
  const PhysicsBodyType: { Rigid: 'rigid'; Static: 'static'; Kinematic: 'kinematic' }
  const InteractableType: { Interactable: 1; Grabbable: 2 }
  /** Ray/plane intersection (plane through 'point' with normal 'normal');
   * null when parallel or behind the origin. Handy for drag previews. */
  function rayPlane(origin: Vec3Like, dir: Vec3Like, point: Vec3Like, normal: Vec3Like): Vector3 | null
}

/** A dynamic box (world.createNode / world.boxes) or a named glTF scene
 * node (world.findNodeByName); scene nodes are read-only and never grab. */
interface WorldNode {
  name: string
  /** current world position (scene nodes: static; boxes: live sim state) */
  readonly translation: WebSG.Vector3
  /** held by anyone? */
  readonly grabbed: boolean
  /** held by us? */
  readonly held: boolean
  grab(): boolean
  moveTo(x: number | Vec3Like, y?: number, z?: number): boolean
  release(vel?: Vec3Like): boolean
  addPhysicsBody(): this
  removePhysicsBody(): this
  addInteractable(): this
  removeInteractable(): this
}

/** A prop as the script sees it; claimedBy '' means unclaimed. */
interface WorldProp {
  id: string
  x: number
  y: number
  z: number
  color: number
  size: number
  kind: string
  claimedBy: string
  /** claimed by us? */
  mine: boolean
}

/** Cosmetic line entity: the script owns and animates it (fewer than 2
 * points hides it). Shared lines broadcast latest-wins per (author, id);
 * animate those sparingly, each mutation is a network message. */
interface WorldLine {
  points: WebSG.Vector3[]
  color: number
  opacity: number
  /** screen px by default, world units with worldUnits:true at creation */
  width: number
  despawn(): void
}

/** Cosmetic video screen: a plane showing a peer's camera stream (dark
 * placeholder until they share). Local-only; creating one reveals the
 * camera toggle. */
interface WorldScreen {
  peer: string
  position: WebSG.Vector3
  yaw: number
  width: number
  height: number
  despawn(): void
}

/** Pointer events arrive pre-raycast against the prop layer: 'entity' and
 * 'point' when a prop was hit, plus the raw ray for your own plane math. */
interface WorldPointerEvent {
  entity: string | null
  point: { x: number; y: number; z: number } | null
  origin: { x: number; y: number; z: number }
  dir: { x: number; y: number; z: number }
}

declare const world: {
  /** runs once, right after the script evaluates */
  onload: (() => void) | null
  /** runs when this peer's session is up and the script starts */
  onenter: (() => void) | null
  /** dt/time in seconds, driven from sim ticks */
  onupdate: ((dt: number, time: number) => void) | null
  /** defining this captures prop-hitting pointer gestures away from the
   * built-in box spawning/grabbing */
  onpointerdown: ((ev: WorldPointerEvent) => void) | null
  onpointermove: ((ev: WorldPointerEvent) => void) | null
  onpointerup: ((ev: WorldPointerEvent) => void) | null
  /** arrow-key and space presses (ev.key: 'ArrowUp' | 'ArrowDown' |
   * 'ArrowLeft' | 'ArrowRight' | ' '), delivered only while this handler
   * is defined */
  onkeydown: ((ev: { key: string }) => void) | null

  /** who am I: peer id, bare Matrix user id (the peer id minus the
   * device; = id outside widget mode), whether this peer is the current
   * primary (senior most reachable: single-runner logic like board init
   * keys off it), and this peer's deterministic accent color */
  readonly me: { id: string; user: string; primary: boolean; color: number }
  /** post a chat message into the Matrix room AS THIS USER (rate-limited
   * to ~1/s by the host; logs locally outside widget mode). Narrate your
   * own player's actions - e.g. chess announces each move. */
  say(text: string): void
  /** replace the HTML HUD overlay in the top-left, over the 3D view.
   * Sanitized by the host (scripts, event handlers and frames are
   * stripped; inline styles survive) and deduped, so calling it every
   * update with unchanged HTML is free. '' hides it. Local-only: each
   * peer's script renders its own HUD from shared state. */
  hud(html: string): void
  /** every connected participant (self included), in join order */
  peers(): { id: string; order: number; color: number; me: boolean }[]
  /** current Matrix room state events of a type, for persistent data
   * like high-score tables. Types are host-allowlisted (others log and
   * return []); the widget capabilities for them are requested lazily
   * on the first call, so the user is only prompted by worlds that use
   * room state - until they approve, reads come back empty. With
   * stateKey: that one event, or null. Self-reported data, only as
   * honest as its authors. */
  getStateEvents(type: string): { type: string; stateKey: string; sender: string; ts: number
    content: any }[]
  getStateEvents(type: string, stateKey: string): { type: string; stateKey: string; sender: string
    ts: number; content: any } | null
  /** send a room state event as this user. Allowlisted types only, and
   * the state key must be (or defaults to) our own Matrix user id:
   * @-prefixed state keys are writable only by that exact sender, which
   * is what keeps users from clobbering each other's per-user events.
   * Rate/size-limited; dropped with a log when room state cannot be
   * written (missing permission). */
  setStateEvent(type: string, content: any, stateKey?: string): void

  /** spawn a dynamic physics box; returns its node */
  createNode(props?: { translation?: Vec3Like; color?: number }): WorldNode
  /** every dynamic box currently in the sim */
  boxes(): WorldNode[]
  /** a spawned box, or a named glTF scene node (read-only), or undefined */
  findNodeByName(name: string): WorldNode | undefined

  // -- props: kinematic physics-free entities, claims as coordination --
  props(): WorldProp[]
  prop(id: string): WorldProp | null
  /** spawn a kinematic sphere prop; returns its id. bounce:false marks a
   * subdued board-game prop: discrete moves ease instead of
   * bounce-dropping, and claims don't swell it. pop:false suppresses the
   * spawn fade-in and despawn pop, so the prop appears and vanishes
   * instantly (snake segments) */
  createSphere(props?: { position?: Vec3Like; translation?: Vec3Like; color?: number; radius?: number
    unlit?: boolean; bounce?: boolean; pop?: boolean }): string
  /** spawn a prop of any kind by name: 'sphere', 'box', or a modelled kind
   * the client renders as built-in geometry - the low-poly chess set
   * 'pawn'|'rook'|'knight'|'bishop'|'queen'|'king', whose size is the
   * piece's height and whose base rests at the prop position. Unknown
   * kinds render as spheres. Returns its id. */
  createProp(props?: { kind?: string; position?: Vec3Like; translation?: Vec3Like; color?: number
    size?: number; unlit?: boolean; bounce?: boolean; pop?: boolean }): string
  /** spawn a kinematic cube prop (a 2*size cube); returns its id */
  createBox(props?: { position?: Vec3Like; translation?: Vec3Like; color?: number; size?: number
    unlit?: boolean; bounce?: boolean; pop?: boolean }): string
  /** an invisible fixed cuboid collider (folded sim state: boxes bounce
   * off it identically on every peer). yaw about Y, dims are full extents.
   * Despawn/move it like any prop. Returns its id. */
  createSolid(props?: { position?: Vec3Like; yaw?: number; dims?: { x?: number; y?: number; z?: number } }): string
  despawn(id: string): boolean
  /** claims coordinate sustained interactions; races resolve
   * deterministically in timeline order */
  claim(id: string): boolean
  unclaim(id: string): boolean
  move(id: string, x: number | Vec3Like, y?: number, z?: number): boolean
  paint(id: string, color: number): boolean

  // -- cosmetics: local-only unless noted, never folded, never hashed --
  createLine(props?: { points?: Vec3Like[]; color?: number; opacity?: number; width?: number
    worldUnits?: boolean; shared?: boolean }): WorldLine
  createScreen(props?: { peer?: string; position?: Vec3Like; yaw?: number; width?: number
    height?: number }): WorldScreen
  /** background/fog colors and whether the default ground shows */
  env(opts?: { background?: number; fog?: { color: number; near: number; far: number } | null
    ground?: boolean }): void
  /** one-shot camera framing hint (use from onload) */
  camera(pos: Vec3Like, target: Vec3Like): void

  createBoxMesh(props?: unknown): unknown
  createCollider(props?: unknown): unknown
  createMaterial(props?: unknown): unknown
  readonly environment: { addNode(node?: unknown): void; findNodeByName(name: string): WorldNode | undefined }
}

declare const console: {
  log(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}
`

/** What the editor opens with when the room has no script yet. */
export const DEFAULT_SCRIPT = `// worldsync world script: every peer runs this, sandboxed; everything it
// does replicates as ops on the shared timeline. world.me.primary marks
// the single-runner peer (see examples/ in the repo for bigger worlds).

world.onenter = () => console.log('hello from', world.me.id)

world.onupdate = (dt, time) => {
  if (!world.me.primary) return
  if (world.boxes().length < 3 && Math.floor(time) > world.boxes().length) {
    world.createNode({ translation: [Math.sin(time) * 2, 3, Math.cos(time) * 2] })
  }
}
`

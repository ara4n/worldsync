// VR video conferencing as a worldsync WebSG script: every participant in
// the MatrixRTC session gets a video screen, arranged as a stacked
// semicircle in front of the viewer, framed in their accent color. Screens
// are local cosmetics (each peer's script instance lays out its own view);
// placing one asks the host for video, which reveals the on-canvas camera
// toggle (V). Nobody's camera is captured or published until they unmute
// it, and joining never prompts for permission by itself.
//
// Upload with "load world script (.js)".

const RADIUS = 3.4
const PER_ROW = 5
const SW = 1.44, SH = 0.81         // 16:9 screens, world units
const ROW_Y = 1.35, ROW_H = 0.95   // bottom row centre height, row pitch
const STEP = Math.PI / 5           // angular pitch between screens on the arc

let screens = {}  // peer id -> { screen, frame }
let shown = ''    // signature of the peer set currently laid out

world.onload = () => {
  world.env({ background: 0x10141a, fog: { color: 0x10141a, near: 8, far: 20 }, ground: true })
  world.camera({ x: 0, y: 1.6, z: 1.2 }, { x: 0, y: 1.6, z: -RADIUS })
}

/** the four corners of a screen's frame, from its pose */
function frameLoop(pos, yaw, w, h) {
  const rx = Math.cos(yaw) * (w / 2 + 0.04), rz = -Math.sin(yaw) * (w / 2 + 0.04)
  const up = h / 2 + 0.04
  const c = (sx, sy) => ({ x: pos.x + sx * rx, y: pos.y + sy * up, z: pos.z + sx * rz })
  return [c(-1, -1), c(1, -1), c(1, 1), c(-1, 1), c(-1, -1)]
}

function layout(peers) {
  for (let i = 0; i < peers.length; i++) {
    const row = Math.floor(i / PER_ROW)
    const inRow = Math.min(peers.length - row * PER_ROW, PER_ROW)
    const col = i - row * PER_ROW
    const a = (col - (inRow - 1) / 2) * STEP
    const pos = { x: RADIUS * Math.sin(a), y: ROW_Y + row * ROW_H, z: -RADIUS * Math.cos(a) }
    const s = screens[peers[i].id]
    s.screen.position = pos
    s.screen.yaw = -a
    s.frame.points = frameLoop(pos, -a, SW, SH)
  }
}

world.onupdate = () => {
  const peers = world.peers()
  const sig = peers.map((p) => p.id).join('|')
  if (sig === shown) return
  shown = sig
  const live = {}
  for (const p of peers) {
    live[p.id] = true
    if (!screens[p.id]) {
      screens[p.id] = {
        screen: world.createScreen({ peer: p.id, width: SW, height: SH }),
        frame: world.createLine({ points: [], color: p.color, width: 2 }),
      }
    }
  }
  for (const id in screens) {
    if (!live[id]) {
      screens[id].screen.despawn()
      screens[id].frame.despawn()
      delete screens[id]
    }
  }
  layout(peers)
}

// worldsync WebSG example: spawns a ring of boxes, then endlessly picks one
// up and stirs it through the pile. Upload with the panel's "load world
// script (.js)" button (widget mode; the mock host at /mock.html works).
// Runs only on the room's root peer; everything it does replicates as ops.
const COUNT = 6
const COLORS = [0xff8844, 0x44ff88, 0x4488ff, 0xffcc22, 0xcc44ff, 0x22ccff]
let boxes = []
let held = null
let t0 = 0

world.onenter = () => console.log('stirrer entered the world')

world.onupdate = (dt, time) => {
  if (boxes.length < COUNT) {
    const k = boxes.length
    boxes.push(world.createNode({
      translation: [Math.cos(k) * 3, 2.5, Math.sin(k) * 3],
      color: COLORS[k % COLORS.length],
    }))
    return
  }
  if (!held) {
    const pick = boxes[Math.floor(time / 4) % COUNT]
    if (pick.grab()) { held = pick; t0 = time }
    return
  }
  const t = time - t0
  if (t < 3) {
    const a = t * 1.5
    held.moveTo(Math.cos(a) * 2.5, 1.5 + Math.sin(t * 5) * 0.4, Math.sin(a) * 2.5)
  } else {
    held.release([-Math.sin(t * 1.5) * 2, 1, Math.cos(t * 1.5) * 2])
    held = null
  }
}

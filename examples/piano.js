// Pianola: a grand piano WORLD that plays itself from MIDI input. The
// piano is glTF data, not an app primitive: examples/piano.glb (built by
// tools/piano-glb.mjs) rigs each of the 88 keys as a named scene node
// (key_21..key_108, MIDI numbering) whose origin sits on the balance
// rail, carrying {note, black, dip} in its glTF extras. This script
// animates those nodes through the WebSG scene-node API - writing
// node.rotation dips a key on this client only, but every peer's script
// hears the same world.onmidi stream (each peer's devices, tagged and
// broadcast), so all views stay in step without touching the physics
// timeline. The scene's baked trimesh already makes the case and floor
// solid on every peer: no collider seeding, nothing folded at all.
//
// Keys are also selectable: each is addInteractable()d, so clicking one
// reports it as ev.entity and PERFORMS it - the click becomes a real
// MIDI note via world.sendMidi, taking the exact hardware path (echoed
// into our own onmidi, played by the audio engine, broadcast to peers).
//
// Sound comes from the world itself: piano.glb carries the Salamander
// grand samples as KHR_audio sources on a positional emitter riding the
// soundboard, and the app's MIDI engine plays them for every noteon on
// the midi plane - local device, remote peer, or a clicked key alike.
// This script only animates the keys; it never touches audio.
//
// Load examples/piano.glb with "load glTF scene (.glb)", then upload
// this with "load world script (.js)".

const FIRST = 21 // A0
const LAST = 108 // C8

// note -> { node, dip, cur, target }: targets set by events, onupdate
// chases them with a fast attack and slower release so runs of MIDI read
// as hammering pianola keys rather than eased UI
const keys = new Map()
const held = {} // note -> { peer, color }
let players = {} // peer id -> notes played (for the HUD tally)
let lastNote = ''
let clicked = null // key held down by our pointer

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const noteName = (n) => NAMES[n % 12] + (Math.floor(n / 12) - 1)

world.onload = () => {
  world.env({ background: 0x0b0d12, fog: { color: 0x0b0d12, near: 12, far: 30 } })
  world.camera({ x: 1.9, y: 1.7, z: 3.1 }, { x: 0, y: 0.85, z: -0.3 })
}

// The scene may still be downloading when the script starts: keep trying
// to find the rig until every key node is there. The dip angle comes
// from each node's glTF extras, so the script carries no model numbers.
function rig() {
  if (keys.size) return true
  for (let n = FIRST; n <= LAST; n++) {
    const node = world.findNodeByName('key_' + n)
    if (!node) { keys.clear(); return false }
    node.addInteractable() // clickable, and pointer hits capture the gesture
    keys.set(n, { node, dip: node.extras?.dip ?? 0.06, cur: 0, target: 0 })
  }
  hud()
  return true
}

function press(note, velocity) {
  const k = keys.get(note)
  if (k) k.target = k.dip * (0.85 + 0.15 * Math.min(velocity, 127) / 127)
}

function release(note) {
  const k = keys.get(note)
  if (k) k.target = 0
}

world.onmidi = (ev) => {
  if (!rig()) return
  if (ev.type === 'noteon') {
    press(ev.note, ev.velocity)
    const who = world.peers().find((p) => p.id === ev.peer)
    held[ev.note] = { peer: ev.peer, color: who ? who.color : 0xffffff }
    players[ev.peer] = (players[ev.peer] || 0) + 1
    lastNote = noteName(ev.note)
    hud()
  } else if (ev.type === 'noteoff') {
    release(ev.note)
    delete held[ev.note]
    hud()
  }
  // control 64 (sustain) is the audio engine's business; pitchbend etc.
  // also arrive here - nothing to animate for them (yet)
}

// clicking a key performs it while the button is down: the note goes out
// as real MIDI, and the echo into our own onmidi above does the animating
world.onpointerdown = (ev) => {
  if (!ev.entity || !ev.entity.startsWith('key_')) return
  clicked = Number(ev.entity.slice(4))
  world.sendMidi(0x90, clicked, 100)
}
world.onpointerup = () => {
  if (clicked === null) return
  world.sendMidi(0x80, clicked, 0)
  clicked = null
}

world.onupdate = (dt) => {
  if (!rig()) return
  for (const k of keys.values()) {
    if (k.cur === k.target) continue
    const tau = k.target > k.cur ? 0.014 : 0.045
    k.cur += (k.target - k.cur) * (1 - Math.exp(-dt / tau))
    if (Math.abs(k.cur - k.target) < 0.0005) k.cur = k.target
    // the key node pivots on the balance rail: +x rotation dips the front
    k.node.rotation = { x: Math.sin(k.cur / 2), y: 0, z: 0, w: Math.cos(k.cur / 2) }
  }
}

function hud() {
  const css = (c) => '#' + c.toString(16).padStart(6, '0')
  const notes = Object.keys(held).map(Number).sort((a, b) => a - b)
  const chord = notes.map((n) =>
    `<b style="color:${css(held[n].color)}">${noteName(n)}</b>`).join(' ')
  const tally = world.peers()
    .filter((p) => players[p.id])
    .map((p) => `<span style="color:${css(p.color)}">${p.id.split(':')[0]}: ${players[p.id]}</span>`)
    .join(' &middot; ')
  world.hud(
    '<h3 style="margin:0">pianola</h3>'
    + '<p style="margin:2px 0">plug in a MIDI keyboard or click a key - everyone sees and hears it</p>'
    + `<p style="margin:2px 0;font-size:18px">${chord || (lastNote ? `last: ${lastNote}` : '&nbsp;')}</p>`
    + (tally ? `<p style="margin:2px 0">${tally}</p>` : ''))
}

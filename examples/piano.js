// Pianola: a grand piano that plays itself from MIDI input. Plug a MIDI
// keyboard into ANY peer's machine and every peer watches the same keys
// dip - world.onmidi delivers each peer's device events to every script
// instance identically (defining the handler is what makes the host
// request MIDI access at all). The piano itself is a local cosmetic, like
// video screens: each peer's script places its own copy and animates it
// from the shared event stream, so nothing here touches the physics
// timeline except one solid collider so thrown boxes bounce off the case.
// No audio yet: the room's voice channel is the sound stage.
//
// Upload with "load world script (.js)".

const POS = { x: 0, y: 0, z: 0 }
const YAW = 0.45 // angled toward the stock camera, recital style

let piano = null
const held = {} // note -> { peer, color }
let players = {} // peer id -> notes played (for the HUD tally)
let lastNote = ''

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const noteName = (n) => NAMES[n % 12] + (Math.floor(n / 12) - 1)

world.onload = () => {
  world.env({ background: 0x0b0d12, fog: { color: 0x0b0d12, near: 12, far: 30 } })
  world.camera({ x: 1.9, y: 1.7, z: 3.1 }, { x: -0.3, y: 0.85, z: -0.5 })
}

world.onenter = () => {
  piano = world.createGrandPiano({ position: POS, yaw: YAW, size: 1 })
  hud()
}

// The case is solid so the physics world agrees it exists: one static
// collider, emitted by the primary only (single-runner pattern) - the one
// deterministic op this world ever folds.
let seeded = false
world.onupdate = () => {
  if (seeded || !world.me.primary) return
  seeded = true
  if (!world.props().some((p) => p.kind === 'collider')) {
    world.createSolid({
      position: { x: POS.x - Math.sin(YAW) * 1.1, y: 0.8, z: POS.z - Math.cos(YAW) * 1.1 },
      yaw: YAW, dims: { x: 1.5, y: 0.45, z: 2.4 },
    })
  }
}

world.onmidi = (ev) => {
  if (!piano) return
  if (ev.type === 'noteon') {
    piano.noteOn(ev.note, ev.velocity)
    const who = world.peers().find((p) => p.id === ev.peer)
    held[ev.note] = { peer: ev.peer, color: who ? who.color : 0xffffff }
    players[ev.peer] = (players[ev.peer] || 0) + 1
    lastNote = noteName(ev.note)
    hud()
  } else if (ev.type === 'noteoff') {
    piano.noteOff(ev.note)
    delete held[ev.note]
    hud()
  }
  // control 64 is the sustain pedal, pitchbend etc. also arrive here -
  // nothing to animate for them (yet)
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
    + '<p style="margin:2px 0">plug in a MIDI keyboard and play - everyone sees the keys move</p>'
    + `<p style="margin:2px 0;font-size:18px">${chord || (lastNote ? `last: ${lastNote}` : '&nbsp;')}</p>`
    + (tally ? `<p style="margin:2px 0">${tally}</p>` : ''))
}

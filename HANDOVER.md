# worldsync handover

Working notes for continuing this project in a fresh session. The README
covers the architecture for users; this doc adds session context, the
debugging history, and open threads.

## What this is

A test jig for p2p multiplayer physics experiments, built July 2026 for
Matthew (matthew@element.io). Three.js rendering, bitECS entities, Rapier
physics (deterministic build), WebRTC full-mesh data channels, rollback
netcode with rubber-band presentation. No server authority; every peer runs
the full sim. Goal: experiment with peers fighting over the same objects and
how races resolve.

Run: `npm run dev` (Vite serves the app AND the ws signaling at /signal),
open http://localhost:5173 in 2+ tabs, same ?room= = same world.
A dev server is usually already running on 5173 (kill: `kill $(lsof -ti:5173)`).

Tests (dev server must be running; all run HEADED per Matthew's request).
NOTE: editing src/ while a test runs triggers a Vite reload that kills the
test mid-flight; finish edits first.
- `node test/smoke.mjs`: 2 browsers, spawn replication, 120ms-lagged drag
  must converge bit-identically, input logs must match.
- `MINUTES=2 BOXES=150 node test/diverge.mjs`: stress that reproduced the
  big divergence bug; auto post-mortem if peers disagree; NORM=/CAD= env
  select normalisation mode and cadence (0 = app default).
- `BOXES=150 node test/perf.mjs`: per-tick phase breakdown per mode.
- `node test/verify-motion.mjs`: single-page replay-vs-live check mid-fall.
- `node test/persist.mjs`: world persistence under the mock host
  (default-off, inline + mxc checkpoint restore, clear on opt-out).
- `node test/nav.mjs`: navigation/selection/edit e2e: click-select without
  disturbing, deselect-vs-spawn clicks, gizmo center-drag converging
  bit-exact across peers, resize + streamed-rotation replication, and the
  walker (WASD/run/jump/arrow look). Pointer-lock carrying is manual-only:
  CDP synthetic events carry no movementX/Y.

## File map (src/)

- `types.ts`: protocol types, wallNow() (= performance.timeOrigin + now).
- `ecs.ts`: bitECS components (Position, Rotation, PrevPosition,
  PrevRotation, Tint, Box), netId<->eid maps, ensureEntity.
- `sim.ts`: THE CORE. Rapier world, global tick grid, cadence
  snapshot/normalize (history ring), interaction timeline, rollback
  (fold/resim, rounds down to cadence), grabs, per-tick pose hashes,
  verifyReplay, stateAt/snapshotAt/roundTrip probes, input log, perf EMAs.
- `net.ts`: signaling client, WebRTC mesh (joiner initiates, signal queue
  serialized to avoid ICE races), ping/pong RTT + wall-skew measurement,
  fake-latency send delay, per-peer strike/exclusion + divergence latches.
- `render.ts`: Three scene, mesh sync from ECS, fixed-timestep interpolation
  (prev->curr by alpha), rubber-band error offsets (View.errors), cmd/ctrl
  toggles left-drag orbit; cosmetic layers (screens, labels, script glTF).
- `input.ts`: pointer gestures in both nav modes: click ground = spawn,
  click box = select (grabs defer to the drag threshold so a click never
  disturbs), drag box = grab/move@33ms/release with throw velocity
  (presented-pose grab override); walk-locked drags carry on the view ray.
- `nav.ts`: navigation modes (orbit vs thirdroom-style walk: pointer-lock
  look, WASD/shift/space, floor raycast, pure camera - never sim state),
  selection, the bottom HUD, and the edit gizmo (TransformControls ->
  grab/pose-rot-stream/release, scale -> one 'resize' op).
- `main.ts`: orchestration; frame loop = fold -> advance -> mirror -> render;
  hash exchange, staleness (opt-in), boot, worker ticker for hidden tabs,
  window.__jig test hooks, __divergence stash.
- `ui.ts`: panel (latency slider, lag-pings + enforce-staleness checkboxes,
  rubber-band ms, input-log download, verify button, persist-world
  checkbox, peer table, log).
- `matrix/persist.ts`: opt-in world persistence (org.worldsync.checkpoint
  state event: persist flag + settled semantic dump, inline under 48kB
  else CBOR in the media repo by mxc pointer). Root peer writes every 10s
  from Sim.dumpPersist (OLDEST history snapshot = settled; grabs
  dropped); Session.rooted gates restore (replayed as a boot seam);
  toggle-off clears the event whole. Wired in main (syncPersist in the
  frame loop + worker ticker, pagehide flush).
- `vite.config.ts`: ws signaling server plugin (rooms, join order, relay).

## Core invariants (break these and peers diverge)

1. Global tick grid: tick K = wall-clock [K*33.3ms, (K+1)*33.3ms). All peers
   bin every interaction by its claimed wall timestamp. Sub-tick timing only
   orders events within a tick (sort: tick, t, order, seq).
2. ALL physics inputs flow through the timeline, including the dragger's own
   drag (33ms move samples). Never feed raw pointer state to the sim.
3. At every CADENCE POINT (tick % cadence == 0 on the global grid; cadence
   10 by default, same on every peer), the world is snapshotted then freed
   and restored from those bytes before stepping ("normalize"), and
   rollbacks round DOWN to a cadence point. Every peer thus performs
   restores at identical ticks whether stepping live or replaying. See
   hunt chapters 5-9.
4. Bodies never sleep (setCanSleep(false) at both creation sites).
5. Body creation order = timeline order everywhere (folds recreate in
   timeline order), so Rapier handles match across peers.
6. State = pure function of (cadence snapshot bytes, timeline). Anything
   violating this must be fixed, not tolerated.
7. Cross-peer state comparison uses POSE/VELOCITY hashes only, exchanged
   for ranges older than the fold window (SETTLE_TICKS=165 > HISTORY_TICKS)
   so no rollback can rewrite an exchanged tick. Snapshot BYTES are never
   compared across peers (see chapter 9); byte-level checks are local only
   (verifyReplay).

## The divergence hunt (chronological, so you don't re-litigate)

1. Initial build diverged badly. Fixes round 1: global tick grid (was
   per-page epochs), drags through timeline only, deterministic rapier build
   (@dimforge/rapier3d-deterministic-compat 0.19), 30Hz, render interp.
2. Still diverged at scale (Matthew: ~100 boxes, 500ms one-sided latency).
   Input logs (added for this) were bit-identical across peers, so netcode
   delivered identical inputs at identical ticks. Symptom shape: lagged
   sender has rollbacks=0 (receives everything fresh), other peer folds
   everything (~1 rollback per received interaction).
3. Post-mortem tooling showed: states bit-identical at tick N-1, zero inputs
   at tick N, divergence at N. Sleep-state theory: partially right
   (disabled sleeping, necessary but not sufficient).
4. Snapshot byte comparison: peers' snapshots differed in ~2400 internal
   bytes while every pose/velocity bit matched. roundTrip (serialize ->
   restore -> serialize) is byte-idempotent, so not a serialization bug.
5. ROOT CAUSE (confirmed in bundled rapier.mjs source): takeSnapshot
   serializes gravity, integration params, islands, broadPhase, narrowPhase,
   bodies, colliders, joints - but step() also uses this.physicsPipeline and
   this.ccdSolver which are NOT serialized (likely incl. parry contact
   manifold workspaces, serde(skip) trait objects). A restored world gets a
   fresh pipeline; a fold-heavy peer therefore evolves different
   solver-internal state than a live-stepping peer. Usually pose-neutral
   (why short self-checks passed), decisive under contact stress (grabbed
   box pinned inside settling pile).
6. FIX: per-tick normalize (invariant 3). Verified: 2 min, 132 boxes, 500ms
   latency, 1386 rollbacks on the folder, drags through the pile: worst
   cross-peer pose delta 0.000000000m; verifyReplay byte-exact on both.
7. "Why not restore only on rollbacks?" (Matthew asked): because rollback
   times are per-peer arrival-determined; each restore resets the hidden
   state, so restore timing must be identical on all peers.
8. Pipeline-reset experiment (REFUTED, commit 5e0b3b0): world.step()
   consults exactly the 9 serialized components plus physicsPipeline and
   ccdSolver (verified in the bundle), and both wrappers have no-arg ctors,
   so ?norm=pipeline replaced just those two per tick instead of restoring.
   Result: stress diverges in seconds; a LONE page gets verifyReplay
   posesMatch=true bytesMatch=false. Conclusion: serialize+restore also
   canonicalises in-memory representation of the serialized components
   (orderings affecting FP summation), and stepping is sensitive to the
   representative. So a fork that merely serialized PhysicsPipeline would
   NOT enable restore-free rollback; it would need representation-
   independent stepping (canonical constraint sorting) inside rapier.
9. Byte-hash noise + grid-aligned cadence (the actual overhead fix):
   b-hash "divergence" latched even in restore mode with poses bit-equal;
   final-map diff showed peers' snapshot bytes differ PERSISTENTLY.
   Isolated in node: after the first step, exactly two u32 LE per-step
   counters (offsets 148/192 in an empty world, broad-phase section)
   increment every step and are serialized; equal-warmup worlds serialize
   identically. A folding peer steps more total times than a live peer, so
   cross-peer snapshot bytes NEVER match. The b≠ signal was structural
   noise all along (and polluted the original bug's byte diffs). Removed
   the byte-hash exchange entirely (also saves ~0.5ms/tick of FNV).
   Then implemented cadence normalization (invariant 3): snapshot+restore
   every K grid-aligned ticks, rollback rounds down. Validated bit-exact
   at cad=1 and cad=10 (150-box stress, ~1400 rollbacks, 300/300 settled
   pose hashes equal, zero anomalies). Default cadence 10.

## Diagnostic toolkit (all live in the app)

- Input log: every input fed to the sim {tick, claimedTick, t, peer, order,
  seq, type, netId, pos, vel}, full float precision; panel button downloads;
  diff two peers' logs sorted by (tick,t,order,seq).
- Per-tick pose/velocity hash on the global grid; exchanged for settled
  ranges (SETTLE_TICKS=165 back, beyond the fold window so exchanged values
  are final); sync column: `=` ok, `≠@N` diverged; first divergent tick
  latched. No cross-peer byte hashes (invariant 7).
- Step-phase perf EMAs in sim.perf {snap, norm, phys, hash}, shown in the
  panel status line and dumped by test/perf.mjs.
- On pose divergence: auto verifyReplay + window.__divergence stash (bit
  dumps + raw snapshots at divergent tick and tick-1).
- ANOMALY log lines for the two known unrecoverable events: tick jump after
  a >2s stall; interaction clamped because it predates the snapshot window.
- __jig hooks: sim, net, view, pos(netId), screenPos(netId),
  screenOfGround(x,z), screenOfWorld(x,y,z), verify(depth), roundTrip().

## Wire protocol notes

- CBOR on data channels (ordered reliable), src/wire.ts: cbor-x with
  useRecords:false so every message is a self-describing plain map (no
  cross-message schema state; joiners decode mid-stream). Swapped from
  JSON 2026-07-25 (Matthew asked; thirdroom's bespoke ECS replication
  does not fit this message vocabulary). f64 round-trips exactly;
  UNLIKE JSON, CBOR would carry -0 faithfully, so session.emit's -0
  normalization is now the only thing upholding the "-0 never crosses
  the wire" guarantee (keep it). The headless hub round-trips through
  the same codec. ws SIGNALING (vite plugin) stays JSON - it never
  carries sim data.
- Staleness enforcement is OFF by default (a drop = guaranteed permanent
  divergence; it fights determinism testing). Checkbox re-enables:
  max(250ms, 1.5*RTT+120ms), 10 strikes = excluded.
- Clock skew measured (NTP-style, min-RTT sample) but NOT corrected; wall
  clocks trusted. Future: stamp tick numbers + calibrate (Matthew's plan).
- Late join: boot-req to first senior connected peer -> JSON entity dump.

## Perf state

150 settled boxes on Matthew's M5, per tick (budget 33ms), measured by
test/perf.mjs after the byte-hash removal:
- cad=1:  1.50ms = snap 0.26 + restore 0.42 + phys 0.63 + hash 0.20
  (serialization overhead ~= 1x the physics step itself)
- cad=10: 0.89ms = snap 0.03 + restore 0.05 + phys 0.65 + hash 0.17
  (overhead amortised to ~13% of physics; DEFAULT)
Fold storms on a lagged peer remain the pressure point (replay = N ticks x
step cost, plus up to cadence-1 extra ticks from rounding down). Next
levers if scaling further: raise cadence (validated knob), thin the pose
hash, or batch bodies.

## The fork question (answered 2026-07-20)

Matthew wanted to know if forking rapier/parry could remove the restore
overhead. Answer: the overhead is already near-zero at cadence 10, and a
fork would be much harder than "serialize the pipeline": chapter 8 shows
restore-free rollback needs representation-independent stepping inside
rapier (canonical constraint ordering), not just more serde coverage. Not
worth it at jig scale. A TINY fork could zero the two per-step broad-phase
counters during serialization to make cross-peer byte comparison
meaningful again (early-warning internals check, chapter 9) - nice-to-have
only.

## WebMIDI + pianola (2026-07-24, glTF 2026-07-25, audio 2026-07-25)

world.onmidi exposes WebMIDI to scripts: defining the handler is the
subscription (access requested lazily, so non-MIDI worlds never
prompt); a scene carrying note-mapped KHR_audio samples counts as the
same subscription (an instrument world prompts at scene load, script
or not). Local device events are parsed
(noteon/noteoff/control/pitchbend), delivered to our own script, and
broadcast as {kind:'midi'} - a COSMETIC plane, never folded/hashed.
Deliberate design call
(Matthew asked): folding notes as prop ops would cost a rollback per
note on every peer at piano rates (fold storms, see perf section) to
sync state physics never reads; cosmetics that do not feed physics stay
off the timeline. mock.html iframe carries allow="midi". Untested
against real hardware so far: a real device on a real Element Web host
needs the host iframe to allow MIDI (EW does not today - degrade is a
logged access failure).

The piano itself is glTF DATA, not an app primitive (Matthew: no
world.createGrandPiano in the app; scripts animate existing glTF data
instead). tools/piano-glb.mjs (plain node, OUTSIDE src/ so vite never
bundles it) builds examples/piano.glb: a world with a stage floor and
the modelled grand, every key a named node key_21..key_108 with its
origin on the balance rail and {note, black, dip} in its glTF extras.
The WebSG scene-node API animates it: findNodeByName exposes writable
local TRS (write-through components, thirdroom-style), node.extras, and
addInteractable() for pointer picking - all local cosmetics, restored
on script stop, trimesh collider untouched (see websg.ts ScriptHost).
examples/piano.js is the pianola; test/piano.mjs e2e's the full flow
(glb upload, rig, __jig.midi chord on both tabs, click-a-key capture,
sample decode + voices sounding/silencing on both tabs).

SOUND is glTF data too (2026-07-25, Matthew asked): piano-glb.mjs
fetches the Salamander grand set (tonejs mirror, CC-BY 3.0 Alexander
Holm; 30 mp3s every minor third A0..C8, cached in gitignored
tools/samples/) and splices thirdroom-flavour KHR_audio into the GLB:
per-note audio+source ({note} in source extras), one positional
emitter on the soundboard node; attribution in asset.copyright (glb is
~2.5MB). scene.ts extracts that at parse time into ParsedScene.audio
(bytes + emitter anchored to its THREE node); src/audio.ts is the
engine: decode-once per scene, voice = BufferSource->Gain into the
emitter's Gain->HRTF-Panner chain, nearest sample pitch-shifted by
playbackRate (max half a semitone off with minor-third spacing),
velocity^1.6 gain, 0.35s noteoff ramp, per-peer CC64 sustain, 48-voice
cap with oldest-steal, listener follows the camera per frame
(audio.frame in the rAF loop). Driven from deliverMidi - BOTH local
WebMIDI and remote 'midi' broadcasts, so all peers hear the same
performance; AudioContext resumes on first gesture (autoplay), tests
pass --autoplay-policy=no-user-gesture-required. world.sendMidi(status,
d1, d2) lets scripts perform down the same path (microtask-deferred so
the onmidi echo cannot re-enter QuickJS mid-dispatch); piano.js clicks
use it, so a clicked key sounds and dips everywhere. __jig.audio()
exposes {context, emitters, samples, voices, sounding} for tests.

## Line primitive: removed, then RESTORED (2026-07-25)

History, so you don't re-litigate: a "WebSG manipulates glTF data,
never draws primitives" rule (d98c121) removed world.createLine and
the 'line' DcMessage plane; example worlds drew wires by loadGltf-ing
unit cubes via a shared createPolyline helper, and dots moved its
chains to kv-table data + a tip bead. Matthew REVERSED this the same
day (drawing lines via glTF instantiation is too clunky): lines are an
ENGINE PRIMITIVE again alongside boxes/spheres - world.createLine,
the render-side fat-line layer (Line2, screen-px or worldUnits
widths), the 'line' latest-wins cosmetic broadcast plane, departed
peers taking their shared lines with them - and the example worlds are
back on their pre-d98c121 createLine versions (dots chains ride shared
lines again). world.loadGltf STAYS for instantiating real glTF data;
it is just not the mandatory path for simple geometry. test/snake.mjs
remains a focus-sensitive flake either side of all this.

## Architecture world (2026-07-25)

tools/arch-glb.mjs builds examples/arch.glb: the codebase as a 3D
machine world, at MEMBER granularity, analyzed (not curated) with the
TypeScript compiler API. Modules are slabs carrying blocks for their
major members - when one class/function dominates a file (Sim,
main()) the tool descends into it. Footprint ~ lines, height ~
consumer count (load-bearing = towers; main = the flat central
manifold). Layout has two cooperating sources (Matthew asked for
both): DISTRICTS come from label propagation over the
symbol-weighted import graph (main excluded or it glues everything;
<3-member clusters merge into the hint-nearest one; found: sim,
render, matrix_net, websg, websg_dts), GEOGRAPHY comes from an ASCII
architecture diagram embedded in the tool - the layout DSL: token
positions become slab anchors (dataflow west->east: transports ->
wire/session -> sim -> presentation; chassis center; sandbox south;
vendors outboard), then a relaxation pass de-overlaps. Pipes =
imports, symbol-accurate, routed as swoopy catmull ribbons through
district masts - one bus per district pair at its own reserved
height, cable-tray slot offsets keeping the ribbon parallel (a full
Manhattan-tray variant was built and REVERTED 2026-07-25, Matthew
judged it no clearer - it lives at commit 972d836 if wanted); a cone
mid-ribbon plus a down-cone at the socket give direction (pipes point
at what they depend on); traces fan from the socket to the exact
imported member blocks; dynamic import() thin and pale; net->vite
/signal the one runtime wire. Endpoints are semantic: each module has
ONE labeled import port (breakout block on its slab edge) that all its
outgoing pipes leave from, and each arriving pipe's socket rides a
small mast hoisted above the provider's member skyline at the centroid
of the symbols it imports, traces arcing DOWN onto each symbol's roof
(they were invisible between the boxes at slab level). world.highlight
(new WebSG API -> view.setOutline) powers arch.js hover: pointing at a
pipe lights it + both endpoint modules and HUDs the symbol list;
pointing at a module lights its whole loom. Hover needed a host
change: input.ts forwards UNCAPTURED pointermoves to scripts as
ScriptPointer.hover, gated on the script defining onpointermove. Every slab/member/pipe
is a named node (mod_sim, mod_sim__rollback, dep_three__Mesh,
pipe_main__sim) with {module, member, kind, district, loc, consumers,
symbols} extras, and an arch_index node carries a manifest -
examples/arch.js (the world script) uses it: SPACE sweeps the city
between full detail and the module-dependency skeleton (scale 0.001
is the hide channel), clicking a slab HUDs its extras. Labels are
flat ShapeGeometry text (extruded TextGeometry ballooned the glb 5x).
Screenshot loop: scratchpad arch-shot script (mock.html upload +
script upload + keyboard + png).

## Navigation mode + edit gizmo (2026-07-25)

Matthew asked for thirdroom-style navigation: walk mode (WASD / shift
run / space jump, pointer-lock or cursor-key look) beside the classic
orbit, with single-click selection switching to orbit-around-the-box
for precision manipulation instead of carrying it around. Decisions:

- Default stays ORBIT so the whole scripted-test estate (coordinate
  clicks, plane drags) keeps working; walk is the HUD toggle, ?nav=walk,
  or world.navigation('walk'). Flipping the default is one line in
  nav.ts if wanted.
- The avatar is PURE CAMERA (src/nav.ts): floor from a downward raycast
  against the rendered scene (three's per-mesh AABB early-out keeps
  many-mesh scenes cheap; one giant terrain mesh would want a BVH), no
  wall collision, nothing enters the timeline. Walking through the arch
  city works today; piano too (crosshair clicks reach scripts - scriptEv
  and Input cast through screen center while locked).
- Clicks SELECT now, so grabs defer until the 6px drag threshold - this
  removed diverge.mjs's accidental "quick grab+release pairs" stress
  input (its comment predates this; drags still plow). Its final "worst
  pose delta" line can read tens of metres when a box was shoved off the
  ledge: it free-falls forever and the two pages sample live poses at
  different wall instants. The hash-map comparison right above it is the
  truth (0 differing ticks = converged).
- Gizmo edits ride the EXISTING protocol: grab + pose stream + release.
  Rotation joins the pose plane (optional rot on samples, latest-wins <=
  tick, applied via setNextKinematicRotation; release carries the final
  rot so the pin is never a tick stale). Scale is a new 'resize' op whose
  dims live ONLY in the physics world (colliders serialise into
  snapshots - no side table to drift); they join the per-body hash, cross
  boot seams/checkpoints when non-default, and render reads sim.boxDims
  into mesh.scale each frame.
- world.navigation('orbit') pins orbit in the board worlds (dots, chess,
  four-in-a-row, snake, tetrix, videoconf); selection still borrows
  orbit; the pin clears when the script stops.
- Selection outline shares the OutlinePass with the inspector and
  world.highlight: last caller wins, fine for a jig.
- POINTER LOCK (bug Matthew hit in the piano room, fixed 2026-07-26):
  the walk toggle originally did not request lock - only a later canvas
  click did, which nobody does - so mouselook silently never engaged.
  Now the toggle click itself locks (it is a user gesture). When lock is
  genuinely unavailable, nav latches lockBroken and walk falls back to
  DRAG-LOOK on empty space (street-view style), with clicks acting
  normally - that is the stock Element Web path. The REAL gate there
  (found 2026-07-26, Element Desktop): AppTile's iframe is SANDBOXED,
  and Chromium gates pointer lock in sandboxed frames on the sandbox
  attribute's allow-pointer-lock flag - NOT the allow= feature list
  (current Chrome does not even list pointer-lock as a permissions-
  policy feature, so editing allow= does nothing). Matthew's element-web
  checkout now adds allow-pointer-lock to AppTile's sandboxFlags
  (uncommitted; upstream candidate). element-desktop sets no Electron
  setPermissionRequestHandler, so its default grants the pointerLock
  permission - no desktop-side change needed. mock.html's allow= grant
  is kept as harmless future-proofing. Esc-exit cooldown failures
  (~1.3s) are ignored, not latched.
  Debugging trap: under Playwright/CDP the browser window is UNFOCUSED
  and requestPointerLock rejects with WrongDocumentError everywhere,
  iframe or not - bringToFront() + a real click makes it succeed; do not
  mistake that for a host restriction. Locked mouselook is therefore
  untestable headlessly (no movementX on synthetic events); drag-look is
  covered in test/nav.mjs instead.

## Element Web/Desktop host gotchas (2026-07-26)

Both found running worldsync as a real widget; both patched in Matthew's
element-web checkout (uncommitted there; upstream candidates):

- Pointer lock: AppTile's iframe sandbox lacks allow-pointer-lock (see
  the walk-mode section above).
- Capability re-prompt ping-pong (tetrix, not piano): EW's
  ElementWidgetDriver.validateCapabilities REPLACES the remembered
  capability set (localStorage widget_<id>_approved_caps) with
  intersection(allowed, requested) - but an MSC2974 renegotiation only
  passes the NEWLY requested capabilities (ClientWidgetApi filters to
  the delta), so remembering the highscore grant clobbers the
  remembered boot-handshake grants, and the next boot's remember
  clobbers the highscore grant back: full-permissions prompt + state
  prompt on every open, forever (EW has a TODO on the exact line).
  Piano never calls the state APIs, never renegotiates, never clobbers.
  Patch: merge into the remembered set instead of replacing. Worldsync
  keeps its lazy MSC2974 request by design (worlds that never touch
  room state never prompt); folding SCRIPT_STATE_TYPES into the boot
  handshake would mask the EW bug at the cost of prompting everyone.

## Known gaps / next-step candidates

- Cross-machine wall-clock skew shifts tick binning (same-machine tabs are
  exact). Fix: tick stamps + calibration.
- Late joiners get a JSON dump, not byte-exact state: founding peers agree
  exactly, joiners start merely close. Fix: send snapshot bytes + timeline.
- No resync after real divergence, no kick, no entity deletion, no jitter
  sim (latency shim is constant delay, ordered channel).
- Hidden tabs simulate via worker heartbeat; >2s hard stall still jumps.
- ?norm=pipeline is kept as a live demo of the refuted experiment; do not
  use it for real runs (it diverges by design).

## Matthew's working preferences (from this session)

- Commit as you go. No Co-Authored-By, no session links, NO EM-DASHES
  anywhere (use brackets or hyphens); succinct.
- Playwright headed, not headless.
- cmd-drag orbit (mac). Scripted drags must plow THROUGH the pile, not
  around it.
- Happy to have rapier forked/built from source if debugging demands it.
- Repo has an AGPL LICENSE.txt from an earlier "initial experiment" commit
  he made himself; git history before that is his.

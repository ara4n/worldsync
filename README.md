# worldsync

A test jig for experimenting with peer-to-peer multiplayer physics: Three.js
rendering, bitECS entities, Rapier simulation, WebRTC data channels, and
rollback netcode with rubber-band presentation.

Every participant runs their own full Rapier simulation. There is no server
authority. Replication happens on two planes: discrete ops (spawn, grab,
release, boot) are tick-stamped events on one shared timeline that every
peer folds in by rolling the physics world back and replaying, while
continuous drag motion travels as latest-wins pose streams that never cause
rollbacks and are healed in batches by heartbeat folds.

## Run it

```
npm install
npm run dev
```

Open http://localhost:5173 in two or more tabs (or `--host` and use two
machines). Everyone in the same `?room=` is meshed together. The Vite dev
server doubles as the WebRTC signaling server (`/signal`), so there is nothing
else to start. `npm run build && npm run preview` serves the production build
with the same signaling.

Controls: click the ground to spawn a box, drag a box to move it (physics
resumes on release, with throw velocity), cmd-drag or right-drag orbits,
two-finger drag pans along the ground plane, pinch or ctrl-wheel zooms.

Rendering: cascaded shadow maps (4 cascades, splits weighted hard toward
the camera so contact shadows get millimetre texels), double-sided
shadow casting with a tiny normal bias - the combination that finally
killed both shadow acne and peter-panning at box/ground contacts - and
ACES filmic tone mapping (exposure 1.2) so glossy glTF floors show a
graded specular sheen instead of a clipped white blob. The renderer
logs a feature stamp (`[worldsync] renderer: ...`) at startup so a
screenshot can be matched to the code that drew it; host iframes cache
aggressively enough that this matters.

## Matrix widget mode (matryoshka)

With widget URL params present (`widgetId`, `parentUrl`, `roomId`, `userId`,
`deviceId`, `baseUrl`, per element-call's convention) the app runs as a
Matrix widget instead of the ws demo: matrix-widget-api + matrix-js-sdk's
`createRoomWidgetClient` proxy everything through the host client, so
identity and encryption are inherited from it. Room presence is MatrixRTC
(`m.call.member` state events); each member's `createdTs` is its join
order, and the oldest member roots the tick grid. Data travels as LiveKit
text streams (topic `worldsync`), with the SFU url + JWT obtained via the
OpenID exchange against an lk-jwt-service (element-call's flow; override
the service url with `?lkService=`). The Session and Sim are identical in
both modes - MatrixNet is just another transport behind the same seam.

The handshake matches real Element Web semantics, learned the hard way
against a live EW: widgets added with `/addwidget` run under the host
default `waitForIframeLoad=true`, so the widget must NOT send
ContentLoaded (such hosts answer it with a hard "Improper sequence"
error, visible only in the parent frame's console), and the
RoomWidgetClient must be constructed at module scope: the host fires its
capabilities request at the iframe load event, and constructing after
the Rapier wasm init loses that race by seconds, leaving startClient
waiting forever. In widget mode every diagnostic line is mirrored to the
console with a `[worldsync]` prefix, including a notice when input is
ignored because the session has not started.

Widget mode also carries **MSC3815 world scenes** (Third Room's worlds
proposal): the panel's "load glTF scene" button uploads a GLB through the
host's MSC4039 media actions, points the room's
`org.matrix.msc3815.world` state event (`scene_url`) at it, and folds a
`scene` op into the shared timeline, stamped ahead like a boot seam so
every peer swaps in the scene's colliders on the same tick. Each peer
bakes the GLB's meshes into one fixed trimesh (deterministically: same
bytes, same traversal, f64 transforms rounded to f32 identically), so
boxes rest on and roll off the scene bit-identically everywhere.
Real-world GLBs decode fully: KTX2/Basis textures, Draco and meshopt
geometry (decoder binaries served from `public/basis` and
`public/draco`, pinned to the three version), and
`EXT_mesh_gpu_instancing` meshes bake one collider copy per instance at
`matrixWorld * instanceMatrix` - baking only the node transform parks a
phantom collider at the node origin and leaves the visible instances
untouchable. A scene
(re)load is a deterministic world RESET at the op's tick: every body is
dropped (no stale pile floating inside the new world) and the default
ground plane yields to the scene's own floors, returning when the scene
is cleared. The scene rides history snapshots and the boot seam like any
other sim state;
late joiners fetch and adopt it from room state before tick calibration,
and a peer whose download outlives the op's lead applies the op hollow
(one logged anomaly) and heals by folding from the op's tick once the
geometry arrives. Requires widget mode - the classic ws demo has no media
repo to share bytes through, so its button just explains that.

**MSC3815 `script_url` (WebSG scripts)** is supported too: the panel's
"load world script" button uploads a JS file and merges `script_url` into
the world state event. The script runs in a QuickJS-in-WASM sandbox
(quickjs-emscripten, singlefile variant) with a 32MB memory limit, 1MB
stack, and a 20ms interrupt deadline per hook call - tighter than
thirdroom's runtime, which relies on its fixed 64MiB WASM heap alone.

The execution model: EVERY peer runs its own script instance,
uncoordinated and wall-clock, like thirdroom - but where thirdroom's
WebSG hands scripts raw netcode (`network.broadcast`, listeners,
replicators, `isHost`) and papers over disagreement with
owner-authoritative interpolation, here the script never sees the
network at all. **The sim is the network**: scripts read the
deterministic sim state, and every mutation leaves the sandbox as an
ordinary op on the shared tick grid, folded by all peers exactly like
human input. QuickJS heaps are never rollback state; script state is
per-peer and disposable. Two primitives make multi-peer scripts work:

- **Claims.** Props (see below) carry a `claim` field; a `claim` op only
  applies to an unclaimed prop, so racing claims from rival peers
  resolve deterministically by `(tick, order, seq)` with zero consensus
  machinery. Sustained interactions (chaining dots) claim as they go and
  `unclaim`/despawn on completion; `unclaim` is owner-only unless
  `force` (the ghost path: the primary force-clears claims of departed
  peers). One-shot ops never touch claims - they just race.
- **`world.me.primary`.** True on the senior-most *reachable* peer.
  Single-runner logic (board seeding, ambient behaviour) guards on it;
  a handover flips the flag on the survivor's already-running instance.
  During a partition both sides can briefly believe they are primary
  (split-brain, doubled effects) until connectivity settles.

The API surface, WebSG-flavoured: `world.onload/onenter/onupdate(dt,
time)`; boxes via `world.createNode({translation, color})` /
`world.boxes()` / `node.grab()/moveTo()/release(vel)` (the grab
pipeline); props - kinematic, physics-free entities whose position /
color / size / claim are folded sim state - via `world.createSphere`,
`world.props()/prop(id)`, `world.claim/unclaim/move/paint/despawn`;
pointer input via `world.onpointerdown/move/up(ev)` where `ev` carries
the hit prop plus the raw ray (`WebSG.rayPlane` does plane math for drag
previews) and a prop hit captures the gesture away from box spawning;
cosmetics via generic line entities - `world.createLine({points, color,
opacity, width, worldUnits, shared})` returns a handle whose
points/color/opacity/width the script mutates (and animates) itself,
drawn as fat lines (width in screen px, or world units for wire-like
lines that scale with the camera); `shared` lines are broadcast
latest-wins per (author, id) beside the protocol - never folded, never
hashed - while local ones never leave the client (`world.me.color` is
each peer's deterministic accent color for drawing in) - plus
`world.env` (background/fog/ground) and `world.camera`. Prop motion is
animated client-side (bounce drops, fade-in spawns, pop-out despawns):
the sim stores logical poses, renderers add the juice.

**`examples/dots.js` is dots-3d ported whole into the sandbox** - the
proving example for all of the above. The 3x3x3 board is props; players
race to claim dots as they drag chains (you cannot claim a dot someone
holds - rival chains contest the board dot-by-dot and the timeline
arbitrates); everyone watches everyone else's chain line wave around
live; on release the acting peer computes the outcome (clears, column
drops, refills, stalemate reshuffle) with its own local `Math.random`
and ships it as ops, so no shared randomness or seed sync exists
anywhere. Rollback races are handled in ~15 lines of script
(`revalidate()`: drop chain links you turned out not to own).
`examples/stir.js` shows the primary-guard pattern for ambient logic.

Remaining WebSG API gaps against thirdroom's surface: materials,
lights, arbitrary meshes, UI canvases, the action bar, and ECS component
stores are absent (no deterministic backend - the op vocabulary is the
only mutation channel). Collision events would need deterministic
contact extraction from Rapier, which differs across peers inside the
unsettled window; `applyImpulse` would need a new op type to be
foldable. Raw-WASM scripts (thirdroom accepts them alongside JS) are
not supported. Scripts doing tight read-act loops on *unsettled* state
can double-fire across rollbacks; dots sidesteps this by being
event-driven with idempotent one-shots, but a "settled reads only"
dispatch mode is the structural fix if it bites.

For the dev loop, `/mock.html?room=x` is a mock widget host: the real
`ClientWidgetApi` against an in-memory widget driver whose room state is
replicated across tabs via BroadcastChannel, with a BroadcastChannel
transport standing in for LiveKit. Two tabs mesh exactly like the classic
demo - no Element Web, homeserver, or SFU required - while exercising the
genuine widget handshake (same waitForIframeLoad semantics as EW),
RoomWidgetClient, and MatrixRTC membership machinery, plus an in-memory
MSC4039 media repo gossiped between tabs so scene upload works too. `node
test/mockwidget.mjs` asserts bit-exact convergence through this stack,
late join included; `node test/scene.mjs` runs the full scene flow across
three tabs (upload, live fetch, late-join preload) and asserts the healed
peer converges to the bit; `node test/script.mjs` uploads a world script,
asserts only the primary emits ops (with no divergence), then closes the
primary's tab and asserts the survivor's instance takes over; `node
test/dots.mjs` plays dots for real - uploads `examples/dots.js`, waits
for the board, drags a chain with the mouse, asserts the second tab sees
the claims and the chain line mid-drag, then the clear + refills, all
hash-clean.

To embed for real, serve the app (dev server works: `npm run dev --
--host`) and add it to a room in Element Web with

```
/addwidget http://HOST:5173/?widgetId=$matrix_widget_id&userId=$matrix_user_id&deviceId=$org.matrix.msc3819.matrix_device_id&baseUrl=$org.matrix.msc4039.matrix_base_url&roomId=$matrix_room_id
```

(Element Web substitutes the `$`-templates and appends `parentUrl`
itself.) The lk-jwt-service is discovered element-call style: a
transport advertised by an existing member, else the client well-known,
else the user's homeserver `/.well-known/matrix/client` fetched
directly (a RoomWidgetClient never talks to a homeserver itself, so the
sdk's well-known is usually empty in widget mode); `&lkService=`
overrides all of that. Status: verified END-TO-END against Element
Desktop + matrix.org + livekit-jwt.call.matrix.org - handshake,
capability grant (the widget logs the approved/denied sets, since a
quietly-denied capability presents as a silent hang), OpenID -> SFU JWT
exchange, LiveKit connect, scene upload/download and play. Voice rides
the same LiveKit room: the mic starts muted and is never captured or
published until the first unmute (M toggles, so joining never prompts
for permission by itself), while remote peers' audio always plays -
hearing others needs no mic of your own (the mock host and the ws demo
have no media path, so M just logs there). LiveKit text
streams are not yet end-to-end encrypted - wiring the MatrixRTC key
events into payload encryption is the natural next step. Ghost
`m.call.member`s from killed sessions no longer stall calibration: a
joiner gives seniors 3s to become reachable on the transport, then
writes them off and roots the tick grid itself (a senior that shows up
late triggers a hard resync + boot seam and the room heals); the widget
also leaves the RTC session on pagehide so refreshes stop minting
ghosts. Media uploads cross the widget boundary as memory-backed Blobs:
an `<input>` File is backed by its on-disk path, and the read grant
does not survive the postMessage hop to the host's process (Element
Desktop's upload dies with ERR_ACCESS_DENIED and an empty body).
Upload failures surface the homeserver's `matrix_api_error` detail and
pre-flight the host's media size limit.

Test hooks: `npm run dev` then `node test/smoke.mjs` runs a two-browser
Playwright smoke test (spawn replication plus a laggy drag that must
converge, with identical input logs). `MINUTES=2 BOXES=150 node
test/diverge.mjs` is the divergence stress: one peer on 500ms latency
builds a big pile with tight click grids and drags boxes through it while
the other folds everything via rollback; any disagreement triggers an
automatic bit-level post-mortem (NORM/CAD env vars select the
normalisation mode and cadence). `BOXES=150 node test/perf.mjs` prints the
per-tick cost breakdown for each mode. `node test/latejoin.mjs` settles a
pile on one page, joins a second page late, and asserts the boot seam
bit-converges with no divergence latch (LAT=500 delays the boot so it folds
into the joiner's past). All run headed.

`npm run test:headless` needs no browser and no server: the whole protocol
stack (Session + Sim) runs on an in-process hub with a virtual clock and
per-link one-way latencies, covering laggy drags, late joins, three-peer
meshes, wildly skewed local clocks, ops racing a join, glTF scene
collider swaps (slow-download heal and late-join adoption included), a
sandboxed world script driving the sim through ops, and a backdating
cheater - ~72 virtual seconds, bit-exact assertions, a third of a real
second. The hub delivers messages through a JSON round-trip so wire
serialisation hazards stay exercised.

## How it works

- **Fixed 60Hz tick on a shared grid, by calibration, not wall clocks.**
  Ops carry the tick number they belong to, stamped by their author, and
  every peer folds an op at exactly that tick; within a tick, (joinOrder,
  seq) orders ops, so the timeline's total order is all-integer. What tick
  "now" is comes from a per-peer tick clock: the first peer in a room roots
  the grid at tick 0, a joiner calibrates once against a senior peer's pong
  (which carries the responder's fractional tick reading, corrected by
  half the measured round trip) and then slews toward the current root by
  at most 0.05 ticks per 1Hz pong. Grid phase error never affects
  convergence - ops fold at their stamped tick everywhere regardless - it
  only affects how deep folds run. A 47s-skewed, 200ppm-drifting local
  clock calibrates away to zero grid error in the headless suite. State is
  defined at tick boundaries; rendering interpolates between the previous
  and current tick, one tick behind. At every cadence point (every 10th
  grid-aligned tick by default) the Rapier world (`world.takeSnapshot`),
  the netId to body-handle map, and the grab table go into a 5 second ring
  buffer; a young sim also snapshots its (off-grid) start tick so folds
  have a floor from tick one.
- **Determinism.** Physics uses the `@dimforge/rapier3d-deterministic-compat`
  build (Rapier's enhanced-determinism feature, reproducible across
  platforms). All physics inputs flow through the op timeline and the
  recorded pose tracks: the dragger's own sim is driven by the same
  tick-stamped pose samples it broadcasts, never by raw pointer state.
  Body creation order
  (and hence handle assignment) converges because rollback replays recreate
  bodies in timeline order. Sleeping is disabled on all bodies: the sleep
  timer is per-peer-history dependent, so a peer that rolls back a lot puts
  bodies to sleep later than one that steps live.
- **Normalisation: every cadence tick steps a freshly restored world.**
  Rapier's `takeSnapshot` serializes gravity, integration parameters,
  islands, broad/narrow phase, bodies, colliders, and joints, but `step()`
  also consults the PhysicsPipeline and CCD solver, which are NOT
  serialized. A restored world gets fresh copies of those, so a peer folding
  interactions in via rollback carries different solver-internal state than
  one stepping continuously; usually pose-neutral, but under contact stress
  it changes constraint outcomes and identical inputs still diverge. So the
  restore path is made THE path: at every cadence point (every 10th
  grid-aligned tick by default, `?cad=K` to change, `?cad=1` for every
  tick), the world is snapshotted into the history ring and immediately
  freed and restored from those bytes before stepping. Rollbacks round down
  to a cadence point, so a replay performs restores at exactly the ticks
  the live path performed them: live stepping and rollback replay are the
  same operation by construction. Measured cross-peer agreement:
  bit-identical through 2 minutes of ~140 boxes, 500ms one-sided latency,
  and ~1400 rollbacks, at cadence 1 and cadence 10.
- **Restore is not just a pipeline reset (refuted experiment).** If the only
  effect of restoring were fresh PhysicsPipeline/CCDSolver objects, one
  could skip serialization and just replace those two (they are what
  `world.step()` consults beyond the serialized components). `?norm=pipeline`
  does exactly that, and it diverges under the stress test within seconds;
  a single page even fails byte-level replay verification. Serialization
  additionally CANONICALISES the in-memory representation of the serialized
  components (orderings that change floating-point summation), and stepping
  is sensitive to the representative, so the serialize+restore round trip
  itself is the normaliser and cannot be skipped, only amortised via the
  cadence. A rapier fork that merely serialized the pipeline would
  therefore not enable restore-free rollback either; it would have to make
  stepping representation-independent (e.g. canonically sorting
  constraints), which is what enhanced-determinism does across platforms
  but not across build histories of the same world.
- **Snapshot bytes are never comparable across peers.** Rapier serializes
  two per-step u32 counters (broad-phase section); a folding peer steps
  more times in total than a live-stepping peer (every replayed tick
  counts), so two peers' snapshots legitimately differ forever even when
  every pose, velocity, and solver outcome is bit-identical. Cross-peer
  hash comparison therefore uses the pose/velocity hash only; byte-level
  checks are local (replay verification), where step counts do line up.
  Perf at 150 settled boxes on an M5 (per tick, 33ms budget): cadence 1 is
  1.5ms (0.26 snapshot + 0.42 restore + 0.63 physics + 0.20 hash), cadence
  10 is 0.89ms with the serialization overhead amortised to ~0.08ms.
- **Divergence detection.** Each tick records a bit-exact hash of every
  body's pose, velocities, and sleep state, on the global tick grid. Peers
  exchange ranges old enough (5.5s, beyond the fold window) that no later
  rollback can rewrite them, and latch the first divergent tick (sync
  column: `=` agree, `≠@N` diverged at tick N). On divergence a replay
  self-check runs automatically and bit-level dumps of the state at the
  divergent tick are stashed on `window.__divergence` for cross-peer
  diffing. "verify replay determinism" runs the self-check on demand: it
  restores a 2s-old snapshot into a scratch world, replays the same
  timeline, and compares poses and snapshot bytes against the live world.
- **Two replication planes.** Discrete ops are `{peer, order, seq, tick,
  type, netId, ...}`, applied locally and broadcast on an ordered reliable
  data channel; sequence numbers dedupe. Continuous drag motion is NOT an
  op: it is a `pose` stream, latest-wins per (entity, author), recorded
  into tick-sorted tracks. The kinematic pin drives each held body from
  its holder's track at the tick being simulated, so replays read the
  poses that belong to that tick however late they arrived: folding an op
  back in also folds in the motion that raced it. Each grab records its
  start tick, so stragglers from an earlier drag of the same box can
  never drive a new one. Why the split: routing every drag sample through
  rollback costs a restore+replay per remote packet; the pose plane pays
  one heartbeat fold per remote peer per 200ms instead, converging to the
  identical bits (the diverge stress folds ~3x less often than when drags
  were ops).
- **Heartbeats: healing and attestation.** Every peer broadcasts a beat
  every 12 ticks. A beat from P folds one whole interval deeper than the
  beat's tick, so every tick gets re-simulated at least once after P's
  poses for it fully arrived (ordered channel: they were sent before the
  beat), converging pose-driven contact outcomes within ~200ms + RTT; the
  fold is skipped when P streamed nothing in the window and holds nothing.
  Beats are also attestations: anything P later stamps before its own last
  beat is a provable history rewrite and earns a strike, however slow the
  link - which replaces any RTT-based staleness heuristic. Ops too old to
  fold (beyond the snapshot window) also strike; ten strikes exclude the
  peer, flagged for an admin to kick.
- **Rollback.** An interaction claiming a past tick restores the snapshot at
  the cadence point at or below that tick and re-steps to the present,
  applying every timeline entry (local and remote) on its tick, so it takes
  effect at the time the sender claimed.
  An op stamped at the current not-yet-simulated tick needs no rollback
  (it is a depth-0 fold: that tick has not run yet); with 60Hz ticks that
  only happens for sub-17ms delivery, so most network RTTs force a genuine
  rollback for every received op. Claimed-future stamps are scheduled for
  their tick (clamped to 500ms ahead). Ops stamped before a peer's own
  start are logged inert at their true tick (the boot seam owns that era),
  which keeps input logs identical across peers with different join times.
  Body handles can change during a replay, which is why the handle map is
  snapshotted alongside the physics state.
- **Rubber-banding.** When a rollback rewrites the present, each mesh keeps an
  error offset (old presented pose minus corrected sim pose) that decays to
  zero over 100ms (tunable in the panel, 0 disables it).
- **Interacting during rubber-band.** Grabbing uses the presented pose as
  truth: the grab teleports the body there locally and in the broadcast, per
  the design. The locally dragged box never rubber-bands; the pointer wins.
- **Contested drags.** A grab is last-writer-wins in timeline order,
  including stealing a grab another peer holds (the loser's pose stream
  stops driving the body identically on every peer). Two users fighting
  over a box produce an honest tug of war; the loser sees it rubber-band
  away. Held bodies are kinematic: the solver integrates them toward the
  holder's pose with a real velocity, so a held box shoves the pile
  properly; release returns the body to dynamic with the author's
  authoritative pose and throw velocity. The pin is velocity-faithful,
  not latest-wins: it approaches the newest sample no faster than the
  hand's measured speed (over a >=6-tick baseline), reading only samples
  stamped at or before the simulated tick so live and healed histories
  agree. Without this, any sample/tick cadence mismatch multiplied the
  held body's instantaneous velocity (a 4:1 mismatch measured 4x, and a
  gentle 0.25 m/s touch ejected a resting box at 1 m/s; now 0.27 m/s,
  the physical floor for an infinite-mass impact at restitution 0.3).
- **Input log.** Every op fed into the local Rapier world is recorded with
  full float precision as `{tick, claimedTick, peer, order, seq, type,
  netId, pos, vel}`. "download input log" saves it as JSON; grab it from two
  peers and diff (sort by tick, order, seq) to see exactly where their
  inputs disagreed. Pose streams are not logged (they are disposable by
  design); the recorded tracks cover the fold window. If the logs match but state hashes differ, the divergence
  is in the engine, not the netcode. Events that are expected to break sync
  (tick jumps after a hard stall, interactions clamped because they predate
  the snapshot window) are logged in the panel as ANOMALY lines and marked in
  the log via claimedTick.
- **Late join.** A joiner requests a boot from the most senior peer it
  connects to. The senior dumps its world as `boot` interactions (full pose,
  velocities and grab state per entity) broadcast to every peer, itself
  included, so the seam is part of the one shared timeline. On the boot
  tick every peer discards its world and rebuilds it from scratch, letting
  the boot entries recreate each body in dump order: the senior's warm
  contact manifolds and warmstart impulses are serialised world state, so a
  reset-in-place there vs a cold create on the joiner steps differently;
  rebuilding from empty on all peers is the only symmetric route, and makes
  post-seam histories bit-identical (verified: a late joiner into a settled
  pile converges to equal per-tick hashes, with and without latency). The
  dump is read from the sender's newest snapshot (state at a declared
  tick), the seam is stamped 12 ticks ahead so no peer's grid has already
  passed it, an empty room still sends a marker op so the seam always
  exists, and every peer re-applies non-boot ops stamped between the dump
  and the seam after the rebuild: ops that race a join survive on every
  peer (the headless suite asserts this). Hash exchange is floored at the
  seam: a joiner neither sends nor compares hashes for ticks it simulated
  before its world was seeded.

## Experiments to try

- Two tabs, fake latency 200ms on one, drag the same box in opposite
  directions and watch the tug of war resolve.
- Throw a box through a stack while another peer is dragging in it.
- Set rubber-band to 0 to see raw rollback snaps, or 1000ms to see the
  correction glide in slow motion.
- Crank fake latency while dragging and watch the pose plane: the remote
  side shows the drag ~RTT late and its contact consequences snap into
  place at each 200ms heartbeat fold.

## Known gaps (deliberate, for now)

- Attestation assumes ordered delivery per author; changing the fake
  latency slider mid-flight can reorder a beat past an op and cause a
  spurious strike (the 10-strike threshold absorbs it).
- An op that folds below the boot dump's snapshot tick after the dump was
  sent is erased by the seam on every peer alike: consistent, but a
  sufficiently laggy op racing a join can still vanish.
- No resync after divergence; the hash column only reports it.
- No kick mechanism; exclusion is local and one-way.
- No entity deletion, no interest management, JSON on the wire: all fine at
  jig scale, all replaceable later.
- Hidden tabs keep simulating via an unthrottled worker heartbeat, but a hard
  stall of more than 2s (debugger pause, machine sleep) still jumps ticks and
  is reported as an ANOMALY rather than repaired.
- Held bodies are infinite-mass kinematic while grabbed: even a slow touch
  transfers (1+restitution) x hand speed to a 1kg box. A force-capped PD
  controller on a dynamic body would give finite hand mass, at the cost of
  a mushier hold.
- Widget mode: the ghost-membership fallback writes seniors off after a
  3s unreachability grace; a genuinely slow senior arriving later means
  a hard resync and a boot seam rather than a clean calibration. One
  unexplained session-start hang was seen with a second client present -
  the capability/membership diagnostics should name it if it recurs.
- Scenes are single-file `.glb` only, colliders are a raw bake of every
  mesh (no OMI_collider / physics extensions, no exclusions), and a
  joiner whose scene preload FAILS joins without colliders and diverges
  on scene contacts until a new scene op arrives; the failure is logged
  but not retried.
- World-script state is per-peer and unreplicated by design (only ops
  replicate): primary-guarded ambient logic restarts from scratch on a
  handover, and a partition can run it on both sides at once (doubled
  effects) until connectivity settles. The sandbox has no clock/network
  access, so a hostile script is bounded to what ops can do - but ops
  are exactly what a hostile PEER can already do, so the trust model is
  unchanged.
- Claims are cooperative, not access control: any peer can force-unclaim
  (needed for ghost cleanup, usable for griefing), and nothing yet maps
  Matrix power levels onto who may claim/move/despawn what. Doing that
  deterministically means feeding ACL changes through the timeline as
  ops (room state arrives at different wall times per peer), with
  Matrix state as the source that stamps them - designed, not built.

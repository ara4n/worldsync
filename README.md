# worldsync

A test jig for experimenting with peer-to-peer multiplayer physics: Three.js
rendering, bitECS entities, Rapier simulation, WebRTC data channels, and
rollback netcode with rubber-band presentation.

Every participant runs their own full Rapier simulation. There is no server
authority: user interactions (spawn, grab, move, release) are timestamped and
broadcast to every peer, and each peer folds remote interactions into its own
history by rolling the physics world back and replaying.

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
wheel zooms.

Test hooks: `npm run dev` then `node test/smoke.mjs` runs a two-browser
Playwright smoke test (spawn replication plus a laggy drag that must
converge, with identical input logs). `MINUTES=2 BOXES=150 node
test/diverge.mjs` is the divergence stress: one peer on 500ms latency
builds a big pile with tight click grids and drags boxes through it while
the other folds everything via rollback; any disagreement triggers an
automatic bit-level post-mortem (NORM/CAD env vars select the
normalisation mode and cadence). `BOXES=150 node test/perf.mjs` prints the
per-tick cost breakdown for each mode. All run headed.

## How it works

- **Fixed 30Hz tick on a global grid.** Tick K covers wall-clock time
  [K*33.3ms, (K+1)*33.3ms), the same window on every peer, so a claimed
  timestamp bins into the same tick everywhere (modulo wall-clock skew).
  State is defined at tick boundaries; rendering interpolates between the
  previous and current tick, one tick behind. At every cadence point (every
  10th grid-aligned tick by default) we snapshot the Rapier world
  (`world.takeSnapshot`), the netId to body-handle map, and the grab table
  into a 5 second ring buffer.
- **Determinism.** Physics uses the `@dimforge/rapier3d-deterministic-compat`
  build (Rapier's enhanced-determinism feature, reproducible across
  platforms). All physics inputs flow through the interaction timeline, drags
  included: the dragger's own sim is driven by the same tick-rate move
  samples it broadcasts, never by raw pointer state. Body creation order
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
- **Interactions, not state.** Each user action is `{peer, seq, t, type,
  netId, pos, vel?, color?}`, applied locally and broadcast on an ordered
  reliable data channel. Sequence numbers dedupe.
- **Timestamps decide what happened when.** `t` is wall-clock epoch ms with
  sub-ms precision (`performance.timeOrigin + performance.now()`; browsers do
  not expose true nanoseconds). The claimed timestamp is trusted as-is to
  place the event in a tick and to order events within a tick, with
  (joinOrder, seq) breaking exact ties so all peers converge on one total
  order. Clock skew is measured (NTP-style ping/pong, minimum-RTT sample) and
  shown in the panel but deliberately not corrected for; the future plan is
  to stamp interactions with a tick number and calibrate tick timelines
  across peers instead.
- **Rollback.** An interaction claiming a past tick restores the snapshot at
  the cadence point at or below that tick and re-steps to the present,
  applying every timeline entry (local and remote) on its tick, so it takes
  effect at the time the sender claimed.
  An interaction claiming a time inside the current not-yet-simulated tick
  needs no rollback (it is a depth-0 fold: that tick has not run yet); with
  30Hz ticks that only happens for sub-33ms delivery, so most network RTTs
  force a genuine rollback for every received interaction. Claimed-future
  timestamps are scheduled for their tick (clamped to 500ms ahead). Body
  handles can change during a replay, which is why the handle map is
  snapshotted alongside the physics state.
- **Rubber-banding.** When a rollback rewrites the present, each mesh keeps an
  error offset (old presented pose minus corrected sim pose) that decays to
  zero over 100ms (tunable in the panel, 0 disables it).
- **Interacting during rubber-band.** Grabbing uses the presented pose as
  truth: the grab teleports the body there locally and in the broadcast, per
  the design. The locally dragged box never rubber-bands; the pointer wins.
- **Contested drags.** A grab or move is last-writer-wins in timeline order,
  including stealing a grab another peer holds. Two users fighting over a box
  produce an honest tug of war; the loser sees it rubber-band away.
- **Staleness (opt-in).** With "enforce staleness limit" ticked, an
  interaction older than `max(250ms, 1.5 * RTT + 120ms)` is dropped and
  counts as a strike; ten strikes and the peer is excluded from the sim,
  flagged in the panel for an admin to kick. It is off by default because a
  dropped interaction is a guaranteed permanent divergence (the sender
  applied what you refused), which gets in the way of determinism testing;
  when off, arbitrarily late interactions fold in as long as they are within
  the 5s snapshot window. Tick "enforce" and untick "lag clock sync too"
  while faking latency to look like a peer backdating history and watch
  yourself get excluded elsewhere.
- **Input log.** Everything fed into the local Rapier world is recorded with
  full float precision as `{tick, claimedTick, t, peer, order, seq, type,
  netId, pos, vel}`. "download input log" saves it as JSON; grab it from two
  peers and diff (sort by tick, t, order, seq) to see exactly where their
  inputs disagreed. If the logs match but state hashes differ, the divergence
  is in the engine, not the netcode. Events that are expected to break sync
  (tick jumps after a hard stall, interactions clamped because they predate
  the snapshot window) are logged in the panel as ANOMALY lines and marked in
  the log via claimedTick.
- **Late join.** A joiner requests a one-shot entity snapshot from the most
  senior peer it connects to.

## Experiments to try

- Two tabs, fake latency 200ms on one, drag the same box in opposite
  directions and watch the tug of war resolve.
- Throw a box through a stack while another peer is dragging in it.
- Set rubber-band to 0 to see raw rollback snaps, or 1000ms to see the
  correction glide in slow motion.
- Uncheck "lag clock sync too" with high fake latency to trigger the
  stale-interaction exclusion path.

## Known gaps (deliberate, for now)

- Convergence still depends on trusted wall clocks: peers whose clocks
  disagree bin events into different ticks. The fix is stamping interactions
  with the tick number and calibrating tick timelines explicitly.
- Late joiners bootstrap from a JSON state dump, not a byte-exact snapshot,
  and miss in-flight interactions; founding peers should agree exactly, a
  late joiner starts merely close.
- No resync after divergence; the hash column only reports it.
- No kick mechanism; exclusion is local and one-way.
- No entity deletion, no interest management, JSON on the wire: all fine at
  jig scale, all replaceable later.
- Hidden tabs keep simulating via an unthrottled worker heartbeat, but a hard
  stall of more than 2s (debugger pause, machine sleep) still jumps ticks and
  is reported as an ANOMALY rather than repaired.

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
Playwright smoke test (spawn replication plus a laggy drag that must converge).

## How it works

- **Fixed 30Hz tick on a global grid.** Tick K covers wall-clock time
  [K*33.3ms, (K+1)*33.3ms), the same window on every peer, so a claimed
  timestamp bins into the same tick everywhere (modulo wall-clock skew).
  State is defined at tick boundaries; rendering interpolates between the
  previous and current tick, one tick behind. Before each tick we snapshot
  the Rapier world (`world.takeSnapshot`), the netId to body-handle map, and
  the grab table into a 2 second ring buffer.
- **Determinism.** Physics uses the `@dimforge/rapier3d-deterministic-compat`
  build (Rapier's enhanced-determinism feature, reproducible across
  platforms). All physics inputs flow through the interaction timeline, drags
  included: the dragger's own sim is driven by the same tick-rate move
  samples it broadcasts, never by raw pointer state. Identical inputs on an
  identical tick grid through a deterministic engine means peers who have
  seen the same interactions should agree exactly; body creation order (and
  hence handle assignment) also converges because rollback replays recreate
  bodies in timeline order.
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
  that tick and re-steps to the present, applying every timeline entry (local
  and remote) on its tick, so it takes effect at the time the sender claimed.
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
- **Staleness.** An interaction older than `max(250ms, 1.5 * RTT + 120ms)`
  (or older than the rollback window) is dropped and counts as a strike; ten
  strikes and the peer is excluded from the sim, flagged in the panel for an
  admin to kick. Uncheck "lag clock sync too" while faking latency to look
  like a peer backdating history and watch yourself get excluded elsewhere.
- **Late join.** A joiner requests a one-shot entity snapshot from the most
  senior peer it connects to.
- **Divergence.** Sims are best-effort deterministic only. A coarse hash of
  quantised positions is broadcast every second; the peer table shows = when a
  peer's sim matches ours (meaningful once things are at rest).

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
- No entity deletion, no interest management, JSON on the wire, snapshots
  every tick: all fine at jig scale, all replaceable later.
- A hidden tab stops simulating and rebases its clock on return rather than
  replaying the gap.

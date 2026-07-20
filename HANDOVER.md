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
  toggles left-drag orbit.
- `input.ts`: click ground = spawn, drag box = grab/move@33ms/release with
  throw velocity, presented-pose grab override.
- `main.ts`: orchestration; frame loop = fold -> advance -> mirror -> render;
  hash exchange, staleness (opt-in), boot, worker ticker for hidden tabs,
  window.__jig test hooks, __divergence stash.
- `ui.ts`: panel (latency slider, lag-pings + enforce-staleness checkboxes,
  rubber-band ms, input-log download, verify button, peer table, log).
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

- JSON on data channels (ordered reliable). JSON round-trips f64 exactly
  except -0 -> 0; emit normalizes -0 (keep this).
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

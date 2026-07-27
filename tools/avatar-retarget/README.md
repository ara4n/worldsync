# Turning a foreign rigged GLB into a worldsync avatar

How `public/avatar-robot.glb` was made from `Robot_Black.glb` (a Third Room
Unity-exporter GLB), and everything learned doing it. The runnable version of
this document is `retarget.mjs` beside this file; read this first, run
that second. The worked example throughout is the robot, but the method is
character-agnostic for any Mixamo-auto-rigged humanoid.

## What worldsync requires of an avatar (the contract)

`src/avatar.ts` binds to nothing character-specific, but it does assume:

- **Skeleton**: the standard Mixamo skeleton, bones named `mixamorig<Name>`
  or `mixamorig:<Name>` (the `bone()` helper accepts both). Head/Neck and the
  arm chains must exist by name: the head-pitch and arm-aim overrides look
  them up directly.
- **Clips inside the same GLB**, resolved by name: `Idle`, `Walk`, `Run`,
  `WalkBack`, `RunBack`, `StrafeLeft`, `StrafeRight`, `StrafeLeftRun`,
  `StrafeRightRun`, `TurnLeft`, `TurnRight`, `Fall1`, `Fall2`. There is no
  clip borrowing from the default asset: `ensureAsset` uses only the loaded
  file's animations. (`Fall3` rides along unused.)
- **Origin at the feet, facing +Z** in bind pose. `buildRig` yaw-flips the
  rig once (`rotation.y = PI`) because the group's yaw-0 forward is -Z.
- **Every clip keys every bone it animates from t=0.** The loader shifts
  Mixamo's 1/30 lead-in, but see gotcha 1 for the subtler version of this.
- Proportions are free (the robot is 1.47m vs the X-bot's ~1.8m), though see
  "open cosmetic issues" at the end.

## The concrete case

- Source character: `Robot_Black.glb`, exported from Unity 6.5 by the
  thirdroom-unity-exporter. 7 skinned meshes, 7 skins over one hierarchy,
  54 joints, no animations.
- Clip source: `public/avatar-default.glb` (thirdroom's X-bot carrying all
  14 clips, built by `tools/avatar-glb.mjs`).

First discovery: the robot's rig IS a Mixamo rig with the `mixamorig:`
prefix stripped (names like `LeftToe_End` are Mixamo-specific). Its 54
joints are an exact subset of the X-bot's 67; the 13 missing are leaf ends
only (eyes, `HeadTop_End`, `*Toe_End`, fingertip `*4` bones), which no clip
needs for skinning. So bone MAPPING is trivial (strip the prefix). Bone
CONVENTIONS are not, which is the whole story below.

## Why the two obvious approaches fail

1. **Copy tracks by bone name.** The X-bot stores a non-identity rest
   rotation on every joint; the Unity export stores near-identity local
   rotations (the pose lives in the translations + inverse bind matrices).
   Absolute quaternion keys from one rig are meaningless in the other's
   local frames: limbs fold. This is exactly the documented failure of the
   `--ybot` experiment in `tools/avatar-glb.mjs` ("legs fold upward").
2. **three's `SkeletonUtils.retargetClip`.** Two problems: it emits track
   names like `.bones[Hips].quaternion`, which `GLTFExporter` cannot map to
   nodes (exported clips silently lose their targets), and its rest-pose
   handling (`localOffsets`) would need per-bone matrices computed by
   exactly the alignment pass described below, at which point you have
   written the retargeter anyway.

## The retarget that works

Everything runs in a browser page (`tools/avatar-retarget/retarget.html`)
against the repo's own three.js, driven by Playwright, so the math executes
on the exact library worldsync renders with.

1. **Map bones** target-name -> source-bone by stripping `mixamorig:?`.
2. **Recover both BIND poses from inverse bind matrices**, not from node
   transforms: joint bind world transform = `inverse(boneInverse)`. In
   three's skinning that identity holds regardless of the mesh's
   `bindMatrix`. Critical because avatar-default.glb's node TRS is some
   animated frame, not a rest pose (all 67 joints carry rotations).
3. **Pose the target's bind skeleton into the source's bind pose** by
   hierarchical direction matching, top-down: for each mapped bone, compare
   each mapped child's bone direction (world, in the pose built so far)
   with the source's bind direction, take the shortest-arc rotation
   (slerp-averaged over multiple children), premultiply it onto the bone's
   world orientation, recompute the subtree. This absorbs T-pose vs A-pose
   and every other rest difference. Call the result the "matched" pose.
4. **Per-bone constant offset** `O_b = inv(srcBindWorldQuat) * matchedWorldQuat`.
5. **Sample each clip at 30fps** through an `AnimationMixer` on the source
   rig. Per frame, per bone, top-down:
   `targetWorldQuat = srcWorldQuat * O_b`, converted to a local quaternion
   under the target parent's already-updated world transform. Bone
   translations stay at bind (proportions preserved); only Hips gets a
   position track: `srcHipsWorldPos * (targetBindHipsY / srcBindHipsY)`
   (0.344 for the robot; without it feet sink or float).
6. **Track names are node paths** (`mixamorigHips.quaternion`,
   `mixamorigHips.position`) so GLTFExporter resolves them.
7. **Rename bones to `mixamorig<Name>`** (colon-free; some loaders strip
   `:` from node names, and colon-free round-trips everywhere), rename the
   tracks to match, export with `GLTFExporter` `{ binary, animations }`.

## Gotchas, in order of pain

1. **Shift source clips to t=0 BEFORE sampling.** Mixamo tracks start at
   t=1/30. Sampling frame 0 at t=0 makes the interpolant clamp to the first
   key, baking a DUPLICATED first frame into every exported clip. Runtime
   consequence: at every loop wrap, three's mixer produces an unchanged
   value through the duplicate zone and skips rewriting the bones, so
   avatar.ts's post-mixer overrides (head pitch, arm aim) premultiply onto
   stale bones and COMPOUND (~29deg/frame at 120Hz), then snap back when
   real keys resume: a one-frame head break, most visible on the constantly
   looping Fall1 while flying. This is the same class of bug avatar.ts's
   load-time shift fixes for avatar-default.glb, but load-time shifting
   cannot fix baked duplicate frames; the retargeter must shift first
   (times arrays are shared between tracks, shift each instance once).
   `wrapcheck.html` exists to regression-test exactly this.
2. **Bind pose != node pose.** Recover rest transforms from
   `inverse(inverseBindMatrix)`; never trust the node hierarchy TRS of an
   animation-carrying GLB (see step 2 above).
3. **Materials tuned for a lit-environment renderer read black here.**
   worldsync has direct lights and no environment map. The Unity export
   carried `baseColorFactor` ~0.084 (a tint that looked right in Unity /
   env-lit viewers): near-black in worldsync. Lift `baseColorFactor` to
   `[1,1,1,1]` after export (a 10-line GLB JSON-chunk patch; keep
   `metallicFactor` 0, metals take nothing from direct diffuse light).
   Same lesson as the silver-not-mirror notes in `tools/avatar-glb.mjs`.
4. **Compressed avatars need the shared loader.** thirdroom.io/pipeline
   outputs `KHR_texture_basisu` (KTX2) in `extensionsRequired`; a bare
   `new GLTFLoader()` refuses the file outright and the figure silently
   never appears (only a panel log line). avatar.ts now loads through
   `glbLoader()` from scene.ts (KTX2/Draco/Meshopt configured at startup).
   Keep it that way for any new loader path.
5. **Do not judge exports in macOS Preview.** Its glb->usdz conversion
   mangles skinned meshes (exploded parts, faceted shading) even when the
   GLB is fully valid. Use a real glTF viewer, the pose-grid, or worldsync
   itself. (The Unity-exporter robot happens to have bind pose == mesh
   pose, so stripping skins yields a Preview-safe static copy if ever
   needed.)
6. **Mixamo leaf-bone gaps are fine.** Tracks for the 13 missing end bones
   are simply not generated (the mapping skips them); nothing warns,
   nothing breaks.
7. **The exporter drops what it doesn't know.** Third Room's `MX_*`
   extensions (background, reflection probes, lightmaps) vanish through
   GLTFExporter. For an avatar that is desirable; don't be surprised.

## Tooling

```
node tools/avatar-retarget/retarget.mjs <character.glb> [out.glb]
```

Retargets, exports, renders a pose grid (7 clips at mid-phase: check for
folded limbs, floating feet, spun heads), and runs the loop-wrap override
check on Fall1/Run/Walk/Idle (fails the build on any post-frame-0 spike).
Playwright is the only dependency beyond the repo's own node_modules.
Remember gotcha 3 (baseColor lift) before shipping the output, then run it
through thirdroom.io/pipeline for KTX2 compression (6.5MB -> ~2.7MB for the
robot) and re-verify in-app: `URL=... node test/avatar.mjs` passes
asset-agnostically, and a shoulder-cam look (`V`) plus a fly (`B`, watches
Fall1 wrap) covers what the tests don't.

## Current state and open cosmetic issues

- `DEFAULT_URL` points at `avatar-robot-opt.glb` (the pipeline-compressed
  build); `avatar-default.glb` remains for `setUrl` swaps. Rebuilding the
  robot means: retarget.mjs -> baseColor patch -> thirdroom.io/pipeline ->
  replace `public/avatar-robot-opt.glb`.
- Camera constants assume a ~1.8m figure: the local-figure hide radius uses
  eye height 1.6 (avatar.ts `update`) and the shoulder cam frames above the
  1.47m robot's head. Functional, but nav.ts/avatar.ts constants deserve a
  scale-aware pass if short/tall avatars become the norm.
- The robot's visor is not emissive (the Unity material exported without
  emission); give the source material emission in Unity if the glow matters.

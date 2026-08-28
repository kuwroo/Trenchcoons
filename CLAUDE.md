# Trenchcoons — agent operating instructions

Open-world driving game. Two raccoons in a trenchcoat in a cardboard box.
Mid-migration from Godot to a WebGPU/Three.js rebuild, on branch `web-rebuild`.

## Read first

- `docs/ART_BIBLE.md` — visual target. Read before touching any shader,
  material, palette, or post effect.
- `docs/ARCHITECTURE.md` — systems, render graph order, conventions, Asset Forge.
- `docs/MILESTONES.md` — the work queue.
- `refs/README.md` — what each reference image governs.

The Godot project at the repo root is the **old** build, kept for assets and
reference. Do not add features to it.

## Stack

WebGPU only (no WebGL2 fallback) · Three.js + TSL · TypeScript strict · Vite ·
Rapier · vanilla Three for rendering, React for Forge/debug UI only.

## The look, in one box

**Genshin Impact's grasslands** — `refs/genshin/grasslands.jpg` is the primary
reference and the tie-breaker. Clean stylised realism: crisp shading, saturated
but not acid greens, flat sculptural rock planes, strong blue atmospheric
perspective, clean gradient skies with thin wispy cloud.

**The painterly direction is ABANDONED.** No brush-stroke overlay on terrain, no
hyper-saturation. It produced a mottled camouflage look that never resolved.
Capy Castaway now governs CHARACTER form language only.

```
Shadows:   coloured and lifted, tinted toward sky. Never grey, never crushed.
Specular:  water, wet surfaces, ice, vehicle paint. Never nature.
Lit surfaces warm ~50deg toward yellow and jump ~0.4 in VALUE while LOSING
           ~0.15 saturation. Measured across the references.
Distance:  blue haze + desaturation. The main fidelity lever.
Forms:     big, readable, sculptural. Flat rock planes.
Sky:       clean gradient, thin wispy cloud. NOT heavy blobs.
Biomes:    must be distinguishable by more than hue — ground, scatter, rock
           form, grass density and light all change together.
```

## Known issue: cast shadows go blue

The most visible fault in the build. Measured on one frame, meadow camera at
noon:

  lit ground          rgb(167,224,95)  H 87  S0.58  V0.88   correct green
  cast shadow pool    rgb( 37, 90,117)  H201  S0.68  V0.46   blue, 114deg off

Shadowed ground takes the SKY's hue rather than a tint of the ground beneath it.
ART_BIBLE §2 requires a bias of about 40 degrees that stays in the material
family; the reference runs lit H99 -> shadow H136, a 37-degree shift.

`npm run complaints` gates this and reports 73 degrees, NOT 114 — it averages
the darkest fifth of the whole frame, so ordinary shading dilutes the pools. The
gate is directionally right and understates the fault; trust the pool
measurement when judging a fix.

Mechanism: in shadow the direct term is ~0, so the surface renders as
albedo x ambient. If ambient carries full sky chroma the albedo is erased. The
fix belongs in how ambient combines with albedo — ambient must TINT, not
replace — and not in any value in assets/defs, which cannot reach this.

## Known issue: the palette only survives in mid-tones

Measured on one frame at the meadow camera (pos 2160,0,-420, eye 6), sampled
across the value range:

  brightest lit   rgb(175,184,188)  H198 S0.07  V0.74   washed to grey
  mid-lit         rgb(109,169,120)  H131 S0.35  V0.66   green, correct
  shadow          rgb( 35, 70,119)  H213 S0.70  V0.45   blue

Material colour only reaches the screen in the middle of the range. Highlights
blow out toward white and lose all chroma; shadows are flooded by blue sky
ambient and lose the albedo's hue entirely.

NO PALETTE VALUE FIXES EITHER END. Two palette corrections were made and
verified present in the defs while the render did not move, because the authored
shadow colour is overwhelmed by ambient and the authored lit colour is
overwhelmed by exposure. Chasing ground colour in assets/defs is the wrong layer
until the lighting pipeline stops crushing both ends.

The two things to fix, in the material and atmosphere rather than the data:
  1. Ambient must TINT the shade, not replace it — §2 says shadows sit about 40
     degrees off the lit hue and stay in the material family. Lit H99 to shadow
     H136 is right; lit H99 to shadow H213 is the albedo being erased.
  2. Highlights must retain chroma. The reference's brightest grass is H73 at
     S0.34, pale but still green; ours reaches S0.07, which is grey.

## Resolved: rocks were buried

Fixed. `src/assets/generators/rock.ts` now derives its lift from the solid's own
measured extent and THROWS if the buried fraction does not match the authored
`embed`, so the bug cannot come back silently. The budget report carries a
`buried` invariant and passes. Left here because the diagnosis was re-derived
from scratch twice.

## Resolved: "distance doesn't read as blue haze"

There was never an engine fault. The gate that reported it ran a camera at
`eye=6` looking along a near hillside -- a frame with no depth range in it, in
which no aerial-perspective term can rotate anything. On a vista the build
scores 111 degrees of hue rotation against the reference's 126. Two further
faults in the same gate: band means were confounded by shadow (shadowed ground
goes blue here, so a shadowed foreground reads as distant -- greybox-noon's
plainly green near hill measured H178), and the metric was unsigned, scoring an
INVERTED ladder as highly as a correct one. See tools/complaints.mjs.

## Known issue: the foreground is too DARK (hue is fixed)

The one failing check in `npm run complaints`. Measured on the median of a
ground-level near band against refs/genshin/grasslands.jpg:

  reference   H78  V0.85
  was         H113 V0.55
  now         H90  V0.63     hue fixed in biomes.ts; VALUE still 0.22 short

**FIVE mechanisms have been tried for the value and every one regresses the gate
suite.** Measured on the same frame and the same 33-shot set. Do not re-run them:

  lever                            fg V   spread   palette  struct  shadow  hue
  baseline                         0.625  0.573    12       28      6       6
  toneGamma 1.27->1.12, exp 1.5    0.698  0.525    20       30      1       6
  BASE_EXPOSURE 1.26 -> 1.45       0.660  0.569    15       29      5       6
  ground.ts FILL 0.12 -> 0.30      0.718  0.490    16       30      3       6
  polynomial low-mid lift, k 0.09  0.687  0.518    19       30      2       6
  GATED LUMA LIFT, k 0.12          0.681  0.616    12       31      6       6
  GATED LUMA LIFT, k 0.28          0.749  0.643    16       31      7       6

The shaped curve the previous note asked for was built and it IS the right shape
— worth re-implementing rather than re-deriving:

    l = luminance(t)
    w = smoothstep(0.18, 0.40, l) * (1 - smoothstep(0.62, 1.0, l))
    out = t * (l + k*w) / l

Three properties, all measured. It holds HUE (H88.7 against the baseline's
H90.0, where a per-channel version drifted to H97 because green sits in the
window's plateau while red is still in its ramp). It holds the SHADOWS, which a
`t*(1-t)^2` polynomial does not — that expression is ~6.75t near black, and at
k 0.09 it pushed ten frames to "NO SHADOW PIXELS AT ALL", i.e. it deleted the
dark anchor. And it INCREASES p05-p95 spread (0.573 -> 0.616) rather than
compressing it, because the plateau is a pure offset.

It still fails, on the one gate nobody expected: STRUCTURE. The window's ramp
(0.18-0.40) has derivative > 1, so it expands local contrast in the darker
tiles, and rock-collision crosses the over-detail ceiling at k as low as 0.12 —
the same ceiling the ground clutter was dialled back for. At k 0.28, where the
value target is finally met, structure goes 28 -> 31.

CONCLUSION: this is not a knob problem. Five independent mechanisms — two
scalars, a fill floor, and two curve shapes — all buy foreground value and all
pay for it in a gate calibrated on refs/. Either the V>=0.75 target is wrong for
this build's look, or several gates need recalibrating together as one decision.
Both are art-direction calls, not tuning. Do not spend another round bisecting a
scalar.

**Do not chase the value in the palette either.** Measured: raising the meadow's
authored base value 0.61 -> 0.80 (+0.19) moved the rendered band 0.547 -> 0.625
(+0.078). That is a compression of about 0.4, so reaching 0.85 would need an
authored value above 1.0. The remainder is exposure and tonemap. This is the
number behind the long-standing "no palette value fixes either end" rule.

Warm and bright must move TOGETHER. Three candidates that warmed the hue with the
value left alone all turned the sunlit slope to dry stubble — warm plus dark is
khaki, not meadow.

SATURATION IS NOT MEASURABLE on this frame and is deliberately not gated. The
brightest-half of the band says the build is over-saturated (0.68 vs 0.56); the
median of the same band says under-saturated (0.66 vs 0.74). The difference is
content, not colour: this build draws instanced blades whose bright lime tips
dominate any brightest-N selection and the reference is painted grass with none.

Ruled out by measurement, so nobody re-derives them:
  * the scatter grass surfaces (`grassMound`, `scrub`) — magenta-ing
    base/shadow/lit on both moves the band only H107 -> H103; grass is a
    minority of it. The band is the terrain ground, shaded by
    `src/terrain/ground.ts`, which is not a `PainterlyMaterial`.
  * `assets/defs/surfaces/meadow.json` — its stops were already right.

Resolved, and worth knowing about as a class of bug: the vertical-gradient term
was dead on every blade of grass in the game. `positionLocal` is
SELF-REFERENTIAL in any material that overrides `positionNode` — grass does, for
wind and crush — so the gradient read the node being defined in terms of it and
evaluated to nothing. Fixed by reading `positionGeometry`, which is also what
the gradient wants (the sweep should be locked to the form, not slide down a
blade as the wind bends it). If you add another material with a `positionNode`,
this is the trap.

## Known issue: close-range ground, partly fixed (structure gate, 28/33)

Mid-distance already passes ABOVE the reference — biome-meadow's near band is
0.0704 against grasslands.jpg's 0.058 — and the deficit is only the last couple
of metres, where the tuft lattice leaves the terrain plane visible between
clumps. `ground-sprig` (three blades, 30 tris, its own 0.30 m lattice in the near
band only) took grass-close from 0.0176 to 0.0250 and the gate from 29 to 28.

**THE WINDOW IS EMPTY — do not just turn the density up.** The gate has a
CEILING as well as a floor, and the two frames pull opposite ways:

  clutter thin   grass-close      near-noon        rock-collision
  1.00           0.0322 passes    0.0943 OVER      0.0943 OVER
  0.86           0.0289 FORMLESS  0.0938 OVER      —
  0.72           0.0275 FORMLESS  0.0912 ok        0.0943 OVER
  0.55 (shipped) 0.0250 FORMLESS  0.0908 ok        0.0907 ok

grass-close needs >=0.031 to clear FORMLESS; near-noon and rock-collision must
stay <=0.0929. Nothing in between satisfies all three at this asset size, so 0.55
is the most that breaches no ceiling. Going further needs a different mechanism —
smaller features rather than more of these — not a bigger number.

Also ruled out by measurement: the ground material's own micro term (0.18 -> 0.45
reached only 0.0074 and pulled `npm run distinct`'s corridor ratio 2.05 -> 1.74),
and near-band tuft density (already at its 3400 cap).

## Known issue: "I don't see tyre marks"

Measured, so nobody re-diagnoses it from scratch:

- Marks ARE stamped world-wide. Probing `__trench.deform` 500 m from the sand
  pan after a short drive finds 23 cells at peak 0.817.
- The main ground material DOES sample the field — `mat('meadow', deform)` in
  greybox.ts, and the ground mesh uses `meadow`.
- The cause is the RESPONSE, not the plumbing. `BIOMES.grass` is
  `maxDepth 0.07` against sand's 0.10 and snow's 0.35, with `refill: 20` — so on
  the default surface a mark is shallow and gone in twenty seconds. ART_BIBLE §4
  authored that on purpose ("grass flattens then springs back over ~20s"), and
  the consequence is that a player driving normally never sees one.

So the fix is an art-direction call about grass, not a bug hunt in src/deform.
Any change here must keep `npm run distinct`'s corridor ratio >= 1.25.

## Invariants — do not break these

- **Units are metres.**
- **NPR, not PBR.** No metal/roughness workflow for nature.
- **Tonemap is gentle filmic with highlight desaturation OFF.** Not AgX — it
  desaturates highlights, the opposite of the target.
- **No `Math.random()` in generation.** Seeded RNG only; determinism is what
  makes the screenshot harness meaningful.
- **Render calls live in `core/renderGraph.ts`.** Don't scatter them.
- **Never block a frame on GPU readback.** Deformation → physics is async.
- **All vegetation samples the one global wind field.** No per-asset wobble.
- **No hardcoded assets.** Every asset is a JSON def in `assets/defs/` driven by
  a Forge generator — including imported and AI-generated meshes.
- **Ambient comes from the sky LUT**, never a constant.
- **The Forge must render exactly like the game.** Both go through
  `graded(surfaceId, params)`. The Forge used to use the raw def while the game
  used the GRADE override — for `stone` that is ambient 4.9 against 1.75 — so
  every rock in the preview was a flat cyan lump and every rock in the game was
  correctly faceted. A whole gauntlet round was then spent respeccing geometry
  that was already right. Grading now happens inside `ScatterLibrary.material()`
  so neither caller has to remember. If you add another viewer, route it there.
- Perf: 16.6ms @ 1080p, <1500 draw calls, <400MB GPU memory.

## Controls — couch co-op (confirmed)

Two players, one keyboard, one car. P1 steers with `A`/`D`; P2 throttles and
brakes with `Up`/`Down`. This is the hook, not a fallback.

## Motion rule

Nothing in this game moves linearly. Every transition — camera, suspension,
body roll, UI, idle — goes through the shared spring/easing utility. A parked
car must still be visibly alive. See MILESTONES M3.

## Verifying visual work

**Before believing a defect, check that the harness renders what ships.** Five
apparatus failures this session (HMR reload, perf measuring a pit, a dead
preview server, concurrent builds, blank `drawImage` on a WebGPU canvas) and a
sixth — the ungraded Forge — each produced a confident, specific, WRONG
diagnosis. The ungraded Forge cost the most: it read as a geometry problem,
came with a plane-area histogram, and was a one-line material bug.

Two habits that caught it:
* **Reproduce the critic's number with your own instrument before acting on
  it.** Matching their ungraded reading exactly (`#adc9c8 H178 luma 0.764`) is
  what proved the instrument sound and left the material as the only variable.
* **Check where a measurement box actually lands.** The two boxes offered as
  "facets 70 deg apart at identical luma" were on the same face. Look at the
  frame.


Screenshots are the feedback signal — not "it compiles".

```
npm run dev        # game (HMR)
npm run shots      # headless capture -> shots/*.png
npm run gate       # palette + shadow + structure + hue + distinct
npm run perf       # frame stability; needs `vite preview`, NOT dev (HMR
                   # reloads mid-measurement and kills the context)
npm run typecheck
```

### The gates are the bar
Each is calibrated so all six images in `refs/` pass. If a gate fails your
output, your output is wrong. **Do not loosen a threshold to pass** — adding new
diagnostic output is fine, moving the bar is not.

Every gate needs a floor AND a ceiling. Three separate one-sided metrics were
gamed during M1: `shadowSat` rewarded navy shadows, `vRange` rewarded crushed
darks, `medStd` rewarded high-frequency noise over brushwork. A one-sided metric
is an invitation to optimise the proxy instead of the goal.

**Prefer subject-vs-control over whole-frame measurement.** A whole-frame metric
cannot tell you whether the thing you care about changed. `tracks-decay` scored
a 19.27 whole-frame difference while its subject moved by nothing; the pair that
replaced it measures inside the tyre corridor against bare sand either side and
requires a ratio (8.65 vs 1.97 = 4.39). A ratio between subject and control
cannot be satisfied by changing everything, which is exactly the loophole every
absolute threshold here has eventually leaked.

**Watch for gates fighting features.** The structure gate's detail floor pushed
a builder to make the M4 sand pan noisier to clear it, and the surface's own
blotches then out-contrasted the tyre marks the pan exists to display. When a
gate and a feature disagree, the gate is usually measuring the wrong region.

Before trusting any new gate, run it against `refs/` first. Three of the five
were mis-calibrated on the first write and only caught that way.

Any world state is reproducible from a URL:
```
?seed=1234&pos=120,8,-340&look=0.3,-0.1&time=0.35&weather=snow&biome=alpine
```

Wait on `__ready` before capturing, or screenshots race the streaming system.

"Done" on visual work means **compared against `refs/`**, not that it ran.

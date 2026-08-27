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

## Known issue: rocks are buried

A modelling critic measured this directly, via mesh spans with assets placed at
y=0 on a ground plane at y=0:

  rock-medium    -1.188 .. 0.612   66% below ground (authored embed 0.16)
  boulder-large  -2.635 .. 0.766   77%
  rock-slab      -0.523 .. 0.071   88%
  rock-slab v1   entirely below ground, renders nothing

`Polytope.box` is centred on y=0, so half the block is under the origin before
`embed` applies. `src/assets/generators/rock.ts` then does `shift = q[1] - drop`
and never adds `+hy`. Every OTHER generator lifts correctly — outcrop's `put`
adds `y0 + hy`, the conifer trunk starts at y0 = 0 — so rock is the outlier.

Flat sculptural rock is the defining form in refs/genshin/grasslands.jpg, so
this costs the world its rock language.

NOT YET FIXED, deliberately. Adding `+hy` typechecks and produced no visible
change in a before/after capture (rock-like pixel share 0.35% either way), which
leaves an unresolved risk: if scatter placement already compensates for the
un-lifted geometry, the lift makes rocks FLOAT instead. Whoever fixes it should
verify against generator mesh spans directly rather than pixels, and check how
the terrain scatter derives its y.

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

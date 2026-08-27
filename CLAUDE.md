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
- Perf: 16.6ms @ 1080p, <1500 draw calls, <400MB GPU memory.

## Controls — couch co-op (confirmed)

Two players, one keyboard, one car. P1 steers with `A`/`D`; P2 throttles and
brakes with `Up`/`Down`. This is the hook, not a fallback.

## Motion rule

Nothing in this game moves linearly. Every transition — camera, suspension,
body roll, UI, idle — goes through the shared spring/easing utility. A parked
car must still be visibly alive. See MILESTONES M3.

## Verifying visual work

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

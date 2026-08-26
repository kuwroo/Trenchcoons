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

**Painterly, hyper-saturated, soft-lit.** Not photoreal, not flat-cel — painted.
Capy Castaway for character style and vibrance; Tohad's cliffs for palette;
Genshin for terrain and foliage forms; Mario Kart for open-world structure,
water driving, and tire tracks.

```
Shadows:   coloured and lifted, tinted toward sky. Never grey, never crushed.
Specular:  water, wet surfaces, ice, vehicle paint. Never nature.
Lit surfaces warm ~50deg toward yellow and jump ~0.4 in VALUE, while LOSING
           ~0.15 saturation. Measured across the references. Do not chase glow
           with saturation — that is what makes it look like acid plastic.
Distance:  haze + desaturation + hue shift toward sky. Never a grey fog lerp.
Forms:     big and simple. Detail lives in the light, not the geometry.
Clouds:    pink and lavender, not white.
```

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

Before trusting any new gate, run it against `refs/` first. Three of the five
were mis-calibrated on the first write and only caught that way.

Any world state is reproducible from a URL:
```
?seed=1234&pos=120,8,-340&look=0.3,-0.1&time=0.35&weather=snow&biome=alpine
```

Wait on `__ready` before capturing, or screenshots race the streaming system.

"Done" on visual work means **compared against `refs/`**, not that it ran.

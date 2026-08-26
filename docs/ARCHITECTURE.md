# Trenchcoons — Architecture

## Decisions already made

| Decision | Choice | Why |
|---|---|---|
| Engine | Three.js (from Godot) | Godot's web export is Compatibility-renderer-only — no compute shaders. Would force a choice between "runs in browser" and "has the target visuals". |
| Graphics API | **WebGPU only** | Chrome/Edge/Safari 26+. Firefox gets an unsupported notice. No WebGL2 fallback. |
| Shading | TSL | Node-based, compiles to WGSL, gives us compute. |
| Material model | **NPR / painterly, not PBR** | Reference board is Capy Castaway + painterly concept art. See ART_BIBLE §3. |
| Language | TypeScript, `strict: true` | Cheapest correctness signal in an agent-driven loop. |
| Bundler | Vite | HMR, two entry points (game + forge). |
| Physics | Rapier (Rust/wasm) | Mature raycast vehicle controller. |
| Scene layer | Vanilla Three, **not** R3F | Reconciler fights GPU-driven rendering and custom render graphs. |
| UI layer | React, forge + debug panels only | Not in the render path. |
| Assets | **Parametric definitions, not baked meshes** | See §"Asset Forge". This is what makes in-game tweaking possible. |

## Conventions

- **Units: metres.** 1 world unit = 1m. Car ≈ 3.2m long.
- **Y-up**, right-handed, `-Z` forward.
- **Time in seconds.** TOD is `0..1`, `0.25` = sunrise, `0.5` = noon.
- **Origin rebasing** past 4km from origin. All systems handle the rebase event.
- Seeded RNG everywhere. No `Math.random()` in generation, ever.

## Directory layout

```
src/
  core/         renderer, render graph, frame loop, clock, origin rebasing, RNG
  atmosphere/   scattering LUTs, aerial perspective, clouds, TOD, sky IBL
  material/     the shared painterly material — ramp, brush overlay, rim, wind
  terrain/      CDLOD quadtree, heightfield compute, climate fields + biome
                classification, splat material, Rapier sync
  deform/       deformation field — toroidal RTs, stamping, decay, readback
  vegetation/   GPU instancing, global wind field, impostor LOD
  water/        lagoon + open-ocean registers, foam, refraction
  vehicle/      Rapier raycast vehicle, per-surface friction, chase camera
  weather/      compute particles, grade blending
  forge/        asset generators, param schemas, Forge UI  <-- see below
  debug/        inspector, perf HUD, URL state codec, screenshot harness
assets/
  defs/         asset definitions (JSON) — the source of truth for every asset
  meshes/       imported GLBs (AI-generated or authored), referenced by defs
docs/  refs/
```

## Render graph order

Centralised in `core/renderGraph.ts`. Do not scatter render calls.

```
1  atmosphere LUTs        (compute; transmittance/multiscatter cached,
                           sky-view per frame)
2  wind field update      (compute, small RT)
3  deformation stamp      (wheel contacts -> deform RTs)
4  deformation decay      (compute, refill toward rest state)
5  vegetation cull + LOD  (compute -> indirect draw buffers)
6  shadow cascades        (4 cascades)
7  depth prepass
8  opaque                 (terrain reads deform RT for displacement)
9  sky + volumetric clouds (quarter-res, temporal upsample)
10 water                  (needs opaque depth + colour)
11 transparent + particles
12 post: bloom -> filmic tonemap -> biome LUT -> chromatic aberration -> vignette
```

Aerial perspective is applied in-shader during 8/10 from the sky-view LUT, not
as a post pass.

**Tonemap note:** gentle filmic with highlight desaturation *off*. Not AgX — it
desaturates highlights, which is the opposite of the target look.

## Asset Forge

Every asset in the game is authored, inspected, and tuned here. Nothing is
hardcoded and nothing bypasses it.

### The core idea: assets are parameters, not meshes

An asset definition is JSON in `assets/defs/`:

```jsonc
{
  "id": "conifer-alpine-01",
  "version": 4,
  "type": "procedural",          // or "mesh" for imported GLB
  "generator": "conifer",
  "params": { "height": 8.4, "tiers": 6, "droop": 0.3, "trunkLean": 0.08 },
  "material": { "baseColor": "#3F7A2E", "tipColor": "#7FB53C",
                "shadowTint": "#2A4F6E", "brushStrength": 0.35, "windStiffness": 0.6 },
  "lod": { "auto": true, "impostorFrom": 120 },
  "biomes": ["alpine", "forest"],
  "seedJitter": { "height": 0.2, "droop": 0.15 }
}
```

A **generator** is a typed function `params -> geometry`. Its param schema is
declared alongside it, which gives three things for free: the Forge UI
auto-builds its sliders, the LLM knows exactly what it may change, and edits are
validated before they render.

This is the design choice that makes "tweak each one in the game" work at all.
Baked GLBs would mean round-tripping through a DCC tool for every adjustment.

### Generators

`src/forge/generators/` — conifer, broadleaf, bush, grass-tuft, reed, cactus,
palm, rock, cliff, log, fence, prop. Each exports `{ schema, generate, preview }`.

### Imported and AI-generated meshes

GLBs from Meshy / Tripo / Rodin / Hunyuan3D enter through the Forge as `"type":
"mesh"` defs. On import the Forge: normalises pivot and scale to the metre
convention, generates LODs and an impostor, strips PBR maps, and reassigns the
shared painterly material. Their params are limited to material, scale, and
variant — but they live in the same registry, use the same inspector, and are
tweakable in-game exactly like procedural assets. One pipeline, no exceptions.

### The Forge UI

Separate Vite entry at `/forge`, sharing the game's renderer, sky, and material.

- Asset browser over `assets/defs/`
- Viewport running the **game's actual atmosphere and post**, with TOD scrubber
  and biome-preset backdrops — WYSIWYG or the tool is useless
- Param panel auto-generated from the generator's schema
- **Prompt box** — natural language → LLM returns a *param patch* → shown as a
  diff → accept or reject. It edits parameters, never geometry directly, so
  every change is reviewable and revertable. If a request genuinely can't be
  expressed in the schema, it proposes a generator code change instead — a
  larger, explicitly-reviewed step.
- Variant grid — seed × param jitter, pick favourites
- Budget readout: triangles, draw calls, texture memory, LOD chain
- **Silhouette check** — flat-black render at LOD2 distance, enforcing the
  ART_BIBLE "big shapes, restrained detail" rule mechanically

### In-game tweaking

Dev overlay: hover any instance → its def opens in an inline panel built from
the same schema and the same React components as the Forge → live edit → writes
back to the JSON. The Forge and the in-game inspector are one codebase.

## Biome classification

Biomes are **derived from continuous climate fields**, never painted as regions.
See ART_BIBLE §5.

```
elevation   = heightfield
temperature = f(elevation, polarAxis) + noise
moisture    = f(distanceToWater) + noise
coastality  = f(distance to sea level)      // independent of climate
```

`classify(temperature, moisture, elevation) -> weights[]` returns normalised
weights over the biome set, keeping the top 3. Everything downstream — splat,
scatter density, fog colour, fog density, grade LUT, surface friction — lerps on
those same weights. One weight vector, many consumers; they cannot desync.

There is no transition-band code path. Ambiguity in the classification *is* the
transition, and its width follows from how fast the fields vary.

**Beach is applied after classification**, driven by `coastality`, and inherits a
tint from the dominant neighbouring land biome so a polar beach reads colder than
a temperate one.

Consequence worth stating: impossible adjacencies are impossible by construction.
Desert cannot border snow, because the fields must pass through the intervening
temperatures. No adjacency graph to maintain.

## The deformation field

Signature system. Touches terrain, physics, weather, and vegetation.

**Storage.** Toroidal RTs that scroll with the player, so cost is bounded
regardless of world size. Two tiers:

- **Near field** — 2048², 256m coverage, full update rate
- **Committed** — 1024², 2km coverage, retains marks outside the near field

Marks promote near→committed as the player leaves, demote back on return.

**Channels.**

| | |
|---|---|
| `R` | height displacement (metres, signed) |
| `G` | disturbance mask (0 pristine → 1 fully disturbed) |
| `B` | wetness / compaction |
| `A` | age (drives decay rate) |

**Write.** Oriented quads stamped at each wheel contact, direction from wheel
forward, intensity from `slipRatio * normalLoad`. Hard cornering must visibly cut
deeper than cruising — that feedback is what makes the system feel alive.

**Read — three consumers:**

1. Terrain **vertex** shader displaces by the height channel
2. Terrain **fragment** shader blends the disturbed material via the mask
3. **Physics** samples it for friction and rolling resistance

Consumer 3 is what makes this a mechanic rather than a decal system. It reads a
CPU-side mirror updated by async readback — never block a frame on `mapAsync`.

**Decay.** Per-biome rates driven by the age channel (ART_BIBLE §4): snow ~90s,
sand ~8s, mud effectively permanent. Rain sets a global accelerated decay.

## Determinism and the agent loop

**URL state codec** (`debug/urlState.ts`)
```
?seed=1234&pos=120,8,-340&look=0.3,-0.1&time=0.35&weather=snow&biome=alpine
```

**Screenshot harness** (`debug/shots.ts` + Playwright) — a fixed set of named URL
states, loaded headless, captured, diffed against `refs/`.

The renderer exposes a `__ready` promise resolving only when all LUTs, terrain
chunks, and instance buffers for the current view are resident. Without it,
screenshots race the streaming system and diffs are noise.

## Performance budget

- **16.6ms** at 1080p on an M-series Mac or mid-range discrete GPU
- **< 1500 draw calls** — everything instanced or indirect
- **< 400MB** GPU memory
- Volumetric clouds at quarter res, temporally upsampled
- Terrain collision synced to Rapier only within 200m

## Migrating from the Godot build

Carries over: GLBs in `assets/`, audio in `audio/`, the car feel constants from
`scenes/car.gd` (max_speed 35, accel 60, friction 8, turn 4.5), and the island
design intent in `scripts/world_gen.gd`'s header comment.

Everything else is rewritten — ~150 lines of real logic. `world_gen.gd` was a
stub that only ever built one plane.

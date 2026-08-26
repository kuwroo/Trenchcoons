# Trenchcoons — Milestones

Work queue. One at a time, each ending in a screenshottable, diffable state.

**Ordering principle: atmosphere before terrain.** A greybox world under correct
atmosphere already reads like the references. A detailed terrain under a bad sky
does not. Atmosphere also lights everything downstream.

**Second principle: the asset definition format exists from M1.** Even before the
Forge UI is built, nothing is ever hardcoded — every prop, rock, and tree is a
JSON def from the very first one. Retrofitting that later would mean rewriting
every asset.

---

## M0 — Skeleton
- Vite + TS strict + Three WebGPU booting to a cleared frame
- `core/renderGraph.ts` with pass order stubbed
- Deterministic clock, seeded RNG, URL state codec
- `__ready` promise contract
- Playwright screenshot harness, `npm run shots`
- Perf HUD (frame time, draw calls, GPU memory)

**Done when:** `npm run shots` gives byte-identical PNGs across two runs at the
same seed.

## M1 — Atmosphere + painterly material
The biggest fidelity lever. Built against a greybox world.
- Transmittance + multiscatter LUTs (cached), sky-view LUT (per frame)
- Aerial perspective in-shader; **haze + desaturation + hue shift**, not grey fog
- TOD driver, sky IBL feeding ambient
- The shared painterly material: 3-stop ramp, vertical gradient, triplanar brush
  overlay, sky-tinted rim
- Post chain: bloom → filmic (highlight desat OFF) → LUT → chromatic aberration
- Volumetric clouds, quarter-res + temporal upsample. **Clouds are pink/lavender.**
- Asset definition format + loader (no UI yet)

**Done when:** greyboxed forms at `time=0.25/0.5/0.75` read as convincingly lit
painterly scenes, and the saturation matches `refs/painterly/cliffs-tohad.jpg`.

## M2 — Terrain
- CDLOD quadtree chunking, origin rebasing
- Heightfield from layered noise in compute
- Continuous climate fields: temperature, moisture, coastality
- `classify()` → top-3 biome weights; splat, fog, grade, scatter all lerp on them
- Six biomes per ART_BIBLE §4; beach applied post-classification from coastality
- Snow landform: smooth low-frequency noise with deliberate dark rock ridges
  punching through (ART_BIBLE §4, alpine)
- Rapier collision heightfield within 200m

**Done when:** driving one straight line crosses grassland → snowfield → beach →
sea with no visible seam, and the same line in another direction gives
grassland → desert → beach → sea. No hand-authored transition anywhere.

## M3 — Vehicle
- Rapier raycast vehicle, tuned from the Godot feel constants
- Chase camera — spring arm, velocity lookahead, FOV punch. (The Godot build
  called `look_at` every physics frame with no smoothing. Don't port that.)
- Per-surface friction from the splat map at each wheel contact
- Engine audio, pitch by speed

**Done when:** grass, snow, sand, road, and mud each feel distinct to drive on
without looking at the screen.

## M4 — Deformation field ★
See ARCHITECTURE §"The deformation field".
- Toroidal near-field (2048²/256m) + committed (1024²/2km)
- Oriented wheel stamping, intensity by `slipRatio * normalLoad`
- Vertex displacement + fragment material blend
- Async readback → physics friction feedback
- Per-biome decay rates

**Done when:** you can carve a path across snow, drive 500m away, return, and
find your tracks — and driving in your own rut feels different from fresh snow.

Validate wet sand against `refs/mkw/beach-wet-sand-tracks.jpg` first — it's the
most literal reference on the board.

## M5 — Asset Forge ★
Before vegetation, because vegetation is its first real consumer.
- Generators: conifer, broadleaf, bush, grass-tuft, reed, cactus, palm, rock,
  cliff, log, fence, prop — each with a declared param schema
- `/forge` route: browser, viewport with the game's real sky + post, TOD scrubber,
  biome backdrops
- Auto-generated param panel from schema
- Prompt box → LLM returns a param patch → diff → accept/reject
- Variant grid (seed × jitter)
- Budget readout + silhouette check at LOD2 distance
- In-game inspector overlay sharing the same schema and components

**Done when:** a tree can be created, tuned by prompt, saved, seen in-world, and
re-tuned from inside the game — without touching code.

## M6 — Vegetation
- GPU instance generation per chunk, biome-weighted scatter from Forge defs
- Compute cull + LOD → indirect draw
- Global wind field RT; everything samples it
- Grass bends away from the vehicle (reuses the deform RT)
- Tree impostors at distance

**Done when:** a gust visibly crosses the field and grass, leaves, and reeds all
respond to the same wave.

## M7 — Water
Two registers, blended by depth:
- **Lagoon** (Capy Castaway) — opaque turquoise, painted foam blobs, visible
  submerged terrain
- **Open ocean** (MKW) — foam wake, sun glitter path
- Shallow-water driving: spray, drag, instant mark erasure

## M8 — Weather
- Compute particles: rain, snow
- Weather → grade blending
- **Rain washes marks away; snowfall refills ruts.** Highest-value systemic
  tie-in available — don't defer it.

## M9 — AI mesh ingest
- Meshy / Tripo / Rodin / Hunyuan3D GLB import into the Forge
- Auto-LOD + impostor bake, pivot/scale normalisation, PBR strip, painterly
  material reassignment
- Validation against the metre convention and budget

---

## Open questions

- **2-player couch co-op?** The Godot build had one player steering (A/D) and
  another accelerating (arrows). Distinctive hook, but it constrains the input
  layer. **Decide before M3.**
- Characters and animation — not scheduled yet.
- Any actual game loop: objectives, progression, the driving-licence premise.

## Reference gaps

- Trenchcoat / cardboard box concept art — the raccoon style is settled from
  `refs/character/`, but the coat and box are not.

Snow and biome transitions are both resolved (`refs/snow/`, ART_BIBLE §5).

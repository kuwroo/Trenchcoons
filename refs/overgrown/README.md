# Overgrown portfolio — primary visual guide (everything except sky)

Trenchcoons takes its **meadow / countryside look** from:

`/Users/chloeongsiyi/overgrown-portfolio`

**Exception: the sky.** Sky colour, clouds, and the sky LUT stay on Trenchcoons’
`Atmosphere` / ToD system. Do not import overgrown’s `skybox.ts` cloud field or
equirect background.

## What overgrown governs here

| Domain | Overgrown source | Wired into |
|---|---|---|
| Ground / grass palette | `src/grass/defaults.js` (`grassColor`, `groundColor`) + `groundTextures.ts` | `BIOME_STYLES.meadow` / `.forest` stops; grass tint in `src/world/grass.ts` |
| Fog / haze chromaticity | `fogColor #d0eafc`, soft bright blue haze | biome `fog` / `fogDensity` (haze grade — not sky fill) |
| Warm key light | `sunIntensity`, `sunTint`-class `#ffe8a0`, elev ~28° feel | biome `sunTint` + `ambient` (Atmosphere directional grade) |
| Trees / bushes / rocks / pebbles | `landscapePopulate.ts` `NATURE_CATALOG` | `qn-*` scatter defs via `npm run nature:import` |
| Understory clustering | bushes around tree patches | `UNDERSTORY_IDS` × `groveAt` in `scatter.ts` |
| Grass carpet | `GrassField` uniform density over 240 m, near+far LOD fade (not camera-radius thinning) | `src/world/grass.ts` — same window, no `BAND_THIN` rings |
| Dirt paths | `pathCurve.js` main/cross/spur + dirt alpha envelopes | `src/world/pathCurve.ts` + ground dirt blend + grass/scatter clearance — **meadow & forest only** (gated by baked `pathLand` / `pathLandAt`) |

## What to read there

| Path | Role |
|---|---|
| `src/grass/defaults.js` | Olive grass/ground, fog, sun angles/intensities |
| `src/app/environment.ts` | Lights, fog hex, warm sun colour (ignore skybox setup) |
| `src/app/groundTextures.ts` | Light olive meadow floor + sandy dirt |
| `src/systems/landscapePopulate.ts` | Quaternius catalog + placement heuristics |
| `src/app/World.ts` | Live density counts |
| `docs/ATTRIBUTION.md` | Quaternius CC0 |

## Import trees / props

```
NATURE_DIR=/Users/chloeongsiyi/overgrown-portfolio/public/models/stylized-nature \
  npm run nature:import
```

Writes `assets/meshes/qn-*.json` for the Forge `imported` generator.

## Attribution

Quaternius — Stylized Nature MegaKit (Standard), CC0 1.0.  
https://quaternius.com

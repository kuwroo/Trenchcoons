# Trenchcoons

Two broke raccoons in pursuit of a driving licence end up on their most
treacherous test yet. Couch co-op: one keyboard, one cardboard box, two players
who have to agree on where they are going.

**Currently mid-rebuild** from Godot to a WebGPU/Three.js open world. The Godot
project still sits at the repo root for reference; the live work is the web
build on branch `web-rebuild`.

## Play it

Requires a WebGPU browser — **Chrome, Edge, or Safari 26+**. Firefox is not
supported; there is deliberately no WebGL2 fallback (see `docs/ARCHITECTURE.md`).

```
npm install
npm run dev          # then open http://127.0.0.1:5173
```

| | |
|---|---|
| **Player 1** | `A` / `D` — steer |
| **Player 2** | `Up` / `Down` — throttle and brake |
| Solo | `WASD` or arrows, all four |

Two players, one keyboard, one car. This is the hook rather than a fallback:
every change in surface grip becomes a negotiation between two people, which is
what the deformation system is ultimately for.

## Useful URLs

Any world state is reproducible from the address bar, which is what makes the
screenshot harness meaningful:

```
?seed=1234&pos=120,8,-340&look=0.3,-0.1&time=0.35&weather=snow&biome=alpine
?car=0                     free camera, no vehicle
?freeCam                   detach the chase camera
?drive=throttle:0-200,steer:40-200&frame=170     scripted-input replay
```

`time` is 0..1 — `0.25` sunrise, `0.36` mid-morning (the hero state), `0.5`
noon, `0.75` dusk.

## What works today

- Painterly WebGPU renderer: atmospheric scattering sky, pink-lavender clouds,
  aerial perspective, one shared NPR material, filmic post with chromatic
  aberration
- Procedural rolling terrain with scattered conifers and rocks
- Couch co-op kart on raycast suspension — per-wheel springs, body roll and
  pitch from acceleration, squash-and-stretch, wheel slip, and an idle state
  where a parked car still breathes
- Chase camera with velocity lookahead and FOV punch
- Locked 60fps at 1080p, verified over 12s runs on a production build

## Not there yet

- **Tire tracks and snow paths** — the deformation field is in progress
- Biomes are not yet climate-driven; the world is one grassland
- No game loop, objectives, or the driving-licence premise
- Raccoon characters are placeholder blobs; no rigging

## Development

```
npm run dev         game, with hot reload
npm run typecheck
npm run shots       headless capture -> shots/*.png
npm run gate        palette + shadow + structure + hue + distinct + regress
npm run perf        frame stability (needs `vite preview`, NOT dev — HMR
                    reloads the page mid-measurement)
```

### The gates

`tools/*.mjs` measure rendered output against the images in `refs/` and are
calibrated so every reference passes. They exist because "looks about right" is
not reviewable, and because an agent loop needs a signal it cannot argue with.

Two rules learned the hard way, both in `CLAUDE.md`:

1. **Every gate needs a floor and a ceiling.** Four one-sided metrics were
   satisfied while the picture got worse — `shadowSat` rewarded navy shadows,
   `vRange` rewarded crushed darks, `medStd` rewarded high-frequency noise.
2. **Run a new gate against `refs/` before trusting it.** Three of six were
   mis-calibrated on first write and only caught that way; one of them would
   have failed the master palette reference it was written to protect.

And a third that no amount of tooling replaces: **the gates are bug-detectors,
not art directors.** A config satisfying every metric can still look wrong. Look
at the picture.

## Docs

| | |
|---|---|
| `docs/ART_BIBLE.md` | the visual target, per-biome palettes, measured colour rules |
| `docs/ARCHITECTURE.md` | render graph order, conventions, the deformation field, the Asset Forge |
| `docs/MILESTONES.md` | work queue, M0 through M9 |
| `refs/README.md` | what each reference image governs |

## Credits

Kuwro — Lead developer, Concept Artist, Worldbuilding, 3D Artist, Rigger
Jammjace — Lead developer, Sound Designer, Level Design, Rigger

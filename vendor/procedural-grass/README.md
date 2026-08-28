# Procedural Grass — Three.js Prototype

> **Vendored into Trenchcoons** at `vendor/procedural-grass/` from
> `~/procedural-grass` (2026-08-28). **Now the in-game grass path.**
>
> Ported to WebGPU/TSL in `src/world/grass.ts` +
> `src/vegetation/grass/` (crossed silhouette cards, `public/grass-clump.png`,
> synced field wind, kart push/flatten, biome density). This folder stays as
> the WebGL reference prototype.

High-fidelity interactive grass field prototype based on the **NotebookLM: Three.js Procedural Grass — Agent Research Pack** recipes:

- `InstancedMesh` tapered blades (Bezier lean, root→tip UVs)
- Jittered-grid placement + density noise + slope mask
- Multi-layer wind (global / gust / turbulence) with per-instance phase
- Player interaction via `uPlayerPos` radial push + flatten (root-locked)
- Opaque stylized blades (no transparent sort tax)

## Run locally

```bash
cd ~/procedural-grass
npm install
npm run dev
```

Open the URL Vite prints (default **http://localhost:5173**).

## Controls

| Input | Action |
|-------|--------|
| **W A S D** / arrows | Move player through grass |
| Mouse drag | Orbit camera |
| Scroll | Zoom |
| Density slider | Rebuild field density |
| Wind slider | Wind strength |

## Stack

- Three.js (WebGL)
- Vite
- Vanilla ES modules (no R3F)

## Notes

- Blade budget auto-scales with CPU cores (~70k–140k).
- Interaction is GPU-only (shader uniforms), matching the notebook “few colliders” path.
- For trails / many actors, upgrade to an influence render-target (see notebook player–grass brief).

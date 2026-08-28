# PROTOTYPE SNAPSHOT v2 — Three.js Procedural Grass
# Path: ~/procedural-grass
# Run: cd ~/procedural-grass && npm run dev → http://localhost:5173/
# Updated: 2026-07-16 (silhouette clumps + final look)

## Final design (user-approved direction)

### Geometry
- **Each instance = ONE grass clump** like Vecteezy vector icon (silhouette cutout)
- **Crossed cards @ 90°** so edge-on view still reads as a tuft
- Random yaw per instance for full-orbit coverage
- Far LOD: same silhouette, larger / sparser, smooth translucent fade

### Silhouette / alpha
- `public/grass-clump.png` — offline cleaned alpha (green key + flood fill + morph close)
- `public/grass-clump-ref.jpg` — original white-bg icon
- `src/grassSilhouette.js` — runtime bg removal fallback + procedural icon
- Shader: `uAlphaMap` + `uAlphaCutoff` discard

### Colour
- Flat fill `uGrassColor` (minimal world patch noise)
- Soft mint Ghibli greens by default
- Avoid dark random blades (albedo floors)

### Wind (Ghibli field waves)
- Synchronized rolling waves along wind dir, high uSync
- Soft translucent LOD fade (not dither noise)

### Player interaction
- Radial push + flatten
- Shadow on pushed-down grass (darker mint, not pure black)
- Soft green contact shadow disc under player

### Sun
- DirectionalLight + sun disc visual
- Custom shader must receive uSunDir / uSunColor / uSunIntensity
  (ShaderMaterial ignores Three.js lights)

### Settings
- Control panel + localStorage autosave
- F2 / Save as project defaults → src/defaults.js via vite middleware

### Key files
| File | Role |
|------|------|
| main.js | Scene, player, sun, panel, save |
| grassField.js | InstancedMesh near+far, scatter |
| grassMaterial.js | Wind, interact, silhouette alpha, sun, LOD |
| bladeGeometry.js | Silhouette card / cross geometry |
| grassSilhouette.js | Alpha texture generation + load |
| noiseTexture.js | Soft patch colour noise |
| public/grass-clump.png | Clean silhouette asset |

### Run
```bash
cd ~/procedural-grass
npm install
npm run dev
```

### Agent notes
- Do NOT use multi-blade 3D card fans for near grass anymore — silhouette clump only
- Cross geometry required for perpendicular camera views
- Prefer grass-clump.png over jpg for cutout quality


========================================================================
# FILE: README.md
========================================================================

# Procedural Grass — Three.js Prototype

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


========================================================================
# FILE: package.json
========================================================================

{
  "name": "procedural-grass",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite --host --port 5173",
    "build": "vite build",
    "preview": "vite preview --host --port 5173"
  },
  "dependencies": {
    "three": "^0.178.0"
  },
  "devDependencies": {
    "vite": "^7.0.0"
  }
}


========================================================================
# FILE: vite.config.js
========================================================================

import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname));

function writeDefaultsModule(settings) {
  const defaultsPath = path.join(root, 'src', 'defaults.js');
  const jsonPath = path.join(root, 'src', 'defaults.json');

  // Coerce numeric-looking strings for stable defaults object
  const coerced = {};
  for (const [k, v] of Object.entries(settings)) {
    if (typeof v === 'boolean') coerced[k] = v;
    else if (typeof v === 'number') coerced[k] = v;
    else if (typeof v === 'string' && v !== '' && !Number.isNaN(Number(v)) && !v.startsWith('#')) {
      coerced[k] = Number(v);
    } else {
      coerced[k] = v;
    }
  }

  fs.writeFileSync(jsonPath, JSON.stringify(coerced, null, 2) + '\n');
  fs.writeFileSync(
    defaultsPath,
    `/** Auto-saved panel defaults — do not edit by hand; use "Save as project defaults". */\n` +
      `export const DEFAULTS = ${JSON.stringify(coerced, null, 2)};\n`
  );
  return coerced;
}

function saveDefaultsPlugin() {
  return {
    name: 'save-defaults',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url === '/__save-defaults' && req.method === 'POST') {
          let body = '';
          req.on('data', (chunk) => {
            body += chunk;
          });
          req.on('end', () => {
            try {
              const settings = JSON.parse(body);
              const saved = writeDefaultsModule(settings);
              res.statusCode = 200;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ ok: true, count: Object.keys(saved).length, settings: saved }));
              // trigger HMR for defaults consumers
              const mod = server.moduleGraph.getModuleById(path.join(root, 'src', 'defaults.js'));
              if (mod) server.reloadModule(mod);
            } catch (err) {
              res.statusCode = 400;
              res.end(JSON.stringify({ ok: false, error: String(err) }));
            }
          });
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [saveDefaultsPlugin()],
  server: {
    host: true,
    port: 5173,
  },
});


========================================================================
# FILE: index.html
========================================================================

<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Procedural Grass — Three.js Prototype</title>
    <link rel="stylesheet" href="/src/style.css" />
  </head>
  <body>
    <canvas id="c"></canvas>

    <aside id="panel" class="panel">
      <header class="panel-header">
        <div>
          <h1>Grass Control Panel</h1>
          <p class="sub">WASD move · drag orbit · scroll zoom</p>
        </div>
        <button type="button" id="panelToggle" class="icon-btn" title="Collapse">▾</button>
      </header>

      <div id="panelBody" class="panel-body">
        <div id="stats" class="stats">—</div>

        <!-- WIND -->
        <section class="section">
          <div class="section-head">
            <h2>Wind</h2>
            <label class="toggle">
              <input type="checkbox" id="windEnabled" checked />
              <span>On</span>
            </label>
          </div>

          <div class="wind-compass-wrap">
            <canvas id="windCompass" width="140" height="140" aria-label="Wind direction"></canvas>
            <div class="wind-compass-meta">
              <div>Dir <strong id="windAngleLabel">45°</strong></div>
              <div class="hint-sm">Drag dial or use angle</div>
            </div>
          </div>

          <p class="section-note">Ghibli-style: long synchronized waves roll across the field</p>
          <label class="ctrl">
            <span>Direction</span>
            <input id="windAngle" type="range" min="0" max="360" step="1" value="45" />
            <em id="windAngleVal">45°</em>
          </label>
          <label class="ctrl">
            <span>Strength</span>
            <input id="windStrength" type="range" min="0" max="2.5" step="0.05" value="1.15" />
            <em id="windStrengthVal">1.15</em>
          </label>
          <label class="ctrl">
            <span>Field breath</span>
            <input id="windGlobal" type="range" min="0" max="2" step="0.05" value="0.55" />
            <em id="windGlobalVal">0.55</em>
          </label>
          <label class="ctrl">
            <span>Rolling waves</span>
            <input id="windGust" type="range" min="0" max="2.5" step="0.05" value="1.35" />
            <em id="windGustVal">1.35</em>
          </label>
          <label class="ctrl">
            <span>Micro flutter</span>
            <input id="windTurb" type="range" min="0" max="1.5" step="0.05" value="0.18" />
            <em id="windTurbVal">0.18</em>
          </label>
          <label class="ctrl">
            <span>Wind speed</span>
            <input id="windSpeed" type="range" min="0.2" max="3" step="0.05" value="0.85" />
            <em id="windSpeedVal">0.85</em>
          </label>
          <label class="ctrl">
            <span>Wave length</span>
            <input id="waveScale" type="range" min="0.08" max="1.2" step="0.02" value="0.38" />
            <em id="waveScaleVal">0.38</em>
          </label>
          <label class="ctrl">
            <span>Wave travel</span>
            <input id="waveTravel" type="range" min="0.2" max="3.5" step="0.05" value="1.45" />
            <em id="waveTravelVal">1.45</em>
          </label>
          <label class="ctrl">
            <span>Gust width</span>
            <input id="waveWidth" type="range" min="1" max="5" step="0.1" value="2.2" />
            <em id="waveWidthVal">2.20</em>
          </label>
          <label class="ctrl">
            <span>Sync</span>
            <input id="windSync" type="range" min="0" max="1" step="0.02" value="0.92" />
            <em id="windSyncVal">0.92</em>
          </label>
          <label class="check">
            <input type="checkbox" id="windAutoRotate" />
            Auto-rotate wind direction
          </label>
          <label class="ctrl" id="windAutoSpeedRow">
            <span>Rotate speed</span>
            <input id="windAutoSpeed" type="range" min="0.02" max="0.5" step="0.01" value="0.08" />
            <em id="windAutoSpeedVal">0.08</em>
          </label>
        </section>

        <!-- BLADE / FIELD -->
        <section class="section">
          <div class="section-head">
            <h2>Blade &amp; field</h2>
          </div>
          <p class="section-note">Each instance = one silhouette clump (vector grass icon)</p>
          <label class="ctrl">
            <span>Clump width</span>
            <input id="bladeWidth" type="range" min="0.4" max="1.8" step="0.02" value="0.95" />
            <em id="bladeWidthVal">0.95</em>
          </label>
          <label class="ctrl">
            <span>Clump height</span>
            <input id="bladeHeight" type="range" min="0.3" max="1.5" step="0.02" value="0.72" />
            <em id="bladeHeightVal">0.72</em>
          </label>
          <!-- kept for settings restore compatibility (hidden via CSS if needed) -->
          <input type="hidden" id="bladeCurve" value="0.2" />
          <input type="hidden" id="bladeSegments" value="1" />
          <input type="hidden" id="bunchBlades" value="1" />
          <label class="ctrl">
            <span>Density</span>
            <input id="density" type="range" min="0.3" max="1.5" step="0.05" value="1" />
            <em id="densityVal">1.00</em>
          </label>
          <label class="check">
            <input type="checkbox" id="lodEnabled" checked />
            Distance LOD (blades → chunks)
          </label>
          <label class="ctrl">
            <span>LOD near</span>
            <input id="lodNear" type="range" min="4" max="40" step="1" value="14" />
            <em id="lodNearVal">14</em>
          </label>
          <label class="ctrl">
            <span>LOD far</span>
            <input id="lodFar" type="range" min="10" max="70" step="1" value="28" />
            <em id="lodFarVal">28</em>
          </label>
          <label class="ctrl">
            <span>Scale min</span>
            <input id="scaleMin" type="range" min="0.3" max="1.2" step="0.05" value="0.55" />
            <em id="scaleMinVal">0.55</em>
          </label>
          <label class="ctrl">
            <span>Scale max</span>
            <input id="scaleMax" type="range" min="0.5" max="2" step="0.05" value="1.4" />
            <em id="scaleMaxVal">1.40</em>
          </label>
          <label class="check">
            <input type="checkbox" id="usePath" checked />
            Clear path through field
          </label>
          <label class="check">
            <input type="checkbox" id="slopeMask" checked />
            Slope mask (no cliff grass)
          </label>
          <label class="check">
            <input type="checkbox" id="grassVisible" checked />
            Show grass
          </label>
          <button type="button" id="rebuildBtn" class="btn">Rebuild field</button>
        </section>

        <!-- PLAYER INTERACTION -->
        <section class="section">
          <div class="section-head">
            <h2>Player interaction</h2>
            <label class="toggle">
              <input type="checkbox" id="interactEnabled" checked />
              <span>On</span>
            </label>
          </div>
          <label class="ctrl">
            <span>Radius</span>
            <input id="playerRadius" type="range" min="0.2" max="3" step="0.05" value="0.95" />
            <em id="playerRadiusVal">0.95</em>
          </label>
          <label class="ctrl">
            <span>Push</span>
            <input id="pushStrength" type="range" min="0" max="1.5" step="0.05" value="0.55" />
            <em id="pushStrengthVal">0.55</em>
          </label>
          <label class="ctrl">
            <span>Flatten</span>
            <input id="flattenStrength" type="range" min="0" max="1" step="0.05" value="0.28" />
            <em id="flattenStrengthVal">0.28</em>
          </label>
          <label class="ctrl">
            <span>Push shadow</span>
            <input id="pushShadow" type="range" min="0" max="1" step="0.05" value="0.72" />
            <em id="pushShadowVal">0.72</em>
          </label>
          <label class="ctrl">
            <span>Move speed</span>
            <input id="moveSpeed" type="range" min="1" max="12" step="0.5" value="5.5" />
            <em id="moveSpeedVal">5.5</em>
          </label>
          <label class="check">
            <input type="checkbox" id="playerVisible" checked />
            Show player
          </label>
          <label class="check">
            <input type="checkbox" id="cameraFollow" checked />
            Camera follow player
          </label>
        </section>

        <!-- COLORS / LOOK (A+ style: flat + noise) -->
        <section class="section">
          <div class="section-head"><h2>Color (flat + noise)</h2></div>
          <p class="section-note">
            A+ Grass style — one flat colour, variation from a noise texture (no tip gradient)
          </p>
          <label class="ctrl color">
            <span>Grass</span>
            <input id="grassColor" type="color" value="#7dcf72" />
          </label>
          <label class="ctrl color">
            <span>Noise tint</span>
            <input id="noiseColor" type="color" value="#8fd97a" />
          </label>
          <label class="ctrl">
            <span>Patch size</span>
            <input id="noiseScale" type="range" min="0.015" max="0.25" step="0.005" value="0.04" />
            <em id="noiseScaleVal">0.04</em>
          </label>
          <label class="ctrl">
            <span>Patch amount</span>
            <input id="noiseStrength" type="range" min="0" max="1" step="0.02" value="0.1" />
            <em id="noiseStrengthVal">0.10</em>
          </label>
          <label class="ctrl">
            <span>Patch contrast</span>
            <input id="noiseContrast" type="range" min="0.5" max="2.5" step="0.05" value="0.7" />
            <em id="noiseContrastVal">0.70</em>
          </label>
          <label class="ctrl">
            <span>Edge soft</span>
            <input id="patchSoftness" type="range" min="0.02" max="0.45" step="0.01" value="0.45" />
            <em id="patchSoftnessVal">0.45</em>
          </label>
          <label class="ctrl">
            <span>Root AO</span>
            <input id="rootAO" type="range" min="0" max="0.5" step="0.02" value="0.04" />
            <em id="rootAOVal">0.04</em>
          </label>
          <label class="ctrl color">
            <span>Ground</span>
            <input id="groundColor" type="color" value="#6fc468" />
          </label>
          <label class="ctrl color">
            <span>Sky / fog</span>
            <input id="fogColor" type="color" value="#a8d4f5" />
          </label>
          <label class="ctrl">
            <span>Ambient</span>
            <input id="ambient" type="range" min="0" max="1" step="0.05" value="0.68" />
            <em id="ambientVal">0.68</em>
          </label>
          <label class="ctrl">
            <span>SSS</span>
            <input id="sss" type="range" min="0" max="1.5" step="0.05" value="0.28" />
            <em id="sssVal">0.28</em>
          </label>
          <label class="ctrl">
            <span>Specular</span>
            <input id="specular" type="range" min="0" max="1" step="0.05" value="0.06" />
            <em id="specularVal">0.06</em>
          </label>
        </section>

        <!-- SCENE -->
        <section class="section">
          <div class="section-head"><h2>Scene</h2></div>
          <label class="check">
            <input type="checkbox" id="fogEnabled" checked />
            Fog
          </label>
          <label class="ctrl">
            <span>Fog near</span>
            <input id="fogNear" type="range" min="5" max="60" step="1" value="28" />
            <em id="fogNearVal">28</em>
          </label>
          <label class="ctrl">
            <span>Fog far</span>
            <input id="fogFar" type="range" min="20" max="120" step="1" value="78" />
            <em id="fogFarVal">78</em>
          </label>
          <label class="check">
            <input type="checkbox" id="shadowsEnabled" checked />
            Shadows
          </label>
          <label class="check">
            <input type="checkbox" id="groundVisible" checked />
            Show ground
          </label>
          <label class="check">
            <input type="checkbox" id="sunDiscVisible" checked />
            Show sun disc
          </label>
          <label class="ctrl">
            <span>Sun azimuth</span>
            <input id="sunAzimuth" type="range" min="0" max="360" step="1" value="40" />
            <em id="sunAzimuthVal">40°</em>
          </label>
          <label class="ctrl">
            <span>Sun elevation</span>
            <input id="sunElevation" type="range" min="5" max="85" step="1" value="48" />
            <em id="sunElevationVal">48°</em>
          </label>
          <label class="ctrl">
            <span>Sun intensity</span>
            <input id="sunIntensity" type="range" min="0" max="4" step="0.05" value="1.6" />
            <em id="sunIntensityVal">1.60</em>
          </label>
          <label class="ctrl">
            <span>Sky fill</span>
            <input id="hemiIntensity" type="range" min="0" max="1.5" step="0.05" value="0.55" />
            <em id="hemiIntensityVal">0.55</em>
          </label>
          <label class="ctrl">
            <span>Exposure</span>
            <input id="exposure" type="range" min="0.4" max="2" step="0.05" value="1.05" />
            <em id="exposureVal">1.05</em>
          </label>
          <button type="button" id="saveDefaultsBtn" class="btn">Save as project defaults (F2)</button>
          <button type="button" id="resetBtn" class="btn ghost">Reset to project defaults</button>
          <p class="section-note" id="saveStatus">
            Panel auto-saves to this browser. Soft refresh (Cmd+R) keeps it. F2 bakes into the project.
          </p>
        </section>
      </div>
    </aside>

    <script type="module" src="/src/main.js"></script>
  </body>
</html>


========================================================================
# FILE: src/defaults.js
========================================================================

/** Auto-saved panel defaults — do not edit by hand; use "Save as project defaults". */
export const DEFAULTS = {
  "windEnabled": true,
  "windAngle": 45,
  "windStrength": 1.15,
  "windGlobal": 0.55,
  "windGust": 1.35,
  "windTurb": 0.2,
  "windSpeed": 0.85,
  "waveScale": 0.38,
  "waveTravel": 1.45,
  "waveWidth": 2.2,
  "windSync": 0.92,
  "windAutoRotate": false,
  "windAutoSpeed": 0.08,
  "bladeWidth": 0.96,
  "bladeHeight": 0.78,
  "bladeCurve": 0.2,
  "bladeSegments": 1,
  "bunchBlades": 1,
  "density": 0.75,
  "lodEnabled": true,
  "lodNear": 14,
  "lodFar": 28,
  "scaleMin": 0.55,
  "scaleMax": 1.4,
  "usePath": true,
  "slopeMask": true,
  "grassVisible": true,
  "interactEnabled": true,
  "playerRadius": 1.2,
  "pushStrength": 0.55,
  "flattenStrength": 0.3,
  "pushShadow": 0.4,
  "moveSpeed": 5.5,
  "playerVisible": true,
  "cameraFollow": true,
  "grassColor": "#a0a555",
  "noiseColor": "#b9b42d",
  "noiseScale": 0.055,
  "noiseStrength": 0.22,
  "noiseContrast": 0.7,
  "patchSoftness": 0.45,
  "rootAO": 0.04,
  "groundColor": "#a6af1d",
  "fogColor": "#a8d4f5",
  "ambient": 0.7,
  "sss": 0.3,
  "specular": 0.05,
  "fogEnabled": true,
  "fogNear": 28,
  "fogFar": 78,
  "shadowsEnabled": true,
  "groundVisible": true,
  "sunDiscVisible": true,
  "sunAzimuth": 40,
  "sunElevation": 74,
  "sunIntensity": 1.6,
  "hemiIntensity": 0.95,
  "exposure": 1.05
};


========================================================================
# FILE: src/defaults.json
========================================================================

{
  "windEnabled": true,
  "windAngle": 45,
  "windStrength": 1.15,
  "windGlobal": 0.55,
  "windGust": 1.35,
  "windTurb": 0.2,
  "windSpeed": 0.85,
  "waveScale": 0.38,
  "waveTravel": 1.45,
  "waveWidth": 2.2,
  "windSync": 0.92,
  "windAutoRotate": false,
  "windAutoSpeed": 0.08,
  "bladeWidth": 0.96,
  "bladeHeight": 0.78,
  "bladeCurve": 0.2,
  "bladeSegments": 1,
  "bunchBlades": 1,
  "density": 0.75,
  "lodEnabled": true,
  "lodNear": 14,
  "lodFar": 28,
  "scaleMin": 0.55,
  "scaleMax": 1.4,
  "usePath": true,
  "slopeMask": true,
  "grassVisible": true,
  "interactEnabled": true,
  "playerRadius": 1.2,
  "pushStrength": 0.55,
  "flattenStrength": 0.3,
  "pushShadow": 0.4,
  "moveSpeed": 5.5,
  "playerVisible": true,
  "cameraFollow": true,
  "grassColor": "#a0a555",
  "noiseColor": "#b9b42d",
  "noiseScale": 0.055,
  "noiseStrength": 0.22,
  "noiseContrast": 0.7,
  "patchSoftness": 0.45,
  "rootAO": 0.04,
  "groundColor": "#a6af1d",
  "fogColor": "#a8d4f5",
  "ambient": 0.7,
  "sss": 0.3,
  "specular": 0.05,
  "fogEnabled": true,
  "fogNear": 28,
  "fogFar": 78,
  "shadowsEnabled": true,
  "groundVisible": true,
  "sunDiscVisible": true,
  "sunAzimuth": 40,
  "sunElevation": 74,
  "sunIntensity": 1.6,
  "hemiIntensity": 0.95,
  "exposure": 1.05
}


========================================================================
# FILE: src/main.js
========================================================================

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GrassField } from './grassField.js';
import { terrainHeight } from './noise.js';
import { DEFAULTS as SAVED_DEFAULTS } from './defaults.js';

const canvas = document.getElementById('c');
const statsEl = document.getElementById('stats');
const LS_KEY = 'procedural-grass-settings-v4-silhouette';

// Project defaults (from src/defaults.js — update via "Save as project defaults" / F2)
let DEFAULTS = { ...SAVED_DEFAULTS };

// ---- renderer / scene ----
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = DEFAULTS.exposure;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
// Soft Ghibli sky (reference)
const skyColor = DEFAULTS.fogColor || '#a8d4f5';
scene.background = new THREE.Color(skyColor);
scene.fog = new THREE.Fog(skyColor, DEFAULTS.fogNear ?? 18, DEFAULTS.fogFar ?? 62);

const camera = new THREE.PerspectiveCamera(52, window.innerWidth / window.innerHeight, 0.1, 200);
// Lower, longer view like the reference
camera.position.set(0, 2.4, 7.5);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.maxPolarAngle = Math.PI * 0.48;
controls.minDistance = 2.5;
controls.maxDistance = 28;
controls.target.set(0, 1.1, 0);

// ---- lights (sun directional + sky fill) ----
const hemi = new THREE.HemisphereLight(0xc8e8ff, 0x6aaf55, 0.85);
scene.add(hemi);

const sun = new THREE.DirectionalLight(0xfff8e0, DEFAULTS.sunIntensity ?? 1.05);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 120;
sun.shadow.camera.left = -36;
sun.shadow.camera.right = 36;
sun.shadow.camera.top = 36;
sun.shadow.camera.bottom = -36;
sun.shadow.bias = -0.0003;
sun.shadow.normalBias = 0.04;
scene.add(sun);
scene.add(sun.target);
sun.target.position.set(0, 0, 0);

// soft opposite fill so shadowed side isn’t pure black
const fill = new THREE.DirectionalLight(0xa8c8ff, 0.22);
scene.add(fill);

// Visible sun disc in the sky (follows directional light)
const sunGroup = new THREE.Group();
const sunCore = new THREE.Mesh(
  new THREE.SphereGeometry(2.2, 24, 24),
  new THREE.MeshBasicMaterial({ color: 0xffe08a, fog: false, depthWrite: false })
);
const sunGlow = new THREE.Mesh(
  new THREE.SphereGeometry(4.5, 24, 24),
  new THREE.MeshBasicMaterial({
    color: 0xffc857,
    transparent: true,
    opacity: 0.28,
    fog: false,
    depthWrite: false,
  })
);
const sunHalo = new THREE.Mesh(
  new THREE.SphereGeometry(7.5, 24, 24),
  new THREE.MeshBasicMaterial({
    color: 0xfff3c0,
    transparent: true,
    opacity: 0.12,
    fog: false,
    depthWrite: false,
  })
);
sunGroup.add(sunCore, sunGlow, sunHalo);
sunGroup.renderOrder = 1;
scene.add(sunGroup);

/**
 * Place directional sun + disc from azimuth / elevation (degrees).
 * Azimuth 0° = +X (east), 90° = +Z (south). Elevation 0° = horizon, 90° = zenith.
 */
function setSunFromAngles(azimuthDeg, elevationDeg) {
  const az = (azimuthDeg * Math.PI) / 180;
  const el = THREE.MathUtils.clamp(elevationDeg, 2, 89) * (Math.PI / 180);
  const dist = 55;
  const cosEl = Math.cos(el);
  const x = dist * cosEl * Math.cos(az);
  const y = dist * Math.sin(el);
  const z = dist * cosEl * Math.sin(az);

  sun.position.set(x, y, z);
  sun.target.position.set(0, 0, 0);
  sun.target.updateMatrixWorld();
  sun.updateMatrixWorld();

  // fill from opposite side, lower
  fill.position.set(-x * 0.35, Math.max(6, y * 0.25), -z * 0.35);

  sunGroup.position.set(x, y, z);
  sunGroup.visible = elevationDeg > 3;

  // Warm sun near horizon, cooler at noon
  const warm = THREE.MathUtils.smoothstep(elevationDeg, 5, 35);
  const col = new THREE.Color().setHSL(0.1 - warm * 0.02, 0.55 - warm * 0.15, 0.72 + warm * 0.1);
  sun.color.copy(col);
  sunCore.material.color.copy(col).multiplyScalar(1.1);
  sunGlow.material.color.copy(col);

  // Drive custom grass shader sun (ShaderMaterial ignores Three.js lights)
  if (grass?.material?.uniforms) {
    const u = grass.material.uniforms;
    if (u.uSunDir) u.uSunDir.value.set(x, y, z).normalize();
    if (u.uSunColor) u.uSunColor.value.copy(col);
    if (u.uSunIntensity) u.uSunIntensity.value = sun.intensity;
  }
}

// ---- grass ----
const cores = navigator.hardwareConcurrency || 4;
// Slightly lower budget — far LOD clumps cover distance
// Each instance is a full bunch — fewer instances than single blades
const bladeBudget = cores <= 4 ? 32000 : cores <= 8 ? 45000 : 58000;

const grass = new GrassField({
  size: 48,
  bladeCount: bladeBudget,
  // width/height = silhouette card size (one clump icon per instance)
  bladeWidth: DEFAULTS.bladeWidth ?? 0.95,
  bladeHeight: DEFAULTS.bladeHeight ?? 0.72,
  lodNear: DEFAULTS.lodNear ?? 12,
  lodFar: DEFAULTS.lodFar ?? 24,
});
scene.add(grass.object);
scene.add(grass.ground);

setSunFromAngles(DEFAULTS.sunAzimuth ?? 40, DEFAULTS.sunElevation ?? 48);
grass.setWindDir(DEFAULTS.windAngle);

// ---- player ----
const player = new THREE.Group();
const body = new THREE.Mesh(
  new THREE.CapsuleGeometry(0.28, 0.7, 6, 12),
  new THREE.MeshStandardMaterial({ color: 0xf0d0a0, roughness: 0.55, metalness: 0.05 })
);
body.castShadow = true;
body.position.y = 0.7;
player.add(body);

const hat = new THREE.Mesh(
  new THREE.SphereGeometry(0.2, 16, 12),
  new THREE.MeshStandardMaterial({ color: 0xe07050, roughness: 0.4 })
);
hat.position.y = 1.25;
hat.castShadow = true;
player.add(hat);

player.position.set(0, 0, 4);
scene.add(player);

// Soft green trail shadow under player (reference: dark mint underfoot, not pure black)
const contactShadow = new THREE.Mesh(
  new THREE.CircleGeometry(1, 48),
  new THREE.MeshBasicMaterial({
    color: 0x3d6b38,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
    fog: true,
  })
);
contactShadow.rotation.x = -Math.PI / 2;
contactShadow.renderOrder = 2;
scene.add(contactShadow);

// ---- wind arrow helper in scene (XZ) ----
const windArrowGroup = new THREE.Group();
const arrowMat = new THREE.MeshBasicMaterial({ color: 0xa8e878, transparent: true, opacity: 0.85 });
const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.6, 8), arrowMat);
shaft.rotation.z = Math.PI / 2;
shaft.position.x = 0.8;
const head = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.35, 10), arrowMat);
head.rotation.z = -Math.PI / 2;
head.position.x = 1.75;
const base = new THREE.Mesh(
  new THREE.RingGeometry(0.55, 0.65, 32),
  new THREE.MeshBasicMaterial({ color: 0x7ecf6a, side: THREE.DoubleSide, transparent: true, opacity: 0.5 })
);
base.rotation.x = -Math.PI / 2;
windArrowGroup.add(shaft, head, base);
windArrowGroup.position.set(0, 0.15, 0);
scene.add(windArrowGroup);

function placeWindArrow() {
  const y = terrainHeight(0, 0) + 0.08;
  windArrowGroup.position.set(0, y, 0);
}
placeWindArrow();

// ---- input ----
const keys = new Set();
window.addEventListener('keydown', (e) => {
  keys.add(e.code);
  // don't steal space from page when typing in panel — no text inputs currently
});
window.addEventListener('keyup', (e) => keys.delete(e.code));

const playerVel = new THREE.Vector3();
const tmp = new THREE.Vector3();
let moveSpeed = DEFAULTS.moveSpeed;
let cameraFollow = DEFAULTS.cameraFollow;

function updatePlayer(dt) {
  const forward = tmp.set(0, 0, 0);
  camera.getWorldDirection(forward);
  forward.y = 0;
  if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
  forward.normalize();
  const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();

  const wish = new THREE.Vector3();
  if (keys.has('KeyW') || keys.has('ArrowUp')) wish.add(forward);
  if (keys.has('KeyS') || keys.has('ArrowDown')) wish.sub(forward);
  if (keys.has('KeyA') || keys.has('ArrowLeft')) wish.sub(right);
  if (keys.has('KeyD') || keys.has('ArrowRight')) wish.add(right);

  if (wish.lengthSq() > 0) {
    wish.normalize().multiplyScalar(moveSpeed);
    playerVel.lerp(wish, 1 - Math.exp(-12 * dt));
  } else {
    playerVel.multiplyScalar(Math.exp(-10 * dt));
  }

  player.position.x += playerVel.x * dt;
  player.position.z += playerVel.z * dt;

  const lim = grass.size * 0.48;
  player.position.x = THREE.MathUtils.clamp(player.position.x, -lim, lim);
  player.position.z = THREE.MathUtils.clamp(player.position.z, -lim, lim);
  player.position.y = terrainHeight(player.position.x, player.position.z);

  if (playerVel.lengthSq() > 0.01) {
    const face = Math.atan2(playerVel.x, playerVel.z);
    body.rotation.y = THREE.MathUtils.lerp(body.rotation.y, face, 1 - Math.exp(-10 * dt));
    hat.rotation.y = body.rotation.y;
  }

  if (cameraFollow) {
    controls.target.lerp(
      new THREE.Vector3(player.position.x, player.position.y + 1.15, player.position.z),
      1 - Math.exp(-4 * dt)
    );
  }

  grass.setPlayer(tmp.set(player.position.x, player.position.y + 0.35, player.position.z));

  // Contact shadow follows player footprint
  const pr = grass.material.uniforms.uPlayerRadius?.value ?? 1.2;
  const interactOn = grass.material.uniforms.uInteractEnabled?.value > 0.5;
  contactShadow.visible = interactOn && player.visible;
  contactShadow.position.set(player.position.x, player.position.y + 0.035, player.position.z);
  // Slightly elongated footprint in move direction
  const speed = playerVel.length();
  const s = pr * (1.1 + Math.min(speed, 4) * 0.04);
  contactShadow.scale.set(s * 1.15, s * 0.95, 1);
  const pushSh = grass.material.uniforms.uPushShadow?.value ?? 0.85;
  contactShadow.material.opacity = 0.28 + pushSh * 0.32;
}

// ---- UI helpers ----
const $ = (id) => document.getElementById(id);

function bindRange(id, onChange, { format = (v) => Number(v).toFixed(2), suffix = '' } = {}) {
  const el = $(id);
  const label = $(id + 'Val');
  const apply = () => {
    const v = parseFloat(el.value);
    if (label) label.textContent = `${format(v)}${suffix}`;
    onChange(v, el);
  };
  el.addEventListener('input', apply);
  return { el, apply, get: () => parseFloat(el.value), set: (v) => { el.value = v; apply(); } };
}

function bindCheck(id, onChange) {
  const el = $(id);
  const apply = () => onChange(el.checked, el);
  el.addEventListener('change', apply);
  return { el, apply, get: () => el.checked, set: (v) => { el.checked = v; apply(); } };
}

function bindColor(id, onChange) {
  const el = $(id);
  const apply = () => onChange(el.value, el);
  el.addEventListener('input', apply);
  return { el, apply, get: () => el.value, set: (v) => { el.value = v; apply(); } };
}

// panel collapse
const panel = $('panel');
$('panelToggle').addEventListener('click', () => {
  panel.classList.toggle('collapsed');
  $('panelToggle').textContent = panel.classList.contains('collapsed') ? '▸' : '▾';
});

// ---- wind compass ----
const compass = $('windCompass');
const compassCtx = compass.getContext('2d');
let windAngle = DEFAULTS.windAngle;

function drawWindCompass(angleDeg, strength = 1) {
  const ctx = compassCtx;
  const w = compass.width;
  const h = compass.height;
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.min(w, h) * 0.38;

  ctx.clearRect(0, 0, w, h);

  // face
  ctx.beginPath();
  ctx.arc(cx, cy, r + 10, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(20, 40, 24, 0.9)';
  ctx.fill();

  // ticks
  ctx.strokeStyle = 'rgba(180, 220, 160, 0.35)';
  ctx.lineWidth = 1.5;
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * (r - 4), cy + Math.sin(a) * (r - 4));
    ctx.lineTo(cx + Math.cos(a) * (r + 6), cy + Math.sin(a) * (r + 6));
    ctx.stroke();
  }

  // cardinal labels (screen: 0°=+X right, 90°=+Z down in our mapping for compass visual)
  ctx.fillStyle = 'rgba(200, 240, 180, 0.85)';
  ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('E', cx + r + 14, cy);
  ctx.fillText('W', cx - r - 14, cy);
  ctx.fillText('S', cx, cy + r + 14);
  ctx.fillText('N', cx, cy - r - 14);

  // wind arrow (angle 0 → +X, increases toward +Z)
  const rad = (angleDeg * Math.PI) / 180;
  const len = r * (0.45 + 0.45 * Math.min(strength, 1.5) / 1.5);
  const x2 = cx + Math.cos(rad) * len;
  const y2 = cy + Math.sin(rad) * len;

  ctx.strokeStyle = '#8fd96a';
  ctx.fillStyle = '#8fd96a';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  // arrow head
  const ah = 10;
  const ang = Math.atan2(y2 - cy, x2 - cx);
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - ah * Math.cos(ang - 0.4), y2 - ah * Math.sin(ang - 0.4));
  ctx.lineTo(x2 - ah * Math.cos(ang + 0.4), y2 - ah * Math.sin(ang + 0.4));
  ctx.closePath();
  ctx.fill();

  // center hub
  ctx.beginPath();
  ctx.arc(cx, cy, 4, 0, Math.PI * 2);
  ctx.fillStyle = '#dff5d0';
  ctx.fill();
}

function setWindAngle(deg, { fromUI = false } = {}) {
  windAngle = ((deg % 360) + 360) % 360;
  grass.setWindDir(windAngle);
  windArrowGroup.rotation.y = -windAngle * (Math.PI / 180); // visual align on XZ
  $('windAngleLabel').textContent = `${Math.round(windAngle)}°`;
  if (!fromUI) {
    $('windAngle').value = String(Math.round(windAngle));
    $('windAngleVal').textContent = `${Math.round(windAngle)}°`;
  }
  drawWindCompass(windAngle, grass.material.uniforms.uWindStrength.value);
}

// drag on compass
function angleFromEvent(ev) {
  const rect = compass.getBoundingClientRect();
  const x = ((ev.clientX - rect.left) / rect.width) * compass.width - compass.width / 2;
  const y = ((ev.clientY - rect.top) / rect.height) * compass.height - compass.height / 2;
  let deg = (Math.atan2(y, x) * 180) / Math.PI;
  if (deg < 0) deg += 360;
  return deg;
}

let draggingCompass = false;
compass.addEventListener('pointerdown', (e) => {
  draggingCompass = true;
  compass.setPointerCapture(e.pointerId);
  $('windAutoRotate').checked = false;
  setWindAngle(angleFromEvent(e));
});
compass.addEventListener('pointermove', (e) => {
  if (!draggingCompass) return;
  setWindAngle(angleFromEvent(e));
});
compass.addEventListener('pointerup', () => { draggingCompass = false; });
compass.addEventListener('pointercancel', () => { draggingCompass = false; });

// ---- bind controls ----
let rebuildTimer = null;
function scheduleRebuild() {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => doRebuild(), 150);
}

function doRebuild() {
  grass.setBladeShape({
    width: parseFloat($('bladeWidth').value),
    height: parseFloat($('bladeHeight').value),
  });
  const n = grass.rebuild({
    densityScale: parseFloat($('density').value),
    scaleMin: parseFloat($('scaleMin').value),
    scaleMax: parseFloat($('scaleMax').value),
    usePath: $('usePath').checked,
    slopeMask: $('slopeMask').checked,
  });
  const near = typeof n === 'object' ? n.near : n;
  const far = typeof n === 'object' ? n.far : 0;
  statsEl.textContent = `${near.toLocaleString()} near + ${far.toLocaleString()} chunks · rebuilt`;
}

bindRange('windAngle', (v) => {
  setWindAngle(v, { fromUI: true });
  $('windAngleVal').textContent = `${Math.round(v)}°`;
}, { format: (v) => String(Math.round(v)), suffix: '°' });

bindRange('windStrength', (v) => {
  grass.material.uniforms.uWindStrength.value = v;
  drawWindCompass(windAngle, v);
});
bindRange('windGlobal', (v) => { grass.material.uniforms.uWindGlobal.value = v; });
bindRange('windGust', (v) => { grass.material.uniforms.uWindGust.value = v; });
bindRange('windTurb', (v) => { grass.material.uniforms.uWindTurb.value = v; });
bindRange('windSpeed', (v) => { grass.material.uniforms.uWindSpeed.value = v; });
bindRange('waveScale', (v) => { grass.material.uniforms.uWaveScale.value = v; });
bindRange('waveTravel', (v) => { grass.material.uniforms.uWaveTravel.value = v; });
bindRange('waveWidth', (v) => { grass.material.uniforms.uWaveWidth.value = v; });
bindRange('windSync', (v) => { grass.material.uniforms.uSync.value = v; });
bindRange('windAutoSpeed', () => {});

bindCheck('windEnabled', (on) => {
  grass.material.uniforms.uWindEnabled.value = on ? 1 : 0;
  windArrowGroup.visible = on;
});
bindCheck('windAutoRotate', () => {});

['bladeWidth', 'bladeHeight', 'density', 'scaleMin', 'scaleMax'].forEach((id) => {
  bindRange(id, () => scheduleRebuild(), {
    format: (v) => Number(v).toFixed(2),
    suffix: '',
  });
});
bindCheck('usePath', () => scheduleRebuild());
bindCheck('slopeMask', () => scheduleRebuild());
bindCheck('lodEnabled', (on) => {
  grass.setLodEnabled(on);
  if ($('grassVisible').checked) grass.farMesh.visible = on;
});
bindRange('lodNear', (v) => {
  grass.setLodDistances(v, parseFloat($('lodFar').value));
}, { format: (v) => String(Math.round(v)) });
bindRange('lodFar', (v) => {
  grass.setLodDistances(parseFloat($('lodNear').value), v);
}, { format: (v) => String(Math.round(v)) });
bindCheck('grassVisible', (on) => {
  grass.nearMesh.visible = on;
  grass.farMesh.visible = on && grass.lodEnabled;
});

$('rebuildBtn').addEventListener('click', () => doRebuild());

bindCheck('interactEnabled', (on) => {
  grass.material.uniforms.uInteractEnabled.value = on ? 1 : 0;
  contactShadow.visible = on && player.visible;
});
bindRange('playerRadius', (v) => { grass.material.uniforms.uPlayerRadius.value = v; });
bindRange('pushStrength', (v) => { grass.material.uniforms.uPushStrength.value = v; });
bindRange('flattenStrength', (v) => { grass.material.uniforms.uFlattenStrength.value = v; });
bindRange('pushShadow', (v) => {
  if (grass.material.uniforms.uPushShadow) grass.material.uniforms.uPushShadow.value = v;
});
bindRange('moveSpeed', (v) => { moveSpeed = v; }, { format: (v) => Number(v).toFixed(1) });
bindCheck('playerVisible', (on) => {
  player.visible = on;
  contactShadow.visible = on && grass.material.uniforms.uInteractEnabled.value > 0.5;
});
bindCheck('cameraFollow', (on) => { cameraFollow = on; });

bindColor('grassColor', (v) => grass.material.uniforms.uGrassColor.value.set(v));
bindColor('noiseColor', (v) => grass.material.uniforms.uNoiseColor.value.set(v));
bindRange('noiseScale', (v) => { grass.material.uniforms.uNoiseScale.value = v; });
bindRange('noiseStrength', (v) => { grass.material.uniforms.uNoiseStrength.value = v; });
bindRange('noiseContrast', (v) => { grass.material.uniforms.uNoiseContrast.value = v; });
bindRange('patchSoftness', (v) => { grass.material.uniforms.uPatchSoftness.value = v; });
bindRange('rootAO', (v) => { grass.material.uniforms.uRootAO.value = v; });
bindColor('groundColor', (v) => {
  if (grass.ground) grass.ground.material.color.set(v);
});
bindColor('fogColor', (v) => {
  scene.background.set(v);
  if (scene.fog) scene.fog.color.set(v);
  grass.material.uniforms.uFogColor.value.set(v);
});
bindRange('ambient', (v) => { grass.material.uniforms.uAmbient.value = v; });
bindRange('sss', (v) => { grass.material.uniforms.uSSS.value = v; });
bindRange('specular', (v) => { grass.material.uniforms.uSpecular.value = v; });

bindCheck('fogEnabled', (on) => {
  grass.material.uniforms.uFogEnabled.value = on ? 1 : 0;
  scene.fog = on
    ? new THREE.Fog(
        grass.material.uniforms.uFogColor.value,
        parseFloat($('fogNear').value),
        parseFloat($('fogFar').value)
      )
    : null;
});
bindRange('fogNear', (v) => {
  grass.material.uniforms.uFogNear.value = v;
  if (scene.fog) scene.fog.near = v;
}, { format: (v) => String(Math.round(v)) });
bindRange('fogFar', (v) => {
  grass.material.uniforms.uFogFar.value = v;
  if (scene.fog) scene.fog.far = v;
}, { format: (v) => String(Math.round(v)) });
bindCheck('shadowsEnabled', (on) => {
  renderer.shadowMap.enabled = on;
  sun.castShadow = on;
});
bindCheck('groundVisible', (on) => {
  if (grass.ground) grass.ground.visible = on;
});
bindCheck('sunDiscVisible', (on) => {
  sunGroup.visible = on && parseFloat($('sunElevation').value) > 3;
});
function refreshSun() {
  setSunFromAngles(parseFloat($('sunAzimuth').value), parseFloat($('sunElevation').value));
  sunGroup.visible = $('sunDiscVisible').checked && parseFloat($('sunElevation').value) > 3;
}
bindRange('sunAzimuth', () => refreshSun(), {
  format: (v) => String(Math.round(v)),
  suffix: '°',
});
bindRange('sunElevation', () => refreshSun(), {
  format: (v) => String(Math.round(v)),
  suffix: '°',
});
bindRange('sunIntensity', (v) => {
  sun.intensity = v;
  if (grass.material.uniforms.uSunIntensity) {
    grass.material.uniforms.uSunIntensity.value = v;
  }
});
bindRange('hemiIntensity', (v) => {
  hemi.intensity = v;
  // Map sky fill somewhat into grass ambient so panel still feels connected
  if (grass.material.uniforms.uAmbient) {
    grass.material.uniforms.uAmbient.value = 0.22 + v * 0.35;
  }
});
bindRange('exposure', (v) => { renderer.toneMappingExposure = v; });

function collectSettings() {
  const out = {};
  panel.querySelectorAll('input').forEach((el) => {
    if (!el.id) return;
    if (el.type === 'checkbox') out[el.id] = el.checked;
    else if (el.type === 'color') out[el.id] = el.value;
    else if (el.type === 'range') out[el.id] = parseFloat(el.value);
    else out[el.id] = el.value;
  });
  return out;
}

function applySettingsObject(d, { rebuild = true } = {}) {
  if (!d || typeof d !== 'object') return;

  // Merge over project defaults so partial saves still work
  const merged = { ...DEFAULTS, ...d };

  const set = (id, val) => {
    const el = $(id);
    if (!el || val === undefined || val === null) return;
    if (el.type === 'checkbox') el.checked = !!val;
    else el.value = String(val);
  };

  Object.keys(merged).forEach((k) => set(k, merged[k]));

  // Apply without double-firing rebuild storms: pause autosave briefly
  suppressingPersist = true;
  panel.querySelectorAll('input[type="range"]').forEach((el) => {
    el.dispatchEvent(new Event('input'));
  });
  panel.querySelectorAll('input[type="checkbox"]').forEach((el) => {
    el.dispatchEvent(new Event('change'));
  });
  panel.querySelectorAll('input[type="color"]').forEach((el) => {
    el.dispatchEvent(new Event('input'));
  });
  if (merged.windAngle != null) setWindAngle(Number(merged.windAngle));
  suppressingPersist = false;

  if (rebuild) doRebuild();
  // Snapshot after apply so next reload keeps this look
  persistLocal(true);
}

function applyDefaults() {
  applySettingsObject(DEFAULTS, { rebuild: true });
  setSaveStatus('Restored project defaults', 'ok');
}

let suppressingPersist = false;
let persistTimer = null;

function persistLocal(immediate = false) {
  if (suppressingPersist) return;
  const write = () => {
    try {
      const s = collectSettings();
      localStorage.setItem(LS_KEY, JSON.stringify(s));
      // dual-write sessionStorage so a hard refresh in the same tab still has a copy
      sessionStorage.setItem(LS_KEY, JSON.stringify(s));
    } catch {
      /* ignore */
    }
  };
  if (immediate) {
    write();
    return;
  }
  clearTimeout(persistTimer);
  persistTimer = setTimeout(write, 80);
}

function loadLocal() {
  try {
    const raw = localStorage.getItem(LS_KEY) || sessionStorage.getItem(LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    // sanity: need at least a couple known keys
    if (parsed.grassColor == null && parsed.windStrength == null && parsed.bladeWidth == null) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function setSaveStatus(msg, kind = 'muted') {
  const status = $('saveStatus');
  if (!status) return;
  status.textContent = msg;
  status.style.color =
    kind === 'ok' ? '#9fd48a' : kind === 'warn' ? '#f0c070' : 'rgba(200, 232, 184, 0.65)';
}

async function saveAsProjectDefaults() {
  const settings = collectSettings();
  try {
    const res = await fetch('/__save-defaults', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'save failed');
    DEFAULTS = { ...data.settings };
    persistLocal(true);
    setSaveStatus(`Saved ${data.count} settings as project defaults ✓  (F2 anytime)`, 'ok');
  } catch (err) {
    persistLocal(true);
    const blob = new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'defaults.json';
    a.click();
    URL.revokeObjectURL(a.href);
    setSaveStatus(`Downloaded defaults.json — server save failed (${err.message})`, 'warn');
  }
}

$('saveDefaultsBtn').addEventListener('click', () => saveAsProjectDefaults());
$('resetBtn').addEventListener('click', () => applyDefaults());

window.addEventListener('keydown', (e) => {
  if (e.key === 'F2') {
    e.preventDefault();
    saveAsProjectDefaults();
  }
});

// Persist on every tweak + when leaving the page
panel.querySelectorAll('input').forEach((el) => {
  el.addEventListener('input', () => persistLocal());
  el.addEventListener('change', () => persistLocal());
});
window.addEventListener('beforeunload', () => persistLocal(true));
window.addEventListener('pagehide', () => persistLocal(true));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') persistLocal(true);
});
// Safety net: snapshot every 2s while the tab is open
setInterval(() => persistLocal(true), 2000);

// initial labels / compass from project defaults (may be overwritten by session restore)
setWindAngle(DEFAULTS.windAngle ?? 45);
panel.querySelectorAll('input[type="range"]').forEach((el) => {
  const id = el.id;
  const label = $(id + 'Val');
  if (!label) return;
  if (
    id === 'windAngle' ||
    id === 'fogNear' ||
    id === 'fogFar' ||
    id === 'bladeSegments' ||
    id === 'bunchBlades' ||
    id === 'sunAzimuth' ||
    id === 'sunElevation' ||
    id === 'lodNear' ||
    id === 'lodFar'
  ) {
    label.textContent =
      id === 'windAngle' || id === 'sunAzimuth' || id === 'sunElevation'
        ? `${Math.round(el.value)}°`
        : String(Math.round(el.value));
  } else if (id === 'moveSpeed') {
    label.textContent = Number(el.value).toFixed(1);
  } else {
    label.textContent = Number(el.value).toFixed(2);
  }
});

// Restore last session if we have one — otherwise keep code/HTML defaults and start autosaving
const local = loadLocal();
if (local) {
  applySettingsObject(local, { rebuild: true });
  setSaveStatus('Restored your last session from browser storage ✓  ·  F2 = save as project defaults', 'ok');
} else {
  // Do NOT rebuild/reset further — stay on current HTML/control values and begin tracking
  persistLocal(true);
  setSaveStatus(
    'No saved session yet. Tweak freely — auto-saves every change. Press F2 when you like the look.',
    'warn'
  );
}

// ---- resize ----
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---- loop ----
const clock = new THREE.Clock();
let frames = 0;
let fpsAccum = 0;
let fps = 0;

function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;

  updatePlayer(dt);
  grass.setTime(t);
  controls.update();

  if ($('windAutoRotate').checked && $('windEnabled').checked) {
    const spd = parseFloat($('windAutoSpeed').value);
    setWindAngle(windAngle + spd * 60 * dt); // deg/sec scaled
  }

  // bob wind arrow slightly
  windArrowGroup.position.y = terrainHeight(0, 0) + 0.08 + Math.sin(t * 2.2) * 0.02;

  renderer.render(scene, camera);

  frames++;
  fpsAccum += dt;
  if (fpsAccum >= 0.5) {
    fps = Math.round(frames / fpsAccum);
    frames = 0;
    fpsAccum = 0;
    const dir = Math.round(windAngle);
    statsEl.textContent =
      `${grass.nearMesh.count.toLocaleString()} near · ${grass.farMesh.count.toLocaleString()} chunks · ${fps} fps\n` +
      `wind ${grass.material.uniforms.uWindStrength.value.toFixed(2)} @ ${dir}°` +
      (grass.material.uniforms.uWindEnabled.value < 0.5 ? ' (off)' : '');
  }

  requestAnimationFrame(frame);
}

statsEl.textContent = `${grass.nearMesh.count.toLocaleString()} near · ${grass.farMesh.count.toLocaleString()} chunks · ready`;
requestAnimationFrame(frame);


========================================================================
# FILE: src/grassMaterial.js
========================================================================

import * as THREE from 'three';
import { createColorNoiseTexture } from './noiseTexture.js';
import { createGrassSilhouetteTexture } from './grassSilhouette.js';

/**
 * One silhouette grass clump per instance (Vecteezy-style cutout) + flat tint.
 */
/**
 * @param {object} [opts]
 * @param {THREE.Texture} [opts.noiseMap]
 * @param {THREE.Texture} [opts.alphaMap] grass clump silhouette (alpha)
 * @param {number} [opts.lodNear]
 * @param {number} [opts.lodFar]
 * @param {boolean} [opts.lodFadeIn]
 */
export function createGrassMaterial(opts = {}) {
  const noiseMap = opts.noiseMap || createColorNoiseTexture(256);
  const alphaMap = opts.alphaMap || createGrassSilhouetteTexture(512);

  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uWindEnabled: { value: 1 },
      uWindStrength: { value: 1.15 },
      uWindDir: { value: new THREE.Vector2(1.0, 0.0).normalize() },
      uWindGlobal: { value: 0.55 },
      uWindGust: { value: 1.35 },
      uWindTurb: { value: 0.18 },
      uWindSpeed: { value: 0.85 },
      uWaveScale: { value: 0.38 },
      uWaveTravel: { value: 1.45 },
      uWaveWidth: { value: 2.2 },
      uSync: { value: 0.92 },
      uInteractEnabled: { value: 1 },
      uPlayerPos: { value: new THREE.Vector3(0, 0, 0) },
      uPlayerRadius: { value: 0.95 },
      uPushStrength: { value: 0.65 },
      uFlattenStrength: { value: 0.42 },
      uPushShadow: { value: 0.88 },

      uGrassColor: { value: new THREE.Color('#6fcf3a') },
      uNoiseColor: { value: new THREE.Color('#7dd948') },
      uNoiseMap: { value: noiseMap },
      uAlphaMap: { value: alphaMap },
      uNoiseScale: { value: 0.035 },
      uNoiseStrength: { value: 0.08 },
      uNoiseContrast: { value: 0.65 },
      uPatchSoftness: { value: 0.5 },
      uRootAO: { value: 0.02 },
      uStrokeStrength: { value: 0.0 },
      uAlphaCutoff: { value: 0.15 },

      uSunDir: { value: new THREE.Vector3(0.35, 0.9, 0.2).normalize() },
      uSunColor: { value: new THREE.Color('#fff8e0') },
      uSunIntensity: { value: 1.05 },
      uAmbient: { value: 0.72 },
      uSSS: { value: 0.4 },
      uSpecular: { value: 0.02 },
      uFogColor: { value: new THREE.Color('#a8d4f5') },
      uFogNear: { value: 18 },
      uFogFar: { value: 62 },
      uFogEnabled: { value: 1 },

      uLodNear: { value: opts.lodNear ?? 12 },
      uLodFar: { value: opts.lodFar ?? 24 },
      uLodFadeIn: { value: opts.lodFadeIn ? 1 : 0 },
      uLodEnabled: { value: 1 },
    },
    vertexShader: /* glsl */ `
      precision highp float;

      attribute float aPhase;
      attribute float aColorVar;
      attribute float aStiffness;

      uniform float uTime;
      uniform float uWindEnabled;
      uniform float uWindStrength;
      uniform vec2 uWindDir;
      uniform float uWindGlobal;
      uniform float uWindGust;
      uniform float uWindTurb;
      uniform float uWindSpeed;
      uniform float uWaveScale;
      uniform float uWaveTravel;
      uniform float uWaveWidth;
      uniform float uSync;
      uniform float uInteractEnabled;
      uniform vec3 uPlayerPos;
      uniform float uPlayerRadius;
      uniform float uPushStrength;
      uniform float uFlattenStrength;

      varying float vElevation;
      varying float vInteract;
      varying vec3 vWorldNormal;
      varying vec3 vWorldPos;
      varying vec2 vWorldXZ;
      varying vec2 vUv;

      float hash12(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * 0.1031);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z);
      }

      float gustPulse(float phase, float width) {
        float s = 0.5 + 0.5 * sin(phase);
        return pow(s, max(width, 1.0));
      }

      void main() {
        vUv = uv;
        vElevation = uv.y;

        vec4 worldPos4 = instanceMatrix * vec4(position, 1.0);
        vec3 worldPos = worldPos4.xyz;
        vec3 root = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        vWorldXZ = root.xz;

        float h = uv.y;
        float hBend = h * h * (1.15 - 0.15 * h);
        float h2 = h * h;

        float stiff = mix(0.92, 1.08, aStiffness);
        float t = uTime * uWindSpeed;

        vec2 wdir = length(uWindDir) > 1e-5 ? normalize(uWindDir) : vec2(1.0, 0.0);
        vec2 across = vec2(-wdir.y, wdir.x);

        float along = dot(root.xz, wdir);
        float side = dot(root.xz, across);

        float localPhase = mix(aPhase, 0.0, clamp(uSync, 0.0, 1.0));
        float spatialJitter = (hash12(floor(root.xz * 0.35)) - 0.5) * mix(1.2, 0.12, uSync);

        vec2 windPush = vec2(0.0);

        if (uWindEnabled > 0.5 && uWindStrength > 0.0) {
          float scale = max(uWaveScale, 0.05);
          float travel = uWaveTravel;

          float breath =
              sin(t * 0.55 + localPhase * 0.15) * 0.5
            + sin(t * 0.23) * 0.5;
          breath *= uWindGlobal;

          float p1 = along * scale - t * travel * 1.0 + spatialJitter;
          float p2 = along * scale * 0.42 - t * travel * 0.48 + 0.7;
          float p3 = along * scale * 1.65 - t * travel * 1.55 + side * 0.08;

          float g1 = gustPulse(p1, uWaveWidth);
          float g2 = gustPulse(p2, uWaveWidth * 0.85);
          float g3 = gustPulse(p3, uWaveWidth * 1.15);

          float leanWave =
              sin(p1) * (0.35 + 0.65 * g1) * 0.72
            + sin(p2) * (0.40 + 0.60 * g2) * 0.38
            + sin(p3) * (0.50 + 0.50 * g3) * 0.16;

          float frontCurve = sin(side * scale * 0.55 + t * 0.2) * 0.12
                           + sin(side * scale * 0.18 - along * scale * 0.1) * 0.08;
          leanWave += frontCurve * (0.5 + 0.5 * g1);
          leanWave *= uWindGust;

          float fieldAmt = (breath * 0.45 + leanWave) * stiff;

          float micro =
              sin(t * 4.8 + aPhase * 3.5 + along * 0.8)
            * 0.07
            * uWindTurb
            * (0.35 + 0.65 * h);

          float windAmt = (fieldAmt + micro) * uWindStrength;

          windPush = wdir * windAmt * hBend * 0.58;
          windPush += across * (g1 - 0.35) * uWindGust * hBend * 0.08 * uWindStrength;
          windPush += across * micro * h2 * 0.35;

          worldPos.xz += windPush;
          worldPos.y -= length(windPush) * 0.16 * h;
        }

        vec2 pushDir = vec2(0.0);
        float influence = 0.0;
        if (uInteractEnabled > 0.5) {
          vec2 toBlade = root.xz - uPlayerPos.xz;
          float dist = length(toBlade);
          influence = 1.0 - smoothstep(0.0, uPlayerRadius, dist);
          influence = influence * influence;
          pushDir = dist > 1e-4 ? normalize(toBlade) : vec2(1.0, 0.0);
          worldPos.xz += pushDir * influence * h2 * uPushStrength;
          // Flatten more aggressively for flat bunches
          worldPos.y -= influence * h * uFlattenStrength;
        }
        vInteract = influence;

        // Blade normal in world space; bias upward so thin cards still catch sunlight
        vec3 N = normalize(mat3(instanceMatrix) * normal);
        N = normalize(N + vec3(windPush.x, 0.22, windPush.y) * 0.85
                        + vec3(pushDir.x, 0.0, pushDir.y) * influence * 0.5);
        // Flattened grass faces more upward (self-shadow look)
        N = normalize(mix(N, vec3(0.0, 1.0, 0.0), 0.42 + influence * 0.35));
        vWorldNormal = N;
        vWorldPos = worldPos;

        gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;

      uniform vec3 uGrassColor;
      uniform vec3 uNoiseColor;
      uniform sampler2D uNoiseMap;
      uniform sampler2D uAlphaMap;
      uniform float uNoiseScale;
      uniform float uNoiseStrength;
      uniform float uNoiseContrast;
      uniform float uPatchSoftness;
      uniform float uRootAO;
      uniform float uPushShadow;
      uniform float uStrokeStrength;
      uniform float uAlphaCutoff;
      uniform vec2 uWindDir;

      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
      uniform float uSunIntensity;
      uniform float uAmbient;
      uniform float uSSS;
      uniform float uSpecular;
      uniform vec3 uFogColor;
      uniform float uFogNear;
      uniform float uFogFar;
      uniform float uFogEnabled;
      uniform float uLodNear;
      uniform float uLodFar;
      uniform float uLodFadeIn;
      uniform float uLodEnabled;
      uniform vec3 uPlayerPos;
      uniform float uPlayerRadius;
      uniform float uInteractEnabled;

      varying float vElevation;
      varying float vInteract;
      varying vec3 vWorldNormal;
      varying vec3 vWorldPos;
      varying vec2 vWorldXZ;
      varying vec2 vUv;

      void main() {
        // Silhouette cutout — one clump shape per instance
        float mask = texture2D(uAlphaMap, vUv).a;
        if (mask < uAlphaCutoff) discard;

        // --- Distance LOD: smooth translucent fade ---
        float dist = length(cameraPosition - vWorldPos);
        float visibility = 1.0;
        if (uLodEnabled > 0.5) {
          if (uLodFadeIn < 0.5) {
            visibility = 1.0 - smoothstep(uLodNear, max(uLodFar, uLodNear + 0.01), dist);
          } else {
            float fadeIn = smoothstep(uLodNear * 0.7, uLodNear + (uLodFar - uLodNear) * 0.15, dist);
            float fadeOut = 1.0 - smoothstep(uLodFar, uLodFar * 1.35, dist);
            visibility = fadeIn * fadeOut;
          }
          visibility = visibility * visibility * (3.0 - 2.0 * visibility);
        }
        if (visibility < 0.004) discard;

        // Flat fill colour (very subtle world patch only)
        vec2 nUV = vWorldXZ * uNoiseScale;
        float p1 = texture2D(uNoiseMap, nUV).r;
        float n = clamp((p1 - 0.5) * uNoiseContrast + 0.5, 0.0, 1.0);
        float soft = max(uPatchSoftness, 0.02);
        float patchMask = smoothstep(0.5 - soft, 0.5 + soft, n);
        vec3 col = mix(uGrassColor, uNoiseColor, patchMask * uNoiseStrength);
        col *= 1.0 - uRootAO * (1.0 - vElevation) * 0.25;
        col = max(col, uGrassColor * 0.95);

        // --- Soft sun (flat-ish lighting, not harsh metal) ---
        vec3 L = normalize(uSunDir);
        vec3 N = normalize(vWorldNormal);
        if (dot(N, L) < 0.0) N = -N;
        vec3 V = normalize(cameraPosition - vWorldPos);

        float ndl = max(dot(N, L), 0.0);
        float wrapDiff = ndl * 0.45 + 0.55; // soft wrap for cartoon meadow
        vec3 sunTerm = uSunColor * uSunIntensity * wrapDiff;

        float hemi = 0.55 + 0.45 * max(N.y, 0.0);
        vec3 sky = vec3(0.65, 0.78, 1.0);
        vec3 groundAmb = vec3(0.45, 0.62, 0.35);
        vec3 ambTerm = mix(groundAmb, sky, hemi) * uAmbient;

        float backlight = max(dot(V, -L), 0.0);
        float sss = pow(backlight, 1.5) * uSSS * 0.4;
        vec3 lit = col * (ambTerm + sunTerm) + col * uSunColor * sss;
        lit = max(lit, col * 0.55);

        // --- Soft green trail / pushed shadow (like reference under character) ---
        float push = clamp(vInteract, 0.0, 1.0);
        // Darker mint, not black
        vec3 crushCol = col * vec3(0.42, 0.55, 0.38);
        lit = mix(lit, crushCol, push * uPushShadow * (0.55 + 0.45 * (1.0 - vElevation)));

        if (uInteractEnabled > 0.5) {
          float pd = length(vWorldXZ - uPlayerPos.xz);
          // Soft elongated footprint shadow
          float blob = 1.0 - smoothstep(0.0, uPlayerRadius * 1.35, pd);
          blob = pow(blob, 1.6);
          vec3 trailCol = col * vec3(0.38, 0.52, 0.36);
          lit = mix(lit, trailCol, blob * 0.55 * uPushShadow);
        }

        if (uFogEnabled > 0.5) {
          float fog = smoothstep(uFogNear, uFogFar, dist);
          lit = mix(lit, uFogColor, fog);
        }

        gl_FragColor = vec4(lit, visibility);
      }
    `,
    side: THREE.DoubleSide,
    // Smooth translucent LOD fades (whole InstancedMesh = one sort unit)
    transparent: true,
    depthWrite: true,
    alphaTest: 0.0,
    opacity: 1,
  });
}


========================================================================
# FILE: src/grassField.js
========================================================================

import * as THREE from 'three';
import { createSilhouetteCrossGeometry } from './bladeGeometry.js';
import { createGrassMaterial } from './grassMaterial.js';
import { createColorNoiseTexture } from './noiseTexture.js';
import { createGrassSilhouetteTexture, loadGrassSilhouetteFromUrl } from './grassSilhouette.js';
import { fbm2, terrainHeight, terrainNormal } from './noise.js';

/**
 * Each instance = ONE grass clump silhouette card (Vecteezy-style tuft).
 * Near + far LOD share the same shape; far is scaled up / sparser.
 */
export class GrassField {
  constructor({
    size = 42,
    bladeCount = 35000,
    segments = 1, // unused (silhouette card)
    bladeWidth = 0.85,
    bladeHeight = 0.7,
    curvature = 0.14,
    bunchBlades = 1,
    lodNear = 14,
    lodFar = 28,
  } = {}) {
    this.size = size;
    this.targetCount = bladeCount;
    this.segments = segments;
    this.bladeWidth = bladeWidth;
    this.bladeHeight = bladeHeight;
    this.curvature = curvature;
    this.bunchBlades = bunchBlades;
    this.densityScale = 1;
    this.scaleMin = 0.85;
    this.scaleMax = 1.2;
    this.usePath = true;
    this.slopeMask = true;
    this.lodNear = lodNear;
    this.lodFar = lodFar;
    this.lodEnabled = true;

    this.group = new THREE.Group();
    this.group.name = 'GrassField';

    this._noiseMap = createColorNoiseTexture(256);
    this._alphaMap = createGrassSilhouetteTexture(512);

    this.nearMat = createGrassMaterial({
      noiseMap: this._noiseMap,
      alphaMap: this._alphaMap,
      lodNear,
      lodFar,
      lodFadeIn: false,
    });
    this.farMat = createGrassMaterial({
      noiseMap: this._noiseMap,
      alphaMap: this._alphaMap,
      lodNear,
      lodFar,
      lodFadeIn: true,
    });
    this._linkSharedUniforms(this.nearMat, this.farMat);
    this.material = this.nearMat;

    // Try load reference PNG/JPG silhouette (white → alpha)
    this._tryLoadRefSilhouette();

    // Crossed cards so edge-on views still show the clump silhouette
    this.nearGeo = createSilhouetteCrossGeometry(bladeWidth, bladeHeight);
    this.farGeo = createSilhouetteCrossGeometry(bladeWidth * 1.25, bladeHeight * 1.1);

    const farBudget = Math.max(2000, Math.floor(bladeCount * 0.16));
    this.nearMesh = new THREE.InstancedMesh(this.nearGeo, this.nearMat, bladeCount);
    this.farMesh = new THREE.InstancedMesh(this.farGeo, this.farMat, farBudget);
    for (const m of [this.nearMesh, this.farMesh]) {
      m.castShadow = false;
      m.receiveShadow = true;
      m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    }
    this.mesh = this.nearMesh;
    this.farBudget = farBudget;

    this._dummy = new THREE.Object3D();
    this._phases = new Float32Array(bladeCount);
    this._colorVars = new Float32Array(bladeCount);
    this._stiffness = new Float32Array(bladeCount);
    this._farPhases = new Float32Array(farBudget);
    this._farColors = new Float32Array(farBudget);
    this._farStiff = new Float32Array(farBudget);

    this.group.add(this.nearMesh, this.farMesh);
    this.rebuild();
  }

  async _tryLoadRefSilhouette() {
    try {
      // Prefer offline-cleaned PNG (better bg removal), fall back to JPG + runtime clean
      const tex = await loadGrassSilhouetteFromUrl('/grass-clump.png');
      this._alphaMap = tex;
      this.nearMat.uniforms.uAlphaMap.value = tex;
      this.farMat.uniforms.uAlphaMap.value = tex;
      // linked uniform should share — also set far explicitly
      if (this.farMat.uniforms.uAlphaMap) this.farMat.uniforms.uAlphaMap.value = tex;
    } catch {
      try {
        const tex = await loadGrassSilhouetteFromUrl('/grass-clump-ref.jpg');
        this._alphaMap = tex;
        this.nearMat.uniforms.uAlphaMap.value = tex;
        this.farMat.uniforms.uAlphaMap.value = tex;
      } catch {
        // keep procedural silhouette
      }
    }
  }

  _linkSharedUniforms(a, b) {
    const skip = new Set(['uLodNear', 'uLodFar', 'uLodFadeIn', 'uLodEnabled']);
    for (const key of Object.keys(a.uniforms)) {
      if (skip.has(key)) continue;
      if (b.uniforms[key]) b.uniforms[key] = a.uniforms[key];
    }
  }

  setLodDistances(near, far) {
    this.lodNear = near;
    this.lodFar = Math.max(far, near + 1);
    this.nearMat.uniforms.uLodNear.value = this.lodNear;
    this.nearMat.uniforms.uLodFar.value = this.lodFar;
    this.farMat.uniforms.uLodNear.value = this.lodNear;
    this.farMat.uniforms.uLodFar.value = this.lodFar;
  }

  setLodEnabled(on) {
    this.lodEnabled = on;
    const v = on ? 1 : 0;
    this.nearMat.uniforms.uLodEnabled.value = v;
    this.farMat.uniforms.uLodEnabled.value = v;
    this.farMesh.visible = on;
  }

  setTime(t) {
    this.material.uniforms.uTime.value = t;
  }

  setPlayer(pos) {
    this.material.uniforms.uPlayerPos.value.copy(pos);
  }

  setWindDir(angleDeg) {
    const r = (angleDeg * Math.PI) / 180;
    this.material.uniforms.uWindDir.value.set(Math.cos(r), Math.sin(r));
  }

  setBladeShape({ width, height } = {}) {
    if (width != null) this.bladeWidth = width;
    if (height != null) this.bladeHeight = height;

    const nearNext = createSilhouetteCrossGeometry(this.bladeWidth, this.bladeHeight);
    const farNext = createSilhouetteCrossGeometry(this.bladeWidth * 1.25, this.bladeHeight * 1.1);

    const copyAttrs = (fromGeo, toGeo) => {
      for (const name of ['aPhase', 'aColorVar', 'aStiffness']) {
        const a = fromGeo.getAttribute(name);
        if (a) toGeo.setAttribute(name, a);
      }
    };
    copyAttrs(this.nearGeo, nearNext);
    copyAttrs(this.farGeo, farNext);

    this.nearGeo.dispose();
    this.farGeo.dispose();
    this.nearGeo = nearNext;
    this.farGeo = farNext;
    this.nearMesh.geometry = nearNext;
    this.farMesh.geometry = farNext;
  }

  _placeInstance(dummy, x, y, z, n, random, scaleMin, scaleMax, scaleBoost = 1) {
    // Spread yaws so the field isn’t one flat wall when viewed from the side.
    // Cross geometry already covers 90°; instance yaw adds the rest.
    const yaw = random() * Math.PI * 2;
    const t = random();
    const scaleY = (scaleMin + t * (scaleMax - scaleMin) * 0.5 + (scaleMax - scaleMin) * 0.25) * scaleBoost;
    const scaleX = (0.92 + random() * 0.2) * scaleBoost;
    const tiltX = (1 - n.y) * (random() - 0.5) * 0.1;
    dummy.position.set(x, y, z);
    dummy.rotation.set(tiltX, yaw, 0);
    dummy.scale.set(scaleX, scaleY, 1);
    dummy.updateMatrix();
  }

  rebuild({
    densityScale = this.densityScale,
    scaleMin = this.scaleMin,
    scaleMax = this.scaleMax,
    usePath = this.usePath,
    slopeMask = this.slopeMask,
  } = {}) {
    this.densityScale = densityScale;
    this.scaleMin = scaleMin;
    this.scaleMax = Math.max(scaleMax, scaleMin + 0.05);
    this.usePath = usePath;
    this.slopeMask = slopeMask;

    const size = this.size;
    const half = size * 0.5;
    const area = size * size;
    // Silhouette clumps are wider — moderate density
    const baseDensity = (this.targetCount / area) * densityScale * 0.85;
    const gridStep = 1 / Math.sqrt(Math.max(baseDensity, 0.4));
    const chunkStep = gridStep * 2.5;

    const dummy = this._dummy;
    let rng = 1234567;
    const random = () => {
      rng = (rng * 1664525 + 1013904223) >>> 0;
      return rng / 0xffffffff;
    };

    const accept = (x, z, randomFn) => {
      const dn = fbm2(x * 0.045, z * 0.045, 4) * 2 - 1;
      if (dn < -0.28) return false;
      if (randomFn() > dn * 0.45 + 0.72) return false;
      if (usePath) {
        const path = Math.exp(-((x * 0.08) ** 2) * 0.35 - ((z - 2) * 0.15) ** 2);
        if (path > 0.55 && randomFn() > 0.15) return false;
      }
      const nrm = terrainNormal(x, z);
      if (slopeMask && nrm.y < 0.72) return false;
      return true;
    };

    let i = 0;
    const max = this.targetCount;
    for (let gx = -half; gx < half && i < max; gx += gridStep) {
      for (let gz = -half; gz < half && i < max; gz += gridStep) {
        const x = gx + (random() - 0.5) * gridStep * 0.9;
        const z = gz + (random() - 0.5) * gridStep * 0.9;
        if (!accept(x, z, random)) continue;
        const y = terrainHeight(x, z);
        const nrm = terrainNormal(x, z);
        this._placeInstance(dummy, x, y, z, nrm, random, scaleMin, scaleMax, 1);
        this.nearMesh.setMatrixAt(i, dummy.matrix);
        this._phases[i] = random() * Math.PI * 2;
        this._colorVars[i] = random();
        this._stiffness[i] = random();
        i++;
      }
    }
    this.nearMesh.count = i;
    this.nearMesh.instanceMatrix.needsUpdate = true;
    this.nearGeo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(this._phases.slice(0, i), 1));
    this.nearGeo.setAttribute('aColorVar', new THREE.InstancedBufferAttribute(this._colorVars.slice(0, i), 1));
    this.nearGeo.setAttribute('aStiffness', new THREE.InstancedBufferAttribute(this._stiffness.slice(0, i), 1));

    let j = 0;
    const maxFar = this.farBudget;
    rng = 987654321;
    for (let gx = -half; gx < half && j < maxFar; gx += chunkStep) {
      for (let gz = -half; gz < half && j < maxFar; gz += chunkStep) {
        const x = gx + (random() - 0.5) * chunkStep * 0.7;
        const z = gz + (random() - 0.5) * chunkStep * 0.7;
        if (!accept(x, z, random)) continue;
        if (random() > 0.75) continue;
        const y = terrainHeight(x, z);
        const nrm = terrainNormal(x, z);
        this._placeInstance(dummy, x, y, z, nrm, random, scaleMin, scaleMax, 1.2);
        this.farMesh.setMatrixAt(j, dummy.matrix);
        this._farPhases[j] = random() * Math.PI * 2;
        this._farColors[j] = random();
        this._farStiff[j] = random();
        j++;
      }
    }
    this.farMesh.count = j;
    this.farMesh.instanceMatrix.needsUpdate = true;
    this.farGeo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(this._farPhases.slice(0, j), 1));
    this.farGeo.setAttribute('aColorVar', new THREE.InstancedBufferAttribute(this._farColors.slice(0, j), 1));
    this.farGeo.setAttribute('aStiffness', new THREE.InstancedBufferAttribute(this._farStiff.slice(0, j), 1));

    if (!this.ground) {
      const ggeo = new THREE.PlaneGeometry(size + 4, size + 4, 128, 128);
      ggeo.rotateX(-Math.PI / 2);
      const pos = ggeo.attributes.position;
      for (let vi = 0; vi < pos.count; vi++) {
        const px = pos.getX(vi);
        const pz = pos.getZ(vi);
        pos.setY(vi, terrainHeight(px, pz));
      }
      pos.needsUpdate = true;
      ggeo.computeVertexNormals();
      const gmat = new THREE.MeshStandardMaterial({
        color: new THREE.Color('#6fc468'),
        roughness: 1.0,
        metalness: 0.0,
      });
      this.ground = new THREE.Mesh(ggeo, gmat);
      this.ground.receiveShadow = true;
      this.ground.position.y = -0.02;
    }

    this.setLodDistances(this.lodNear, this.lodFar);
    this.setLodEnabled(this.lodEnabled);

    return { near: i, far: j, total: i + j };
  }

  get object() {
    return this.group;
  }

  get count() {
    return (this.nearMesh?.count || 0) + (this.farMesh?.count || 0);
  }
}


========================================================================
# FILE: src/bladeGeometry.js
========================================================================

import * as THREE from 'three';

/**
 * Single grass clump card — one plane for a silhouette texture
 * (Vecteezy-style “one grass bunch” per instance).
 * UV: u across, v = 0 base → 1 tip (for wind root lock).
 */
export function createSilhouetteCardGeometry(width = 0.9, height = 0.75) {
  // Simple vertical plane in XY, facing +Z
  const hw = width * 0.5;
  const positions = new Float32Array([
    -hw, 0, 0,
    hw, 0, 0,
    hw, height, 0,
    -hw, height, 0,
  ]);
  const uvs = new Float32Array([
    0, 0,
    1, 0,
    1, 1,
    0, 1,
  ]);
  const normals = new Float32Array([
    0, 0, 1,
    0, 0, 1,
    0, 0, 1,
    0, 0, 1,
  ]);
  const indices = [0, 1, 2, 0, 2, 3];

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setIndex(indices);
  return geometry;
}

/**
 * Crossed silhouette (two cards @ 90°) — same clump icon, readable from all angles.
 * Avoids the “paper thin line” when viewed edge-on.
 */
export function createSilhouetteCrossGeometry(width = 0.9, height = 0.75) {
  const hw = width * 0.5;
  const positions = [];
  const uvs = [];
  const normals = [];
  const indices = [];

  const addPlane = (yaw) => {
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const base = positions.length / 3;
    const corners = [
      [-hw, 0],
      [hw, 0],
      [hw, height],
      [-hw, height],
    ];
    const uvC = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    for (let i = 0; i < 4; i++) {
      const lx = corners[i][0];
      const ly = corners[i][1];
      positions.push(lx * c, ly, -lx * s);
      uvs.push(uvC[i][0], uvC[i][1]);
      // outward-ish normal
      normals.push(s, 0, c);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  addPlane(0);
  addPlane(Math.PI * 0.5);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setIndex(indices);
  return geometry;
}

export function createFlatBunchGeometry(bladeCount, width = 0.9, height = 0.75) {
  return createSilhouetteCrossGeometry(width * 2.2, height);
}

export function createClumpGeometry(bladeCount, width = 1.0, height = 0.8) {
  return createSilhouetteCrossGeometry(width * 2.4, height);
}

export function createBladeGeometry(segments, width = 0.5, height = 0.7) {
  return createSilhouetteCrossGeometry(width * 2, height);
}


========================================================================
# FILE: src/grassSilhouette.js
========================================================================

import * as THREE from 'three';

/**
 * Improved white-background removal for grass icons:
 * - green chroma key
 * - corner flood-fill of white bg
 * - dilate/erode hole fill
 * - soft edge blur
 */
export function removeWhiteBackgroundToAlpha(imageData) {
  const { data, width: w, height: h } = imageData;
  const alpha = new Uint8Array(w * h);

  const lumAt = (i) => (data[i] + data[i + 1] + data[i + 2]) / 3;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const lum = (r + g + b) / 3;
      const idx = y * w + x;

      const nearWhite =
        lum > 240 && Math.abs(r - g) < 28 && Math.abs(g - b) < 28 && Math.abs(r - b) < 28;
      const pureWhite = r > 250 && g > 250 && b > 250;
      const greenGrass = g > 75 && g >= r * 0.82 && g >= b * 0.72 && lum < 248;

      if (greenGrass && !pureWhite) {
        // Soften near-white greens at edge of icon
        const edge = Math.min(1, Math.max(0, (245 - lum) / 40));
        alpha[idx] = Math.round(255 * Math.max(edge, greenGrass ? 1 : 0));
        if (lum < 240) alpha[idx] = 255;
      } else if (nearWhite || pureWhite || g < 70) {
        alpha[idx] = 0;
      } else {
        const score = g - Math.max(r, b);
        alpha[idx] = score > 20 ? 255 : score > 5 ? 160 : 0;
      }
    }
  }

  // Flood-fill background from image borders (force white regions to transparent)
  const vis = new Uint8Array(w * h);
  const q = [];
  const tryPush = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const id = y * w + x;
    if (vis[id]) return;
    const i = id * 4;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const lum = (r + g + b) / 3;
    // only flood through bright/white-ish pixels
    if (lum < 205 && !(r > 215 && g > 215 && b > 215)) return;
    vis[id] = 1;
    alpha[id] = 0;
    q.push(x, y);
  };
  for (let x = 0; x < w; x++) {
    tryPush(x, 0);
    tryPush(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    tryPush(0, y);
    tryPush(w - 1, y);
  }
  for (let qi = 0; qi < q.length; ) {
    const x = q[qi++];
    const y = q[qi++];
    tryPush(x + 1, y);
    tryPush(x - 1, y);
    tryPush(x, y + 1);
    tryPush(x, y - 1);
  }

  // Morphological close (fill pinholes in leaves)
  const dilate = (src) => {
    const dst = new Uint8Array(src.length);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        let m = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            m = Math.max(m, src[(y + dy) * w + (x + dx)]);
          }
        }
        dst[y * w + x] = m;
      }
    }
    return dst;
  };
  const erode = (src) => {
    const dst = new Uint8Array(src.length);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        let m = 255;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            m = Math.min(m, src[(y + dy) * w + (x + dx)]);
          }
        }
        dst[y * w + x] = m;
      }
    }
    return dst;
  };
  let a2 = dilate(alpha);
  a2 = dilate(a2);
  a2 = erode(a2);
  a2 = erode(a2);

  // Soft 3x3 blur on alpha for anti-aliased edges
  const soft = new Uint8Array(a2.length);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let s = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          s += a2[(y + dy) * w + (x + dx)];
        }
      }
      soft[y * w + x] = Math.round(s / 9);
    }
  }

  // Write back as white RGB + alpha
  for (let i = 0; i < w * h; i++) {
    const p = i * 4;
    data[p] = 255;
    data[p + 1] = 255;
    data[p + 2] = 255;
    data[p + 3] = soft[i];
  }
  return imageData;
}

export function createGrassSilhouetteTexture(size = 512) {
  // Prefer pre-baked high-quality PNG if already loaded via TextureLoader path
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = '#ffffff';

  const X = (u) => u * size;
  const Y = (v) => (1 - v) * size;

  ctx.beginPath();
  ctx.moveTo(X(0.12), Y(0.0));
  ctx.lineTo(X(0.12), Y(0.12));
  ctx.bezierCurveTo(X(0.3), Y(0.2), X(0.7), Y(0.2), X(0.88), Y(0.12));
  ctx.lineTo(X(0.88), Y(0.0));
  ctx.closePath();
  ctx.fill();

  function blade(baseX, tipX, tipV, baseW) {
    ctx.beginPath();
    ctx.moveTo(X(baseX - baseW), Y(0.02));
    ctx.quadraticCurveTo(X(baseX - baseW * 0.35), Y(tipV * 0.55), X(tipX), Y(tipV));
    ctx.quadraticCurveTo(X(baseX + baseW * 0.35), Y(tipV * 0.55), X(baseX + baseW), Y(0.02));
    ctx.closePath();
    ctx.fill();
  }

  blade(0.22, 0.14, 0.58, 0.055);
  blade(0.28, 0.22, 0.72, 0.05);
  blade(0.34, 0.3, 0.86, 0.055);
  blade(0.4, 0.38, 0.94, 0.055);
  blade(0.46, 0.46, 1.0, 0.06);
  blade(0.5, 0.5, 0.98, 0.055);
  blade(0.54, 0.54, 1.0, 0.06);
  blade(0.6, 0.62, 0.92, 0.055);
  blade(0.66, 0.7, 0.84, 0.05);
  blade(0.72, 0.78, 0.7, 0.05);
  blade(0.78, 0.86, 0.56, 0.045);
  blade(0.36, 0.34, 0.55, 0.035);
  blade(0.64, 0.66, 0.52, 0.035);
  blade(0.48, 0.47, 0.7, 0.04);
  blade(0.18, 0.08, 0.42, 0.04);
  blade(0.84, 0.94, 0.4, 0.04);

  const img = ctx.getImageData(0, 0, size, size);
  removeWhiteBackgroundToAlpha(img);
  ctx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Load pre-baked PNG (preferred) or JPG with improved bg removal.
 */
export async function loadGrassSilhouetteFromUrl(url) {
  // Prefer clean PNG next to ref
  const preferPng = url.replace(/grass-clump-ref\.jpe?g$/i, 'grass-clump.png');
  const urls = preferPng !== url ? [preferPng, url] : [url];

  for (const u of urls) {
    try {
      const tex = await loadOne(u, u.endsWith('.png'));
      if (tex) return tex;
    } catch {
      /* try next */
    }
  }
  throw new Error('silhouette load failed');
}

function loadOne(url, isPng) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const size = 512;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, size, size);
      const scale = Math.min(size / img.width, size / img.height) * 0.94;
      const w = img.width * scale;
      const h = img.height * scale;
      const ox = (size - w) / 2;
      const oy = (size - h) / 2 + size * 0.02;
      ctx.drawImage(img, ox, oy, w, h);

      if (isPng) {
        // Already has alpha from offline process — just normalize RGB to white
        const data = ctx.getImageData(0, 0, size, size);
        const d = data.data;
        for (let i = 0; i < d.length; i += 4) {
          const a = d[i + 3];
          d[i] = 255;
          d[i + 1] = 255;
          d[i + 2] = 255;
          d[i + 3] = a > 20 ? a : 0;
        }
        ctx.putImageData(data, 0, 0);
      } else {
        const data = ctx.getImageData(0, 0, size, size);
        removeWhiteBackgroundToAlpha(data);
        ctx.putImageData(data, 0, 0);
      }

      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.NoColorSpace;
      tex.magFilter = THREE.LinearFilter;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.generateMipmaps = true;
      tex.needsUpdate = true;
      tex.premultiplyAlpha = false;
      resolve(tex);
    };
    img.onerror = () => reject(new Error('fail ' + url));
    img.src = url + (url.includes('?') ? '&' : '?') + 'v=2';
  });
}


========================================================================
# FILE: src/noise.js
========================================================================

/** Simple deterministic 2D value noise + fbm (no deps). */

function hash2(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

export function valueNoise2(x, y) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = smoothstep(x - x0);
  const fy = smoothstep(y - y0);
  const a = hash2(x0, y0);
  const b = hash2(x0 + 1, y0);
  const c = hash2(x0, y0 + 1);
  const d = hash2(x0 + 1, y0 + 1);
  const u = a + (b - a) * fx;
  const v = c + (d - c) * fx;
  return u + (v - u) * fy;
}

export function fbm2(x, y, octaves = 4) {
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise2(x * freq, y * freq);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

/** Terrain height in world units. */
export function terrainHeight(x, z) {
  const n =
    fbm2(x * 0.035, z * 0.035, 5) * 2.4 +
    fbm2(x * 0.012, z * 0.012, 3) * 1.6 +
    Math.sin(x * 0.08) * Math.cos(z * 0.07) * 0.35;
  return n * 0.55;
}

export function terrainNormal(x, z, eps = 0.35) {
  const hL = terrainHeight(x - eps, z);
  const hR = terrainHeight(x + eps, z);
  const hD = terrainHeight(x, z - eps);
  const hU = terrainHeight(x, z + eps);
  // unnormalized cross of tangent vectors
  const nx = hL - hR;
  const ny = 2 * eps;
  const nz = hD - hU;
  const len = Math.hypot(nx, ny, nz) || 1;
  return { x: nx / len, y: ny / len, z: nz / len };
}


========================================================================
# FILE: src/noiseTexture.js
========================================================================

import * as THREE from 'three';

/**
 * Large soft colour-patch map for A+-style grass variation.
 * Low-frequency blobs + cellular cells → meadow patches, not fine grain.
 */
export function createColorNoiseTexture(size = 256) {
  const data = new Uint8Array(size * size * 4);

  const hash2 = (ix, iy) => {
    const s = Math.sin(ix * 127.1 + iy * 311.7) * 43758.5453;
    return s - Math.floor(s);
  };

  const smooth = (t) => t * t * (3 - 2 * t);

  const valueNoise = (x, y) => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = smooth(x - x0);
    const fy = smooth(y - y0);
    const a = hash2(x0, y0);
    const b = hash2(x0 + 1, y0);
    const c = hash2(x0, y0 + 1);
    const d = hash2(x0 + 1, y0 + 1);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };

  // few octaves only → broad shapes
  const fbmLow = (x, y) => {
    let v = 0;
    let a = 0.55;
    let f = 1;
    let n = 0;
    for (let i = 0; i < 3; i++) {
      v += a * valueNoise(x * f, y * f);
      n += a;
      a *= 0.5;
      f *= 2.0;
    }
    return v / n;
  };

  // cellular / Worley-ish: distance to nearest random point in cell grid
  const worley = (x, y) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    let minD = 1e9;
    let minD2 = 1e9;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const cx = xi + ox;
        const cy = yi + oy;
        const px = cx + hash2(cx, cy);
        const py = cy + hash2(cx + 19, cy + 47);
        const dx = px - x;
        const dy = py - y;
        const d = dx * dx + dy * dy;
        if (d < minD) {
          minD2 = minD;
          minD = d;
        } else if (d < minD2) {
          minD2 = d;
        }
      }
    }
    const d1 = Math.sqrt(minD);
    const d2 = Math.sqrt(minD2);
    // F2-F1 style soft cell edges
    return THREE.MathUtils.clamp(d2 - d1, 0, 1);
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;

      // large meadow blobs (very low frequency across texture)
      const blobs = fbmLow(u * 2.2, v * 2.2);
      // organic cells ~ handful of patches across the map
      const cells = worley(u * 5.5, v * 5.5);
      // combine: broad tone + cell structure
      let patch = blobs * 0.55 + (1.0 - cells) * 0.45;
      // soft threshold → clearer patch regions (not salt-and-pepper)
      patch = smooth(THREE.MathUtils.clamp((patch - 0.32) / 0.45, 0, 1));

      // second layer of slightly offset patches for R vs G variety
      const blobs2 = fbmLow(u * 2.0 + 3.1, v * 2.0 + 1.7);
      const cells2 = worley(u * 4.2 + 1.3, v * 4.2 - 0.8);
      let patch2 = blobs2 * 0.5 + (1.0 - cells2) * 0.5;
      patch2 = smooth(THREE.MathUtils.clamp((patch2 - 0.35) / 0.4, 0, 1));

      const i = (y * size + x) * 4;
      data[i] = Math.floor(THREE.MathUtils.clamp(patch, 0, 1) * 255);
      data[i + 1] = Math.floor(THREE.MathUtils.clamp(patch2, 0, 1) * 255);
      data[i + 2] = Math.floor(THREE.MathUtils.clamp((patch + patch2) * 0.5, 0, 1) * 255);
      data[i + 3] = 255;
    }
  }

  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}


========================================================================
# FILE: src/style.css
========================================================================

* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

html,
body {
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: #0b1220;
  font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial,
    sans-serif;
  color: #e8f0e6;
}

#c {
  display: block;
  width: 100%;
  height: 100%;
}

.panel {
  position: fixed;
  top: 12px;
  right: 12px;
  z-index: 20;
  width: min(340px, calc(100vw - 24px));
  max-height: calc(100vh - 24px);
  display: flex;
  flex-direction: column;
  border-radius: 16px;
  background: rgba(8, 14, 10, 0.82);
  border: 1px solid rgba(180, 220, 160, 0.2);
  backdrop-filter: blur(14px);
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.4);
  overflow: hidden;
}

.panel.collapsed .panel-body {
  display: none;
}

.panel-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  padding: 14px 14px 10px;
  border-bottom: 1px solid rgba(180, 220, 160, 0.12);
}

.panel-header h1 {
  font-size: 14px;
  font-weight: 650;
  color: #c8f0b0;
  letter-spacing: 0.02em;
}

.panel-header .sub {
  margin-top: 3px;
  font-size: 11px;
  opacity: 0.75;
  line-height: 1.35;
}

.icon-btn {
  border: 0;
  background: rgba(255, 255, 255, 0.06);
  color: #dff5d0;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
}

.icon-btn:hover {
  background: rgba(255, 255, 255, 0.12);
}

.panel-body {
  overflow-y: auto;
  padding: 10px 14px 16px;
  overscroll-behavior: contain;
}

.stats {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  color: #b6d9a8;
  margin-bottom: 10px;
  padding: 8px 10px;
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.25);
  line-height: 1.45;
}

.section {
  padding: 10px 0 12px;
  border-top: 1px solid rgba(180, 220, 160, 0.1);
}

.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.section-head h2 {
  font-size: 12px;
  font-weight: 650;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #9fd48a;
}

.section-note {
  font-size: 10px;
  line-height: 1.4;
  opacity: 0.65;
  margin: 0 0 8px;
  color: #c8e8b8;
}

.toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  opacity: 0.9;
  cursor: pointer;
  user-select: none;
}

.ctrl {
  display: grid;
  grid-template-columns: 88px 1fr 40px;
  align-items: center;
  gap: 8px;
  margin-top: 7px;
  font-size: 11px;
}

.ctrl.color {
  grid-template-columns: 88px 1fr;
}

.ctrl span {
  opacity: 0.85;
}

.ctrl em {
  font-style: normal;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 10px;
  opacity: 0.75;
  text-align: right;
}

.ctrl input[type='range'] {
  width: 100%;
  accent-color: #7ecf6a;
}

.ctrl input[type='color'] {
  width: 100%;
  height: 28px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
  padding: 0;
}

.check {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  font-size: 11px;
  cursor: pointer;
  user-select: none;
}

.check input {
  accent-color: #7ecf6a;
}

.btn {
  margin-top: 10px;
  width: 100%;
  border: 0;
  border-radius: 10px;
  padding: 9px 12px;
  background: linear-gradient(180deg, #6fbf5a, #4e9a3f);
  color: #0c160c;
  font-weight: 650;
  font-size: 12px;
  cursor: pointer;
}

.btn:hover {
  filter: brightness(1.06);
}

.btn.ghost {
  background: rgba(255, 255, 255, 0.08);
  color: #e8f0e6;
  border: 1px solid rgba(180, 220, 160, 0.18);
}

.wind-compass-wrap {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 6px 0 4px;
}

#windCompass {
  width: 120px;
  height: 120px;
  border-radius: 50%;
  background: radial-gradient(circle at 40% 35%, #1a2a1c, #0a100c 70%);
  border: 1px solid rgba(160, 210, 140, 0.25);
  cursor: crosshair;
  touch-action: none;
  flex-shrink: 0;
}

.wind-compass-meta {
  font-size: 12px;
  line-height: 1.45;
}

.wind-compass-meta .hint-sm {
  font-size: 10px;
  opacity: 0.65;
  margin-top: 4px;
}

/* keep canvas free of panel pointer capture except panel itself */
.panel,
.panel * {
  pointer-events: auto;
}

// Forge Environments mode — live biome / atmosphere preview and style editor.
//
// Uses the game's TerrainWorld + clipmap ground + scatter + grass + atmosphere
// + post chain (ARCHITECTURE: "WYSIWYG or the tool is useless"). Edits mutate
// BIOME_STYLES in place, rebake the palette maps, and force a scatter/grass
// rebuild. Copy JSON exports a patch you can paste into biomes.ts; nothing
// writes source files from the browser.

import * as THREE from 'three/webgpu'
import { Atmosphere } from '../../atmosphere/sky'
import { WindField } from '../../atmosphere/wind'
import { Clock } from '../../core/clock'
import { Rng } from '../../core/rng'
import { buildPostChain } from '../../post/postChain'
import {
  BIOME_IDS, BIOME_STYLES, authoredBiomeStyle, biomeStyleToJson, cloneBiomeStyle,
  replaceBiomeStyle, resetBiomeStyle, type BiomeId, type BiomeStyle, type ScatterEntry,
} from '../../terrain/biomes'
import { TerrainWorld } from '../../terrain/world'
import { buildWorld } from '../../world/world'
import { scatterIds } from '../registry'
import { BIOMES } from '../../deform/biome'

declare global {
  interface Window {
    __ready?: Promise<void>
    __forgeEnv?: {
      biome: BiomeId
      style: BiomeStyle
      lastExport: string
      terrain: TerrainWorld
      apply: () => void
      exportJson: () => string
      reset: () => void
    }
  }
}

/** Authored vista cameras from tools/shots.mjs biome-* captures. Forced biome
 *  paints the whole world, so any site works; these keep the known references. */
const VIEWS: Record<BiomeId, { x: number; z: number; eye: number; yaw: number; pitch: number }> = {
  meadow: { x: 2160, z: -420, eye: 6, yaw: 1.15, pitch: -0.06 },
  forest: { x: 1680, z: 240, eye: 8, yaw: 0.85, pitch: -0.08 },
  desert: { x: 2820, z: -2220, eye: 8, yaw: 1.15, pitch: -0.05 },
  alpine: { x: 2700, z: 3000, eye: 14, yaw: 2.30, pitch: -0.05 },
  wetland: { x: 960, z: -780, eye: 7, yaw: 1.4, pitch: -0.1 },
  coast: { x: -520, z: -1100, eye: 6, yaw: -0.6, pitch: -0.08 },
}

const RESPONSE_KEYS = Object.keys(BIOMES) as Array<keyof typeof BIOMES>
const GRASS_IDS = ['', ...scatterIds().filter((id) => id.startsWith('grass'))]
const ALL_SCATTER = scatterIds()

const COLOR_FIELDS = [
  'base', 'shadow', 'lit', 'cliff', 'under', 'rock', 'fog', 'sunTint',
] as const satisfies ReadonlyArray<keyof BiomeStyle>

const NUM_FIELDS: ReadonlyArray<{
  key: keyof BiomeStyle
  min: number
  max: number
  step: number
  label: string
}> = [
  { key: 'relief', min: 0, max: 40, step: 0.5, label: 'relief (m)' },
  { key: 'reliefScale', min: 20, max: 400, step: 5, label: 'relief scale (m)' },
  { key: 'reliefRidge', min: 0, max: 1, step: 0.01, label: 'relief ridge' },
  { key: 'rockSlope', min: 0.5, max: 1, step: 0.01, label: 'rock slope (cos)' },
  { key: 'grassDensity', min: 0, max: 2.5, step: 0.01, label: 'grass / m²' },
  { key: 'grassScale', min: 0.3, max: 2, step: 0.05, label: 'grass scale' },
  { key: 'fogDensity', min: 0.2, max: 2.5, step: 0.05, label: 'fog density' },
  { key: 'ambient', min: 0.5, max: 1.6, step: 0.01, label: 'ambient' },
]

function hexCss(n: number): string {
  return `#${(n >>> 0).toString(16).padStart(6, '0')}`
}
function parseHex(s: string, fallback: number): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(s.trim())
  return m ? Number.parseInt(m[1]!, 16) : fallback
}

/** Assign a numeric BiomeStyle field without fighting the scatter/string union. */
function setStyleNumber(style: BiomeStyle, key: string, value: number): void {
  ;(style as unknown as Record<string, unknown>)[key] = value
}

function fail(e: unknown): never {
  const el = document.getElementById('err') as HTMLDivElement
  el.style.display = 'grid'
  el.textContent = (e instanceof Error ? `${e.message}\n\n${e.stack ?? ''}` : String(e)) +
    '\n\nThis build is WebGPU-only (Chrome/Edge/Safari 26+).'
  throw e instanceof Error ? e : new Error(String(e))
}

export async function bootEnvEditor(): Promise<void> {
  if (!navigator.gpu) fail(new Error('navigator.gpu is unavailable.'))

  const q = new URLSearchParams(location.search)
  const numParam = (k: string, d: number): number => {
    const v = Number(q.get(k))
    return q.has(k) && Number.isFinite(v) ? v : d
  }
  const warmup = Math.max(1, Math.round(numParam('warmup', 64)))
  let biome: BiomeId = (BIOME_IDS.includes(q.get('biome') as BiomeId)
    ? q.get('biome') as BiomeId
    : 'meadow')
  let tod = numParam('time', 0.42)
  // Vite HMR can keep a mutated BIOME_STYLES across soft reloads of this
  // module. Always start from the authored snapshot so a previous pink
  // experiment cannot leak into a fresh Environments session.
  resetBiomeStyle()
  let draft = cloneBiomeStyle(BIOME_STYLES[biome])
  let lastExport = ''

  let resolveReady!: () => void
  window.__ready = new Promise<void>((r) => { resolveReady = r })

  const canvas = document.getElementById('app') as HTMLCanvasElement
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true })
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  renderer.setSize(innerWidth, innerHeight)
  renderer.toneMapping = THREE.NoToneMapping
  await renderer.init()

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 0.1, 12_000)
  camera.rotation.order = 'YXZ'

  const atmosphere = new Atmosphere(tod)
  scene.add(atmosphere.dome)
  const wind = new WindField()
  const terrain = new TerrainWorld(new Rng('forge-env'), { forced: biome })
  const world = buildWorld(atmosphere, wind, null, terrain)
  scene.add(world.group)

  const view = { ...VIEWS[biome] }
  const placeCamera = (): void => {
    const gy = world.heightAt(view.x, view.z)
    camera.position.set(view.x, gy + view.eye, view.z)
    camera.rotation.y = view.yaw
    camera.rotation.x = view.pitch
    world.recentre(view.x, view.z, true)
  }
  placeCamera()

  const applyGrade = (): void => {
    const fog = new THREE.Color().setHex(draft.fog, THREE.SRGBColorSpace)
    const sun = new THREE.Color().setHex(draft.sunTint, THREE.SRGBColorSpace)
    atmosphere.setBiomeGrade(fog, draft.fogDensity, sun, draft.ambient)
  }

  const applyLive = (): void => {
    replaceBiomeStyle(biome, draft)
    terrain.rebake()
    world.scatter.reloadChoices(atmosphere)
    world.recentre(view.x, view.z, true)
    applyGrade()
    syncHud()
  }

  applyGrade()

  const pipeline = buildPostChain(renderer, scene, camera, atmosphere)
  const clock = new Clock({ fixedDelta: 1 / 60 })
  const hud = document.getElementById('hud') as HTMLDivElement

  const syncHud = (): void => {
    const g = world.heightAt(view.x, view.z)
    hud.textContent =
      `ENV  ${biome}  tod=${tod.toFixed(2)}  eye=${view.eye.toFixed(1)}\n` +
      `pos ${view.x.toFixed(0)},${g.toFixed(1)},${view.z.toFixed(0)}  ` +
      `scatter ${world.scatter.instances}\n` +
      `drag orbit · scroll eye · 1-6 biome · R reset`
  }
  syncHud()

  window.__forgeEnv = {
    get biome() { return biome },
    get style() { return cloneBiomeStyle(draft) },
    get lastExport() { return lastExport },
    terrain,
    apply: applyLive,
    exportJson: () => {
      lastExport = biomeStyleToJson(draft)
      return lastExport
    },
    reset: () => {
      resetBiomeStyle(biome)
      draft = cloneBiomeStyle(BIOME_STYLES[biome])
      applyLive()
      renderPanel()
    },
  }

  // ── panel DOM ─────────────────────────────────────────────────────────────
  const panel = document.getElementById('env-panel') as HTMLDivElement
  panel.hidden = false

  const renderPanel = (): void => {
    const scatterOpts = ALL_SCATTER.map(
      (id) => `<option value="${id}">${id}</option>`,
    ).join('')
    const grassOpts = GRASS_IDS.map(
      (id) => `<option value="${id}" ${draft.grassId === id ? 'selected' : ''}>${id || '(none)'}</option>`,
    ).join('')
    const respOpts = RESPONSE_KEYS.map(
      (k) => `<option value="${k}" ${draft.response === k ? 'selected' : ''}>${k}</option>`,
    ).join('')

    panel.innerHTML = `
      <div class="forge-section">
        <div class="forge-row forge-tabs-biome">
          ${BIOME_IDS.map((id) =>
            `<button type="button" data-biome="${id}" class="${id === biome ? 'on' : ''}">${id}</button>`,
          ).join('')}
        </div>
      </div>
      <div class="forge-section">
        <label>time of day <span data-readout="tod">${tod.toFixed(2)}</span>
          <input type="range" min="0" max="1" step="0.01" value="${tod}" data-tod />
        </label>
        <label>eye height (m) <span data-readout="eye">${view.eye.toFixed(1)}</span>
          <input type="range" min="1.5" max="40" step="0.5" value="${view.eye}" data-eye />
        </label>
      </div>
      <div class="forge-section">
        <h3>ground</h3>
        <div class="forge-colors">
          ${COLOR_FIELDS.filter((k) => k !== 'fog' && k !== 'sunTint').map((k) => `
            <label title="${k}"><span>${k}</span>
              <input type="color" data-color="${k}" value="${hexCss(draft[k] as number)}" />
            </label>`).join('')}
        </div>
        ${NUM_FIELDS.filter((f) =>
          f.key === 'relief' || f.key === 'reliefScale' || f.key === 'reliefRidge' || f.key === 'rockSlope',
        ).map((f) => `
          <label>${f.label} <span data-readout="${f.key}">${Number(draft[f.key]).toFixed(2)}</span>
            <input type="range" min="${f.min}" max="${f.max}" step="${f.step}"
              value="${draft[f.key] as number}" data-num="${f.key}" />
          </label>`).join('')}
      </div>
      <div class="forge-section">
        <h3>grass</h3>
        <label>grass def
          <select data-grass-id>${grassOpts}</select>
        </label>
        ${NUM_FIELDS.filter((f) => f.key === 'grassDensity' || f.key === 'grassScale').map((f) => `
          <label>${f.label} <span data-readout="${f.key}">${Number(draft[f.key]).toFixed(2)}</span>
            <input type="range" min="${f.min}" max="${f.max}" step="${f.step}"
              value="${draft[f.key] as number}" data-num="${f.key}" />
          </label>`).join('')}
      </div>
      <div class="forge-section">
        <h3>light &amp; air</h3>
        <div class="forge-colors">
          <label title="fog"><span>fog</span>
            <input type="color" data-color="fog" value="${hexCss(draft.fog)}" />
          </label>
          <label title="sunTint"><span>sun</span>
            <input type="color" data-color="sunTint" value="${hexCss(draft.sunTint)}" />
          </label>
        </div>
        ${NUM_FIELDS.filter((f) => f.key === 'fogDensity' || f.key === 'ambient').map((f) => `
          <label>${f.label} <span data-readout="${f.key}">${Number(draft[f.key]).toFixed(2)}</span>
            <input type="range" min="${f.min}" max="${f.max}" step="${f.step}"
              value="${draft[f.key] as number}" data-num="${f.key}" />
          </label>`).join('')}
        <label>deform response
          <select data-response>${respOpts}</select>
        </label>
      </div>
      <div class="forge-section">
        <h3>scatter <button type="button" class="forge-mini" data-add-scatter>+ add</button></h3>
        <div class="forge-scatter-list">
          ${draft.scatter.map((e, i) => `
            <div class="forge-scatter-row" data-si="${i}">
              <select data-s-id>${ALL_SCATTER.map((id) =>
                `<option value="${id}" ${e.id === id ? 'selected' : ''}>${id}</option>`,
              ).join('')}</select>
              <label>dens<input type="number" data-s-dens min="0" max="20000" step="10" value="${e.perKm2}" /></label>
              <label>lo<input type="number" data-s-lo min="0.2" max="3" step="0.05" value="${e.scale[0]}" /></label>
              <label>hi<input type="number" data-s-hi min="0.2" max="3" step="0.05" value="${e.scale[1]}" /></label>
              <button type="button" class="forge-mini" data-s-del title="remove">×</button>
            </div>`).join('') || '<p class="forge-muted">no scatter entries</p>'}
        </div>
        <template id="scatter-blank">${scatterOpts}</template>
      </div>
      <div class="forge-section forge-actions">
        <button type="button" data-act="apply">apply</button>
        <button type="button" data-act="reset">reset biome</button>
        <button type="button" data-act="copy">copy JSON</button>
        <button type="button" data-act="game">open in game</button>
      </div>
      <p class="forge-muted">Live edits mutate the in-memory biome table and rebake
        the same maps the game reads. Copy JSON to paste into
        <code>src/terrain/biomes.ts</code> — the browser cannot write that file.</p>
    `
  }

  let debounce: number | null = null
  const scheduleApply = (): void => {
    if (debounce !== null) window.clearTimeout(debounce)
    debounce = window.setTimeout(() => {
      debounce = null
      applyLive()
    }, 80)
  }

  const switchBiome = (id: BiomeId): void => {
    // Keep the previous biome's draft committed before leaving.
    replaceBiomeStyle(biome, draft)
    biome = id
    draft = cloneBiomeStyle(BIOME_STYLES[biome])
    Object.assign(view, VIEWS[biome])
    terrain.setForced(biome)
    world.scatter.reloadChoices(atmosphere)
    placeCamera()
    applyGrade()
    renderPanel()
    syncHud()
    const url = new URL(location.href)
    url.searchParams.set('mode', 'env')
    url.searchParams.set('biome', biome)
    history.replaceState(null, '', url)
  }

  panel.addEventListener('input', (ev) => {
    const t = ev.target as HTMLElement
    if (!(t instanceof HTMLInputElement || t instanceof HTMLSelectElement)) return

    if (t.hasAttribute('data-tod')) {
      tod = Number(t.value)
      atmosphere.setTimeOfDay(tod)
      applyGrade()
      const r = panel.querySelector('[data-readout="tod"]')
      if (r) r.textContent = tod.toFixed(2)
      syncHud()
      return
    }
    if (t.hasAttribute('data-eye')) {
      view.eye = Number(t.value)
      placeCamera()
      const r = panel.querySelector('[data-readout="eye"]')
      if (r) r.textContent = view.eye.toFixed(1)
      syncHud()
      return
    }
    if (t.hasAttribute('data-color')) {
      const key = t.getAttribute('data-color') as (typeof COLOR_FIELDS)[number]
      const cur = draft[key] as number
      setStyleNumber(draft, key, parseHex(t.value, cur))
      scheduleApply()
      return
    }
    if (t.hasAttribute('data-num')) {
      const key = t.getAttribute('data-num') as typeof NUM_FIELDS[number]['key']
      setStyleNumber(draft, key, Number(t.value))
      const r = panel.querySelector(`[data-readout="${key}"]`)
      if (r) r.textContent = Number(t.value).toFixed(2)
      scheduleApply()
      return
    }
    if (t.hasAttribute('data-grass-id')) {
      draft.grassId = t.value
      scheduleApply()
      return
    }
    if (t.hasAttribute('data-response')) {
      draft.response = t.value as BiomeStyle['response']
      scheduleApply()
      return
    }

    const row = t.closest('[data-si]') as HTMLElement | null
    if (!row) return
    const i = Number(row.dataset.si)
    const entry = draft.scatter[i]
    if (!entry) return
    if (t.hasAttribute('data-s-id')) entry.id = t.value
    if (t.hasAttribute('data-s-dens')) entry.perKm2 = Number(t.value)
    if (t.hasAttribute('data-s-lo')) entry.scale[0] = Number(t.value)
    if (t.hasAttribute('data-s-hi')) entry.scale[1] = Number(t.value)
    scheduleApply()
  })

  panel.addEventListener('click', (ev) => {
    const t = (ev.target as HTMLElement).closest('button') as HTMLButtonElement | null
    if (!t) return
    if (t.dataset.biome) {
      switchBiome(t.dataset.biome as BiomeId)
      return
    }
    if (t.hasAttribute('data-add-scatter')) {
      const entry: ScatterEntry = {
        id: ALL_SCATTER[0] ?? 'rock-small',
        perKm2: 200,
        scale: [0.8, 1.2],
        maxSlope: 0.6,
      }
      draft.scatter.push(entry)
      applyLive()
      renderPanel()
      return
    }
    if (t.hasAttribute('data-s-del')) {
      const row = t.closest('[data-si]') as HTMLElement | null
      if (!row) return
      draft.scatter.splice(Number(row.dataset.si), 1)
      applyLive()
      renderPanel()
      return
    }
    switch (t.dataset.act) {
      case 'apply':
        applyLive()
        break
      case 'reset': {
        resetBiomeStyle(biome)
        draft = authoredBiomeStyle(biome)
        replaceBiomeStyle(biome, draft)
        applyLive()
        renderPanel()
        break
      }
      case 'copy': {
        // Export only into memory + a textarea. Prefer Ctrl/Cmd-C from the box.
        lastExport = biomeStyleToJson(draft)
        let box = panel.querySelector('#env-export') as HTMLTextAreaElement | null
        if (!box) {
          box = document.createElement('textarea')
          box.id = 'env-export'
          box.className = 'forge-export'
          box.spellcheck = false
          box.readOnly = true
          panel.querySelector('.forge-actions')?.after(box)
        }
        box.value = lastExport
        t.textContent = 'exported'
        window.setTimeout(() => { t.textContent = 'copy JSON' }, 1600)
        break
      }
      case 'game': {
        const u = new URL('/', location.origin)
        u.searchParams.set('biome', biome)
        u.searchParams.set('time', String(tod))
        u.searchParams.set('pos', `${view.x},0,${view.z}`)
        u.searchParams.set('eye', String(view.eye))
        u.searchParams.set('look', `${view.yaw},${view.pitch}`)
        u.searchParams.set('car', '0')
        window.open(u.toString(), '_blank')
        break
      }
    }
  })

  renderPanel()

  // ── orbit ─────────────────────────────────────────────────────────────────
  let dragging = false
  let lastX = 0
  let lastY = 0
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    dragging = true
    lastX = e.clientX
    lastY = e.clientY
    canvas.setPointerCapture(e.pointerId)
  })
  canvas.addEventListener('pointerup', () => { dragging = false })
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return
    const dx = e.clientX - lastX
    const dy = e.clientY - lastY
    lastX = e.clientX
    lastY = e.clientY
    view.yaw -= dx * 0.005
    view.pitch = Math.max(-1.2, Math.min(0.4, view.pitch - dy * 0.004))
    camera.rotation.y = view.yaw
    camera.rotation.x = view.pitch
  })
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault()
    view.eye = Math.max(1.5, Math.min(60, view.eye + Math.sign(e.deltaY) * 0.8))
    placeCamera()
    const eyeInput = panel.querySelector('[data-eye]') as HTMLInputElement | null
    const eyeRead = panel.querySelector('[data-readout="eye"]')
    if (eyeInput) eyeInput.value = String(view.eye)
    if (eyeRead) eyeRead.textContent = view.eye.toFixed(1)
    syncHud()
  }, { passive: false })

  addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
    const idx = '123456'.indexOf(e.key)
    if (idx >= 0 && BIOME_IDS[idx]) {
      switchBiome(BIOME_IDS[idx]!)
      return
    }
    if (e.key === 'r' || e.key === 'R') {
      resetBiomeStyle(biome)
      draft = authoredBiomeStyle(biome)
      replaceBiomeStyle(biome, draft)
      applyLive()
      renderPanel()
    }
  })

  if (q.get('shot') === '1') document.body.classList.add('shot')

  let readied = false
  const tick = (ms: number): void => {
    if (!readied) clock.tick(ms)
    else clock.tick(ms)
    wind.timeNode.value = clock.elapsed
    camera.updateMatrixWorld()
    atmosphere.updateLuts(renderer)
    const hidden = world.shadowExcluded
    for (const o of hidden) o.visible = false
    void atmosphere.shadow.render(
      renderer, scene, camera, atmosphere.state.sunDir, atmosphere.dome,
    ).finally(() => { for (const o of hidden) o.visible = true })
    atmosphere.updateSky(camera, clock.elapsed)
    // Keep streaming centred on the orbit point (not camera-forward wander).
    world.recentre(view.x, view.z)
    pipeline.render()
    if (!readied && clock.frame >= warmup) {
      readied = true
      resolveReady()
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)

  addEventListener('resize', () => {
    renderer.setSize(innerWidth, innerHeight)
    camera.aspect = innerWidth / innerHeight
    camera.updateProjectionMatrix()
  })
}

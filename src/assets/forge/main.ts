// Asset Forge viewport.
//
// ARCHITECTURE: "Separate Vite entry at /forge, sharing the game's renderer,
// sky, and material... Viewport running the game's ACTUAL atmosphere and post
// — WYSIWYG or the tool is useless."
//
// This is the viewport half. It exists because the scatter library cannot be
// judged from the game: placement belongs to the world team, so nothing here is
// in the scene yet, and "it compiles" is not the bar — CLAUDE.md is explicit
// that screenshots are the feedback signal and that done means compared against
// refs/. So the assets get their own page, lit by the same atmosphere, graded
// by the same post chain, and captured by the same Playwright harness.
//
//   ?ids=rock-slab,conifer-tall   subset, in order (default: everything)
//   ?variant=0                    which baked variant to show
//   ?lod=0|1|2|imp                which rung
//   ?collider=1                   draw the collision proxies instead
//   ?time=0.36                    time of day, same convention as the game
//   ?row=6                        assets per row
//   ?pitch=0.2&dist=1.0           camera elevation (rad) and distance multiplier
//   ?warmup=48                    frames before __ready resolves

import * as THREE from 'three/webgpu'
import { Atmosphere } from '../../atmosphere/sky'
import { PainterlyMaterial } from '../../material/painterly'
import { surface } from '../../material/defs'
import { graded } from '../../world/surfaceGrade'
import { buildPostChain } from '../../post/postChain'
import { Clock } from '../../core/clock'
import { ScatterLibrary } from '../library'
import { scatterBudget } from '../budget'
import { colliderGeometry } from '../collider'
import { scatterAsset, scatterIds, scatterVariants } from '../registry'

declare global {
  interface Window {
    __ready?: Promise<void>
    __forge?: { budget: ReturnType<typeof scatterBudget>; ids: string[]; scene: THREE.Scene }
  }
}

const q = new URLSearchParams(location.search)
const numParam = (k: string, d: number): number => {
  const v = Number(q.get(k))
  return q.has(k) && Number.isFinite(v) ? v : d
}

// FRAMING MODES, and they exist because the old contact sheets hid three
// separate defects at once. One LOD at a time, at forty metres, on a mottled
// meadow concealed a library that was 78% underground, a set of LOD1 rungs
// mirrored through y = 0, and leopard-print facets — simultaneously. A sheet you
// cannot see a defect in is not evidence.
//
//   focus   one asset at twice its own height, so form and ground contact read.
//   ladder  every rung of ONE asset in ONE frame, so a silhouette jump or an
//           origin shift is visible in a single image instead of across four.
//   grid    a 1 m line grid exactly at y = 0. Burial is only readable against a
//           known ground line; without it a half-sunk rock looks like a small
//           rock.
const focusId = q.get('focus')?.trim() ?? ''
const ladderId = q.get('ladder')?.trim() ?? ''
const ids = ladderId
  ? [ladderId, ladderId, ladderId, ladderId]
  : focusId
    ? [focusId]
    : (q.get('ids')?.split(',').map((s) => s.trim()).filter(Boolean)) ?? scatterIds()
const showGrid = q.get('grid') === '1' || Boolean(focusId) || Boolean(ladderId)
const variantSel = Math.max(0, Math.round(numParam('variant', 0)))
const lodSel = q.get('lod') ?? '0'
const showCollider = q.get('collider') === '1'
const perRow = Math.max(1, Math.round(numParam('row', 6)))
const warmup = Math.max(1, Math.round(numParam('warmup', 48)))

function fail(e: unknown): never {
  const el = document.getElementById('err') as HTMLDivElement
  el.style.display = 'grid'
  el.textContent = (e instanceof Error ? `${e.message}\n\n${e.stack ?? ''}` : String(e)) +
    '\n\nThis build is WebGPU-only (Chrome/Edge/Safari 26+).'
  throw e instanceof Error ? e : new Error(String(e))
}

let resolveReady!: () => void
window.__ready = new Promise<void>((r) => { resolveReady = r })

async function boot(): Promise<void> {
  if (!navigator.gpu) fail(new Error('navigator.gpu is unavailable.'))
  const canvas = document.getElementById('app') as HTMLCanvasElement
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true })
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  renderer.setSize(innerWidth, innerHeight)
  renderer.toneMapping = THREE.NoToneMapping
  await renderer.init()

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.1, 12_000)
  camera.rotation.order = 'YXZ'

  const atmosphere = new Atmosphere(numParam('time', 0.36))
  scene.add(atmosphere.dome)

  const lib = new ScatterLibrary(atmosphere)

  // Ground, on the game's own meadow surface, so an asset is judged against the
  // value it will actually sit on rather than against a void.
  const groundMat = new PainterlyMaterial(atmosphere, graded('meadow', surface('meadow')))
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000, 1, 1), groundMat.material)
  ground.rotation.x = -Math.PI * 0.5
  ground.name = 'forge-ground'
  scene.add(ground)

  // ── lay the library out on a grid ────────────────────────────────────────
  // Columns are sized to the assets IN them rather than to the biggest asset on
  // the sheet. A uniform cell driven by the boulder puts the pebble four pixels
  // across, which is a sheet you cannot judge a pebble from.
  const shown = ids.map((id) => ({
    id,
    variant: Math.min(variantSel, scatterVariants(id) - 1),
    asset: scatterAsset(id, Math.min(variantSel, scatterVariants(id) - 1)),
  }))
  const cols = Math.min(perRow, shown.length)
  const rows = Math.ceil(shown.length / cols)
  const GAP = 0.45
  const colW: number[] = new Array<number>(cols).fill(0.6)
  const rowD: number[] = new Array<number>(rows).fill(0.6)
  let maxTop = 0.6
  shown.forEach((s, i) => {
    const c = i % cols
    const r = Math.floor(i / cols)
    const span = s.asset.bounds.footprint * 2
    colW[c] = Math.max(colW[c]!, span)
    rowD[r] = Math.max(rowD[r]!, span)
    maxTop = Math.max(maxTop, s.asset.bounds.height)
  })
  const offsets = (sizes: readonly number[]): { at: number[]; total: number } => {
    let total = 0
    for (const v of sizes) total += v + GAP
    total -= GAP
    const at: number[] = []
    let run = -total * 0.5
    for (const v of sizes) { at.push(run + v * 0.5); run += v + GAP }
    return { at, total }
  }
  const colAt = offsets(colW)
  const rowAt = offsets(rowD)

  const wireMat = new THREE.MeshBasicNodeMaterial({ wireframe: true })
  wireMat.color = new THREE.Color(0xff3d6e)

  // THE GROUND LINE. A 1 m grid sitting exactly on y = 0: geometry below the
  // plane occludes nothing and the lines run straight through it, geometry above
  // it hides the lines behind it. That single cue is the difference between
  // "small rock" and "large rock, 78% buried", which is a defect that shipped.
  if (showGrid) {
    const half = Math.max(colAt.total, rowAt.total) * 0.5 + 2
    const step = Math.max(0.25, Math.min(2, maxTop * 0.25))
    const seg: number[] = []
    for (let v = -Math.ceil(half / step) * step; v <= half; v += step) {
      seg.push(-half, 0, v, half, 0, v, v, 0, -half, v, 0, half)
    }
    const gg = new THREE.BufferGeometry()
    gg.setAttribute('position', new THREE.Float32BufferAttribute(seg, 3))
    const gm = new THREE.LineBasicNodeMaterial()
    gm.color = new THREE.Color(0xff3d6e)
    const grid = new THREE.LineSegments(gg, gm)
    grid.name = 'forge-groundline'
    grid.frustumCulled = false
    scene.add(grid)
  }

  shown.forEach((s, i) => {
    const asset = s.asset
    const x = colAt.at[i % cols]!
    const z = rowAt.at[Math.floor(i / cols)]!

    if (showCollider) {
      const geo = colliderGeometry(asset.collider)
      if (geo) {
        const m = new THREE.Mesh(geo, wireMat)
        m.position.set(x, 0, z)
        m.name = `proxy-${asset.id}`
        m.frustumCulled = false
        scene.add(m)
      }
      return
    }

    // In ladder mode the CELL picks the rung, so all four sit in one frame.
    const cellLod = ladderId ? (i === 3 ? 'imp' : String(i)) : lodSel
    for (const part of asset.parts) {
      const entry = cellLod === 'imp'
        ? part.impostor
        : part.lods[Math.min(part.lods.length - 1, Math.max(0, Math.round(Number(cellLod) || 0)))]!
      const mesh = new THREE.Mesh(entry.geometry, lib.material(part.surface, part.material))
      mesh.position.set(x, 0, z)
      mesh.name = `${asset.id}#${asset.variant}/${part.slot}`
      mesh.frustumCulled = false
      scene.add(mesh)
    }
  })

  // Frame the sheet from the FOV rather than from a guessed multiple of its
  // size: the first version put a row of rocks 49 m away in a 42 degree lens
  // and every asset on the sheet was under twenty pixels tall.
  const vFov = (camera.fov * Math.PI) / 180
  const hFov = 2 * Math.atan(Math.tan(vFov * 0.5) * camera.aspect)
  const fitW = (colAt.total * 0.5) / Math.tan(hFov * 0.5)
  const fitH = (maxTop * 0.62) / Math.tan(vFov * 0.5)
  // A close-up is framed on the asset's own height, not on the sheet's width:
  // `fitW` over one cell puts a 0.2 m pebble at the same distance as a 26 m
  // cliff, which is how the pebble ended up four pixels across.
  const dist = focusId
    ? Math.max(1.2, maxTop * 2.2) * numParam('dist', 1)
    : (Math.max(fitW, fitH) * 1.12 + rowAt.total * 0.5) * numParam('dist', 1)
  const elev = numParam('pitch', 0.2)
  const aimY = maxTop * (focusId ? 0.4 : 0.45)
  camera.position.set(0, aimY + Math.tan(elev) * dist, dist)
  camera.rotation.set(-elev, 0, 0)

  const pipeline = buildPostChain(renderer, scene, camera, atmosphere)
  const clock = new Clock({ fixedDelta: 1 / 60 })

  const hud = document.getElementById('hud') as HTMLDivElement
  const budget = scatterBudget()
  // `scene` exposed so a probe can measure the REAL geometry — per-face normals
  // and areas — instead of inferring form from a screenshot. A flat-looking rock
  // is either a material bug or a form bug and pixels alone cannot tell you which.
  window.__forge = { budget, ids: shown.map((s) => s.id), scene }
  hud.textContent =
    `${budget.defs} defs / ${budget.assets} variants / ${budget.batches} batches` +
    `  worst-case draws ${budget.worstCaseDraws}\n` +
    `showing ${shown.length}  lod=${ladderId ? '0/1/2/imp' : lodSel}` +
    `${showCollider ? '  COLLIDERS' : ''}\n` +
    (budget.problems.length ? budget.problems.slice(0, 4).join('\n') : 'budget ok')
  if (q.get('shot') === '1') document.body.classList.add('shot')

  let readied = false
  const tick = (ms: number): void => {
    if (!readied) clock.tick(ms)
    camera.updateMatrixWorld()
    atmosphere.updateLuts(renderer)
    void atmosphere.shadow.render(
      renderer, scene, camera, atmosphere.state.sunDir, atmosphere.dome,
    )
    atmosphere.updateSky(camera, clock.elapsed)
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

boot().catch(fail)

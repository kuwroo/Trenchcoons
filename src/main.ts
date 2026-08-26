import * as THREE from 'three/webgpu'
import { Clock } from './core/clock'
import { RenderGraph, type FrameCtx } from './core/renderGraph'
import { Rng } from './core/rng'
import { readUrlState } from './debug/urlState'
import { PerfHud } from './debug/perfHud'

declare global {
  interface Window {
    /** Resolves only when everything for the current view is resident.
     *  The screenshot harness MUST await this or captures race the streaming
     *  system and diffs become noise. */
    __ready?: Promise<void>
    __trench?: { state: ReturnType<typeof readUrlState>; frame: () => number }
  }
}

function fail(e: unknown): never {
  const el = document.getElementById('err') as HTMLDivElement
  el.style.display = 'grid'
  el.textContent =
    'Trenchcoons failed to start\n\n' +
    (e instanceof Error ? `${e.message}\n\n${e.stack ?? ''}` : String(e)) +
    '\n\nThis build is WebGPU-only (Chrome/Edge/Safari 26+). No WebGL2 fallback.'
  throw e instanceof Error ? e : new Error(String(e))
}

const state = readUrlState()
const rng = new Rng(state.seed)

// The HUD must never appear in a capture — critics diff these PNGs against
// refs/, and overlay text would poison every comparison.
if (state.shot) document.body.classList.add('shot')

let resolveReady!: () => void
window.__ready = new Promise<void>((r) => { resolveReady = r })

const canvas = document.getElementById('app') as HTMLCanvasElement
const hud = new PerfHud()
const graph = new RenderGraph()
const clock = new Clock({ fixedDelta: state.shot ? 1 / 60 : null })

async function boot() {
  if (!navigator.gpu) fail(new Error('navigator.gpu is unavailable.'))

  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true })
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  renderer.setSize(innerWidth, innerHeight)
  await renderer.init()

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 0.1, 8000)
  camera.position.set(...state.pos)
  camera.rotation.order = 'YXZ'
  camera.rotation.y = state.look[0]
  camera.rotation.x = state.look[1]

  // ── M0 greybox ────────────────────────────────────────────────────────────
  // Deliberately unlit-neutral. M1 replaces this with the painterly material
  // and real atmosphere; until then these forms exist purely so the harness
  // has stable silhouettes to capture.
  scene.background = new THREE.Color(0x9fc4dc)

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(600, 600, 1, 1),
    new THREE.MeshBasicNodeMaterial({ color: 0x7f9a6a }),
  )
  ground.rotation.x = -Math.PI / 2
  scene.add(ground)

  const boxGeo = new THREE.BoxGeometry(1, 1, 1)
  const sphGeo = new THREE.SphereGeometry(0.5, 24, 16)
  const grey = new THREE.MeshBasicNodeMaterial({ color: 0xb8c2c8 })
  const forms = new THREE.Group()
  for (let i = 0; i < 24; i++) {
    const useBox = rng.float() > 0.5
    const m = new THREE.Mesh(useBox ? boxGeo : sphGeo, grey)
    const h = rng.range(1, 6)
    m.scale.set(rng.range(1, 4), h, rng.range(1, 4))
    m.position.set(rng.range(-90, 90), h / 2, rng.range(-90, 90))
    m.rotation.y = rng.range(0, Math.PI * 2)
    forms.add(m)
  }
  scene.add(forms)

  graph.register('opaque', () => { renderer.render(scene, camera) })

  addEventListener('resize', () => {
    renderer.setSize(innerWidth, innerHeight)
    camera.aspect = innerWidth / innerHeight
    camera.updateProjectionMatrix()
  })

  window.__trench = { state, frame: () => clock.frame }

  // ── Frame loop ────────────────────────────────────────────────────────────
  let readied = false
  let lastMs = performance.now()

  const tick = async (rafMs: number) => {
    const nowMs = performance.now()
    clock.tick(rafMs)
    const ctx: FrameCtx = { dt: clock.delta, elapsed: clock.elapsed, frame: clock.frame }

    renderer.info.reset()
    await graph.run(ctx)

    const dtMs = Math.max(0, nowMs - lastMs)
    lastMs = nowMs
    hud.update(dtMs, {
      drawCalls: renderer.info.render.drawCalls,
      triangles: renderer.info.render.triangles,
    }, nowMs)

    // Ready only after warmup frames, so pipelines are compiled and any
    // streaming has settled before the harness captures.
    if (!readied && clock.frame >= state.warmup) {
      readied = true
      resolveReady()
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

boot().catch(fail)

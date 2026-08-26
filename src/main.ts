import * as THREE from 'three/webgpu'
import { Clock } from './core/clock'
import { RenderGraph, type FrameCtx } from './core/renderGraph'
import { Rng } from './core/rng'
import { readUrlState } from './debug/urlState'
import { PerfHud } from './debug/perfHud'
import { Atmosphere } from './atmosphere/sky'
import { buildPostChain } from './post/postChain'
import { buildGreybox } from './world/greybox'

declare global {
  interface Window {
    /** Resolves only when everything for the current view is resident.
     *  The screenshot harness MUST await this or captures race the streaming
     *  system and diffs become noise. */
    __ready?: Promise<void>
    __trench?: {
      state: ReturnType<typeof readUrlState>
      frame: () => number
      /** Live TOD scrub, for iterating without a reload. */
      setTime: (tod: number) => void
    }
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
  // The tonemap lives in the post chain (gentle filmic, highlight desaturation
  // OFF). The renderer must not apply a second one on top.
  renderer.toneMapping = THREE.NoToneMapping
  await renderer.init()

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 0.1, 12_000)
  camera.position.set(...state.pos)
  camera.rotation.order = 'YXZ'
  camera.rotation.y = state.look[0]
  camera.rotation.x = state.look[1]

  // ── M1: atmosphere first, everything else lit by it ───────────────────────
  const atmosphere = new Atmosphere(state.time)
  scene.add(atmosphere.dome)

  const world = buildGreybox(atmosphere, rng)
  scene.add(world.group)

  // `pos` from the URL is a floor, not an absolute: the greybox heightfield is
  // procedural, so a fixed y in a shot URL would sometimes land inside a hill
  // and the capture would be a screenful of backface.
  camera.position.y = Math.max(
    state.pos[1], world.heightAt(camera.position.x, camera.position.z) + 9,
  )

  const pipeline = buildPostChain(renderer, scene, camera, atmosphere)

  // ── render graph ──────────────────────────────────────────────────────────
  // 1  atmosphere LUTs: transmittance folded into the analytic model, sky-view
  //    and irradiance rebuilt only when TOD changes.
  graph.register('atmosphereLUT', () => { atmosphere.updateLuts(renderer) })

  // 6  shadow cascades: four texel-snapped ortho slabs from the sun, packed
  //    into one atlas. This is the only pass that renders geometry outside the
  //    post chain's scene pass, and it has to, because it needs its own cameras
  //    and an override material.
  graph.register('shadow', async () => {
    await atmosphere.shadow.render(
      renderer, scene, camera, atmosphere.state.sunDir, atmosphere.dome,
    )
  })

  // 9  sky: the dome is part of the scene, so the draw itself happens inside
  //    the scene pass owned by 12. This pass only advances its state.
  graph.register('sky', (ctx) => { atmosphere.updateSky(camera, ctx.elapsed) })

  // 12 post. `pass(scene, camera)` inside the chain executes the opaque + sky
  //    draws (graph steps 7-9) as its first stage, so there is still exactly
  //    one place in the codebase that issues render calls.
  graph.register('post', () => { pipeline.render() })

  addEventListener('resize', () => {
    renderer.setSize(innerWidth, innerHeight)
    camera.aspect = innerWidth / innerHeight
    camera.updateProjectionMatrix()
  })

  window.__trench = {
    state,
    frame: () => clock.frame,
    setTime: (tod: number) => atmosphere.setTimeOfDay(((tod % 1) + 1) % 1),
  }

  // ── Frame loop ────────────────────────────────────────────────────────────
  let readied = false
  let lastMs = performance.now()

  const tick = async (rafMs: number) => {
    const nowMs = performance.now()
    // In shot mode the clock FREEZES the moment `__ready` resolves. The harness
    // screenshots an unknown number of frames after that, and a clock that kept
    // running kept drifting the cloud field by a sub-pixel per frame — enough
    // for a +/-1 LSB difference on ~0.2% of channels between two runs, which is
    // exactly what M0's byte-identical contract forbids. Rendering continues;
    // only time stops, so every frame from `__ready` onward is identical.
    if (!(state.shot && readied)) clock.tick(rafMs)
    const ctx: FrameCtx = { dt: clock.delta, elapsed: clock.elapsed, frame: clock.frame }

    // The camera is not in the scene graph, so nothing else will do this — and
    // the sky dome needs its world position.
    camera.updateMatrixWorld()

    renderer.info.reset()
    await graph.run(ctx)

    const dtMs = Math.max(0, nowMs - lastMs)
    lastMs = nowMs
    const s = atmosphere.state
    hud.lines['tod'] = `${s.tod.toFixed(3)}  sun ${(Math.asin(s.sunDir.y) * 57.2958).toFixed(1)}deg`
    hud.lines['haze'] = `${(s.hazeDensity * 1000).toFixed(2)}/km  exp ${s.exposure.toFixed(2)}`
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

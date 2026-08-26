import * as THREE from 'three/webgpu'
import { Clock } from './core/clock'
import { RenderGraph, type FrameCtx } from './core/renderGraph'
import { Rng } from './core/rng'
import { readUrlState } from './debug/urlState'
import { PerfHud } from './debug/perfHud'
import { Atmosphere } from './atmosphere/sky'
import { buildPostChain } from './post/postChain'
import { buildGreybox } from './world/greybox'
import { Vehicle, type VehicleTelemetry } from './vehicle/vehicle'
import { Kart } from './vehicle/kart'
import { ChaseCamera } from './vehicle/camera'
import { KeyboardInput, mountControlHint, type InputSource } from './vehicle/input'
import { ScriptedInput, readVehicleOptions } from './vehicle/replay'
import { ContactShadow, NO_CAST_LAYER } from './vehicle/contactShadow'

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
      /** Camera pose, for diagnosing framing without a screenshot. */
      cam?: () => { x: number; y: number; z: number; fov: number }
      /** The DRAWN ground height, for offline spot-finding by the harness. */
      heightAt?: (x: number, z: number) => number
      /** Scatter footprints, so the harness can find a spawn that is not
       *  inside a 13 m bush. */
      obstacles?: () => { x: number; z: number; r: number }[]
      /** Vehicle telemetry. The shot harness reads this to find crests and
       *  landings instead of guessing frame numbers. */
      car?: () => (VehicleTelemetry & {
        x: number; y: number; z: number; yaw: number
        wheels: { compression: number; contact: boolean; slip: number }[]
      }) | null
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

  // ── M3: the couch co-op vehicle ───────────────────────────────────────────
  // Opt-in under `?shot=1` (the fifteen M1 gate shots are ratcheted against a
  // best-ever ledger and must stay the same pictures), opt-out everywhere else.
  const carOpts = readVehicleOptions()
  let car: {
    vehicle: Vehicle
    kart: Kart
    chase: ChaseCamera
    input: InputSource
    shadow: ContactShadow
  } | null = null

  if (carOpts.enabled) {
    const vehicle = new Vehicle(world.groundAt)
    const kart = new Kart(atmosphere)
    vehicle.object.add(kart.root)
    scene.add(vehicle.object)
    const shadow = new ContactShadow(world.groundAt)
    scene.add(shadow.mesh)
    // The contact shadow must not be a shadow CASTER, or it draws a second,
    // offset copy of itself up-sun. It lives on a layer the sun cascades'
    // cameras do not have enabled; this is the one place that opts back in.
    camera.layers.enable(NO_CAST_LAYER)

    // A spawn is a request, not an instruction. `pos=280,14,760` — the perf
    // harness's ground-noon scene — asks for a point 84 m down inside the
    // lagoon bowl, and unvalidated it put the whole rig underwater and still
    // reported 60 fps. `spawnPoint` answers with the nearest dry, gentle,
    // unobstructed point, deterministically.
    const asked = carOpts.spawn ?? [state.pos[0], state.pos[2]]
    const [sx, sz] = world.spawnPoint(asked[0] as number, asked[1] as number)
    if (Math.hypot(sx - (asked[0] as number), sz - (asked[1] as number)) > 0.5) {
      console.warn(
        `[trench] spawn ${asked[0]},${asked[1]} is underwater, too steep or ` +
        `inside a scattered form; moved to ${sx.toFixed(1)},${sz.toFixed(1)}`,
      )
    }
    // `look`'s yaw doubles as the spawn heading: in car mode the chase camera
    // owns the camera, so nothing else is using it.
    vehicle.spawn(sx, sz, carOpts.yaw ?? state.look[0])
    shadow.update(vehicle)
    const chase = new ChaseCamera(camera, world.groundAt, carOpts.framing)
    chase.reset(vehicle)
    const input: InputSource = carOpts.script
      ? new ScriptedInput(carOpts.script)
      : new KeyboardInput()
    if (!carOpts.script) mountControlHint()
    car = { vehicle, kart, chase, input, shadow }
  }

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
    cam: () => ({
      x: camera.position.x, y: camera.position.y, z: camera.position.z, fov: camera.fov,
    }),
    heightAt: world.groundAt,
    obstacles: () => world.obstacles,
    car: () => {
      if (!car) return null
      const p = car.vehicle.object.position
      return {
        ...car.vehicle.telemetry,
        x: p.x, y: p.y, z: p.z, yaw: car.vehicle.yaw,
        wheels: car.vehicle.wheels.map((w) => ({
          compression: w.compression, contact: w.contact, slip: w.slip,
        })),
      }
    },
  }

  // ── Frame loop ────────────────────────────────────────────────────────────
  // `?frame=N` counts from the first frame of the drive script, i.e. from the
  // end of the warmup — see the offset in the tick below.
  const readyFrame = state.warmup + (carOpts.frame ?? 0)
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
    const frozen = state.shot && readied
    if (!frozen) clock.tick(rafMs)
    // A frozen clock reports dt 0, and every spring in core/spring.ts treats
    // dt <= 0 as a hard no-op. That is what keeps the vehicle — which is a
    // stack of springs — byte-identical across the unknown number of frames the
    // harness renders after `__ready`.
    const dt = frozen ? 0 : clock.delta
    const ctx: FrameCtx = { dt, elapsed: clock.elapsed, frame: clock.frame }

    // Simulation, before the graph: the shadow cascades and the scene pass both
    // need this frame's chassis pose, and none of it issues a render call.
    if (car) {
      // The scripted timeline starts when the WARMUP ends, not at frame 0.
      // Warmup exists to compile pipelines and settle streaming, and it is 64
      // frames — over a second of driving. Without this offset every capture
      // earlier than frame 64 is unreachable, which is most of a launch.
      car.vehicle.update(dt, car.input.sample(clock.frame - state.warmup))
      car.kart.update(dt, clock.elapsed, car.vehicle)
      // After the kart, before the camera: the shadow reads the same pose the
      // wheels were just placed at, and the shadow patch is scene geometry the
      // camera's terrain solve does not care about.
      if (dt > 0) car.shadow.update(car.vehicle)
      car.chase.update(dt, car.vehicle)
    }

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
    if (car) {
      const t = car.vehicle.telemetry
      hud.lines['car'] = `${t.speed.toFixed(1)}m/s  slip ${t.slipRatio.toFixed(2)}` +
        `  ${t.airborne ? 'AIR' : `${t.contacts}/4`}  idle ${t.idle.toFixed(2)}`
      hud.lines['pose'] = `pitch ${(t.pitch * 57.3).toFixed(1)}  roll ${(t.roll * 57.3).toFixed(1)}` +
        `  squash ${t.squash.toFixed(3)}  f${clock.frame}`
    }
    hud.update(dtMs, {
      drawCalls: renderer.info.render.drawCalls,
      triangles: renderer.info.render.triangles,
    }, nowMs)

    // Ready only after warmup frames, so pipelines are compiled and any
    // streaming has settled before the harness captures. `?frame=N` moves that
    // point, which is how a scripted drive is captured at an exact moment: the
    // clock freezes the instant `__ready` resolves, so frame N is a pose.
    if (!readied && clock.frame >= readyFrame) {
      readied = true
      resolveReady()
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

boot().catch(fail)

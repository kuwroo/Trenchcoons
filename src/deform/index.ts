// M4 — the deformation field, wired up.
//
// `field.ts` owns the storage and the shader; `mirror.ts` owns the CPU copy;
// this is the only file that knows there is a car. It reads the vehicle's
// per-wheel contact and slip telemetry, turns it into stamps, drives the two
// render-graph passes, and hands the physics back the two things the field
// makes it feel: a ground surface with your own ruts in it, and the drag of
// driving through them.
//
// Nothing here is imported by the material, and nothing in `src/vehicle/` is
// imported except types — the coupling is one height-field wrapper and one
// force application, both through the vehicle's public surface.

import * as THREE from 'three/webgpu'
import type { DeformHook } from '../material/painterly'
import type { HeightField, Vehicle } from '../vehicle/vehicle'
import { DeformField, DEPTH_SCALE, type WheelStamp } from './field'
import { DeformMirror, wheelDrag } from './mirror'
import { BIOMES, biome, weatherDecay, type DeformResponse } from './biome'

/** Half-width of a kart tyre's contact patch, metres. */
const TYRE_HALF = 0.115

/** A rectangular surface with a response of its own. See `world.pan`. */
export interface DeformPatch {
  x: number
  z: number
  halfX: number
  halfZ: number
}

export interface DeformOptions {
  enabled: boolean
  /** `?biome=` — ARCHITECTURE's URL codec: "force a biome under the player,
   *  bypassing climate classification". */
  biome: string | null
  /** `?weather=` — drives the global decay multiplier. */
  weather: string
  /** Shot mode. Makes the readback deterministic; see `DeformMirror`. */
  deterministic: boolean
}

/**
 * Read the deformation field's URL surface.
 *
 * OPT-IN under `?shot=1`, opt-out everywhere else — the same contract
 * `readVehicleOptions` uses and for the same reason, spelled out in
 * `src/vehicle/replay.ts`: the twenty existing captures are ratcheted against a
 * best-ever ledger by `tools/regress.mjs`, and a system that puts new geometry
 * and new albedo into a frame would silently rewrite all twenty baselines. The
 * four `tracks-*` captures ask for it explicitly and are gated exactly as hard
 * as everything else — `npm run gate` reads every PNG in `shots/`.
 */
export function readDeformOptions(search = location.search): DeformOptions {
  const q = new URLSearchParams(search)
  const shot = q.has('shot')
  const raw = q.get('deform')
  const off = raw === '0' || raw === 'false'
  const asked = raw !== null && !off
  return {
    enabled: off ? false : shot ? asked : true,
    biome: q.get('biome'),
    weather: q.get('weather') ?? 'clear',
    deterministic: shot,
  }
}

const _v = new THREE.Vector3()
const _fwd = new THREE.Vector3()

/** Per-wheel contact history, so a stamp is a segment rather than a dot. */
interface WheelTrace {
  x: number
  z: number
  seeded: boolean
}

export class Deformation {
  readonly field: DeformField
  readonly mirror: DeformMirror
  /** The response of the surface the player is on, and of everything else. */
  private patchResponse: DeformResponse
  private readonly worldResponse: DeformResponse = BIOMES['grass'] as DeformResponse
  private patch: DeformPatch | null = null
  private readonly traces: WheelTrace[] = []
  private readonly stamps: WheelStamp[] = []
  private centreX = 0
  private centreZ = 0

  constructor(private readonly options: DeformOptions) {
    this.field = new DeformField({ weather: weatherDecay(options.weather) })
    this.mirror = new DeformMirror(this.field.near.rt)
    // `?biome=` names the surface UNDER THE PLAYER. Without a patch to stand on
    // it is the whole world's response; with one it is the patch's.
    this.patchResponse = options.biome
      ? biome(options.biome)
      : BIOMES['wetSand'] as DeformResponse
    this.field.setResponse(this.patchResponse, this.worldResponse, null)
  }

  /** The terrain material's read hook. */
  get hook(): DeformHook { return this.field }

  /**
   * Tell the field where the surface with the non-default response is.
   *
   * Until M2's climate fields land there is no `classify()` to ask, so the
   * greybox's sand pan is the one place in the world with a response of its
   * own. `DeformField.responseAt` blends the two by this footprint; when M2
   * arrives it becomes a biome-weight sample and nothing else changes.
   */
  setPatch(patch: DeformPatch | null): void {
    this.patch = patch
    this.field.setResponse(this.patchResponse, this.worldResponse, patch)
  }

  /** CPU-side twin of `DeformField.patchMask`. Physics and shading must agree. */
  private responseAt(x: number, z: number): DeformResponse {
    const p = this.patch
    if (!p) return this.patchResponse
    const inside = Math.abs(x - p.x) <= p.halfX && Math.abs(z - p.z) <= p.halfZ
    return inside ? this.patchResponse : this.worldResponse
  }

  /**
   * Ground height with the field's displacement folded in — consumer (3), the
   * geometric half.
   *
   * Passed to `new Vehicle(...)` in place of the raw terrain, so the suspension,
   * the plane fit and therefore the body roll all see the ruts. It is also
   * self-limiting: a wheel that drops into its own rut compresses LESS, which
   * lowers `load`, which lowers the depth of the next stamp. The feedback
   * cannot run away.
   */
  heightField(base: HeightField): HeightField {
    return (x: number, z: number): number => base(x, z) + this.mirror.displacement(x, z)
  }

  /**
   * Build this frame's stamps from the vehicle's telemetry.
   *
   * Intensity is `slipRatio * normalLoad`, per ARCHITECTURE, with two additions
   * the telemetry makes available and the spec's summary implies:
   *
   *  - WHEELSPIN (`wheel.slip`) counts as slip, so a standing start digs in.
   *  - SCRUB — the angle between where the wheel is pointing and where the
   *    contact patch is actually travelling — counts too, and it also WIDENS
   *    the mark. That is the term that makes cornering read differently from
   *    braking rather than merely harder: a locked wheel cuts a deep narrow
   *    line, a scrubbing one smears a broad one.
   */
  sampleVehicle(vehicle: Vehicle, dt: number): void {
    this.stamps.length = 0
    const p = vehicle.object.position
    this.centreX = p.x
    this.centreZ = p.z
    if (!(dt > 0)) return
    vehicle.object.updateMatrix()
    const t = vehicle.telemetry
    const speed = t.speed
    for (let i = 0; i < vehicle.wheels.length; i++) {
      const w = vehicle.wheels[i]!
      const trace = this.traces[i] ?? (this.traces[i] = { x: 0, z: 0, seeded: false })
      _v.copy(w.anchor).applyMatrix4(vehicle.object.matrix)
      const bx = _v.x
      const bz = _v.z
      if (!trace.seeded) { trace.x = bx; trace.z = bz; trace.seeded = true }
      const ax = trace.x
      const az = trace.z
      trace.x = bx
      trace.z = bz
      if (!w.contact) continue

      // Where this wheel is POINTING, versus where its patch is going.
      const steer = w.front ? w.steerAngle : 0
      const cs = Math.cos(steer)
      const sn = Math.sin(steer)
      _fwd.set(
        vehicle.forward.x * cs + vehicle.right.x * sn, 0,
        vehicle.forward.z * cs + vehicle.right.z * sn,
      )
      const dx = bx - ax
      const dz = bz - az
      const len = Math.hypot(dx, dz)
      const scrub = len > 1e-4
        ? 1 - Math.abs((_fwd.x * dx + _fwd.z * dz) / len)
        : 0

      const slip = Math.min(1,
        Math.abs(t.slipRatio) * 2.0 + w.slip * 0.7 + scrub * 1.6)
      const load = w.load
      const r = this.responseAt(bx, bz)
      // A parked car still presses the ground, but only once — the stamp is
      // MAX-blended, so holding still cannot bore a hole.
      const moving = 0.28 + 0.72 * Math.min(1, speed / 1.4)
      const depthM = r.maxDepth * Math.min(1, load * (0.22 + 1.5 * slip)) * moving
      this.stamps.push({
        ax, az, bx, bz,
        halfWidth: TYRE_HALF * (1 + 0.95 * slip),
        depth: Math.min(1, depthM / DEPTH_SCALE),
        mask: Math.min(1, load * (0.62 + 0.8 * slip) * moving),
        wet: r.wet * (0.55 + 0.45 * slip),
      })
    }
  }

  /** Track the field on a camera instead — used when there is no vehicle. */
  setCentre(x: number, z: number): void { this.centreX = x; this.centreZ = z }

  /** Render-graph pass 3. */
  async stampPass(renderer: THREE.Renderer): Promise<void> {
    await this.field.update(renderer, this.centreX, this.centreZ, this.stamps)
  }

  /** Render-graph pass 4, plus the readback that feeds the CPU mirror. */
  async decayPass(renderer: THREE.Renderer, dt: number): Promise<void> {
    await this.field.decay(renderer, dt)
    await this.mirror.update(
      renderer, this.centreX, this.centreZ, this.options.deterministic,
    )
  }

  /**
   * Consumer (3), the handling half: rolling resistance and rut tracking.
   *
   * Applied to `Vehicle.velocity` between updates rather than inside the
   * vehicle, because `src/vehicle/` is not this milestone's to edit — and it
   * turns out to be the right seam anyway. `update()` reads the velocity at the
   * top of the step and recomposes it at the bottom, so an external impulse
   * here is indistinguishable from one the model applied itself.
   */
  applyToVehicle(vehicle: Vehicle, dt: number): void {
    if (!(dt > 0)) return
    let drag = 0
    let latDamp = 0
    let n = 0
    for (const w of vehicle.wheels) {
      if (!w.contact) continue
      _v.copy(w.anchor).applyMatrix4(vehicle.object.matrix)
      const s = this.mirror.sample(_v.x, _v.z)
      const d = wheelDrag(s, this.responseAt(_v.x, _v.z))
      drag += d.drag
      latDamp += d.latDamp
      n++
    }
    if (n === 0) return
    drag /= n
    latDamp /= n
    if (drag <= 0 && latDamp <= 0) return

    const v = vehicle.velocity
    let vLong = v.dot(vehicle.forward)
    let vLat = v.dot(vehicle.right)
    // Rolling resistance, never through zero: a rut slows you down, it does not
    // reverse you out of itself.
    const dv = drag * dt
    vLong -= Math.sign(vLong) * Math.min(Math.abs(vLong), dv)
    // Rut tracking. Damping the LATERAL component is what "the rut holds you"
    // means mechanically, and it is the same knob that makes a slick snow rut
    // (grip < 1, so latDamp 0) feel nothing like a wet-sand one.
    vLat *= Math.max(0, 1 - latDamp * dt)
    v.copy(vehicle.forward).multiplyScalar(vLong)
      .addScaledVector(vehicle.right, vLat)
  }

  dispose(): void { this.field.dispose() }
}

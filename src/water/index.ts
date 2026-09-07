// The water system, wired up. The only file here that knows there is a car.
//
// Same shape and the same seams as src/deform/index.ts, deliberately: a height
// field wrapper, a stamp builder, and one force application through the
// vehicle's public surface. `src/vehicle/` is not edited.
//
// TWO RACCOONS IN A TRENCHCOAT CAN DRIVE ON THE SEA. That is a design decision,
// not a physics one — the box is a cardboard box, it floats, and the brief is
// "make the raccoons able to drive on the water". Mechanically it is the
// cheapest possible thing that is also the honest one: the vehicle's height
// field becomes `max(terrain, water surface)`, so every system that already
// reads ground height — suspension, the plane fit that drives body roll, the
// contact test, the chase camera — sees the swell and reacts to it with no
// further coupling. Then the surface gets a HANDLING CHARACTER through the same
// external-impulse seam the deformation field uses: heavy longitudinal drag,
// and lateral grip cut hard, so the sea is fast in a straight line and slithers
// in a corner.

import * as THREE from 'three/webgpu'
import type { Atmosphere } from '../atmosphere/sky'
import type { HeightField, Vehicle } from '../vehicle/vehicle'
import type { TerrainWorld } from '../terrain/world'
import type { Obstacle } from '../world/scatter'
import { Water, type WaterOptions } from './water'
import { RING_STRIDE, STAMP_BUDGET, WAKE_SPAN, type FoamStamp } from './wake'

export { Water } from './water'
export { WakeField, WAKE_SPAN, FOAM_LIFE } from './wake'

/** Half-width of the churn a wheel throws up, metres. Wider than a tyre. */
// THE WHEELS BARELY SPRAY, because in the reference they do not spray at all.
// `refs/water/shore-foam-wake.jpg` shows a wake that is PURELY a chain of rings
// with open water between them — no continuous line down the middle. At 0.32 the
// two wheel tracks laid a solid pair of ribbons along the whole trail, which
// closed every ring interior: measured, the wake's `fill` was 0.97 against the
// reference's 0.562 while `hull` looked correct, because the corridor between
// rings was full. Kept small rather than zero so the contact patch still reads
// at the car itself, which is the one place the reference cannot advise on.
const WHEEL_FOAM = 0.14
/**
 * Radius of a hull ring pulse, metres, before the speed term.
 *
 * HALVED, AND THE STROKE AND PITCH CAME WITH IT. Measured by `tools/water.mjs`'s
 * own code, the drawn stroke was 0.97% of frame width against the reference
 * chain's 0.47%, and the ring pitch 12.8% against 6.3% — the whole wake was
 * drawn at twice the reference's scale, which no amount of froth or lace fixes
 * because it is not a texture problem. Halving the radius and the stride lands
 * both at once and doubles the number of ring interiors, which is where the
 * enclosed pockets come from (reference 121, ours 8 before this).
 *
 * DELIBERATELY SMALL IN ABSOLUTE TERMS. At 1.6 m with a speed term reaching
 * 2.2x, the rings came out 7 m across behind a 1.4 m box — five times the width
 * of the thing making them, which reads as crop circles rather than as a wake.
 * `refs/water/shore-foam-wake.jpg`'s rings are one to two times the width of the
 * object that left them, so this is 1.0 m with the speed term capped at 1.5x.
 */
const RING_RADIUS = 1.15
/** Radius of the froth collar around the hull, metres. Just outside the box. */
const HULL_COLLAR = 1.05
/**
 * How far outside a solid's own radius its foam collar sits, metres.
 *
 * A MULTIPLIER ON THE SOLID'S OWN RADIUS, not metres added to it. Additive was
 * wrong on small forms and visibly so: at +1.15 m a 0.4 m pebble got a ring
 * whose inner edge sat 0.85 m clear of it — four pebble-radii out — which reads
 * as a detached hoop hovering round the object like a cartoon "ping" rather than
 * as foam breaking on it. The reference's white HUGS the silhouette at every
 * size, which is what a proportion gives and a constant cannot.
 */
const OBSTACLE_COLLAR = 1.3
/** Most collars to stamp in one frame. The nearest ones win. */
// Bob ripples. `RIPPLE_LIFE` is kept at the contact channel's own decay so a
// ring is gone from the field at about the moment it stops being stamped.
const RIPPLE_MAX = 4
/** Ripples are a floating feature; above this the wake takes over. */
const RIPPLE_MAX_SPEED = 6
const RIPPLE_LIFE = 1.05
const RIPPLE_R0 = 0.95
const RIPPLE_R1 = 4.8

const OBSTACLE_MAX = 22
/** Metres per second below which a wheel stops throwing foam. */
const FOAM_MIN_SPEED = 1.2

/**
 * How far below the visual water surface the suspension "ground" sits, metres.
 *
 * The vehicle is not edited; sinking is done by returning a lower height from
 * `heightField` so every system that already follows ground (suspension, belly
 * clamp, camera) drops with it. Authored so ~10% of the cardboard box is under
 * the waterline:
 *
 *   chassisY ≈ h + rest(0.34) + wheelR(0.4) - sag(≈0.11) = h + 0.63
 *   box bottom ≈ chassisY + (BOX_Y 0.4 − BOX.h/2 0.53) = chassisY − 0.13
 *   want waterline at boxBottom + 0.10·1.06 → h = surface − 0.61
 *
 * Wheels (diameter 0.8 m) sit almost fully submerged; the box reads as floating.
 */
const WATER_SINK = 0.61

/**
 * Longitudinal drag on water, m/s per second at full speed.
 *
 * Applied through `Vehicle.velocity` between updates, exactly as
 * `Deformation.applyToVehicle` does and for the reason documented there:
 * `update()` reads the velocity at the top of the step and recomposes it at the
 * bottom, so an external impulse here is indistinguishable from one the model
 * applied itself.
 */
const WATER_DRAG = 3.4
/** Fraction of lateral velocity NOT scrubbed off per second. >1 = slides. */
const WATER_SLIDE = 1.9

/** Deterministic 0..1 hash of a small integer. Wang-style, no allocation. */
function hash01(i: number): number {
  let x = (i | 0) * 0x9e3779b1
  x ^= x >>> 15
  x = (x * 0x85ebca6b) | 0
  x ^= x >>> 13
  return ((x >>> 0) % 100003) / 100003
}

const _v = new THREE.Vector3()
const _fwd = new THREE.Vector3()

export interface WaterSystemOptions extends WaterOptions {
  /** `?water=0` turns the sheet off entirely. Diagnostic. */
  enabled?: boolean
}

/** Read the water system's URL surface. */
export function readWaterOptions(search = location.search): WaterSystemOptions {
  const q = new URLSearchParams(search)
  const raw = q.get('water')
  return {
    enabled: !(raw === '0' || raw === 'false'),
    def: q.get('waterdef') ?? undefined,
  }
}

interface WheelTrace {
  x: number
  z: number
  seeded: boolean
}

export class WaterSystem {
  readonly water: Water
  private readonly stamps: FoamStamp[] = []
  private readonly traces: WheelTrace[] = []
  /** Metres travelled since the last ring pulse. */
  /**
   * Birth times of the live bob ripples, in `elapsed` seconds.
   *
   * A stamp cannot grow after it is issued — the field stores a value, not a
   * shape — so an expanding ring has to be RE-STAMPED each frame at a radius
   * derived from its age. This holds the ages; the radius is computed at stamp
   * time. Bounded, and the oldest is dropped rather than the array growing.
   */
  private ripples: number[] = []
  /** `elapsed` at which the next ripple is due. */
  private nextRipple = 0
  /** Seconds, advanced by `sampleVehicle`; the ripples' own timebase. */
  private rippleClock = 0
  private ringDebt = 0
  /** Pulse counter, for the deterministic per-ring jitter. */
  private ringIndex = 0
  private ringSeeded = false
  private ringX = 0
  private ringZ = 0

  constructor(
    atmosphere: Atmosphere,
    private readonly terrain: TerrainWorld,
    options: WaterSystemOptions = {},
  ) {
    this.water = new Water(atmosphere, terrain, options)
    this.installDebug()
  }

  /**
   * Diagnostic surface, on `window.__trenchWater`.
   *
   * Lives here rather than in main.ts for the reason src/deform/index.ts gives
   * for its own: the module owns its debugging. It also earns its place
   * immediately — the first build of this system drew NOTHING, and an A/B
   * against `?water=0` measured a mean absolute difference of 0.00 per channel
   * over the whole frame, which proves the sheet is absent without saying why.
   * `parented` and `visible` separate "never added to the scene" from "added
   * and hidden", which is the distinction that cost the most time to make.
   */
  private installDebug(): void {
    const w = window as unknown as { __trenchWater?: unknown }
    w.__trenchWater = {
      state: () => ({
        level: this.water.level,
        parented: this.water.mesh.parent?.name ?? null,
        visible: this.water.mesh.visible,
        material: this.water.material.name,
        triangles: (this.water.mesh.geometry.index?.count ?? 0) / 3,
        pos: this.water.mesh.position.toArray(),
        stamps: this.stamps.length,
      }),
      /**
       * Why is (or is not) scatter placed here — the predicate `Scatter` applies,
       * reported term by term.
       *
       * Added because "no rock is ever placed in the water" survived three
       * plausible fixes (`wade` semantics, density, slope limit) and each was
       * verified live in the built bundle while the frames did not move. The
       * predicate has four terms and guessing which one rejects is how a session
       * disappears.
       */
      placement: (x: number, z: number) => {
        const h = this.terrain.heightAt(x, z)
        const c = this.terrain.climateAt(x, z)
        return {
          height: +h.toFixed(2),
          depth: +(this.water.level - h).toFixed(2),
          roughSlope: +this.terrain.roughSlopeAt(x, z, 1.5).toFixed(3),
          dominant: c.dominant,
          coast: +(c.weights[5] ?? 0).toFixed(3),
        }
      },
      /** Water depth in metres at a world XZ, negative on land. */
      depthAt: (x: number, z: number) =>
        this.water.level - this.terrain.heightAt(x, z),
      stamps: () => this.stamps,
      /** ASCII map of the wake field around the car. See `WakeField.debugScan`. */
      scan: async (cx?: number, cz?: number, window?: number) =>
        this.lastRenderer
          ? this.water.wake.debugScan(
            this.lastRenderer, cx ?? this.ringX, cz ?? this.ringZ, window,
          )
          : null,
    }
  }

  get mesh(): THREE.Mesh { return this.water.mesh }

  /** True where the terrain is below the still water line. */
  isWater(x: number, z: number): boolean {
    return this.terrain.heightAt(x, z) < this.water.level
  }

  /**
   * The vehicle's height field, with the water surface in it.
   *
   * Composes with the deformation field's wrapper rather than replacing it —
   * `max` of the two is right in both directions: over land the terrain (ruts
   * and all) is above the sea and wins, over water the (sunk) sheet is above
   * the seabed and wins. The sheet is returned `WATER_SINK` below the drawn
   * surface so the box floats with ~10% underwater and the wheels submerge;
   * near shore the rising seabed takes over naturally as soon as it clears
   * that sunk line.
   */
  heightField(base: HeightField): HeightField {
    return (x: number, z: number): number =>
      Math.max(base(x, z), this.water.surfaceAt(x, z) - WATER_SINK)
  }

  /**
   * Build this frame's foam stamps.
   *
   * Two shapes, because the reference is two things at once (see the header of
   * wake.ts): a capsule per wheel along the path it covered this frame, and a
   * ring pulsed every `RING_STRIDE` metres behind the hull. The ring is what
   * makes the trail read as the chain of expanding circles in
   * `refs/water/shore-foam-wake.jpg` rather than as a painted stripe.
   */
  sampleVehicle(vehicle: Vehicle, dt: number): void {
    this.stamps.length = 0
    if (!(dt > 0)) return
    vehicle.object.updateMatrix()
    const t = vehicle.telemetry
    const speed = t.speed
    this.rippleClock += dt

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
      if (!w.contact || !this.isWater(bx, bz)) continue

      // Scrub, the same term the deformation field uses: a wheel pointing
      // somewhere other than where its patch is travelling throws a much
      // broader sheet of water.
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

      // Foam is a function of how hard the wheel is working the water, and
      // unlike a tyre mark it needs SPEED — a wheel resting on the sea does not
      // churn it. Floored at zero rather than clamped up, so a car idling on
      // the water leaves nothing and the surface stays clean.
      const work = Math.min(1, Math.max(0, (speed - FOAM_MIN_SPEED) / 7))
      // MODEST, and deliberately below the ring pulses' amplitude. The churn
      // and the wheel spray are the froth AT the car; the rings are the wake.
      // Because the material's lace threshold rises as a mark ages, a mark
      // stamped at 0.5 dissolves in about a third of the time one stamped at
      // 1.0 does — which is how "broad froth near the hull, chain of rings
      // behind it" is expressed with one field and no extra channels.
      // WEAKER STILL. At 0.45 the two wheel lines survived long enough to run
      // the length of the trail and read as railway track threaded through the
      // rings — "film sprockets" was the note. They are spray at the wheels, so
      // they have to die within about half a second at speed.
      // SCRUB WEIGHS HEAVILY. A wheel sliding sideways throws a sheet of water
      // where a rolling one throws a ribbon, and the metric agrees: in a turn the
      // ring chain follows an arc and leaves a large enclosed void on its inside
      // (holeMax 7.8% of frame width against the reference's 3.4%), which is
      // exactly where the spray from a scrubbing wheel goes.
      const amount = Math.min(1, work * (0.30 + 0.55 * scrub + 0.25 * w.slip))
      if (amount <= 0.02) continue
      this.stamps.push({
        ax, az, bx, bz,
        radius: WHEEL_FOAM * (1 + 1.1 * scrub),
        band: 0.10,
        amount,
        ring: 0,
        contact: 0,
      })
    }

    // ── the hull churn, and the ring pulses ──────────────────────────────────
    const p = vehicle.object.position
    // Behind the hull, where a hull actually pushes water aside.
    const rx = p.x - vehicle.forward.x * 1.25
    const rz = p.z - vehicle.forward.z * 1.25
    if (!this.ringSeeded) { this.ringX = rx; this.ringZ = rz; this.ringSeeded = true }

    // THERE IS NO CONTINUOUS HULL CAPSULE, and its removal is the fix for "the
    // wake is a painted stripe" that four rounds of width and lace tuning could
    // not reach.
    //
    // A capsule stamped every frame along the path is, by construction, an
    // unbroken line in the water — and `tools/water.mjs` measures exactly that:
    // the longest unbroken run of foam along a scanline was 0.63 of the box
    // against 0.366 in `refs/water/shore-foam-wake.jpg`'s ring chain, even after
    // the capsule had been narrowed to 0.32 m and the rings given clear
    // interiors. Narrowing a continuous line makes it a thinner continuous
    // line. The reference's wake has no centre line in it at all: it is
    // overlapping rings and nothing else, with a collar of froth at the object.
    //
    // So the trail is now rings plus the collar below, and the per-wheel
    // capsules survive only as SPRAY — stamped at about half the rings'
    // amplitude, so the material's age-driven lace threshold dissolves them
    // within a couple of seconds and they read as churn at the wheels rather
    // than as a stripe to the horizon.

    // Distance travelled since the last pulse. THIS IS NOT BOOKKEEPING: deleting
    // the churn block above took these three lines with it, `ringDebt` stayed at
    // zero forever, and not one ring pulse was emitted for the rest of the
    // session — which presented as `wakeShare 0.000` and sent two rounds of
    // debugging into the ring's own geometry. `__trenchWater.scan` is what
    // caught it: the field's PEAK was 0.443, exactly the wheel spray's authored
    // amount, so nothing stamped at 1.0 had ever been written.
    this.ringDebt += Math.hypot(rx - this.ringX, rz - this.ringZ)
    this.ringX = rx
    this.ringZ = rz

    // A COLLAR OF FROTH AROUND THE HULL ITSELF, re-stamped every frame.
    //
    // Without it the car has clean untouched water against its sides and reads
    // as hovering: measured on the first build, the box just to starboard of the
    // hull scored 0.000 foam and the water between the wheels was 6% darker than
    // the water beside it, which is nothing. Both references show a body in
    // water ringed by foam — it is the rock's collar in `shore-foam-wake.jpg`
    // and the outline round every rock in `lake-cartoon-cells.jpg`, and the same
    // annulus does the job here.
    // FADED OUT BY SPEED, and that is not a taste call — a collar re-stamped
    // every frame is swept along the path into a continuous 2.1 m band of foam,
    // and that band was what filled the ring pulses in and put the trail back to
    // a slab. Measured from a lifted camera: the ring chain was invisible and
    // the trail read as one white stroke with a few holes in it.
    //
    // Which leaves the right behaviour anyway. A hull standing in water is
    // ringed by froth (`lake-cartoon-cells.jpg`'s rocks, and the rock in
    // `shore-foam-wake.jpg`); a hull at speed puts that displacement into its
    // WAKE instead, which is what the ring pulses are. So the collar is a
    // low-speed feature and the rings are the fast one, and they hand over at
    // about 8 m/s.

    // NO BOW WAVE, AND THE REASON IS STRUCTURAL RATHER THAN AESTHETIC.
    //
    // A moving hull should push a pair of diverging lines from its bow, and a
    // review is right that without them the car reads as pasted onto the surface.
    // It was implemented and reverted, with the numbers: two capsules from the
    // bow at an amplitude high enough to survive the material's lace threshold
    // (0.78, since the threshold at a fresh mark reaches 0.55 * wakeLace = 0.715)
    // swept into a slab within a second — `wakeShare` 0.15 -> 0.44, stroke 0.0064
    // -> 0.0167 against the reference's 0.0047, `laceRuns` 4.4 -> 2.5. Exactly the
    // failure the continuous hull capsule was deleted for.
    //
    // The conflict is not tunable: this field has ONE decay rate, so a mark is
    // either strong enough to be visible and therefore long-lived, or short-lived
    // and therefore invisible. Contact froth needs a SECOND CHANNEL with a fast
    // decay — G and B in the wake target are unused — and that is a change to
    // `WakeField`, not a constant. Until then the hull collar below carries it,
    // at a floor rather than fading to nothing.

    // Distance travelled since the last pulse. THIS IS NOT BOOKKEEPING: deleting
    // the churn block above took these three lines with it, `ringDebt` stayed at
    // zero forever, and not one ring pulse was emitted for the rest of the
    // session — which presented as `wakeShare 0.000` and sent two rounds of
    // debugging into the ring's own geometry. `__trenchWater.scan` is what
    // caught it: the field's PEAK was 0.443, exactly the wheel spray's authored
    // amount, so nothing stamped at 1.0 had ever been written.
    this.ringDebt += Math.hypot(rx - this.ringX, rz - this.ringZ)
    this.ringX = rx
    this.ringZ = rz

    // A COLLAR OF FROTH AROUND THE HULL ITSELF, re-stamped every frame.
    //
    // Without it the car has clean untouched water against its sides and reads
    // as hovering: measured on the first build, the box just to starboard of the
    // hull scored 0.000 foam and the water between the wheels was 6% darker than
    // the water beside it, which is nothing. Both references show a body in
    // water ringed by foam — it is the rock's collar in `shore-foam-wake.jpg`
    // and the outline round every rock in `lake-cartoon-cells.jpg`, and the same
    // annulus does the job here.
    // FADED OUT BY SPEED, and that is not a taste call — a collar re-stamped
    // every frame is swept along the path into a continuous 2.1 m band of foam,
    // and that band was what filled the ring pulses in and put the trail back to
    // a slab. Measured from a lifted camera: the ring chain was invisible and
    // the trail read as one white stroke with a few holes in it.
    //
    // Which leaves the right behaviour anyway. A hull standing in water is
    // ringed by froth (`lake-cartoon-cells.jpg`'s rocks, and the rock in
    // `shore-foam-wake.jpg`); a hull at speed puts that displacement into its
    // WAKE instead, which is what the ring pulses are. So the collar is a
    // low-speed feature and the rings are the fast one, and they hand over at
    // about 8 m/s.
    // NO FLOOR UNDER THIS AT SPEED. A floor of 0.28 was tried here and removed:
    // the material's lace threshold at a fresh mark reaches `0.55 * wakeLace` =
    // 0.715, so a mark at 0.25 is dissolved before it is drawn, and a stamp that
    // provably cannot be seen is worse than none.
    //
    // "Forward of the hull and to either side of it the water measures 0.000
    // foam, so the box reads as pasted onto the surface" is answered now, and by
    // the second channel that note called for rather than by a constant — see
    // CONTACT_LIFE in wake.ts and the bow froth below.
    const collar = 1 - Math.min(1, speed / 8)
    if (collar > 0.02 && this.isWater(p.x, p.z)) {
      this.stamps.push({
        ax: p.x, az: p.z, bx: p.x, bz: p.z,
        radius: HULL_COLLAR,
        band: 0.10,
        amount: 0.9 * collar,
        ring: 1,
        contact: 0,
      })
    }

    // ── CONTACT FROTH: the water breaking against the hull ───────────────────
    //
    // Writes the CONTACT channel (G) only — `amount: 0` — so it lives about 1.1 s
    // instead of six. That is the whole reason this can exist at all: the bow
    // wave tried before this was issued continuously into the six-second wake
    // channel and swept into a slab within a second (`wakeShare` 0.15 -> 0.44,
    // stroke 0.0064 -> 0.0167 against the reference's 0.0047). At 1.1 s a
    // continuous stamp cannot reach far enough behind the car to become one.
    //
    // Three marks: one across the bow, where a hull throws water and where the
    // frame previously measured 0.000 foam, and one down each flank. The bow
    // mark runs AHEAD of the hull by a distance that grows with speed.
    //
    // `fill` SETS THE LEVEL, and it is a hard structural cap rather than a knob.
    // `fill` is foam over foam-plus-enclosed-holes, so ANY foam added anywhere
    // that does not itself enclose new water raises it:
    //
    //   froth 0.62 -> fill 0.745 ok      0.66 -> laceRuns 2.50 FAIL (floor 2.6)
    //   froth 0.78 -> fill 0.843 FAIL    0.88 bow-only -> fill 0.911 FAIL
    //
    // Bow-only placement was tried on the theory that the flanks sit inside the
    // wake's envelope and the bow does not; it is worse, because the envelope is
    // derived from the foam's own extent and grows to include whatever is added.
    // Position is not the free variable. 0.62 is the most the measure allows, and
    // it buys foam in a 30-70 px ring round the hull of 3.1% against 1.8% before
    // — real, and subtler than the reference would suggest if it had a craft in
    // frame to compare against. It does not, which is why this level is a
    // judgement and not a match.
    if (this.isWater(p.x, p.z)) {
      const fx = vehicle.forward.x, fz = vehicle.forward.z
      const rxc = vehicle.right.x, rzc = vehicle.right.z
      const lead = 1.15 + 0.30 + 0.040 * speed
      // Capped well under 1: a saturated contact mark cannot be laced by any
      // threshold, because every sample of it sits above the step.
      const froth = Math.min(0.62, 0.30 + speed / 58)
      const half = 0.82
      this.stamps.push({
        ax: p.x + fx * lead - rxc * half, az: p.z + fz * lead - rzc * half,
        bx: p.x + fx * lead + rxc * half, bz: p.z + fz * lead + rzc * half,
        radius: 0.34, band: 0.10, amount: 0, ring: 0, contact: froth,
      })
      for (const sgn of [-1, 1]) {
        this.stamps.push({
          ax: p.x + fx * 1.05 + rxc * sgn * 0.86,
          az: p.z + fz * 1.05 + rzc * sgn * 0.86,
          bx: p.x - fx * 1.05 + rxc * sgn * 0.86,
          bz: p.z - fz * 1.05 + rzc * sgn * 0.86,
          radius: 0.30, band: 0.10, amount: 0, ring: 0,
          contact: froth * 0.85,
        })
      }
    }

    // ── BOB RIPPLES: rings spreading out from a floating box ─────────────────
    //
    // A HULL SITTING IN WATER PUSHES RINGS OUT AS IT RISES AND FALLS, and this
    // is the one water feature that has to work when the car is doing nothing.
    // ART_BIBLE's motion rule — "a parked car must still be visibly alive" —
    // applies to the water around it, not just the suspension.
    //
    // RE-STAMPED EVERY FRAME AT A RADIUS FROM ITS AGE, because a stamp cannot
    // grow: `WakeField` stores an amount per texel, not a shape, so an expanding
    // ring is a fresh ring each frame rather than one ring that widens. The
    // array holds birth times and the radius is derived here.
    //
    // ON THE CONTACT CHANNEL, so they live about a second and cannot pile into a
    // slab — the failure that killed two earlier attempts at continuous marks
    // (see CONTACT_LIFE in wake.ts). It also means their own decay does the
    // fading, so the amplitude only has to fall enough to read as spreading.
    // BELOW A WALKING PACE ONLY. At speed the bow wave and the ring chain are
    // what the water does, and concentric rings centred on a moving hull are
    // neither physical nor visible under them. Confining the ripples here also
    // keeps them out of the wake frames, so they cannot push `fill`.
    if (speed < RIPPLE_MAX_SPEED && this.isWater(p.x, p.z)) {
      // The bob drives the RATE and the strength. `vy` is the hull's vertical
      // speed, so a box riding a swell emits faster and harder than a still one,
      // and a still one still emits.
      const bob = Math.min(1, Math.abs(t.vy) / 1.1)
      // SHORT ENOUGH THAT SEVERAL RINGS ARE ALIVE AT ONCE. `RIPPLE_LIFE` is
      // 1.05 s, so a 0.78 s period leaves barely more than one ring on the
      // water and the effect reads as a single hoop rather than as a spreading
      // set. Measured on `water-bob`, the radial foam profile at 0.78 s had one
      // ring (45-75 px at 3.3-4.0%) and nothing beyond it.
      const period = 0.62 - 0.22 * bob
      if (this.rippleClock >= this.nextRipple) {
        this.nextRipple = this.rippleClock + period
        this.ripples.push(this.rippleClock)
        if (this.ripples.length > RIPPLE_MAX) this.ripples.shift()
      }
      for (let i = this.ripples.length - 1; i >= 0; i--) {
        const age = this.rippleClock - this.ripples[i]!
        if (age > RIPPLE_LIFE) { this.ripples.splice(i, 1); continue }
        const k = age / RIPPLE_LIFE
        // Spreads fast at first and slows, the way a real ring does as it loses
        // energy; `sqrt` is close enough and costs nothing.
        const radius = RIPPLE_R0 + (RIPPLE_R1 - RIPPLE_R0) * Math.sqrt(k)
        // Fades from the outset so the outermost ring is always the faintest.
        // WELL ABOVE THE MATERIAL'S STEP, and this is the whole reason the first
        // version was invisible. Contact foam is `smoothstep(0.26, 0.60, contact
        // * (lace * 0.75 + 0.25))`, so an amplitude of 0.36 lands the product in
        // 0.09..0.36 and almost all of it falls under the step's foot. Measured
        // by A/B: with the ripples switched off entirely the radial foam profile
        // around a floating box was identical to three decimals (3.29% against
        // 3.31% in the one annulus that differed at all) — the ring visible there
        // is the decaying wake from the drive-out, not the ripples.
        //
        // Third time in this file that a mark has been authored under the
        // threshold it has to cross: see the 0.28 hull-collar floor and the
        // contact froth's first lace range.
        //
        // AND THEN NOT SO FAR ABOVE IT THAT THE RINGS MERGE. At 0.92 every ring
        // cleared the step over its whole circumference, and with the decay pass
        // dilating each one by a texture or two the set filled into a solid white
        // disc around the hull — visible, and not rings. The window is narrow
        // because it is bounded below by the step and above by the merge.
        // NO FADE WITH AGE, and removing it is what finally made the outer rings
        // exist. Fading the stamp by `(1 - k)` fought the material's step from
        // the wrong end: the older, larger rings — exactly the ones that carry
        // the spreading read — dropped under it and vanished, so the profile
        // showed the hull froth and nothing beyond the wake. The CONTACT CHANNEL
        // ALREADY FADES THEM: it decays over `CONTACT_LIFE`, so a ring dims on
        // its own without ever being authored below the threshold.
        const amp = 0.78 + 0.20 * bob
        if (amp <= 0.03) continue
        this.stamps.push({
          ax: p.x, az: p.z, bx: p.x, bz: p.z,
          radius,
          // Thin: a ripple is a line on the surface, not a band of froth.
          band: 0.10,
          amount: 0, ring: 1, contact: amp,
        })
      }
    }

    // THE STRIDE IS JITTERED PER PULSE. At a fixed stride the chain is a row of
    // evenly spaced circles laid down at a metronome's tempo: measured, the
    // coefficient of variation of ring spacing was 0.197 against 1.112 in
    // `refs/water/shore-foam-wake.jpg`, whose rings bunch and gap. A CV that low
    // is the single most mechanical thing about the trail and no amount of foam
    // fixes it.
    const stride = RING_STRIDE * (0.45 + 1.15 * hash01(this.ringIndex * 2 + 77))
    if (this.ringDebt >= stride && speed > FOAM_MIN_SPEED && this.isWater(rx, rz)) {
      this.ringDebt = 0
      // Faster = bigger ring, because the hull is displacing more water. The
      // radius is set ONCE at emission and never revisited: the field is
      // MAX-blended, so re-stamping a growing circle would fill it in solid.
      // The trail's small-near-large-far reading comes from the pulses behind
      // you having been emitted at higher speed, plus the dilation in the decay
      // pass widening the older ones.
      const grow = 1 + Math.min(0.35, speed / 60)
      // PER-PULSE JITTER, seeded off the pulse index rather than
      // `Math.random()` — CLAUDE.md: "No Math.random() in generation. Seeded RNG
      // only; determinism is what makes the screenshot harness meaningful", and
      // a wake that differed between two captures would break the byte-identical
      // contract the whole shot ledger rests on.
      //
      // Without it the trail is a row of identical evenly-spaced circles and
      // reads as a spring or a slinky. The reference's rings vary in size and
      // wander off the centre line, because the water they are made in is not
      // uniform.
      const n = this.ringIndex++
      const h1 = hash01(n * 2 + 1)
      const h2 = hash01(n * 2 + 2)
      const side = 0.5 * (h2 - 0.5) * 2
      const px2 = rx + vehicle.right.x * side
      const pz2 = rz + vehicle.right.z * side
      this.stamps.push({
        ax: px2, az: pz2, bx: px2, bz: pz2,
        // A WIDE SPREAD OF RADII WAS TRIED HERE and is reverted; see the note in
        // CLAUDE.md. `0.30 + 2.1 * h^2.2` skews most pulses SMALL rather than
        // clustering them mid-range as intended, so the mean radius fell,
        // `wakeShare` halved to 0.064 and `laceRuns` failed at 2.05.
        radius: RING_RADIUS * grow * (0.62 + 0.85 * h1),
        band: 0.10,
        contact: 0,
        amount: Math.min(1, 0.72 + speed / 40) * (0.86 + 0.14 * h2),
        ring: 1,
      })

      // ── THE INNER-ARC PULSE ──────────────────────────────────────────────
      //
      // A second, smaller ring offset toward the INSIDE of the turn, and it
      // exists because of a measured failure rather than a guess: cornering, the
      // ring chain follows an arc and encloses the middle of the turn circle, so
      // `tools/water.mjs` read the largest enclosed foam hole at 7.8% of frame
      // width against a 5.5% ceiling — a single 139 x 217 px void inside the
      // curve. A straight-line reference cannot calibrate that shape, and the
      // honest answer was a feature rather than a threshold.
      //
      // Physically it is the inner wheel's wash: on a slide the inside of the arc
      // is being dragged through, and the offset is proportional to yaw rate
      // because that is what sets how tight the arc is. The wheel spray cannot
      // reach it — it follows each wheel's own path, and the void is inside the
      // innermost of them, which is why raising the scrub term moved the number
      // by 0.03 points.
      //
      // `-sign(yawRate) * right` is the inside: `forward` is
      // `(-sin yaw, -cos yaw)`, so `d(forward)/d(yaw)` is `-right` and an
      // increasing yaw turns the car toward `-right`.
      const yr = t.yawRate
      if (Math.abs(yr) > 0.35) {
        // 3.4 / 1.9, and BOTH ways of changing it were tried and reverted when a
        // taller swell grew the turn's inner void past its ceiling: enlarging the
        // pulse took `holeMax` 0.0558 -> 0.0578 (a bigger ring draws its own arc
        // rather than filling the existing one) and offsetting it further inward
        // took it to 0.0603 (it leaves a gap between the chain and the pulse,
        // which becomes its own enclosed hole). The void is not reachable from
        // this pulse at that swell.
        const inward = Math.min(3.4, 1.9 * Math.abs(yr)) * -Math.sign(yr)
        const ix = px2 + vehicle.right.x * inward
        const iz = pz2 + vehicle.right.z * inward
        if (this.isWater(ix, iz)) {
          this.stamps.push({
            ax: ix, az: iz, bx: ix, bz: iz,
            // NOT ENLARGED. Growing this to (0.58 + 0.62 h) was tried to close
            // the turn's inner void at a taller swell and made it WORSE —
            // `holeMax` 0.0558 -> 0.0578 — because a larger inner ring adds its
            // own arc rather than filling the one already there.
            radius: RING_RADIUS * grow * (0.45 + 0.5 * h2),
            band: 0.10,
            contact: 0,
            amount: Math.min(1, 0.5 + speed / 55) * (0.8 + 0.2 * h1),
            ring: 1,
          })
        }
      }
    }
  }

  /** No car: the wake field still has to decay, and the sheet still recentres. */
  clearStamps(): void { this.stamps.length = 0 }

  /**
   * A WHITE FOAM COLLAR AROUND EVERY SOLID THAT STANDS IN THE WATER.
   *
   * The single most characteristic mark in `refs/water/lake-cartoon-cells.jpg` —
   * every one of its seven rocks is drawn with a thick white outline, and
   * `refs/water/shore-foam-wake.jpg` puts the same closed annulus round its one
   * rock. The build had neither, for two independent reasons: nothing was ever
   * placed below the waterline (fixed by `ScatterEntry.wade`), and the material
   * had exactly two foam sources, the shore band and the wake.
   *
   * Written into the wake field rather than computed in the shader, and that is
   * the cheap half of the design: the shader would need the obstacle set as a
   * uniform array and a loop per fragment, where the field already has a
   * ring-stamp primitive, a toroidal window that covers exactly the near field a
   * collar is visible in, and a decay pass that keeps it honest. Re-stamped
   * every frame because the field decays; a static solid re-stamped in place
   * does not sweep, so unlike the hull collar it costs nothing in shape.
   *
   * @param obstacles `world.obstacles` — near solid forms, already streamed to
   *   the camera and mutated in place, so this is a read of a live array.
   */
  stampObstacles(obstacles: readonly Obstacle[], cx: number, cz: number): void {
    if (this.stamps.length >= STAMP_BUDGET) return
    // Nearest first, and only those inside the field's own window: a collar
    // further away than the toroidal span would alias onto a texel that means
    // somewhere else.
    const reach = Math.min(WAKE_SPAN * 0.45, 110)
    let taken = 0
    for (const o of obstacles) {
      if (taken >= OBSTACLE_MAX || this.stamps.length >= STAMP_BUDGET) break
      const dx = o.x - cx
      const dz = o.z - cz
      if (dx * dx + dz * dz > reach * reach) continue
      if (!this.isWater(o.x, o.z)) continue
      this.stamps.push({
        ax: o.x, az: o.z, bx: o.x, bz: o.z,
        contact: 0,
        radius: o.r * OBSTACLE_COLLAR,
        // A WASH, not a hairline — see `band` on FoamStamp. This is the mark
        // refs/README.md calls the lake's signature.
        band: 0.30,
        amount: 1,
        ring: 1,
      })
      taken++
    }
  }

  private lastRenderer: THREE.Renderer | null = null

  /** Render-graph step 10. */
  async pass(
    renderer: THREE.Renderer, camera: THREE.Camera, dt: number,
  ): Promise<void> {
    this.lastRenderer = renderer
    await this.water.update(renderer, camera, dt, this.stamps)
  }

  /**
   * Handling character. Drag and a lateral grip cut, applied outside
   * `Vehicle.update` through the same seam the deformation field uses.
   */
  applyToVehicle(vehicle: Vehicle, dt: number): void {
    if (!(dt > 0)) return
    let onWater = 0
    let n = 0
    for (const w of vehicle.wheels) {
      if (!w.contact) continue
      _v.copy(w.anchor).applyMatrix4(vehicle.object.matrix)
      n++
      if (this.isWater(_v.x, _v.z)) onWater++
    }
    if (n === 0 || onWater === 0) return
    const frac = onWater / n

    const v = vehicle.velocity
    let vLong = v.dot(vehicle.forward)
    let vLat = v.dot(vehicle.right)
    // Drag rises with speed, as drag does. Never through zero: water slows you
    // down, it does not push you backwards.
    const dv = WATER_DRAG * frac * Math.min(1, Math.abs(vLong) / 8) * dt
    vLong -= Math.sign(vLong) * Math.min(Math.abs(vLong), dv)
    // Lateral grip GIVEN BACK. The tyre model already scrubbed sideways
    // velocity off this step; this restores a fraction of it, which is the only
    // way to express "less grip" from outside the model. Capped for the reason
    // `Deformation.applyToVehicle` caps its slick side: it can only ever hand
    // back what was taken, and an uncapped multiplier here would let a
    // low-framerate step build a slide out of nothing.
    vLat *= 1 + Math.min(WATER_SLIDE - 1, 2) * frac * dt
    v.copy(vehicle.forward).multiplyScalar(vLong)
      .addScaledVector(vehicle.right, vLat)
  }

  dispose(): void { this.water.dispose() }
}

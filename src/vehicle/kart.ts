// The kart: a cardboard box with two raccoons in it.
//
// Everything here is procedural motion over a PROCEDURAL RIG. There is still no
// imported skeleton and nothing is keyframed (MILESTONES M3: "there are no
// rigged assets, so nothing here is keyframed") — but "not keyframed" is not the
// same as "not rigged", and the previous pass conflated the two. The occupants
// are now twelve joints an animal, solved parent-before-child, and every
// quantity that moves one goes through a spring in core/spring.ts.
//
// WHAT THE RIG BOUGHT, in order of how much it shows:
//
//   PAWS THAT HOLD THINGS. The driver's paws are IK'd onto the steering wheel's
//   rim and the passenger's onto the box rim — both authored in KART space, not
//   in the animal's — so they stay put while the shoulder leans into a corner
//   and the spine breathes underneath. That is the single mark the reference
//   sheet has that nothing here had: in three of its four views a paw is hooked
//   over something.
//   A TAIL WITH A CHAIN IN IT. Five segments, each following its parent through
//   its own spring, so a flick at the root arrives at the tip four lags later
//   and the whole thing whips instead of swinging as a board.
//   EARS THAT FLICK. An ear can only rotate about its own base if something
//   above it holds the base, which the hand-composed transform could not do.
//   THE HOVER. Airborne, the whole seat joint rises out of the box and the
//   chain above it splays — one value, `hover`, moving one joint, and the
//   twelve below it come along.
//
// The idle layer is the point of M3, not decoration: "a parked, untouched car
// must never be a still image". It is cross-faded by the vehicle's own `idle`
// telemetry rather than switched, and it never fades to zero — a moving car
// still breathes and its occupants still lean.

import * as THREE from 'three/webgpu'
import type { Atmosphere } from '../atmosphere/sky'
import type { WindField } from '../atmosphere/wind'
import { PainterlyMaterial } from '../material/painterly'
import { surface } from '../material/defs'
import { graded } from '../world/surfaceGrade'
import { AngleSpring, Spring, clamp, saturate, smoothstep, sway } from '../core/spring'
import type { Vehicle } from './vehicle'
import { PosedInstances, hubCapGeometry, roundedBox, wheelGeometry } from './geometry'
import { EXHAUST, boxInkGeometry, boxShellGeometry, boxTapeGeometry, exhaustGeometry, flapGeometry } from './box'
import {
  RACCOON, Rig, alertGeometry, bibGeometry, blazeGeometry, bodyGeometry, buildRaccoonJoints,
  earGeometry, grinGeometry, helmGeometry, limbGeometry, maskGeometry,
  muzzleGeometry, noseGeometry, pawGeometry, skullGeometry, sphere, tailGeometry,
  tailProfile,
} from './raccoon'
import type { Joint, RaccoonJoints } from './raccoon'

/**
 * Kart dimensions, chassis space. y = 0 is the suspension anchor plane, so the
 * ground sits at -(rest + wheelRadius) = -0.74 and every number below can be
 * read as "height above the axle line".
 */
const BOX = { w: 1.72, h: 1.06, d: 2.68, r: 0.2 }
const BOX_Y = 0.4
const RIM_Y = BOX_Y + BOX.h * 0.5
/** Inside face of the box floor — where a raccoon's weight rests. */
const FLOOR_Y = BOX_Y - BOX.h * 0.5 + 0.075
/**
 * The flaps.
 *
 * `rest` IS THE FIX FOR A BUG THAT LOOKED LIKE A CHARACTER PROBLEM, so it is
 * worth the paragraph. The hinge angle is measured off VERTICAL, and at 1.0 rad
 * a 0.66 m flap hinged at 0.90 m puts its tip at 0.90 + 0.66*cos(1.0) = 1.26 m,
 * leaning outward toward the camera — which is exactly the height of the
 * occupants' heads. Every eye-level capture of the crew was therefore a
 * photograph of four flaps with two pairs of ears behind them, and three rounds
 * were spent adjusting the raccoons' heights against an occluder. Past pi/2 the
 * flap falls BELOW its own hinge and the crew is clear; 1.62 rad is just past
 * flat, drooping slightly, which is also the pose all four views of the
 * reference sheet draw.
 *
 * `front` is separate and larger: the reference's 3/4 view has the front flap
 * folded right down against the front wall, and it is the one flap directly
 * between the chase camera and two faces.
 */
const FLAP = { len: 0.58, thick: 0.07, rest: 2.05, side: 3.02 }

/**
 * The steering wheel, in kart space.
 *
 * Sits ahead of the driver and is RAKED BACK 0.5 rad, because a wheel mounted
 * dead vertical in front of a seated animal is a bus and the reference draws it
 * tipped toward the driver's chest. `x` is the driver's side, set from `SEAT.x`
 * so the two cannot drift apart.
 *
 * THE RADIUS AND THE HEIGHT ARE BOTH SOLVED, between the muzzle above and the
 * box rim below, and both walls have been hit:
 *
 *   radius 0.30, y 1.04   the wheel is as wide as the skull and parked across
 *                         the driver's face. The animal is behind its own
 *                         steering wheel in the literal sense.
 *   radius 0.21, y 0.90   the rim's nine and three o'clock land at y 0.82,
 *                         which is 0.11 m BELOW the box rim — so both of the
 *                         driver's paws were inside the box, behind the front
 *                         wall, invisible in every frame. The wheel was there
 *                         and nobody was holding it.
 *   radius 0.20, y 0.97   the rim's top is 1.17, just under the muzzle's
 *                         underside at 1.19, and the grip points at +/-0.75 rad
 *                         off the top sit at 1.10 — 0.17 m clear of the rim.
 *
 * `thickness` 0.055, up from 0.038, and the reason is OCCLUSION rather than
 * proportion. The wheel sits 0.23 m in front of the driver's head, so from a
 * rear-quarter camera the head covers most of it and a sliver of the far rim
 * peeks past the jaw. At 0.038 that sliver is a thin curved taper and it reads
 * as stray geometry — a critic reported it as "a whisker or fur card rendering
 * edge-on... a stray or misangled triangle", and finding out otherwise took five
 * probes: flagging the pale surfaces cleared furLight, furMuzzle and mask;
 * relaxing the limb taper cleared the arms; rounding the ruff cleared the tufts;
 * zeroing the ear batch cleared the ears; and flagging four surface families at
 * once finally lit it green. THE SLIVER IS THE WHEEL and it is correct — it just
 * has to be thick enough that a fragment of it still reads as a rim. The sheet's
 * wheel is chunky anyway. The radius came down 0.20 -> 0.17 and the wheel moved
 * 0.04 m back toward the driver in the same pass, both so that the shoulder mass
 * covers more of it from astern; the sheet's wheel is modest in any case. What
 * remains visible is a short thick arc rather than a taper, which reads as part
 * of a wheel.
 *
 * `grip` is measured from the rim's TOP rather than from the horizontal for the
 * same reason: what has to clear the box is the paw, and the paw's height is
 * `y + radius * cos(grip)`, which is only readable if `grip` is the angle that
 * appears in it.
 *
 * 1.2 rad, DOWN FROM 0.75, and the reason is the rear camera. At 0.75 the paws
 * sat 0.17 m above the box rim, so from behind — between the two heads, with the
 * driver's own torso occluding the arm — one of them showed as a small dark shape
 * with finger ridges and nothing attached to it. A critic judging the gameplay
 * frame called it "a disembodied paw floating in the gap between the two backs"
 * and listed it as plainly broken, which is fair: it is geometrically correct and
 * it reads as an amputation. At 1.2 the paws come down to 1.03 m, near enough to
 * the 0.93 rim that the torso covers them from astern while they stay plainly on
 * the wheel from the front.
 */
const HELM = {
  radius: 0.17, thickness: 0.055, y: RIM_Y + 0.02, z: -1.04, rake: 0.5,
  /** Where the paws grip, as an angle either side of the rim's TOP. */
  grip: 1.2,
}

/**
 * How far the crew leaves the box in zero g.
 *
 * `rise` IS SOLVED AGAINST THE RIM and 0.30 was three times too small. The
 * measurement that settled it: the crew's lowest point is the torso's underside
 * at 0.074 m, the box rim is at 0.930, so 0.30 m of lift leaves the whole body
 * still 0.56 m INSIDE the box — no gap ever opens between animal and box, and
 * from outside the pose reads as "they stood up", not as zero g. 0.90 m puts the
 * torso's underside 0.04 m clear of the rim, so daylight shows between the crew
 * and the box, which is the entire content of the shot.
 *
 * `splay` pushes them apart at the same time, and it went up with the rise for a
 * related reason the critic caught: at full hover the two bodies, two heads and
 * four limbs merged into one horizontal chain of brown lumps in which you could
 * not tell there were two animals. `drift` slides them back — a body in free
 * fall inside a box that is still moving forward gets left behind by it.
 */
const HOVER = {
  rise: 1.05, splay: 0.24, drift: 0.1,
  /** How far BELOW the seat a landing may drive them, as a fraction of `rise`. */
  crouch: 0.13,
} as const

const UP = new THREE.Vector3(0, 1, 0)
const GLYPH_NORMAL = new THREE.Vector3(0, 0, 1)

/**
 * Where each occupant sits, and which of the two is driving.
 *
 * `z` MOVED FORWARD 0.66 m and that fixed the arms rather than the composition.
 * At -0.16 the crew sat almost exactly in the middle of a 2.68 m box while both
 * paw targets — the box's front rim at z -1.18 and the steering wheel — were up
 * at the front, so the passenger was being asked to reach 1.18 m on a 0.42 m
 * arm. The IK does not fail loudly when that happens: it clamps to full
 * extension and aims, so what rendered was a straight stick pointing at the rim
 * with a paw in mid-air 0.7 m short of it, which reads as a modelling error in
 * the arm. The reference's top-down view puts both animals hard against the
 * front of the box, which is also where the things they hold are.
 */
const SEAT = { x: 0.37, z: -0.82 }
/** Driver is index 0, on -x. Matches the reference sheet's front view. */
const DRIVER = 0

/** Resting hinge angle for flap `i`, in the layout order used below. */
function flapRest(i: number): number {
  return i < 2 ? FLAP.rest : FLAP.side
}

/** Deterministic 0..1 hash. No Math.random in generation, ever. */
function hash(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return x - Math.floor(x)
}

/**
 * One raccoon's animation state. The joints live in the shared `Rig`; this is
 * only the springs that drive them.
 *
 * Nothing here holds a target as a plain number that is then lerped: every one
 * of these is a `Spring`, so a schedule change produces a MOVEMENT rather than a
 * jump, which is the whole of the project's motion rule.
 */
interface Occupant {
  joints: RaccoonJoints
  side: number
  phase: number
  driving: boolean
  /**
   * Uniform size, so the two are not the same animal twice.
   *
   * The sheet draws them DIFFERENT: the driver is bulkier with a shaggier
   * silhouette and the passenger is smaller and smoother. The build shared every
   * geometry between two instances, so at gameplay distance a critic reported
   * them as "one clone pasted twice" — which they were. A per-instance uniform
   * scale is the cheapest possible differentiation and it costs no geometry, no
   * batch and no draw call.
   *
   * UNIFORM is not a stylistic choice. `Joint` composes its scale into the world
   * matrix and children inherit it, so a non-uniform value shears everything
   * below it — a slightly wide torso would hand a slightly wide, slightly
   * skewed skull to the head joint and every face marking with it.
   */
  size: number

  glanceYaw: AngleSpring
  glancePitch: Spring
  /** Vertical bob of the whole animal, plus the crouch under load. */
  bob: Spring
  /** Blink. 0 open, 1 shut. */
  lid: Spring
  glanceSlot: number
  /** Ear flick, one spring an ear, kicked on a schedule and on impact. */
  earFlick: [Spring, Spring]
  earSlot: number
  /** Tail: one angular spring per segment, per axis. Segment n chases n-1. */
  tailYaw: Spring[]
  tailPitch: Spring[]
  /** Spine lean, from measured lateral and longitudinal acceleration. */
  leanRoll: Spring
  leanPitch: Spring
  /** 0 gripping, 1 arms free and splayed. Rises with the hover. */
  release: Spring
  /** Scale of the "!" glyph. 0 absent. */
  alert: Spring
  /** How long the glyph has been up, for its wobble. */
  alertAge: number
}

export class Kart {
  /** Parented to `vehicle.object`. */
  readonly root = new THREE.Group()
  readonly materials: PainterlyMaterial[] = []

  /** Squash and breathing act on this; the wheels must not inherit them. */
  private readonly body = new THREE.Group()

  private readonly wheels: PosedInstances
  private readonly hubs: PosedInstances
  /** Trailing arm from the chassis down to each hub. */
  private readonly struts: PosedInstances
  /**
   * Two batches, not one. The flaps used to share a unit-width geometry scaled
   * per instance, which stretched the corrugated cut along the free edge into
   * ellipses on the long flaps and stopped it reading as a repeat. Each width
   * now gets its own geometry: index 0/1 are the short end flaps, 2/3 the long
   * side ones.
   */
  private readonly flapsShort: PosedInstances
  private readonly flapsLong: PosedInstances

  // ── the crew ──────────────────────────────────────────────────────────────
  // One batch per (shape, surface) pair. Thirteen batches for two whole animals
  // including a five-segment ringed tail and four-digit paws, which is the
  // return on driving instanced batches from a rig instead of building a scene
  // graph: an Object3D per joint would be 24 meshes an animal and 240 draw calls
  // a frame once the four shadow cascades are counted.
  private readonly rig = new Rig()
  private readonly skulls: PosedInstances
  private readonly masks: PosedInstances
  private readonly blazes: PosedInstances
  private readonly muzzles: PosedInstances
  private readonly noses: PosedInstances
  private readonly grins: PosedInstances
  private readonly tongues: PosedInstances
  private readonly earsOuter: PosedInstances
  private readonly earsInner: PosedInstances
  private readonly eyeballs: PosedInstances
  private readonly scleras: PosedInstances
  private readonly bodies: PosedInstances
  private readonly bibs: PosedInstances
  private readonly limbs: PosedInstances
  private readonly paws: PosedInstances
  private readonly tailFur: PosedInstances
  private readonly tailRing: PosedInstances
  private readonly alerts: PosedInstances
  private readonly alertInk: PosedInstances

  private readonly helm: THREE.Mesh

  // ── springs ───────────────────────────────────────────────────────────────
  /** One per flap. Underdamped so a gust makes them flutter, not swing once. */
  private readonly flapSprings: Spring[] = []
  /** Steering wheel angle. Follows the visual steer, with slack in the paws. */
  private readonly helmAngle = new Spring(0, 3.4, 0.7)
  /**
   * The zero-g hover. 0 seated, 1 floating clear of the box.
   *
   * SLOW AND HEAVILY UNDERDAMPED on purpose (0.9 Hz, zeta 0.42). This is the one
   * spring in the file whose ring-down is the feature rather than a side effect:
   * on a long jump the pair rise, overshoot, drift back down a little and hang,
   * which is what reads as weightlessness. A critically damped version arrives
   * and stops, and a pair of animals that arrive at a new height and hold it
   * read as having been TELEPORTED up, not as floating.
   */
  private readonly hover = new Spring(0, 0.9, 0.42)

  private readonly occupants: Occupant[] = []

  private readonly p = new THREE.Vector3()
  private readonly s = new THREE.Vector3()
  private readonly m = new THREE.Matrix4()
  private readonly q = new THREE.Quaternion()
  private readonly target = new THREE.Vector3()
  private readonly worldPos = new THREE.Vector3()
  private readonly camWorld = new THREE.Vector3()
  private readonly offsetM = new THREE.Matrix4()
  private readonly rollQ = new THREE.Quaternion()
  private readonly wind: WindField | null
  /** Last frame's paw targets, kept only so `probe()` can report the miss. */
  private readonly pawTargets = [
    new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(),
  ]

  constructor(atmosphere: Atmosphere, wind: WindField | null = null) {
    this.wind = wind
    // THROUGH `graded()`, which this file was not doing and should have been.
    //
    // CLAUDE.md makes it an invariant — "The Forge must render exactly like the
    // game. Both go through `graded(surfaceId, params)`... If you add another
    // viewer, route it there" — and lists five callers. The kart was a sixth and
    // took the RAW def, so every surface on the vehicle was rendering with the
    // abandoned painterly overlay still switched on: `CLEAN` zeroes
    // `brushStrength`, `brushHue`, `detailStrength`, `regionStep` and
    // `reliefShade`, and the kart was running all five at whatever its defs
    // authored.
    //
    // That is not a bookkeeping point, it is the mottle. `fur` carries
    // detailStrength 0.10 and reliefShade 0.40, and on a 0.29 m sphere at 250 px
    // that pair renders as the blotchy camouflage field ART_BIBLE 1 abandoned —
    // measured on car-crew, the heads were the noisiest surfaces in the frame,
    // and three rounds were spent trying to author it away in the defs. It
    // cannot be authored away from here: `graded` OVERRIDES the def, so the
    // def's own value was never going to be the one that shipped for any other
    // surface in the game, and the kart was the only place it was.
    const mat = (id: string): THREE.Material => {
      const m = new PainterlyMaterial(atmosphere, graded(id, surface(id)))
      this.materials.push(m)
      return m.material
    }
    const cardboard = mat('cardboard')
    const flapMat = mat('cardboardFlap')
    const tapeMat = mat('tape')
    const inkMat = mat('boxInk')
    const tyre = mat('tyre')
    const fur = mat('fur')
    const furLight = mat('furLight')
    const furDark = mat('furDark')
    const furMuzzle = mat('furMuzzle')
    const maskMat = mat('mask')
    const eyeMat = mat('eye')
    const hubMat = mat('hub')
    const helmMat = mat('helm')
    const alertMat = mat('alert')
    const mouthMat = mat('mouthPink')
    const alertInkMat = mat('alertOutline')

    this.root.name = 'kart'
    this.root.add(this.body)

    // ── the box ────────────────────────────────────────────────────────────
    // Corrugation, fold creases, tape and print, all as geometry — see
    // src/vehicle/box.ts for why none of it could be done in the material.
    const boxMesh = new THREE.Mesh(boxShellGeometry(BOX.w, BOX.h, BOX.d, BOX.r), cardboard)
    boxMesh.position.y = BOX_Y
    boxMesh.name = 'kart-box'
    boxMesh.frustumCulled = false
    this.body.add(boxMesh)

    for (const [geo, m, name] of [
      [boxTapeGeometry(BOX.w, BOX.h, BOX.d, BOX.r), tapeMat, 'kart-box-tape'],
      [boxInkGeometry(BOX.w, BOX.h, BOX.d, BOX.r), inkMat, 'kart-box-ink'],
    ] as const) {
      const mesh = new THREE.Mesh(geo, m)
      mesh.position.y = BOX_Y
      mesh.name = name
      mesh.frustumCulled = false
      this.body.add(mesh)
    }

    // ── flaps: hinged at their own origin ──────────────────────────────────
    this.flapsShort = new PosedInstances(
      flapGeometry(BOX.w - 0.16, FLAP.len, FLAP.thick), flapMat, 2, 'kart-flaps-end',
    )
    this.flapsLong = new PosedInstances(
      flapGeometry(BOX.d - 0.2, FLAP.len, FLAP.thick), flapMat, 2, 'kart-flaps-side',
    )
    this.body.add(this.flapsShort.mesh, this.flapsLong.mesh)
    for (let i = 0; i < 4; i++) {
      this.flapSprings.push(new Spring(flapRest(i), 2.3 + i * 0.21, 0.42))
    }

    // ── the exhaust, taped to the side ─────────────────────────────────────
    // Shares `helm`: every scavenged manufactured part on this vehicle is the
    // same cool lavender, which is the sheet's own rule and what separates them
    // from the cardboard they are stuck to.
    const exhaust = new THREE.Mesh(exhaustGeometry(), helmMat)
    exhaust.position.set(EXHAUST.x * (BOX.w * 0.5 + 0.05), BOX_Y + EXHAUST.y, EXHAUST.z)
    exhaust.name = 'kart-exhaust'
    exhaust.frustumCulled = false
    this.body.add(exhaust)

    // ── the steering wheel ─────────────────────────────────────────────────
    // Bolted to the box, not to the driver: the paws come to IT, which is the
    // right way round both physically and for the IK — a wheel parented to a
    // paw would move when the animal leaned, and a leaning driver whose wheel
    // follows their hands is not steering anything.
    this.helm = new THREE.Mesh(helmGeometry(HELM.radius, HELM.thickness), helmMat)
    this.helm.position.set(-SEAT.x, HELM.y, HELM.z)
    this.helm.rotation.x = HELM.rake
    this.helm.name = 'kart-helm'
    this.helm.frustumCulled = false
    this.body.add(this.helm)

    // ── occupants ──────────────────────────────────────────────────────────
    // Segment counts are set by SCREEN SIZE, not by taste. At the 4.6 m arm
    // `car-idle` uses a head is ~250 px tall and an ear ~70, and at 10 segments
    // the facets on an ear were individually countable — a hexagonal ear is a
    // modelling error, not a stylisation. ART_BIBLE §6 asks for "chunky,
    // rounded" forms whose "volume reads from silhouette alone", which is
    // exactly what a countable facet destroys.
    const R = RACCOON
    this.skulls = new PosedInstances(skullGeometry(), fur, 2, 'kart-skulls')
    this.masks = new PosedInstances(maskGeometry(), maskMat, 2, 'kart-masks')
    this.blazes = new PosedInstances(blazeGeometry(), furLight, 2, 'kart-blazes')
    // NOT `furLight`. The reference's muzzle is 0.18 of value darker than its
    // brow blaze and the two were sharing a surface — see furMuzzle.json.
    this.muzzles = new PosedInstances(muzzleGeometry(), furMuzzle, 2, 'kart-muzzles')
    this.noses = new PosedInstances(noseGeometry(), furDark, 2, 'kart-noses')
    // The driver grins and the passenger does not — the reference's own
    // asymmetry, and most of the pair's character. Both batches carry two
    // instances and the passenger's is written at zero scale, which is cheaper
    // than splitting the shared mask geometry in two.
    this.grins = new PosedInstances(grinGeometry(false), eyeMat, 2, 'kart-grins')
    this.tongues = new PosedInstances(grinGeometry(true), mouthMat, 2, 'kart-tongues')
    this.earsOuter = new PosedInstances(earGeometry(false), fur, 4, 'kart-ears')
    this.earsInner = new PosedInstances(earGeometry(true), furLight, 4, 'kart-ears-inner')
    // THE DARK ONE IS THE IRIS AND IT IS THE SMALLER OF THE TWO. See
    // `RACCOON.iris` for the inversion this is fixing — a cream sphere concentric
    // with and larger than a dark one hides the dark one completely, which is
    // what shipped for one capture and produced two pairs of pupil-less beads.
    this.eyeballs = new PosedInstances(sphere(R.eye * R.iris, 12), eyeMat, 4, 'kart-irises')
    // The eyeball, pale, and it is the LARGER of the two.
    //
    // The offset version was a real misreading of the reference. There IS a cream
    // crescent on the outboard side of the reference's iris, and I built it by
    // translating a 1.1x sphere sideways by 0.3 of the eye radius. Measured, that
    // makes the assembly 0.125 m wide on a 0.638 m skull — 0.195 of the head
    // against the reference's 0.112 — at an aspect ratio of 1.32. So the eye was
    // half again too big AND an oval AND had its pupil shoved inboard, and both
    // animals read cross-eyed. What the reference actually draws is cream
    // wrapping the outer edge and the top and the bottom of the iris, which is
    // what a dark iris sitting on the FRONT of a pale ball gives you for free,
    // and which no arrangement of two concentric spheres can give you at all.
    this.scleras = new PosedInstances(sphere(R.eye, 14), furLight, 4, 'kart-eyeballs')
    this.bodies = new PosedInstances(bodyGeometry(), fur, 2, 'kart-bodies')
    // The pale chest bib. Its own batch because it is a different surface; it
    // rides the spine exactly as the body does, since it is built from the same
    // profile.
    this.bibs = new PosedInstances(bibGeometry(), furLight, 2, 'kart-bibs')
    // 0.55 of the upper arm's length, not 0.42. At 0.084 m of radius against a
    // 0.35 m torso the arms were twigs, and a twig with a 0.072 m paw on the end
    // of it reads as a starfish on a stick.
    this.limbs = new PosedInstances(limbGeometry(R.upperArm * 0.55), fur, 8, 'kart-limbs')
    this.paws = new PosedInstances(pawGeometry(), furDark, 4, 'kart-paws')
    // Rings are the MATERIAL, not the geometry: even segments in fur, odd in
    // near-black. Five segments an animal, so three pale and two dark.
    // COUNTS DERIVED FROM `tailSegments`, not written out. They were 6 and 4 for
    // a five-segment tail and the segment count has now changed twice; a literal
    // here silently drops the tip segments off the end of the batch, which
    // renders as a tail that is mysteriously short rather than as an error.
    const tailFurN = Math.ceil(R.tailSegments / 2) * 2
    const tailRingN = Math.floor(R.tailSegments / 2) * 2
    this.tailFur = new PosedInstances(tailGeometry(R.tailRadius), fur, tailFurN, 'kart-tail-fur')
    this.tailRing = new PosedInstances(
      tailGeometry(R.tailRadius), furDark, tailRingN, 'kart-tail-ring',
    )
    // 0.52 m tall: about 0.8 of a skull's width, which is the ratio a comic
    // exclamation over a head is drawn at. At 0.42 it was legible and timid.
    //
    // TWO BATCHES, because the keyline is a different surface. The glyph used to
    // draw its own outline in its own red, which is not an outline: measured, the
    // glyph rendered #af2e29 V0.69 against a V0.90 snowfield and read as a dark
    // smear. Ink behind fill is what makes a comic mark legible over both a bright
    // sky and a dark hillside, and it is two draw calls for the whole crew.
    this.alerts = new PosedInstances(alertGeometry(0.52, false), alertMat, 2, 'kart-alerts')
    this.alertInk = new PosedInstances(
      alertGeometry(0.52, true), alertInkMat, 2, 'kart-alert-ink',
    )

    for (const b of [
      this.bodies, this.bibs, this.skulls, this.masks, this.blazes, this.muzzles,
      this.noses, this.grins, this.tongues, this.earsOuter, this.earsInner,
      this.eyeballs, this.scleras, this.limbs, this.paws, this.tailFur,
      this.tailRing, this.alerts, this.alertInk,
    ]) {
      this.body.add(b.mesh)
    }

    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1
      const joints = buildRaccoonJoints(this.rig, side)
      this.occupants.push({
        joints,
        side,
        phase: hash(i * 7 + 3),
        driving: i === DRIVER,
        size: i === DRIVER ? 1 : 0.93,
        // Underdamped: a glance arrives slightly past where it was going and
        // settles, which is most of what makes it read as alive.
        glanceYaw: new AngleSpring(0, 1.15, 0.5),
        glancePitch: new Spring(0, 1.3, 0.6),
        bob: new Spring(0, 1.6, 0.6),
        lid: new Spring(0, 9, 0.85),
        glanceSlot: -1,
        // Stiff and nearly undamped: an ear flick is a 0.1 s twitch that rings
        // twice. Anything slower is a head shake.
        earFlick: [new Spring(0, 5.2, 0.3), new Spring(0, 5.6, 0.28)],
        earSlot: -1,
        tailYaw: [],
        tailPitch: [],
        leanRoll: new Spring(0, 1.35, 0.55),
        leanPitch: new Spring(0, 1.5, 0.6),
        release: new Spring(0, 2.4, 0.8),
        // The glyph pops. `easeOutBack` is applied on top of this, so the spring
        // only has to be quick and slightly loose.
        alert: new Spring(0, 4.2, 0.5),
        alertAge: 0,
      })
      const o = this.occupants[i]!
      for (let t = 0; t < joints.tail.length; t++) {
        // Softer toward the tip: a tail is stiff at the root and floppy at the
        // end, so the frequency falls and the damping falls with it. That
        // gradient IS the whip — with one frequency for all five the chain moves
        // as a rigid arc and reads as a board.
        o.tailYaw.push(new Spring(0, 2.6 - t * 0.3, 0.5 - t * 0.05))
        o.tailPitch.push(new Spring(0, 2.8 - t * 0.32, 0.52 - t * 0.05))
      }
    }

    // ── wheels ─────────────────────────────────────────────────────────────
    this.wheels = new PosedInstances(wheelGeometry(0.4, 0.3, 14), tyre, 4, 'kart-wheels')
    // A HUBCAP, not a second wheel. This used to call `wheelGeometry` at a
    // smaller radius, so each wheel had a toothed disc inside a toothed tyre —
    // see `hubCapGeometry` for what that did to the vehicle's register.
    this.hubs = new PosedInstances(hubCapGeometry(0.19, 0.34), hubMat, 4, 'kart-hubs')

    const strutGeo = roundedBox(0.115, 1, 0.15, 0.05, 2)
    strutGeo.translate(0, -0.5, 0)
    this.struts = new PosedInstances(strutGeo, hubMat, 4, 'kart-struts')
    this.root.add(this.wheels.mesh, this.hubs.mesh, this.struts.mesh)
  }

  /**
   * Per-occupant pose diagnostics, for `window.__trench.crew()`.
   *
   * IT REPORTS THE PAW MISS, which is the number three rounds of this work needed
   * and did not have. A two-bone IK that cannot reach its target does not error —
   * it clamps to full extension and aims — so "the driver's paws are on the
   * wheel" was an opinion about a 20-pixel region of a capture, and it was wrong
   * for three rounds while the target sat 1.18 m away on a 0.42 m arm. `miss` is
   * the distance from the solved paw to where it was told to be, and anything
   * over about 0.02 m is a paw in mid-air.
   *
   * READ IT AGAINST `release`. At release 0 the paws are gripping and any miss is
   * a fault; the airborne splay is a pose rather than a grip and a small residual
   * there is only how far the spring has left to travel.
   *
   * `flaps`, `ears` and `tail` are here for the IMPACT RESPONSE, which a still
   * frame fundamentally cannot show: a flap at 1.9 rad photographs identically
   * whether it was kicked there or authored there, so "do the flaps react to a
   * landing" is only answerable as a DIFFERENCE between the landing frame and a
   * control. That is the subject-vs-control discipline the gates already use, and
   * it is why `car-thump`'s framing was being agonised over for two rounds while
   * the question it exists to answer was not a framing question at all.
   */
  probe(): {
    driving: boolean; hover: number; release: number
    /** Flap hinge angles off vertical, radians, in layout order. */
    flaps: number[]
    /** Ear flick spring values — the impact response, per ear. */
    ears: number[]
    /** Tail segment pitch springs, root to tip. */
    tail: number[]
    paws: { miss: number; target: [number, number, number] }[]
  }[] {
    return this.occupants.map((o) => ({
      flaps: this.flapSprings.map((f) => f.value),
      ears: o.earFlick.map((e) => e.value),
      tail: o.tailPitch.map((t) => t.value),
      driving: o.driving,
      hover: this.hover.value,
      release: o.release.value,
      paws: [o.joints.pawL, o.joints.pawR].map((paw, a) => {
        const t = this.pawTargets[this.occupants.indexOf(o) * 2 + a]!
        paw.worldPosition(this.worldPos)
        return {
          miss: this.worldPos.distanceTo(t),
          target: [t.x, t.y, t.z] as [number, number, number],
        }
      }),
    }))
  }

  /**
   * `elapsed` is the deterministic clock, so the idle layer is frame-exact in a
   * capture. `dt` of 0 must leave everything untouched — the shot harness
   * freezes the clock and keeps rendering.
   *
   * `camera` is only used to billboard the "!" glyph, and is optional so the
   * Forge and any other viewer can drive a kart without one.
   */
  update(dt: number, elapsed: number, vehicle: Vehicle, camera?: THREE.Camera): void {
    const t = vehicle.telemetry
    const speedNorm = saturate(t.speed / 35)
    // The idle layer never switches off, it only quietens: a driving car still
    // breathes. 1 parked, ~0.3 flat out.
    const amp = 0.3 + 0.7 * t.idle

    // ── the box breathes ───────────────────────────────────────────────────
    const b = sway(elapsed, 0.28)
    const sq = t.squash
    // Volume-ish conservation: squash down, spread out. Scaling about y = 0
    // keeps the base sitting on the wheels instead of sinking through them.
    this.body.scale.set(
      1 + sq * 0.42 - 0.009 * b * amp,
      1 - sq - 0.0 + 0.017 * b * amp,
      1 + sq * 0.42 - 0.009 * b * amp,
    )
    this.body.position.y = 0.012 * b * amp

    // ── the hover: airborne, the crew floats out of the box ────────────────
    // Driven by AIRTIME rather than by the airborne flag, so a wheel skipping
    // over a kerb for two frames does not launch two raccoons. 0.28 s is about
    // the shortest air a jump ramp produces and about the longest a bump does.
    const air = smoothstep(0.12, 0.55, t.airtime)
    // THE LANDING SLAMS THEM BACK IN. Without this the hover comes down at the
    // same 0.9 Hz it went up at, and 0.9 Hz is a 1.1 second period — so 0.07 s
    // after touchdown the crew is still at 0.95 of full hover, floating above a
    // box that has already hit the ground and squashed. Measured on car-thump,
    // which is why that capture exists.
    //
    // A velocity kick rather than a faster spring, because the asymmetry is the
    // POINT and it is also what physically happens: going up is free-fall drift
    // and the pair are weightless, coming down is a cardboard box arriving
    // underneath them at 30 m/s. The spring is underdamped, so the kick
    // overshoots into the box and rebounds once — which is the comic beat, and
    // it lands on the same frame as the body squash because both read the same
    // `landingImpact`.
    if (t.landingImpact > 0) this.hover.kick(-clamp(t.landingImpact * 0.22, 0, 5))
    this.hover.step(dt, air)
    // THE BOX FLOOR STOPS THEM. Measured without this, the landing kick rang the
    // spring to hover -0.48, which is 0.43 m below the seat — the whole crew
    // through the bottom of the box and out under the kart. A negative hover is
    // wanted (it is the crouch as they land) and an unbounded one is a hole in
    // the vehicle.
    //
    // The velocity is killed as well as the value, and that is the part that
    // matters: clamping the value alone leaves the spring winding up below the
    // floor and then springing back out of it later, which reads as a bounce
    // that arrives half a second after the landing it belongs to. Killing the
    // velocity is what a floor physically does.
    if (this.hover.value < -HOVER.crouch) {
      this.hover.value = -HOVER.crouch
      if (this.hover.velocity < 0) this.hover.velocity = 0
    }
    const hover = this.hover.value

    this.poseFlaps(dt, elapsed, t, speedNorm, amp)
    this.poseHelm(dt, vehicle)
    this.poseCrew(dt, elapsed, t, amp, hover, camera)
    this.poseWheels(vehicle)
  }

  /**
   * Flaps: blown open by the WIND FIELD and by speed, kicked by impact.
   *
   * THE WIND IS THE GLOBAL ONE NOW. This used to be a private `sway()` per flap
   * and that was a straight violation of the CLAUDE.md invariant ("all
   * vegetation samples the one global wind field. No per-asset wobble") in
   * everything but the letter. It matters visually and not just bureaucratically:
   * each flap samples at its OWN world position, so a gust front crosses the
   * four flaps in the order the geometry sits along the wind vector, and the
   * same front is already crossing the grass the kart is parked in. A private
   * sine cannot ever agree with the weather.
   *
   * IMPACT. `landingImpact` is held for exactly one frame by the vehicle, so it
   * is a velocity KICK on the spring rather than a target — a target would need
   * to be held and released, and the release would be a second event to tune.
   * The kick is the physically right shape too: the box decelerates, the flap
   * does not, so the flap keeps going up.
   */
  private poseFlaps(
    dt: number, elapsed: number, t: Vehicle['telemetry'], speedNorm: number, amp: number,
  ): void {
    const flapLayout: readonly [number, number, number][] = [
      // x, z, yaw. Widths are baked into the two geometries.
      [0, -BOX.d * 0.5 + 0.02, 0],
      [0, BOX.d * 0.5 - 0.02, Math.PI],
      [-BOX.w * 0.5 + 0.02, 0, Math.PI * 0.5],
      [BOX.w * 0.5 - 0.02, 0, -Math.PI * 0.5],
    ]
    // One impulse per landing, shared out over the flaps by how much of the
    // impact each one can see. The end flaps take the most because the box
    // pitches about its lateral axis on a landing.
    if (t.landingImpact > 0) {
      for (let i = 0; i < 4; i++) {
        // The end pair swings free and takes the whole impulse; the side pair is
        // folded flat against the wall and can only shiver against it.
        const share = i < 2 ? 1 : 0.18
        this.flapSprings[i]!.kick(t.landingImpact * 0.09 * share * (0.7 + hash(i) * 0.6))
      }
    }
    for (let i = 0; i < 4; i++) {
      const [fx, fz, yaw] = flapLayout[i]!
      const spring = this.flapSprings[i]!
      // Airflow pushes the leading flaps open and the trailing ones flat; the
      // side flaps mostly feel the corner.
      const facing = i === 0 ? 1 : i === 1 ? -0.55 : 0
      const lateral = (i === 2 ? -1 : i === 3 ? 1 : 0) * clamp(t.aLat, -30, 30) * 0.004
      // Sampled at the flap's own hinge in WORLD space, so the gust travels.
      let gust = 0
      if (this.wind) {
        this.p.set(fx, RIM_Y, fz)
        this.body.localToWorld(this.p)
        const w = this.wind.sampleAt(this.p.x, this.p.z)
        // Project the field onto the flap's own outward normal: a flap edge-on
        // to the wind barely moves, one facing it opens. `yaw` is the flap's
        // outward direction about +Y.
        gust = w.x * Math.sin(yaw) + w.z * -Math.cos(yaw)
      } else {
        gust = sway(elapsed, 1.05 + i * 0.17, hash(i * 17 + 11))
      }
      // A flap folded flat against the wall has nowhere to go, so the whole
      // airflow term is scaled right down on the side pair. Leaving it at full
      // strength peeled them off the wall at speed and undid the fold.
      const free = i < 2 ? 1 : 0.14
      const target = flapRest(i)
        + (speedNorm * 0.42 * facing
          + lateral
          + gust * (0.055 + 0.13 * speedNorm) * (0.5 + amp * 0.5)
          - clamp(t.aLong, -60, 60) * 0.0016) * free
      // The ceiling is 2.95 rather than 2.0 now that the front flap rests at
      // 2.7 — a clamp below a spring's own rest value pins it there and every
      // gust and every impact kick on that flap silently did nothing.
      const angle = spring.step(dt, clamp(target, 0.9, 2.95))
      this.p.set(fx, RIM_Y - 0.03, fz)
      // 'YXZ': yaw first, then the hinge tilt in the flap's own frame.
      const batch = i < 2 ? this.flapsShort : this.flapsLong
      batch.set(i & 1, this.p, -clamp(angle, 0.85, 3.0), yaw, 0)
    }
    this.flapsShort.flush()
    this.flapsLong.flush()
  }

  /**
   * The steering wheel turns with the steer, and it turns MORE than the wheels
   * do.
   *
   * `steerVis` is the visual road-wheel angle, about 0.5 rad at full lock. A
   * real wheel turns two or three times that, and the cartoon read wants more
   * still, so the ratio is 2.6 — enough that the driver's paws visibly travel
   * round the rim in a corner, which is the only thing that proves the animal is
   * driving rather than holding on.
   */
  private poseHelm(dt: number, vehicle: Vehicle): void {
    // `Vehicle.steerVis` is private; the front wheel's own `steerAngle` IS that
    // spring's output, already smoothed, so reading it here keeps one source of
    // truth rather than a second spring chasing the input.
    const front = vehicle.wheels.find((w) => w.front)
    this.helm.rotation.z = -this.helmAngle.step(dt, (front?.steerAngle ?? 0) * 2.6)
  }

  /** Pose both raccoons, then flush every batch once. */
  private poseCrew(
    dt: number, elapsed: number, t: Vehicle['telemetry'], amp: number, hover: number,
    camera?: THREE.Camera,
  ): void {
    this.rig.clear()
    for (let i = 0; i < this.occupants.length; i++) {
      this.poseOne(this.occupants[i]!, i, dt, elapsed, t, amp, hover)
    }
    this.rig.solve()
    for (let i = 0; i < this.occupants.length; i++) {
      this.writeOne(this.occupants[i]!, i, RACCOON, hover, camera)
    }
    for (const batch of [
      this.bodies, this.bibs, this.skulls, this.masks, this.blazes, this.muzzles,
      this.noses, this.grins, this.tongues, this.earsOuter, this.earsInner,
      this.eyeballs, this.scleras, this.limbs, this.paws, this.tailFur,
      this.tailRing, this.alerts, this.alertInk,
    ]) batch.flush()
  }

  /**
   * Write one raccoon's POSE onto its joints. Nothing here reads a world matrix,
   * because none of them are solved yet — the paw IK is the one thing that needs
   * a solved chain and it runs in two stages for exactly that reason (see
   * `aimArm`).
   */
  private poseOne(
    o: Occupant, i: number, dt: number, elapsed: number,
    t: Vehicle['telemetry'], amp: number, hover: number,
  ): void {
    const j = o.joints
    const R = RACCOON

    // ── the seat: where the animal sits, and how far it has floated out ────
    // The hover is the headline feature and it is ONE joint. `rise` is set so
    // the chest clears the rim rather than by eye: seated, the shoulders are
    // just under it; at full hover the whole torso is above it and the box reads
    // as having let go of its cargo.
    const hoverBob = sway(elapsed, 0.37, o.phase * 1.7) * hover * 0.05
    j.seat.offset.set(
      SEAT.x * o.side + hover * o.side * HOVER.splay,
      FLOOR_Y + hover * HOVER.rise + hoverBob,
      SEAT.z + hover * HOVER.drift,
    )
    j.seat.scale.setScalar(o.size)

    // ── breathing, lean, crouch ────────────────────────────────────────────
    // The bob is the animal's whole mass moving, so it lives on the spine and
    // not on the head: a head that bobs on a still body is a nodding dog.
    const bobTarget = sway(elapsed, 0.44, o.phase) * 0.026 * amp
      - saturate(t.squash) * 0.075
    const bob = o.bob.step(dt, bobTarget)
    j.spine.offset.y += bob
    // Chest expands on the breath. 1.5% is almost nothing and it is the
    // difference between a parked animal and a prop — it is the only motion left
    // on a frame where every spring has settled.
    const breath = 1 + sway(elapsed, 0.31, o.phase * 2.3) * 0.017 * amp
    j.chest.scale.set(breath, 1 / breath ** 0.4, breath)

    // Lean: measured acceleration, through springs, so a corner is entered and
    // left rather than snapped into. Airborne it INVERTS toward a splay — a
    // falling animal arches back, it does not lean into a corner it cannot feel.
    const leanRoll = o.leanRoll.step(dt, clamp(t.aLat, -40, 40) * -0.0038 * (1 - hover))
    const leanPitch = o.leanPitch.step(dt, clamp(t.aLong, -80, 80) * 0.0026 * (1 - hover))
    j.spine.rotation.z = leanRoll
    // ARCHES BACK in the hover, and this is a sign flip. `- hover * 0.3` tipped
    // the spine's up-axis toward -Z, which is FORWARD, so the pair went face-down
    // — and a face-down animal with its arms splayed is indistinguishable from
    // the animal next to it. What a startled body in free fall does is arch, so
    // the chest opens toward the camera and both faces stay legible.
    // 0.12, down from 0.22. The arch is right and the amount was not: at 0.22 rad
    // the head joint — 0.75 m up the chain — swings 0.16 m back, the shoulder mass
    // it is supposed to meet swings a third of that, and the 0.02 m overlap at the
    // throat becomes a 0.14 m GAP. Two heads floating clear of two bodies is the
    // one thing a zero-g pose must not look like, because it is what a broken
    // parent looks like.
    j.spine.rotation.x = leanPitch + hover * 0.12

    // ── head: glance, and the impact nod ───────────────────────────────────
    const glanceSlot = Math.floor(elapsed / 2.6 + o.phase * 3)
    if (glanceSlot !== o.glanceSlot) {
      o.glanceSlot = glanceSlot
      // +/-46 degrees of yaw. The wide +/-77 range was written when the chase
      // camera only ever saw the backs of two heads and was solving that by
      // turning a head far enough that one cheek came round; now that the rig
      // frames the occupants and the parked captures are taken from the front,
      // the same number is the problem — at 77 degrees a chunky skull presents
      // its BACK to the camera for most of a cycle and reads as a head spinning.
      o.glanceYaw.target = (hash(glanceSlot * 13 + i) - 0.5) * 1.6
      // Biased upward: the rig sits above the occupants, so a symmetric range
      // spends half its time showing the tops of two skulls.
      o.glancePitch.target = (hash(glanceSlot * 29 + i * 5) - 0.35) * 0.42
    }
    const gw = 0.35 + 0.65 * t.idle
    const yawG = o.glanceYaw.step(dt, o.glanceYaw.target) * gw
    const pitchG = o.glancePitch.step(dt, o.glancePitch.target) * gw
    j.head.rotation.y = yawG
    // Airborne, the head comes UP. Positive rx lifts the gaze — the head's
    // forward is -Z, so rotating by +rx sends it to (0, sin rx, -cos rx). It was
    // NEGATIVE, which pointed both faces at the ground for the whole flight.
    j.head.rotation.x = pitchG + hover * 0.14 + leanPitch * 0.4
    j.head.rotation.z = leanRoll * 0.5

    // ── ears: flick on a schedule, flop on impact, and rise in the hover ───
    const earSlot = Math.floor(elapsed / 1.9 + o.phase * 5)
    if (earSlot !== o.earSlot) {
      o.earSlot = earSlot
      // Only one ear, and only sometimes. Both ears flicking together is a
      // rabbit; a single ear twitching on its own is what an animal does.
      const which = hash(earSlot * 31 + i) > 0.5 ? 1 : 0
      if (hash(earSlot * 41 + i * 3) > 0.35) {
        o.earFlick[which]!.kick(2.6 + hash(earSlot * 7) * 1.6)
      }
    }
    if (t.landingImpact > 0) {
      // Both ears, hard. A landing is felt by the whole animal.
      //
      // THE COEFFICIENT WAS FOUR TIMES TOO SMALL and only a measurement found
      // it: `window.__trench.crew()` across a real landing showed the ear flick
      // peaking at 0.10 rad and back to 0.00 within 0.08 s. On a 5.2 Hz spring
      // the peak displacement is kick/omega = kick/32.7, so the old ceiling of 5
      // could never produce more than 0.15 rad however hard the car hit — a flop
      // too small and too brief to see in any frame. 24 gives 0.73 rad, which is
      // an ear visibly thrown back and ringing down over about a third of a
      // second. A still frame cannot show this at all, which is why it survived
      // three rounds of looking at captures.
      const k = clamp(t.landingImpact * 1.8, 0, 24)
      o.earFlick[0]!.kick(k)
      o.earFlick[1]!.kick(k * 0.86)
    }
    for (let e = 0; e < 2; e++) {
      const side = e === 0 ? -1 : 1
      const flick = o.earFlick[e]!.step(dt, 0)
      const ear = e === 0 ? j.earL : j.earR
      // DELTAS off the rest cant, which `Joint.clear()` has already restored —
      // the outward cant is part of the animal, not part of the animation. The
      // flick rotates about the ear's own base, which is the whole reason the
      // ear needed to be a joint.
      ear.rotation.z += (flick * 0.16 + hover * 0.18) * side
      ear.rotation.x += -flick * 0.1 - hover * 0.14
    }

    // ── blink ──────────────────────────────────────────────────────────────
    const blinkPeriod = 3.1 + o.phase * 1.7
    const blinkSlot = Math.floor(elapsed / blinkPeriod + o.phase)
    const blinkT = elapsed - (blinkSlot - o.phase) * blinkPeriod
    // Eyes stay WIDE while falling. A raccoon that blinks calmly through a
    // 10 m drop is not alarmed, and the "!" over its head says it is.
    const closing = blinkT < 0.11 && hover < 0.3 ? 1 : 0
    o.lid.step(dt, closing)

    // ── tail: a chain, each segment chasing its parent ─────────────────────
    // The DRIVE is at the root only. Every segment below it is driven by the
    // segment above through its own spring, which is what makes the motion
    // travel down the chain as a wave instead of the whole tail rotating
    // rigidly. That lag is the only thing in this file that is genuinely a
    // simulation rather than a pose.
    const tailWind = this.wind
      ? (() => {
        j.seat.worldPosition(this.worldPos)
        this.body.localToWorld(this.worldPos)
        const w = this.wind!.sampleAt(this.worldPos.x, this.worldPos.z)
        return w.x * 0.06 + w.z * 0.04
      })()
      : 0
    let driveYaw = clamp(t.aLat, -40, 40) * 0.0075
      + sway(elapsed, 0.33, o.phase) * 0.1 * amp
      + tailWind
    let drivePitch = -clamp(t.aLong, -80, 80) * 0.003
      + sway(elapsed, 0.41, o.phase * 1.3) * 0.075 * amp
      // Floats UP in the hover. A tail that hangs while the animal floats is
      // the one part that would give the trick away — but this is applied to
      // EVERY segment on top of the 0.55 rad rest curl, so it multiplies by
      // five: at -0.34 the total came to 3.6 rad and the tail wrapped right over
      // the animal's head and down in front of its chest, which read as a
      // tentacle rather than as a tail floating. -0.10 adds about 0.5 rad over
      // the whole chain, which opens the arc without inverting it.
      + hover * -0.1
    if (t.landingImpact > 0) {
      // Same correction as the ears, from the same measurement: at a ceiling of
      // 1.4 on a 2.8 Hz spring the tail root moved 0.08 rad on a landing that
      // arrived at 58 m/s, i.e. the tail did not react. 9 gives 0.51 rad at the
      // root, and the chain's own lag carries it to the tip over the next few
      // frames — which is the whole reason the tail is a chain.
      const k = clamp(t.landingImpact * 0.9, 0, 9)
      o.tailPitch[0]!.kick(k)
      o.tailYaw[0]!.kick(k * 0.5 * o.side)
    }
    for (let s = 0; s < j.tail.length; s++) {
      const yaw = o.tailYaw[s]!.step(dt, driveYaw)
      const pitch = o.tailPitch[s]!.step(dt, drivePitch)
      // `+=`, not `=`: `clear()` has put the segment back on its authored curl
      // and these springs bend the tail AWAY from it. Assigning would straighten
      // the whole tail out into the box the instant any spring settled at zero.
      j.tail[s]!.rotation.y += yaw
      j.tail[s]!.rotation.x += pitch
      // The next segment's target is what this one actually DID, scaled down —
      // so the wave decays as it travels and the tip does not flail harder than
      // the root.
      driveYaw = yaw * 0.72
      drivePitch = pitch * 0.72
    }

    // ── arms: grip, or splay ───────────────────────────────────────────────
    o.release.step(dt, hover)

    // ── the "!" ────────────────────────────────────────────────────────────
    // FALLING, not merely airborne — see `writeAlert` for why that distinction
    // is the whole gag. The two animals notice a beat apart: `phase` shifts the
    // threshold, so one glyph is always up first.
    const falling = t.airborne && t.vy < -(2.4 + o.phase * 1.1) ? 1 : 0
    if (falling && o.alert.value < 0.02) o.alertAge = 0
    else o.alertAge += dt
    // Springs in, snaps out. A warning that fades away slowly is not a warning,
    // so on the way down the target is chased twice as fast by the spring's own
    // frequency being irrelevant — the value is simply floored to zero once the
    // animal is back on the ground, and the landing squash covers the cut.
    o.alert.step(dt, falling)
    if (!falling && !t.airborne) o.alert.value *= 0.72
  }

  /**
   * Solve the arms against world-space targets and write every batch.
   *
   * SPLIT FROM `poseOne` FOR A REASON. The paw targets are the steering wheel's
   * rim and the box rim, which live in the BODY's frame, and the shoulder they
   * reach from is at the end of a chain that has just been posed. So the chain
   * has to be solved once before the IK can know where the shoulder ended up.
   * Doing the arms in the same pass as the pose would aim them at last frame's
   * shoulder, which lags by one frame and looks like a tuning problem.
   */
  private writeOne(
    o: Occupant, i: number, R: typeof RACCOON, hover: number, camera?: THREE.Camera,
  ): void {
    const j = o.joints
    const release = o.release.value

    this.skulls.setMatrix(i, j.head.world)
    this.masks.setMatrix(i, j.head.world)
    this.blazes.setMatrix(i, j.head.world)
    this.muzzles.setMatrix(i, j.head.world)
    this.noses.setMatrix(i, j.head.world)
    // Zero scale on the passenger. `setMatrix` post-multiplies, so a zero scale
    // collapses every vertex to a point and the instance draws nothing.
    this.s.set(1, 1, 1).multiplyScalar(o.driving ? 1 : 0)
    this.grins.setMatrix(i, j.head.world, this.s)
    this.tongues.setMatrix(i, j.head.world, this.s)
    this.bodies.setMatrix(i, j.spine.world)
    this.bibs.setMatrix(i, j.spine.world)

    for (let e = 0; e < 2; e++) {
      const ear = e === 0 ? j.earL : j.earR
      this.earsOuter.setMatrix(i * 2 + e, ear.world)
      this.earsInner.setMatrix(i * 2 + e, ear.world)
      const eye = e === 0 ? j.eyeL : j.eyeR
      const side = e === 0 ? -1 : 1
      // The lid closes the eye by squashing it about its own vertical, which on
      // an orb with a hard rim reads as a blink at any distance. `setMatrix`
      // post-multiplies, so this is the eye's own axis and not the world's — see
      // the note there.
      this.s.set(1, 1 - o.lid.value * 0.92, 1)
      this.scleras.setMatrix(i * 2 + e, eye.world, this.s)
      // The iris rides FORWARD off the eyeball's centre and INBOARD, so the cream
      // shows on the outer side. Both take the same squash: a blink that shut the
      // pale ball and left the pupil floating would be worse than no blink.
      this.m.copy(eye.world).multiply(this.offsetM.makeTranslation(
        -side * R.eye * R.irisIn, 0, -R.eye * R.irisOut,
      ))
      this.eyeballs.setMatrix(i * 2 + e, this.m, this.s)
    }

    // ── the arms ───────────────────────────────────────────────────────────
    // Two targets an animal, in the body's frame. The driver takes the wheel's
    // rim at nine and three o'clock (which the helm's own rotation carries
    // round, so the paws travel with the steer); the passenger hooks both paws
    // over the near rim of the box, which is exactly what the reference's
    // second raccoon does.
    for (let a = 0; a < 2; a++) {
      const side = a === 0 ? -1 : 1
      const shoulder = a === 0 ? j.shoulderL : j.shoulderR
      const elbow = a === 0 ? j.elbowL : j.elbowR
      const paw = a === 0 ? j.pawL : j.pawR
      if (o.driving) {
        // On the rim, `grip` radians either side of its TOP, carried round by the
        // helm's own rotation so the paws travel with the steer.
        const ang = side * HELM.grip + this.helm.rotation.z
        const rr = HELM.radius + HELM.thickness * 0.4
        const rx = Math.sin(ang) * rr
        const ry = Math.cos(ang) * rr
        // Rake the point into the helm's tilted plane.
        this.target.set(
          -SEAT.x + rx,
          HELM.y + ry * Math.cos(HELM.rake),
          HELM.z - ry * Math.sin(HELM.rake),
        )
      } else {
        this.target.set(
          SEAT.x * o.side + side * BOX.w * 0.19,
          RIM_Y + 0.02,
          -BOX.d * 0.5 + 0.16,
        )
      }
      // Released, the paws go up and out — the zero-g splay. Blended rather
      // than switched, so a short hop only lifts them a little.
      if (release > 0.001) {
        // THE SPLAY TARGET IS RELATIVE TO THE SHOULDER, not to the box, and that
        // is the second version of this. The first was a fixed point in body
        // space, and once `HOVER.rise` went to 0.90 m the shoulders rose ABOVE it,
        // so at full hover both animals were reaching down and back for a spot
        // over the rim — a grab for the box, not a splay. Anchoring it to the
        // shoulder also makes it REACHABLE by construction: the offset is 0.446 m
        // against a 0.48 m arm, so the pose is a held splay rather than a chain
        // clamped at full extension aiming at something it cannot touch. Those
        // two look different — an extended arm is dead straight and an
        // almost-extended one still has an elbow in it.
        shoulder.worldPosition(this.p)
        this.p.x += side * 0.36
        this.p.y += 0.28
        this.p.z -= 0.12
        this.target.lerp(this.p, release)
      }
      this.pawTargets[i * 2 + a]!.copy(this.target)
      this.aimArm(shoulder, elbow, paw, this.target, side)
      const limbBase = (i * 2 + a) * 2
      this.limbs.setMatrix(limbBase, shoulder.world, this.s.set(1, R.upperArm, 1))
      this.limbs.setMatrix(limbBase + 1, elbow.world, this.s.set(1, R.foreArm, 1))
      this.paws.setMatrix(i * 2 + a, paw.world)
    }

    // ── the tail ───────────────────────────────────────────────────────────
    // Even segments in fur, odd in near-black, tapering to the tip.
    let furSlot = i * 3
    let ringSlot = i * 2
    for (let s = 0; s < j.tail.length; s++) {
      // `tailProfile`, not a lerp — a bushy tail holds its thickness and pinches
      // at the end, and a linear narrowing is an arm. See raccoon.ts.
      const k = tailProfile(s / (j.tail.length - 1))
      this.s.set(k, k, 1)
      if (s % 2 === 0) this.tailFur.setMatrix(furSlot++, j.tail[s]!.world, this.s)
      else this.tailRing.setMatrix(ringSlot++, j.tail[s]!.world, this.s)
    }

    // ── the "!" ────────────────────────────────────────────────────────────
    this.writeAlert(o, i, camera)
  }

  /**
   * A two-bone IK, solved by law of cosines, writing the shoulder's swing and
   * the elbow's bend.
   *
   * `side` biases which way the elbow breaks — outward, away from the body,
   * because an elbow that folds inward puts a forearm through a torso and the
   * only cue that something is wrong is a forearm that has gone missing.
   *
   * Solved in the SHOULDER'S PARENT frame rather than in world space: the chest
   * is already leaning and breathing, and a target expressed in the chest's
   * frame is automatically carried by both. Both joints are then re-solved so
   * the paw and the two bone matrices are current this frame.
   */
  private aimArm(
    shoulder: Joint,
    elbow: Joint,
    paw: Joint,
    worldTarget: THREE.Vector3,
    side: number,
  ): void {
    const R = RACCOON
    // Into the shoulder's own space. `shoulder.world` includes the shoulder's
    // rest offset, so the target arrives relative to the joint itself.
    this.m.copy(shoulder.world).invert()
    this.p.copy(worldTarget).applyMatrix4(this.m)
    const dist = this.p.length()
    const l1 = R.upperArm
    const l2 = R.foreArm
    // Never let the arm reach exactly straight: at full extension the elbow's
    // bend is 0 and its axis is undefined, so the forearm's roll jitters. 0.995
    // keeps a degree of bend in.
    const d = clamp(dist, Math.abs(l1 - l2) + 1e-3, (l1 + l2) * 0.995)
    // Direction to the target, as a yaw about +Y and a pitch off -Y (the rest
    // pose points straight down).
    //
    // THE NEGATIONS ARE THE WHOLE SOLUTION AND THEY WERE MISSING. Derive it: with
    // Euler order 'YXZ' the composition is Ry(yaw) * Rx(pitch), and the rest bone
    // is (0, -L, 0). Rx(p) takes it to (0, -L cos p, -L sin p); Ry(y) then takes
    // that to (-L sin p sin y, -L cos p, -L sin p cos y). Matching that against a
    // target direction (dx, dy, dz) gives sin y = -dx / sin p and
    // cos y = -dz / sin p, i.e. `atan2(-dx, -dz)` — which is `atan2(dx, dz)` plus
    // pi. `atan2(dx, dz)` therefore swung every arm to the OPPOSITE side of the
    // body, and because the layout is symmetric all four paws missed by exactly
    // the same 0.587 m. That identical figure across two animals and two arms is
    // what named the bug: a reach failure varies with the target, a frame error
    // does not.
    const yaw = Math.atan2(-this.p.x, -this.p.z)
    const pitch = Math.atan2(Math.hypot(this.p.x, this.p.z), -this.p.y)
    // Law of cosines: the angle between the upper arm and the line to the
    // target, and the interior angle at the elbow.
    const cosA = clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1)
    const cosB = clamp((l1 * l1 + l2 * l2 - d * d) / (2 * l1 * l2), -1, 1)
    const a = Math.acos(cosA)
    const bend = Math.PI - Math.acos(cosB)
    // 'YXZ' on a chain that hangs down -Y: yaw turns the plane and X is the swing
    // out of vertical. THERE IS NO THIRD DEGREE OF FREEDOM HERE, and the `side *
    // 0.22` that used to sit in the Z slot was a misunderstanding of the
    // composition rather than a tuning value. With order 'YXZ' the Z rotation is
    // applied INNERMOST, so it turns the bone in its own XY plane BEFORE the aim —
    // it does not choose which way the elbow breaks, it moves the whole chain off
    // target, and it was 0.10 m of the residual paw miss on its own. A real
    // elbow-pole needs a roll about the shoulder-to-target AXIS, which is an outer
    // rotation and cannot be expressed as a term in this Euler at all. The bend
    // plane is fully determined by (yaw, pitch); to bias which way an elbow goes,
    // move the paw TARGET, not the joint.
    shoulder.rotation.set(pitch - a, yaw, 0)
    elbow.rotation.set(bend, 0, 0)
    shoulder.solve()
    elbow.solve()
    paw.solve()
  }

  /**
   * The cartoon red "!", one per raccoon, popped while falling.
   *
   * THE TRIGGER IS FALLING, NOT AIRBORNE. `airtime` alone would put an
   * exclamation mark over a car that has merely left a kerb, and worse, it would
   * put one up on the way UP a jump — which is the moment the pair are having
   * fun, not the moment they are alarmed. So it needs downward velocity as well:
   * `vy < -2.4 m/s` and off the ground. A launch therefore reads as hover with no
   * glyph, and the glyph arrives at the apex when the fall starts, which is
   * exactly the comic beat.
   *
   * It is a BILLBOARD. It faces the camera by construction — the glyph's own
   * rotation is thrown away and replaced by the camera's, which is the only
   * correct thing for a 2D graphic and the reason `camera` had to be plumbed
   * through `update`. Yaw-only would have been cheaper and is wrong: the chase
   * camera on a jump is well below the kart looking up, and a yaw-only glyph
   * foreshortens into a red smear at exactly the moment it is needed.
   *
   * The two raccoons' glyphs are at different heights and out of phase, because
   * two identical exclamation marks popping in unison read as a UI element and
   * one leading the other by a beat reads as two animals noticing.
   */
  private writeAlert(o: Occupant, i: number, camera?: THREE.Camera): void {
    const j = o.joints
    const scale = o.alert.value
    if (scale < 0.01 || !camera) {
      // Scale zero rather than skipping the write: an instance left at last
      // frame's matrix stays on screen. `setMatrix` with a zero scale collapses
      // every vertex to a point and the batch draws nothing visible.
      this.s.set(0, 0, 0)
      this.alerts.setMatrix(i, this.m.identity(), this.s)
      this.alertInk.setMatrix(i, this.m, this.s)
      return
    }
    j.head.worldPosition(this.p)
    // OUT AND UP, and staggered on BOTH axes. The two glyphs used to sit 67 px
    // apart at the same height overlapping the crew, and the second one's dot was
    // occluded by the first animal's head — so one of the pair showed a bar with
    // no dot, which is not a legible exclamation mark. Pushing them apart
    // laterally and giving the far one extra height clears both.
    this.p.y += 0.44 + (o.side > 0 ? 0.1 : 0)
    this.p.x += o.side * 0.34
    this.p.z -= 0.1
    // Wobble: a comic exclamation is never still. Small, and on the ROLL only,
    // so the glyph stays upright and legible.
    const wob = Math.sin(o.alertAge * 17) * 0.14 * Math.exp(-o.alertAge * 1.6)
    camera.getWorldPosition(this.camWorld)
    this.body.worldToLocal(this.camWorld)
    // Look from the glyph toward the camera, both in the body's frame.
    this.m.lookAt(this.p, this.camWorld, UP)
    this.q.setFromRotationMatrix(this.m)
    this.q.multiply(this.rollQ.setFromAxisAngle(GLYPH_NORMAL, wob))
    // `easeOutBack` on the spring's own value: the spring gives the timing and
    // the ease gives the overshoot a comic pop needs, which a spring alone
    // cannot because a spring that overshoots this hard also rings.
    const k = 1 + 0.34 * Math.sin(Math.PI * saturate(scale))
    this.s.set(k, k, k).multiplyScalar(saturate(scale))
    this.m.compose(this.p, this.q, this.s)
    this.alerts.setMatrix(i, this.m)
    this.alertInk.setMatrix(i, this.m)
  }

  private poseWheels(vehicle: Vehicle): void {
    for (let i = 0; i < vehicle.wheels.length; i++) {
      const w = vehicle.wheels[i]!
      this.p.set(w.anchor.x, -w.hubDrop, w.anchor.z)
      this.wheels.set(i, this.p, w.spin, w.steerAngle, 0)
      this.hubs.set(i, this.p, w.spin, w.steerAngle, 0)
      // From the chassis mount down to the hub. Tucked inboard of the tyre so
      // it never intersects the tread, and it does NOT steer with the wheel —
      // a trailing arm does not.
      this.p.set(w.anchor.x * 0.62, 0.16, w.anchor.z * 0.86)
      this.struts.set(i, this.p, 0, 0, 0, this.s.set(1, w.hubDrop + 0.16, 1))
    }
    this.wheels.flush()
    this.hubs.flush()
    this.struts.flush()
  }
}

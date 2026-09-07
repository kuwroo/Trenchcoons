// The raccoon: geometry, and the rig that gives it life.
//
// Everything here is measured against the reference sheet
// `refs/character/raccoon-boxkart-sheet.png` — four views of two raccoons in a
// FRAGILE box on wheels. Read that image before changing a number here; the
// notes below quote it constantly because almost every choice in this file is a
// reading of it rather than a preference.
//
// WHY THIS FILE EXISTS AT ALL. The occupants used to be five scaled spheres
// composed by hand in kart.ts — a head, an equatorial "mask" band, a muzzle,
// two ears and two eyes — with the child parts' positions computed by writing
// out `Ry * Rx` longhand for each one. Three things were wrong with that and
// only the first is cosmetic:
//
//   1. IT WAS NOT A RACCOON. A band round the skull's equator is not a mask.
//      The reference's face is a THREE-VALUE SANDWICH — a cream blaze above
//      each eye, a dark almond patch over it, a cream muzzle below — plus a
//      dark stripe down the forehead centre and a cream-tufted cheek ruff.
//      Take any one of those away and you have a small brown animal. The band
//      was the only one of the five present, and it was the wrong shape.
//   2. THE HAND-COMPOSED TRANSFORM DOES NOT NEST. `local()` in kart.ts applied
//      exactly one rotation pair, from the head. So an ear could ride the head
//      and nothing could ride the ear: no ear flick, no tail with a chain in
//      it, no arm whose paw stays on the wheel while the shoulder leans. Every
//      motion the milestone asks for past "the head turns" needs two levels.
//   3. IT COULD NOT BE POSED OFF THE BOX. The paws grip a rim and a steering
//      wheel that are authored in KART space, and the raccoon is authored in
//      its own; without a joint chain there is no frame to convert between.
//
// So there is a rig — `Rig` and `Joint` below, twelve joints an animal, solved
// parent-before-child in one flat pass. It is thirty lines and it is not a
// scene graph: joints write their world matrix straight into an instanced batch
// (`PosedInstances.setMatrix`), so the whole two-raccoon crew is still ~13 draw
// calls and Three never walks a hierarchy for it. The kart is drawn five times
// a frame — once for the frame, once per shadow cascade — so that matters.
//
// THE FACE MARKINGS ARE SPHERICAL CAPS OF THE SKULL'S OWN SPHERE, inflated
// 1.5%. That is the one technique that makes this file possible and it is worth
// stating plainly, because the obvious alternative fails: a flattened sphere
// used as a "patch" is a lens that intersects the skull, so it floats proud at
// its centre and disappears into the surface at its edge — which is what made
// the v1 mask survive as a crescent on one cheek and nothing on the other. A
// cap built at the skull's radius CANNOT do that; it conforms exactly,
// everywhere, at every angle, and its silhouette is whatever outline you hand
// it. `spherePatch` takes an outline in tangent angles and projects it, so an
// almond eye patch, a tapering forehead stripe and a curved brow blaze are all
// the same twelve lines of code.

import * as THREE from 'three/webgpu'
import { MeshBuilder, loft, normalize, ring, transformRing } from '../assets/mesh'
import type { Vec3 } from '../assets/mesh'
import { mergeGeometries, place } from './geometry'

/**
 * Raccoon dimensions, RACCOON-LOCAL metres. The origin is the SEAT — where the
 * animal's weight rests on the box floor — with +Y up and -Z forward, matching
 * the kart (the car drives toward -z).
 *
 * The proportions are taken off the front view of the reference by ratio to the
 * box, which is the only measurement a flat concept sheet can give: the driver's
 * head spans a third of the box's width, so at BOX.w 1.72 the skull is 0.58 m
 * across and `skull` is 0.29. That happens to be exactly what the old sphere
 * head used, which is the one thing the previous pass had right.
 */
export const RACCOON = {
  /**
   * Skull radius. The unit every face marking is measured in.
   *
   * 0.335, up from 0.29. Measured against the sheet's front view, its head and
   * ears occupy about 48% of the animal's total height and the build's occupied
   * 38% — the head was not too NARROW (the cranium was already 0.84 of the body's
   * width against the sheet's 0.72) but too SMALL. Everything on the face scales
   * with this, because every marking is authored in tangent angles on a sphere of
   * this radius, so the whole head grows in proportion for one number.
   *
   * The ruff's widest band ends up at 0.50 m of half-width, which at a seat of
   * +/-0.37 would breach the box's 0.785 m interior — except that band sits at
   * 1.18 m, a quarter of a metre above the 0.93 m rim, where there is no wall.
   */
  skull: 0.335,
  /** Skull is wider than deep and slightly squat — the reference head is a
   *  broad trapezoid with the cheeks flaring OUT past the ears. */
  skullScale: new THREE.Vector3(1.1, 0.94, 0.98),
  /** Torso radius. The reference's bodies are ~1.25x the head across, which at
   *  two abreast in a 1.57 m interior is as much as will fit — the top-down view
   *  shows them genuinely squeezed, so the crowding is on-model. */
  body: 0.35,
  /**
   * Joint heights ABOVE THE SEAT, absolute rather than chained off `body`.
   *
   * They used to be ratios of the torso radius — `body * 0.55` then `body * 0.72`
   * then `neckHeight - body * 1.27` — and the first capture showed exactly what
   * is wrong with that: the sum came to 0.98, the box rim is 0.985 above the
   * floor, and so the head's CENTRE landed on the rim and the pair were two sets
   * of ears in a box. The error was invisible in the source, because no single
   * ratio was wrong; only the total was, and the total was nowhere written down.
   *
   * These are now measured against the box's own rim, which is the thing the
   * reference actually composes against: the shoulders come up TO the rim and
   * the whole head is clear above it. Anything that changes `BOX.h` has to come
   * back here, and that is the right coupling to make visible.
   */
  spineY: 0.22,
  chestY: 0.62,
  /**
   * Seat-to-head-CENTRE.
   *
   * 1.42 puts the head's underside 0.16 m clear of the box rim, which is what
   * the reference's front view has: chest fur ON the rim line, the whole head
   * above it. 1.30 was one revision too timid — it left the chin exactly at the
   * rim, so the jaw and the mouth line were cut off by the box in every frame
   * and the pair read as peering over it rather than sitting in it.
   */
  neckHeight: 1.42,
  /**
   * Ear base radius, and its height as a multiple of that.
   *
   * 0.150, up from 0.115, and SET WIDER (`earOut` 1.02). The profile
   * measurement is what forced it: at the top four rows of the front silhouette
   * the sheet is 0.76-0.84 of its widest and the build was 0.40-0.62, because up
   * there the sheet's width is set by its EARS and the build's ears did not
   * reach the skull's own edge, let alone past it. An ear rooted inside the
   * silhouette contributes nothing to it.
   *
   * WIDE AND SHORT, which is not the instinct. The reference's ear is a rounded
   * triangle about 0.42 of the head's width at the base and only 0.30 of its
   * height tall — so 0.115 and 1.55. The first pass used 0.125 at 2.05, which is
   * a 0.26 m spike on a 0.55 m head, and the pair came out as rabbits. An ear
   * that is taller than it is wide belongs to a different animal, and the read
   * is immediate at any distance because it is a silhouette property.
   */
  ear: 0.150,
  earAspect: 1.55,
  /** Ear yaw out from straight ahead, and its tilt off vertical. The reference's
   *  ears are set WIDE and canted outward about 25 degrees. */
  /**
   * Ear yaw out from straight ahead, and its tilt off vertical.
   *
   * BOTH REDUCED. The ear is 0.23 m wide on a 0.638 m head — 36% of the head's
   * width, which is the reference's own 30-35% — and it was still being read as a
   * narrow nub, because at 0.86 of yaw and 0.42 of cant the ear presents its
   * EDGE to a camera in front of the animal and foreshortens to about a third of
   * its width. The number that matters for the read is the projected width, not
   * the modelled one.
   */
  earYaw: 0.62,
  /*
   * 0.44, up from 0.30, which is the 25 degrees the comment above has claimed
   * the reference sets all along — it was only ever unreachable because the cant
   * was applied with the wrong SIGN and leaned the ears inboard, so every
   * increase made the V over the crown deeper. With the sign fixed the magnitude
   * is worth having: the front row profile's top row is the two ear TIPS, the
   * sheet puts them at 0.82 of its widest and the build read 0.60.
   */
  earTilt: 0.44,
  /** How far out along the skull the ear roots sit, and how high. The reference
   *  sets them near the head's outer EDGE, not on top of it. */
  /*
   * 1.29, out from 1.02, and solved rather than dialled.
   *
   * `onSkull` does NOT project onto the sphere — it only applies `skullScale`
   * and the taper — so this is a direct lateral multiplier on the root, which
   * currently lands at x 0.1606. Aligning the front silhouette on the two
   * landmarks both subjects unambiguously share (the ear TIP and the cheek
   * ruff's widest point, so the map is anchored at both ends of this span rather
   * than resting on the disputed chin fraction) the ear reads:
   *
   *   y      1.573  1.644  1.714  1.785
   *   sheet  0.326  0.343  0.346  0.339
   *   build  0.296  0.308  0.305  0.276
   *   delta  -0.030 -0.035 -0.042 -0.063
   *
   * Mean -0.042, so 1.02 * (1 + 0.042/0.1606) = 1.29. The deficit GROWS toward
   * the tip, so a constant outward shift leaves a residual there — that is the
   * tilt's job and is deliberately not touched in the same change.
   *
   * NOTE WHAT THIS SUPERSEDES. The raw row table read rows 5-6 as 0.13-0.14
   * NARROW and the cranium as the fault; aligned on the landmarks the cranium is
   * 0.019-0.027 WIDE and the whole deficit is the ears. The rows are skewed even
   * inside the head, because this model is a bust — see `raccoon-profile.mjs`.
   */
  earOut: 1.29,
  earUp: 0.6,
  /**
   * How far the muzzle projects past the skull, as a fraction of the radius.
   *
   * 0.32 puts the tip 0.107 m ahead of the skull's surface.
   *
   * A modeller review asked for 0.30-0.35 of HEAD DEPTH and I read that as 0.55
   * of the radius, which rendered as a proboscis — a pale dome covering the whole
   * lower face. The two are not the same measurement: head depth is 0.657 m, so
   * 0.32 of the radius is already 0.16 of the depth measured from the eye plane
   * rather than from the surface, and the surface is most of the way forward
   * already. **Check which datum a ratio is measured from before dialling it.** The front view cannot see this number at all
   * and two previous versions were set without it.
   */
  muzzleReach: 0.32,
  /**
   * Muzzle radius, kept as the unit `nose` is measured against.
   *
   * It was 0.135 for one capture, i.e. 0.31 m across — HALF the head's width —
   * and it did not read as a big muzzle, it read as a cream wedge sticking out
   * sideways past the mask. That is the failure mode of every over-scaled
   * feature on a spherical head: past about a third of the head's width a
   * projecting form stops reading as part of the face and starts reading as an
   * object attached to it.
   */
  muzzle: 0.095,
  /**
   * Nose radius.
   *
   * 0.030, and the constraint is the SNOUT, not the face: at 0.046 scaled 1.15
   * in x the nose was 0.106 m across while the muzzle's tip is 0.046 m across,
   * so the nose was more than twice the width of the thing it sits on and read
   * as a wart on the end of a cone. It is placed at 0.86 along the snout rather
   * than 0.94 for the same reason — further back the muzzle is wide enough to
   * carry it.
   */
  nose: 0.03,
  /**
   * Eye orb radius.
   *
   * MEASURED OFF THE REFERENCE, which draws the eye 32 x 33 px on a 286 px head
   * — CIRCULAR, and 0.112 of the head's width. The build's assembly was 0.195 of
   * the head at an aspect of 1.32, because a 1.1x sclera translated sideways by
   * 0.3 of the eye radius makes the pair 0.125 m wide on a 0.638 m skull. So it
   * was both half again too big AND an oval, and the offset pushed the pupil
   * inboard, which is why both animals read cross-eyed. At 0.030 with a
   * concentric 1.3x sclera the assembly is 0.078 m — 0.122 of the head.
   */
  eye: 0.03,
  /**
   * The IRIS radius, as a multiple of the eyeball, and how far forward it sits.
   *
   * THE EYEBALL IS THE CREAM ONE. That inversion is the fix for a genuinely
   * embarrassing error: the previous pass made a cream sclera CONCENTRIC with a
   * dark orb and 1.3x its radius, on the reasoning that a ring of cream round a
   * dark iris is what the reference draws. A larger concentric sphere occludes
   * the smaller one from every direction — that is what "larger and concentric"
   * means — so the render came back with two pairs of small cream beads and no
   * pupils at all. The reference's construction is the other way round: a pale
   * eyeball with a dark iris sitting ON its front, offset INBOARD so the cream
   * shows on the outer side, which is also what makes both animals look like
   * they are looking at something.
   */
  /**
   * Iris radius as a multiple of the eyeball. 0.82, up from 0.72 — at 0.72 the
   * pale ball dominated and the pair read googly. The reference's eye is mostly
   * iris with the cream showing as a crescent, not a ring.
   */
  iris: 0.82,
  irisOut: 0.55,
  /** How far inboard the iris sits. 0.18 — at 0.30 both animals were cross-eyed. */
  irisIn: 0.18,
  /**
   * Where the eye's CENTRE sits, as a fraction of the skull's radius.
   *
   * 0.89. There is a window about 0.06 wide here and both walls of it are real,
   * which is why the number is measured by `tools/raccoon.mjs` rather than
   * eyeballed:
   *
   *   0.80  the orb is ENTIRELY INSIDE THE SKULL. It stands -0.006 m — six
   *         millimetres under the surface — so there is no eye on screen at all,
   *         and that is what shipped for three capture rounds. A missing eye
   *         reads as a shading problem on the mask, so all three rounds were
   *         spent on the mask.
   *   0.95+ half of a 0.104 m ball stands proud and the pair have goggles on.
   *   0.89  stands 0.020 m — correct for the 0.052 m orb it was solved for.
   *
   * 0.945 now, RE-SOLVED because the orb shrank to 0.030 m. That is the point of
   * keeping this measured: the sink and the radius are not independent, and
   * halving the eye put it back under the surface by 0.032 m — silently, and with
   * exactly the symptom the 0.80 version had. `tools/raccoon.mjs` caught it in the
   * same run that made the change.
   */
  eyeSink: 0.945,
  /** Shoulder half-width, as a fraction of the torso radius. */
  shoulder: 0.78,
  /**
   * Arm bones. Total reach 0.48 m, and it is set by what the animal has to HOLD
   * rather than by anatomy: from the shoulder at (x +/-0.273 of the seat, y 0.725,
   * z -0.89) the furthest target is the steering wheel's grip at 0.456 m, so
   * 0.42 m of arm could not reach anything on the vehicle. See `SEAT` in kart.ts
   * for how that went unnoticed.
   */
  upperArm: 0.23,
  foreArm: 0.25,
  /**
   * Paw radius. 0.056, down from 0.072.
   *
   * At 0.072 with four 0.024 m digits the paw was 0.16 m across on a 0.64 m
   * head — a quarter of the head — and it read as a boxing glove. 0.065 rather
   * than 0.056 because the limb's own taper had to be relaxed (see
   * `limbGeometry`) and the wrist must stay narrower than the paw on it. The reference
   * draws the paws SMALL and near-black: two of them side by side on the box rim
   * are together about as wide as one eye patch. The digits are what makes a paw
   * read as a hand, and they only need to break the silhouette, not to be
   * countable.
   */
  paw: 0.065,
  /** Tail: five segments, tapering, ringed. Five is the count in the top-down
   *  view and it is also the fewest that gives three pale bands and two dark
   *  ones, which is what makes a tail read as a RACCOON's tail rather than as a
   *  tail. Fewer and it is a sausage; more and the rings alias at chase
   *  distance. */
  /**
   * SEVEN, up from five. Five gives three pale bands and two dark ones, which is
   * the minimum that reads as ringed — and "minimum that reads" turned out not
   * to be enough: FIVE separate observers looking at the gameplay frame failed to
   * identify these as tails, calling them variously a raised arm with a cuff, a
   * pale banded prop, and (twice) nothing at all. The tails ARE present and
   * banded, confirmed each time by flagging `furDark` magenta, so every one of
   * those claims was wrong — but five independent failures to read a feature is
   * data about the feature, not about the observers. Seven segments gives four
   * pale and three dark, and the segment length and curl per joint come down
   * together so the tail's total length and arc are unchanged.
   */
  tailSegments: 7,
  tailRadius: 0.185,
  /**
   * Tip radius as a fraction of the root, and the PROFILE matters more than the
   * number — see `tailProfile`.
   */
  tailTaper: 0.5,
  tailSegLength: 0.17,
  /**
   * Curl per tail joint, radians, negative being UP.
   *
   * 0.40 over four joints is 1.52 rad total, and it is solved against the
   * CHASE CAMERA rather than against the rim.
   *
   * At 0.55 the total was 2.2 rad, which arcs the tip up and then back FORWARD
   * over the animal's own shoulders — where it lands inside the shoulder mass
   * and is occluded by the body it belongs to. That is the whole reason the
   * tails were only ever visible in the mid-air capture. At 0.40, with the base
   * moved to the body's rear surface and the segments lengthened to 0.25 m, the
   * chain leans BACK as it rises: the tip lands at y 1.17 and z +0.11, which is
   * 0.24 m clear of the rim and 0.59 m behind the torso's rear surface. Nothing
   * occludes it from a camera sitting behind the kart, which is the camera the
   * player looks through for the entire game.
   *
   * A raccoon's tail is its signature feature after the mask, and until this
   * round the gameplay view contained neither.
   */
  tailCurl: 0.26,
} as const

// ── the rig ─────────────────────────────────────────────────────────────────

/**
 * One joint. Holds a REST offset from its parent plus an animated TRS, and
 * composes them into a world matrix.
 *
 * The split matters: rest is the model's proportions and never changes, pose is
 * what the springs write. Collapsing the two — as the hand-composed version
 * effectively did — means every animation has to re-derive the rest pose, and
 * the first time you get it slightly wrong the ear detaches from the head.
 */
export class Joint {
  readonly world = new THREE.Matrix4()
  /** Animated offset, ADDED to the rest translation, in the parent's frame. */
  readonly offset = new THREE.Vector3()
  /** Animated rotation, in the joint's own frame. 'YXZ' to match the rest of
   *  the vehicle code, where yaw-then-pitch is what every pose reads as. */
  readonly rotation = new THREE.Euler(0, 0, 0, 'YXZ')
  /**
   * The joint's rotation AT REST. `clear()` restores `rotation` to this rather
   * than to zero, so a pose layer writes deltas off the model's own shape.
   *
   * The tail is what forced this and it is worth stating why, because the
   * obvious alternative silently fails. A raccoon's tail is ARCHED OVER ITS OWN
   * BACK — that curl is 2.2 radians spread over four joints and it is part of
   * the animal, not part of any animation. Put it in the pose layer instead and
   * every spring that drives the tail has to add the curl back in on top of
   * whatever it is doing, so the curl becomes a term in five different
   * expressions and the first one that forgets it drops the tail into the box.
   * The ear's outward cant had exactly that bug for one round.
   */
  readonly restRotation = new THREE.Euler(0, 0, 0, 'YXZ')
  readonly scale = new THREE.Vector3(1, 1, 1)

  private readonly rest = new THREE.Vector3()
  private readonly local = new THREE.Matrix4()
  private readonly q = new THREE.Quaternion()
  private readonly t = new THREE.Vector3()

  constructor(readonly parent: Joint | null, x = 0, y = 0, z = 0) {
    this.rest.set(x, y, z)
  }

  /** Back to the rest pose. Called at the top of every frame's pose pass so a
   *  layer that does not write a joint leaves it where the model has it, rather
   *  than wherever last frame's layer left it. */
  clear(): this {
    this.offset.set(0, 0, 0)
    this.rotation.copy(this.restRotation)
    this.scale.set(1, 1, 1)
    return this
  }

  /** Author the rest pose. Chainable off `Rig.add`. */
  atRest(rx: number, ry = 0, rz = 0): this {
    this.restRotation.set(rx, ry, rz)
    this.rotation.copy(this.restRotation)
    return this
  }

  solve(): void {
    this.t.copy(this.rest).add(this.offset)
    this.q.setFromEuler(this.rotation)
    this.local.compose(this.t, this.q, this.scale)
    if (this.parent) this.world.multiplyMatrices(this.parent.world, this.local)
    else this.world.copy(this.local)
  }

  /** World-space position, into `out`. Needed by the paw IK and by the alert
   *  glyph, both of which have to reach across from one chain to another. */
  worldPosition(out: THREE.Vector3): THREE.Vector3 {
    return out.setFromMatrixPosition(this.world)
  }
}

/**
 * A flat, ordered list of joints. Order IS the hierarchy: a joint is only ever
 * added after its parent, so one forward pass solves the whole tree.
 *
 * Deliberately not a `THREE.Object3D` tree. An Object3D chain would give the
 * same matrices and then insist on being rendered, which would put every ear
 * and every tail segment in its own draw call — 24 meshes an animal against a
 * budget that is already spending five draws per mesh on shadow cascades.
 */
export class Rig {
  private readonly joints: Joint[] = []

  add(parent: Joint | null, x = 0, y = 0, z = 0): Joint {
    if (parent && !this.joints.includes(parent)) {
      // Cheap, once at construction, and it catches the one mistake that makes
      // this design fail silently: a child added before its parent solves
      // against last frame's matrix and lags by exactly one frame, which looks
      // like a spring tuning problem and is not one.
      throw new Error('Rig.add: parent must be added before its child')
    }
    const j = new Joint(parent, x, y, z)
    this.joints.push(j)
    return j
  }

  clear(): void {
    for (const j of this.joints) j.clear()
  }

  solve(): void {
    for (const j of this.joints) j.solve()
  }
}

/** Every joint one raccoon has. */
export interface RaccoonJoints {
  /** Sits on the box floor. The hover lifts this. */
  seat: Joint
  spine: Joint
  chest: Joint
  head: Joint
  earL: Joint
  earR: Joint
  eyeL: Joint
  eyeR: Joint
  shoulderL: Joint
  shoulderR: Joint
  elbowL: Joint
  elbowR: Joint
  pawL: Joint
  pawR: Joint
  /** Root-to-tip. `tail[0]` hangs off the spine. */
  tail: Joint[]
}

/**
 * Build one raccoon's joint chain into `rig`.
 *
 * The arm chain is authored STRAIGHT DOWN — shoulder at the top, elbow one
 * upper-arm below it, paw one forearm below that — rather than in a bent rest
 * pose. That is what lets `aimArm` in kart.ts treat it as a plain two-bone IK:
 * the rest pose is the fully-extended one, so the only thing the solver has to
 * find is the swing and the elbow bend, and a rest pose with bend already in it
 * would have to be undone first.
 */
export function buildRaccoonJoints(rig: Rig, side: number): RaccoonJoints {
  const R = RACCOON
  const seat = rig.add(null, 0, 0, 0)
  const spine = rig.add(seat, 0, R.spineY, 0.02)
  const chest = rig.add(spine, 0, R.chestY - R.spineY, -0.03)
  // THE HEAD LEANS OUT OVER THE CHEST. On the sheet the chin leads the chest
  // line by about a third of the head's depth; the build had them stacked on one
  // vertical, which is most of why the head read as bolted on rather than
  // growing out of the shoulders.
  //
  // 0.07, NOT 0.15. At 0.15 the side view had the head hanging off the front of
  // the body with barely a join — and the aspect metric APPROVED it, because a
  // bounding width does not care whether depth comes from a deep body or from a
  // head sticking out the front. That is the one-sided-metric trap this project
  // already documents: read the row profile, which is a shape, not the aspect,
  // which is one number two very different forms can both satisfy. This is a TRANSLATION and not a pitch on
  // purpose — pitching the head forward would tip the face down and cost the
  // front view, and the sheet's head leans while still looking level.
  const head = rig.add(chest, 0, R.neckHeight - R.chestY, -0.07)

  const sk = R.skull
  const ey = Math.sin(R.earTilt)
  // The outward cant is REST DATA — see `Joint.restRotation`. The flick is a
  // delta on top of it.
  // THE CANT'S SIGN WAS INVERTED, so the ears leaned INBOARD for every round the
  // comment above claimed they were "canted outward about 25 degrees". Derived
  // rather than guessed, because this is the fifth sign bug in this project and
  // every previous one was guessed at first:
  //
  //   the ear is lofted along +Y (`earGeometry` pushes [p[0], t * h, ...]), and
  //   Euler order 'YXZ' applies Z INNERMOST, so the length axis is Ry * Rz * +Y.
  //   For the RIGHT ear at atRest(0, +0.31, +0.3):
  //     Rz(+0.3) * (0,1,0) = (-0.296, 0.955, 0)          <- already -x
  //     Ry(+0.31) * that   = (-0.281, 0.955, 0.090)      <- still -x, INBOARD
  //
  // Over the ear's 0.2325 m that is 0.065 m of inboard lean, and it is measurable
  // on the export: the right ear's outer edge peaks at x 0.297 mid-ear and falls
  // to 0.099 at the tip. The front row profile is what made it matter — row 0 read
  // 0.43 of the widest against the sheet's 0.82, because the topmost slice of this
  // silhouette is the two ear TIPS and the sheet sets them near its outer edge
  // while ours converged toward the crown. A V-notch between two inward-leaning
  // ears is a cat.
  //
  // Negating Z per side sends both outboard: for the right ear Rz(-0.3) gives
  // (+0.296, 0.955, 0) and Ry(+0.31) holds it at +0.281; the left mirrors.
  // `ey` is deliberately NOT negated — it is a small shared forward offset for
  // the root, not a per-side cant.
  const earL = rig.add(head, ...onSkull(
    -Math.sin(R.earYaw) * sk * R.earOut, sk * R.earUp, ey * sk * 0.06,
  )).atRest(0, -R.earYaw * 0.5, R.earTilt)
  const earR = rig.add(head, ...onSkull(
    Math.sin(R.earYaw) * sk * R.earOut, sk * R.earUp, ey * sk * 0.06,
  )).atRest(0, R.earYaw * 0.5, -R.earTilt)
  // Eyes are their own joints so the blink can squash them without squashing
  // the mask patch they sit in — the reference's eye is a hard orb INSIDE a soft
  // patch, and a blink that closed both would read as the whole face pinching.
  // Direction matches the mask patch's own centre (u = 0.44 rad) so the orb
  // lands inside the patch by construction rather than by two numbers agreeing
  // by luck; `eyeSink` then sets how deep in the socket it sits.
  const eyeDir = 0.44
  const eyeUp = Math.sin(0.1) * R.eyeSink
  const eyeSpread = Math.sin(eyeDir) * Math.cos(0.1) * R.eyeSink
  const eyeFwd = -Math.cos(eyeDir) * Math.cos(0.1) * R.eyeSink
  const eyeL = rig.add(head, ...onSkull(-eyeSpread * sk, eyeUp * sk, eyeFwd * sk))
  const eyeR = rig.add(head, ...onSkull(eyeSpread * sk, eyeUp * sk, eyeFwd * sk))

  const sx = R.body * R.shoulder
  const shoulderL = rig.add(chest, -sx, 0.16, -0.06)
  const shoulderR = rig.add(chest, sx, 0.16, -0.06)
  const elbowL = rig.add(shoulderL, 0, -R.upperArm, 0)
  const elbowR = rig.add(shoulderR, 0, -R.upperArm, 0)
  const pawL = rig.add(elbowL, 0, -R.foreArm, 0)
  const pawR = rig.add(elbowR, 0, -R.foreArm, 0)

  // The tail leaves the back of the spine and is steered OUTBOARD by `side`, so
  // in a two-abreast box the two tails curl away from each other instead of
  // through each other. The top-down view has exactly this: both tails swept to
  // the outside of their own animal.
  const tail: Joint[] = []
  // The base sits HIGH on the rump and BEHIND the torso, and both of those were
  // corrections. Low and forward, the arc passed through the body by 0.02 m —
  // the sort of margin that reads as an intersection on exactly the frames where
  // it is lit — and, worse, the whole tail then sat inside the trenchcoat's cone,
  // which is single-sided and drew over it. The tail was in the scene, correctly
  // posed, and in no frame the game shows. Behind the torso and 0.36 m up, the
  // 2.2 rad curl carries the tip to 1.03 m against a rim at 0.985, so it breaks
  // the silhouette from the chase camera, which is the only place it can be
  // seen from.
  let parent = rig.add(spine, side * R.body * 0.5, R.body * 0.75, R.body * 1.15)
    .atRest(-R.tailCurl, side * 0.1, 0)
  tail.push(parent)
  for (let i = 1; i < R.tailSegments; i++) {
    // THE OUTWARD SPLAY IS ON THE UPPER SEGMENTS ONLY, and that is a constraint
    // rather than a stylistic choice. The tail has to end up OUTBOARD of the
    // body to break the silhouette — arcing straight up behind the shoulders it
    // is hidden by them from every ground camera, which is what shipped: the
    // tails were only ever visible in the mid-air capture, and a raccoon's tail
    // that is invisible while driving is not doing its job. But the lower
    // segments are still inside the box, whose interior half-width is 0.785 m
    // against a tail base already at 0.545, so they cannot splay without going
    // through the wall. Segments 2 and up sit above the 0.93 m rim, where there
    // is no wall left to hit.
    // THE OUTWARD SPLAY IS ONLY ON THE SEGMENTS THAT HAVE CLEARED THE RIM, and
    // the threshold moved from 2 to 3 because the old one put the tail THROUGH
    // the box. Summed, 0.3 at the base plus 0.24 a joint from segment 2 gives
    // 0.64 m of lateral travel on a base already 0.545 m out — a tip at x 1.19
    // against an outer wall at 0.86, with segments 2 and 3 crossing the board on
    // the way. Flagging `furDark` magenta and re-rendering is what identified
    // the two banded shapes floating outside the box as the tails themselves.
    //
    // THE TOP TWO SEGMENTS CARRY THE SPLAY, expressed as `tailSegments - 2`
    // rather than as the literal 3 it used to be. Those are the ones above the
    // 0.93 m rim, where there is no wall left to cross; everything below is held
    // nearly straight so it stays inside the 0.785 m interior.
    //
    // The literal was tuned when the tail had five segments and silently became
    // wrong at seven — four segments then took the outward yaw instead of two, so
    // the chain turned sideways instead of upward and the tip dropped from 1.25 m
    // to 1.04. Second time in two rounds that a constant tuned against
    // `tailSegments` outlived the count; the batch sizes in kart.ts were the
    // first. ANY number derived from the segment count has to be written as a
    // function of it.
    //
    // 0.52 ON THOSE TWO, up from 0.30, so the tail is seen SIDE-ON from behind.
    // At 0.30 it points nearly away from a camera sitting behind the kart, and a
    // foreshortened ringed tail does not read as a tail — a critic judging the
    // gameplay frame took it for a raised arm with a sleeve and a cuff, which is
    // exactly what a row of alternating light and dark segments looks like when
    // its length is compressed to nothing. Turning it across the view is what
    // makes the rings read as rings.
    parent = rig.add(parent, 0, 0, R.tailSegLength)
      .atRest(-R.tailCurl, side * (i >= R.tailSegments - 2 ? 0.52 : 0.05), 0)
    tail.push(parent)
  }

  return {
    seat, spine, chest, head, earL, earR, eyeL, eyeR,
    shoulderL, shoulderR, elbowL, elbowR, pawL, pawR, tail,
  }
}

// ── spherical caps: the face markings ───────────────────────────────────────

/**
 * A direction on the skull, from tangent angles.
 *
 * `u` is yaw from straight ahead (-Z), positive toward +X; `v` is elevation.
 * So (0, 0) is the tip of the nose's direction and (0, pi/2) is the top of the
 * head, which makes every outline below readable as "so many degrees off the
 * front of the face".
 */
function dirAt(u: number, v: number): Vec3 {
  const cv = Math.cos(v)
  return [Math.sin(u) * cv, Math.sin(v), -Math.cos(u) * cv]
}

/**
 * A patch of a sphere with an arbitrary outline, triangulated as a fan from the
 * outline's centroid, with smooth radial normals.
 *
 * `outline` is a closed loop of (u, v) tangent angles. `lift` is the fraction of
 * the radius the patch stands proud by — 0.015 is enough to beat depth
 * precision at the near plane the chase camera uses and far too little to see
 * as a step.
 *
 * FAN TRIANGULATION IS THE CONSTRAINT: every outline handed to this must be
 * star-shaped about its own centroid. Almonds, tapering stripes and shallow
 * arcs all are. A blaze that curves through more than about 90 degrees is not,
 * and comes out with the fan cutting across the concave side — use
 * `sphereRibbon` for those.
 *
 * THE (u, v) PARAMETERISATION IS LEFT-HANDED AGAINST THE OUTWARD NORMAL, and
 * getting that wrong cost a whole capture round with a completely wrong
 * diagnosis, so it is worth deriving here rather than asserting.
 *
 *   d(dir)/du at the origin is (+1, 0, 0) and d(dir)/dv is (0, +1, 0), so
 *   cross(du, dv) is +Z — while the outward normal at dirAt(0,0) is -Z.
 *
 * An outline walked with (u, v) INCREASING is therefore wound clockwise seen
 * from outside, i.e. back-facing, i.e. culled. `almond` and every stripe below
 * walk increasing, so the fan is emitted a-then-d REVERSED (`c, pd, pa`) to put
 * the front face outward.
 *
 * What that bug looked like: a face with correct eyes, a correct muzzle and NO
 * MASK AND NO BROW AT ALL. Every marking was in the scene, at the right place, at
 * the right size, with the right normals — and drawing zero pixels, because the
 * painterly material is single-sided. It reads as a palette problem (the marks
 * must be too close in value to the fur) or a conformance problem, and both of
 * those were investigated first. It is the same failure the ocean had: "polarSheet
 * winds its rings so the sheet faces DOWN, so back-face culling removed all 48k
 * triangles." `tools/raccoon.mjs` now checks winding against the authored normals
 * for exactly this reason.
 */
export function spherePatch(
  radius: number, outline: readonly (readonly [number, number])[], lift = 0.015,
): THREE.BufferGeometry {
  const b = new MeshBuilder()
  const r = radius * (1 + lift)
  let cu = 0
  let cv = 0
  for (const [u, v] of outline) { cu += u; cv += v }
  cu /= outline.length
  cv /= outline.length
  const at = (u: number, v: number): { p: Vec3; n: Vec3 } => {
    const n = dirAt(u, v)
    return { p: [n[0] * r, n[1] * r, n[2] * r], n }
  }
  const c = at(cu, cv)
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i]!
    const d = outline[(i + 1) % outline.length]!
    const pa = at(a[0], a[1])
    const pd = at(d[0], d[1])
    // REVERSED — see the note on handedness above. The painterly material is
    // single-sided, so a patch wound the other way is simply absent.
    b.triN(c.p, c.n, pd.p, pd.n, pa.p, pa.n)
  }
  return b.build()
}

/**
 * A strip of a sphere following a centreline, with a per-station half-width.
 *
 * For the brow blaze, which is the one marking on the face that curves too far
 * to fan: in the reference it starts at the bridge of the nose, climbs over the
 * inner brow, and sweeps back and down around the OUTSIDE of the eye patch —
 * something like 120 degrees of arc. Built as a ribbon it also gets to taper,
 * which the reference's blaze does hard at both ends.
 *
 * The width is applied along the local tangent's perpendicular in (u, v) space
 * rather than in true arc length. On a patch this small — under a third of the
 * skull — the difference is under a millimetre and the alternative is a frame
 * per station.
 */
export function sphereRibbon(
  radius: number,
  centre: readonly (readonly [number, number])[],
  halfWidth: readonly number[],
  lift = 0.015,
): THREE.BufferGeometry {
  const b = new MeshBuilder()
  const r = radius * (1 + lift)
  const at = (u: number, v: number): { p: Vec3; n: Vec3 } => {
    const n = dirAt(u, v)
    return { p: [n[0] * r, n[1] * r, n[2] * r], n }
  }
  const edges: { a: { p: Vec3; n: Vec3 }; b: { p: Vec3; n: Vec3 } }[] = []
  for (let i = 0; i < centre.length; i++) {
    const prev = centre[Math.max(0, i - 1)]!
    const next = centre[Math.min(centre.length - 1, i + 1)]!
    let tu = next[0] - prev[0]
    let tv = next[1] - prev[1]
    const len = Math.hypot(tu, tv) || 1
    tu /= len
    tv /= len
    // Perpendicular in the tangent plane.
    const w = halfWidth[Math.min(halfWidth.length - 1, i)]!
    const [u, v] = centre[i]!
    edges.push({ a: at(u - tv * w, v + tu * w), b: at(u + tv * w, v - tu * w) })
  }
  for (let i = 0; i + 1 < edges.length; i++) {
    const e0 = edges[i]!
    const e1 = edges[i + 1]!
    // THE HANDEDNESS FLIPS AT THE POLE. The derivation in `spherePatch` gives
    // `cross(d/du, d/dv) = -cos(v) * dir`, and the sign of that is the sign of
    // -cos(v) — which reverses as v passes pi/2. Every ribbon on this animal used
    // to stay well below the pole so it never came up; the dorsal stripe runs
    // from the bridge at v 0.06 over the crown to v 2.30, and the segments past
    // the crown came out wound the other way. 12% of the mask's triangles,
    // drawing nothing, on exactly the half of the stripe the chase camera
    // exists to see. `tools/raccoon.mjs` caught it before it shipped, which is
    // the fourth time.
    const flip = Math.cos((centre[i]![1] + centre[i + 1]![1]) * 0.5) < 0
    if (flip) {
      b.triN(e0.a.p, e0.a.n, e0.b.p, e0.b.n, e1.b.p, e1.b.n)
      b.triN(e0.a.p, e0.a.n, e1.b.p, e1.b.n, e1.a.p, e1.a.n)
    } else {
      b.triN(e0.a.p, e0.a.n, e1.b.p, e1.b.n, e0.b.p, e0.b.n)
      b.triN(e0.a.p, e0.a.n, e1.a.p, e1.a.n, e1.b.p, e1.b.n)
    }
  }
  return b.build()
}

/**
 * The mask band's centreline and half-width at a tangent yaw `u`.
 *
 * SHARED BY THE MASK AND THE BLAZE, and that is the point. The blaze has to sit
 * just ABOVE the band's upper edge, and when both were written out longhand they
 * disagreed: the blaze's centreline ran at v = 0.263 with a 0.075 half-width
 * while the band's upper edge at the same u was 0.241, so the blaze's lower half
 * lay ON the dark. Two markings at the same 1.5% lift have no depth between them
 * to sort by, so what rendered was a pale lens interleaved with the dark mask
 * directly over each eye — which reads as a drooping eyelid, on both animals, in
 * every frame. Deriving the blaze's position FROM the band makes that
 * unrepresentable.
 *
 * `u` is in +/-`MASK_SPAN`; outside that the band has ended.
 */
const MASK_SPAN = 0.98

function maskBandV(u: number): number {
  // Dips toward the cheeks: the reference's mask falls away at both outer ends
  // rather than running level, which is what tilts each eye's patch and gives
  // the mask its scowl.
  const t = u / MASK_SPAN
  return 0.1 - t * t * 0.2
}

function maskBandHalf(u: number): number {
  const t = u / MASK_SPAN
  // Pinched at the bridge, full over each eye, tapering to the outer tips. The
  // bridge pinch is what stops the band reading as a blindfold — the reference
  // narrows there but never breaks.
  const overEye = Math.exp(-((Math.abs(t) - 0.46) ** 2) / 0.055)
  return 0.075 + overEye * 0.11 - t ** 4 * 0.05
}

/**
 * Lift ladder for the face markings, as a fraction of the skull radius.
 *
 * EVERY FAMILY GETS ITS OWN RUNG and the reason is depth, not taste. All the
 * markings merge into one geometry per surface, so nothing sorts them; two caps
 * that overlap in (u, v) at the same lift are COPLANAR and their triangles
 * interleave per-pixel. That shipped twice — the forehead stripe against the
 * band (a pale rectangle punched out of the middle of the stripe, which read as
 * a keyhole on the forehead) and the blaze against the band. 0.004 of the radius
 * between rungs is 1.2 mm, far too little to see as a step and far more than
 * enough to win a depth test at the near plane the chase camera uses.
 */
/**
 * The ladder, AUTHORED IN MILLIMETRES.
 *
 * It used to be authored as fractions of the skull's radius, and that is the
 * wrong unit twice over. A standoff is not a proportion of anything — it is
 * however far a marking has to stand off the surface to win a depth test, which
 * is a fixed small absolute distance — and writing it as a fraction made it move
 * whenever the head did. It has now been pushed past the readback's 0.02 m
 * DETACHED tolerance TWICE by changes that had nothing to do with the face:
 * once when the skull grew 16% (round 20) and once when the taper landed and
 * multiplied everything at the jaw by 1.26 (round 24). Both times the numbers
 * here were correct and the unit was not.
 *
 * THE CEILING IS 0.02 m AFTER THE TAPER, so the tallest rung has to be authored
 * under 0.02 / 1.34 = 14.9 mm. 1.34 is the MEASURED amplification at the mouth,
 * where every one of these sits and where it is worst; it is not the taper's
 * own 1.26 at that height, because the Jacobian stretches a radial offset by
 * more than the taper alone. Take the figure from `tools/raccoon.mjs`, not from
 * HEAD_TAPER — an estimate off the table put the tongue at 21 mm.
 *
 * THE MUZZLE PAD IS A RUNG ON THIS LADDER, and everything drawn ON the muzzle
 * has to sit above it. The pad went in above the mouth and the grin once and
 * simply hid them — the face came back with no mouth at all, which reads as a
 * missing feature rather than as a depth-ordering mistake. If a marking is drawn
 * on another marking, its lift is not independent.
 */
const STANDOFF_MM = {
  band: 4.0, blaze: 5.0, stripe: 6.4,
  muzzle: 11.0, mouth: 12.2, grin: 13.4, tongue: 14.6,
} as const

/** Millimetres to the fraction-of-radius that `spherePatch` and friends want. */
const mm = (v: number): number => v / 1000 / RACCOON.skull

const LIFT = {
  band: mm(STANDOFF_MM.band),
  blaze: mm(STANDOFF_MM.blaze),
  stripe: mm(STANDOFF_MM.stripe),
  muzzle: mm(STANDOFF_MM.muzzle),
  mouth: mm(STANDOFF_MM.mouth),
  grin: mm(STANDOFF_MM.grin),
  tongue: mm(STANDOFF_MM.tongue),
} as const

/**
 * The driver's open grin — a filled dark cavity, and the tongue inside it.
 *
 * DRAWN OVER the shared mouth LINE rather than instead of it, because the line
 * lives in the `mask` batch which both animals share and only the driver grins.
 * Two one-shape batches whose passenger instance is scaled to zero is cheaper
 * than splitting the mask geometry in two, and it is the same trick the "!" uses
 * when it is absent.
 *
 * The reference gives the driver a wide open pink-tongued smile and the passenger
 * a closed line, and that asymmetry is most of the pair's character.
 */
export function grinGeometry(tongue: boolean): THREE.BufferGeometry {
  const r = RACCOON.skull
  const N = 12
  const out: [number, number][] = []
  const halfU = tongue ? 0.19 : 0.25
  const drop = tongue ? 0.1 : 0.15
  const top = tongue ? -0.4 : -0.37
  // Upper edge, then lower edge, and THE ORDER IS LOAD-BEARING. `spherePatch`
  // reverses whatever loop it is handed (see the handedness note there), so an
  // outline must be walked the same way round as every other marking in this
  // file: down one side, across the bottom, up the other. Written the intuitive
  // way — along the top edge and back along the bottom — it comes out with the
  // reverse cyclic order, i.e. back-facing, i.e. invisible. That is the FOURTH
  // time this project has lost geometry to winding, and this one got through
  // because the new shape was never added to `tools/raccoon.mjs`. It is now.
  for (let i = 0; i <= N; i++) {
    const t = 1 - (i / N) * 2
    out.push([t * halfU, top - (1 - t * t) * 0.02])
  }
  for (let i = 0; i <= N; i++) {
    const t = (i / N) * 2 - 1
    out.push([t * halfU, top - (1 - t * t) * drop])
  }
  return conform(spherePatch(r, out, tongue ? LIFT.tongue : LIFT.grin))
}

/** An almond outline in tangent angles, tilted, with a sharp inner corner. */
function almond(
  cu: number, cv: number, halfU: number, halfV: number, tilt: number, segments = 14,
): [number, number][] {
  const out: [number, number][] = []
  const ct = Math.cos(tilt)
  const st = Math.sin(tilt)
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2
    // An almond, not an ellipse: the |cos| power pinches both ends into corners,
    // which is what the reference's eye patch has — it is a leaf shape with a
    // point at the bridge and a point at the cheek, and a plain ellipse reads as
    // a pair of sunglasses.
    const cu2 = Math.cos(a)
    const su = Math.sin(a)
    const u = cu2 * halfU
    const v = su * halfV * (0.55 + 0.45 * Math.abs(cu2) ** 0.6)
    out.push([cu + u * ct - v * st, cv + u * st + v * ct])
  }
  return out
}

// ── geometry ────────────────────────────────────────────────────────────────

/**
 * Deterministic 0..1 hash. No `Math.random` in generation, ever — the screenshot
 * harness is only meaningful if frame N is byte-identical between runs.
 */
function hash(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return x - Math.floor(x)
}

/** Low-poly smooth blob. Segment counts are set by screen size — see below. */
function ball(radius: number, detail: number): THREE.BufferGeometry {
  return new THREE.SphereGeometry(radius, detail, Math.max(4, detail >> 1))
}

/**
 * The same blob, exported.
 *
 * kart.ts built the eyeball and the iris with inline `new THREE.SphereGeometry`
 * calls and their own segment counts, which is the one part of the animal whose
 * tessellation was decided somewhere other than here. `tools/raccoon-export.mjs`
 * needs it too, and a shared helper is better than a third copy.
 */
export function sphere(radius: number, detail: number): THREE.BufferGeometry {
  return ball(radius, detail)
}

/**
 * Apply the skull's non-uniform scale to a piece of head geometry.
 *
 * EVERY head part goes through this and it is not optional. The skull is a
 * sphere squashed to (1.1, 0.94, 0.98) — a broad squat head, which is what the
 * reference has — and the face markings are caps of the UNSQUASHED sphere. Skip
 * this on one of them and that marking conforms to a head that is not there:
 * it stands 0.03 m proud at the cheeks and sinks 0.017 m under the surface at
 * the brow, so a mask patch is a floating shell on one side of the face and
 * absent on the other. That is the exact symptom the v1 mask had, from a
 * different cause, and it took three rounds to find the first time.
 *
 * It works because the squash is applied to the whole family alike: an affine
 * map takes the sphere to the ellipsoid and takes any cap of the sphere to the
 * corresponding cap of the ellipsoid, so conformance survives it exactly.
 */
/**
 * The head's horizontal taper: how wide the skull is at each height, as a
 * multiple of the sphere's own radius there. `t` is y / skull radius, so +1 is
 * the crown and -1 the chin.
 *
 * THE REFERENCE'S HEAD IS A TRAPEZOID, NOT A BALL, and this table is measured
 * off it rather than chosen. Silhouette width of the sheet's front-view skull —
 * ears excluded, since they leave the outline by y 702 — normalised to its own
 * widest row:
 *
 *   t  +0.66   0.48        t  -0.14   0.91
 *   t  +0.39   0.65        t  -0.28   1.00   <- the cheek, 73% down the head
 *   t  +0.13   0.79        t  -0.68   0.87
 *
 * A sphere is symmetric about its equator and widest at mid-height. This is
 * widest at 73% down and HALF as wide at the crown as at the cheek. Dividing the
 * measured widths by the sphere's own `sqrt(1 - t^2)` leaves the taper below,
 * which rises monotonically from crown to jaw — the numbers past the cheek keep
 * climbing because the sphere is closing fast there and it takes more
 * multiplier to hold the same width.
 *
 * WHY THIS AND NOT A BIGGER RUFF. The flare used to come entirely from
 * `ruffGeometry`, a skirt pushed out at one band of elevations on a spherical
 * skull — and it read as exactly what it was, a plate bolted to the side of the
 * head, with a hard horizontal top and bottom and an overhang that cast its own
 * shadow onto the body. Three independent reviews called it a slab from the
 * front, a poncho hem from behind and a scarf groove in profile, which is ONE
 * ring-shaped hard edge seen from three angles. A form cannot be made to look
 * grown-from by decorating it; the widening has to be in the skull.
 */
/*
 * THE JAW STATIONS ARE CUT 9%, because the trapezoid had a BULGE on it and the
 * bulge was a shelf. Multiplying each station by the sphere's own radius there:
 *
 *   t       -0.14   -0.28   -0.41   -0.68
 *   before   1.020   1.123   1.113   0.982     <- rises 10% past the cheek
 *   after    1.020   1.019   1.010   0.891     <- holds, then closes
 *
 * The head is still a trapezoid — 0.541 of the radius at t 0.66 against 1.020 at
 * the cheek — and that was never the fault. The fault was the extra 10% between
 * t -0.28 and -0.41, which put the skull's widest half-width at 0.463 where the
 * BODY at the same height is 0.301: a 0.16 m overhang that then fell back to
 * 0.235 over the next 0.17 m of height. A near-horizontal underside on a flat-
 * shaded form selects one ramp stop over its whole area and casts its own shadow
 * onto the body, which is the "plate bolted to the head" read this taper was
 * introduced to CURE — it moved the plate from the ruff into the skull rather
 * than removing it. Three reviews called the old ruff a slab, a poncho hem and a
 * scarf groove; the same edge was still there, 0.09 m lower.
 *
 * MEASURED ON THE SHEET, both views: head 243 px against body 240, a ratio of
 * 1.01. The build was at 1.113. Head and body are meant to be very nearly the
 * same width and the head is meant to be DEEPER — that is the whole difference
 * between the two views, and it is why the fix is to narrow the head rather than
 * to widen the body, which the front rows already have correct.
 *
 * The crown stations are deliberately untouched. The front row profile has the
 * build NARROW from row 0 to row 7 by 0.16 to 0.43, so the upper head wants more
 * width and not less; cutting the peak lets those rows renormalise up on their
 * own without moving any geometry above the cheek.
 */
const HEAD_TAPER: readonly [number, number][] = [
  [1.00, 0.62],
  [0.66, 0.72],
  [0.39, 0.79],
  [0.13, 0.89],
  [-0.14, 1.03],
  [-0.28, 1.061],
  [-0.41, 1.107],
  /*
   * NO JAW UNDERCUT HERE, AND THE ATTEMPT IS RECORDED BECAUSE THE NUMBERS THAT
   * JUSTIFIED IT WERE MIS-ALIGNED, NOT WRONG.
   *
   * The sheet plainly has a waist: measured at 144 rows its front silhouette
   * falls 0.918 -> 0.713 -> 0.902 over nine rows, a 0.383 -> 0.297 m drop in
   * 0.037 m of height. Decomposing per station said the BARE SPHERE was already
   * 0.017-0.055 too wide at v -0.50..-0.70, so the knob had to be this table
   * rather than the ruff, and solving taper = x_sheet / (r cos v s.x) gave
   * 1.040 / 0.989 / 1.075. It measured exactly as predicted: rows 29-32 went
   * +0.15/+0.23/+0.20/+0.18 to +0.08/+0.13/+0.12/+0.10 and NOTHING outside the
   * band moved by a thousandth.
   *
   * IT WAS STILL THE WRONG PLACE, by about 0.10 m. `raccoon-profile.mjs`
   * normalises both subjects over their own total height, and that only aligns
   * anatomy if both have the same head-height fraction. They do not: this model
   * is a BUST with its base floating 0.42 m above the box floor, so ear-tip to
   * chin is 0.771 of 1.345 = 57% of its height, against the sheet's 48%. The
   * sheet's waist at frac 0.42 is therefore 87% of the way down the SHEET's head,
   * which lands at frac 0.50 here — y 1.15, the neck — and the undercut went in
   * at y 1.24-1.27, the jaw.
   *
   * The render is what said so: narrowing the skull where the mouth sits turned
   * the grin into a dark open gash, because the chin's surface rotated to face
   * downward under it. A conformance gate cannot catch that — the markings
   * followed the taper correctly, which is exactly what `conform` guarantees.
   *
   * So a waist may well be right, at y ~1.15, which is the BODY's top and not the
   * skull at all. Do not re-derive it from a row index.
   */
  [-0.68, 1.216],
  [-1.00, 1.270],
]

/**
 * The skull's FORE-AFT taper, separate from its across taper above.
 *
 * WHY IT HAS TO BE SEPARATE. The side silhouette, aligned on its own landmarks
 * (ear tip and deepest point), had the head too SHALLOW at the crown and too
 * deep just above the cheek, while the front view had the same stations correct
 * across — so no single multiplier can satisfy both. Solving
 * `tz = depth_target / 2 / (r cos v s.z)` at the skull-dominated stations:
 *
 *   y       1.670  1.594  1.518  1.442
 *   t       0.794  0.552  0.311  0.070
 *   needed  0.954  0.895  0.900  0.925
 *   across  0.681  0.748  0.820  0.921     <- 1.40x, 1.20x, 1.10x, 1.00x out
 *
 * A CRANIUM IS DEEPER THAN IT IS WIDE and this is what that costs: at t 0.79 the
 * head now runs half-width 0.153 against half-depth 0.191, a ratio of 1.25. The
 * two tapers converge below the eye line and are IDENTICAL from t -0.14 down, so
 * the jaw, the muzzle and every marking on them are untouched — which matters,
 * because the muzzle's own forward projection is scaled by this term.
 *
 * CONFORMANCE STILL HOLDS, for the same reason it holds for the across taper:
 * both depend only on HEIGHT, so every point at a given y is scaled by the same
 * pair of factors and the `LIFT` ladder keeps its order. That is the property to
 * preserve if either table is ever changed again.
 */
const HEAD_DEPTH_TAPER: readonly [number, number][] = [
  [1.00, 0.980],
  [0.79, 0.954],
  [0.55, 0.895],
  [0.31, 0.900],
  [0.07, 0.925],
  // From here down it tracks HEAD_TAPER exactly — the side view is within
  // 0.013 m of target at t 0.07 and 0.003 m at the cheek landmark, so there is
  // nothing to correct below the eye line and a difference here would only
  // shear the markings off a jaw that already fits.
  [-0.14, 1.03],
  [-0.28, 1.061],
  [-0.41, 1.107],
  [-0.68, 1.216],
  [-1.00, 1.270],
]

/** As `headTaper`, for the fore-aft axis. */
export function headDepthTaper(t: number): [number, number] {
  let prev = HEAD_DEPTH_TAPER[0] as [number, number]
  if (t >= prev[0]) return [prev[1], 0]
  for (const cur of HEAD_DEPTH_TAPER.slice(1)) {
    if (t >= cur[0]) {
      const span = prev[0] - cur[0]
      const slope = (prev[1] - cur[1]) / span
      return [cur[1] + slope * (t - cur[0]), slope]
    }
    prev = cur
  }
  return [prev[1], 0]
}

/** The taper and its slope d/dt, which the normal transform below needs. */
export function headTaper(t: number): [number, number] {
  let prev = HEAD_TAPER[0] as [number, number]
  if (t >= prev[0]) return [prev[1], 0]
  for (const cur of HEAD_TAPER.slice(1)) {
    if (t >= cur[0]) {
      const span = prev[0] - cur[0]
      const slope = (prev[1] - cur[1]) / span
      return [cur[1] + slope * (t - cur[0]), slope]
    }
    prev = cur
  }
  return [prev[1], 0]
}

/**
 * Apply the skull's shape to a piece of head geometry.
 *
 * EVERY head part goes through this and it is not optional. The skull is a
 * sphere squashed to (1.1, 0.94, 0.98) and then tapered by `headTaper`, and the
 * face markings are caps of the UNSQUASHED sphere. Skip this on one of them and
 * that marking conforms to a head that is not there: it stands 0.03 m proud at
 * the cheeks and sinks 0.017 m under the surface at the brow, so a mask patch is
 * a floating shell on one side of the face and absent on the other. That is the
 * exact symptom the v1 mask had, from a different cause, and it took three
 * rounds to find the first time.
 *
 * CONFORMANCE SURVIVES THE TAPER because the taper depends only on HEIGHT. Every
 * point at a given y is scaled by the same factor, so a cap that sat at radius
 * r(1 + lift) above the skull still sits outside it afterwards and the whole
 * `LIFT` ladder keeps its order. That is the property to preserve if this
 * function is ever changed again — a map that varied with x or z would shear the
 * markings off the surface.
 *
 * THE NORMALS NEED THE JACOBIAN, NOT THE SCALE. Under `x' = A(y)x, y' = Sy,
 * z' = B(y)z` the correct normal map is the inverse transpose of
 *
 *     [ A   A'x  0 ]
 *     [ 0   S    0 ]
 *     [ 0   B'z  B ]
 *
 * and the `A'`/`B'` terms are not negligible here: the taper runs 0.62 to 1.40,
 * so ignoring the slope would tilt the shading on exactly the cheek and jaw the
 * taper exists to create. `computeVertexNormals` is not an option — it would
 * smooth the ruff, which is flat-shaded on purpose.
 */
function conform(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const s = RACCOON.skullScale
  const r = RACCOON.skull
  const pos = geo.attributes.position as THREE.BufferAttribute
  const nrm = geo.attributes.normal as THREE.BufferAttribute
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const y = pos.getY(i)
    const z = pos.getZ(i)
    const [f, df] = headTaper(y / r)
    const [fz, dfz] = headDepthTaper(y / r)
    const A = s.x * f
    const B = s.z * fz
    const Ad = (s.x * df) / r
    const Bd = (s.z * dfz) / r
    pos.setXYZ(i, x * A, y * s.y, z * B)
    const nx = nrm.getX(i)
    const ny = nrm.getY(i)
    const nz = nrm.getZ(i)
    const ox = nx / A
    const oy = ny / s.y - (Ad * x * nx) / (A * s.y) - (Bd * z * nz) / (B * s.y)
    const oz = nz / B
    const len = Math.hypot(ox, oy, oz) || 1
    nrm.setXYZ(i, ox / len, oy / len, oz / len)
  }
  pos.needsUpdate = true
  nrm.needsUpdate = true
  geo.computeBoundingSphere()
  return geo
}

/** The same map applied to a POINT, for joints that hang off the skull. */
export function onSkull(x: number, y: number, z: number): [number, number, number] {
  const s = RACCOON.skullScale
  const t = y / RACCOON.skull
  const f = headTaper(t)[0]
  const fz = headDepthTaper(t)[0]
  return [x * s.x * f, y * s.y, z * s.z * fz]
}

/**
 * The RUFF: a jagged skirt that FOLLOWS the skull's own profile.
 *
 * The character's defining silhouette. Zoomed on the reference's front view the
 * cheek ruff is the widest part of the whole animal — wider than the skull it
 * grows from and wider than the body below — and it is a hard angular zigzag,
 * five or six points down each side. It is what makes the head read as FUR
 * rather than as a ball.
 *
 * FOUR CONSTRUCTIONS, and the three that failed each failed differently and
 * instructively:
 *
 *   SIX BALLS SUNK INTO THE SKULL. Lumps on a sphere. Read as acne, as cheek
 *   pouches, as pale spots, and once edge-on as a blade; moved or resized in
 *   four rounds without being right. A ball has no direction and a fur point is
 *   entirely direction.
 *
 *   A FLARED LOFTED COLLAR at constant height. Came out a SOMBRERO — a flat brim
 *   standing straight out sideways — because a ring of revolution flares in one
 *   plane and the reference's ruff does not.
 *
 *   TWENTY-SIX AIMED PYRAMIDS. Long and thin they were QUILLS (the first in-game
 *   capture was a pufferfish); squat and wide they were CHIPS, flat flakes
 *   scattered on a sphere, some of them across an eye. Applied primitives on a
 *   smooth surface read as applique at any size, because the surface they sit on
 *   is still visibly a sphere between them.
 *
 * What works is neither applied nor revolved: rings that take the SPHERE'S OWN
 * horizontal radius at each elevation and push it out by a per-vertex amount.
 * The skirt therefore hugs the head by construction — it cannot brim, because
 * its profile IS the head's profile — and the push is what makes it jagged.
 *
 * TWO MODULATIONS DO ALL THE WORK:
 *   `bulge(u)`  zero at the front, maximum at the cheeks. The ruff flares where
 *               the reference flares and vanishes at the chin, which is what
 *               keeps it off the muzzle, the mouth and the mask.
 *   the zigzag  alternate vertices pushed out and in, so the outline is pointed
 *               rather than smooth. Flat-shaded, or radial normals would round
 *               the points straight back into the ball this replaces.
 *
 * THE SKULL STAYS A SPHERE UNDERNEATH. Every marking is a cap of a sphere of
 * radius `skull` (see the file header), so the surface the mask sits on cannot
 * change shape. The skirt is additive and its `bulge` is zero exactly where the
 * markings are.
 */
function ruffGeometry(): THREE.BufferGeometry {
  const R = RACCOON
  const b = new MeshBuilder()
  // 38, not 26. The skirt is flat-shaded so every quad is a facet, and at 26
  // segments those facets are large enough to read as angular PLATES — armour
  // rather than fur — once a warm directional key is on them. Finer segments
  // keep the jagged outline (which is the point) while the individual faces drop
  // below the size at which the eye tracks them separately.
  const SEG = 38
  // Elevations from just under the eye line down to the neck, and how far the
  // skirt stands off the sphere at each — peaking at the cheek, closing at both
  // ends so it merges into the head rather than ending in a lip.
  // THE RUFF HAS TO OUT-WIDTH THE BODY, and that ratio is the reference's most
  // measurable proportion: its head-plus-ruff is about 1.3x the width of the
  // torso below. At a 0.30 push the two came out 0.404 against 0.378 — the ruff
  // ahead by 0.026, which is nothing, and the animal read as a big egg with a
  // small head. Narrowing the BODY instead is not available: the two sit at
  // +/-0.37 and nearly touch, and any narrower opens a gap between them that
  // shows the box through. So the ruff grows.
  // JAG HALVED. The second reference sheet shows the cheek ruff as SOFT tufted
  // bumps — four or five shallow points down each cheek, integrated into the
  // head's outline — not the hard teeth the first sheet's smaller reproduction
  // suggested. At 0.24 of jag the points were sharp enough to read as armour
  // plates under a directional key; at 0.11 they read as fur. The outward push
  // stays, because the ruff still has to be the widest part of the animal.
  const STATIONS: readonly [number, number, number][] = [
    // PUSH REDUCED. Remember `conform` scales the whole skull by 1.10 in x, so a
    // push of 0.44 becomes a 0.464 m half-width against the body's 0.378 — 23%
    // wider, where the profile measurement says the sheet keeps head and body
    // within 10% of each other. Forgetting the conform scale is easy and it puts
    // every ruff number 10% out.
    // SPREAD OVER MORE HEIGHT AND FLATTER AT THE PEAK. Concentrated in a narrow
    // band with a sharp maximum it rendered as a LID — a hard horizontal disc
    // between the head and the body, which is the "stacked primitives" read in
    // its purest form. A ruff is a long soft transition, so the push ramps in
    // over four stations and out over three instead of spiking at one.
    // THE PEAK MOVED DOWN to the cheek line. At v -0.54 the widest points sat
    // level with the EARS and stuck out sideways like wings, which both fought
    // the ears for the top of the silhouette and put the ruff's mass in the
    // wrong place — the sheet's flare is at the cheeks, below the eye, and the
    // crown above it is clean. Ramping in later and peaking at -0.78 puts the
    // mass where the sheet has it and gives the ears the crown to themselves.
    // CUT TO A FIFTH, because the flare moved into the SKULL. `HEAD_TAPER` now
    // widens the head from 0.62 of the sphere at the crown to 1.34 at the jaw,
    // which is the reference's own trapezoid measured off its front view — so
    // the ruff no longer has to supply the width and must not, or the two add.
    // Left at the old numbers with the taper in, the head came out 1.13 m across
    // against 0.87, and the widest row of the whole animal was the ruff by a
    // margin of 25%.
    //
    // WHAT THE RUFF IS FOR NOW is the notched OUTLINE and the fore-aft depth
    // behind the ears — not the flare. Its push tops out at 0.054 of the radius,
    // about 22 mm, and the jag is nearly as large as the push at every station:
    // teeth that swing from nothing to twice the push read as fur points on a
    // silhouette, where the old ones read as a plate with a serrated hem.
    [0.10, 0.002, 0.006],
    [-0.16, 0.012, 0.017],
    [-0.42, 0.032, 0.033],
    [-0.66, 0.048, 0.050],
    [-0.78, 0.054, 0.055],   // the sheet's cheek points
    [-0.98, 0.046, 0.044],
    [-1.18, 0.026, 0.028],
    [-1.38, 0.008, 0.011],
    [-1.54, 0.000, 0.006],
  ]
  /**
   * THE TUFTS RUN DOWN THE CHEEK, NOT AROUND IT, and that is the axis six rounds
   * of ruff work were spent on the wrong side of.
   *
   * The teeth above vary with AZIMUTH (the `spike` hash on `i`). An orthographic
   * silhouette is the MAX OVER AZIMUTH at each height, so the ~10 teeth whose
   * angular window straddles the tangent point collapse to their envelope and
   * the zigzag between them never reaches the outline at all. Measured with
   * `tools/raccoon-outline.mjs` on the build before this change: over the whole
   * cheek band the right edge climbed +3,+2,+3,+3 and fell -1,-2,-3,-5, ZERO
   * direction reversals on either cheek — one smooth rounded bulge. The
   * max-over-azimuth reach per station is a smooth ramp by construction:
   *
   *   station  0.10  -0.16  -0.42  -0.66  -0.78  -0.98  -1.18  -1.38  -1.54
   *   reach    .010   .035   .076   .115   .128   .105   .064   .023   .008
   *
   * That reconciles two sets of reviews that read as contradictory. The teeth
   * ARE visible — in SHADING, where their facets catch the key light, which is
   * what "spiked collar" and "gear" were describing. They are invisible in the
   * OUTLINE, which is what "slab", "poncho hem" and "scarf groove" were
   * describing. Both were right about different channels.
   *
   * Sheet 2 draws "four or five soft tufted bumps down each cheek". Down. So the
   * reach has to oscillate with ELEVATION, and that needs enough rings in v to
   * resolve a lobe: the nine authored stations are the ENVELOPE, resampled onto
   * `RUFF_RINGS` so the lobe has about four rings per cycle. Below three it
   * aliases into a taper and the outline goes smooth again.
   *
   * The lobe multiplies the JAG only and not the `push`. Applying it to the whole
   * offset was the first instinct and it costs head DEPTH — the ruff's rear floor
   * is where the head's fore-aft mass comes from, and head/body depth is 1.63
   * against the sheet's 1.65 with no room to give any back. So the smooth push
   * keeps the mass and the lobed jag carries the outline.
   */
  const RUFF_RINGS = 17
  const RUFF_LOBES = 4
  const LOBE_FLOOR = 0.15
  const envAt = (v: number): [number, number] => {
    let prev = STATIONS[0] as [number, number, number]
    if (v >= prev[0]) return [prev[1], prev[2]]
    for (const cur of STATIONS.slice(1)) {
      if (v >= cur[0]) {
        const f = (v - cur[0]) / (prev[0] - cur[0])
        return [cur[1] + (prev[1] - cur[1]) * f, cur[2] + (prev[2] - cur[2]) * f]
      }
      prev = cur
    }
    return [prev[1], prev[2]]
  }
  const vTop = (STATIONS[0] as [number, number, number])[0]
  const vEnd = (STATIONS[STATIONS.length - 1] as [number, number, number])[0]
  const RESAMPLED: [number, number, number, number][] = []
  for (let k = 0; k < RUFF_RINGS; k++) {
    const t = k / (RUFF_RINGS - 1)
    const v = vTop + (vEnd - vTop) * t
    const [push, jag] = envAt(v)
    const lobe = LOBE_FLOOR + (1 - LOBE_FLOOR)
      * (0.5 + 0.5 * Math.cos(t * RUFF_LOBES * Math.PI * 2))
    RESAMPLED.push([v, push, jag, lobe])
  }
  const rings: Vec3[][] = RESAMPLED.map(([v, push, jag, lobe]) => {
    const out: Vec3[] = []
    const cv = Math.cos(v)
    const sv = Math.sin(v)
    for (let i = 0; i < SEG; i++) {
      const u = (i / SEG) * Math.PI * 2
      // 0 at the front (u = 0), 1 at the sides, easing off toward the back so
      // the ruff does not become a mane.
      // 0 at the muzzle, full at the cheeks, and NOT zero behind. The ruff used
      // to ease off toward the back, which left the head shallow fore-aft: the
      // side silhouette measured 0.567 wide-to-tall against the sheet's 0.661
      // while the body rows already matched to within 0.12 — so the missing
      // depth was the HEAD's, and a raccoon's ruff wraps the whole skull. The
      // floor of 0.88 keeps mass behind the ears where the sheet has it.
      //
      // It is that high because of a RATIO, not a look: the sheet's side view
      // has the head 1.7 times deeper than the body, and the build was at 1.18.
      // Since the body's own depth is set by the front view, the only way to
      // reach 1.7 is to deepen the head — and the ruff behind the skull is where
      // a raccoon's head depth actually comes from.
      const uu2 = Math.abs(u <= Math.PI ? u : Math.PI * 2 - u)
      const bulge = Math.max(0.88 * Math.min(1, uu2 / 1.1),
        Math.sin(Math.min(Math.PI, uu2 * 1.15)) ** 0.8)
      // IRREGULAR, because regularity is what said "mechanical". A review called
      // the previous ruff a spiked collar or a gear, and the diagnosis was exact:
      // the teeth were all the same length, evenly spaced, and every one of them
      // stood proud at the SAME radius, which is a machined edge. Real fur has
      // tufts of different lengths and some that sit back inside the mass.
      //
      // So the tooth height is hashed per vertex over a 3-cycle: two out and one
      // in as before, but the out ones vary by about a third and roughly every
      // fourth tooth is pushed BELOW the skull's own radius so the ring is never
      // a complete circle of points.
      const hv = hash(i * 31 + 7)
      const spike = i % 3 === 0
        ? -0.45 - hv * 0.35
        : (hash(i * 17 + 3) < 0.24 ? -0.30 : 0.72 + hv * 0.62)
      const rad = R.skull * (cv + (push + jag * spike) * bulge * lobe)
      out.push([
        Math.sin(u) * rad * 1.05,
        sv * R.skull,
        -Math.cos(u) * rad * 0.95,
      ])
    }
    return out
  })
  loft(b, rings, { closed: true, flat: true })
  return b.build()
}

/**
 * The skull: a sphere for everything the markings touch, plus the ruff.
 *
 * The sphere is not negotiable — `spherePatch` and `sphereRibbon` build every
 * marking as a cap of a sphere of radius `skull`, so the moment the surface the
 * markings sit on stops being that sphere, the mask floats at its centre and
 * sinks at its edge. The ruff is therefore additive and lives entirely below the
 * lowest marking.
 */
export function skullGeometry(): THREE.BufferGeometry {
  return conform(mergeGeometries([ball(RACCOON.skull, 22), ruffGeometry()]))
}

/**
 * The dark marks: two almond eye patches, the stripe down the forehead centre,
 * and the mouth line.
 *
 * All four are caps of the skull, merged, so the whole mask is one batch. The
 * FOREHEAD STRIPE is the mark most easily left out and it is not optional: in
 * both front views a dark wedge runs from between the ears down to the bridge
 * of the nose, and it is what joins the two eye patches into one mask instead of
 * two unrelated blots. Without it the face reads as a panda.
 *
 * The MOUTH is here rather than in its own pink surface because it is a dark
 * line on a pale muzzle at every distance the game shows it, and the reference's
 * passenger draws it exactly that way. The driver's open pink smile is charming
 * and is a two-value detail that a 40-pixel head cannot hold; a dark curve is
 * the same read at every size for no extra draw call.
 */
export function maskGeometry(): THREE.BufferGeometry {
  const R = RACCOON
  const r = R.skull
  const parts: THREE.BufferGeometry[] = []

  // ── the band ─────────────────────────────────────────────────────────────
  // ONE CONTINUOUS MASS THAT CROSSES THE BRIDGE. Measured on the reference: the
  // mask is a single region 250 x 67 px on a 286 px head, i.e. 0.87 of the head's
  // width and 0.23 of it tall, and the eyes sit INSIDE that dark field.
  //
  // Two almonds was the wrong model and it failed in a specific way: with a cream
  // blaze laid over the top of each one, the dark was cut into two thin crimson
  // bands with tan fur between them and above them, so at 150 px the face read as
  // a fat cream eyebrow over a pink ring — a red panda. The band is what puts the
  // eyes in a dark field.
  //
  // NOT AN EQUATORIAL BAND. The v1 mask wrapped the whole skull and that is a
  // different error; this spans 0.9 rad either side of the face and stops at the
  // cheeks, which is 0.87 of the head's width seen from the front and nothing at
  // all from behind.
  const N = 15
  const centre: [number, number][] = []
  const widths: number[] = []
  for (let i = 0; i <= N; i++) {
    const u = ((i / N) * 2 - 1) * MASK_SPAN
    centre.push([u, maskBandV(u)])
    widths.push(maskBandHalf(u))
  }
  parts.push(sphereRibbon(r, centre, widths, LIFT.band))

  // ── the dorsal stripe: bridge, forehead, crown, and down the BACK ────────
  //
  // IT RUNS OVER THE CROWN, and that is a gameplay fix rather than an anatomy
  // one. Measured on `car-chase` — the camera the player looks through for the
  // entire game, which sees the BACKS of two heads — a quantise of the head
  // region returned three browns and nothing else: V0.20, V0.43, V0.57, no pale
  // stop and no dark mark. Every marking on this animal was on the front of a
  // sphere the player never sees. The same quantise from the front returns a
  // 0.45 spread with cream at V0.65 and mask at V0.20.
  //
  // BUILT ON THE EQUATOR AND THEN ROTATED, which is the only way to get a
  // constant-width stripe over a pole. `sphereRibbon` applies half-width
  // perpendicular to the centreline in (u, v) space, so a centreline running
  // along v has its width applied in u — and an interval of u subtends
  // `u * cos(v)` of arc, which goes to zero at the crown. Compensating by
  // dividing out cos(v) needs a floor to avoid dividing by zero, and whatever
  // floor you pick is exactly where the stripe pinches: at 0.22 it necked to a
  // tenth of its width at precisely the point the chase camera looks at.
  //
  // A centreline along the EQUATOR has no such problem — its width is applied in
  // v, where an interval subtends `v * r` of arc regardless of position. So the
  // stripe is built from u 0 to u -2.95 at v = 0 and the whole geometry is then
  // turned a quarter turn about Z, which carries the equator onto the sagittal
  // midline: `(sin u, 0, -cos u)` becomes `(0, -sin u, -cos u)`, i.e. the nose at
  // u 0, the crown at u -pi/2, and the back of the skull beyond — -2.95 carries
  // it 79 degrees past vertical, which is most of the way down the occiput.
  const stripe: [number, number][] = []
  const stripeW: number[] = []
  const S = 12
  for (let i = 0; i <= S; i++) {
    const t = i / S
    stripe.push([-t * 2.95, 0])
    // Pinched at the bridge, full across the forehead and crown, tapering away
    // down the back — which is what the mark on an actual animal does.
    // 0.09..0.20 rad of half-width is 0.052..0.116 m on a 0.64 m head, i.e. 8%
    // to 18% of its width — the reference's stripe is about 15%. The first pass
    // ran 5% to 12% and read as a pencil line at chase distance, which is the
    // only distance this mark exists for.
    stripeW.push(0.09 + Math.sin(Math.min(1, t * 1.35) * Math.PI) ** 0.55 * 0.11)
  }
  const dorsal = sphereRibbon(r, stripe, stripeW, LIFT.stripe)
  dorsal.rotateZ(-Math.PI * 0.5)
  parts.push(dorsal)

  // ── the mouth ────────────────────────────────────────────────────────────
  // Raised: it sat 15 px of fur below the muzzle's lower edge and read as a chin
  // crease. A mouth belongs ON the muzzle.
  const smile: [number, number][] = []
  const M = 9
  for (let i = 0; i <= M; i++) {
    const t = (i / M) * 2 - 1
    smile.push([t * 0.28, -0.34 - (1 - t * t) * 0.085])
  }
  parts.push(sphereRibbon(r, smile, smile.map((_, i) => {
    const t = (i / M) * 2 - 1
    // Pinched at the corners, full in the middle — which is what makes a line
    // read as a smile rather than as a scar.
    return 0.012 + (1 - t * t) * 0.022
  }), LIFT.mouth))

  return conform(mergeGeometries(parts))
}

/**
 * The pale marks on the skull: a brow blaze over each eye and a cheek flash
 * under it.
 *
 * The blaze is the highest-contrast mark on the whole animal — cream against a
 * mid taupe, a 0.24 value step — and it is what makes the dark patch read as a
 * MASK rather than as shadow. It is built as a ribbon because it sweeps about
 * 110 degrees, from the bridge of the nose up over the inner brow and back down
 * outside the eye, tapering at both ends.
 *
 * The muzzle is NOT here: it is a real volume that projects forward off the
 * face, not a marking on it, so it is its own geometry below.
 */
export function blazeGeometry(): THREE.BufferGeometry {
  const r = RACCOON.skull
  const parts: THREE.BufferGeometry[] = []
  for (const side of [-1, 1] as const) {
    const centre: [number, number][] = []
    const widths: number[] = []
    const N = 9
    for (let i = 0; i <= N; i++) {
      const t = i / N
      // STARTS AT 0.26, not 0.14. At 0.14 the blaze's inner tip sat inside the
      // forehead stripe's own half-width (0.075..0.19), and both are caps at the
      // same 1.5% lift — so the two interleaved and rendered as a pale notch
      // punched out of the middle of the dark stripe, which read as a keyhole on
      // the forehead. Markings on one sphere at one lift must not overlap in
      // (u, v); there is no depth between them to sort by.
      const u = side * (0.26 + t * 0.7)
      // Its own half-width at this station, so the clearance below is exact.
      const w = 0.02 + Math.sin(t * Math.PI) ** 0.8 * 0.055
      // RIDES THE BAND'S OWN UPPER EDGE, derived rather than duplicated — see
      // `maskBandV`. The clearance is the blaze's half-width plus 0.02 rad, so
      // the pale mark touches the dark mark and never crosses it, at every u.
      centre.push([u, maskBandV(u) + maskBandHalf(u) + w + 0.02])
      // 0.075 rad of half-width at the peak, not 0.11. The reference's pale band
      // is 20 px on a 286 px head — 0.07 of the head's width — and the build
      // measured 0.13, so it was 1.9x over and read as an eyebrow rather than as
      // a highlight on the mask's edge.
      widths.push(w)
    }
    parts.push(sphereRibbon(r, centre, widths, LIFT.blaze))
    // THE CHEEK FLASH IS GONE. It was a small cream almond low on the jaw and at
    // every size tried it read as a blemish rather than as pale fur — which is
    // the limit of this technique honestly stated: a spherical cap has a HARD
    // edge, so it can draw a stripe or a patch but it cannot draw a soft broad
    // area of lighter fur, and the reference's cheek is exactly that. The pale
    // cheek now comes from the ruff clumps catching the key light instead, which
    // is a form answer to a form problem. If it is ever wanted as a marking it
    // needs a gradient, i.e. a vertex-coloured cap, not a bigger almond.
  }
  return conform(mergeGeometries(parts))
}

/**
 * The muzzle: a BROAD, SHORT snout — wide enough to read flat from the front,
 * projecting enough to read as a muzzle in profile.
 *
 * THIS IS THE THIRD VERSION AND THE FIRST THAT FITS BOTH AXES, which is the whole
 * argument for fitting the side view at all:
 *
 *   a LOFTED CONE projecting 0.11 m. Correct in profile and wrong from the
 *   front, where it read as a rodent's snout — narrow, pointed, and the wrong
 *   animal. Replaced on the front view's evidence alone.
 *   a FLAT SPHERICAL CAP. Correct from the front, where the sheet does draw the
 *   muzzle as a broad pale mass sitting flat on the face, and wrong in profile:
 *   the sheet's side view has a distinct snout projecting about 0.10 m past the
 *   brow, and a 0.015 m pad has no profile at all.
 *
 * Both were fitted against one axis and neither was checked against the other.
 * The muzzle is a wide shallow dome now: the pad's own outline swept forward and
 * shrinking, so from the front it presents the same broad rounded mass and from
 * the side it has a real projection. **A form fitted to one orthographic view is
 * a guess about every other one.**
 *
 * The nose, the mouth and the grin all ride it, so its outline is still the
 * `LIFT` ladder's `muzzle` rung and they stay above it.
 */
export function muzzleGeometry(): THREE.BufferGeometry {
  const R = RACCOON
  const b = new MeshBuilder()
  const SEG = 20
  const STATIONS = 5
  const rings: Vec3[][] = []
  for (let i = 0; i < STATIONS; i++) {
    const t = i / (STATIONS - 1)
    // Shrinks and lifts as it goes forward: a snout tips slightly down and its
    // tip is well above its root, which is what stops it reading as a beak.
    // CONVERGES TO A NEAR-POINT rather than being capped. `loft`'s `capEnd`
    // fans one polygon over the final ring and gives every triangle the LOOP's
    // single normal — and this ring is not planar, it lies on a curved surface,
    // so the fan triangles nearest its extremes disagree with that normal and
    // come out backfacing. Five of 178 triangles, which the readback caught.
    // Closing the profile to 0.06 of its width instead removes the cap entirely.
    const k = (1 - t * t * 0.55)
    // THE REACH RAMPS AS t^1.8, NOT LINEARLY, so the snout curves out of the face
    // instead of projecting off it. Linear, the ring around t 0.36 — which is
    // what sets the frontmost point at y 1.400 — already carried 36% of full
    // reach where the sheet's front edge wants 0.046 m less. The exponent drops
    // that ring to 15% and leaves the TIP at t 1 exactly where it was, which
    // matters because the tip is the one station that already matched (+0.004 m
    // at y 1.240) and it is where the nose has to sit.
    //
    // MEASURED ALTERNATIVE, REJECTED: pushing the top-edge taper 0.55 -> 0.80
    // made it WORSE, muzzle-only mean |delta| 0.0333 -> 0.0351 m, overshooting
    // y 1.273 to +0.029 while y 1.370 and 1.400 moved by 0.001 and -0.010. The
    // heights that are wrong are not set by the ring TOPS at high t, so no amount
    // of top taper reaches them.
    //
    // THE EXPONENT IS SWEPT, NOT GUESSED. `raccoon-export.mjs` runs in 0.18 s, so
    // thirteen probes cost less than one Blender render — measure the OBJ, not the
    // picture, for anything that is a geometry question:
    //
    //   exp    1.0    1.4    1.6    1.8   1.85    1.9    2.0    2.4    2.8
    //   mean 0.0331 0.0241 0.0227 0.0215 0.0212 0.0273 0.0262 0.0242 0.0230
    //
    // 1.85 is marginally best and 1.8 is what ships, because y 1.337 JUMPS 0.064 m
    // between 1.85 and 1.9 — the frontmost point there switches rings — and
    // sitting 0.05 from a cliff is a fragile place to leave a constant.
    //
    // AND DO NOT "IMPROVE" THE TESSELLATION WITHOUT RE-FITTING. At STATIONS 8 the
    // best mean over the same sweep is 0.0296 against 0.0212 here, worse at every
    // exponent: more rings make the lofted surface FULLER, and part of this fit is
    // the five-station loft's chords cutting inside the true surface. That is
    // legitimate — the silhouette IS the faceted surface — but the station count
    // is load-bearing here and not just a quality dial.
    const push = LIFT.muzzle + t ** 1.8 * R.muzzleReach
    const out: Vec3[] = []
    for (let q = 0; q < SEG; q++) {
      const a = (q / SEG) * Math.PI * 2
      const cu = Math.cos(a)
      const su = Math.sin(a)
      const uu = cu * 0.50 * k
      // THE TOP EDGE TAPERS FASTER THAN THE BOTTOM, which is what gives the
      // snout a STOP under the brow. Decomposing the sheet's side silhouette
      // into its front and rear edges — both normalised from the nose in units
      // of the deepest span, so the comparison needs no pixel scale — says the
      // REAR is already right and the whole excess is the front:
      //
      //   y       rear target / build      front target / build
      //   1.370      0.240 / 0.251           -0.412 / -0.540   0.128 too far
      //   1.337           -                  -0.441 / -0.512   0.071 too far
      //   1.273           -                  -0.522 / -0.545   0.023 too far
      //
      // The excess GROWS going up, which is the signature of a snout whose top
      // holds its full forward reach: the build's profile recedes 0.009 m from
      // y 1.290 to 1.367 where the sheet recedes 0.12. `0.24 * (1 - t * 0.55)`
      // leaves the ROOT untouched, so the pale pad keeps its height in the front
      // view where that view is already fitted to 0.012 m, and takes the TIP's
      // top edge from 0.108 to 0.049 — so at any given height above the tip the
      // frontmost ring is an earlier, less-projected one.
      //
      // Not the cant (`- t * 0.28`) and not the reach: both move the tip, and the
      // tip is where the nose lives and where the profile already matches to
      // 0.023 m. Only the TOP is wrong.
      const vv = su * (su > 0 ? 0.24 * (1 - t * 0.55) : 0.34) * k
      // The snout cants DOWN as it goes forward — about 16 degrees over its
      // length, so the nose tip sits below the eye line. Level, it read as a
      // beak; the sheet's side view drops it clearly.
      const d = dirAt(uu, -0.14 + vv - t * 0.28)
      const rr = R.skull * (1 + push)
      out.push([d[0] * rr, d[1] * rr, d[2] * rr])
    }
    rings.push(out)
  }
  // FLAT SHADED, and this is a trap this file already documents once. `loft`'s
  // `flat: false` takes radial normals about each ring's centroid IN THE XZ
  // PLANE — `radial()` zeroes y — so it is only meaningful for rings stacked
  // along Y. These rings march FORWARD along -Z, so smooth mode hands every
  // vertex a garbage normal; the readback sees geometric windings disagreeing
  // with them and reports 3-6% backfacing, and chasing that as a winding problem
  // (reversing the rings, dropping the caps, converging the tip) makes it worse
  // every time. Flat shading computes each face's normal from the face, so it
  // cannot disagree with itself — and on a five-station low-poly snout the
  // faceting is the house style anyway.
  loft(b, rings, { closed: true, capEnd: true, flat: true })
  return conform(b.build())
}


/**
 * The nose: a small dark rounded triangle sitting on the muzzle pad.
 *
 * It used to ride the tip of the lofted snout, which meant its position was a
 * function of `muzzleReach` and drifted every time that changed. With the snout
 * gone it is placed directly: on the pad, just above its centre, protruding a
 * little so it catches its own light. The reference draws it about a fifth of
 * the head's width and unmistakably the darkest mark on the face.
 */
export function noseGeometry(): THREE.BufferGeometry {
  const R = RACCOON
  const g = ball(R.nose, 12)
  g.scale(1.35, 0.9, 0.85)
  // ELEVATION -0.28 AND 0.60 OF THE REACH, and this only became reachable once
  // round 35's t^1.8 ramp pulled the muzzle back. Both nose terms were swept
  // JOINTLY with the muzzle's cant — 64 combinations at 0.18 s an export — and
  // scored against three constraints at once, which is why three earlier rounds
  // of single-knob probing found only beaks and burials:
  //
  //   the front edge, against the sheet's decomposed side silhouette
  //   the nose's own HEIGHT, which must land at frac 0.33-0.385 of the model —
  //     measured independently, the sheet's nose is frac 0.33 front and
  //     0.36-0.385 side — and this is what disqualified the sweep's optimum
  //   how far the nose stands PROUD of the muzzle across its own height, which
  //     must be positive everywhere (or it is buried) and nearly constant (or it
  //     is a beak)
  //
  //   config                       front|d|   proud            nose frac
  //   0.86 / -0.16  (was)           0.0483   +0.075..+0.112     0.346
  //   0.66 / -0.44  (unconstrained  0.0152   +0.032..+0.054     0.420  REJECTED
  //                  optimum)
  //   0.60 / -0.28  (shipped)       0.0348   +0.009..+0.035     0.375
  //
  // ONLY 7 OF 64 SATISFY ALL THREE. The unconstrained optimum scores 2.3x better
  // on the front edge and puts the nose two thirds of the way down the pad where
  // the sheet has it near the top — a sweep optimises exactly what you score and
  // silently sacrifices whatever you leave out.
  const d = dirAt(0, -0.28)
  const k = R.skull * (1 + LIFT.muzzle + R.muzzleReach * 0.60) - R.nose * 0.3
  return conform(place(g, d[0] * k, d[1] * k, d[2] * k))
}

/**
 * An ear: a rounded triangle, built as a lofted teardrop so it has a real tip.
 *
 * `blob(0.105).scale(1, 1.15, 0.62)` was what the sphere version used, and a
 * squashed sphere has no tip — the reference's ears are rounded TRIANGLES with a
 * point at the top, wide at the base, and the point is 30% of the read. Built
 * about its own base so the ear joint's rotation is the flick.
 */
export function earGeometry(inner: boolean): THREE.BufferGeometry {
  const R = RACCOON
  const b = new MeshBuilder()
  // WIDER AND TALLER than it was, because the reference's ear carries a pale RIM
  // and a small pale patch at the base is not a rim. At 0.70 of the outer ear the
  // inner shell covered about half the ear's face and the pale read as a notch;
  // at 0.86 it fills most of it and the fur shows as a border all the way round,
  // which is the reference's shape.
  //
  // The inner ear is still SHORTER in proportion as well as smaller, so it stops
  // below the tip. Sharing the outer's aspect made the two tapers so nearly
  // parallel that the inner's front face broke through the outer's by 0.002 m
  // along its whole length — which renders as a pale wedge slicing a diagonal
  // notch out of the ear, i.e. as a torn ear rather than as an inner ear.
  const r = inner ? R.ear * 0.86 : R.ear
  const h = r * RACCOON.earAspect * (inner ? 0.88 : 1)
  const STATIONS = 5
  const rings: Vec3[][] = []
  for (let i = 0; i < STATIONS; i++) {
    const t = i / (STATIONS - 1)
    // Wide at the base, pinching to a rounded point. `1 - t^1.7` keeps the
    // lower half broad, which is the reference's silhouette; a linear taper is
    // a cone.
    const rad = r * (1 - t ** 1.7) ** 0.62
    const r0 = ring(9, Math.max(0.004, rad), 0)
    rings.push(r0.map((p) => [
      p[0],
      t * h,
      // The inner ear is a shallow SHELL sitting clearly proud of the front of
      // the ear, not a solid tucked just inside it.
      p[2] * (inner ? 0.3 : 0.42) - (inner ? R.ear * 0.34 : 0),
    ] as Vec3))
  }
  loft(b, rings, { closed: true, capStart: !inner, capEnd: true, flat: false })
  return b.build()
}

/**
 * The torso's profile: (height above the spine, half-width, DEPTH multiplier).
 * The first two are in `body` units; the third scales the fore-aft radius
 * against the half-width at that station. Shared with `bibGeometry`.
 *
 * THE DEPTH IS ITS OWN CURVE, and it took fitting the SIDE view to find that.
 * Measured against the sheet's side silhouette, the head matched within 0.06 at
 * every row and the body was 0.27 to 0.47 too WIDE below the chest — because a
 * seated raccoon is deep at the chest and narrows fore-aft toward the haunches,
 * while the build swept one circular profile with a constant 1.06 depth scale.
 * A form that is correct in the front view can be wrong in the side view by half
 * its width and nothing in the front view will ever say so.
 *
 * AND THE WHOLE CURVE IS SHALLOW. The sheet's DEEPEST row in side view is the
 * HEAD, not the body: with the ruff and the snout the head measures 1.00 and the
 * chest below it only 0.55-0.62. The build had them equal, so its body was as
 * deep fore-aft as it was — a rotund barrel where the sheet has a broad but
 * comparatively flat seated chest. Every multiplier is scaled to 0.58 of what it
 * was, which puts the body at about 0.6 of the head's depth.
 *
 * Within that, depth still peaks at the chest (station 2.50) and falls to 0.50
 * at the base, so the haunches taper the way a seated animal's do.
 *
 * IT IS AN EGG. Not a cone, which is what it was, and not a barrel, which is
 * what it briefly became — a straight-sided cylinder that rendered as a DUSTBIN
 * with a ball balanced on it. The sheet's body is widest at about 45% of its
 * height and tapers in both directions, gently to the shoulders and harder to
 * the haunches.
 *
 * The barrel came from a measurement I trusted too far, and the measurement was
 * broken: see the note in tools/raccoon-profile.mjs about the tail.
 *
 * IT DOES NOT REACH THE BOX FLOOR, AND THAT IS DELIBERATE. The sheet's body is
 * as wide as it is tall. Ours has to sit in a box whose interior half-width is
 * 0.785 m with two animals at +/-0.37, which caps a body at 0.38 m of half-width
 * — so a body that also spanned the full 1.12 m from the box floor to the head
 * would be 0.55 as wide as tall, which is a rugby ball, and that is exactly what
 * it rendered as. The two proportions cannot both hold.
 *
 * What resolves it is that everything below station 2.19 is INSIDE THE BOX and
 * never seen, so the body does not have to reach the floor. It is a compact egg
 * 0.76 m tall and 0.76 m wide — the sheet's proportion exactly — hung from the
 * head with its base floating 0.42 m above the floor, where the box hides it.
 * The model is a bust, because the game only ever shows a bust. `tools/raccoon-profile.mjs` samples the front silhouette's width at 24
 * rows and normalises each image to its own widest row; against the sheet the
 * build came back NARROWER almost everywhere — rows 12-21, the body, at 0.67-0.79
 * against the sheet's 0.85-0.99 — while the overall aspect ratio matched to
 * within 0.013. Total proportion right, DISTRIBUTION wrong: the sheet holds near
 * its maximum width for most of its height and the build pinched between masses,
 * which is the numeric form of "it reads as stacked circles". The profile now
 * holds 1.00-1.08 from station -0.30 to 2.10.
 *
 * THE FULLNESS IS ALSO AT THE RIM, and that is a gameplay constraint rather than
 * an anatomical one. The box rim sits 0.985 m
 * above the seat, which is 2.19 in `body` units — so everything below station
 * 2.19 is INSIDE THE BOX and never seen. The first profile put its widest point
 * at station 0.95, i.e. 0.43 m under the rim, and the only part of the body the
 * player could ever see was the narrow neck above it. That is why the shoulders
 * read as pinched in every capture while the profile looked correct in source.
 *
 * THE CROSS-SECTION IS A WIDE SHALLOW ELLIPSE, NOT A CIRCLE, and that came out
 * of measuring the sheet's two views against each other rather than either one
 * alone. Peak silhouette widths, in the sheet's own pixels:
 *
 *   front   head 243   body 240      head/body 1.01
 *   side    head 234   body 142      head/body 1.65
 *
 * So the HEAD is near-spherical (234 deep against 243 wide, 0.96) and the BODY
 * is barely more than half as deep as it is wide (142 against 240, 0.59). The
 * build had the body at 0.83 — nearly round — which is why the side view read as
 * a ball on a slab while the front view was fitted to within 0.12 a row. A
 * single-view profile cannot see this: depth is invisible from the front and
 * width is invisible from the side, and the error lives in the RATIO between
 * them. Two orthographic views is the minimum for a cross-section.
 *
 * The depth column is therefore nearly flat where the width column is not: the
 * sheet's side silhouette holds 126-146 px from the neck to 78% of the height,
 * a 1.16x variation, against the front's widths which sweep 1.9x. Depth per
 * station is set so the PRODUCT `rad * depth` is roughly constant through the
 * middle and tapers only at the base, which is what a constant-depth column
 * with a wide waist actually requires.
 *
 * Widening the body by 1.10 does not move the front aspect ratio at all, because
 * the head is still the widest thing in that view and the aspect is a bounding
 * box. It moves the ROWS, which is where the error was. Round 22's lesson,
 * applied on purpose this time.
 */
/*
 * THE DEPTH COLUMN IS x1.41 THROUGHOUT, and the reason it took thirty rounds is
 * that the number arguing against it was measured through a clipped crop.
 *
 * `SHEET_BOXES.side` cut the torso off at x 1040 — see `raccoon-profile.mjs` —
 * so the sheet's BODY read shallower than it is while its HEAD, whose rightmost
 * is 1037, read correctly. Every body-relative depth on that image was therefore
 * biased down, including the head/body depth ratio: 1.65 as measured, about
 * **1.16** once the crop reaches the real body/tail seam at 1120.
 *
 * The build was at 1.628 and the corrected side profile put its body rows 0.13
 * to 0.27 short — 0.60-0.62 of the head's depth where the sheet runs 0.77-0.87.
 * So `head 0.802 / 1.16 = 0.691` against a body depth of 0.491 gives x1.41.
 *
 * ROUNDS 27 AND 28 BOTH DECLINED THIS CHANGE and both were reasoning from the
 * bad ratio: round 27 held the neck's depth only as far as the body's own maximum
 * "so head/body depth stays at 1.628 rather than collapsing toward 1.1", and 1.1
 * is very nearly the right answer. The lesson is not that the caution was wrong —
 * it is that a ratio guarding a change should be checked as hard as the change.
 *
 * The box has room: half-depth goes 0.246 -> 0.346 about a seat near z -0.16,
 * against a front interior at about z -1.18, and the two occupants are separated
 * in x rather than z so they cannot meet.
 */
const BODY_STATIONS: readonly [number, number, number][] = [
  [0.73, 0.61, 1.029],
  [1.05, 0.94, 0.860],
  [1.40, 1.12, 0.832],
  [1.75, 1.19, 0.832],   // widest across, at about 47% of the body's height
  [2.10, 1.17, 0.846],
  // A WAIST, REVERSING THE "NO WAIST" NOTE THAT USED TO SIT HERE — and the note
  // was not wrong, it was guarding a condition this shape does not breach.
  //
  // ITS ARGUMENT WAS: the skull closes toward its underside, so a body arriving
  // narrower than the cranium pinches inside it and flares out below, and that
  // step is the clearest "two primitives" tell there is. True, and the guard is
  // real. But the failure needs an ABRUPT skull edge for the body to pinch
  // inside of, and there is none: both the sphere and the ruff's lowest ring
  // taper to nothing at the pole, y 1.105. Between 1.14 and 1.32 the body simply
  // runs INSIDE the skull and is hidden, the skull's own profile carries the
  // silhouette down through its collapse, and the body emerges below it. The
  // outline stays continuous — `tools/raccoon-outline.mjs` is what checks that,
  // and a STEP rather than a dip is the failure to watch for.
  //
  // THE SHEET HAS THE WAIST, measured at 144 rows: its front silhouette falls
  // 0.918 -> 0.713 -> 0.902 over nine rows. Converted into this model's metres
  // through the HEAD FRACTION rather than by row index — 57% here against the
  // sheet's 48%, because this is a bust and the sheet has feet, see
  // `raccoon-profile.mjs` — the target is
  //
  //   y      1.211  1.189  1.166  1.144  1.122  1.101  1.078  1.056  1.025
  //   sheet  0.383  0.380  0.326  0.295  0.309  0.322  0.336  0.349  0.373
  //   skull  0.396  0.403  0.353  0.273   ...closing to the pole at 1.105
  //
  // so the skull owns the top of the dip (and is only 0.02-0.03 over it) and the
  // BODY owns everything below y 1.15, where it was 0.04-0.08 too wide. A
  // previous attempt put this in `HEAD_TAPER` at y 1.24-1.27 — the jaw — off the
  // raw row index, and narrowed the skull where the mouth sits.
  //
  // h = (y - 0.2192) / 0.3504 and x = 0.3504 * rad, which is how these were
  // solved rather than dialled. Station 2.10 is deliberately untouched: the
  // body's DEPTH extent peaks at h 1.75-2.10 and sets the head/body depth ratio,
  // which is already 1.628 against the sheet's 1.65 and has nothing to give.
  //
  // THE DEPTH COLUMN IS RE-SOLVED FOR THE NARROWED RAD, because `depth`
  // MULTIPLIES `rad` and the waist above took the neck's fore-aft depth down
  // with its width — half-depth 0.244 -> 0.189 at h 2.64, which no front-view
  // measurement can see. The side silhouette, aligned on its own landmarks (ear
  // tip and deepest point), read y 1.185 at 0.549 against a target of 0.732: the
  // single worst row in either view.
  //
  // A NECK IS NARROW ACROSS AND STILL DEEP FORE-AFT, which is the whole reason
  // these are two columns (round 23). Each value below is `pre * rad_old /
  // rad_new`, i.e. exactly the multiplier that holds the previous half-depth
  // through the new width — 0.2446, 0.2443 and 0.2400 against the body's own
  // maximum of 0.246 at h 1.75-2.10. Staying just under that maximum is
  // deliberate: it leaves the body's depth EXTENT untouched, so head/body depth
  // stays at 1.628 rather than collapsing toward 1.1.
  //
  // AND THE RATIO IS WHY THIS WAS MISSED. head/body depth held at 1.628 across
  // the waist change and looked like proof nothing had moved. It is a ratio of
  // two EXTENTS and is blind to the shape between them — the same trap as the
  // side ASPECT approving a head leaned off the front of the body in round 22.
  [2.30, 1.064, 0.925],
  [2.45, 0.959, 1.025],
  [2.64, 0.845, 1.144],   // the neck: narrowest across, still deep fore-aft
  [2.90, 0.850, 1.111],
  [3.15, 0.860, 1.015],   // up inside the cranium, fully covered
]

/**
 * The CHEST BIB: a pale cream shell down the front of the body.
 *
 * The second reference sheet's front view makes this one of the raccoon's
 * largest markings — a broad light region running from under the chin all the way
 * down the belly, bounded by the darker flank fur — and the build had nothing
 * there at all. On a character whose body is 40% of its on-screen area, a
 * missing marking that covers half of that body is the single biggest remaining
 * difference from the sheet.
 *
 * IT FOLLOWS THE BODY'S OWN PROFILE, the same trick that finally made the ruff
 * work: rings taken from `BODY_STATIONS` and pushed out a hair, so the shell
 * hugs by construction and cannot float or sink however the torso is retuned.
 * Only the front arc is built — a full ring would be a stripe round the whole
 * animal — and its half-angle narrows toward the neck, which is the shape the
 * sheet draws.
 */
export function bibGeometry(): THREE.BufferGeometry {
  const R = RACCOON
  const b = new MeshBuilder()
  const SEG = 14
  const hLo = (BODY_STATIONS[0] as [number, number, number])[0]
  const hHi = (BODY_STATIONS[BODY_STATIONS.length - 1] as [number, number, number])[0]
  const rings: Vec3[][] = BODY_STATIONS.map(([h, rad, depth]) => {
    // KEYED OFF HEIGHT, NOT STATION INDEX. This was `i / (length - 1)`, so
    // adding the waist stations below the neck would have slid the bib's throat
    // down the body without anything erroring — the same silent failure the tail
    // hit twice when a constant outlived the count it was derived from. Any
    // number derived from a count has to be written as a function of it.
    const t = (h - hLo) / (hHi - hLo)
    // Wide across the belly, narrowing to a throat. `t` runs bottom to top.
    const half = 1.15 - t * 0.45
    const out: Vec3[] = []
    for (let k = 0; k < SEG; k++) {
      const u = -half + (k / (SEG - 1)) * half * 2
      const r = R.body * rad * 1.015
      out.push([Math.sin(u) * r, R.body * h, -Math.cos(u) * r * depth])
    }
    return out
  })
  // Open strip, not a closed ring, and smooth so it shades with the body.
  loft(b, rings, { closed: false, flat: false })
  return b.build()
}

/**
 * The torso: a lofted, slightly tapered mass — NOT two stacked spheres.
 *
 * What was here was a sphere for the torso and a second, smaller sphere for the
 * shoulders, and rendered in isolation the pair read as exactly that: a snowman,
 * with a hard crease where the two spheres met and another where the head sphere
 * landed on top of them.
 *
 * The reference's body is one straight-sided mass, narrower than the head's ruff
 * and running more or less vertically down into the box. That relationship is
 * the point: the RUFF is the widest thing on the character, so the body has to be
 * narrower than it or the silhouette inverts and the head looks pinched. At
 * `body` 0.35 against the ruff's 1.26 * 0.29 * 1.06 = 0.387 half-width, the ruff
 * wins by 0.04 — narrow, and on the right side.
 *
 * Lofted from one profile so there is no internal crease, closed at the bottom
 * (the box floor is under it and nothing sees the cap) and OPEN at the top,
 * where the ruff hangs over the join. That open top is what removes the snowman
 * seam: the head does not sit ON the body, its ruff comes down OVER it.
 */
export function bodyGeometry(): THREE.BufferGeometry {
  const R = RACCOON
  const b = new MeshBuilder()
  const SEG = 20
  // (height above the spine, half-width as a multiple of `body`)
  // THE TOP STATION REACHES INTO THE HEAD. This is the fix for the single worst
  // thing in the first isolated turnaround: the body's crown was at 0.85 above
  // the seat and the skull's underside at 1.15, so there was a 0.30 m GAP and the
  // head floated over the torso. In a game capture the box hides the gap and the
  // ruff distracts from it; on a clean turnaround it is the first thing you see,
  // and it is most of why the model read as stacked spheres. At 2.90 in `body`
  // units the neck reaches 1.235 — 0.085 m INSIDE the skull — so the two forms
  // interpenetrate and the ruff hangs over the join.
  // THE FULLNESS IS AT THE RIM, not at the middle of the torso, and this is a
  // gameplay constraint rather than an anatomical one. The box rim sits 0.985 m
  // above the seat, which is 2.19 in `body` units — so everything below station
  // 2.19 is INSIDE THE BOX and never seen. The first profile put its widest
  // point at station 0.95, i.e. 0.43 m under the rim, and the only part of the
  // body the player could ever see was the narrow neck above it. That is why the
  // shoulders read as pinched in every capture while the profile looked correct
  // in the source.
  const rings = BODY_STATIONS.map(([h, rad, depth]) => ring(SEG, R.body * rad, R.body * h)
    .map((p) => [p[0], p[1], p[2] * depth] as Vec3))
  // Bottom-to-top faces outward; capped at the base only.
  // CAPPED AT BOTH ENDS. Open at the top it read as a bucket — you see the
  // interior wall, because the painterly material is single-sided and the near
  // face of a hollow form is culled. The ruff hangs over the join either way, so
  // the cap costs 18 triangles and nothing sees it.
  loft(b, rings, { closed: true, capStart: true, capEnd: true, flat: false })
  return b.build()
}

/**
 * A limb bone: a tapered capsule spanning y 0..-1 in its own space, so an
 * instance scaled to the bone's length IS the bone.
 *
 * One geometry serves the upper arm and the forearm, at different scales — eight
 * instances of one shape instead of two batches of four. The taper is authored
 * thin-at-the-bottom, which is right for both: an upper arm narrows to the
 * elbow and a forearm narrows to the wrist.
 */
export function limbGeometry(radius: number): THREE.BufferGeometry {
  const b = new MeshBuilder()
  // ROUNDED AT BOTH ENDS. This was a flat-capped tapered cone, and the critic
  // saw the result before I did: "thin spiky triangular slivers clipping through
  // the belly fur near the paws". Two bones per arm, each a cone with a flat cut
  // across its narrow end, meeting at an elbow with no joint between them — so
  // an arm was four sharp wedges radiating from the chest rather than a limb.
  //
  // A capsule fixes both halves of that. The rounded ends mean consecutive bones
  // OVERLAP into a continuous form instead of butting flat faces together, so the
  // elbow needs no joint ball of its own and the shoulder none either; and a
  // limb that ends in a dome reads as a limb, where one that ends in a point
  // reads as a spike whatever its length.
  //
  // Identified by elimination, not by looking: the shards were attributed to the
  // coat first (wrong — flagging the coat magenta showed it is not in the frame
  // at all) and then to the paws' digits (wrong — flagging `furDark` magenta lit
  // the paws and left the shards dark). Two builds to rule out two hypotheses,
  // which is cheaper than three more rounds of guessing at a 30-pixel feature.
  const STATIONS = 9
  const CAP = 0.18
  const rings: Vec3[][] = []
  for (let i = 0; i < STATIONS; i++) {
    const t = i / (STATIONS - 1)
    // Taper along the bone: a wrist must stay narrower than the paw on it.
    const taper = radius * (1 - t * 0.55)
    // Hemispherical rounding over the first and last CAP of the length.
    const e = Math.min(1, t / CAP, (1 - t) / CAP)
    const r = taper * Math.sqrt(Math.max(0, 1 - (1 - e) ** 2))
    rings.push(transformRing(ring(8, Math.max(1e-4, r), 0), 0, -t, 0))
  }
  loft(b, rings, { closed: true, flat: false })
  return b.build()
}

/**
 * A paw: a small palm with four short digits, near-black.
 *
 * The digits are the point. In the front view the passenger's paws are two tiny
 * shapes hooked over the box rim, and what makes them read as HANDS at that size
 * is four separate dark lobes breaking the silhouette — a plain dark ball on a
 * kraft rim is a bolt. Merged, so a paw is still one instance.
 *
 * Built about the wrist with the digits pointing -Y (down the limb's axis) and
 * curled forward, which is the grip pose; the arm IK aims the whole thing, so
 * the paw never needs its own rotation.
 */
export function pawGeometry(): THREE.BufferGeometry {
  const R = RACCOON
  const palm = ball(R.paw, 10)
  palm.scale(1.1, 0.86, 1.0)
  const parts: THREE.BufferGeometry[] = [place(palm, 0, -R.paw * 0.5, 0)]
  const DIGITS = 4
  for (let i = 0; i < DIGITS; i++) {
    const t = (i / (DIGITS - 1)) * 2 - 1
    const g = ball(R.paw * 0.34, 7)
    g.scale(1, 1.5, 1)
    parts.push(place(
      g,
      t * R.paw * 0.66,
      -R.paw * 1.22,
      -R.paw * 0.34 - (1 - t * t) * R.paw * 0.14,
      0.5, 0, 0,
    ))
  }
  return mergeGeometries(parts)
}

/**
 * How fat the tail is at station `t`, 0 at the root and 1 at the tip.
 *
 * A BUSHY TAIL IS NOT A TAPERED LIMB, and that distinction is the whole reason
 * this function exists rather than a lerp. Six independent observers looking at
 * the gameplay frame have read this tail as an arm — variously "a raised arm
 * with a cuff", "a prop", and most recently "the paw/arm gripping each box side,
 * rich brown-red with a cream cuff, reading clearly at 8% of frame width", which
 * is the tail described accurately and named wrongly. It is prominent. It is
 * legible. It is not legible AS A TAIL.
 *
 * Three things made it limb-shaped and the taper was the biggest: a steady
 * linear narrowing from root to tip is exactly an arm's silhouette. A raccoon's
 * tail stays FAT for most of its length and pinches only near the end, so the
 * profile is flat-then-falling — `1 - 0.5 * t^2.2` holds 0.92 of full thickness
 * at the halfway point and 0.5 at the tip. The root radius went up with it, from
 * 0.15 to 0.185, so the tail is unambiguously thicker than the 0.127 m arm
 * beside it rather than a shade over.
 */
export function tailProfile(t: number): number {
  return 1 - (1 - RACCOON.tailTaper) * t ** 2.2
}

/**
 * One tail segment: a ball, sized for its station.
 *
 * A tail is a chain of these and the RINGS ARE THE MATERIAL, not the geometry —
 * even segments draw in `fur`, odd ones in `furDark`, so the banding costs two
 * batches and no extra vertices. That is why the segment count is odd (five):
 * it puts fur at both the root and the tip with dark bands between, which is
 * what a raccoon's tail does, rather than ending on a band.
 *
 * Slightly elongated along its own axis so consecutive segments overlap into a
 * continuous tube instead of reading as beads.
 */
export function tailGeometry(radius: number): THREE.BufferGeometry {
  const g = ball(radius, 12)
  // 1.5 ALONG THE CHAIN, not 1.24, and the constraint is the TIP rather than the
  // root. Segments sit 0.25 m apart and taper to 0.62 of the root radius, so at
  // the tip a 0.093 m ball elongated 1.24 has a 0.115 m half-length and its
  // neighbour 0.143 — summing to 0.258 against a 0.25 m spacing, i.e. touching
  // and not overlapping. The root segments merged fine and the last two read as
  // separate BEADS, which turns a tail into a string of pearls exactly where it
  // is thinnest and most visible against the sky. At 1.5 every pair overlaps
  // with room to spare, including when the chain bends.
  g.scale(0.94, 0.94, 1.5)
  return g
}

/**
 * The steering wheel, in KART space — it is bolted to the box, not to a
 * raccoon, and the driver's paws come to IT.
 *
 * A torus plus a hub plus two lower spokes, which is what the reference draws:
 * the rim is a fat ring, the spokes come off the bottom in a shallow V, and
 * there is no top spoke. Built in the XY plane with the axis along Z, then
 * tilted by the caller, so a rotation about Z is the steer.
 */
export function helmGeometry(radius: number, thickness: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    new THREE.TorusGeometry(radius, thickness, 8, 20),
  ]
  // THE HUB AND SPOKES ARE HALF THE SIZE THEY WERE, and darkening the surface was
  // not enough on its own. They are FLAT SLABS facing the sky, so every one of
  // them selects the material's `lit` stop over its whole area at once while the
  // torus beside them takes a range — measured, they rendered as the brightest
  // thing on the whole vehicle and read as a strip of sticking plaster across the
  // driver's chest. A curved form cannot do that, and a small one cannot do it
  // over enough pixels to matter: the hub is 0.024 m instead of 0.048, and the
  // spokes are thinner, shorter and set into the lower half where the rim's own
  // shadow falls across them.
  const hub = new THREE.CylinderGeometry(radius * 0.12, radius * 0.12, thickness * 1.2, 10, 1)
  parts.push(place(hub, 0, 0, 0, Math.PI * 0.5, 0, 0))
  for (const side of [-1, 1] as const) {
    const spoke = new THREE.BoxGeometry(radius * 0.08, radius * 0.7, thickness * 0.7)
    parts.push(place(spoke, 0, -radius * 0.45, 0, 0, 0, side * 0.46))
  }
  // THE COLUMN. Without it the wheel is a ring hanging in front of a chest with
  // nothing holding it up — the critic read it as floating, and they were right:
  // there was no geometry at all between the hub and the box. It runs along the
  // helm's own +Z, which the 0.5 rad rake carries forward and down into the front
  // wall, so it lands where a column taped into a cardboard box would.
  const column = new THREE.CylinderGeometry(radius * 0.09, radius * 0.11, radius * 1.3, 8, 1)
  parts.push(place(column, 0, 0, radius * 0.62, Math.PI * 0.5, 0, 0))
  return mergeGeometries(parts)
}

/**
 * The cartoon exclamation mark, as a flat billboard glyph in the XY plane.
 *
 * A tapering bar over a round dot, doubled — see the winding note inside, which
 * is the one thing about this function that is not obvious.
 *
 * Origin at the glyph's centre so a scale pop is centred on it.
 */
export function alertGeometry(height: number, outline: boolean): THREE.BufferGeometry {
  const b = new MeshBuilder()
  // PROPORTIONS ARE THE WHOLE READ, and the first set was too loose: measured on
  // car-fall, the gap between the bar's foot and the dot's crown was 0.17 of the
  // glyph's height against a dot only 0.26 across, so at 40 px the two halves
  // read as two unrelated red marks — one floating in the sky and one sitting on
  // a raccoon's head. A comic exclamation is a TIGHT stack: a fat tapering bar,
  // a small gap, a bold dot. 0.07 of gap, and the bar is a third wider.
  const barTop = height * 0.5
  const barBot = height * 0.02
  const wTop = height * 0.25
  const wBot = height * 0.14
  const v = (x: number, y: number, z: number): Vec3 => [x, y, z]
  // THE GLYPH FACES -Z, and that is not a preference — `Matrix4.lookAt(eye,
  // target, up)` builds a frame whose -Z axis points at the target, so the
  // billboard in kart.ts turns this geometry's -Z toward the camera. Authored
  // facing +Z, the first version rendered as a red BAR WITH NO DOT: the bar's
  // quad happened to be wound clockwise-from-+Z and the dot's fan
  // counter-clockwise, so exactly one of the two survived back-face culling.
  // Nothing in the frame says "half your glyph is culled" — it says "the dot is
  // missing", which reads as a geometry bug in the dot. Third time this project
  // has lost geometry to winding (the ocean sheet, the face markings, this), so
  // `tools/raccoon.mjs` checks it.
  const FRONT: Vec3 = [0, 0, -1]
  // One copy per call: the FILL at 1.0, or the KEYLINE at 1.22 and 8 mm behind.
  // They are separate geometries because they are separate surfaces — see the
  // note in kart.ts on why an outline in the fill's own colour is not an outline.
  for (const s of outline ? [1.22] : [1.0]) {
    // The larger copy is an OUTLINE, 8 mm behind, in the same flat red. It is
    // not a contrasting keyline — it thickens the silhouette against the sky
    // without a second material. A comic exclamation needs weight, and a bar
    // thin enough to look right at 2 m vanishes at 20.
    const z = outline ? 0.008 : 0
    // Wound counter-clockwise seen from -Z, i.e. front-facing for the billboard.
    // Top-left, top-right, bottom-right, bottom-left. Its cross product is -Z
    // because the loop descends: cross_z = 2w*(bot - top) and bot < top. The
    // OTHER order looks like the right one and is not — the winding check caught
    // that on the first attempt at this fix, which is what the check is for.
    b.polygon([
      v(-wTop * 0.5 * s, barTop * s, z),
      v(wTop * 0.5 * s, barTop * s, z),
      v(wBot * 0.5 * s, barBot * s, z),
      v(-wBot * 0.5 * s, barBot * s, z),
    ], FRONT)
    const dotR = height * 0.15 * s
    const dotY = -height * 0.2 * s
    const dot: Vec3[] = []
    for (let i = 0; i < 12; i++) {
      const a = -(i / 12) * Math.PI * 2
      dot.push(v(Math.cos(a) * dotR, dotY + Math.sin(a) * dotR, z))
    }
    b.polygon(dot, FRONT)
  }
  return b.build()
}

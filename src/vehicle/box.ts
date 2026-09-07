// The cardboard box, as FORM.
//
// This file exists because of a specific critique, and the critique was right:
// the box and the meadow were "visibly one material with a hue swap". Both were
// the shared painterly brush field at the same on-screen frequency, so the deck
// came out as a two-tone amoeba camouflage with the same blob shape and the same
// blob size as the grass 40 m behind it.
//
// The authored `brushScale` could not fix that on its own. `painterly.ts`
// selects its brush octave by PROJECTED SIZE (see `STROKE_PX`), so every surface
// in the game gets a ~13 px mark whatever it authors — that is the right rule
// for terrain, and it means a prop cannot differentiate itself with the noise
// knobs alone. Two things follow, and this file is the second:
//
//   1. `cardboard.json` stops trying. brushStrength drops to a fifth, the region
//      selector is switched almost off, and `brushScale` is raised far enough
//      that the ladder clamps at its floor, so the box's mottle is world-locked
//      at 0.16 m instead of screen-locked at 13 px. The paint layer becomes
//      paper mottling instead of camouflage.
//   2. The cardboard read moves into GEOMETRY, where the ART_BIBLE says detail
//      belongs anyway ("detail lives in the light, not the geometry" — and a
//      flute IS form that lights, not texture). Five things, all of which the
//      critique named as missing:
//
//        corrugation   vertical flutes across all four walls
//        flute edge    a scalloped corrugated cut along every flap's free edge
//        fold crease   a raised crease spine down each of the four box corners
//        tape          a band wrapping the girth, and a strip under the base
//        printed mark  this-way-up arrows, a shipping label, a stencil block
//
// All of it is merged down: the flutes and creases become part of the shell
// geometry, the scallops part of the flap geometry, so the whole dressing costs
// two extra draw calls (tape, ink) and about 9k triangles. The kart is drawn
// five times a frame — once for the frame, once per shadow cascade — so a draw
// call saved here is worth five.
//
// THE BOX IS OPEN. That is not a detail, it is the whole vehicle: two raccoons
// stand IN it, the flaps are splayed out at the rim, and the chase camera looks
// down into it for the entire game. The first version got this half right — the
// flaps were hinged open — while the shell underneath was still a CLOSED
// rounded box, so a lid sat across the opening with the occupants sticking
// through it, taped shut, with a shipping label on top. Reported as "the
// cardboard box is open but i still see cover", and it was exactly that.
//
// The shell is therefore a TUB, not a box: outer wall, rolled rim showing the
// board's real thickness, inner liner, and a floor. The liner is not optional —
// the painterly material is single-sided, so an opening with no liner is a hole
// you can see the meadow through. And the tape and the print had to move with
// it: a strip down a lid seam and a band over the lid are both drawing a lid
// that no longer exists, so the tape is now a waist band round all four walls
// (still crossing every corner fold, which was the point of it) plus a strip
// under the base, which is where the tape on a real box actually is.
//
// Every number is in metres, in BOX-LOCAL space: the origin is the centre of
// the box, so +y/2 is the RIM and +z is the rear (the car drives toward -z).

import * as THREE from 'three/webgpu'
import { mergeGeometries, place, roundedBox } from './geometry'
import { MeshBuilder, loft, roundedRect } from '../assets/mesh'

/**
 * Board specification. A real C-flute is 8 mm, which at the chase camera is
 * under two pixels on a 1.7 m box — it would alias into a shimmer and read as
 * nothing. These are the stylised numbers: ~0.13 m puts a flute at roughly
 * 30 screen pixels at the framing the car shots use, which is comfortably
 * coarser than the 13 px the shared brush ladder pins every other surface to.
 * That gap is the point — it is what stops the box sharing a frequency with the
 * grass behind it.
 */
export const BOARD = {
  /** Flute period across a wall. */
  flutePitch: 0.132,
  /**
   * How far a flute stands proud of the liner.
   *
   * Shallow, and that is the whole difference between corrugation and a crate.
   * The first pass used 0.012 m on a 0.032 m cylinder sunk into the wall, which
   * looked like it should overlap its neighbours and did not: a cylinder of
   * radius R sunk to depth R-rise only breaks the surface over a half-width of
   * sqrt(R^2-(R-rise)^2) = 0.033 m, a quarter of the pitch, so three quarters of
   * the wall stayed flat liner and the flutes read as a picket fence.
   *
   * `fluteArc` below solves for the radius that makes that half-width exactly
   * half the pitch, so the arcs meet edge to edge and the wall is one
   * continuous wave.
   */
  fluteRise: 0.01,
  /**
   * Board thickness, shown at the open rim.
   *
   * Real board is 4 mm and would be invisible; 0.075 m puts the rim at ~13
   * screen pixels at the chase framing, which is enough to read as an EDGE
   * rather than as a paper cut. It also matches `FLAP.thick` in kart.ts (0.07),
   * because the flaps are folded out of this same board and a flap noticeably
   * thinner than the wall it hinges off looks like a modelling mistake.
   */
  thickness: 0.075,
  /** Fold crease down a box corner: taller and rounder than a flute. */
  creaseRadius: 0.05,
  creaseRise: 0.012,
  /**
   * Period of the corrugation exposed along a cut flap edge. Finer than the
   * wall flutes: a flap is seen edge-on from the chase camera as often as
   * face-on, and at 0.115 m the crests read end-on as a row of cotton reels
   * rather than as a cut.
   */
  cutPitch: 0.086,
  /** Radial segments on a flute. 8 is enough: the silhouette is never seen. */
  segments: 8,
} as const

/**
 * Where the exhaust is taped on. One wall only — the sheet strings it along a
 * single side and a symmetric pair would read as a design feature rather than as
 * something scrounged.
 */
export const EXHAUST = { x: 1, y: -0.24, z: -0.05 } as const

/** Deterministic 0..1 hash. No Math.random in generation, ever. */
function hash(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return x - Math.floor(x)
}

/** Evenly spaced positions spanning [-half, +half], inclusive of both ends. */
function span(half: number, pitch: number): number[] {
  const n = Math.max(2, Math.floor((half * 2) / pitch) + 1)
  const step = (half * 2) / (n - 1)
  const out: number[] = []
  for (let i = 0; i < n; i++) out.push(-half + i * step)
  return out
}

function rod(radius: number, length: number): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(radius, radius, length, BOARD.segments, 1)
}

/**
 * One flute: a shallow arc strip standing `rise` proud of the liner over
 * exactly one pitch, facing +Z, centred on the origin.
 *
 * The radius is solved rather than authored — see `fluteRise`. Only the arc
 * that actually breaks the surface is built (an open partial cylinder), so a
 * flute is 12 triangles instead of a 40-vertex cylinder mostly buried in the
 * wall, and all of its tessellation goes where it is visible. Neighbours meet
 * exactly at the liner plane, so the strip needs no end caps and no seam shows.
 */
function fluteArc(pitch: number, rise: number, length: number): {
  geo: THREE.BufferGeometry
  /** How far the arc's axis sits BEHIND the liner plane. */
  sunk: number
} {
  const a = pitch * 0.5
  const radius = (a * a + rise * rise) / (2 * rise)
  const half = Math.asin(Math.min(1, a / radius))
  const geo = new THREE.CylinderGeometry(
    radius, radius, length, BOARD.segments, 1, true, -half, half * 2,
  )
  return { geo, sunk: radius - rise }
}

/**
 * The box shell: an OPEN TUB — outer wall, rolled rim, inner liner, floor —
 * plus vertical flutes across all four walls and a raised fold crease down each
 * corner.
 *
 * Built from a rounded-rectangle profile lofted between rings rather than from
 * `roundedBox`, because there is no way to take the top off a projected
 * `BoxGeometry` and be left with a rim that has thickness. The profile route
 * gives all four surfaces from one outline, so the liner cannot drift out of
 * register with the wall it lines.
 *
 * The flutes are cylinders sunk into the liner so only `fluteRise` shows. That
 * is cheaper than displacing a subdivided box (which would need ~80 segments
 * across the deck to carry the wave) and it gives the same thing the reference
 * needs: a hard, regular, DIRECTIONAL light break, which is the one signal no
 * isotropic noise field can produce.
 *
 * They stop short of the rim and the floor, because a flute stops at a fold in
 * real board too.
 */
export function boxShellGeometry(
  w: number, h: number, d: number, r: number,
): THREE.BufferGeometry {
  const hx = w * 0.5
  const hy = h * 0.5
  const hz = d * 0.5
  const t = BOARD.thickness
  // Where the rounding starts, i.e. where the flat liner ends.
  const ix = hx - r
  const iz = hz - r
  const rise = hy - r * 0.85

  // ── the tub ─────────────────────────────────────────────────────────────
  // Ring order is load-bearing: `roundedRect` winds counter-clockwise in XZ, so
  // lofting top-ring-then-bottom-ring faces OUTWARD and bottom-then-top faces
  // inward. Getting either backwards produces a box that is invisible from one
  // side and looks like a rendering bug rather than a winding bug.
  const innerR = Math.max(0.04, r - t)
  const outerTop = roundedRect(hx, hz, r, hy)
  const outerBot = roundedRect(hx, hz, r, -hy)
  const innerTop = roundedRect(hx - t, hz - t, innerR, hy)
  const innerFloor = roundedRect(hx - t, hz - t, innerR, -hy + t)
  const tub = new MeshBuilder()
  // Bottom-to-top faces outward (see `loft`); the liner is the same profile
  // walked top-to-bottom, which turns it inside to face the cargo.
  loft(tub, [outerBot, outerTop], { closed: true })
  loft(tub, [innerTop, innerFloor], { closed: true })
  tub.polygon(innerFloor)
  tub.polygonFlipped(outerBot)
  // The rim: a strip across the board's thickness, which is the surface that
  // says "this is open" from every angle the camera ever has.
  for (let i = 0; i < outerTop.length; i++) {
    const j = (i + 1) % outerTop.length
    tub.quad(outerTop[i]!, innerTop[i]!, innerTop[j]!, outerTop[j]!)
  }

  const parts: THREE.BufferGeometry[] = [tub.build()]

  // ── flutes: vertical, across every wall ─────────────────────────────────
  // One arc geometry, cloned and turned onto each wall. `place` composes Euler
  // 'YXZ', and only the yaw is used here, so the turn is a plain rotation about
  // the box's up-axis: +Z as built, then pi, +pi/2 and -pi/2 for the other
  // three walls.
  const flute = fluteArc(BOARD.flutePitch, BOARD.fluteRise, rise * 2)
  const sunk = flute.sunk
  for (const x of span(ix - 0.02, BOARD.flutePitch)) {
    parts.push(place(flute.geo.clone(), x, 0, hz - sunk))
    parts.push(place(flute.geo.clone(), x, 0, -(hz - sunk), 0, Math.PI, 0))
  }
  for (const z of span(iz - 0.02, BOARD.flutePitch)) {
    parts.push(place(flute.geo.clone(), hx - sunk, 0, z, 0, Math.PI * 0.5, 0))
    parts.push(place(flute.geo.clone(), -(hx - sunk), 0, z, 0, -Math.PI * 0.5, 0))
  }
  flute.geo.dispose()

  // ── fold creases: one down each corner, on the 45deg bisector ───────────
  // The corner is already a quarter-cylinder of radius `r`; the crease sits on
  // it, proud by `creaseRise`, so the fold reads as a raised spine catching the
  // key rather than as a dark outline. A dark line would be a cartoon stroke,
  // which is not what any reference in refs/ does.
  const off = (r - (BOARD.creaseRadius - BOARD.creaseRise)) * Math.SQRT1_2
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      parts.push(place(
        rod(BOARD.creaseRadius, rise * 2),
        sx * (ix + off), 0, sz * (iz + off),
      ))
    }
  }
  return mergeGeometries(parts)
}

/**
 * A box flap, hinged at its own origin and spanning y 0..len, with a TORN free
 * edge.
 *
 * THE REGULAR SCALLOP IS GONE, and it was the single most invented shape on the
 * vehicle. The free edge used to carry evenly spaced beads at an 0.086 m pitch —
 * authored as "the corrugation exposed along a cut flap edge", which is a real
 * thing on real board. Two problems with it, and the second is fatal:
 *
 *   IT IS 17x OVERSCALE. Real C-flute is about 5 mm. At 0.086 m the crests are
 *   9.6 px wide at the chase camera, comfortably resolvable, so the eye reads
 *   them as individual objects rather than as a texture.
 *   IT IS PERFECTLY REGULAR, and nothing else on this vehicle is. A row of 31
 *   identical evenly spaced bumps running the whole top perimeter reads as
 *   extruded plastic trim or corrugated tubing — manufactured — which fights the
 *   one thing the box has to say, that two animals tore it off a skip.
 *
 * The reference's flap edges are HAND-TORN: an irregular wavering line with the
 * occasional deeper bite out of it, no repeat anywhere. So the edge is now a
 * jittered tab profile driven by `hash`, with the tab HEIGHTS varying four times
 * as much as their widths — which is what tearing does, because the tear follows
 * the board's own weak points rather than a ruler.
 */
export function flapGeometry(width: number, len: number, thick: number): THREE.BufferGeometry {
  // The tear line sits BELOW the nominal length and what stands proud of it are
  // the tabs the tear left behind. Additive, because `mergeGeometries` merges and
  // cannot subtract — an earlier version of this function claimed to take bites
  // OUT of the edge and was in fact adding boxes at the tip, which would have
  // produced a lip rather than a tear. Same silhouette either way as long as the
  // baseline is dropped to make room, and this version can actually do it.
  // NEARLY SMOOTH NOW, and the reference settled it: THE SHEET TEARS THE TAPE,
  // NOT THE BOARD. Its rear view draws the box's top edge as a smooth line with a
  // soft wavy fold, its folded flap band with a clean lower edge, and the only
  // ragged thing anywhere on the vehicle is the zigzag bottom of a tape patch.
  // The hand-torn board edge was my idea, not the sheet's, and it has been
  // flagged by three separate critiques in three different words — saw-tooth
  // fringe, ribbed pegs, dentil moulding — each time reading as manufactured
  // trim or as a WOODEN crate, which is the one thing this box must not be.
  //
  // What survives is a waver: 0.26 of the board's thickness rather than 1.9,
  // which at 0.018 m is a soft irregularity in the silhouette rather than a row
  // of teeth. The tape keeps its torn ends, where the sheet actually puts them.
  const TABS = Math.max(6, Math.round(width / 0.075))
  const reach = thick * 0.26
  const slab = roundedBox(width, len - reach, thick, 0.03, 2)
  slab.translate(0, (len - reach) * 0.5, 0)
  const parts: THREE.BufferGeometry[] = [slab]
  for (let i = 0; i < TABS; i++) {
    const j = hash(i * 7 + Math.round(width * 100))
    const k = hash(i * 23 + 5)
    // Height varies 4x, width barely at all. Irregular depth over regular
    // spacing is what tearing looks like — the tear follows the board's own weak
    // points, so it wanders in DEPTH while travelling steadily along. Regular
    // depth over irregular spacing reads as damage instead.
    const high = reach * (0.25 + j * 1.0)
    // WIDTH VARIES AS MUCH AS HEIGHT NOW, and that is a correction about which
    // AXIS the viewer sees. A face-on tear reads by its depth profile, so the
    // first version varied height 4x and width barely — correct for the long
    // flaps, which fold flat and are seen face-on. The REAR end flap is seen
    // EDGE-ON from the chase camera for the whole game, and edge-on all you see
    // is the widths: 28 near-identical blocks in a row, which three separate
    // critiques called dentil moulding, ribbed pegs, and a wooden crate.
    // EVERY TAB IS WIDER THAN ITS OWN SPACING, which is what makes the edge a
    // continuous waver instead of a comb. Varying the width around 1.0 of the
    // spacing seemed like the way to make the tear irregular and does the
    // opposite: any tab narrower than the spacing leaves a GAP beside it, so the
    // row acquires visible teeth with sky between them — which is precisely what
    // three critiques kept describing. The irregularity has to live in the
    // OVERLAP, not in whether there is one.
    const wide = (width / TABS) * (1.15 + k * 0.7)
    const x = ((i + 0.5) / TABS - 0.5) * width
    parts.push(place(
      roundedBox(wide, high, thick, 0.012, 1),
      x, len - reach + high * 0.5, 0, 0, 0, (k - 0.5) * 0.28,
    ))
  }
  return mergeGeometries(parts)
}

/** A thin slab lying on a face, `t` metres proud of it. */
function strip(sx: number, sy: number, sz: number): THREE.BufferGeometry {
  return new THREE.BoxGeometry(sx, sy, sz)
}

/**
 * Packing tape: DISCRETE PATCHES, plus the strip under the base.
 *
 * The girth band is gone. It was a continuous loop round all four walls, and the
 * argument for it was sound as far as it went — a band that crosses every corner
 * fold is unmistakably tape, and it was the only element on the kart that
 * crossed a fold. But it is not what the reference does, and the difference
 * matters: `refs/character/raccoon-boxkart-sheet.png` puts three or four SEPARATE
 * strips on each face, at slight angles, with torn ends, in the places a box
 * actually gets taped and re-taped. A continuous band reads as a manufactured
 * stripe — a racing livery — where a scatter of patches reads as a box that has
 * been opened and shut a few times, which is the entire character of the
 * vehicle.
 *
 * Every patch is deterministic from `hash`. No `Math.random` in generation, ever.
 *
 * TORN ENDS ARE THE POINT. A rectangle of tape is a sticker; hand-torn packing
 * tape has a ragged zigzag at both ends, and at the size these are drawn — about
 * 0.2 m on a 2.68 m box — the zigzag is the only thing that says "torn by an
 * animal" rather than "printed on". Each end gets three small triangles cut into
 * it, which is four extra triangles a patch and the cheapest character on the
 * whole kart.
 */
function tapePatch(len: number, high: number, lift: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [strip(len, high, lift)]
  // Ragged ends: three teeth a side, alternating in and out.
  const TEETH = 3
  for (const side of [-1, 1] as const) {
    for (let i = 0; i < TEETH; i++) {
      const t = (i + 0.5) / TEETH - 0.5
      const bite = 0.018 + (i % 2) * 0.014
      parts.push(place(
        strip(bite * 2, high / TEETH * 0.9, lift),
        side * (len * 0.5 + bite * 0.5), t * high, 0,
      ))
    }
  }
  return mergeGeometries(parts)
}

export function boxTapeGeometry(
  w: number, h: number, d: number, r: number,
): THREE.BufferGeometry {
  const hx = w * 0.5
  const hy = h * 0.5
  const hz = d * 0.5
  const lift = 0.012
  const parts: THREE.BufferGeometry[] = []

  // ── the long sides ───────────────────────────────────────────────────────
  // Placed where the reference puts them: one near each end at about mid-height
  // and one low and central, all at a few degrees off level.
  const sidePatches: readonly [number, number, number, number][] = [
    // along-z, height, length, tilt
    [-0.72, -0.20, 0.26, 0.09],
    [0.62, -0.26, 0.22, -0.13],
    [-0.02, -0.44, 0.30, 0.05],
  ]
  for (const face of [-1, 1] as const) {
    const wall = face * (hx + lift * 0.5)
    for (let i = 0; i < sidePatches.length; i++) {
      const [z, y, len, tilt] = sidePatches[i]!
      // Mirrored per side and jittered off the hash, so the two long faces are
      // not each other's reflection — a box taped symmetrically looks designed.
      const j = hash(i * 13 + (face > 0 ? 5 : 0))
      const g = tapePatch(len * (0.85 + j * 0.3), 0.15, 0.010)
      // Built in the XY plane; turned onto a wall whose normal is +/-x.
      g.rotateY(Math.PI * 0.5)
      parts.push(place(g, wall, y + (j - 0.5) * 0.05, z * face, tilt * face, 0, 0))
    }
  }

  // ── the two ends ─────────────────────────────────────────────────────────
  for (const face of [-1, 1] as const) {
    const wall = face * (hz + lift * 0.5)
    for (let i = 0; i < 2; i++) {
      const j = hash(i * 29 + (face > 0 ? 11 : 3))
      const g = tapePatch(0.22 + j * 0.08, 0.14, 0.010)
      parts.push(place(
        g, (i === 0 ? -0.44 : 0.5) * face, i === 0 ? 0.16 : -0.28, wall,
        0, 0, (j - 0.5) * 0.28,
      ))
    }
  }

  // ── the two bands strapping the exhaust on ───────────────────────────────
  // Same surface as the rest of the tape, so they merge here rather than into
  // `exhaustGeometry` — a second tape material on the vehicle would be one more
  // draw call for a colour that already exists.
  for (const z of [-0.24, 0.16]) {
    const g = tapePatch(0.14, 0.34, 0.010)
    g.rotateY(Math.PI * 0.5)
    parts.push(place(g, EXHAUST.x * (hx + lift * 0.5) * 1.06, EXHAUST.y, z, 0, 0, 0))
  }

  // ── the seam under the base ──────────────────────────────────────────────
  // The one place tape genuinely holds a box together, and it is seen every time
  // the kart leaves the ground.
  parts.push(place(strip(0.26, 0.014, (hz - r) * 2), 0, -(hy + lift * 0.5), 0))
  return mergeGeometries(parts)
}

/** One printed arrow: a triangle over a stem. */
function arrowGlyph(x: number, y: number, z: number, size: number): THREE.BufferGeometry[] {
  // `thetaStart` pi puts the first of the three vertices at -Z, which the
  // axis-onto-Z rotation below carries to +Y, so the triangle points UP. Doing
  // it with a roll instead does not work: `place` composes Euler 'YXZ', so the
  // roll is applied BEFORE the axis swing and turns the prism about its own
  // length rather than about the wall normal.
  const head = new THREE.CylinderGeometry(size, size, 0.012, 3, 1, false, Math.PI)
  return [
    place(head, x, y + size * 0.45, z, Math.PI * 0.5, 0, 0),
    place(strip(size * 0.5, size * 1.0, 0.012), x, y - size * 0.6, z),
  ]
}

/**
 * A minimal stroke font, for the one piece of text this game needs.
 *
 * WHY A FONT AND NOT A TEXTURE. The reference sheet's single most recognisable
 * mark is the words FRAGILE and THIS SIDE UP printed on the box — it is the
 * first thing anyone reads in the concept art and the build had abstract bars
 * where it should be. A texture would be the obvious answer and it is closed to
 * this project twice over: the painterly material reads no UVs at all (it works
 * from `positionLocal` / `positionWorld` / `normalWorld`, which is why
 * `mergeParts` drops every other attribute), and CLAUDE.md's asset rule wants
 * form rather than a bitmap. Letters as extruded strokes are form, they light
 * like the rest of the print, and they merge into the ink batch for no extra
 * draw call.
 *
 * Each glyph is a list of strokes in a unit cell: x in 0..~0.56, y in 0..1,
 * origin bottom-left. Deliberately a SINGLE-WEIGHT STENCIL — no curves, no
 * bowls, no serifs. That is not a shortcut, it is what a depot stencil looks
 * like, and it is also the only style that survives being 40 px wide on a box
 * seen from 4 m: a rounded letterform at that size is a smudge.
 */
type Stroke = readonly [number, number, number, number]
const GLYPHS: Record<string, readonly Stroke[]> = {
  F: [[0, 0, 0, 1], [0, 1, 0.52, 1], [0, 0.55, 0.4, 0.55]],
  R: [[0, 0, 0, 1], [0, 1, 0.44, 1], [0.5, 0.94, 0.5, 0.62],
      [0, 0.56, 0.44, 0.56], [0.44, 1, 0.5, 0.94], [0.44, 0.56, 0.5, 0.62],
      [0.2, 0.56, 0.54, 0]],
  A: [[0, 0, 0.28, 1], [0.28, 1, 0.56, 0], [0.11, 0.36, 0.45, 0.36]],
  G: [[0.12, 1, 0.46, 1], [0, 0.86, 0, 0.14], [0, 0.86, 0.12, 1],
      [0, 0.14, 0.12, 0], [0.12, 0, 0.46, 0], [0.46, 0, 0.56, 0.14],
      [0.56, 0.14, 0.56, 0.44], [0.34, 0.44, 0.56, 0.44]],
  I: [[0.26, 0, 0.26, 1]],
  L: [[0, 0, 0, 1], [0, 0, 0.5, 0]],
  E: [[0, 0, 0, 1], [0, 1, 0.52, 1], [0, 0.52, 0.4, 0.52], [0, 0, 0.52, 0]],
  T: [[0, 1, 0.56, 1], [0.28, 0, 0.28, 1]],
  H: [[0, 0, 0, 1], [0.52, 0, 0.52, 1], [0, 0.52, 0.52, 0.52]],
  // S as five straight runs. A stencil S is exactly this and nothing smoother
  // would read at the size it is printed.
  S: [[0.52, 0.88, 0.4, 1], [0.4, 1, 0.12, 1], [0.12, 1, 0, 0.86],
      [0, 0.86, 0.52, 0.36], [0.52, 0.36, 0.52, 0.14], [0.52, 0.14, 0.4, 0],
      [0.4, 0, 0.12, 0], [0.12, 0, 0, 0.12]],
  D: [[0, 0, 0, 1], [0, 1, 0.34, 1], [0.34, 1, 0.52, 0.82],
      [0.52, 0.82, 0.52, 0.18], [0.52, 0.18, 0.34, 0], [0.34, 0, 0, 0]],
  U: [[0, 1, 0, 0.16], [0, 0.16, 0.13, 0], [0.13, 0, 0.41, 0],
      [0.41, 0, 0.54, 0.16], [0.54, 0.16, 0.54, 1]],
  P: [[0, 0, 0, 1], [0, 1, 0.44, 1], [0.44, 1, 0.5, 0.92],
      [0.5, 0.92, 0.5, 0.66], [0.5, 0.66, 0.44, 0.58], [0, 0.58, 0.44, 0.58]],
  ' ': [],
}

/** Advance width per glyph, in cell units, including the gap to the next. */
const ADVANCE = 0.74

/**
 * Set a word as extruded strokes on a wall.
 *
 * `axis` names the wall's NORMAL — 'z' for the two short ends, 'x' for the two
 * long sides — and `face` is +1 or -1 for which of the pair. `across` and `y`
 * are the centre of the text in world coordinates on that wall.
 *
 * THE READING DIRECTION IS DERIVED, NOT AUTHORED, and it is worth deriving here
 * rather than guessing, because guessing got it backwards on all four walls at
 * once and the render just says "mirrored".
 *
 * A viewer's right hand is `cross(forward, up)`. Standing outside a wall, the
 * forward direction is the wall's INWARD normal, so:
 *
 *   +z wall   forward (0,0,-1)  right = cross(f, up) = (+1, 0, 0)   ->  +x
 *   -z wall   forward (0,0,+1)  right = (-1, 0, 0)                  ->  -x
 *   +x wall   forward (-1,0,0)  right = (0, 0, -1)                  ->  -z
 *   -x wall   forward (+1,0,0)  right = (0, 0, +1)                  ->  +z
 *
 * which is `+face` on the z walls and `-face` on the x ones. Every glyph
 * coordinate is laid out in READING space and multiplied by it. The
 * first version mirrored with a post-hoc `scale(-1, 1, 1)` and rotated with a
 * post-hoc `rotateX`, and both are applied about the GEOMETRY'S ORIGIN rather
 * than about the stroke — `placeGeometry` composes T * R * S, so the rotation
 * belongs in the `place` call and nowhere else. What that produced was strokes
 * flung metres off the box in an arc, which is unmistakable once seen and looks
 * like a font bug rather than a transform-order one.
 */
function setText(
  text: string, size: number, across: number, y: number,
  axis: 'x' | 'z', face: number, wall: number,
): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = []
  const weight = size * 0.16
  const dir = axis === 'z' ? face : -face
  const width = (text.length - 1) * ADVANCE * size + size * 0.56
  let cursor = -width * 0.5
  for (const ch of text.toUpperCase()) {
    for (const [x0, y0, x1, y1] of GLYPHS[ch] ?? []) {
      const ax = across + dir * (cursor + x0 * size)
      const bx = across + dir * (cursor + x1 * size)
      const ay = y + y0 * size
      const by = y + y1 * size
      // `weight` is added so consecutive strokes overlap at their shared corner
      // and a letter reads as one continuous mark rather than as loose dashes.
      const len = Math.hypot(bx - ax, by - ay) + weight
      const angle = Math.atan2(by - ay, bx - ax)
      const mx = (ax + bx) * 0.5
      const my = (ay + by) * 0.5
      parts.push(axis === 'z'
        // Built along x and rolled about the wall's own normal.
        ? place(strip(len, weight, 0.010), mx, my, wall, 0, 0, angle)
        // Built along z; Rx(-a) sends +z to (0, sin a, cos a), which is the
        // stroke's direction in this wall's (across, up) plane.
        : place(strip(0.010, weight, len), wall, my, mx, -angle, 0, 0))
    }
    cursor += ADVANCE * size
  }
  return parts
}

/**
 * Printed marks, in ink. WALLS ONLY — there is no lid seam, because there is no
 * lid.
 *
 * THE WORDS ARE THE POINT NOW. `refs/character/raccoon-boxkart-sheet.png` prints
 * FRAGILE in a ruled box with THIS SIDE UP beside it on the long side, and it is
 * the single most recognisable mark on the whole vehicle — the build had three
 * abstract code bars and a stencil outline where the reference has words, which
 * is why the kart read as "a cardboard box" rather than as "THAT cardboard box".
 *
 * It goes on both long sides, which is where the reference puts it, AND on the
 * front, which is the face the chase camera looks at for the entire game. That
 * is a deliberate departure: a mark the player never sees is not doing any work,
 * and a depot would have stamped every face anyway.
 *
 * The arrows stay. They are the only near-black element on the vehicle apart
 * from the eyes and the paws, and without one the whole kart floats in the top
 * half of the value range against the meadow.
 */
export function boxInkGeometry(w: number, h: number, d: number, r: number): THREE.BufferGeometry {
  const hz = d * 0.5
  const hx = w * 0.5
  const parts: THREE.BufferGeometry[] = []
  const size = 0.15

  // ── ONE long side: FRAGILE in its box, THIS SIDE UP beside it ────────────
  // The stamp goes on the wall the exhaust is NOT taped to, which is what the
  // sheet does — its two side views show different things, one stamped and one
  // with the pipe. Printing both walls put the two on top of each other and lost
  // both, and it also made the vehicle symmetric, which a scrounged one is not.
  for (const face of [-EXHAUST.x] as const) {
    const wall = face * (hx + 0.024)
    parts.push(...setText('FRAGILE', size * 0.86, -0.34, -0.30, 'x', face, wall))
    // The rule around it. Four bars, not a filled panel.
    const bw = 0.96
    const bh = 0.26
    // 0.96 wide, not 0.78. FRAGILE at size 0.129 spans 0.645 m and the rule has
    // to clear BOTH ends of it plus its own 0.022 m bar; at 0.78 the left bar
    // landed 0.06 m off the F, which perspective closed to nothing and rendered
    // as "|RAGILE".
    // THE WHOLE BLOCK SITS IN THE BOTTOM 40% OF THE WALL, and that is set by the
    // flap rather than chosen: the long-side flap now folds flat DOWN the outside
    // of this wall and its tip reaches local y -0.13, so everything above that is
    // covered board. The sheet puts its FRAGILE in the same place for the same
    // reason — the folded flap is the band above it.
    for (const sy of [-1, 1]) {
      parts.push(place(strip(0.010, 0.022, bw), wall, -0.27 + sy * bh * 0.5, -0.34))
    }
    for (const sz of [-1, 1]) {
      parts.push(place(strip(0.010, bh, 0.022), wall, -0.27, -0.34 + sz * bw * 0.5))
    }
    // Three short lines to the right of the rule, exactly as the sheet sets it.
    parts.push(...setText('THIS', size * 0.55, 0.44, -0.20, 'x', face, wall))
    parts.push(...setText('SIDE', size * 0.55, 0.44, -0.31, 'x', face, wall))
    parts.push(...setText('UP', size * 0.55, 0.44, -0.42, 'x', face, wall))
  }

  // ── the front: arrows only ───────────────────────────────────────────────
  // NO TEXT HERE, and that is a correction. It had FRAGILE on it, and the front
  // flap rests folded DOWN against this wall (FLAP.front, 2.7 rad — see kart.ts)
  // so the stamp was completely hidden in every capture. A mark nobody can see
  // is not a mark.
  const front = -(hz + 0.024)
  parts.push(...arrowGlyph(-0.56, 0.02, front, 0.075))
  parts.push(...arrowGlyph(-0.34, 0.02, front, 0.075))

  // ── the rear: FRAGILE, because this is the face the game shows ───────────
  // The reference stamps the box's long SIDES, and both of those are stamped
  // above. This one is a deliberate addition: the chase camera sits behind the
  // kart for the entire game, so the rear wall is the single most-looked-at
  // surface in the project and it was carrying three abstract code bars.
  const rear = hz + 0.028
  // LOW ON THE WALL, for the same reason the side stamp is: the rear end flap
  // rests at 2.05 rad and shelves 0.51 m back with its tip at local y 0.23, so
  // everything above that is under it from a camera behind the kart — which is
  // the only camera this face has. At y -0.02 the stamp was completely hidden and
  // the chase view showed two arrows and a tear line.
  parts.push(...setText('FRAGILE', size * 0.8, -0.02, -0.26, 'z', 1, rear))
  // THE CODE BARS ARE GONE. Three horizontal strips meant to read as a shipping
  // label's barcode, and at gameplay distance they read as nothing at all — the
  // critic called them "a stray placeholder with no legible geometric or
  // narrative purpose", which is exactly right for an abstract mark on a vehicle
  // where every other mark is a word or a piece of tape. Two more this-way-up
  // arrows in their place: the arrows are the only near-black element on the
  // kart besides the eyes and the paws, and they are what anchors its value.
  parts.push(...arrowGlyph(0.56, -0.30, rear, 0.07))
  parts.push(...arrowGlyph(0.74, -0.30, rear, 0.07))
  return mergeGeometries(parts)
}

/**
 * The exhaust pipe: a scavenged muffler taped to the box's side.
 *
 * Pure sight gag, and the sheet spends a whole view on it — a chrome silencer
 * with a Y-branch at one end and a bolt-eye flange at the other, strapped to the
 * cardboard with two bands of packing tape. It is the single clearest statement
 * of what this vehicle is: two animals have taped a car part to a box because
 * cars have one, and it is connected to nothing.
 *
 * Built lying along the box's z axis so it can be turned onto either long wall,
 * in the same cool lavender as the hubcaps and the steering wheel — the sheet
 * gives every scavenged manufactured part one colour, which is what separates
 * them from the box they are stuck to.
 *
 * The two tape bands are NOT here. They are in `boxTapeGeometry` with the rest of
 * the tape, because they are the same surface and merging them here would mean
 * a second tape material on the vehicle.
 */
export function exhaustGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  const tube = (r: number, len: number, x: number, y: number, z: number,
    rx = 0, ry = 0, rz = 0): void => {
    const g = new THREE.CylinderGeometry(r, r, len, 10, 1)
    // Built along +Y; swung onto +Z, then by the caller's own angles.
    parts.push(place(g, x, y, z, rx + Math.PI * 0.5, ry, rz))
  }
  // Silencer body, with a slightly wider collar at each end so it reads as a
  // fabricated part rather than as a length of pipe.
  tube(0.082, 0.66, 0, 0, 0)
  tube(0.094, 0.06, 0, 0, -0.30)
  tube(0.094, 0.06, 0, 0, 0.30)
  // The Y-branch: two thinner pipes off the front end, one swept up and one down.
  tube(0.048, 0.32, 0, 0.10, -0.47, -0.5)
  tube(0.048, 0.24, 0, -0.07, -0.44, 0.42)
  // Bolt eyes at both far ends — flat rings with a dark centre, which is what
  // gives the silhouette its two little loops.
  for (const [z, sign] of [[-0.62, -1], [0.44, 1]] as const) {
    const eye = new THREE.CylinderGeometry(0.062, 0.062, 0.04, 10, 1)
    parts.push(place(eye, 0, sign * 0.02, z, Math.PI * 0.5, 0, 0))
  }
  tube(0.048, 0.18, 0, 0.01, 0.38)
  return mergeGeometries(parts)
}

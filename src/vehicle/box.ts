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
 * A box flap, hinged at its own origin and spanning y 0..len, with the free
 * edge cut across the flutes so the corrugation shows.
 *
 * Built at its true width rather than scaled per instance: the long side flaps
 * and the short end flaps therefore need two geometries and two batches instead
 * of one, which is a draw call well spent — an x-scaled flap stretches its
 * scallops into ellipses and the corrugation stops reading as a repeat.
 */
export function flapGeometry(width: number, len: number, thick: number): THREE.BufferGeometry {
  const slab = roundedBox(width, len, thick, 0.03, 2)
  slab.translate(0, len * 0.5, 0)
  const parts: THREE.BufferGeometry[] = [slab]
  const xs = span(width * 0.5 - 0.05, BOARD.cutPitch)
  // Half the spacing, so the crests touch and the cut reads as one wave rather
  // than as a row of separate beads.
  const sr = ((width - 0.1) / Math.max(1, xs.length - 1)) * 0.5
  for (const x of xs) {
    const bead = new THREE.CylinderGeometry(sr, sr, thick, BOARD.segments, 1)
    parts.push(place(bead, x, len - sr * 0.55, 0, Math.PI * 0.5, 0, 0))
  }
  return mergeGeometries(parts)
}

/** A thin slab lying on a face, `t` metres proud of it. */
function strip(sx: number, sy: number, sz: number): THREE.BufferGeometry {
  return new THREE.BoxGeometry(sx, sy, sz)
}

/**
 * Packing tape: a band round the girth, a strip under the base, and a shipping
 * label on the rear wall.
 *
 * The band is the piece that does the work, and it survives the box being open
 * because it never depended on the lid: a band that crosses all four corner
 * folds is unmistakably tape, and it is the only element on the kart that
 * crosses a fold — which is what tells the eye that the folds are folds.
 *
 * What did NOT survive: a spine down the lid seam and a segment of the band
 * running across the lid. Both were drawing a lid. The tape they represented
 * has moved to the underside, which is where the tape on an open box is.
 */
export function boxTapeGeometry(
  w: number, h: number, d: number, r: number,
): THREE.BufferGeometry {
  const hx = w * 0.5
  const hy = h * 0.5
  const hz = d * 0.5
  const lift = 0.010
  const band = 0.30
  const bandY = -0.02
  const parts: THREE.BufferGeometry[] = []

  // Girth band, all the way round the four walls.
  const b = new MeshBuilder()
  loft(b, [
    roundedRect(hx + lift, hz + lift, r + lift, bandY + band * 0.5),
    roundedRect(hx + lift, hz + lift, r + lift, bandY - band * 0.5),
  ], { closed: true })
  parts.push(b.build())

  // Base tape: the strip that is actually holding the box together, seen every
  // time the kart leaves the ground.
  parts.push(place(strip(0.26, 0.014, (hz - r) * 2), 0, -(hy + lift * 0.6), 0))

  // Shipping label: a paper rectangle stuck over the corrugation on the rear
  // wall, which is the face the chase camera spends the whole game looking at.
  parts.push(place(strip(0.46, 0.30, 0.012), 0.28, 0.02, hz + 0.020))
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
 * Printed marks, in ink. WALLS ONLY — there is no lid seam, because there is no
 * lid; the docstring used to say "and the lid seam" and that was the last
 * mention of one anywhere on the kart.
 *
 * Small, dark, and deliberately not symmetrical with the tape: a box that has
 * been through a depot has a couple of stencils on it in whatever order the
 * depot felt like. This is also the only near-black element on the vehicle
 * apart from the eyes, which is what gives the box a value anchor — without one
 * the whole kart floats in the top half of the range against the meadow.
 */
export function boxInkGeometry(w: number, h: number, d: number, r: number): THREE.BufferGeometry {
  const hz = d * 0.5
  const parts: THREE.BufferGeometry[] = []

  // Rear wall: two this-way-up arrows, and three code bars on the label.
  const rear = hz + 0.028
  parts.push(...arrowGlyph(-0.44, 0.0, rear, 0.085))
  parts.push(...arrowGlyph(-0.19, 0.0, rear, 0.085))
  const bars = [0.34, 0.28, 0.2]
  for (let i = 0; i < bars.length; i++) {
    parts.push(place(strip(bars[i]!, 0.028, 0.008), 0.28, 0.10 - i * 0.075, hz + 0.030))
  }

  // Front wall: a stencil block outline. Four bars, not a filled rectangle —
  // an outline survives being 40 px wide, a filled one becomes a blob.
  const front = -(hz + 0.024)
  // Kept inside the flat part of the wall: past `w/2 - r` the surface curves
  // away into the corner and a straight printed bar would float off it.
  const bw = Math.min(w * 0.3, (w * 0.5 - r) * 1.5)
  const bh = h * 0.28
  parts.push(place(strip(bw, 0.026, 0.010), 0, bh * 0.5, front))
  parts.push(place(strip(bw, 0.026, 0.010), 0, -bh * 0.5, front))
  parts.push(place(strip(0.026, bh, 0.010), bw * 0.5, 0, front))
  parts.push(place(strip(0.026, bh, 0.010), -bw * 0.5, 0, front))
  return mergeGeometries(parts)
}

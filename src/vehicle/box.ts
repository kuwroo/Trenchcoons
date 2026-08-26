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
//        tape          a spine along the lid seam, and a band wrapping the girth
//        printed mark  this-way-up arrows, a shipping label, a stencil block
//
// All of it is merged down: the flutes and creases become part of the shell
// geometry, the scallops part of the flap geometry, so the whole dressing costs
// two extra draw calls (tape, ink) and about 9k triangles. The kart is drawn
// five times a frame — once for the frame, once per shadow cascade — so a draw
// call saved here is worth five.
//
// Every number is in metres, in BOX-LOCAL space: the origin is the centre of
// the box, so +y/2 is the lid and +z is the rear (the car drives toward -z).

import * as THREE from 'three/webgpu'
import { mergeGeometries, place, roundedBox } from './geometry'

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
 * The box shell: a rounded box, plus vertical flutes across all four walls and
 * a raised fold crease down each corner.
 *
 * The flutes are cylinders sunk into the liner so only `fluteRise` shows. That
 * is cheaper than displacing a subdivided box (which would need ~80 segments
 * across the deck to carry the wave, and would pay for that resolution on the
 * lid where there are no flutes) and it gives the same thing the reference
 * needs: a hard, regular, DIRECTIONAL light break, which is the one signal no
 * isotropic noise field can produce.
 *
 * They stop short of the rounded top and bottom, because a flute stops at a
 * fold in real board too.
 */
export function boxShellGeometry(
  w: number, h: number, d: number, r: number,
): THREE.BufferGeometry {
  const hx = w * 0.5
  const hy = h * 0.5
  const hz = d * 0.5
  // Where the rounding starts, i.e. where the flat liner ends.
  const ix = hx - r
  const iz = hz - r
  const rise = hy - r * 0.85
  const parts: THREE.BufferGeometry[] = [roundedBox(w, h, d, r, 4)]

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
 * Packing tape: a spine down the lid seam, and a band wrapping the girth.
 *
 * The band is the piece that does the work. A flat strip on the lid is just a
 * lighter rectangle; a band that goes over the lid, round both top corners and
 * down both walls is unmistakably tape, and it is also the only element on the
 * kart that crosses a fold — which is what tells the eye that the folds are
 * folds.
 */
export function boxTapeGeometry(
  w: number, h: number, d: number, r: number,
): THREE.BufferGeometry {
  const hx = w * 0.5
  const hy = h * 0.5
  const hz = d * 0.5
  const ix = hx - r
  const iy = hy - r
  const lift = 0.010
  const band = 0.30
  const bandZ = 0.78
  const parts: THREE.BufferGeometry[] = []

  // Seam spine, along the lid. Deliberately shorter than the seam line in the
  // ink pass below, so the bare seam shows fore and aft of the tape.
  parts.push(place(strip(0.24, 0.016, 1.62), 0, hy + lift * 0.8, 0))

  // Girth band: lid segment, two corner arcs, two wall segments.
  parts.push(place(strip(ix * 2, 0.016, band), 0, hy + lift, bandZ))
  // `CylinderGeometry` puts theta 0 at +Z and sweeps toward +X; rotating the
  // axis onto Z maps (sin t, -cos t) into the XY plane, so the +X->+Y quadrant
  // is theta pi/2..pi and the -X->+Y quadrant is pi..3pi/2.
  const arc = (start: number): THREE.BufferGeometry =>
    new THREE.CylinderGeometry(
      r + lift, r + lift, band, BOARD.segments * 2, 1, true, start, Math.PI * 0.5,
    )
  parts.push(place(arc(Math.PI * 0.5), ix, iy, bandZ, Math.PI * 0.5, 0, 0))
  parts.push(place(arc(Math.PI), -ix, iy, bandZ, Math.PI * 0.5, 0, 0))
  for (const sx of [-1, 1]) {
    parts.push(place(strip(0.016, iy * 2, band), sx * (hx + lift), 0, bandZ))
  }

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
 * Printed marks and the lid seam, in ink.
 *
 * Small, dark, and deliberately not symmetrical with the tape: a box that has
 * been through a depot has a couple of stencils on it in whatever order the
 * depot felt like. This is also the only near-black element on the vehicle
 * apart from the eyes, which is what gives the box a value anchor — without one
 * the whole kart floats in the top half of the range against the meadow.
 */
export function boxInkGeometry(w: number, h: number, d: number, r: number): THREE.BufferGeometry {
  const hy = h * 0.5
  const hz = d * 0.5
  const iz = hz - r
  const parts: THREE.BufferGeometry[] = []

  // The lid seam — the fold the tape is holding shut.
  parts.push(place(strip(0.022, 0.010, iz * 2), 0, hy + 0.004, 0))

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
  const bw = 0.52
  const bh = 0.30
  parts.push(place(strip(bw, 0.026, 0.010), 0, bh * 0.5, front))
  parts.push(place(strip(bw, 0.026, 0.010), 0, -bh * 0.5, front))
  parts.push(place(strip(0.026, bh, 0.010), bw * 0.5, 0, front))
  parts.push(place(strip(0.026, bh, 0.010), -bw * 0.5, 0, front))
  return mergeGeometries(parts)
}

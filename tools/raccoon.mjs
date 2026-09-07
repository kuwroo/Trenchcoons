// Raccoon layout readback. Not a gate — an INSTRUMENT.
//
// It exists because three consecutive capture rounds each produced a confident,
// specific and wrong diagnosis of the same face. The renders showed a head with
// no eyes, no nose and one unidentifiable cream shape on it, and every reading of
// those frames was a guess about which part had gone where — the muzzle was
// blamed for the cream shape, the mask was blamed for being unlit, the glance was
// blamed for turning the head away. None of that was measurable in a PNG at 130
// pixels a head.
//
// What was actually wrong is arithmetic, and arithmetic is exactly what a
// screenshot cannot show you: every feature is authored in TANGENT ANGLES on a
// sphere of radius 0.29, then the whole head is squashed to (1.10, 0.94, 0.98),
// so whether a part ends up INSIDE or OUTSIDE the skull is the product of four
// numbers in two files. The eyes were 0.006 m under the surface. That is
// invisible in a frame, obvious in a table, and it is the whole reason the face
// had no eyes.
//
// CLAUDE.md's own lesson, from the water: "THE LESSON IS THE INSTRUMENT. Bugs 1,
// 3 and 4 were each diagnosed by a whole-field readback, not by looking at the
// frame — the frame was self-consistent and wrong every time. Build the readback
// first."
//
//   node tools/raccoon.mjs
//
// It reports, for every part of the head, where it sits relative to the skull's
// own surface along its own ray, and FAILS on the two conditions that cannot be
// seen in a capture:
//
//   BURIED     a part meant to protrude that does not break the surface at all
//   DETACHED   a part floating clear of the surface with a gap under it
//   BACKFACING triangles wound away from their own authored normals
//
// All three are silent in the render. A buried part is simply absent, which reads
// as an art problem; a detached one shows a shadow gap at exactly one sun angle;
// and a backfacing part draws NOTHING, because the painterly material is
// single-sided. The third one cost a full capture round on its own: the mask and
// the brow blaze were both wound clockwise-from-outside, so a face that had every
// marking in the right place at the right size rendered with none of them, and
// the frames were read as a palette failure. It is the same bug the ocean had —
// CLAUDE.md, M7 bug 1 — and it is now impossible to ship again.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PNG } from 'pngjs'

const ROOT = path.resolve(import.meta.dirname, '..')

/**
 * Bundle the geometry half of src/vehicle/raccoon.ts for node and import it.
 *
 * Bundled rather than read through a node loader because raccoon.ts imports
 * `three/webgpu` and uses extensionless relative TS imports, neither of which
 * node's own type stripping resolves. `rolldown` is what this project's vite
 * already runs on, so this costs no new dependency AND is compiled by the same
 * toolchain as the game — which a hand-copied duplicate of the trigonometry
 * would not be. That matters more than convenience here: the entire value of
 * this instrument is that it cannot disagree with what ships.
 */
async function loadRaccoon() {
  const entry = path.join(os.tmpdir(), `trench-raccoon-${process.pid}.mjs`)
  const out = path.join(os.tmpdir(), `trench-raccoon-${process.pid}.bundle.mjs`)
  fs.writeFileSync(entry, `export * from ${JSON.stringify(path.join(ROOT, 'src/vehicle/raccoon.ts'))}\n`)
  execFileSync(path.join(ROOT, 'node_modules/.bin/rolldown'), [
    entry, '--platform', 'node', '--format', 'esm', '--file', out,
  ], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] })
  const mod = await import(`file://${out}`)
  fs.rmSync(entry, { force: true })
  fs.rmSync(out, { force: true })
  return mod
}

const R = await loadRaccoon()
const { RACCOON } = R

/**
 * Where the skull's surface is along a ray, and where a point sits on it.
 *
 * The skull is the unit sphere of radius `skull`, scaled by `skullScale` and
 * then tapered by `headTaper` — narrow at the crown, widest at the cheek — so it
 * is NOT an ellipsoid and there is no closed form for the surface along a ray.
 *
 * THIS FUNCTION IS THE GATE'S MODEL OF THE SKULL AND IT HAS TO TRACK THE REAL
 * ONE. When the taper landed, this still described an ellipsoid and the gate
 * reported nine failures — a detached mask, a buried blaze, both eyes inside the
 * head — none of which were real: the geometry had moved and the model had not.
 * The tolerances below are unchanged and must stay unchanged; what was wrong was
 * the surface being measured against, which is a different thing from a
 * threshold. If `conform` in raccoon.ts changes shape again, change this too, in
 * the same commit.
 */
function surfaceAlong(x, y, z) {
  const s = RACCOON.skullScale
  const r = RACCOON.skull
  const len = Math.hypot(x, y, z)
  if (len < 1e-9) return Infinity
  const dx = x / len, dy = y / len, dz = z / len
  // Signed "how far outside the skull" for the point k units along the ray, in
  // the unit sphere's own units. The taper is a function of HEIGHT, and height
  // is scaled by s.y before it reaches the geometry, so the argument has to be
  // un-scaled by s.y to get back to the sphere's own t.
  const g = (k) => {
    const qy = k * dy
    const t = qy / (r * s.y)
    const f = R.headTaper(t)[0]
    const fz = R.headDepthTaper(t)[0]
    return Math.hypot((k * dx) / (s.x * f), qy / s.y, (k * dz) / (s.z * fz)) - r
  }
  // Bisection, not a division. With a height-dependent taper there is no closed
  // form, and 60 halvings of a bracket four skull-radii wide lands well inside
  // the 0.004 m tolerance this file gates on.
  let lo = 0
  let hi = r * 4 * Math.max(s.x, s.y, s.z)
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) * 0.5
    if (g(mid) < 0) lo = mid
    else hi = mid
  }
  return (lo + hi) * 0.5
}

/**
 * Signed distance of a point OUTSIDE the skull surface, in metres.
 *
 * PERPENDICULAR, NOT RADIAL. This used to be `|p| - surfaceAlong(p)`, the gap
 * measured along the ray from the head's origin, and on an ellipsoid that is
 * near enough to the perpendicular distance that nobody noticed. On the tapered
 * skull it is not: near the jaw the surface runs steeply away from the radial
 * direction, so a marking hugging it at 5 mm measured 22 mm and the gate called
 * three of them DETACHED. Acting on that would have meant thinning the `LIFT`
 * ladder to fix a fault in the ruler.
 *
 * `F/|grad F|` is the first-order distance to the zero set of the implicit
 * surface, which is what a marking's standoff actually is, and it is accurate
 * precisely where these parts live — within a few millimetres of the surface.
 */
function outside(x, y, z) {
  const s = RACCOON.skullScale
  const r = RACCOON.skull
  // THE Z AXIS HAS ITS OWN TAPER. This modelled the skull as isotropically
  // tapered, and the moment `headDepthTaper` split the fore-aft axis off (the
  // cranium is 1.25x deeper than wide at t 0.79, measured off the sheet's side
  // view) this surface became SHALLOWER than the geometry at the crown — so the
  // mask and the blaze, hugging the real surface correctly, reported 0.042 m of
  // standoff and the gate called them DETACHED. Same fault as the radial-vs-
  // perpendicular note above, and the same trap: the fix is the ruler, not the
  // `LIFT` ladder. Any future per-axis term has to be added here in the same
  // edit as in `conform`.
  const F = (qx, qy, qz) => {
    const t = qy / (r * s.y)
    const f = R.headTaper(t)[0]
    const fz = R.headDepthTaper(t)[0]
    return Math.hypot(qx / (s.x * f), qy / s.y, qz / (s.z * fz)) - r
  }
  const h = 1e-5
  const v = F(x, y, z)
  const gx = (F(x + h, y, z) - F(x - h, y, z)) / (2 * h)
  const gy = (F(x, y + h, z) - F(x, y - h, z)) / (2 * h)
  const gz = (F(x, y, z + h) - F(x, y, z - h)) / (2 * h)
  const g = Math.hypot(gx, gy, gz)
  return g < 1e-9 ? v : v / g
}

/**
 * Fraction of triangles whose geometric winding disagrees with their own
 * authored vertex normals.
 *
 * The comparison is what makes this meaningful. Winding alone says nothing —
 * clockwise is only wrong relative to which way the surface is supposed to face —
 * and these generators author the outward normal explicitly, so the authored
 * normal IS the intent and `cross(b-a, c-a)` is what the rasteriser will use. If
 * they point opposite ways the triangle is invisible.
 */
function backfacing(geo) {
  const p = geo.attributes.position.array
  const n = geo.attributes.normal.array
  const idx = geo.index ? geo.index.array : null
  const count = idx ? idx.length : p.length / 3
  let bad = 0
  let total = 0
  for (let t = 0; t + 2 < count; t += 3) {
    const [i, j2, k] = idx ? [idx[t], idx[t + 1], idx[t + 2]] : [t, t + 1, t + 2]
    const ax = p[i * 3], ay = p[i * 3 + 1], az = p[i * 3 + 2]
    const ux = p[j2 * 3] - ax, uy = p[j2 * 3 + 1] - ay, uz = p[j2 * 3 + 2] - az
    const vx = p[k * 3] - ax, vy = p[k * 3 + 1] - ay, vz = p[k * 3 + 2] - az
    const cx = uy * vz - uz * vy
    const cy = uz * vx - ux * vz
    const cz = ux * vy - uy * vx
    const len = Math.hypot(cx, cy, cz)
    if (len < 1e-12) continue
    total++
    if (cx * n[i * 3] + cy * n[i * 3 + 1] + cz * n[i * 3 + 2] < 0) bad++
  }
  return total ? bad / total : 0
}

/** Furthest-out and nearest-in vertex of a geometry, measured against the skull. */
function extent(geo) {
  const p = geo.attributes.position.array
  let lo = Infinity
  let hi = -Infinity
  for (let i = 0; i < p.length; i += 3) {
    const d = outside(p[i], p[i + 1], p[i + 2])
    if (d < lo) lo = d
    if (d > hi) hi = d
  }
  return { lo, hi, tris: (geo.index ? geo.index.count : p.length / 3) / 3 }
}

const problems = []
const rows = []

function report(name, geo, want) {
  const e = extent(geo)
  const back = backfacing(geo)
  rows.push({ name, ...e, want, back })
  if (back > 0.02) {
    problems.push(`${name}: BACKFACING — ${(back * 100).toFixed(0)}% of triangles are wound away from their own normals, so they draw nothing at all`)
  }
  // `want` is what the part is FOR. A marking conforms to the surface; a volume
  // projects past it; a socket part has to break it without floating.
  if (want === 'conform') {
    if (e.hi > 0.02) problems.push(`${name}: DETACHED — stands ${e.hi.toFixed(3)} m off the skull (a marking must hug it)`)
    if (e.lo < -0.004) problems.push(`${name}: BURIED — reaches ${(-e.lo).toFixed(3)} m under the skull`)
  } else if (want === 'project') {
    if (e.hi < 0.05) problems.push(`${name}: BURIED — protrudes only ${e.hi.toFixed(3)} m; it will read as absent`)
  } else if (want === 'socket') {
    if (e.hi <= 0.002) problems.push(`${name}: BURIED — does not break the surface (protrudes ${e.hi.toFixed(3)} m)`)
    if (e.hi > 0.045) problems.push(`${name}: DETACHED — protrudes ${e.hi.toFixed(3)} m; it will read as a goggle stuck on the head`)
  }
}

// ── head-attached geometry ──────────────────────────────────────────────────
report('mask (eye patches, forehead stripe, mouth)', R.maskGeometry(), 'conform')
report('blaze (brow stripes, cheek flashes)', R.blazeGeometry(), 'conform')
// THE MUZZLE'S INTENT CHANGED, so its check did. It was a lofted snout and was
// checked as 'project' — must stand at least 0.05 m clear of the skull or it
// reads as absent. It is now a shallow spherical PAD (the reference has no
// snout; see muzzleGeometry), so the correct question is whether it CONFORMS,
// exactly as the mask and the blaze do. This is not a loosened threshold: the
// conform check is two-sided and tighter, requiring the surface to sit within
// 0.02 m outside and 0.004 m inside the skull, where 'project' had only a floor.
// AND IT CHANGED BACK. Round 19 made the muzzle a flat pad and this check became
// 'conform'; fitting the sheet's SIDE view showed the muzzle does project about
// 0.10 m, so it is a shallow snout again and 'project' is once more the right
// question. A check encodes an intent — when the intent oscillates, so does it,
// and that is the check doing its job rather than being unstable.
report('muzzle (snout)', R.muzzleGeometry(), 'project')
// THE NOSE'S CONTROL IS THE MUZZLE, NOT THE SKULL. Measured against the head it
// scored +0.024 .. +0.091 and "passed", which is meaningless — the nose is
// supposed to be clear of the skull, it sits on the end of a snout that is itself
// clear of it. What can actually go wrong is the nose parting company with the
// muzzle, so the check is the gap between the two surfaces.
{
  const nose = R.noseGeometry()
  const muzzle = R.muzzleGeometry()
  const np = nose.attributes.position.array
  const mp = muzzle.attributes.position.array
  let gap = Infinity
  for (let i = 0; i < np.length; i += 3) {
    let near = Infinity
    for (let k = 0; k < mp.length; k += 3) {
      const d = Math.hypot(np[i] - mp[k], np[i + 1] - mp[k + 1], np[i + 2] - mp[k + 2])
      if (d < near) near = d
    }
    if (near < gap) gap = near
  }
  const back = backfacing(nose)
  rows.push({ name: 'nose', lo: gap, hi: gap, back, note: `nearest muzzle vertex ${gap.toFixed(3)} m away` })
  if (back > 0.02) problems.push(`nose: BACKFACING — ${(back * 100).toFixed(0)}% of triangles wound away from their normals`)
  if (gap > 0.03) {
    problems.push(`nose: DETACHED from the muzzle — nearest muzzle vertex is ${gap.toFixed(3)} m away, so it floats in front of the snout`)
  }
}

// EVERY new face marking must be listed here. The driver's grin was added and
// not listed, and it went out back-facing and invisible on the very next capture
// — the fourth winding loss in this project and the first one that this tool
// existed for and did not catch, purely because the shape was not handed to it.
report('grin (driver, open mouth)', R.grinGeometry(false), 'conform')
report('tongue (driver)', R.grinGeometry(true), 'conform')

// The "!" is not on the head, so it gets no surface check — but it IS the third
// piece of geometry in this project to be silently deleted by back-face culling,
// so it gets the winding one. Its front faces -Z, because that is the axis
// `Matrix4.lookAt` points at the camera.
{
  const geo = R.alertGeometry(0.52, false)
  const back = backfacing(geo)
  const n = geo.attributes.normal.array
  const facesMinusZ = n.length >= 3 && n[2] < -0.5
  rows.push({
    name: 'alert glyph ("!")', lo: 0, hi: 0, back,
    note: `${(geo.index.count / 3)} tris, front normal ${facesMinusZ ? '-Z (correct for lookAt)' : '+Z (WRONG — lookAt points -Z at the camera)'}`,
  })
  if (back > 0.02) problems.push(`alert glyph: BACKFACING — ${(back * 100).toFixed(0)}% of triangles wound away from their normals; part of the glyph will be invisible`)
  if (!facesMinusZ) problems.push('alert glyph: faces +Z, but the billboard turns -Z toward the camera, so the whole glyph is culled')
}

// ── the parts whose position lives in the RIG, not in a geometry ────────────
// Rebuilt here through the same `buildRaccoonJoints` the game calls, so this
// cannot disagree with it. The seat is left at the origin, which puts the head
// joint's own frame at the origin too once its ancestors are subtracted — and
// that is the frame every face part above is authored in.
const rig = new R.Rig()
const j = R.buildRaccoonJoints(rig, -1)
rig.solve()

const headInv = j.head.world.clone().invert()
function inHead(joint) {
  const m = joint.world.clone().premultiply(headInv)
  return [m.elements[12], m.elements[13], m.elements[14]]
}

for (const [name, joint, radius, want] of [
  // The IRIS is checked at its own offset position, because it rides forward off
  // the eyeball's centre — and "the pale ball is visible but the pupil is not" is
  // a reachable state that no frame explains. It shipped once.
  ['iris L', j.eyeL, RACCOON.eye * RACCOON.iris + RACCOON.eye * RACCOON.irisOut, 'socket'],
  ['iris R', j.eyeR, RACCOON.eye * RACCOON.iris + RACCOON.eye * RACCOON.irisOut, 'socket'],
  ['eyeball L', j.eyeL, RACCOON.eye, 'socket'],
  ['eyeball R', j.eyeR, RACCOON.eye, 'socket'],
  ['ear L root', j.earL, 0, 'root'],
  ['ear R root', j.earR, 0, 'root'],
]) {
  const [x, y, z] = inHead(joint)
  const d = outside(x, y, z)
  const surf = surfaceAlong(x, y, z)
  rows.push({
    name, lo: d, hi: d + radius, want,
    note: `centre ${d >= 0 ? '+' : ''}${d.toFixed(3)} m vs surface (surface at ${surf.toFixed(3)} m)`,
  })
  if (want === 'socket') {
    const stand = d + radius
    if (stand <= 0.002) {
      problems.push(`${name}: BURIED — the whole orb is inside the skull (stands ${stand.toFixed(3)} m). There will be no eye on screen.`)
    } else if (stand > 0.045) {
      problems.push(`${name}: DETACHED — stands ${stand.toFixed(3)} m proud; reads as a bead stuck on the head`)
    }
  }
}

// ── the rig's own geometry, against the box it has to sit in ────────────────
// Duplicated from kart.ts on purpose and flagged as such: these four numbers are
// the box, and if they ever disagree with kart.ts this report is lying. They are
// here because the single most expensive error in this whole effort was the crew
// sitting 0.005 m too low relative to a rim defined in another file.
const BOX = { h: 1.06, y: 0.4, board: 0.075 }
const RIM_Y = BOX.y + BOX.h * 0.5
const FLOOR_Y = BOX.y - BOX.h * 0.5 + BOX.board
const headY = FLOOR_Y + RACCOON.neckHeight
const chinY = headY - RACCOON.skull * RACCOON.skullScale.y
const tail = j.tail.map((t) => FLOOR_Y + t.world.elements[13])
const tipY = tail[tail.length - 1] + RACCOON.tailRadius * RACCOON.tailTaper

console.log('\nraccoon layout — face parts vs the skull surface\n')
for (const r of rows) {
  const flag = problems.some((p) => p.includes(r.name.split(' (')[0])) ? 'FAIL' : 'ok  '
  const span = r.note ?? `${r.lo >= 0 ? '+' : ''}${r.lo.toFixed(3)} .. ${r.hi >= 0 ? '+' : ''}${r.hi.toFixed(3)} m`
  const back = r.back === undefined ? '' : `   ${(r.back * 100).toFixed(0)}% backfacing`
  console.log(`  ${flag} ${r.name.padEnd(44)} ${span}${r.tris ? `   ${r.tris} tris` : ''}${back}`)
}

console.log('\nthe crew vs the box\n')
const lines = [
  ['box rim', RIM_Y, null],
  ['box floor (inside)', FLOOR_Y, null],
  ['head centre', headY, null],
  ['chin', chinY, chinY > RIM_Y + 0.08
    ? null : `too low — the jaw and the mouth line are cut off by the rim (want > ${(RIM_Y + 0.08).toFixed(2)})`],
  ['tail tip (top of)', tipY, tipY > RIM_Y + 0.05
    ? null : `below the rim — the tail is not in any frame the game shows (want > ${(RIM_Y + 0.05).toFixed(2)})`],
]
for (const [name, y, err] of lines) {
  console.log(`  ${err ? 'FAIL' : 'ok  '} ${name.padEnd(20)} y = ${y.toFixed(3)}${err ? `   ${err}` : ''}`)
  if (err) problems.push(`${name}: ${err}`)
}

// ── the idle layer, as a SUBJECT-VS-CONTROL measurement ─────────────────────
//
// MILESTONES M3: "a parked, untouched car must never be a still image." That is
// the one requirement in this whole effort with no test attached, and it is
// exactly the kind that breaks silently — every spring in kart.ts could settle
// to a constant and nothing would error.
//
// `car-idle` and `car-idle-b` are the same URL 48 frames (0.8 s) apart, which is
// what makes this measurable at all. A WHOLE-FRAME difference is useless here
// and measures the wrong thing: the grass has its own wind and moves 13% of its
// pixels over the same 0.8 s, so a dead kart in a live meadow still scores. The
// pair is the kart's own box against an equal area of empty meadow beside it,
// and the requirement is a RATIO — which cannot be satisfied by the weather.
{
  const A = 'shots/car-idle.png'
  const B = 'shots/car-idle-b.png'
  if (fs.existsSync(A) && fs.existsSync(B)) {
    const a = PNG.sync.read(fs.readFileSync(A))
    const b = PNG.sync.read(fs.readFileSync(B))
    const churn = (x0, y0, x1, y1) => {
      let moved = 0
      let total = 0
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * a.width + x) * 4
          const d = Math.max(
            Math.abs(a.data[i] - b.data[i]),
            Math.abs(a.data[i + 1] - b.data[i + 1]),
            Math.abs(a.data[i + 2] - b.data[i + 2]),
          )
          total++
          if (d > 6) moved++
        }
      }
      return total ? (100 * moved) / total : 0
    }
    // Boxes are fixed to this capture's framing. If `car-idle`'s camera moves,
    // they move with it or this measures scenery.
    const kart = churn(560, 380, 1120, 900)
    const grass = churn(0, 380, 560, 900)
    console.log('the idle layer (M3: a parked car is never a still image)\n')
    // A RATIO NEEDS A USABLE DENOMINATOR, and this one's is scenery that another
    // session is actively editing. It has been measured at 12.9% and at 23.7%
    // within an hour, and once at 0.0% — at which point `kart / max(grass, 1e-6)`
    // reported a ratio of 26 million and the gate PASSED on a divide-by-zero.
    // That is worse than failing: a metric that cannot be computed has to say so
    // rather than return a number.
    //
    // So the control is checked for usability first. Below 2% it is not a
    // control — the grass is not moving, so it cannot tell a live kart from a
    // dead one — and the check falls back to the kart's own absolute churn
    // against a floor, which is weaker and honest about being weaker.
    if (grass < 2) {
      const ok = kart >= 8
      console.log(`  ${ok ? 'ok  ' : 'FAIL'} kart ${kart.toFixed(1)}% of pixels moved in 0.8 s`
        + `  (meadow control ${grass.toFixed(1)}% is UNUSABLE — scenery static in this`
        + ` capture, so this is an absolute floor, not the ratio)`)
      if (!ok) {
        problems.push(`the idle layer looks dead — the kart moved only ${kart.toFixed(1)}% of its pixels in 0.8 s (absolute floor 8%; the meadow control was unusable at ${grass.toFixed(1)}%)`)
      }
    } else {
      const ratio = kart / grass
      console.log(`  ${ratio >= 1.8 ? 'ok  ' : 'FAIL'} kart ${kart.toFixed(1)}% of pixels moved in 0.8 s`
        + `, meadow control ${grass.toFixed(1)}%  ->  ratio ${ratio.toFixed(2)}x`)
      if (ratio < 1.8) {
        problems.push(`the idle layer is dead or nearly so — the kart moved ${kart.toFixed(1)}% of its pixels against the meadow's ${grass.toFixed(1)}%, a ratio of ${ratio.toFixed(2)}x (want >= 1.8)`)
      }
    }
    console.log('')
  }
}

if (problems.length) {
  for (const p of problems) console.log(`  FAIL  ${p}`)
  console.log(`\n${problems.length} problem(s)\n`)
  process.exit(1)
}
console.log('raccoon layout ok\n')

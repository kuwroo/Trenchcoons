// Stylised cloud layer — thin, high, wispy cirrus.
//
// REWRITTEN AGAINST THE NEW BRIEF. The previous version was authored for the
// painterly direction: coverage 0.47, opacity 0.97, a hard 0.085-wide alpha
// edge and two extra octaves of internal "modelling" so a tile landing wholly
// inside a cloud still had structure in it. That is a recipe for large opaque
// masses with hard silhouettes, and the user's report was exactly that — "the
// sky is weirdly blobby".
//
// ART_BIBLE §1: "Skies are a clean gradient with thin wispy cloud, never heavy
// blobs." refs/genshin/grasslands.jpg gives roughly a fifth of its sky to
// cloud, all of it thin enough to read the gradient through, all of it drawn
// out into streaks by altitude wind. Four things changed to get there:
//
//   HIGHER    2400 m -> 6200 m. Altitude is most of what makes cirrus read as
//             cirrus: the plane projection flattens, the features shrink toward
//             the horizon instead of ballooning overhead, and the layer stops
//             dominating a frame that is pitched up.
//   THINNER   the alpha is now proportional to how far the density is ABOVE the
//             coverage threshold, not a smoothstep that saturates a texel past
//             it. A cloud has to be deep before it is opaque, and almost none
//             of them are.
//   SPARSER   coverage 0.47 -> 0.26, opacity 0.97 -> 0.58.
//   STREAKED  the across-wind axis is squashed 0.30 instead of 0.62, and the
//             octave count drops from 4+2 to 3+1. Fewer octaves is not a
//             saving here, it is the LOOK: high-frequency detail in the sky is
//             the fine-scale texture tools/complaints.mjs measures and no
//             reference has any.
//
// The pink-and-lavender colour anchors from ART_BIBLE §4 are untouched. They
// were never the problem.

import {
  dot, float, mix, mx_fractal_noise_float, pow, saturate, smoothstep, vec2, vec3,
} from 'three/tsl'
import type { Node } from 'three/webgpu'
import type { SkyNodes } from './scattering'

/** Metres. Cirrus altitude, not cumulus. */
const CLOUD_HEIGHT = 6200
/** Inverse feature size in metres. */
const CLOUD_SCALE = 1 / 7600
/**
 * How far past the coverage threshold the density has to go before the layer is
 * fully opaque. Large = thin veils; the old code effectively used 0.085.
 */
const DEPTH_TO_OPAQUE = 0.38

export interface CloudSample {
  color: Node<'vec3'>
  alpha: Node<'float'>
}

export function cloudLayer(u: SkyNodes, dir: Node<'vec3'>): CloudSample {
  // Project the view ray onto the cloud plane.
  const upness = dir.y.max(0.02)
  const t = float(CLOUD_HEIGHT * CLOUD_SCALE).div(upness)
  const drift = vec2(u.cloudTime.mul(0.0042), u.cloudTime.mul(0.0015))
  // Squashed hard across the wind: cirrus is drawn out into long parallel
  // streaks, and that anisotropy is most of what separates it from cumulus.
  const q = vec2(dir.x.mul(0.30), dir.z).mul(t).add(drift)

  // Three octaves. The fourth and fifth were sub-pixel at this feature size and
  // their only visible contribution was the fine texture the sky is not allowed
  // to have.
  const base = mx_fractal_noise_float(vec3(q.x, q.y, 0.31), 3, 2.05, 0.52, 1)
  const wisp = mx_fractal_noise_float(vec3(q.x.mul(2.2).add(17.2), q.y.mul(2.2), 4.1), 1, 2.1, 0.5, 1)
  const density = base.mul(0.5).add(0.5).add(wisp.mul(0.06))

  // Coverage as a THRESHOLD, thickness as the distance above it.
  //
  // The old version took `cover` — a saturating smoothstep 0.085 wide — as the
  // alpha, so any texel a fraction past the threshold was a fully opaque cloud
  // and the layer was a binary mask with a hard edge. Alpha now grows linearly
  // with depth over a range four times wider than that whole edge, which is
  // what makes the mass read as translucent and lets the gradient show through
  // the middle of it.
  const edge = u.cloudCoverage.oneMinus()
  const depth = saturate(density.sub(edge).div(float(DEPTH_TO_OPAQUE)))
  // A soft-shouldered ramp rather than a step: thin cirrus has no silhouette.
  const body = pow(depth, float(1.35))

  // Cheap directional term: thin edges read as lit, thick cores as shadowed.
  // At these depths almost everything is an edge, which is correct — a cirrus
  // deck is lit through.
  const mu = dot(dir, u.sunDir)
  const towardSun = pow(saturate(mu), 3).mul(0.45).add(0.72)
  const shade = mix(u.cloudLit, u.cloudShadow, pow(depth, float(2.2)).mul(0.7))
  const rim = u.cloudLit.mul(pow(saturate(mu), 12)).mul(0.6)
  const color = vec3(shade.mul(towardSun).add(rim))

  // Clouds thin out toward the horizon rather than stopping above it. Widened
  // slightly with the altitude change, because a 6.2 km deck genuinely does
  // compress into a band near the horizon.
  const horizonFade = smoothstep(0.003, 0.075, dir.y)
  const alpha = body.mul(horizonFade).mul(u.cloudOpacity)
  return { color, alpha }
}

// Stylised cloud layer.
//
// Not volumetric — a single plane-projected fBm slab evaluated on the sky dome.
// ART_BIBLE is explicit that colour matters more than technique here: the clouds
// in refs/painterly/cliffs-tohad.jpg are PINK where lit and LAVENDER where
// self-shadowed, and that single choice does more work than any raymarcher.

import {
  dot, float, mix, mx_fractal_noise_float, mx_noise_float, pow, saturate, smoothstep,
  vec2, vec3,
} from 'three/tsl'
import type { Node } from 'three/webgpu'
import type { SkyNodes } from './scattering'

/** Metres. Low enough that the plane projection reads as perspective. */
const CLOUD_HEIGHT = 2400
/** Inverse feature size in metres. */
const CLOUD_SCALE = 1 / 4400

export interface CloudSample {
  color: Node<'vec3'>
  alpha: Node<'float'>
}

export function cloudLayer(u: SkyNodes, dir: Node<'vec3'>): CloudSample {
  // Project the view ray onto the cloud plane.
  const upness = dir.y.max(0.018)
  const t = float(CLOUD_HEIGHT * CLOUD_SCALE).div(upness)
  const drift = vec2(u.cloudTime.mul(0.0068), u.cloudTime.mul(0.0024))
  // x squashed slightly: gives the wispy, drawn-out banks the refs have.
  const q = vec2(dir.x.mul(0.62), dir.z).mul(t).add(drift)

  // Four octaves, not five: the fifth lands under a pixel at this feature
  // size and the dome shader is the most expensive in the frame.
  const base = mx_fractal_noise_float(vec3(q.x, q.y, 0.31), 4, 2.03, 0.55, 1)
  const wisp = mx_fractal_noise_float(
    vec3(q.x.mul(3.4).add(17.2), q.y.mul(3.4), 4.1), 2, 2.1, 0.5, 1,
  )
  const density = base.mul(0.5).add(0.5).add(wisp.mul(0.085))

  // A CRISP edge, not a 0.26-wide ramp.
  //
  // The soft edge is why every capture's sky read as a smear rather than as the
  // pink cumulus in cliffs-tohad.jpg: a cloud whose alpha takes a quarter of the
  // density range to reach 1 has no boundary anywhere, and a sky with no
  // boundaries has no local structure at all. Measured on atmos-clouds-noon,
  // 60% of the gated region — which is mostly sky, because that shot looks up —
  // came back below the structure gate's dead-flat threshold. The references cut
  // their cloud silhouettes hard and put the softness INSIDE the mass.
  const edge = u.cloudCoverage.oneMinus()
  const cover = smoothstep(edge, edge.add(0.085), density)
  const thickness = saturate(density.sub(edge).mul(1.9))
  // Internal form. Two extra octaves inside the mass, so a tile that lands
  // wholly inside a cloud still has modelling in it rather than being a flat
  // pink field — this is the "softness inside the mass" half of the above.
  const lobe = mx_noise_float(vec3(q.x.mul(2.6).add(5.1), q.y.mul(2.6).add(9.4), 1.7))
    .mul(0.5)
    .add(mx_noise_float(vec3(q.x.mul(6.1).add(21.3), q.y.mul(6.1), 8.2)).mul(0.28))
  const modelled = saturate(thickness.mul(0.6).add(lobe.mul(0.52)).add(0.14))

  // Cheap directional term: thin edges read as lit, thick cores as shadowed.
  const mu = dot(dir, u.sunDir)
  const towardSun = pow(saturate(mu), 3).mul(0.5).add(0.6)
  const body = mix(u.cloudLit, u.cloudShadow, pow(modelled, 1.1))
  const rim = u.cloudLit.mul(pow(saturate(mu), 14)).mul(0.85)
  const color = vec3(body.mul(towardSun).add(rim))

  // Clouds thin out toward the horizon rather than stopping 11 degrees above it.
  // The old 0.015..0.2 fade deleted them across the entire lower sky, which is
  // most of the frame in any shot with the camera pitched up.
  const horizonFade = smoothstep(0.004, 0.055, dir.y)
  const alpha = cover.mul(horizonFade).mul(u.cloudOpacity)
  return { color, alpha }
}

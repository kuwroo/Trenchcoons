// Stylised cloud layer.
//
// Not volumetric — a single plane-projected fBm slab evaluated on the sky dome.
// ART_BIBLE is explicit that colour matters more than technique here: the clouds
// in refs/painterly/cliffs-tohad.jpg are PINK where lit and LAVENDER where
// self-shadowed, and that single choice does more work than any raymarcher.

import { dot, float, mix, mx_fractal_noise_float, pow, saturate, smoothstep, vec2, vec3 } from 'three/tsl'
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

  const edge = u.cloudCoverage.oneMinus()
  const cover = smoothstep(edge, edge.add(0.26), density)
  const thickness = saturate(density.sub(edge).mul(2.0))

  // Cheap directional term: thin edges read as lit, thick cores as shadowed.
  const mu = dot(dir, u.sunDir)
  const towardSun = pow(saturate(mu), 3).mul(0.5).add(0.6)
  const body = mix(u.cloudLit, u.cloudShadow, pow(thickness, 1.25))
  const rim = u.cloudLit.mul(pow(saturate(mu), 14)).mul(0.85)
  const color = vec3(body.mul(towardSun).add(rim))

  // Clouds must not stack up into a hard band at the horizon — the haze eats
  // them, exactly as in the references.
  const horizonFade = smoothstep(0.015, 0.2, dir.y)
  const alpha = cover.mul(horizonFade).mul(u.cloudOpacity)
  return { color, alpha }
}

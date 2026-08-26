// Sky, sky IBL, and aerial perspective.
//
// Owns render-graph pass 1 (atmosphere LUTs) and the sky dome drawn in pass 9.
//
// Two LUTs, both rebuilt only when the time of day actually changes:
//
//   skyView     256x128 equirect, RGBA16F — analytic scattering, no sun disc,
//               no clouds. Read by aerial perspective: "what colour is the air
//               in that direction".
//   irradiance   48x24  equirect, RGBA16F — cosine-weighted hemisphere integral
//               of the sky plus a ground-bounce term. Read by the painterly
//               material as its ONLY ambient source.
//
// The second is the load-bearing one. CLAUDE.md: "Ambient comes from the sky
// LUT, never a constant." Constant ambient is the fastest way to make a
// stylised renderer look dead, and it is why lifted coloured shadows work here.

import * as THREE from 'three/webgpu'
import {
  cameraPosition, dot, equirectDirection, equirectUV, float, luminance, mix, positionLocal,
  smoothstep, texture, uniform, uv, vec3, vec4,
} from 'three/tsl'
import type { Node } from 'three/webgpu'
import { cloudLayer } from './clouds'
import { SunShadow } from './sunShadow'
import { boostSaturation, setSaturation, skyRadiance, sunDisc, type SkyNodes } from './scattering'
import {
  SKY_INTENSITY, SKY_LUM_GAMMA, TAU_MIE, TAU_RAYLEIGH, evaluateSky, linearFromHex, makeSkyState,
  type SkyState,
} from './tod'

const SKYVIEW_W = 256
const SKYVIEW_H = 128
const IRR_W = 48
const IRR_H = 24
const DOME_RADIUS = 11_000
const IRR_SAMPLES = 32

/** Deterministic Fibonacci sphere — no Math.random anywhere in generation. */
function fibonacciSphere(n: number): THREE.Vector3[] {
  const golden = Math.PI * (3 - Math.sqrt(5))
  const out: THREE.Vector3[] = []
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * i + 1) / n
    const r = Math.sqrt(Math.max(0, 1 - y * y))
    const th = golden * i
    out.push(new THREE.Vector3(Math.cos(th) * r, y, Math.sin(th) * r))
  }
  return out
}

const IRR_DIRS = fibonacciSphere(IRR_SAMPLES)

function makeTarget(w: number, h: number): THREE.RenderTarget {
  const rt = new THREE.RenderTarget(w, h, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    // Equirect u wraps; v must clamp or the poles bleed across the seam.
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
  })
  rt.texture.colorSpace = THREE.NoColorSpace
  rt.texture.name = `atmosphere-lut-${w}x${h}`
  return rt
}

export class Atmosphere {
  readonly state: SkyState = makeSkyState()
  readonly nodes: SkyNodes
  readonly dome: THREE.Mesh
  /**
   * Render-graph pass 6. Lives here because the painterly material needs its
   * visibility node and already depends on this class for everything else
   * light-related; main.ts drives the render itself.
   */
  readonly shadow = new SunShadow()

  /** Direct sunlight, colour x intensity. The material's only direct term. */
  readonly sunColorNode = uniform(new THREE.Vector3(1, 1, 1))
  readonly ambientGainNode = uniform(1)
  readonly hazeDensityNode = uniform(0.001)
  readonly hazeGainNode = uniform(1)
  /** Metres of clear air in front of the camera before haze engages. */
  readonly hazeStartNode = uniform(250)
  /** Mean horizon hue. Read by post for the sky-tinted shadow lift. */
  readonly horizonTintNode = uniform(new THREE.Vector3(1, 1, 1))
  /** See `ambientWarm` in tod.ts. */
  private readonly ambientWarmNode = uniform(0)
  /** See `shadowTintBoost` in tod.ts. Read by the painterly material. */
  readonly shadowTintBoostNode = uniform(1)
  /**
   * Chroma pushed into the haze target. The heavy-atmosphere register in
   * refs/mkw/desert-sunset-haze.jpg is meanSat 0.76 — monochrome in HUE and
   * hyper-saturated in chroma. Round 1 read "near-monochrome" as "grey" and
   * measured 0.30.
   */
  private readonly hazeSatNode = uniform(1.75)
  /** Scale height of the haze, metres. Hilltops punch through. */
  readonly hazeHeightNode = uniform(1100)
  readonly exposureNode = uniform(1)
  readonly gradeTintNode = uniform(new THREE.Vector3(1, 1, 1))
  /** See `gradeSat` in tod.ts. */
  readonly gradeSatNode = uniform(1)
  /** See `rampScale` in tod.ts. Read by the painterly material. */
  readonly rampScaleNode = uniform(1)

  private readonly skyViewTarget = makeTarget(SKYVIEW_W, SKYVIEW_H)
  private readonly irradianceTarget = makeTarget(IRR_W, IRR_H)
  private readonly groundAlbedo = uniform(new THREE.Vector3(0.2, 0.28, 0.12))
  private readonly ambientSat = uniform(0.55)
  private readonly quad = new THREE.QuadMesh()
  private readonly skyViewMaterial = new THREE.NodeMaterial()
  private readonly irradianceMaterial = new THREE.NodeMaterial()
  private lutsDirty = true

  constructor(tod: number) {
    const u: SkyNodes = {
      sunDir: uniform(new THREE.Vector3(0, 1, 0)),
      sunTransmittance: uniform(new THREE.Vector3(1, 1, 1)),
      sunAzimuth: uniform(new THREE.Vector3(0, 0, -1)),
      zenithTint: uniform(new THREE.Vector3(1, 1, 1)),
      horizonWarm: uniform(new THREE.Vector3(1, 1, 1)),
      horizonCool: uniform(new THREE.Vector3(1, 1, 1)),
      tauRayleigh: uniform(TAU_RAYLEIGH.clone()),
      tauMie: uniform(TAU_MIE.clone()),
      skyIntensity: uniform(SKY_INTENSITY),
      skyLumGamma: uniform(SKY_LUM_GAMMA),
      // A physical sky is markedly less chromatic than the reference board.
      // These two knobs close most of that gap; see scattering.ts.
      // The noon zenith needs to land near the master palette's #3FA9F5
      // (HSL sat 0.90); round 1 measured rgb(88,145,210), sat 0.58.
      skySaturation: uniform(5.2),
      skySatHorizon: uniform(0.5),
      // Driven per-TOD from evaluateSky, not a constant. See tod.ts.
      anchorMix: uniform(0.68),
      sunDiscIntensity: uniform(0),
      cloudLit: uniform(new THREE.Vector3(1, 1, 1)),
      cloudShadow: uniform(new THREE.Vector3(1, 1, 1)),
      cloudCoverage: uniform(0.44),
      cloudOpacity: uniform(0.94),
      cloudTime: uniform(0),
    }
    this.nodes = u
    linearFromHex(0x7fa83c, this.groundAlbedo.value)

    // ── pass 1a: sky-view LUT ────────────────────────────────────────────────
    this.skyViewMaterial.fragmentNode = vec4(skyRadiance(u, equirectDirection(uv())), 1)
    this.skyViewMaterial.name = 'atmosphere-skyview'

    // ── pass 1b: irradiance LUT ──────────────────────────────────────────────
    // The loop is unrolled on the CPU, so `d.y > 0` is a build-time decision
    // and the shader contains no branches at all.
    const n = equirectDirection(uv())
    let cosWeighted: Node<'vec3'> = vec3(0, 0, 0)
    let radianceSum: Node<'vec3'> = vec3(0, 0, 0)
    let downWeight: Node<'float'> = float(0)
    let upCount = 0
    for (const d of IRR_DIRS) {
      const dn = vec3(d.x, d.y, d.z)
      const c = dot(n, dn).max(0)
      if (d.y > 0) {
        const radiance = skyRadiance(u, dn)
        radianceSum = vec3(radianceSum.add(radiance))
        cosWeighted = vec3(cosWeighted.add(radiance.mul(c)))
        upCount++
      } else {
        downWeight = downWeight.add(c)
      }
    }
    const avgSky = vec3(radianceSum.mul(1 / Math.max(upCount, 1)))
    const bounce = vec3(avgSky.mul(this.groundAlbedo).mul(downWeight).mul(1.7))
    // (4*PI/N)/PI = 4/N — converts the sum straight into an albedo multiplier.
    //
    // Then pulled back off full chroma. `skySaturation` is tuned for the sky
    // DOME, where the reference board wants an electric blue; running the same
    // chroma through the ambient makes every shaded surface in the world navy,
    // and the references keep their shade the albedo's own hue with a cool cast
    // (grasslands.jpg grass-shadow is hue 124, still green). Hemispherical
    // averaging plus a ground bounce is also the physical reason it should be
    // less chromatic than any single sky direction. Driven per-TOD: see
    // `ambientSat` in tod.ts for why low sun needs the opposite treatment.
    this.irradianceMaterial.fragmentNode = vec4(
      setSaturation(vec3(cosWeighted.add(bounce).mul(4 / IRR_SAMPLES)), this.ambientSat), 1,
    )
    this.irradianceMaterial.name = 'atmosphere-irradiance'

    // ── pass 9: the dome ─────────────────────────────────────────────────────
    // Re-centred on the camera each frame, so object space is the view
    // direction and stays exact after origin rebasing.
    const dir = vec3(positionLocal.normalize())
    const clouds = cloudLayer(u, dir)
    const sky = skyRadiance(u, dir)
    const disc = vec3(sunDisc(u, dir).mul(clouds.alpha.oneMinus()))

    const mat = new THREE.MeshBasicNodeMaterial()
    mat.colorNode = vec3(mix(sky, clouds.color, clouds.alpha).add(disc))
    mat.side = THREE.BackSide
    mat.depthWrite = false
    // Depth-TESTED and drawn LAST, which is both what ARCHITECTURE's graph
    // order says (sky is pass 9, after opaque 8) and a real saving: the dome
    // fragment shader is the most expensive in the frame — analytic scattering
    // plus a six-octave cloud fBm — and drawing it first with the test off paid
    // for it on every pixel the terrain then covered. The radius has to clear
    // the far corners of the ground plane for this to be safe; at 11km it does,
    // with the camera's far plane at 12km.
    mat.depthTest = true
    mat.fog = false
    mat.name = 'sky-dome'

    this.dome = new THREE.Mesh(new THREE.SphereGeometry(DOME_RADIUS, 64, 40), mat)
    this.dome.frustumCulled = false
    this.dome.renderOrder = 1000
    this.dome.name = 'sky-dome'

    this.setTimeOfDay(tod)
  }

  /** Sky irradiance arriving at a surface with world normal `n`. From the LUT. */
  skyIrradiance(n: Node<'vec3'>): Node<'vec3'> {
    const lut = vec3(texture(this.irradianceTarget.texture, equirectUV(n)).rgb)
    // At low sun, rotate the chromaticity onto the warm horizon anchor while
    // keeping the LUT's level. See `ambientWarm` in tod.ts for why the integral
    // needs this and why doing it as a hue-only operation is the honest form.
    const warm = boostSaturation(
      vec3(this.nodes.horizonWarm.mul(luminance(lut))), 1.25,
    )
    return vec3(mix(lut, warm, this.ambientWarmNode))
  }

  /** Sky radiance looking along `dir`. From the LUT. */
  skyLookup(dir: Node<'vec3'>): Node<'vec3'> {
    return vec3(texture(this.skyViewTarget.texture, equirectUV(dir)).rgb)
  }

  /**
   * Aerial perspective, applied IN-SHADER (ARCHITECTURE: not a post pass).
   * Haze + desaturation + hue shift toward the sky colour in that exact
   * direction. Never a grey fog lerp — that rule is the whole point.
   */
  aerialPerspective(color: Node<'vec3'>, worldPos: Node<'vec3'>): Node<'vec3'> {
    const toPoint = vec3(worldPos.sub(cameraPosition))
    const dist = toPoint.length()
    const dir = vec3(toPoint.div(dist.max(1e-3)))

    const midHeight = worldPos.y.add(cameraPosition.y).mul(0.5).max(0)
    const heightAtten = midHeight.div(this.hazeHeightNode).negate().exp()
    // A CONTINUOUS near-field rolloff, not a hard start distance.
    //
    // Round 2 integrated from `dist - hazeStart` with hazeStart at 260-410 m,
    // which zeroes aerial perspective across the entire range a gameplay camera
    // can see: grass 15 m out and a ridge 1 km out came back 4 degrees of hue
    // and 0.05 of chroma apart, so the whole frame read as one uniform slab
    // with the far pyramids stepping abruptly to pale blue. Folding a
    // smoothstep INTO the optical depth protects the first ~40 m of albedo —
    // which is what the hard start was really for — while still letting the
    // ladder build continuously from there.
    const optical = dist.mul(smoothstep(this.hazeStartNode.mul(0.12), this.hazeStartNode, dist))
      .mul(this.hazeDensityNode).mul(heightAtten)
    // Capped just below 1: even the furthest silhouette keeps a chroma residue
    // rather than dissolving completely into the sky.
    const f = optical.negate().exp().oneMinus().mul(0.92)

    // Distance is a hue shift toward the sky, plus a real loss of chroma.
    //
    // The haze TARGET's chroma now falls with f. Round 2 boosted it by a flat
    // 1.75-3.1, so distance ADDED saturation and the most distant ridge in
    // frame was the most chromatic thing in it — a hard indigo cutout instead
    // of haze. Both desert references desaturate monotonically toward the
    // horizon (0.31 -> 0.16 and 0.34 -> 0.18 near to far), and a depth ladder
    // that inverts is the single loudest "this is not a painting" tell.
    const hazeColor = boostSaturation(
      vec3(this.skyLookup(dir).mul(this.hazeGainNode)),
      this.hazeSatNode.mul(f.mul(0.38).oneMinus()),
    )
    const faded = setSaturation(color, f.mul(0.34).oneMinus())
    return vec3(mix(faded, hazeColor, f))
  }

  setTimeOfDay(tod: number): void {
    const s = evaluateSky(tod, this.state)
    const u = this.nodes
    u.sunDir.value.copy(s.sunDir)
    u.sunTransmittance.value.copy(s.sunTransmittance)
    u.zenithTint.value.copy(s.zenithTint)
    u.horizonWarm.value.copy(s.horizonWarm)
    u.horizonCool.value.copy(s.horizonCool)
    u.sunAzimuth.value.set(s.sunDir.x, 0, s.sunDir.z)
    if (u.sunAzimuth.value.lengthSq() < 1e-8) u.sunAzimuth.value.set(0, 0, -1)
    u.sunAzimuth.value.normalize()
    u.tauMie.value.copy(TAU_MIE).multiplyScalar(s.mieScale)
    u.anchorMix.value = s.anchorMix
    u.sunDiscIntensity.value = s.sunDiscIntensity
    u.cloudLit.value.copy(s.cloudLit)
    u.cloudShadow.value.copy(s.cloudShadow)
    u.cloudCoverage.value = s.cloudCoverage
    u.cloudOpacity.value = s.cloudOpacity

    this.sunColorNode.value.copy(s.sunColor)
    this.ambientGainNode.value = s.ambientGain
    this.horizonTintNode.value.copy(s.horizonTint)
    this.ambientSat.value = s.ambientSat
    this.ambientWarmNode.value = s.ambientWarm
    this.shadowTintBoostNode.value = s.shadowTintBoost
    this.hazeSatNode.value = s.hazeSat
    this.nodes.skySaturation.value = s.skySaturation
    this.nodes.skySatHorizon.value = s.skySatHorizon
    this.hazeDensityNode.value = s.hazeDensity
    this.hazeGainNode.value = s.hazeGain
    this.hazeStartNode.value = s.hazeStart
    this.exposureNode.value = s.exposure
    this.gradeTintNode.value.copy(s.gradeTint)
    this.gradeSatNode.value = s.gradeSat
    this.rampScaleNode.value = s.rampScale
    this.lutsDirty = true
  }

  /**
   * Render-graph pass 1 — atmosphere LUTs. Free when the time of day is static,
   * which is exactly the caching ARCHITECTURE asks for.
   */
  updateLuts(renderer: THREE.Renderer): void {
    if (!this.lutsDirty) return
    this.lutsDirty = false

    const prev = renderer.getRenderTarget()
    this.quad.material = this.skyViewMaterial
    renderer.setRenderTarget(this.skyViewTarget)
    this.quad.render(renderer)
    this.quad.material = this.irradianceMaterial
    renderer.setRenderTarget(this.irradianceTarget)
    this.quad.render(renderer)
    renderer.setRenderTarget(prev)
  }

  /** Render-graph pass 9 — sky. The dome rides the camera; clouds drift. */
  updateSky(camera: THREE.Camera, elapsed: number): void {
    this.nodes.cloudTime.value = elapsed
    this.dome.position.setFromMatrixPosition(camera.matrixWorld)
  }

  /** Fraction of the sun reaching a world position. Pass 6's output. */
  sunVisibility(worldPos: Node<'vec3'>): Node<'float'> {
    return this.shadow.visibility(worldPos, this.nodes.sunDir)
  }

  dispose(): void {
    this.shadow.dispose()
    this.skyViewTarget.dispose()
    this.irradianceTarget.dispose()
    this.dome.geometry.dispose()
  }
}

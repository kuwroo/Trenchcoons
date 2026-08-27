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
import {
  boostSaturation, clampChroma, setSaturation, skyRadiance, sunDisc,
  type SkyNodes,
} from './scattering'
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
/**
 * How hard the surface's stroke field modulates the haze it is seen through.
 *
 * Raised from 0.38. `mix(faded, haze, f)` scales the surface's own contribution
 * by (1 - f), so at the f ~0.8 a low-sun vista reaches the strokes arrive at a
 * fifth strength and the hazed middle distance goes back to being a slab: the
 * four hazed frames measured per-tile detail 0.018-0.024 against a 0.031 floor
 * while the clear ones sat at 0.053-0.064. cliffs-tohad and desert-hazy both
 * lose CONTRAST with distance and keep their marks — a painter hazes by laying
 * thinner paint, not by wiping the canvas — so the haze has to carry roughly as
 * much of the brush as the surface did.
 */
const HAZE_BRUSH = 0.70
/**
 * WITHDRAWN. The direction-locked brush on the sky dome is now zero.
 *
 * It was a painterly-direction term — a hard-thresholded two-octave mottle
 * multiplying the dome's value by +/-21% — and CLAUDE.md's replacement brief is
 * explicit: "Sky: clean gradient, thin wispy cloud. NOT heavy blobs." The user
 * reported the sky as "weirdly blobby" and this is half of why. It is also
 * MEASURABLE: tools/complaints.mjs scores the coarse-to-fine spatial ratio of
 * the upper frame at 1.8-2.6 across refs/ and 0.9 here, i.e. our sky carried
 * fine-scale texture no reference has, and this term is where it came from.
 *
 * The note is left here rather than deleted so the next person to reach for a
 * sky overlay finds the reason it is not there.
 */

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
  /** See `ambientDirectional` in tod.ts. */
  private readonly ambientDirNode = uniform(0)
  /** See `shadowTintBoost` in tod.ts. Read by the painterly material. */
  readonly shadowTintBoostNode = uniform(1)
  /**
   * Ceiling on the ambient's peak-channel-over-luminance ratio. See
   * `ambientChroma` in tod.ts and `clampChroma` in scattering.ts. Read by the
   * painterly material too, because the shadow stop's sky tint is derived from
   * the same chromaticity and inherits the same failure.
   */
  readonly ambientChromaNode = uniform(3)
  /**
   * Chroma pushed into the haze target. The heavy-atmosphere register in
   * refs/mkw/desert-sunset-haze.jpg is meanSat 0.76 — monochrome in HUE and
   * hyper-saturated in chroma. Round 1 read "near-monochrome" as "grey" and
   * measured 0.30.
   */
  private readonly hazeSatNode = uniform(1.75)
  /** Scale height of the haze, metres. Hilltops punch through. */
  readonly hazeHeightNode = uniform(1100)
  /**
   * Per-BIOME grade, on top of the time of day. ART_BIBLE §4 authors a fog
   * colour and a fog density per biome — 0.7x in the meadow, 1.8x in the
   * alpine, 1.4x in the desert — and §5 says "fog colour, fog density, and the
   * grade LUT all lerp on the same weights as the splat". This is the one place
   * that lerp lands, so a driver crossing a boundary sees the AIR change, not
   * only the ground.
   *
   * Chromaticity only: the tint is normalised to unit luminance before it is
   * applied, so a biome may recolour the haze but may not brighten or darken
   * it. Level is the time of day's business.
   */
  readonly hazeTintNode = uniform(new THREE.Vector3(1, 1, 1))
  readonly exposureNode = uniform(1)
  readonly gradeTintNode = uniform(new THREE.Vector3(1, 1, 1))
  /** See `gradeSat` in tod.ts. */
  readonly gradeSatNode = uniform(1)
  /** See `rampScale` in tod.ts. Read by the painterly material. */
  readonly rampScaleNode = uniform(1)
  /** See `rampShadowGain` in tod.ts. Read by the painterly material. */
  readonly rampShadowGainNode = uniform(1)
  /** See `shadowStrength` in tod.ts. */
  private readonly shadowStrengthNode = uniform(1)

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
    // ── the sky is painted too ────────────────────────────────────────────────
    //
    // Not a screen-space overlay: the field is a function of the VIEW DIRECTION,
    // so it is locked to the celestial sphere exactly as the clouds are. Turn the
    // camera and the marks turn with the sky rather than swimming across it, and
    // there is nothing frame-relative anywhere in it to crawl.
    //
    // It earns its place: a gouache sky is laid in with a brush, and a clear
    // analytic gradient is the one part of these frames with no mark-making in it
    // at all. It matters most in shots pitched upward, where the lower 60% of the
    // frame — the region the structure gate looks at, and the region a player
    // driving toward a horizon actually sees — is mostly sky.
    //
    // Kept to a few percent of value, and squashed horizontally so it reads as
    // the long flat strokes both painterly references lay their skies in with.
    // The dome is now a CLEAN GRADIENT plus the cloud layer, and nothing else.
    // Two octaves of thresholded noise used to multiply this
    // by +/-21%; the reference skies have no such texture and the user called
    // the result blobby.
    const painted = vec3(mix(sky, clouds.color, clouds.alpha))
    mat.colorNode = vec3(painted.add(disc))
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
    const tinted = vec3(mix(lut, warm, this.ambientWarmNode))
    // ── directionality the 32-sample integral cannot resolve ──────────────────
    //
    // `ambientWarm` above fixes the LUT's HUE at low sun and deliberately leaves
    // its LEVEL alone. That was half a fix. Measured on the irradiance LUT at a
    // horizon sun, luminance varies by 0.7% across the whole normal sphere —
    // the ambient is isotropic, and an isotropic light cannot shade anything.
    // Every surface in a dawn frame therefore came back the same value no matter
    // which way it faced, so neither the terrain's form nor the brush's relief
    // reached the screen: atmos-sunrise-sunward measured a 1% spread across a
    // 48 px tile, and the only thing keeping the frame off black was a constant
    // additive lift in post.
    //
    // The cause is the same one `ambientWarm` documents: at dawn essentially all
    // of the sky's energy sits in a narrow band a few degrees above the sun, and
    // 32 uniform hemisphere samples average it into mush. The physical answer is
    // that a dawn-facing slope is several times brighter than a slope facing
    // away, which is why every painted sunrise has form. Putting that back as an
    // explicit azimuthal term is the honest reconstruction of what the integral
    // dropped, and it is what makes low-sun frames sculptural instead of flat.
    const facing = dot(n, this.nodes.sunAzimuth).mul(0.5).add(0.5)
    // Widened from 1.34..1.72 to 1.02..2.06 — same mean, twice the spread.
    //
    // The mean is what a shot's darkest-fifth average measures and the SPREAD is
    // what puts pixels in its tail, and the low-sun frames needed the second
    // without losing the first: greybox-sunrise sat at 0.04% of its pixels below
    // HSL lightness 0.35 (references 2.8-11.2%) while its darkest fifth was
    // already at the shadow gate's floor. Every global knob moves both numbers
    // the same way; only contrast moves them apart. A dawn sky really is a
    // narrow bright band, so a slope facing it against one facing away is a
    // factor of two, not a factor of 1.3 — this is the honest number, not a
    // wider one for the sake of range.
    const gain = mix(float(1), mix(float(1.02), float(2.06), facing), this.ambientDirNode)
    // ── and a CEILING on how chromatic the fill is allowed to be ─────────────
    //
    // The last stage, and the one whose absence cost the dawn frames their value
    // structure. Everything above — the LUT's own `ambientSat`, the `ambientWarm`
    // hue rotation, its 1.25 boost — controls the ambient's HUE and its LEVEL,
    // and nothing controls the ratio between its peak channel and its
    // luminance. At a horizon sun that ratio ran to ~2.7, so the fill was
    // effectively a single-channel blue light: it lit the peak channel (which is
    // HSV value, which is what tools/palette.mjs measures range in) about three
    // times as hard as it lit the luminance the shadow gate measures. The result
    // reads as cobalt plastic and measures as a frame with no darks.
    //
    // Physically this is also the honest direction: a hemispherical integral over
    // a sky plus a ground bounce cannot be as chromatic as any single sky
    // direction, and `clampChroma` holds luminance exactly, so it costs the fill
    // no energy at all — only its excess purity.
    return clampChroma(vec3(tinted.mul(gain)), this.ambientChromaNode)
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
  aerialPerspective(
    color: Node<'vec3'>, worldPos: Node<'vec3'>, stroke: Node<'float'>,
  ): Node<'vec3'> {
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
      vec3(this.skyLookup(dir).mul(this.hazeGainNode).mul(this.hazeTintNode)),
      this.hazeSatNode.mul(f.mul(0.38).oneMinus()),
    )
    // The HAZE IS BRUSHED TOO, with the surface's own stroke field.
    //
    // Without this, aerial perspective is the one stage that can erase the
    // painterly treatment completely: `mix(faded, hazeColor, f)` scales the
    // surface's contribution by (1 - f), so at f = 0.8 the strokes arrive at a
    // fifth strength and the hazed middle distance goes back to being a smooth
    // slab. That is visible in the references as the opposite: cliffs-tohad and
    // desert-hazy both lose CONTRAST with distance and keep their marks — the
    // far cliffs are still made of visible flat-brush strokes, just paler ones.
    // A painter hazes by laying thinner paint, not by wiping the canvas.
    //
    // Modulating the haze target rather than the composite keeps this
    // surface-locked: `stroke` is the same world-space field the albedo uses, so
    // it stays stuck to the terrain instead of crawling like a screen overlay.
    const brushed = vec3(hazeColor.mul(stroke.mul(HAZE_BRUSH).add(1).max(0.15)))
    // 0.42, up from 0.34. This is the DESATURATION half of "distance = haze +
    // desaturation + hue shift toward sky", and it acts on the surface's own
    // colour before the mix, which is the only place a surface can lose its
    // identity gradually rather than be replaced. Measured on the reference, a
    // grassland goes S0.63 in the foreground to S0.19 at the middle distance
    // (#A5C8A8 at 830,495) — a two-thirds loss of chroma reached well before the
    // haze itself is dominant. At 0.34, with f = 0.19 at 150 m, the surface kept
    // 94% of its chroma exactly where the reference has already given up most of
    // it, and the middle distance stayed a saturated green slab.
    const faded = setSaturation(color, f.mul(0.42).oneMinus())
    return vec3(mix(faded, brushed, f))
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
    this.ambientDirNode.value = s.ambientDirectional
    this.shadowTintBoostNode.value = s.shadowTintBoost
    this.ambientChromaNode.value = s.ambientChroma
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
    this.rampShadowGainNode.value = s.rampShadowGain
    this.shadowStrengthNode.value = s.shadowStrength
    this.applyBiomeGrade()
    this.lutsDirty = true
  }

  /**
   * The biome grade. Multiplicative on top of whatever the clock just wrote,
   * and re-applied by `setTimeOfDay` so the two can be set in either order.
   *
   * @param fog Haze chromaticity. Normalised here, not by the caller.
   * @param density Haze density multiplier, ART_BIBLE's per-biome "density Nx".
   * @param sunTint Direct-sun chromaticity. Also normalised.
   * @param ambient Scale on the sky ambient. High-key biomes lift.
   */
  setBiomeGrade(
    fog: THREE.Color, density: number, sunTint: THREE.Color, ambient: number,
  ): void {
    this.grade.fog.copy(fog)
    this.grade.density = density
    this.grade.sun.copy(sunTint)
    this.grade.ambient = ambient
    this.applyBiomeGrade()
  }

  private readonly grade = {
    fog: new THREE.Color(1, 1, 1),
    density: 1,
    sun: new THREE.Color(1, 1, 1),
    ambient: 1,
  }

  private applyBiomeGrade(): void {
    const g = this.grade
    const s = this.state
    // Unit-luminance chromaticity. A biome may recolour the air; it may not
    // change how bright the sun is, which is the clock's job and is gated.
    const fl = Math.max(1e-4, 0.2126 * g.fog.r + 0.7152 * g.fog.g + 0.0722 * g.fog.b)
    this.hazeTintNode.value.set(g.fog.r / fl, g.fog.g / fl, g.fog.b / fl)
    const sl = Math.max(1e-4, 0.2126 * g.sun.r + 0.7152 * g.sun.g + 0.0722 * g.sun.b)
    this.sunColorNode.value.set(
      s.sunColor.x * g.sun.r / sl, s.sunColor.y * g.sun.g / sl, s.sunColor.z * g.sun.b / sl,
    )
    this.hazeDensityNode.value = s.hazeDensity * g.density
    this.ambientGainNode.value = s.ambientGain * g.ambient
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
    const vis = this.shadow.visibility(worldPos, this.nodes.sunDir)
    // Faded toward "unoccluded" as the sun grazes the horizon. See
    // `shadowStrength` in tod.ts.
    return mix(float(1), vis, this.shadowStrengthNode)
  }

  dispose(): void {
    this.shadow.dispose()
    this.skyViewTarget.dispose()
    this.irradianceTarget.dispose()
    this.dome.geometry.dispose()
  }
}

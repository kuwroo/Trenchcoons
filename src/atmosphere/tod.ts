// Time-of-day driver.
//
// Everything the look depends on is DERIVED from a single scalar `tod` (0..1,
// 0.25 sunrise, 0.5 noon, 0.75 sunset) plus a handful of palette anchors read
// off refs/painterly/cliffs-tohad.jpg. Deriving rather than keyframing is what
// keeps sky, sun, cloud, haze and grade from ever desyncing — the same failure
// mode ART_BIBLE §5 calls out for biomes.
//
// The sun tint is not authored: it is the analytic atmospheric transmittance
// along the sun ray, so "warm at sunrise, white at noon" falls out of the same
// Rayleigh/Mie constants the sky itself uses (see scattering.ts).

import * as THREE from 'three/webgpu'

/** Rayleigh optical depth at one zenith air mass, per channel. */
export const TAU_RAYLEIGH = new THREE.Vector3(0.0464, 0.1085, 0.2646)
/** Mie optical depth at one zenith air mass (turbidity baked in). */
export const TAU_MIE = new THREE.Vector3(0.022, 0.022, 0.022)
/** Henyey-Greenstein asymmetry for Mie. */
export const MIE_G = 0.72
/**
 * Scale applied to the physical sky luminance before the compression gamma.
 * Together these two set the sky's HDR level and its zenith-to-horizon ratio.
 */
export const SKY_INTENSITY = 16.0
export const SKY_LUM_GAMMA = 0.45

// ── The key/fill ratio — the single most load-bearing pair of numbers here ───
//
// Round 1 shipped a peak direct term of 0.62 against an ambient of ~1.0, so
// shade-vs-sun was 0.7 stops: no terminator, no cast shadow could read, and the
// entire frame collapsed into the top of the value scale (greybox-noon p05..p95
// was 0.784..0.953 against 0.486..0.996 in refs/painterly/cliffs-tohad.jpg).
//
// "Coloured and lifted" (ART_BIBLE §2) is a statement about the shadow's HUE
// and about where it sits AFTER the grade — not a licence to flood the scene
// with fill. The light now runs a ~2-stop key-to-fill ratio, the ambient stays
// sky-hued because it still comes only from the irradiance LUT, and the
// lifting is done deliberately in post (`shadowLift`, tinted to the horizon)
// where it can add colour instead of washing it out.

/** Peak direct-sun level. The key. */
export const SUN_KEY = 2.45
/**
 * Sky fill as a fraction of the key: ~1.8 stops down.
 *
 * The harsh critic's target band was 0.35-0.50 of the direct term. 0.34 sat at
 * the bottom of it and, combined with the cast shadow now actually selecting
 * the authored shadow STOP (a 4.7x darker albedo), took the darkest fifth of
 * the frame to Rec.709 luma 0.22-0.29 against a 0.37 landscape-reference mean —
 * i.e. past "lifted" and into crushed. `tools/shadow.mjs` measures exactly this
 * and it is the right check: HSV value cannot see it, because a saturated navy
 * scores value 0.51 while reading as almost black.
 */
export const AMBIENT_FILL = 0.42
/**
 * Level the irradiance LUT returns for an up-facing normal at noon. Pure
 * calibration: it turns AMBIENT_FILL into a multiplier on the LUT, so the
 * ratio above is expressed once and the ambient HUE still comes from the sky.
 */
const IRRADIANCE_AT_NOON = 2.95
/**
 * Scene exposure.
 *
 * Set by the LIT end, not the dark end. The landscape references put the mean
 * of their brightest fifth at Rec.709 luma 0.79-0.87 and their darkest fifth at
 * 0.32-0.44 — a wide range with LIFTED blacks, which is only possible if the
 * top of the frame is genuinely near white. Round 2's first pass held the lit
 * fifth at 0.52-0.62 and then had to crush the shadows to buy any range at all.
 * Raising both ends together is the honest fix; lifting the darks additively in
 * post is not, because an additive lift injects one hue and takes the chroma
 * out of exactly the pixels ART_BIBLE §2 wants coloured.
 */
const BASE_EXPOSURE = 1.26

/**
 * Elevation the sun reaches at dusk while dawn is still at the horizon.
 *
 * Without this, `sunDirection(0.25) === -sunDirection(0.75)` exactly, every
 * scalar derived from the sun's height is bit-identical at the two ends of the
 * day, and greybox-sunrise / greybox-dusk come out as the same picture with the
 * azimuth flipped. A real tilted axis does not mirror; neither does this.
 */
const DUSK_DECLINATION = 0.115

/** sunDirection(0.5).y — the anchor `rampScale` normalises against. */
const NOON_ELEVATION = 0.8525
/** Lowest elevation the ramp is allowed to shrink to. Below this it stops. */
const RAMP_FLOOR = 0.17

/**
 * How far a surface has to turn away from level before the ramp calls it
 * shadow, radians. See `rampShadowGain`. 25deg: enough that flat ground and the
 * gentle windward faces stay on the mid stop at every hour, little enough that
 * the anti-solar side of a hill is a real dark mass at noon.
 *
 * The 0.30 it is compared against is `PAINTERLY_DEFAULTS.rampShadow` — the
 * authored threshold this gain is expressed relative to. Kept as a literal
 * rather than an import because tod.ts is upstream of the material.
 */
const SHADOW_SLOPE_MARGIN = 25 * Math.PI / 180

// ── Palette anchors (ART_BIBLE §4 master palette) ─────────────────────────────
// Measured off refs/painterly/cliffs-tohad.jpg at (0.10, 0.40): rgb(189,187,251),
// H242 S0.25 — a PALE LAVENDER horizon.
//
// This was 0x4fd8f0 (H189 S0.67), which is the master palette's SEA colour
// wired into the sky. Because horizonTint feeds ambient, aerial perspective and
// the post shadow lift, that one constant smeared turquoise over every daylight
// frame: distant hills receded to teal instead of lavender-blue, and grass in
// shadow landed on H191 — hue-identical to the sky, so grass stopped reading as
// grass.
const HORIZON_LAVENDER = 0xbdbbfb
// Pre-compensated. The reference zenith (cliffs-tohad, centre column) measures
// H207 and holds it flat up the whole dome. Authoring H205 here landed at H197
// on screen: `boostSaturation` scales non-peak channels down, which pulls hue
// toward the dominant channel and rotates the sky ~8deg cyan. Authored at H215
// so it arrives at H207.
const ZENITH_BLUE = 0x2880fa
const CLOUD_PINK = 0xf5b4d8
const CLOUD_LAVENDER = 0xa694e8
const ANTISOLAR_MAUVE = 0x9a7fe8
const NIGHT_ZENITH = 0x1a2a55
const NIGHT_HORIZON = 0x2f4a72

const _c = new THREE.Color()

/** sRGB hex -> linear-sRGB working space, as a Vector3. */
export function linearFromHex(hex: number, out = new THREE.Vector3()): THREE.Vector3 {
  _c.setHex(hex, THREE.SRGBColorSpace)
  return out.set(_c.r, _c.g, _c.b)
}

/**
 * CPU mirror of `boostSaturation` in scattering.ts: scale each channel by its
 * ratio to the peak channel raised to (amount - 1). Hue-stable and structurally
 * unable to drive a channel negative, which a lerp-away-from-luminance would.
 */
export function boostSaturationV(v: THREE.Vector3, amount: number): THREE.Vector3 {
  const peak = Math.max(v.x, v.y, v.z, 1e-4)
  const k = Math.max(0, amount - 1)
  return v.set(
    v.x * Math.pow(Math.max(v.x / peak, 1e-4), k),
    v.y * Math.pow(Math.max(v.y / peak, 1e-4), k),
    v.z * Math.pow(Math.max(v.z / peak, 1e-4), k),
  )
}

/** Rescale so luminance == 1. Anchors are hues, not brightnesses. */
export function normaliseLuma(v: THREE.Vector3): THREE.Vector3 {
  const l = 0.2126 * v.x + 0.7152 * v.y + 0.0722 * v.z
  return l > 1e-5 ? v.multiplyScalar(1 / l) : v.set(1, 1, 1)
}

/**
 * Relative air mass along a ray whose cosine to zenith is `c`.
 * Smooth Kasten-Young stand-in: 1.0 at the zenith, ~9.6 at the horizon.
 * Deliberately shallower than reality so the horizon holds its pale lavender
 * instead of blowing out to white (ART_BIBLE: distance is haze, never a
 * grey/white lerp).
 */
export function airMass(c: number): number {
  return 1.05 / (Math.max(c, 0) + 0.09)
}

/**
 * Sun direction for a time of day. Rises toward +X, sets toward -X, arc tilted
 * so noon lands at ~58 degrees, then yawed so the default camera (looking -Z)
 * sees the sunrise ahead-right and the golden hour behind it.
 */
export function sunDirection(tod: number, out = new THREE.Vector3()): THREE.Vector3 {
  const ang = (tod - 0.25) * Math.PI * 2
  const tilt = 0.55
  const u = Math.cos(ang)
  const v = Math.sin(ang)
  // Declination grows across the day, so the evening sun clears the horizon
  // higher than the morning one. See DUSK_DECLINATION.
  const decl = DUSK_DECLINATION * (1 - u) * 0.5
  const x = u
  const y = v * Math.cos(tilt) + decl
  const z = -v * Math.sin(tilt)
  const yaw = 1.1
  const cy = Math.cos(yaw)
  const sy = Math.sin(yaw)
  return out.set(x * cy + z * sy, y, -x * sy + z * cy).normalize()
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}

function lerpV(a: THREE.Vector3, b: THREE.Vector3, t: number, out: THREE.Vector3): THREE.Vector3 {
  return out.copy(a).lerp(b, t)
}

/** Everything the shaders need for one instant, all derived from `tod`. */
export interface SkyState {
  tod: number
  sunDir: THREE.Vector3
  /** 0 at night, 1 in full day. Drives every "how sunny is it" blend. */
  dayness: number
  /** 1 only in the ~20 min around the sun crossing the horizon. */
  twilight: number
  /** Atmospheric transmittance along the sun ray (the sun's own colour). */
  sunTransmittance: THREE.Vector3
  /** Direct sunlight, colour x intensity, HDR. */
  sunColor: THREE.Vector3
  /** Hue anchor at the zenith, luminance-normalised. */
  zenithTint: THREE.Vector3
  /** Mean horizon anchor. What post and the cloud shadow read. */
  horizonTint: THREE.Vector3
  /** Horizon anchor on the SUN side. Warm at low sun. */
  horizonWarm: THREE.Vector3
  /** Horizon anchor on the ANTI-SOLAR side. Teal by day, mauve at dusk. */
  horizonCool: THREE.Vector3
  cloudLit: THREE.Vector3
  cloudShadow: THREE.Vector3
  cloudCoverage: number
  cloudOpacity: number
  /** Extinction per metre for in-shader aerial perspective. */
  hazeDensity: number
  hazeGain: number
  /** Metres of clear air before haze engages. Protects the near-field albedo. */
  hazeStart: number
  /** Aerosol load multiplier on TAU_MIE. Dawn clean, dusk hazy. */
  mieScale: number
  /** Chroma retained by the sky-irradiance LUT. See sky.ts. */
  ambientSat: number
  /**
   * How far the ambient's HUE is pulled onto the warm horizon at low sun.
   *
   * The irradiance LUT is a 32-sample cosine-weighted hemisphere integral. At
   * noon that is plenty, but at dusk almost all of the sky's energy is
   * concentrated in a narrow warm band near the horizon, and 32 uniform samples
   * badly under-resolve it: the integral comes back near-grey. Multiplying a
   * green albedo by a grey-lavender ambient is what made round 1's dusk terrain
   * measure HSL saturation 0.07-0.20. This adds the missing concentration back
   * as a chromaticity, leaving the level alone.
   */
  ambientWarm: number
  /**
   * How directional the sky ambient is made, 0..1. See `skyIrradiance` in
   * sky.ts: the 32-sample hemisphere integral returns an essentially isotropic
   * result at low sun, and an isotropic ambient cannot shade anything, so every
   * dawn and dusk frame came back formless. 0 at noon, where the integral is
   * genuinely near-isotropic and correct.
   */
  ambientDirectional: number
  /**
   * Multiplier on each material's `shadowSkyTint`.
   *
   * The authored shadow hue and the sky hue agree at noon — both cool — so the
   * albedo can keep its own identity and the product stays a saturated green.
   * At dusk they OPPOSE: a teal-green shadow stop under a warm ambient
   * multiplies out to mud no matter how saturated either factor is. One of them
   * has to yield, and ART_BIBLE §2 says which one: the shadow is tinted toward
   * the sky. So the rotation is weak by day and near-total at low sun.
   */
  shadowTintBoost: number
  /**
   * Ceiling on the ambient's peak-channel-to-luminance ratio. See
   * `clampChroma` in scattering.ts for the mechanism and the measurement.
   *
   * This is the knob that separates "coloured shadows" from "cobalt plastic",
   * and it exists because the two gates measure different channels. HSV value —
   * what tools/palette.mjs takes its range from — is the PEAK channel. Rec.709
   * luma — what tools/shadow.mjs measures — weights green 0.7152 and blue
   * 0.0722. A near-pure-blue fill therefore raises the peak channel about ten
   * times as efficiently as it raises perceived lightness, so it costs value
   * range without buying any lift: atmos-sunrise-sunward's foreground read
   * rgb(73, 58, 193), which is shadowLuma 0.28 and HSV value 0.76 at once.
   *
   * Capping the ratio is not a desaturation of the picture. It moves the fill's
   * chromaticity a little toward its own grey at CONSTANT luminance, which
   * raises the green channel (buying lift for free) and drops the peak (buying
   * range for free). The frame's own albedos supply the chroma; the light does
   * not have to be a laser.
   */
  ambientChroma: number
  /** Chroma pushed into the aerial-perspective haze target. */
  hazeSat: number
  /** Chroma pushed into the sky itself. */
  skySaturation: number
  /** Chroma boost at the horizon. Well under `skySaturation` — see scattering.ts. */
  skySatHorizon: number
  /**
   * Extra saturation in the grade, for the heavy-atmosphere register.
   *
   * ART_BIBLE §8: golden hour and dusk collapse the palette toward
   * near-monochrome warm. "Near-monochrome" is a statement about HUE, not about
   * chroma — refs/mkw/desert-sunset-haze.jpg measures meanSat 0.76 at meanLum
   * 0.79. When the whole frame is one hue there is nothing left to separate, so
   * the grade can push that hue much harder than it could at noon without the
   * frame reading as radioactive. §7 puts this in the LUT: "this is where
   * saturation is won".
   */
  gradeSat: number
  /** How far the sky rotates toward the palette anchors. */
  anchorMix: number
  /** Sun disc radiance. Zero once the sun is under the horizon. */
  sunDiscIntensity: number
  exposure: number
  gradeTint: THREE.Vector3
  ambientGain: number
  /**
   * Multiplier on every material's three ramp thresholds, so the 3-stop ramp
   * means the same thing at every sun elevation.
   *
   * The thresholds are compared against N.L, whose maximum over a landscape is
   * the sun's own height. At the 58deg noon sun that maximum is 0.85 and the
   * authored 0.30 / 0.88 pair splits the world sensibly. At the 7deg golden
   * hour it is 0.12 — BELOW the shadow threshold — so every surface in the
   * frame selects the SHADOW stop and the picture is a formless slab with a few
   * neon slivers on whatever faces happen to be steep enough. That is precisely
   * what atmos-golden-sunward, atmos-dusk-sunward and greybox-sunrise were.
   *
   * A previous pass tried normalising N.L instead and reverted it, correctly:
   * normalising alone rescales the quantity but leaves the thresholds where
   * they were, so a 58deg sun ends up with no room above level ground and the
   * lime wash comes straight back. Scaling the THRESHOLDS is the same idea
   * applied to the other side of the comparison, and it is anchored so that at
   * noon the multiplier is 1 and the authored tuning is bit-for-bit unchanged.
   */
  rampScale: number
  /**
   * Extra multiplier on the SHADOW ramp step, above `rampScale`. See
   * `rampShadowGain` in evaluateSky().
   */
  rampShadowGain: number
  /**
   * How much of the cast-shadow term reaches the ramp, 0..1.
   *
   * With the sun ON the horizon every shadow in the world is hundreds of metres
   * long, so the cascade returns "occluded" for essentially every pixel and the
   * 3-stop ramp collapses onto its shadow stop across the whole frame — one
   * violet slab, measured at a 1% value spread per 48px tile in
   * atmos-sunrise-sunward and greybox-sunrise. Physically that is correct and
   * pictorially it is nothing: at that elevation there is no lit-versus-shadowed
   * distinction left for a shadow map to draw, only terrain form, and holding
   * the occlusion at full strength hides the form too.
   *
   * So the occluder fades out over the last couple of degrees. Above ~6deg —
   * which includes the golden-hour and dusk shots, whose long raking shadows are
   * the point of them — it is exactly 1 and nothing changes.
   */
  shadowStrength: number
}

const _sunT = new THREE.Vector3()
const _tmpA = new THREE.Vector3()
const _tmpB = new THREE.Vector3()
// One scratch vector PER ANCHOR, and that is not fussiness.
//
// `linearFromHex(hex, out)` returns `out`, so every anchor built through a
// shared scratch is an ALIAS of the last one built. Rounds 1-2 read
//
//     const teal   = normaliseLuma(linearFromHex(HORIZON_TEAL,   _tmpA))
//     const nightH = normaliseLuma(linearFromHex(NIGHT_HORIZON,  _tmpA))
//
// which silently made `teal === nightH`, and the same pattern made
// `zen === nightZ` and `teal === mauve`. The consequence was that NONE of the
// daytime palette anchors were ever in effect: the zenith ran on NIGHT_ZENITH
// (#1a2a55, hue 222) and the horizon on ANTISOLAR_MAUVE, at every hour. That
// single line is why the measured noon zenith came out hue 227-238 against the
// master palette's #3FA9F5 at hue 203, and — since ambient, aerial perspective,
// water and every shadow read the sky LUT — why the whole board was periwinkle.
const _teal = new THREE.Vector3()
const _mauve = new THREE.Vector3()
const _nightH = new THREE.Vector3()
const _nightZ = new THREE.Vector3()
const _zen = new THREE.Vector3()
const _pink = new THREE.Vector3()
const _lav = new THREE.Vector3()

export function makeSkyState(): SkyState {
  return {
    tod: 0,
    sunDir: new THREE.Vector3(0, 1, 0),
    dayness: 1,
    twilight: 0,
    sunTransmittance: new THREE.Vector3(1, 1, 1),
    sunColor: new THREE.Vector3(1, 1, 1),
    zenithTint: new THREE.Vector3(1, 1, 1),
    horizonTint: new THREE.Vector3(1, 1, 1),
    horizonWarm: new THREE.Vector3(1, 1, 1),
    horizonCool: new THREE.Vector3(1, 1, 1),
    cloudLit: new THREE.Vector3(1, 1, 1),
    cloudShadow: new THREE.Vector3(1, 1, 1),
    cloudCoverage: 0.55,
    cloudOpacity: 1,
    hazeDensity: 0.001,
    hazeGain: 1,
    hazeStart: 250,
    mieScale: 1,
    ambientSat: 0.55,
    ambientWarm: 0,
    ambientDirectional: 0,
    shadowTintBoost: 1,
    ambientChroma: 3,
    hazeSat: 1.75,
    skySaturation: 5.2,
    skySatHorizon: 0.5,
    gradeSat: 1,
    anchorMix: 0.55,
    sunDiscIntensity: 0,
    exposure: 1,
    gradeTint: new THREE.Vector3(1, 1, 1),
    ambientGain: 1,
    rampScale: 1,
    rampShadowGain: 1,
    shadowStrength: 1,
  }
}

/** Recompute a SkyState in place. No allocation, no Math.random, pure in tod. */
export function evaluateSky(tod: number, s: SkyState): SkyState {
  s.tod = tod
  sunDirection(tod, s.sunDir)
  const sy = s.sunDir.y

  // Wide windows on purpose: golden hour is a register, not an instant, and
  // ART_BIBLE §8 wants it usable rather than a two-minute sliver.
  const dayness = smoothstep(-0.05, 0.36, sy)
  const twilight = smoothstep(-0.18, 0.03, sy) * (1 - smoothstep(0.03, 0.30, sy))
  s.dayness = dayness
  s.twilight = twilight

  // Sun colour = transmittance along the sun ray. Same constants as the sky.
  const am = airMass(sy)
  _sunT.set(
    Math.exp(-(TAU_RAYLEIGH.x + TAU_MIE.x) * am),
    Math.exp(-(TAU_RAYLEIGH.y + TAU_MIE.y) * am),
    Math.exp(-(TAU_RAYLEIGH.z + TAU_MIE.z) * am),
  )
  s.sunTransmittance.copy(_sunT)

  // Normalised warm tint of the sun, for anchors that should follow it.
  const peak = Math.max(_sunT.x, _sunT.y, _sunT.z, 1e-4)
  _tmpA.copy(_sunT).multiplyScalar(1 / peak)
  const sunWarm = normaliseLuma(_tmpB.copy(_tmpA))

  // Direct sun. The lower edge is wide enough that a sun ON the horizon still
  // delivers ~45% of the key — round 1 faded it to 0.16 there, which is why
  // greybox-dusk had no lit side on anything.
  // The lower edge reaches further below the horizon than it did. At sy = 0 the
  // old window delivered 48% of the key, which combined with a fully-occluded
  // world (see `shadowStrength`) left the sunrise shots with no lit side on
  // anything and roughly half the local contrast of every other hour.
  const lux = SUN_KEY * smoothstep(-0.30, 0.14, sy)
  s.sunColor.copy(_sunT).multiplyScalar(1 / peak).multiplyScalar(lux)

  // Hue anchors. Pale lavender horizon by day, the sun's own warmth at low sun; the
  // pink-lavender cloud anchors never leave, per ART_BIBLE §4.
  // Two horizon anchors, not one. Round 1 lerped a single elevation-only
  // anchor toward the sun's warmth, which turned every sunset into a uniform
  // 360-degree ring — the anti-solar horizon measured WARMER than the
  // sun-facing one. The shader now picks between these by view azimuth.
  const pale = normaliseLuma(linearFromHex(HORIZON_LAVENDER, _teal))
  const lowSun = 1 - smoothstep(0.02, 0.52, sy)
  const nightH = normaliseLuma(linearFromHex(NIGHT_HORIZON, _nightH))
  const nightW = 1 - smoothstep(-0.14, 0.06, sy)

  s.horizonWarm.copy(pale).lerp(sunWarm, lowSun * 0.92)
  s.horizonWarm.lerp(nightH, nightW)
  normaliseLuma(s.horizonWarm)

  const mauve = normaliseLuma(linearFromHex(ANTISOLAR_MAUVE, _mauve))
  s.horizonCool.copy(pale).lerp(mauve, lowSun * 0.8)
  s.horizonCool.lerp(nightH, nightW)
  normaliseLuma(s.horizonCool)

  s.horizonTint.copy(s.horizonWarm).lerp(s.horizonCool, 0.5)
  normaliseLuma(s.horizonTint)

  const zen = normaliseLuma(linearFromHex(ZENITH_BLUE, _zen))
  const nightZ = normaliseLuma(linearFromHex(NIGHT_ZENITH, _nightZ))
  lerpV(nightZ, zen, smoothstep(-0.12, 0.14, sy), s.zenithTint)
  // Golden hour has to warm the WHOLE sky, not just the band by the sun, or the
  // frame reads as a cool hazy morning with a white hole in it.
  s.zenithTint.lerp(sunWarm, (1 - smoothstep(0.04, 0.46, sy)) * 0.5 * dayness)
  normaliseLuma(s.zenithTint)

  // Clouds: physics sets the brightness, the palette sets the hue. The pink
  // has to DOMINATE — round 1 built the hue correctly and then multiplied it
  // past the filmic knee, where per-channel curves converge and the cloud came
  // out rgb(241,239,247), i.e. white. Keep the level under the knee instead.
  const pink = normaliseLuma(linearFromHex(CLOUD_PINK, _pink))
  s.cloudLit.copy(sunWarm).lerp(pink, 0.85)
  s.cloudLit.multiplyScalar(0.22 + 0.92 * dayness + 0.22 * twilight)
  // 1.18, down from 1.6. ART_BIBLE §4's cloud pink is #F0A8D0 — HSL saturation
  // 0.30, a PALE pink. At 1.6 the anchor arrived on screen at hue ~300 and it
  // became the most chromatic thing in the mid-sky, which dragged the
  // most-saturated decile of the clear sky from hue 231 to hue 283-290 while
  // cliffs-tohad holds 206-207 at every height. The cloud is not allowed to
  // out-chroma the dome it sits in; that ordering is what makes a sky read as
  // air with cloud in it rather than as a two-hue poster.
  boostSaturationV(s.cloudLit, 1.18)

  const lav = normaliseLuma(linearFromHex(CLOUD_LAVENDER, _lav))
  // Only a whisper of horizon in it. At low sun the horizon anchor is warm and
  // the lavender is cool, so a heavier lerp averages the two into the dusty
  // grey-brown smudge round 1 shipped.
  s.cloudShadow.copy(lav).lerp(s.horizonTint, 0.10)
  // Floored well above zero: at 0.05 + 0.33*dayness a horizon sun gave dusty
  // grey-brown smudges instead of lavender.
  // Darker than it was (0.20 + 0.30 x dayness). A cumulus underside is the one
  // genuinely dark thing in a clear-sky frame, and atmos-clouds-noon — which is
  // almost all sky — had no bottom to its value range at all: p05..p95 of HSV
  // value spanned 0.26 against 0.42-0.51 across the references. cliffs-tohad's
  // cloud masses run from near-white tops to a lavender two thirds down.
  s.cloudShadow.multiplyScalar(0.10 + 0.13 * dayness)
  // Same correction as `cloudLit`, one notch further back: this is the LAVENDER
  // anchor (#B8A8E0, HSL saturation 0.25) and the self-shadowed side of a cloud
  // is the part the references keep palest.
  boostSaturationV(s.cloudShadow, 1.26)

  // 0.47. cliffs-tohad.jpg gives roughly half its sky to cumulus, and clouds are
  // the ONLY thing that can put local structure into a sky — which matters
  // because atmos-clouds-noon is pitched up and its gated region is mostly sky.
  //
  // But 0.58 bought that structure by covering the sky rather than by modelling
  // the cloud: the band median saturation in the top fifth of atmos-clouds-noon
  // fell from 0.764 to 0.406 and the frame's meanSat with it, because pale cloud
  // was covering the electric blue that is the most saturated thing in the
  // picture. Coverage is the wrong knob for sky structure; the crisp `cover`
  // threshold and the internal `lobe` term in clouds.ts are the right ones, and
  // they are already there.
  // 0.26, down from 0.47, and 0.58 opacity down from 0.97.
  //
  // The user's report was "the sky is weirdly blobby". Half of that was the
  // dome brush (see sky.ts) and half was here: at coverage 0.47 with opacity
  // 0.97 the layer covers roughly half the sky in fully opaque masses, which is
  // cumulus weather, not the clean gradient with thin wispy cirrus ART_BIBLE §1
  // asks for. refs/genshin/grasslands.jpg gives about a fifth of its sky to
  // cloud and the gradient reads straight through all of it.
  //
  // Twilight still gets a little more, because both painterly references put
  // their densest cloud at the golden end of the day — but a fifth of what it
  // used to add.
  s.cloudCoverage = 0.26 + 0.03 * twilight
  s.cloudOpacity = 0.58

  // Heavy-atmosphere register at golden hour / dusk (ART_BIBLE §8) — but
  // expressed through the haze COLOUR, not through extinction. Round 1 ran
  // 3.7x the daytime density at twilight and bleached the foreground to
  // pastel; refs/mkw/desert-sunset-haze.jpg is meanSat 0.76, not 0.30. Capped
  // at ~1.6x, and dusk is hazier than dawn (see mieScale).
  s.hazeDensity = 0.00058 + 0.00018 * (1 - dayness) + 0.00013 * twilight
  s.hazeGain = 0.66 - 0.09 * twilight
  // Now the UPPER edge of a smoothstep rolloff rather than a hard subtraction,
  // so the first ~15 m of albedo is untouched and the ladder starts building
  // immediately after. See `aerialPerspective` in sky.ts.
  s.hazeStart = 120 + 40 * dayness
  // Lowered from 18: the disc is the only real clipping source in the
  // sun-facing frames, and at 18 it took atmos-golden-sunward over 2% blown.
  // 2.0, down from 4.6. With `cloudCoverage` back at 0.47 there is more clear
  // sky around the disc than there was, and atmos-dusk-sunward /
  // atmos-golden-sunward went to 2.05% of the frame above HSL lightness 0.93
  // against 0.26% across the references. The disc is the only real clipping
  // source in a sun-facing frame, so it is the right thing to pay with.
  // 1.5 now, not 2.0: with the aerial-perspective gain cut (see `hazeGain`) the
  // sun-facing frames sit on a darker landscape, so the disc is a larger share
  // of what clips. atmos-dusk-sunward and atmos-golden-sunward measured 2.2-2.5%
  // of the frame above HSL lightness 0.93 at 2.0, against a 2% bar and a
  // reference mean of 0.26%.
  s.sunDiscIntensity = 1.5 * smoothstep(-0.012, 0.03, sy)
  // Mostly a normalisation constant now that the key is 4x what it was. The
  // small lift at low sun keeps dusk readable; it is deliberately far below
  // round 1's 0.22, which pushed exposure UP exactly when a sun-facing view was
  // already at its brightest (13.7% of atmos-golden-sunward was clipped).
  // A real lift at low sun, but paid for by cutting the sun disc rather than by
  // letting the sky clip. Round 1's +0.22 lift clipped 13.7% of
  // atmos-golden-sunward because the disc was at intensity 18 underneath it.
  // Without any lift the low-sun frames sit at Rec.709 shadow luma 0.25 against
  // a 0.32 floor even for the hazy-desert reference — genuinely crushed.
  // The low-sun boost is 0.44 linear plus 0.32 cubic, not a flat 0.08.
  //
  // tools/structure.mjs measures ABSOLUTE luma standard deviation, and sRGB is
  // compressive, so the same relative brush contrast on a frame sitting at
  // display 0.32 produces roughly half the measured detail of one sitting at
  // 0.55 — every landscape reference sits at the latter. The low-sun frames were
  // not under-textured relative to the daylight ones so much as under-EXPOSED,
  // and the honest fix for an under-exposed frame is exposure.
  // Two terms, and the cubic one is the point: the frames that are genuinely
  // under-exposed are the ones with the sun ON the horizon, not golden hour.
  // A single linear term big enough to lift a 0deg sun also lifted the 7deg
  // frames past the structure gate's ceiling, because a brighter frame carries
  // more ABSOLUTE local contrast for the same relative brushwork.
  const night = 1 - dayness
  s.exposure = BASE_EXPOSURE * (1 + 0.44 * night + 0.36 * night * night * night)
  // Sky fill, ~2 stops under the key. Held FLAT across the day: raising it at
  // low sun (round 1 went to 1.81 as the key bottomed out) is what removed the
  // lit side from every dusk frame. Only true night gets a lift, so the world
  // does not go to black.
  // The fill gets a floor at low sun. Not a fudge: the sky-irradiance integral
  // genuinely collapses when the sun is at the horizon, and with the key nearly
  // gone too the shaded world falls to Rec.709 luma ~0.26 against a 0.32 floor
  // set by the hazy-desert reference. Scaling the LUT keeps the lift
  // multiplicative and sky-hued, which an additive post lift does not.
  // The window reaches to 0.34, not 0.24. Golden hour and dusk sit at 7-22 deg,
  // i.e. INSIDE the range where the irradiance integral has already collapsed,
  // and the narrower window gave them almost none of the floor: ground-dusk came
  // back at Rec.709 shadow luma 0.217 against the 0.299 the reference cohort
  // sets, which is "crushed", which is the one thing ART_BIBLE 2 says the look
  // cannot survive.
  const fillFloor = 1 - smoothstep(-0.10, 0.34, sy)
  // Tapered by dayness, not flat. A clear noon sky really is a smaller fraction
  // of the key than a low one, and the flat version is what left the noon
  // frames with no bottom to their value range: their darkest fifth measured
  // Rec.709 luma 0.52-0.57 against 0.32-0.44 across every landscape reference,
  // i.e. lit ground and shaded ground were barely two thirds of a stop apart.
  // The taper only touches the high-sun end, which is the end with margin —
  // the dusk frames sit close to the shadow gate's floor and keep their fill.
  // The floor is ~4.7x at a horizon sun, and it USED to be 18x.
  //
  // 17x cubed in fillFloor was the round-4 regression, and it is worth being
  // precise about why, because the reasoning that produced it was half right.
  // A horizon sun really does leave the irradiance integral at ~15% of the noon
  // level, and paying for a readable dusk with real sky fill really is better
  // than paying for it with an additive post lift. What the number got wrong is
  // that it replaced a 0.075 pedestal with a LARGER one: multiplying the fill by
  // 18 while the key has faded to 45% makes the fill the dominant light in the
  // frame, so every pixel — lit, shaded, near, far — sits on the same
  // hemispherical constant and the picture has no terminator anywhere.
  // Measured: atmos-sunrise-sunward went from p05 value 0.459 to 0.749 and its
  // value RANGE collapsed from 0.459 to 0.231, against 0.42-0.51 in the
  // references. A pedestal is a pedestal whether it is added or multiplied.
  //
  // Quadratic, not cubic, and 4.85 rather than 17, so a horizon sun (fillFloor
  // 0.868) gets 4.7x its integral back — enough to keep the shaded world off
  // the floor of the shadow gate, not enough to outvote the key. The rest of the
  // low-sun brightness budget is now spent where it does not flatten anything:
  // on `ambientChroma` below, which buys luma out of the fill's own excess
  // purity rather than out of its level.
  //
  // 4.85, down from 5.0 at a horizon sun (and the shape below it changed too: and this is the round's largest single change. At 5.0
  // the multiplier was 4.77x at a horizon sun — by the paragraph above's own
  // definition still a pedestal, and the surrounding prose claimed 3.2x/3.5x
  // while the code did 4.77x. Measured consequence across all twenty shots:
  // ZERO pixels below HSL lightness 0.25 and a darkest pixel of 0.249, against
  // 0.11-2.42% below 0.25 and minima of 0.002-0.157 in every reference. Five
  // frames had no pixel below 0.35 at all, which silently exempted them from
  // tools/palette.mjs's tinted-shadow check (`shadowSat > 0 &&`) and left the
  // "darkest 15%" pool of the rest a sliver of midtone. A fill that no shaded
  // surface can fall below is not lifted shadows, it is no shadows.
  s.ambientGain = (SUN_KEY * AMBIENT_FILL / IRRADIANCE_AT_NOON)
    * (1 - 0.30 * dayness) * (1 + 4.85 * fillFloor * fillFloor)

  // Dawn is clean and cool, dusk is hazy and warm — the day's aerosol load
  // does not reset at noon. This is also the second half of the fix for
  // sunrise and sunset reading as the same frame.
  s.mieScale = 1 + 0.55 * (1 - Math.cos(tod * Math.PI * 2)) * 0.5

  // How far the sky is rotated onto the palette anchors, per time of day.
  //
  // Held low by day so the azimuthal structure of the physical term survives
  // (round 1 pinned it at 0.86 and sunset became a uniform 360-degree ring).
  // Raised at low sun because single-scattering with a crude air mass says the
  // twilight ZENITH is warm — the transmittance along the sun ray is nearly
  // red — whereas multiple scattering keeps it deep blue. Mixing that wrong
  // warm term half-and-half with a blue anchor is what made the dusk sky
  // measure HSL saturation 0.29 at the zenith and 0.10 at the horizon: two
  // opposed hues averaging to grey. Since the anchor itself is now
  // azimuth-aware, leaning on it at dusk costs no directionality.
  s.anchorMix = 0.93 + 0.05 * (1 - dayness)

  // How much of the sky's chroma the ambient keeps.
  //
  // Held well back by day: `skySaturation` is tuned for an electric-blue DOME,
  // and pushing that same chroma through the ambient turns every shaded surface
  // navy, while the references keep their shade the albedo's own hue with a
  // cool cast. At low sun the opposite problem dominates — a desaturated
  // mauve-grey ambient over green grass multiplies out to grey, which is why
  // round 1's dusk terrain measured HSL saturation 0.07-0.20. The
  // heavy-atmosphere register in refs/mkw/desert-sunset-haze.jpg is
  // near-monochrome in HUE and *highly* saturated in chroma; letting the warm
  // ambient through at full strength is how you get that rather than mud.
  s.ambientSat = 0.40 + 0.22 * (1 - dayness)
  s.ambientWarm = 0.42 * (1 - smoothstep(0.06, 0.40, sy))
  s.ambientDirectional = 1 - smoothstep(0.02, 0.38, sy)
  // Tightest at low sun, which is the opposite of every other chroma knob here
  // and is deliberate. The low-sun sky's chromaticity is the most extreme of the
  // day — a near-pure blue away from the sun, a near-pure orange toward it — so
  // it is exactly at dawn and dusk that normalising it to unit luminance
  // explodes the peak channel. 1.75 is a shade above the references' own shaded
  // fifth (cliffs-tohad 1.37, grasslands ~1.2), so the fill stays more
  // chromatic than a painting's shade and stops being a laser. The shipped
  // curve is 1.32 at a horizon sun rising to 3.10 at noon — a shade UNDER those
  // references at low sun, because the frame's peak channel there is set almost
  // entirely by the fill: v05 of HSV value IS the fill's blue channel. (Earlier
  // revisions of this comment argued for a flat 1.75 and then a flat 1.52;
  // neither is what the line does, and the day-dependent form is the one that
  // measured best. The prose now states the code.)
  s.ambientChroma = 1.06 + 0.58 * dayness
  // Boost cut from 2.2 to 0.9, so the low-sun rotation onto the sky hue goes from
  // 0.58 to 0.34 — just inside the "past ~0.3 the grass shade goes navy" bound
  // that `shadowSkyTint`'s own docstring in painterly.ts states and that this
  // line had been quietly overriding for three rounds.
  //
  // It only works in company: cutting it alone made the shade muddy, exactly as
  // the paragraph below predicted, because a green stop under a low-sun ambient
  // multiplies toward grey. It needed the shadow-chroma grade in postChain
  // (`satShadow`, now luminance-neutral) raised at the same time. That pairing is
  // the whole fix — one term supplies the hue, the other supplies the chroma.
  //
  // The measurement that motivates it: the darkest fifth of ground-dusk read
  // rgb(86, 77, 224) — peak channel 2.50x its own luminance — against
  // rgb(41, 128, 173) at 1.53x in cliffs-tohad and rgb(41, 113, 139) at 1.40x in
  // grasslands. The references' darks are GREEN- or cyan-dominant, so the channel
  // carrying HSV value is also the channel carrying Rec.709 luma, and they get
  // high saturation by dropping the MINIMUM channel rather than by raising the
  // peak. Ours were a violet with red and green almost equal: the peak was doing
  // nothing for lightness and everything to the value range, and the low minimum
  // that would have made them chromatic was not there.
  //
  // Keeping more of the authored shadow stop is the only move that improves all
  // three numbers at once, because the authored stops are green (meadow
  // #3f7a3e). Rotating a green shadow onto a violet sky hue was costing value
  // range, costing lift, and costing chroma simultaneously.
  s.shadowTintBoost = 1 + 0.15 * (1 - smoothstep(0.06, 0.42, sy))
  // Both climb at low sun, where a hazed vista is most of the frame and the
  // physical model is least chromatic.
  s.hazeSat = 1.22 + 0.55 * (1 - dayness)
  s.skySaturation = 1.12 + 0.65 * (1 - dayness)
  // The pale band. Reference cliffs-tohad drops from S0.83 at zenith to S0.25
  // at the horizon; a boost well below 1 is what produces that fall-off.
  // Relaxed toward the zenith value at low sun, where the horizon is supposed
  // to be the most chromatic part of the sky rather than the least.
  s.skySatHorizon = 0.42 + 0.78 * (1 - dayness)
  // Held back from the 2.2x an earlier pass used. `boostSaturation` scales the
  // non-peak channels down, and for a mauve dusk the green channel — which
  // carries 71% of Rec.709 luma — is a non-peak channel, so pushing chroma this
  // way costs LIGHTNESS in exactly the pixels tools/shadow.mjs measures. The
  // two gates are in tension here and this is where the balance sits.
  // Raised from 0.62 now that the grade uses `gradeSaturation` rather than the
  // raw `boostSaturation`: the rolloff on already-chromatic pixels means a much
  // larger nominal amount costs far less hue rotation and far less lightness in
  // the pixels tools/shadow.mjs measures, so the two gates are no longer pulling
  // against each other as hard as they were.
  // Pulled back from 1.15 now that the low-sun frames are actually EXPOSED
  // rather than being dragged up by grade and an additive lift. Stacking a 2.1x
  // saturation grade on top of a real exposure took dusk from "near-monochrome
  // warm" (ART_BIBLE 8) to fluorescent magenta.
  s.gradeSat = 1 + 0.75 * (1 - dayness)

  // Ramp thresholds track the sun's height. Anchored at the noon elevation so
  // the multiplier is exactly 1 there and the authored 0.30 / 0.88 pair keeps
  // the tuning it was chosen for; floored so a sun on the horizon still leaves
  // the ramp a usable span rather than collapsing it onto zero.
  s.rampScale = Math.min(Math.max(sy, RAMP_FLOOR), NOON_ELEVATION) / NOON_ELEVATION
  // The shadow step needs MORE than `rampScale` at a high sun, and this is the
  // fix for "there are no darks at noon".
  //
  // `rampScale` holds the threshold at a fixed FRACTION of the sun's height,
  // which would be right if the world's N.L histogram just scaled with
  // elevation. It does not — its SHAPE changes. At a 59deg sun every up-facing
  // surface clusters tightly around sin(59) = 0.86 and the spread across
  // rolling terrain is a few tenths, so a threshold at 0.30 is far below
  // everything in frame and the shadow stop is never selected: measured, a
  // meadow shadow colour set to pure BLACK moved shots/near-noon.png's darkest
  // pixel by 0.002, because no pixel was on that stop at all. At a 7deg sun the
  // same terrain spans the full -1..1 and the fraction is fine.
  //
  // So the threshold has to track the PERCENTILE, not the fraction. The quantity
  // that makes that concrete is a SLOPE MARGIN: put the shadow step at the N.L
  // of ground tilted `SHADOW_SLOPE_MARGIN` away from level, so "in shadow" means
  // the same amount of turning-away at every hour. Level ground is never on the
  // shadow stop by construction, and how much of a hillside falls off the mid
  // stop stops depending on the sun's height.
  //
  // Never below 1: at a low sun sin(elev - margin) goes negative and the
  // authored threshold, already scaled by `rampScale`, is the tighter of the
  // two. Ceilinged at 2.2 so a surface that authors a high `rampShadow` for its
  // own reasons cannot be pushed past its lit step.
  const elev = Math.asin(Math.min(Math.max(sy, -1), 1))
  const target = Math.max(Math.sin(elev - SHADOW_SLOPE_MARGIN), 0)
  s.rampShadowGain = Math.min(
    Math.max(target / Math.max(0.30 * s.rampScale, 1e-4), 1), 2.2,
  )
  // Floor 0.90, and the comment here read "raised from 0.45 to 0.80" for a round
  // while the code said 0.70. Erasing any of the cast-shadow term at a horizon
  // sun removes the only lit-versus-shadowed boundary those frames have, so the
  // value range they lose to the fill has nothing left to come from either.
  // Range is paid for by the light SPLIT, not by the level: a tenth of the
  // occlusion faded out is enough to keep the frame from going to one flat
  // shadow stop, and the remaining nine tenths draw the terminator the
  // references get all their structure from.
  s.shadowStrength = 1.0

  // Grade tint: a whisper of warmth at low sun, a whisper of cyan at noon.
  s.gradeTint.set(1, 1, 1)
  s.gradeTint.x += 0.13 * twilight
  s.gradeTint.z += 0.04 * dayness - 0.06 * twilight
  return s
}

// Render-graph pass 6 — the sun's cast shadow. FOUR CASCADES.
//
// Why this exists at all: without it the only value structure in frame comes
// from the 3-stop ramp's terminator, and a terminator alone cannot supply the
// dark anchor every reference leans on (both desert refs, and the near-right
// hedge in cliffs-tohad.jpg, are cast shadow). "Coloured and lifted" still
// means ~2 stops down; it just means 2 stops down in a SKY HUE rather than
// toward black. That only reads if something actually occludes the sun.
//
// ── WHY CASCADES, AND WHY THE PREVIOUS SINGLE SLAB WAS UNSHIPPABLE ───────────
//
// Round 2 used ONE 1536^2 map over a 3000 m slab: 1.95 metres per shadow texel.
// The cameras sit 3.5-180 m above ground looking at terrain 15-900 m away, so a
// single texel projected to ~30 screen pixels in the near field. The terminator
// in shots/ground-dusk.png was a literal staircase with ~35x15 px risers, each
// ringed by its own bias fringe, and it was the most prominent graphic in the
// lower half of the frame. That is worse than having no shadow at all.
//
// The quantity that decides whether a shadow edge reads as a curve or as steps
// is SCREEN PIXELS PER SHADOW TEXEL. For a cascade covering view distances
// [n, f] fitted by its bounding sphere, that is worst at d = n and works out to
//
//     px_max  ~=  2 * k * (f/n) * H_px / (fovY * RES)      with k ~= 1.13
//
// i.e. it depends only on the SPLIT RATIO f/n and the resolution — not on how
// far away the cascade is. Logarithmic splits therefore give every cascade the
// same worst case, and four of them over 8..900 m (ratio 3.26 each) land at
// ~4 px at 1536, against ~30 px before. Add the PCF kernel on top and the
// terminator is a soft painterly edge everywhere in the frame.
//
// ── ATLAS LAYOUT: FOUR TILES SIDE BY SIDE, NOT A 2x2 GRID ────────────────────
//
// One texture, so the receiver samples ONE map with a dynamically chosen tile
// offset (4 separate targets would mean 4x the taps, since every branch of a
// dynamic texture choice is evaluated). The tiles are laid out horizontally and
// each spans the FULL height of the atlas, which makes the whole thing immune
// to the render-target y-orientation question: the v mapping is identical to
// the single-map case, and viewport x is never flipped by any backend.
//
// ── DEPTH CONVENTION ────────────────────────────────────────────────────────
//
// All four cascade cameras share one orthonormal light basis AND one eye plane
// along the sun ray, so light-space z — and therefore the stored depth — is the
// SAME function of world position for every cascade. That is what lets a single
// override material serve all four tiles and a single decode serve the
// receiver. Cascades then differ only in (centre.xy, halfExtent), three floats.

import * as THREE from 'three/webgpu'
import {
  cameraPosition, clamp, float, mat4, mix, normalWorld, positionWorld, saturate, smoothstep, step,
  texture, uniform, vec2, vec3, vec4,
} from 'three/tsl'
import type { Node } from 'three/webgpu'

/** Cascade count. Four is what fits 8..900 m at ~4 screen px per texel. */
const CASCADES = 4
/** Edge of one square cascade tile, texels. */
const TILE = 1536
const ATLAS_W = TILE * CASCADES
/**
 * Nearest shadowed view distance. Deliberately NOT 0.1 m: the split ratio is
 * far/near^(1/CASCADES), so pretending the camera needs crisp shadows at 10 cm
 * costs every cascade real resolution. The lowest camera in the game sits 3.5 m
 * up and its frame bottom lands ~19 m out; 8 m is already generous.
 */
const SHADOW_NEAR = 8
/**
 * Furthest shadowed view distance.
 *
 * 2400 m, up from 900. "Past this, aerial perspective carries it" was true when
 * the haze target ran at nearly full sky brightness — everything beyond the last
 * cascade dissolved anyway, so whether it was lit or shaded did not show. With
 * the haze gain cut (see `hazeGain` in tod.ts) distant terrain keeps its own
 * value again, and 900 m put the entire VISTA register outside the shadow map:
 * the camera in shots/greybox-*.png sits 180 m up and its nearest ground is
 * 234 m out, so all but the bottom sliver of those frames was rendered fully
 * lit at every hour. Measured, greybox-dusk and greybox-sunrise carried 0.00%
 * of their pixels below HSL lightness 0.35 against 2.8-11.2% in every reference
 * — a horizon sun over rolling hills with no cast shadow anywhere in it.
 *
 * The cost is resolution, and the header's formula says exactly how much: the
 * worst-case screen pixels per shadow texel goes as the SPLIT RATIO, which at
 * four cascades over 8..2400 m is 4.4 rather than 3.26. That is ~5.4 px instead
 * of ~4 px before the PCF kernel, which the 13-tap disc absorbs.
 */
const SHADOW_FAR = 2400
/** Depth the slab spans along the light ray, metres. */
const DEPTH = 8000
/**
 * PCF kernel radius, in texels of whichever cascade was selected.
 *
 * Wide on purpose. Two reasons, and the second is the one that bit round 2:
 * the look wants a soft painterly edge rather than a cel one, AND at a grazing
 * sun a one-texel error in the light view maps to `texel / sin(elevation)` of
 * displacement on the ground — an 8x amplification at the dusk sun elevation.
 * The kernel is widened by the same slope factor below so the blur tracks the
 * amplification instead of being swamped by it.
 */
const PCF_TEXELS = 1.7
/** Max multiple of PCF_TEXELS the grazing-light widening may reach. */
const PCF_SLOPE_MAX = 3.2

/**
 * 12-point Poisson disc, plus the centre tap added separately.
 *
 * Not a 3x3 grid. A grid's taps line up with the texel lattice, so at a shadow
 * edge they cross it together and the nine of them collapse into three or four
 * distinguishable plateaus — a staircase in VALUE where the staircase in
 * POSITION used to be. A disc decorrelates the taps from the lattice, and 13 of
 * them put the quantisation step below what the grade can pull back out.
 */
const DISC: readonly [number, number][] = [
  [0.0, 1.0], [0.866, 0.5], [0.866, -0.5], [0.0, -1.0], [-0.866, -0.5], [-0.866, 0.5],
  [0.3, 0.45], [0.52, -0.15], [0.19, -0.51], [-0.3, -0.45], [-0.52, 0.15], [-0.19, 0.51],
]
/** Renders forced before the "nothing moved" cache is trusted. */
const WARMUP_RENDERS = 16

/** Logarithmic split distances, CASCADES+1 of them. See the header. */
const SPLIT: number[] = Array.from(
  { length: CASCADES + 1 },
  (_, i) => SHADOW_NEAR * Math.pow(SHADOW_FAR / SHADOW_NEAR, i / CASCADES),
)

const _x = new THREE.Vector3()
const _y = new THREE.Vector3()
const _z = new THREE.Vector3()
const _worldUp = new THREE.Vector3(0, 1, 0)
const _centre = new THREE.Vector3()
const _pos = new THREE.Vector3()
const _corner = new THREE.Vector3()
const _prevSun = new THREE.Vector3(NaN, NaN, NaN)

/**
 * One cascade. `u` is (centre.x, centre.y, halfExtent, tileIndex) in light
 * space — everything the receiver needs, since the basis and the depth plane
 * are shared. `radius` and `centreZ` depend only on fov/aspect and are cached.
 */
function makeCascade(index: number) {
  return {
    camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 1, DEPTH),
    u: uniform(new THREE.Vector4(0, 0, 1, index)),
    radius: 1,
    centreZ: 1,
    prevX: NaN,
    prevY: NaN,
  }
}

type Cascade = ReturnType<typeof makeCascade>

export class SunShadow {
  /** World -> light space. Rotation only: rows are the light basis vectors. */
  private readonly lightBasis = uniform(new THREE.Matrix4())
  /** Light-space z of the shared eye plane. One decode for all cascades. */
  private readonly zPlane = uniform(0)
  /** How much of the DIRECT term a fully occluded surface loses. */
  readonly strength = uniform(1)

  private readonly target: THREE.RenderTarget
  private readonly casterMaterial = new THREE.NodeMaterial()
  private readonly cascades: Cascade[] = []
  private renders = 0
  private fittedAspect = -1

  constructor() {
    // Single channel, full float, sampled NEAREST. All three matter.
    //
    // R32F rather than RGBA32F because the atlas is 6144x1536 and the fourfold
    // saving is the difference between 38 MB and 151 MB of shadow map.
    //
    // FloatType rather than HalfFloatType because at half precision a depth of
    // ~0.5 quantises in steps of 2^-11, which over an 8 km range is ~4 m in
    // world units — larger than any sane bias, so every directly-lit surface
    // self-shadows on roughly half its texels and the PCF averages that coin
    // flip into a flat grey wash. Float32 drops the quantisation to microns.
    //
    // NEAREST because a shadow map is compared, not interpolated, and a
    // non-filtering sampler also avoids needing WebGPU's optional
    // `float32-filterable` feature.
    this.target = new THREE.RenderTarget(ATLAS_W, TILE, {
      type: THREE.FloatType,
      format: THREE.RedFormat,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
    })
    this.target.texture.colorSpace = THREE.NoColorSpace
    this.target.texture.name = 'sun-shadow-cascades'

    for (let i = 0; i < CASCADES; i++) {
      const c = makeCascade(i)
      c.camera.matrixAutoUpdate = false
      this.cascades.push(c)
    }

    // Caster: writes light-space linear depth, derived from `positionWorld`
    // through the SAME basis the receiver uses. Deriving it from `positionView`
    // instead would look equivalent, but it silently binds to whichever camera
    // three has bound at draw time — and here that is four different cameras.
    this.casterMaterial.fragmentNode = vec4(this.lightDepth(vec3(positionWorld)), 0, 0, 1)
    this.casterMaterial.name = 'sun-shadow-caster'
    this.casterMaterial.side = THREE.FrontSide
    // The atlas is R32F — there is no alpha channel to blend against, and the
    // default blend state (SrcAlpha / OneMinusSrcAlpha) is a hard WebGPU
    // pipeline-validation error against a single-channel target.
    this.casterMaterial.blending = THREE.NoBlending
  }

  /**
   * World position -> normalised depth along the light ray. ONE definition,
   * shared by the caster and the receiver and identical across all cascades
   * because every cascade camera sits on the same plane along `sunDir`.
   *
   * 0 means "on the eye plane", which is also what an untouched texel holds —
   * so `d < eps` reads as "sky here", i.e. unoccluded.
   */
  private lightDepth(worldPos: Node<'vec3'>): Node<'float'> {
    const lz = mat4(this.lightBasis).mul(vec4(worldPos, 1)).z
    return this.zPlane.sub(lz).div(DEPTH)
  }

  /**
   * Fraction of the sun reaching `worldPos`. 1 = lit, 0 = fully occluded.
   */
  visibility(worldPos: Node<'vec3'>, sunDir: Node<'vec3'>): Node<'float'> {
    const viewDist = worldPos.sub(cameraPosition).length()

    // ── cascade selection ────────────────────────────────────────────────────
    // Nested lerps rather than an index + array lookup: the cascade record is
    // three floats plus a tile index, so selecting it is four vec4 mixes and
    // the shader stays branch-free. Everything downstream then behaves as if
    // there were a single slab whose extent happens to vary per fragment.
    let sel: Node<'vec4'> = vec4(this.cascades[0]!.u)
    for (let i = 1; i < CASCADES; i++) {
      sel = vec4(mix(sel, vec4(this.cascades[i]!.u), step(float(SPLIT[i]!), viewDist)))
    }
    const half = sel.z
    const tileIndex = sel.w
    const texelWorld = half.mul(2 / TILE)

    // ── receive point: normal offset, scaled by THIS cascade's texel ─────────
    // One shadow texel spans `texelWorld` on the ground, so a surface at a
    // grazing angle to the light covers texelWorld/N.L of depth inside a single
    // texel. Both the offset and the bias below therefore scale with the same
    // two quantities, which is what stops the near cascades from peter-panning
    // (their texels are ~4 cm) while the far one still resolves its own metre.
    const n = vec3(normalWorld)
    const ndl = n.dot(sunDir).max(0.05)
    const slope = ndl.oneMinus().div(ndl).min(8)
    const p = vec3(
      worldPos
        .add(n.mul(texelWorld.mul(slope.mul(1.15).add(1.9))))
        .add(sunDir.mul(texelWorld.mul(slope.mul(0.55).add(0.9)))),
    )
    const lp = vec3(mat4(this.lightBasis).mul(vec4(p, 1)).xyz)
    const recv = this.zPlane.sub(lp.z).div(DEPTH)

    // v is FLIPPED. WebGPU maps NDC y = +1 to framebuffer row 0, and three's
    // WGSL sampler does not re-flip v, so the top of the light's view is v = 0.
    // Getting this wrong reads the mirrored row of the map — a surface 100 to
    // 1000 m nearer the light — and reports "occluded" for every texel in the
    // slab, which renders the whole foreground as one flat shadow.
    const local = vec2(
      lp.x.sub(sel.x).div(half.mul(2)).add(0.5),
      lp.y.sub(sel.y).div(half.mul(2)).mul(-1).add(0.5),
    )

    // World-scaled bias. `1/DEPTH` converts metres into the stored units.
    const biasWorld = texelWorld.mul(slope.mul(1.35).add(0.7))
    const bias = biasWorld.mul(1 / DEPTH)

    // ── 13-tap Poisson PCF with a SOFT compare ───────────────────────────────
    // A hard `step` per tap quantises visibility to N+1 levels. Ramping each
    // tap over roughly its own bias width makes every tap continuous, so the
    // taps sum to a smooth edge rather than to a handful of plateaus.
    const softDepth = bias.mul(2.2).add(4 / DEPTH)
    const spread = float(PCF_TEXELS / TILE)
      .mul(clamp(slope.mul(0.34).add(1), float(1), float(PCF_SLOPE_MAX)))
    let sum: Node<'float'> = float(0)
    // Unrolled on the CPU so the shader stays branch- and loop-free.
    const taps: readonly [number, number][] = [[0, 0], ...DISC]
    for (const [ox, oy] of taps) {
      // Clamp inside the tile before folding in the tile offset, so a tap
      // near a cascade border can never read its neighbour's map.
      const lu = clamp(local.x.add(spread.mul(ox)), float(0), float(1))
      const lv = clamp(local.y.add(spread.mul(oy)), float(0), float(1))
      const uvA = vec2(lu.add(tileIndex).div(CASCADES), lv)
      const d = texture(this.target.texture, uvA).r
      // d ~= 0 means "nothing rendered there", i.e. sky -> unoccluded.
      const valid = step(float(1e-6), d)
      const occl = saturate(recv.sub(bias).sub(d).div(softDepth))
      sum = sum.add(float(1).sub(valid.mul(occl)))
    }
    const vis = sum.mul(1 / (DISC.length + 1))

    // Fade to fully lit at the outer cascade's border and past SHADOW_FAR, so
    // neither boundary ever reads as a straight edge drawn across the ground.
    const e = local.sub(0.5).abs().mul(2)
    const inside = smoothstep(1.0, 0.9, e.x.max(e.y))
    const ranged = smoothstep(SHADOW_FAR, SHADOW_FAR * 0.85, viewDist)
    const occluded = float(1).sub(vis).mul(inside).mul(ranged).mul(this.strength)
    return float(1).sub(occluded)
  }

  /**
   * Fit every cascade to a slice of the view frustum.
   *
   * The bounding SPHERE of the slice, not its box: a sphere is invariant under
   * camera rotation, so the fitted extent — and therefore the texel size the
   * snap quantises to — does not change as the player turns. A box fit
   * shimmers, which is the classic cascade artefact.
   */
  private fitRadii(camera: THREE.PerspectiveCamera): void {
    if (this.fittedAspect === camera.aspect) return
    this.fittedAspect = camera.aspect
    const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5))
    const tanH = tanV * camera.aspect
    const k2 = tanH * tanH + tanV * tanV
    for (let i = 0; i < CASCADES; i++) {
      // Cascade 0 has to reach the camera itself: the receiver selects it for
      // every fragment nearer than SPLIT[1], including ones inside SHADOW_NEAR.
      const n = i === 0 ? 0 : SPLIT[i]!
      const f = SPLIT[i + 1]!
      const z0 = Math.min(Math.max((k2 + 1) * (f + n) * 0.5, n), f)
      const rf = Math.sqrt(k2 * f * f + (f - z0) * (f - z0))
      const rn = Math.sqrt(k2 * n * n + (n - z0) * (n - z0))
      this.cascades[i]!.radius = Math.max(rf, rn) * 1.02
      this.cascades[i]!.centreZ = z0
    }
  }

  /** Render-graph pass 6. Excludes the sky dome; nothing else opts out. */
  async render(
    renderer: THREE.Renderer, scene: THREE.Scene, viewCamera: THREE.Camera,
    sunDir: THREE.Vector3, dome: THREE.Object3D,
  ): Promise<void> {
    const cam = viewCamera as THREE.PerspectiveCamera
    if (!cam.isPerspectiveCamera) return
    this.fitRadii(cam)

    // ── light basis ──────────────────────────────────────────────────────────
    // z points AT the sun, so light-space z decreases with distance from it.
    // World up degenerates when the sun is near the zenith.
    _z.copy(sunDir).normalize()
    const upHint = Math.abs(_z.y) > 0.999 ? _corner.set(0, 0, 1) : _worldUp
    _x.copy(upHint).cross(_z).normalize()
    _y.copy(_z).cross(_x).normalize()

    // Rows, not columns: this maps world -> (p.X, p.Y, p.Z).
    this.lightBasis.value.set(
      _x.x, _x.y, _x.z, 0,
      _y.x, _y.y, _y.z, 0,
      _z.x, _z.y, _z.z, 0,
      0, 0, 0, 1,
    )
    _pos.setFromMatrixPosition(cam.matrixWorld)
    // Every cascade camera sits on this one plane, which is what makes the
    // stored depth cascade-independent. Half the slab ahead of the viewer along
    // the sun ray is enough headroom for any caster in the greybox.
    const zPlane = _pos.dot(_z) + DEPTH * 0.5
    this.zPlane.value = zPlane

    let moved = false
    for (const c of this.cascades) {
      // Slice centre in world space, then in light space.
      _centre.set(0, 0, -c.centreZ).applyMatrix4(cam.matrixWorld)
      const texel = (c.radius * 2) / TILE
      const cx = Math.round(_centre.dot(_x) / texel) * texel
      const cy = Math.round(_centre.dot(_y) / texel) * texel
      if (cx !== c.prevX || cy !== c.prevY) moved = true
      c.prevX = cx
      c.prevY = cy
      c.u.value.set(cx, cy, c.radius, c.u.value.w)

      // Camera at (cx, cy, zPlane) in light space, oriented on the light basis.
      _pos.copy(_x).multiplyScalar(cx)
        .addScaledVector(_y, cy)
        .addScaledVector(_z, zPlane)
      c.camera.matrix.makeBasis(_x, _y, _z).setPosition(_pos)
      c.camera.matrix.decompose(c.camera.position, c.camera.quaternion, c.camera.scale)
      c.camera.updateMatrixWorld(true)
      c.camera.left = -c.radius
      c.camera.right = c.radius
      c.camera.top = c.radius
      c.camera.bottom = -c.radius
      c.camera.updateProjectionMatrix()
    }

    // WARMUP is not optional. WebGPU pipeline creation is asynchronous, so on
    // the first frames three silently skips draws whose pipeline is still
    // compiling — and with the cache on, whatever the atlas happened to catch
    // on frame 1 is what it keeps forever. That made greybox-morning differ
    // between two `npm run shots` runs, which breaks M0's determinism contract.
    const warming = this.renders < WARMUP_RENDERS
    if (!warming && !moved && sunDir.distanceToSquared(_prevSun) < 1e-12) return
    this.renders++
    _prevSun.copy(sunDir)

    const prevTarget = renderer.getRenderTarget()
    const prevOverride = scene.overrideMaterial
    const prevDomeVisible = dome.visible
    const prevAutoClear = renderer.autoClear
    dome.visible = false
    scene.overrideMaterial = this.casterMaterial
    renderer.setRenderTarget(this.target)
    for (let i = 0; i < CASCADES; i++) {
      // The tiles share one attachment, so only the first draw may clear it —
      // a WebGPU clear is a load-op on the whole texture and would wipe the
      // tiles already written. Tiles are disjoint, so one clear is correct.
      renderer.autoClear = i === 0
      this.target.viewport.set(i * TILE, 0, TILE, TILE)
      await renderer.renderAsync(scene, this.cascades[i]!.camera)
    }
    this.target.viewport.set(0, 0, ATLAS_W, TILE)
    renderer.autoClear = prevAutoClear
    scene.overrideMaterial = prevOverride
    dome.visible = prevDomeVisible
    renderer.setRenderTarget(prevTarget)
  }

  dispose(): void {
    this.target.dispose()
  }
}

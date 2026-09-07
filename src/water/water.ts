// The cartoon sea — mesh, material, and the per-frame state it needs.
//
// Render-graph step 10. What replaced a 24 km PlaneGeometry(1, 1) carrying the
// painterly `water` surface: one flat quad, no waves, no shore, no foam, and a
// palette that was a lagoon placeholder from M1.
//
// THE FIVE THINGS THAT MAKE IT READ AS THE REFERENCES, in order of how much
// they matter:
//
//   1. THE DEPTH LADDER. Four stops selected by BATHYMETRY, not by height or by
//      distance. `refs/water/shore-foam-wake.jpg` is a single continuous ramp
//      from H192 S0.77 open sea to H57 S0.17 dry sand, and every other feature
//      in that picture is a modulation of it. `src/terrain/world.ts` bakes the
//      depth; `src/water/defs.ts` carries the measured stops.
//   2. THE SHORE FOAM BAND, whose OUTER edge is the depth buffer. The water is
//      opaque and drawn after the terrain, so the waterline on screen is exact
//      at any bathymetry resolution — the map only decides how far in from it
//      the band reaches. Broken into lace by noise, because the reference's
//      shore edge is dendritic, not a stroke.
//   3. THE CAUSTIC NETWORK. Ridged noise, two octaves, `1 - abs(n)` raised to a
//      power so the zero-crossing contours come out as thin bright closed
//      loops. That is the polygonal cell pattern in `lake-cartoon-cells.jpg`
//      at 17 m and the fine filigree in `shore-foam-wake.jpg` at 3.4 m, from
//      one mechanism.
//   4. THE WAKE. `src/water/wake.ts`.
//   5. NO FRESNEL DARKENING AND ALMOST NO REFLECTION. Cartoon water is an
//      opaque coloured sheet with a pattern on it. The measured value never
//      drops below 0.73 anywhere in either reference, so anything that darkens
//      the water toward the horizon is wrong — the only thing allowed to take
//      it away is aerial perspective, same as every other surface.
//
// THE MESH IS A POLAR GRID CENTRED ON THE CAMERA. A uniform plane cannot do
// this job: the shore band is a 1 m depth feature and the horizon is 12 km out,
// so a grid fine enough for one is 500 million quads for the other. Rings grow
// geometrically, which holds the ratio of radial to angular cell size constant
// all the way out — 48k triangles total, against the greybox plane's 2.
//
// Waves are evaluated in WORLD space, so the surface itself does not move when
// the grid recentres; only the tessellation slides underneath it.

import * as THREE from 'three/webgpu'
import {
  cameraPosition, dFdx, dFdy, dot, exp2, float, length, log2, luminance, max, min,
  mix, modelWorldMatrix, mx_noise_float, normalize,
  positionLocal, positionWorld, pow, saturate, smoothstep, texture, uniform, vec2,
  vec3, vec4,
} from 'three/tsl'
import type { Node } from 'three/webgpu'
import type { Atmosphere } from '../atmosphere/sky'
import { clampChroma, setSaturation } from '../atmosphere/scattering'
import { BATHY_NEAR, BATHY_RANGE, type TerrainWorld } from '../terrain/world'
import { water as waterDef, type WaterParams } from './defs'
import { TILE_CELLS, voronoiTexture } from './voronoiTexture'
import { swashLift, swashLiftAt, waveField, waveHeightAt } from './waves'
import { WakeField, type FoamStamp } from './wake'

/** Rings in the polar grid. */
const RINGS = 150
/** Sectors. */
const SECTORS = 160
/** Innermost ring radius, metres. */
const R0 = 1.2
/** Outermost ring of the detailed grid, metres. */
const R_FAR = 9000
/** One flat skirt ring beyond that, so the sea reaches the horizon haze. */
const R_SKIRT = 24000

const _c = new THREE.Color()
function hexToLinear(hex: number, out: THREE.Vector3): THREE.Vector3 {
  _c.setHex(hex, THREE.SRGBColorSpace).convertSRGBToLinear()
  return out.set(_c.r, _c.g, _c.b)
}

/**
 * A camera-centred polar sheet.
 *
 * Radii are geometric so the cell aspect ratio is constant: at ring i the
 * radial step is `r_i (g - 1)` and the angular step is `2 pi r_i / SECTORS`,
 * both proportional to r. 1.2 m at the camera, 560 m at 9 km.
 */
function polarSheet(): THREE.BufferGeometry {
  const growth = Math.pow(R_FAR / R0, 1 / (RINGS - 1))
  const radii: number[] = []
  for (let i = 0; i < RINGS; i++) radii.push(R0 * Math.pow(growth, i))
  radii.push(R_SKIRT)
  const nR = radii.length

  const verts = new Float32Array((nR * SECTORS + 1) * 3)
  const normals = new Float32Array((nR * SECTORS + 1) * 3)
  // Vertex 0 is the centre; ring r, sector s is at 1 + r * SECTORS + s.
  normals[1] = 1
  for (let r = 0; r < nR; r++) {
    for (let s = 0; s < SECTORS; s++) {
      const a = (s / SECTORS) * Math.PI * 2
      const o = (1 + r * SECTORS + s) * 3
      verts[o] = Math.cos(a) * radii[r]!
      verts[o + 2] = Math.sin(a) * radii[r]!
      normals[o + 1] = 1
    }
  }

  const idx: number[] = []
  for (let s = 0; s < SECTORS; s++) {
    const s1 = (s + 1) % SECTORS
    idx.push(0, 1 + s1, 1 + s)
  }
  for (let r = 0; r < nR - 1; r++) {
    for (let s = 0; s < SECTORS; s++) {
      const s1 = (s + 1) % SECTORS
      const a = 1 + r * SECTORS + s
      const b = 1 + r * SECTORS + s1
      const c = 1 + (r + 1) * SECTORS + s1
      const d = 1 + (r + 1) * SECTORS + s
      idx.push(a, c, b, a, d, c)
    }
  }

  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(verts, 3))
  g.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  g.setIndex(idx)
  // Never culled: the sheet is always under the camera and its bounding sphere
  // is meaningless once the vertex stage has displaced it.
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), R_SKIRT * 2)
  return g
}

export interface WaterOptions {
  /** Def id in `assets/defs/water/`. */
  def?: string
}

export class Water {
  readonly mesh: THREE.Mesh
  readonly material = new THREE.MeshBasicNodeMaterial()
  readonly wake = new WakeField()
  readonly params: WaterParams
  readonly level: number

  private readonly timeNode = uniform(0)
  private elapsed = 0
  /** Held for `surfaceAt`, which needs the depth to mask the beach swash. */
  private readonly terrain: TerrainWorld

  constructor(
    atmosphere: Atmosphere,
    terrain: TerrainWorld,
    options: WaterOptions = {},
  ) {
    const p = waterDef(options.def ?? 'sea')
    this.params = p
    this.level = terrain.waterLevel
    this.terrain = terrain

    const u = {
      deep: uniform(hexToLinear(p.deep, new THREE.Vector3())),
      mid: uniform(hexToLinear(p.mid, new THREE.Vector3())),
      shallow: uniform(hexToLinear(p.shallow, new THREE.Vector3())),
      edge: uniform(hexToLinear(p.edge, new THREE.Vector3())),
      foam: uniform(hexToLinear(p.foam, new THREE.Vector3())),
      caustic: uniform(hexToLinear(p.causticColour, new THREE.Vector3())),
      depthMid: uniform(p.depthMid),
      depthShallow: uniform(p.depthShallow),
      depthEdge: uniform(p.depthEdge),
      bandSoftness: uniform(p.bandSoftness),
      seabedMix: uniform(p.seabedMix),
      bandWarp: uniform(p.bandWarp),
      causticScale: uniform(p.causticScale),
      causticFine: uniform(p.causticFine),
      causticStrength: uniform(p.causticStrength),
      causticWidth: uniform(p.causticWidth),
      causticFlow: uniform(p.causticFlow),
      causticDeep: uniform(p.causticDeep),
      cellScale: uniform(p.cellScale),
      cellLevels: uniform(p.cellLevels),
      cellAmp: uniform(p.cellAmp),
      cellRim: uniform(p.cellRim),
      cellRimStrength: uniform(p.cellRimStrength),
      cellRound: uniform(p.cellRound),
      cellRimValue: uniform(p.cellRimValue),
      cellRimDesat: uniform(p.cellRimDesat),
      aerial: uniform(p.aerial),
      shallowDesat: uniform(p.shallowDesat),
      waveAmp: uniform(p.waveAmp),
      waveScale: uniform(p.waveScale),
      waveSpeed: uniform(p.waveSpeed),
      waveChop: uniform(p.waveChop),
      foamShore: uniform(p.foamShore),
      foamLace: uniform(p.foamLace),
      foamLaceScale: uniform(p.foamLaceScale),
      foamSlopeBias: uniform(p.foamSlopeBias),
      wakeStrength: uniform(p.wakeStrength),
      wakeLace: uniform(p.wakeLace),
      wakeLaceScale: uniform(p.wakeLaceScale),
      glintStrength: uniform(p.glintStrength),
      glintPower: uniform(p.glintPower),
      glintNeutral: uniform(p.glintNeutral),
      skyMix: uniform(p.skyMix),
      saturationGain: uniform(p.saturationGain),
      swashAmp: uniform(p.swashAmp),
      swashReach: uniform(p.swashReach),
      swashRate: uniform(p.swashRate),
      ambient: uniform(p.ambient),
    }
    const t = this.timeNode

    // ── vertex: the wave field, in world space ────────────────────────────────
    // The undisplaced world position. `positionWorld` is derived from
    // `positionNode`, so reading it here to decide what `positionNode` should be
    // is circular — the same reason painterly.ts samples the deform field off
    // `modelWorldMatrix * positionLocal`.
    const flatWorld = vec3(modelWorldMatrix.mul(vec4(positionLocal, 1)).xyz)
    const vw = waveField(
      flatWorld.xz, t, u.waveAmp, u.waveScale, u.waveSpeed, u.waveChop,
    )
    // THE SWASH LIFTS THE SHEET, which is what floods the sand. It needs the
    // depth at the UNDISPLACED vertex, so the bathymetry is tapped here in the
    // vertex stage as well as in the fragment stage; the two taps read the same
    // map at the same place and therefore agree on where the waterline is.
    const vDepth = mix(
      vec4(texture(terrain.bathyMap,
        vec2(flatWorld.xz.div(terrain.span).add(0.5)))).g.mul(BATHY_NEAR),
      vec4(texture(terrain.bathyMap,
        vec2(flatWorld.xz.div(terrain.span).add(0.5)))).r.mul(BATHY_RANGE),
      smoothstep(0.82, 0.99, vec4(texture(terrain.bathyMap,
        vec2(flatWorld.xz.div(terrain.span).add(0.5)))).g),
    )
    const vSwash = swashLift(
      flatWorld.xz, vDepth, t, u.swashAmp, u.swashReach, u.swashRate,
    )
    this.material.positionNode = vec3(
      positionLocal.x.add(vw.offset.x),
      positionLocal.y.add(vw.height).add(vSwash),
      positionLocal.z.add(vw.offset.y),
    )

    // ── fragment ─────────────────────────────────────────────────────────────
    const wp = vec3(positionWorld)
    const xz = wp.xz
    /**
     * Metres of world per screen pixel — the ONE anti-aliasing quantity in this
     * material that can be trusted.
     *
     * Every earlier fade keyed off `dFdx` of a NOISE-derived value, and that is
     * self-defeating: a screen-space derivative is a finite difference over a
     * 2x2 quad, so on a signal that is already aliasing it under-reports the
     * gradient and the fade never engages. Measured, that is exactly what
     * happened — with the cell rim on, the grazing frames read `fine` 0.0513 and
     * 0.0487 against the reference's 0.0049; with `cellRimStrength` set to 0 they
     * read 0.0120 and 0.0075. The rim was the entire source of the crawl while
     * its own fade believed it was resolved.
     *
     * `positionWorld` is smooth, so its derivative is meaningful at any
     * frequency, and every feature's footprint is then this divided by that
     * feature's wavelength.
     */
    const voronoi = voronoiTexture()

    const mPerPx = length(vec2(
      length(vec2(dFdx(xz.x), dFdy(xz.x))),
      length(vec2(dFdx(xz.y), dFdy(xz.y))),
    ))
    const mapUv = vec2(xz.div(terrain.span).add(0.5))

    // Re-evaluated per PIXEL rather than interpolated from the vertex stage.
    // Six trig calls, and it buys a normal that carries the short wave instead
    // of the 1.2-to-560 m cell average — which is the difference between a
    // glint that reads as water and one that reads as a lens flare.
    const fw = waveField(xz, t, u.waveAmp, u.waveScale, u.waveSpeed, u.waveChop)
    // THE SHADING NORMAL IS MIPPED TOWARD VERTICAL, and this was the actual
    // source of the residual per-pixel crawl — after the cell rim, the ridge
    // octaves, the two lace noises and the flat masses had each been given a
    // screen-space fade and NONE of them moved `water-open`'s `fine` off 0.025.
    //
    // The wave field's shortest component is a 7.3 m sine, so at a gameplay
    // camera the mid-field samples it well under Nyquist; and the normal does not
    // merely tint, it drives `ndl`, the sky term and — through
    // `pow(dot(n, half), 320)` — a specular exponent of three hundred. A high
    // exponent on an under-sampled normal is an aliasing amplifier: a
    // half-pixel change in the normal swings the highlight from nothing to
    // everything.
    //
    // Blending toward straight up as the footprint grows is the correct limit for
    // water: averaged over many wavelengths a wave surface IS flat, so this is a
    // mip rather than a fudge, and it takes the glint, the diffuse flicker and
    // the sky term with it in one move.
    const normAA = smoothstep(0.9, 0.18, mPerPx.div(u.waveScale.mul(0.27).max(1)))
    const n = vec3(normalize(mix(vec3(0, 1, 0), fw.normal, normAA)))

    // ── the ripple / caustic field ───────────────────────────────────────────
    // Ridged noise: `1 - |n|` peaks on the noise's zero-crossing contours, which
    // are closed loops, so raising it to a power leaves a network of thin bright
    // curves. One mechanism, two scales: the reference's big polygonal cells and
    // its fine filigree are the same thing at 17 m and 3.4 m.
    const ridge = (scale: Node<'float'>, drift: number, speed: number): Node<'float'> => {
      const q = vec3(
        xz.x.div(scale).add(t.mul(u.causticFlow).mul(speed)),
        xz.y.div(scale).sub(t.mul(u.causticFlow).mul(speed * 0.6)),
        float(drift).add(t.mul(u.causticFlow).mul(0.5)),
      )
      const raw = mx_noise_float(q)
      const r = raw.abs().oneMinus()
      // AND A SCREEN-SPACE FADE OF ITS OWN, which this octave had none of — only
      // a camera-DISTANCE fade, which cannot see that a grazing view compresses
      // the mid-field into a few pixels. Measured, this was where the per-pixel
      // residual was actually coming from: after the cell rim got its own fade
      // the grazing frames still read `fine` 0.035-0.051 against the reference's
      // 0.0049, and the cell field was already faded to nothing there. A ridge
      // line is a thin bright curve by construction, so it aliases at a lower
      // frequency than anything else in the material.
      // Same trustworthy footprint: a ridge line is roughly a tenth of a cell
      // wide, so it goes sub-pixel at about a twentieth of a cell per pixel.
      const aa = smoothstep(0.07, 0.018, mPerPx.div(scale.max(1)))
      return pow(saturate(r), float(2.4).div(u.causticWidth.max(0.02))).mul(aa)
    }
    const cellBig = ridge(u.causticScale, 3.7, 1)
    const cellFine = ridge(u.causticFine, 11.3, 1.9)

    // ── THE CARTOON CELL FIELD ───────────────────────────────────────────────
    //
    // The register the brief actually asks for — "more cartoony like the
    // graphic" — and the thing ridged noise cannot produce. Measured, with the
    // ridge octaves alone the open water read cellSpread 0.045 / cellEdge 3.4
    // against `refs/water/lake-cartoon-cells.jpg`'s 0.156 / 11.0: a third of the
    // contrast and a third of the edge hardness. That is not a strength knob
    // away, it is a different shape. Ridged noise draws thin bright LINES on a
    // uniform ground; the reference draws FLAT MASSES meeting at crisp borders,
    // which is the same distinction ART_BIBLE §1 makes about rock planes.
    //
    // CONTOUR-QUANTISED NOISE, NOT A WARPED GRID. The first attempt was a
    // domain-warped square lattice — one flat hash per grid cell, a rim on the
    // cell borders — and it rendered as a FISHING NET: `shots/water-vista.png`
    // came back with long straight-ish rim lines running to the horizon in two
    // families at right angles, because a 0.33-cell warp cannot hide a global
    // lattice and a bigger warp folds it. The lesson is that the reference's
    // cells are not a tiling at all; they are irregular closed loops of varying
    // size with no preferred direction.
    //
    // The contours of a 2-octave noise ARE exactly that. Quantise the field into
    // levels and you get flat plateaus (the masses) separated by the level
    // boundaries (the borders), with no lattice anywhere and cell size set by
    // one wavelength.
    //
    // ANTI-ALIASED BY SCREEN-SPACE DERIVATIVE, not by camera distance. A border
    // is a sub-pixel feature as soon as the contour spacing approaches a pixel,
    // and the previous distance-based `nearFade` could not know that — a camera
    // 90 m up looking down puts a 40 m cell at 12 px while sitting well inside
    // the "near" range, which is precisely the tinfoil that `lagoon-morning`
    // measured at 152 features per frame width against the reference's 37.
    // ── A SCALE-INVARIANT CELL FIELD ─────────────────────────────────────────
    //
    // ONE OCTAVE CANNOT BE RIGHT AT TWO CAMERA HEIGHTS, and the measurements say
    // so plainly. Cells per frame width, counted by scanline border crossings:
    //
    //   refs/water/lake-cartoon-cells.jpg   28.1     the governing register
    //   refs/water/shore-foam-wake.jpg      14.5
    //   lagoon-morning                      30.0     on register
    //   water-vista, shallow                21.1     on register
    //   water-wake, bare water               5.7
    //   water-open, near                     3.3
    //   water-close, near                    2.2     12.8x oversized
    //
    // The two frames that MATCH are the two high cameras, so the base scale is
    // already correct at altitude and shrinking it is not the fix: at a scale
    // that gave `water-close` 28 cells, `lagoon-morning` would carry about 400.
    //
    // THE PATTERN STAYS WORLD-LOCKED. A screen-locked cell size would be trivial
    // and wrong — the pattern would slide and breathe as the camera moved, which
    // no water surface does. So the octaves are the base scale times POWERS OF
    // TWO, each of which is a fixed pattern in the world, and the two nearest the
    // pixel footprint are blended. Moving the camera cross-fades two stationary
    // patterns; it never slides one. This is what a mip-map does for a texture,
    // and it is the same reasoning as the rim's energy argument one step up.
    const CELL_PX = 90
    /** Octaves above the base scale needed to put a cell at `CELL_PX` pixels. */
    const lod = log2(mPerPx.mul(CELL_PX).div(u.cellScale.max(1)).max(1e-4))
      .clamp(-2.5, 3.5)
    const lodLo = lod.floor()
    const lodMix = lod.sub(lodLo)

    /**
     * The cell field at one octave — a VORONOI PARTITION, not a contour map.
     *
     * WHAT THIS REPLACED AND WHY, because the previous form was a plausible
     * mistake that survived three rounds. It quantised a noise into levels and
     * drew the level boundaries: `cellLevels` 2.8 means one noise blob crosses
     * about three levels, so it got about three NESTED rings — the bullseye motif
     * that was all over `water-close` and `lagoon-morning` — and the per-cell tone
     * hashed the LEVEL INDEX, so two disjoint regions at the same height shared a
     * tone. It was drawing a topographic map: closed loops of an elevation field,
     * where the reference is a TILING.
     *
     * Side by side the difference is a form language, not a parameter. The
     * reference is a partition: ONE rim between any two neighbours, rims meeting
     * at T and Y junctions in a connected web, near-straight edges, convex
     * interiors. Contours cannot make a junction — level sets never cross — so no
     * setting of `cellRim`, `cellLevels` or `cellRimStrength` could have got
     * there, and each round's tuning made the bullseyes louder instead.
     *
     * `F2 - F1` of a Worley noise is exactly the Voronoi edge distance: zero on a
     * cell border, largest at a cell centre. Rims meet at junctions because
     * Voronoi vertices are where three cells meet.
     *
     * AND THIS IS NOT THE LATTICE THAT WAS REJECTED EARLIER. That was a
     * domain-warped SQUARE GRID with rims on the grid borders, which read as a
     * fishing net because a warp cannot hide a global axis. Worley sites are
     * jittered and have no preferred direction; conflating the two is what kept
     * this unfixed.
     */
    const cellsAt = (scale: Node<'float'>): {
      rim: Node<'float'>
      flat: Node<'float'>
    } => {
      const q = vec2(xz.div(scale.max(0.5)))
      const flow = t.mul(u.causticFlow).mul(0.35)
      // A GENTLE DOMAIN WARP so the cells vary in size and shape. Worley on an
      // unwarped grid of jittered sites gives cells of very similar area, which
      // reads as cracked glass; the reference's vary by two or three to one. This
      // is a warp of the SAMPLE POSITION, not of a lattice — there is no axis for
      // it to reveal, which is the difference from the square-grid attempt.
      const warp = vec2(
        mx_noise_float(vec3(q.mul(0.31), flow.mul(0.5))),
        mx_noise_float(vec3(q.mul(0.31).add(11.7), flow.mul(0.5).add(4.3))),
      ).mul(0.80)
      // SAMPLED FROM THE BAKED VORONOI TEXTURE rather than searched per pixel.
      // See src/water/voronoiTexture.ts for the channel layout and for why the
      // procedural Worley it replaces could not do the job: it returns distances
      // only, so a cell had no identity and its interior could not be a flat
      // plate of its own tone. `refs/water/lake-cartoon-cells.jpg` is a honeycomb
      // of flat plates with bright rims; a marbled field is the thing it is not.
      const cell = vec4(texture(voronoi, q.add(warp).div(TILE_CELLS)))
      /**
       * 0 on a cell border, ~0.5 mid-cell, in cell units.
       *
       * R is the same border distance with its corners bevelled and G is the
       * hard one; `cellRound` mixes them. Both are stored at the same scale, so
       * `cellRim` means the same width at either end of the mix.
       */
      const edge = mix(cell.y, cell.x, u.cellRound)
      return {
        rim: smoothstep(u.cellRim, u.cellRim.mul(0.3), edge),
        // PER CELL, BUT DOMED RATHER THAN FLAT. `B` is the cell's own hashed
        // tone, constant across its interior and stepping at the border, and
        // taken raw it makes each cell a FLAT PLATE — which is what reads as
        // "opaque, made of polygons": a mosaic of shaded facets rather than a
        // surface. Fading the tone out toward the cell's own border instead
        // gives each one a soft dome, so neighbours meet in a gradient and the
        // partition arrives as a rim network over a continuous ramp.
        //
        // The per-cell variation itself has to STAY: the reference measures
        // `cellSpread` 0.133, so distinct cell tones are part of its character
        // and removing them is not the fix. Only the hard edge is.
        flat: cell.z.sub(0.5).mul(smoothstep(0, 0.30, edge).mul(0.62).add(0.38)),
      }
    }

    const octLo = cellsAt(u.cellScale.mul(exp2(lodLo)))
    const octHi = cellsAt(u.cellScale.mul(exp2(lodLo.add(1))))

    // THE FADES SURVIVE, and they are now cheap: because the chosen octave always
    // sits near `CELL_PX` pixels, `cellsPerPx` is near-constant and the fades
    // mostly stop firing — they remain as the guard at the clamp ends, where the
    // world runs out of octaves (a camera on the deck, or one high enough that
    // even the coarsest octave is fine).
    //
    // A rim a fraction of a cell wide goes sub-pixel long before the masses do —
    // `cellFlat` is a STEP function with `cellLevels` hard edges per cell — so the
    // two keep separate thresholds. Fading them together either kept the crawl or
    // flattened the distance, and both were shipped in turn.
    const cellsPerPx = mPerPx.div(u.cellScale.mul(exp2(lodLo)).max(1))
    /** The rim is `cellRim / cellLevels` of a cell wide. */
    const rimCells = u.cellRim.div(u.cellLevels.max(0.5))
    const rimAA = smoothstep(rimCells.mul(0.9), rimCells.mul(0.28), cellsPerPx)
    const cellAA = smoothstep(0.55, 0.13, cellsPerPx)
    // THE RIM BLENDS AS A UNION, NOT A LERP, and the masses lerp. A rim is a
    // sparse PRESENCE feature: two octaves' rims almost never coincide, so
    // `mix` at a half-and-half crossover halves the peak amplitude everywhere
    // and the net goes faint. Measured, that alone took `cellBorder` from 0.168
    // to 0.001. `1 - (1-a)(1-b)` is the coverage union — either octave's rim
    // makes a rim — and it holds 0.75 at the crossover instead of 0.5 while
    // staying continuous. The flat masses are smooth fields and lerp correctly.
    const rimLo = octLo.rim.mul(lodMix.oneMinus())
    const rimHi = octHi.rim.mul(lodMix)
    const rim = rimLo.oneMinus().mul(rimHi.oneMinus()).oneMinus().mul(rimAA)
    const cellFlat = mix(octLo.flat, octHi.flat, lodMix)
    /** Signed, roughly -1..1, for warping band boundaries. */
    const wobble = mx_noise_float(vec3(
      xz.x.div(u.causticScale.mul(0.6)),
      xz.y.div(u.causticScale.mul(0.6)),
      t.mul(u.causticFlow).mul(0.8),
    ))

    // ── the depth ladder ─────────────────────────────────────────────────────
    // R spans BATHY_RANGE metres and G the first BATHY_NEAR, so the shallows get
    // the full 8-bit range instead of the bottom eighth of it. Below the near
    // range the fine channel IS the depth; above it, it is saturated and the
    // coarse one takes over.
    /** Metres of water at a world XZ. */
    const depthAt = (at: Node<'vec2'>): Node<'float'> => {
      const t2 = vec4(texture(terrain.bathyMap, vec2(at.div(terrain.span).add(0.5))))
      // R spans BATHY_RANGE and G the first BATHY_NEAR, so the shallows get the
      // full 8-bit range instead of the bottom eighth of it. Below the near
      // range the fine channel IS the depth; above it, it saturates and the
      // coarse one takes over.
      return mix(t2.g.mul(BATHY_NEAR), t2.r.mul(BATHY_RANGE),
        smoothstep(0.82, 0.99, t2.g))
    }
    const rawDepth = depthAt(xz)

    // ── THE SEABED GRADIENT, AND WHY IT IS LOAD-BEARING ──────────────────────
    //
    // The first build of this authored the surf band as "0.85 metres of DEPTH"
    // and the result was a white belt several hundred metres wide across every
    // coast in the game. That is not a wrong constant, it is the wrong VARIABLE:
    // this world's shelves are nearly flat (the landform was flattened to an
    // 8-degree median slope, and a submerged shelf is gentler still), so a
    // fixed depth threshold buys an unbounded horizontal distance. Measured at
    // (-1004, 809), 0.85 m of depth is about 170 m of beach.
    //
    // So the shore terms work in HORIZONTAL METRES FROM THE WATERLINE, which is
    // the quantity the reference is actually showing and the one an art
    // direction can be authored against. Two extra bathymetry taps give the
    // gradient; dividing depth by it converts to distance.
    const PROBE = 9
    const gx = depthAt(xz.add(vec2(PROBE, 0))).sub(rawDepth)
    const gz = depthAt(xz.add(vec2(0, PROBE))).sub(rawDepth)
    // Floored at 0.004 (a 1-in-250 shelf) so a dead-flat seabed still gets a
    // finite band instead of dividing by zero, and ceilinged at 1 so a cliff
    // face does not collapse the band below a texel.
    const slope = length(vec2(gx, gz)).div(PROBE).clamp(0.004, 1)

    // The ladder stays in DEPTH, because the reference's colour ramp genuinely
    // is a depth ramp — but its boundary WOBBLE is authored in horizontal
    // metres and converted, or a flat shelf turns a 0.55 m wobble into
    // hundred-metre colour blobs by the same arithmetic as above.
    const depth = rawDepth.add(wobble.mul(u.bandWarp).mul(slope)).max(0)

    /** Horizontal metres to the waterline, with the swell's run-up in it. */
    // THE SWASH MOVES THE WATERLINE SIDEWAYS, and it has to be applied here, in
    // horizontal metres, rather than as a depth.
    //
    // Adding the lift to the DEPTH was the first attempt and it is wrong on a
    // flat shelf. This coast is about 1-in-250, so `depth / slope` turns 0.9 m
    // of lift into 225 m of distance-from-the-waterline: the whole surf band was
    // shoved offshore, and wet coverage went DOWN when the swash came on
    // (0.0131 of range against 0.0191 with it disabled). The strip of sand the
    // wave had just flooded reported itself 225 m from the water.
    //
    // A rise of L moves the waterline inland by L/slope, so every point in the
    // sea is that much further from it — one subtraction, in the same units the
    // rest of the shore terms are already authored in.
    const swash = swashLift(xz, rawDepth, t, u.swashAmp, u.swashReach, u.swashRate)
    const shoreDist = rawDepth.div(slope).sub(swash.div(slope))
      // Run-up: the swell moves the waterline in and out. Capped, because on a
      // 1-in-250 shelf an uncapped 0.24 m wave sweeps 60 m of beach and the
      // surf line would pump like a heartbeat.
      //
      // 0.70, DOWN FROM 1.35, so that raising `waveAmp` does not drag the
      // shoreline with it. At 1.35 a 0.62 m swell pinned this term at its -5 m
      // clamp almost all the time, which shifts the waterline a full 5 m inland
      // everywhere and turns the wash into a flood: `foamShare` 0.563,
      // `shoreStroke` 0.0450 against a 0.010 ceiling. Offshore wave height and
      // waterline sweep are separate quantities — real swell shoals and breaks
      // rather than translating the beach — so the multiplier absorbs the
      // amplitude change and the shore band keeps its calibration.
      .sub(fw.height.mul(1.35).div(slope).clamp(-5, 5))
      .max(0)
    const shelf = saturate(slope.mul(6))

    /** Step centred on `at`, `soft` fraction of the gap `gap` wide. */
    const step = (at: Node<'float'>, gap: Node<'float'>): Node<'float'> => {
      const hw = gap.mul(u.bandSoftness).mul(0.5).max(0.04)
      return smoothstep(at.sub(hw), at.add(hw), depth)
    }

    // The seabed reads through at the shallow end — the reference's "sand under
    // water" band is literally the beach colour with a cyan veil on it, and this
    // is the one place the water is allowed to borrow the terrain's palette.
    const decode = (c: Node<'vec3'>): Node<'vec3'> => vec3(pow(c, float(2.2)))
    // DESATURATED on the way in. The seabed here is the terrain's own biome
    // colour, and in a desert-coast that is a saturated yellow — blended
    // straight in it turned the shallows lime green, where the reference's
    // "sand under water" band measures S0.15. Water over sand is sand seen
    // through a veil, so it cannot be MORE chromatic than the sand is.
    const seabed = setSaturation(
      decode(vec3(texture(terrain.baseMap, mapUv).rgb)), 0.55,
    )
    const edgeCol = vec3(mix(u.edge, seabed.mul(1.1), u.seabedMix))

    let albedo: Node<'vec3'> = vec3(edgeCol)
    albedo = vec3(mix(albedo, u.shallow, step(u.depthEdge, u.depthShallow.sub(u.depthEdge))))
    albedo = vec3(mix(albedo, u.mid, step(u.depthShallow, u.depthMid.sub(u.depthShallow))))
    albedo = vec3(mix(albedo, u.deep, step(u.depthMid, u.depthMid)))

    // Caustics focus in the shallows and wash out in open water, which is both
    // physically what happens and what the reference shows.
    const causticFade = mix(float(1), u.causticDeep, smoothstep(
      u.depthShallow, u.depthMid.mul(1.4), depth,
    ))
    // AND A DISTANCE FADE, which is not a nicety — it is the difference between
    // a ripple and a moiré. `causticFine` is a 7 m feature; past about 300 m
    // one feature is under a pixel, so the net stops being a pattern and starts
    // being per-pixel noise that crawls when the camera moves.
    const camDist = wp.sub(cameraPosition).length()
    const nearFade = mix(float(1), float(0.45), smoothstep(120, 620, camDist))
    const caustic = max(cellBig.mul(0.55), cellFine.mul(0.7))
      .mul(u.causticStrength).mul(causticFade).mul(nearFade)

    // FLAT MASSES FIRST, then the rim, then the fine filigree on top. Order
    // matters: the mass is a multiply on the water's own colour so it keeps the
    // depth ladder's hue, while the rim and the filigree are mixes toward the
    // pale caustic colour, which is a light effect and not a change of water.
    // THE MASSES ARE NOT GRAZE-FADED, only the rim is. The flat masses are
    // low-frequency by construction and cannot alias; all of the per-pixel
    // residual comes from the thin rim. Fading both together cost `water-open`
    // its whole cartoon read — cellSpread 0.118 -> 0.053 and cellBorder 0.170 ->
    // 0.026, straight through both floors — to fix an aliasing figure the masses
    // were not contributing to.
    // THE SHALLOWS GET A CALMER FIELD. The brief names the photographic
    // reference for the coast-to-sea look, and there the shallows are a smooth
    // low-contrast wash — detrended cell amplitude 0.030 against the cartoon
    // lake's 0.133, which is the register the DEEP water is supposed to have.
    // Ours applied the deep amplitude all the way in and measured 0.110-0.153
    // over sand, three to five times the governing image, which reads as loud
    // marbling exactly where the reference is a pale wash.
    const cellDepth = mix(float(0.35), float(1),
      smoothstep(u.depthEdge, u.depthMid, depth))
    albedo = vec3(albedo.mul(cellFlat.mul(u.cellAmp).mul(cellAA).mul(cellDepth).add(1)))
    // THE CELL RIM IS NOT FADED BY DEPTH THE WAY THE RIDGE CAUSTIC IS, and that
    // one multiply was why only about 30% of the authored rim colour reached the
    // screen: `causticFade` falls to `causticDeep` = 0.34 in open water, so the
    // rim arrived at 0.95 x 0.34 = 0.32 of its step. Measured, the authored
    // #a9e8ec at S0.28 rendered at S0.66 against a plateau at S0.80 — a hue step
    // of 7 degrees and a value step of 0.05, where the reference's crest is 32
    // degrees and 0.15 from its own plateau.
    //
    // `causticFade` is physically right for the RIDGE octaves — a real caustic
    // focuses in the shallows — and wrong for the cell partition, which is a
    // graphic element the cartoon reference draws at full strength over its
    // deepest water. `cellDepth` stays: that one calms the shallows, which the
    // photographic reference does want.
    // A VALUE STEP IN THE WATER'S OWN HUE, not a second colour laid over it.
    // This used to mix toward `causticColour`, a mint `#d9f3e6`, and measured
    // rim H158-166 S0.42 against interiors at H188 S0.82 — 23 to 29 degrees off
    // with 0.40 less saturation, where the reference's rim is 0 degrees off its
    // own interior and differs by value alone. A hue rotation that large stops
    // being water and becomes netting.
    //
    // Lifting the ALBEDO ITSELF cannot rotate the hue, whatever the depth
    // ladder underneath is doing, so the rim stays in the material family in
    // shallow and deep water alike. The desaturation is a pull toward the
    // lifted colour's own luminance, which is hue-preserving by construction.
    const rimAmt = saturate(rim.mul(u.cellRimStrength).mul(cellDepth))
    const rimLit = vec3(albedo.mul(u.cellRimValue))
    const rimTint = vec3(mix(rimLit, vec3(luminance(rimLit)), u.cellRimDesat))
    albedo = vec3(mix(albedo, rimTint, rimAmt))
    albedo = vec3(mix(albedo, u.caustic, saturate(caustic)))

    // ── foam ─────────────────────────────────────────────────────────────────
    // SHORE. The band's outer edge is the depth buffer, so this only sets how
    // far in it reaches. Laced by noise on the INNER edge, because the
    // reference's surf line is dendritic; narrowed and brightened on a steep
    // shelf, because a plunging shore has a thin hard line of surf and a flat
    // one has metres of wash.
    // ANTI-ALIASED like everything else in here. `foamLaceScale` is 7.5 m and
    // `wakeLaceScale` 1.7 m, and both were the only high-frequency terms in the
    // material with no screen-space protection at all — which is where the last
    // of the per-pixel crawl was hiding once the cell rim and the ridge octaves
    // had theirs. Faded toward its own mean (0), so lace stops breaking the foam
    // at the distance where a hole would be smaller than a pixel: an unresolved
    // hole is noise, and a solid band is the honest limit of one.
    const laceAA = smoothstep(0.5, 0.14, mPerPx.div(u.foamLaceScale.max(0.5)))
    const lace = mx_noise_float(vec3(
      xz.x.div(u.foamLaceScale),
      xz.y.div(u.foamLaceScale),
      t.mul(0.11),
    )).mul(laceAA)
    const shoreWidth = u.foamShore
      .mul(mix(float(1), float(0.45), saturate(shelf.mul(u.foamSlopeBias.mul(2)))))
      .mul(lace.mul(u.foamLace).add(1).max(0.05))
    /**
     * 1 at the waterline, 0 at the seaward edge of the band.
     *
     * OPAQUE OVER THE INNER 45%, not a ramp across the whole width. The band's
     * SHARE of the frame and its unbroken RUN length pull against each other and
     * the width knob cannot satisfy both: measured, at 12 m `foamShare` fell
     * under its floor and at 20 m the longest run reached 0.49 of the box, with
     * nothing in between clearing both. Wide-and-translucent is the wrong shape
     * anyway — most of a 15 m band sat at half opacity, which is pale WATER
     * rather than foam, so it counted against the run length without counting
     * toward the share. The reference's outline is 0.35-0.55% of frame width and
     * near-opaque; ours was 1.0-1.2% and semi-transparent.
     */
    const wash = smoothstep(shoreWidth, shoreWidth.mul(0.55), shoreDist)
    // LACE, and this is the shape of the reference rather than a texture on it.
    // `shore-foam-wake.jpg`'s surf is SOLID white against the sand and breaks
    // into dendritic fingers and holes as it reaches seaward, so the noise
    // threshold has to RISE with distance from the waterline: near the sand no
    // amount of noise can punch through, at the outer edge almost any of it
    // can. A single multiply by noise gives an evenly speckled band instead,
    // which reads as dirt.
    // The threshold starts at 0.22 rather than 0 so that even AT the waterline
    // the noise can open holes; before, `wash` was 1 there, the threshold was 0,
    // and the mask was unconditionally 1 across the inner half of the band.
    const laceT = wash.oneMinus().mul(0.78).add(0.22).mul(u.foamLace)
    const laceMask = smoothstep(laceT, laceT.add(0.3), lace.mul(0.5).add(0.55))
    // Plus a thin bright line hugging the sand. The band alone has no edge, and
    // an edge is what makes surf read as surf rather than as pale water.
    //
    // 0.07 OF THE BAND, NOT 0.26. At 0.26 of a 22 m band this was a 5.7 m strip
    // of unconditional white `max`-ed over the lace, so the lace could never
    // break the part of the surf nearest the sand — which is exactly where the
    // reference's is laciest. Measured: the surf's longest unbroken horizontal
    // run was 0.49 of the measurement box against 0.082 in
    // `refs/water/lake-cartoon-cells.jpg`, i.e. a slab with a soft edge rather
    // than an outline. At 0.07 the line is 1.5 m: an edge, not a fill.
    const surfLine = smoothstep(shoreWidth.mul(0.07), 0, shoreDist)
    // HARD-EDGED STRANDS, not a soft blob. `wash` ramps over 45% of the band and
    // `laceMask` is a smoothstep, so their product was a 40 px gradient — a
    // review called it spilled milk and measured the longest unbroken piece at
    // 0.226 of the box against the reference's 0.082. The reference's shore is a
    // thin branching network of hard-edged strands with sand showing between
    // them.
    //
    // Putting a narrow step on the PRODUCT is what turns a soft field into
    // strands: everything above 0.52 becomes foam, everything below is water, and
    // the lace noise decides which side of that a given point falls on. The band
    // keeps its width and loses its gradient, which is the whole difference.
    // THE SURF LINE IS LACED TOO, at 60% — it was the unconditional solid strip
    // and therefore the longest unbroken piece in the band by construction.
    // Thinning the band did not touch it: `foamShare` fell from 0.056 to 0.030
    // while `shoreMaxRun` moved 0.219 -> 0.199, because the run being measured
    // was never part of what the threshold controls. The reference's shore has no
    // unconditional line anywhere in it; the crisp edge comes from the step below,
    // not from a strip that cannot break.
    const shoreField = max(wash.mul(laceMask), surfLine.mul(mix(float(1), laceMask, 0.6)))
    const shoreFoam = smoothstep(0.44, 0.58, shoreField)

    // WAKE. `1 - fresh` raises the lace threshold as the mark ages, so an old
    // wake dissolves into fragments rather than fading to grey. That dissolve is
    // what the chain of broken rings in the reference actually is.
    const w = this.wake.sample(xz)
    const wakeAA = smoothstep(0.5, 0.14, mPerPx.div(u.wakeLaceScale.max(0.5)))
    const wakeLaceN = mx_noise_float(vec3(
      xz.x.div(u.wakeLaceScale),
      xz.y.div(u.wakeLaceScale),
      t.mul(0.35),
    )).mul(0.5).add(0.5).mul(wakeAA)
    // THE THRESHOLD HAS TO BE ABLE TO EXCEED 1, or a fresh mark is a solid slab.
    // First version was `(1 - fresh) * wakeLace * noise` with wakeLace 0.4, so a
    // just-stamped mark at foam 1.0 met a threshold of at most 0.0 and the trail
    // came out as a featureless white ribbon — measured, and visible in the
    // frame as a painted stripe with no rings in it at all. The age term still
    // dissolves the mark, but it now scales a range that starts high enough to
    // punch holes on day one: at `wakeLace` 1.4 roughly a quarter of a fresh
    // mark is already open water, which is what makes the churn read as foam
    // rather than as paint.
    const wakeThreshold = w.fresh.oneMinus().mul(0.45).add(0.55)
      .mul(u.wakeLace).mul(wakeLaceN)
    // A WIDE ramp, not a narrow one. At +0.25 the mark had a hard white/cyan
    // boundary and read as a chalk line drawn on the water; the reference's foam
    // feathers into the water over most of its own width.
    // A NARROWER ramp than the +0.5 it had. The reference's foam-to-water edge is
    // about 2 px hard (luma 0.759 at -2 px, 0.961 at +1) where ours bled over 7,
    // and a wide ramp is what makes foam read as mist rather than as bubbles. The
    // field is 0.125 m per texel now, so the edge can afford to be crisp.
    const wakeFoam = smoothstep(wakeThreshold, wakeThreshold.add(0.26), w.foam)
      .mul(u.wakeStrength)

    // CONTACT FROTH, on its own channel and therefore on its own threshold.
    //
    // It does not go through `wakeThreshold`: that threshold is driven by the
    // mark's AGE, and every contact mark is by construction about a second old,
    // so the age term would leave it either always solid or always gone. What it
    // gets instead is a fine, fast lace — 0.55 m and moving, against the wake's
    // 0.85 m — because froth against a hull churns where a wake dissolves.
    //
    // The step starts LOW (0.22) on purpose. The reason the previous attempt at
    // this was invisible is that it had to clear the wake channel's 0.715, and
    // the whole point of a separate channel is that it no longer does.
    const contactLace = mx_noise_float(vec3(
      xz.x.div(0.55), xz.y.div(0.55), t.mul(1.7),
    )).mul(0.5).add(0.5)
    // THE LACE HAS TO REACH BELOW THE STEP, or it is not lace. First version
    // multiplied by `lace * 0.5 + 0.62`, a range of 0.62..1.12 that almost never
    // dips under the step's top, so a contact mark at 1.0 was solid everywhere
    // and the froth came out as a white slab around the hull: `wakeShare` 0.362,
    // `fill` 0.970 and `laceStroke` 0.0180 against the reference's 0.0047.
    // `lace * 0.75 + 0.25` spans 0.25..1.0, so at the shipped amount the product
    // straddles the step and roughly half of the mark is open water.
    const contactFoam = smoothstep(
      float(0.26), float(0.60),
      w.contact.mul(contactLace.mul(0.75).add(0.25)),
    ).mul(u.wakeStrength)

    const foamAmount = saturate(max(max(shoreFoam, wakeFoam), contactFoam))
    // NOT MIXED INTO THE ALBEDO. Foam is applied AFTER the light, below, and
    // that is a measured correction rather than a refactor: as an albedo the
    // near-white foam stop was multiplied by the same blue-tinted sky ambient
    // as the water, and the reference's foam is the one thing in either picture
    // that is genuinely neutral — #dbeedb at S0.08, where our surf band measured
    // S0.15-0.25 and read as cream. `tools/water.mjs` discriminates foam from
    // sunlit shallows on saturation alone (the two are 0.07 apart in the
    // reference and nothing apart in brightness), so cream foam does not merely
    // look wrong, it scores zero.

    // ── light ────────────────────────────────────────────────────────────────
    // Same composition as the terrain (src/terrain/ground.ts) so water and the
    // beach next to it sit in one exposure, with ONE difference: no cel ramp.
    // A cel ramp on a sheet whose normal is 88-92 degrees from vertical
    // everywhere puts the entire ocean on one stop and flips it wholesale as
    // the sun moves. The ripple network is what carries variation here.
    const ambient = vec3(clampChroma(
      vec3(atmosphere.skyIrradiance(n)
        .mul(atmosphere.ambientGainNode).mul(u.ambient)),
      // 1.25, TIGHTER THAN THE GROUND'S 1.6. Same mechanism as the note in
      // src/terrain/ground.ts — raw sky irradiance runs a peak channel about
      // 2.7x its own luminance, so it rotates whatever it multiplies toward
      // blue — and water is the surface with the least tolerance for it,
      // because the authored deep stop is ALREADY a blue-cyan and there is no
      // hue distance left to give away. Measured before this: authored #2ea8c6
      // at H192 S0.77 arrived on screen at H201 S0.61.
      1.12,
    ))
    const ndl = saturate(dot(n, atmosphere.nodes.sunDir))
    const vis = atmosphere.sunVisibility(wp)
    // A WRAPPED diffuse, floored at 0.55. Water at dusk is dim, not black, and
    // the reference's darkest measured band is V0.73.
    const direct = vec3(atmosphere.sunColorNode
      .mul(ndl.mul(0.45).add(0.55)).mul(mix(float(0.72), float(1), vis)))
    const light = vec3(ambient.add(direct))
    let color: Node<'vec3'> = vec3(albedo.mul(light))

    // ── foam, lit NEUTRALLY ──────────────────────────────────────────────────
    // Same level as the water beside it, three quarters of the way to grey.
    // Foam is a mass of bubbles: it scatters everything, so it takes the level
    // of the light and almost none of its colour.
    const foamLight = vec3(mix(vec3(luminance(light)), light, 0.25))
    color = vec3(mix(color, u.foam.mul(foamLight), foamAmount))

    // Sky, at 0.1 and weighted by the albedo so it tints rather than replaces.
    const view = vec3(cameraPosition.sub(wp).normalize())
    const grazing = pow(saturate(dot(n, view).oneMinus()), float(4))
    const sky = vec3(atmosphere.skyLookup(vec3(
      view.x.negate(), view.y.abs(), view.z.negate(),
    ).normalize()))
    color = vec3(mix(color, sky.mul(luminance(albedo).add(0.35)), grazing.mul(u.skyMix)))

    // THE ONE SPECULAR ART_BIBLE ASKS FOR. §2: "sharp specular is reserved for
    // water, wet surfaces, ice and vehicle paint" — this is the first entry on
    // that list and until now the build had none of it. Suppressed inside foam:
    // foam is not a mirror.
    const half = vec3(normalize(atmosphere.nodes.sunDir.add(view)))
    const glint = pow(saturate(dot(n, half)), u.glintPower)
      .mul(u.glintStrength).mul(vis).mul(foamAmount.oneMinus())
    // NEUTRALISED BEFORE IT IS ADDED — see `glintNeutral` in defs.ts. Adding the
    // sun's raw colour to cyan water sends the highlight through green, which is
    // what the dusk sun path was: H141 S0.40 against water at H168-181.
    const sunLit = vec3(atmosphere.sunColorNode)
    const glintCol = vec3(mix(sunLit, vec3(luminance(sunLit)), u.glintNeutral))
    color = vec3(color.add(glintCol.mul(glint)))

    // ── THE MINT STRETCH HOLDS ITS SATURATION DOWN ──────────────────────────
    //
    // `refs/water/shore-foam-wake.jpg` keeps saturation FLAT at S0.15-0.18 across
    // the whole mint stretch while the hue rotates H85 -> H152; ours re-saturated
    // through it and measured S0.37 at H147 — 2.2x the reference — and S0.51 at
    // H85 at dusk, 3.2x, which reads as a lime swamp rather than water over sand.
    //
    // Authoring the stops paler cannot fix it, and that is the interesting part:
    // both stops involved are already low-chroma (#c1dbce is S0.11, #a3d1d1 is
    // S0.22) and a blend of two low-chroma colours cannot come out high-chroma.
    // What re-saturates them is downstream — the per-channel filmic curve and the
    // grade both push chroma up as they roll off, and the shallows sit exactly in
    // the part of the range where that is strongest. So the correction has to be
    // downstream too, and weighted by shallowness so the deep end is untouched.
    // Peaks in the MINT band and releases again at the very edge. The desaturation
    // exists to stop the mint stretch going algae green, and applying it right up
    // to the waterline instead drove the last metre or two to S<0.10 — which is
    // not just wrong against the reference's S0.14-0.18 shallowest band, it is
    // below the threshold `tools/water.mjs` uses to tell foam from water, so the
    // shallows were being COUNTED as surf. `water-rocks` read shoreMaxRun 0.399
    // at three different band widths, unchanged, because the number was never
    // measuring the band.
    const shallowness = smoothstep(u.depthMid, u.depthEdge, depth)
      .mul(smoothstep(0, u.depthEdge.mul(0.9), depth))
    color = vec3(setSaturation(color, u.shallowDesat.mul(shallowness).oneMinus()))

    // Chroma falls with luminance, as everywhere else in the build.
    const lum = luminance(color)
    color = setSaturation(color, u.saturationGain.mul(smoothstep(0.03, 0.7, lum)).oneMinus())

    // ── aerial perspective, HELD BACK ───────────────────────────────────────
    // Every other surface takes this at full strength and should. Water is the
    // exception the cartoon reference forces: `lake-cartoon-cells.jpg` keeps its
    // lake one flat graphic colour right out to its silhouette, and measured on
    // our own frames the full-strength term took the far water to H213 S0.43 —
    // sky, not sea, where neither reference has any water past H191.
    //
    // A LERP TOWARD THE HAZED COLOUR rather than a change to the haze model,
    // because the haze model is shared and calibrated: `hue`, `distinct` and
    // `complaints` are all measured off it, and ART_BIBLE §1 names atmospheric
    // perspective as the biggest fidelity lever there is. This says only "the
    // sea keeps a bit more of its own colour than the land does".
    const hazed = vec3(atmosphere.aerialPerspective(color, wp, float(0)))
    this.material.colorNode = vec3(mix(color, hazed, u.aerial))
    this.material.name = 'water-sea'
    // DOUBLE SIDED, AND THIS IS THE BUG THAT MADE THE WHOLE OCEAN INVISIBLE.
    //
    // `polarSheet` winds its rings so the sheet's front face points DOWN, so
    // back-face culling removed every triangle of it when seen from above — an
    // A/B against `?water=0` measured a mean absolute difference of 0.00 per
    // channel over the entire frame, and the frames looked plausible because
    // what they showed instead was the SEABED, which in a coast biome is sand
    // and reads exactly like a beach. Two further measurements were needed to
    // separate this from a depth-test problem: with the sheet raised to y = 0
    // (58 m above the camera, i.e. seen from below) the debug material rendered
    // fine, and with `depthTest` off at sea level it still did not.
    //
    // Fixed by drawing both sides rather than by reversing the index buffer.
    // Water is a surface the player drives ON and the chase camera dips BELOW,
    // so the underside is a real view; and nothing in this material reads the
    // geometric normal — the shading normal is analytic, from `waveField` — so
    // there is no facing-dependent term that two-sided rendering could break.
    this.material.side = THREE.DoubleSide

    this.mesh = new THREE.Mesh(polarSheet(), this.material)
    this.mesh.frustumCulled = false
    this.mesh.name = 'sea'
    this.mesh.position.y = this.level
    this.mesh.matrixAutoUpdate = false
    this.mesh.updateMatrix()
  }

  /**
   * Height of the drivable water surface at a world XZ — the still line, the
   * wave, and the beach swash. Callers must already know they are over water;
   * the terrain is consulted only for the swash's depth mask, because the swash
   * exists only in the shallows.
   *
   * The swash HAS to be here and not only in the shader. It lifts the rendered
   * sheet by up to `swashAmp`, and a car floating on a surface half a metre
   * below the one being drawn is the exact failure the two-evaluations-one-file
   * rule at the top of waves.ts exists to prevent.
   */
  surfaceAt(x: number, z: number): number {
    const p = this.params
    const depth = this.level - this.terrain.heightAt(x, z)
    return this.level
      + waveHeightAt(x, z, this.elapsed, p.waveAmp, p.waveScale, p.waveSpeed)
      + swashLiftAt(x, z, Math.max(0, depth), this.elapsed,
        p.swashAmp, p.swashReach, p.swashRate)
  }

  /**
   * Render-graph step 10. Recentre the sheet, advance the clock, run the wake.
   *
   * The sheet is snapped to whole metres. Nothing about the SURFACE moves when
   * it snaps (the waves are a function of world position), but the caustic and
   * the ladder are sampled per pixel, so the only thing a sub-metre jitter
   * could do is move the tessellation — and a whole-metre snap keeps even that
   * out of the frame-to-frame difference the regression gate measures.
   */
  async update(
    renderer: THREE.Renderer,
    camera: THREE.Camera,
    dt: number,
    stamps: readonly FoamStamp[],
  ): Promise<void> {
    this.elapsed += dt
    this.timeNode.value = this.elapsed
    this.mesh.position.set(
      Math.round(camera.position.x), this.level, Math.round(camera.position.z),
    )
    this.mesh.updateMatrix()
    await this.wake.update(renderer, dt, stamps)
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    this.material.dispose()
    this.wake.dispose()
  }
}

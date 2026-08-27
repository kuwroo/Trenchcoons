// The world, assembled. (Was `greybox.ts`; the greybox is gone.)
//
// WHAT THIS FILE USED TO BE. An M1 greybox: one 8 km plane at 19 m quads, five
// hand-scattered instance sets of icosahedra and cones, a 380 m sand shelf, a
// lagoon, and a finely tessellated "sand pan" that existed because it was the
// only surface in the build with the resolution to show a tyre mark. Every one
// of the user's five reports traces back to something in that list.
//
// WHAT IT IS NOW. An assembler. Nothing here generates terrain, scatter or
// grass; it wires together
//
//   src/terrain/world.ts     the heightfield and the climate classification
//   src/terrain/clipmap.ts   the mesh, 0.55 m cells wherever the camera is
//   src/terrain/ground.ts    the clean biome-splatted ground material
//   src/world/scatter.ts     biome scatter, from the modeller's library
//   src/world/grass.ts       instanced grass, from the modeller's blade assets
//
// …and keeps the three things that are genuinely world-level: the lagoon, the
// distant skyline, and spawn validation.
//
// THE SAND PAN IS GONE, deliberately. It was a workaround for a mesh that could
// not resolve a rut, and the clipmap resolves ruts everywhere. Its response —
// wet sand, the sharpest marks in the game — is now reachable the way every
// other surface is, by being in that biome.

import * as THREE from 'three/webgpu'
import type { Atmosphere } from '../atmosphere/sky'
import type { WindField } from '../atmosphere/wind'
import { PainterlyMaterial, type DeformHook } from '../material/painterly'
import { surface } from '../material/defs'
import { ScatterLibrary } from '../assets'
import { TerrainWorld, LAGOON, type BiomeId } from '../terrain/world'
import { TerrainClipmap } from '../terrain/clipmap'
import { GroundMaterial } from '../terrain/ground'
import { Scatter, type Obstacle, type SolidInstance } from './scatter'
import { Grass } from './grass'
import { graded } from './surfaceGrade'

export type { Obstacle, SolidInstance }

export interface World {
  group: THREE.Group
  terrain: TerrainWorld
  scatter: Scatter
  grass: Grass
  /** The analytic heightfield. */
  heightAt: (x: number, z: number) => number
  /**
   * The height of the ground you can actually SEE.
   *
   * Identical to `heightAt` now, and that is the headline of the terrain
   * change. The greybox needed two functions because its ground was 19 m quads
   * and the drawn triangle sat up to 1.68 m away from the field it was sampled
   * from — two wheel diameters of buried or hovering. The clipmap's finest
   * cells are 0.55 m and the terrain's finest octave has a 46 m wavelength, so
   * the residual is sub-millimetre and the distinction has stopped existing.
   * Kept as a separate name because half the codebase asks for it by name and
   * the guarantee ("this is what is drawn") is still the one being made.
   */
  groundAt: (x: number, z: number) => number
  waterLevel: number
  spawnPoint: (x: number, z: number) => [number, number]
  materials: PainterlyMaterial[]
  /** Near solid forms. Mutated in place by the scatter as the camera moves. */
  obstacles: Obstacle[]
  /** Move the streaming systems. Cheap when nothing crossed a boundary. */
  recentre: (x: number, z: number, force?: boolean) => void
  /** Groups that must not be drawn into the shadow cascades. */
  shadowExcluded: THREE.Object3D[]
  dominantAt: (x: number, z: number) => BiomeId
}

export interface WorldOptions {
  /** `?biome=` — force one classification over the whole world. */
  forced?: BiomeId | null
}

export function buildWorld(
  atmosphere: Atmosphere,
  wind: WindField,
  deform: DeformHook | null,
  terrain: TerrainWorld,
  options: WorldOptions = {},
): World {
  void options
  const group = new THREE.Group()
  group.name = 'world'
  const materials: PainterlyMaterial[] = []
  const mat = (defId: string): THREE.MeshBasicNodeMaterial => {
    // Every world material goes through `graded`. See src/world/surfaceGrade.ts.
    const m = new PainterlyMaterial(atmosphere, graded(defId, surface(defId)))
    materials.push(m)
    return m.material
  }

  // ── the terrain ───────────────────────────────────────────────────────────
  // Two materials: the two finest clipmap levels take the deformation field's
  // VERTEX displacement, the rest do not. See `GroundOptions.relief`.
  const fine = new GroundMaterial(atmosphere, terrain, deform, { relief: true })
  const coarse = new GroundMaterial(atmosphere, terrain, deform, { relief: false })
  const clipmap = new TerrainClipmap(fine.material, coarse.material, (x, z) => terrain.heightAt(x, z))
  group.add(clipmap.group)

  // ── the lagoon ────────────────────────────────────────────────────────────
  // Kept from the greybox, and it earns its place twice: it is the only
  // saturated COOL mass in the palette (every round-1 frame was "one green hue
  // plus a pale sky"), and it is what gives the coast biome an edge to exist
  // along — ART_BIBLE §5, "Coast is the exception ... it appears wherever any
  // land biome meets the water."
  const water = mat('water')
  const sand = mat('sand')
  const shore = new THREE.Mesh(
    new THREE.CylinderGeometry(LAGOON.r * 0.86, LAGOON.r * 0.62, 6, 48), sand,
  )
  shore.position.set(LAGOON.x, terrain.waterLevel - 3.4, LAGOON.z)
  shore.frustumCulled = false
  shore.name = 'lagoon-shore'
  group.add(shore)

  const lagoon = new THREE.Mesh(
    new THREE.CylinderGeometry(LAGOON.r * 0.7, LAGOON.r * 0.55, 5, 48), water,
  )
  lagoon.position.set(LAGOON.x, terrain.waterLevel, LAGOON.z)
  lagoon.frustumCulled = false
  lagoon.name = 'lagoon'
  group.add(lagoon)

  // ── the skyline ──────────────────────────────────────────────────────────
  // There is no longer a skyline OBJECT. ART_BIBLE §1 names atmospheric
  // perspective as the biggest fidelity lever there is and a horizon needs
  // something on it, but the greybox met that with 130 instanced cones on a
  // ring around the world origin — correct only from the origin, and from
  // (3000, -2520) the camera stood inside the ring and the frame was two
  // 40-degree navy pyramids. The rim is now part of the heightfield itself
  // (`RIM_START` in src/terrain/world.ts): real terrain, shaded by the same
  // material as the ground under the wheels, hazed for free, and alpine at the
  // summits because the temperature lapse puts it there.

  // ── scatter and grass ─────────────────────────────────────────────────────
  const library = new ScatterLibrary(atmosphere)
  const scatter = new Scatter(atmosphere, terrain, library)
  group.add(scatter.group)
  const grass = new Grass(atmosphere, terrain, wind, library)
  group.add(grass.group)
  materials.push(...scatter.materials)

  const recentre = (x: number, z: number, force = false): void => {
    clipmap.update(x, z)
    scatter.update(x, z, force)
    grass.update(x, z, force)
  }
  recentre(0, 0, true)

  // ── spawn validation ──────────────────────────────────────────────────────
  // Unchanged in intent from the greybox: `pos=280,14,760` once put the kart
  // 84 m down inside the lagoon bowl with the chase camera in the pit beside
  // it, and both perf scenes then reported a healthy 60 fps for a picture of
  // nothing. The one difference is that the scatter is now streamed, so the
  // obstacle set has to be brought to the REQUEST before it can be consulted.
  const SPAWN = {
    freeboard: 2.5,
    /** Steepest ground a spawn may sit on, radians. 0.16 = 9 degrees: a spawn
     *  is where the PARKED captures happen. */
    maxSlope: 0.16,
    margin: 3.5,
    rings: [0, 9, 18, 30, 45, 64, 88, 120],
    perRing: 16,
  } as const

  const spawnPoint = (x: number, z: number): [number, number] => {
    recentre(x, z, true)
    let best: [number, number] = [x, z]
    let bestScore = -Infinity
    for (const r of SPAWN.rings) {
      const n = r === 0 ? 1 : SPAWN.perRing
      for (let i = 0; i < n; i++) {
        // Fixed angles, no RNG: the same request must always answer the same.
        const a = (i / n) * Math.PI * 2 + r * 0.37
        const px = x + Math.cos(a) * r
        const pz = z + Math.sin(a) * r
        // Water is a DISC, not a global plane: testing `height < waterLevel`
        // everywhere rejected a perfectly dry meadow 1.5 km away whose only
        // crime was sitting below the lagoon's surface height.
        const inLagoon = Math.hypot(px - LAGOON.x, pz - LAGOON.z) < LAGOON.r
        const depth = inLagoon
          ? terrain.heightAt(px, pz) - (terrain.waterLevel + SPAWN.freeboard)
          : 1
        const slope = terrain.slopeAt(px, pz)
        let clear = true
        for (const o of scatter.obstacles) {
          const rr = o.r + SPAWN.margin
          const dx = px - o.x
          const dz = pz - o.z
          if (dx * dx + dz * dz < rr * rr) { clear = false; break }
        }
        if (depth > 0 && slope < SPAWN.maxSlope && clear) { recentre(px, pz, true); return [px, pz] }
        const score = Math.min(depth, 0) * 3
          - Math.max(0, slope - SPAWN.maxSlope) * 40
          - (clear ? 0 : 25) - r * 0.02
        if (score > bestScore) { bestScore = score; best = [px, pz] }
      }
    }
    recentre(best[0], best[1], true)
    return best
  }

  return {
    group,
    terrain,
    scatter,
    grass,
    heightAt: (x, z) => terrain.heightAt(x, z),
    groundAt: (x, z) => terrain.heightAt(x, z),
    waterLevel: terrain.waterLevel,
    spawnPoint,
    materials,
    obstacles: scatter.obstacles,
    recentre,
    // Grass and distant scatter are excluded from the sun cascades. Grass
    // shadows at 0.4 m are below a cascade texel and cost four extra draws of
    // every blade in the frame; distant scatter casts into cascades whose
    // texels are metres across. Near scatter still casts, which is the shadow
    // that reads.
    shadowExcluded: [grass.group, scatter.farGroup, ...clipmap.shadowExcluded],
    dominantAt: (x, z) => terrain.dominantAt(x, z),
  }
}

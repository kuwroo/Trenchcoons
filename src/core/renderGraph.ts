// Central pass ordering. Render calls live here and nowhere else — a scattered
// render path is unreviewable, and the order below is load-bearing for the look.
//
//  1  atmosphere LUTs        7  depth prepass
//  2  wind field             8  opaque (terrain reads deform RT)
//  3  deformation stamp      9  sky + volumetric clouds
//  4  deformation decay     10  water
//  5  vegetation cull/LOD   11  transparent + particles
//  6  shadow cascades       12  post
//
// M0: the ordering exists and passes register into it; most are empty.

export type PassName =
  | 'atmosphereLUT' | 'windField' | 'deformStamp' | 'deformDecay'
  | 'vegetationCull' | 'shadow' | 'depthPrepass' | 'opaque'
  | 'sky' | 'water' | 'transparent' | 'post'

const ORDER: readonly PassName[] = [
  'atmosphereLUT', 'windField', 'deformStamp', 'deformDecay',
  'vegetationCull', 'shadow', 'depthPrepass', 'opaque',
  'sky', 'water', 'transparent', 'post',
]

export interface FrameCtx {
  dt: number
  elapsed: number
  frame: number
}

export type Pass = (ctx: FrameCtx) => void | Promise<void>

export class RenderGraph {
  private passes = new Map<PassName, Pass[]>()

  register(name: PassName, pass: Pass): void {
    if (!ORDER.includes(name)) throw new Error(`unknown pass: ${name}`)
    const list = this.passes.get(name) ?? []
    list.push(pass)
    this.passes.set(name, list)
  }

  /**
   * Passes that ACCUMULATE world state, as opposed to consuming it to make
   * pixels. Deformation marks are history — a capture at frame 1200 has to
   * simulate all 1200 frames or the marks are not there — but nothing in the
   * shadow, opaque, sky, water or post passes feeds back into that history.
   */
  private static readonly STATEFUL: readonly PassName[] = [
    'atmosphereLUT', 'windField', 'deformStamp', 'deformDecay',
  ]

  /**
   * @param stateOnly Run only the accumulating passes and skip everything that
   *   exists to produce pixels. For fast-forwarding a scripted replay to its
   *   capture frame: the deform stamp is a handful of quads, while the passes
   *   this skips are the entire cost of a frame. Only valid for frames that
   *   are NOT going to be screenshotted.
   */
  async run(ctx: FrameCtx, stateOnly = false): Promise<void> {
    for (const name of ORDER) {
      if (stateOnly && !RenderGraph.STATEFUL.includes(name)) continue
      const list = this.passes.get(name)
      if (!list) continue
      for (const p of list) await p(ctx)
    }
  }
}

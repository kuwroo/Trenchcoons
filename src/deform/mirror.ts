// The CPU-side mirror — consumer (3) of the deformation field.
//
// ARCHITECTURE: "Physics samples it for friction and rolling resistance...
// Consumer 3 is what makes this a mechanic rather than a decal system. It reads
// a CPU-side mirror updated by async readback — never block a frame on
// mapAsync."
//
// So: every few frames a small window of the near field around the car is
// pulled back with `readRenderTargetPixelsAsync`. The promise is NOT awaited in
// the frame path; whatever has arrived is what the physics sees, and a mirror
// two or three frames stale is invisible at 60 Hz because a rut does not move.
//
// THE ONE EXCEPTION IS SHOT MODE, and it is a determinism fix rather than a
// convenience. M0's contract is byte-identical PNGs across two runs. The
// vehicle reads this mirror through its height field, so if a readback lands on
// frame 7 in one run and frame 8 in the next, the car is in a different place
// when the harness captures and the two PNGs differ. Under `?shot=1` — fixed
// clock, no player, nothing on screen but the capture — the readback is
// therefore awaited at a fixed cadence, which pins it to a frame. Gameplay
// never waits.

import * as THREE from 'three/webgpu'
import { DEPTH_SCALE, NEAR_RES, NEAR_SPAN } from './field'
import type { DeformResponse } from './biome'

/** Texels per side of the mirrored window. 256 @ 8/m = a 32 m square. */
const WINDOW = 256
/** Frames between readback requests. The car covers 3.5 m in six frames at
 *  top speed, against a 16 m half-window. */
const EVERY = 6
const TEXELS_PER_M = NEAR_RES / NEAR_SPAN

/** Matches `DeformField.displace`'s spoil radius, in metres. */
const SPOIL_R = 0.42

export interface MirrorSample {
  /** Rut depth in metres, positive downward. */
  depth: number
  /** Disturbance, 0..1. Raw channel — the shader's edge shaping is cosmetic. */
  mask: number
  /** Wetness / compaction, 0..1. */
  wet: number
}

const EMPTY: MirrorSample = { depth: 0, mask: 0, wet: 0 }

/**
 * A window of the near field, on the CPU.
 *
 * Deliberately NOT a re-simulation of the stamps. A CPU copy of the stamping
 * maths would be a second implementation to keep in step with the first, and it
 * would not see the decay, the demoted committed marks, or anything else that
 * writes the field later (weather, in M8). Reading the actual texture is the
 * only version that cannot silently disagree with what the player can see.
 */
export class DeformMirror {
  private readonly data = new Uint8Array(WINDOW * WINDOW * 4)
  private readonly scratch = new Uint8Array(WINDOW * WINDOW * 4)
  /** Texel coordinates of the window's lower-left corner, unwrapped. */
  private originX = 0
  private originY = 0
  private valid = false
  private inFlight: Promise<void> | null = null
  private frame = 0

  constructor(private readonly rt: THREE.RenderTarget) {}

  /**
   * Render-graph tail. Issues a readback when one is due.
   *
   * @param blocking shot mode — see the header. Awaiting here is what makes the
   *   physics reproducible; it costs a stall the player never experiences.
   */
  async update(
    renderer: THREE.Renderer, cx: number, cz: number, blocking: boolean,
  ): Promise<void> {
    const due = this.frame % EVERY === 0
    this.frame++
    if (!due) return
    if (this.inFlight) {
      // Still waiting on the previous one. Skipping is the correct behaviour:
      // queueing a second readback would grow an unbounded backlog of stale
      // windows and every one of them would land out of order.
      if (!blocking) return
      await this.inFlight
    }
    const ox = Math.round(cx * TEXELS_PER_M) - WINDOW / 2
    const oy = Math.round(cz * TEXELS_PER_M) - WINDOW / 2
    const p = this.read(renderer, ox, oy)
    this.inFlight = p
    if (blocking) await p
  }

  private async read(renderer: THREE.Renderer, ox: number, oy: number): Promise<void> {
    try {
      // The window is toroidal, so it can straddle the wrap in either axis.
      // Split into at most four axis-aligned reads and reassemble.
      const x0 = ((ox % NEAR_RES) + NEAR_RES) % NEAR_RES
      const y0 = ((oy % NEAR_RES) + NEAR_RES) % NEAR_RES
      const wA = Math.min(WINDOW, NEAR_RES - x0)
      const hA = Math.min(WINDOW, NEAR_RES - y0)
      const parts: [number, number, number, number, number, number][] = [
        [x0, y0, wA, hA, 0, 0],
      ]
      if (wA < WINDOW) parts.push([0, y0, WINDOW - wA, hA, wA, 0])
      if (hA < WINDOW) parts.push([x0, 0, wA, WINDOW - hA, 0, hA])
      if (wA < WINDOW && hA < WINDOW) {
        parts.push([0, 0, WINDOW - wA, WINDOW - hA, wA, hA])
      }
      for (const [sx, sy, w, h, dx, dy] of parts) {
        const buf = await renderer.readRenderTargetPixelsAsync(this.rt, sx, sy, w, h)
        const src = buf as unknown as Uint8Array
        // ROWS COME BACK 256-BYTE ALIGNED, NOT TIGHTLY PACKED. WebGPU requires
        // `bytesPerRow` to be a multiple of 256 on a texture-to-buffer copy and
        // three obliges (`WebGPUTextureUtils.copyTextureToBuffer`: `bytesPerRow
        // = ceil(width * bytesPerTexel / 256) * 256`), then hands the padded
        // buffer straight back. Assuming `row * w * 4` is therefore only
        // correct when the read is 64 texels wide or a multiple of it.
        //
        // The unsplit window is 256 wide and 1024 bytes a row, which is why
        // this was invisible: the bug is in the WRAP SPLIT, whose sub-rect
        // widths are whatever the car's position makes them. A window at
        // x0 = 1960 reads 88 texels wide, assumes a 352-byte stride against an
        // actual 512, and hands the physics a field skewed by 40 texels a row —
        // silently, because every offset stays inside the buffer. About an
        // eighth of x positions and an eighth of z positions do this, so
        // roughly a quarter of the world grid was affected. The three SHORT
        // captures cannot see it — the pan sits at x0 = 294 / y0 = 1004 and a
        // 70 m run never leaves one unsplit window — but `tracks-persist`
        // drives a 300 m loop, which is longer than the 256 m period at which
        // the window wraps, so it crosses the split path in both axes and its
        // PNG moves when this is wrong. That is the regression tripwire.
        //
        // The last row is short — three sizes the buffer as
        // `(h - 1) * stride + w * 4`, not `h * stride` — so the copy is clamped
        // rather than sliced blind.
        const stride = Math.ceil(w * 4 / 256) * 256
        for (let row = 0; row < h; row++) {
          const from = row * stride
          const to = ((dy + row) * WINDOW + dx) * 4
          this.scratch.set(src.subarray(from, Math.min(from + w * 4, src.length)), to)
        }
      }
      this.data.set(this.scratch)
      this.originX = ox
      this.originY = oy
      this.valid = true
    } catch {
      // A readback can fail while the device is being lost or resized. The
      // physics falling back to "pristine ground" is the right failure: the car
      // drives as though the marks were not there, which is exactly how it
      // drove before M4.
    } finally {
      this.inFlight = null
    }
  }

  /** Bilinear sample of the mirrored window. Pristine outside it. */
  sample(x: number, z: number): MirrorSample {
    if (!this.valid) return EMPTY
    const fx = x * TEXELS_PER_M - 0.5 - this.originX
    const fy = z * TEXELS_PER_M - 0.5 - this.originY
    if (fx < 0 || fy < 0 || fx > WINDOW - 2 || fy > WINDOW - 2) return EMPTY
    const ix = Math.floor(fx)
    const iy = Math.floor(fy)
    const tx = fx - ix
    const ty = fy - iy
    const d = this.data
    let depth = 0
    let mask = 0
    let wet = 0
    for (let j = 0; j < 2; j++) {
      for (let i = 0; i < 2; i++) {
        const w = (i ? tx : 1 - tx) * (j ? ty : 1 - ty)
        const o = ((iy + j) * WINDOW + (ix + i)) * 4
        depth += (d[o] ?? 0) * w
        mask += (d[o + 1] ?? 0) * w
        wet += (d[o + 2] ?? 0) * w
      }
    }
    return { depth: (depth / 255) * DEPTH_SCALE, mask: mask / 255, wet: wet / 255 }
  }

  /**
   * Signed vertical displacement in metres, negative down.
   *
   * The same expression `DeformField.displace` evaluates on the GPU, spoil
   * included. They have to agree: if the shader draws a rut the physics cannot
   * feel, the car floats over a visible trench, and if the physics feels one
   * the shader does not draw, the car sinks into flat ground.
   */
  displacement(x: number, z: number): number {
    if (!this.valid) return 0
    const here = this.sample(x, z).depth
    const ring = (
      this.sample(x + SPOIL_R, z).depth + this.sample(x - SPOIL_R, z).depth
      + this.sample(x, z + SPOIL_R).depth + this.sample(x, z - SPOIL_R).depth
    ) * 0.25
    return -here + Math.max(0, ring - here) * 0.5
  }
}

/** Per-wheel handling penalty from the mark the wheel is standing in. */
export interface WheelDrag {
  /** Longitudinal deceleration, m/s². */
  drag: number
  /** Extra lateral damping, 1/s. Positive means the rut is holding the car in
   *  line; a slick rut (grip < 1) contributes none. */
  latDamp: number
}

/**
 * Turn a mirror sample into handling.
 *
 * Two effects, both authored per biome in `BIOMES`:
 *
 *  - ROLLING RESISTANCE scales with the mask AND with how deep the wheel is
 *    sitting. Cruising over a scuff costs almost nothing; ploughing a
 *    full-depth snow rut costs 3.2 m/s², which against the 60 m/s² of drive
 *    the car has is a real, felt tax.
 *  - RUT TRACKING. A wet-sand or grass rut has walls and they steer you; a snow
 *    rut is slick and does not. That is the `grip` column, and it is why
 *    driving in your own rut is not simply "slower".
 */
export function wheelDrag(s: MirrorSample, r: DeformResponse): WheelDrag {
  if (s.mask <= 0.01) return { drag: 0, latDamp: 0 }
  const depthFrac = Math.min(1, s.depth / Math.max(r.maxDepth, 1e-3))
  const bite = s.mask * (0.35 + 0.65 * depthFrac)
  return {
    drag: r.drag * bite,
    // TWO-SIDED, around 1.0 rather than clamped at 0.88.
    //
    // `Math.max(0, r.grip - 0.88)` made the parameter inert for four of the
    // seven biomes: snow (0.80), mud (0.86) and forest (0.88) all produced
    // EXACTLY zero, so a slick rut was indistinguishable from pristine ground
    // laterally and the system could only ever ADD lateral hold. That is the
    // wrong way round for the one biome MILESTONES M4's done-when names —
    // "driving in your own rut feels different from fresh snow" — where the
    // whole point is that the rut is slicker than the ground beside it. The
    // `grip` docstring says "<1 = the rut is slick"; now it is.
    //
    // Sign convention: positive damps the lateral velocity (a wet-sand rut has
    // walls and they steer you), negative RELEASES it. See `applyToVehicle`
    // for why the two sides are not applied symmetrically.
    // 18, not the 6 the one-sided version used: the pivot moved from 0.88 to
    // 1.0, so the same authored table now produces a third of the coefficient
    // it used to. 18 restores wet sand's hold to the 1.08 /s it was tuned at
    // and leaves the RATIOS between biomes exactly as the table authors them.
    latDamp: (r.grip - 1) * bite * 18,
  }
}

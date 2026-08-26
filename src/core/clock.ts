// Deterministic clock. In shot mode the frame delta is fixed so a given frame
// index always produces an identical world state.

export class Clock {
  /** Seconds since start. */
  elapsed = 0
  /** Seconds since last frame, clamped. */
  delta = 0
  frame = 0

  private last = 0
  private readonly fixed: number | null

  constructor(opts: { fixedDelta?: number | null } = {}) {
    this.fixed = opts.fixedDelta ?? null
  }

  tick(nowMs: number): void {
    if (this.fixed !== null) {
      this.delta = this.fixed
    } else {
      const dt = this.last === 0 ? 1 / 60 : (nowMs - this.last) / 1000
      // Clamp: a tab-switch stall must not teleport the vehicle through terrain.
      this.delta = Math.min(dt, 1 / 15)
    }
    this.last = nowMs
    this.elapsed += this.delta
    this.frame++
  }
}

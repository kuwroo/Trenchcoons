// Perf budget is 16.6ms @ 1080p, <1500 draw calls, <400MB GPU memory.
// It erodes silently if nothing shows it.

export class PerfHud {
  private el = document.getElementById('hud') as HTMLDivElement
  private samples: number[] = []
  private lastPaint = 0
  lines: Record<string, string> = {}

  update(dtMs: number, info: { drawCalls: number; triangles: number }, now: number): void {
    this.samples.push(dtMs)
    if (this.samples.length > 90) this.samples.shift()
    if (now - this.lastPaint < 200) return
    this.lastPaint = now

    const sorted = [...this.samples].sort((a, b) => a - b)
    const p50 = sorted[Math.floor(sorted.length * 0.5)] ?? 0
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0
    const over = p50 > 16.6 ? '  OVER BUDGET' : ''

    const extra = Object.entries(this.lines).map(([k, v]) => `${k.padEnd(9)} ${v}`)
    this.el.textContent = [
      `fps       ${(1000 / Math.max(p50, 0.001)).toFixed(0)}`,
      `frame     ${p50.toFixed(2)}ms  p95 ${p95.toFixed(2)}ms${over}`,
      `draws     ${info.drawCalls}${info.drawCalls > 1500 ? '  OVER BUDGET' : ''}`,
      `tris      ${(info.triangles / 1000).toFixed(0)}k`,
      ...extra,
    ].join('\n')
  }
}

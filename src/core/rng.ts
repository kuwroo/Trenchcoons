// Seeded RNG. No Math.random() anywhere in generation — determinism is what
// makes the screenshot harness meaningful (see CLAUDE.md invariants).

/** mulberry32 — small, fast, good enough distribution for scatter/jitter. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Deterministic hash of a string to a u32 seed, so seeds can be readable. */
export function hashSeed(s: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export class Rng {
  /** u32 seed this stream was constructed from. Terrain, scatter and grass
   *  fold it into their spatial hashes so `?seed=` changes the whole map. */
  readonly seed: number
  private next: () => number
  constructor(seed: number | string) {
    this.seed = (typeof seed === 'string' ? hashSeed(seed) : seed) >>> 0
    this.next = mulberry32(this.seed)
  }
  float(): number { return this.next() }
  range(lo: number, hi: number): number { return lo + this.next() * (hi - lo) }
  int(lo: number, hi: number): number { return Math.floor(this.range(lo, hi + 1)) }
  pick<T>(arr: readonly T[]): T {
    if (arr.length === 0) throw new Error('Rng.pick on empty array')
    return arr[Math.floor(this.next() * arr.length)]!
  }
  /** Derive an independent stream — keeps callers from sharing state. */
  fork(tag: string): Rng { return new Rng(hashSeed(tag + ':' + this.next())) }
}

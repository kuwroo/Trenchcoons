// Any world state must be reproducible from a URL, or agent-driven visual
// iteration is unverifiable. See ARCHITECTURE "Determinism and the agent loop".

export type Weather = 'clear' | 'rain' | 'snow' | 'fog' | 'storm'

export interface WorldState {
  seed: string
  /** Camera / player position. */
  pos: [number, number, number]
  /** Camera yaw, pitch in radians. */
  look: [number, number]
  /** Time of day, 0..1 — 0.25 sunrise, 0.5 noon. */
  time: number
  weather: Weather
  /** Force a biome under the player, bypassing climate classification. */
  biome: string | null
  /** Fixed-timestep + frame-count mode for reproducible captures. */
  shot: boolean
  /** Frames to advance before the ready promise resolves (shot mode). */
  warmup: number
  freeCam: boolean
}

const DEFAULTS: WorldState = {
  seed: 'trenchcoons',
  pos: [0, 12, 40],
  look: [0, -0.18],
  time: 0.36,          // mid-morning — the hero state per ART_BIBLE §8
  weather: 'clear',
  biome: null,
  shot: false,
  warmup: 12,
  freeCam: false,
}

function nums(s: string | null, n: number): number[] | null {
  if (!s) return null
  const p = s.split(',').map(Number)
  return p.length === n && p.every(Number.isFinite) ? p : null
}

export function readUrlState(search = location.search): WorldState {
  const q = new URLSearchParams(search)
  const pos = nums(q.get('pos'), 3)
  const look = nums(q.get('look'), 2)
  // `Number(null)` is 0, and 0 IS FINITE. Reading these as
  // `Number(q.get('time'))` and testing `Number.isFinite` therefore accepted
  // the absence of the parameter as the value zero, so every URL without an
  // explicit `time=` ran at tod 0.000 — midnight, sun 56.7 degrees BELOW the
  // horizon — instead of the mid-morning hero hour ART_BIBLE §8 specifies as
  // the default. `npm run dev`, `npm run perf`'s driving scene and the
  // acceptance test's HUD read were all doing this. Same bug, same line, for
  // `warmup`, which silently became 0 and let captures race the streaming
  // system the warmup exists to settle.
  const timeRaw = q.get('time')
  const warmupRaw = q.get('warmup')
  const time = timeRaw === null ? Number.NaN : Number(timeRaw)
  const warmup = warmupRaw === null ? Number.NaN : Number(warmupRaw)
  return {
    seed: q.get('seed') ?? DEFAULTS.seed,
    pos: (pos as [number, number, number]) ?? DEFAULTS.pos,
    look: (look as [number, number]) ?? DEFAULTS.look,
    time: Number.isFinite(time) ? ((time % 1) + 1) % 1 : DEFAULTS.time,
    weather: (q.get('weather') as Weather | null) ?? DEFAULTS.weather,
    biome: q.get('biome'),
    shot: q.has('shot'),
    warmup: Number.isFinite(warmup) ? warmup : DEFAULTS.warmup,
    freeCam: q.has('freeCam'),
  }
}

export function writeUrlState(s: Partial<WorldState>): string {
  const q = new URLSearchParams()
  if (s.seed) q.set('seed', s.seed)
  if (s.pos) q.set('pos', s.pos.map((n) => n.toFixed(1)).join(','))
  if (s.look) q.set('look', s.look.map((n) => n.toFixed(3)).join(','))
  if (s.time !== undefined) q.set('time', s.time.toFixed(3))
  if (s.weather && s.weather !== 'clear') q.set('weather', s.weather)
  if (s.biome) q.set('biome', s.biome)
  return '?' + q.toString()
}

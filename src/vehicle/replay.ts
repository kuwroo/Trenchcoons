// Deterministic motion capture.
//
// A screenshot cannot show motion, so none of M3's animation requirements are
// verifiable without this: a fixed input sequence, applied on the deterministic
// clock, captured at a named frame. `?drive=throttle:0-120,steer:40-120&frame=90`
// is a reproducible pose, frame-exact, from a URL — which is the same contract
// the rest of the project runs on (ARCHITECTURE, "Determinism and the agent
// loop").
//
// Grammar:
//
//   drive   := segment (',' segment)*
//   segment := channel (':' from '-' to)? ('@' value)?
//   channel := throttle | brake | steer | steerLeft | handbrake
//
// Frames are inclusive of `from`, exclusive of `to`, and count from the first
// simulated frame. Omitting the range means "the whole run". `@value` overrides
// the channel's default magnitude, so `steer:30-200@0.55` is a half-lock turn.
// Channels sum, so `throttle:0-200,brake:120-140` is a lift-and-brake.
//
//   ?drive=                       parked, idle layer running
//   ?drive=throttle:0-90          launch
//   ?drive=throttle:0-300,steer:40-300
//                                 accelerate then turn in
//   ?frame=90                     resolve `__ready` at frame 90 and freeze
//   ?camyaw=0.8&camarm=0.72       CAPTURE ONLY: swing the chase arm round to a
//                                 3/4 rear view and pull it in. Nothing in
//                                 gameplay sets these; see camera.ts.
//
// This runs on the SAME clock as the game (fixed 1/60 under `?shot=1`), so a
// frame index is a time in seconds and nothing here needs its own timeline.

import type { DriveInput, InputSource } from './input'
import type { ChaseFraming } from './camera'

export type DriveChannel = 'throttle' | 'brake' | 'steer' | 'steerLeft'

interface Segment {
  channel: DriveChannel
  from: number
  to: number
  value: number
}

const DEFAULT_VALUE: Record<DriveChannel, number> = {
  throttle: 1, brake: -1, steer: 1, steerLeft: -1,
}

const ALIASES: Record<string, DriveChannel> = {
  throttle: 'throttle', gas: 'throttle', accel: 'throttle',
  brake: 'brake', reverse: 'brake',
  steer: 'steer', right: 'steer', steerright: 'steer',
  steerleft: 'steerLeft', left: 'steerLeft', steerl: 'steerLeft',
}

export interface DriveScript {
  segments: Segment[]
  /** Last frame any segment touches. Diagnostic. */
  length: number
  raw: string
}

/**
 * Parse `drive`. Throws on anything it does not understand rather than
 * silently dropping it: a typo'd channel that quietly becomes "parked" would
 * produce a plausible-looking shot of the wrong thing, which is the most
 * expensive kind of failure in a screenshot-driven loop.
 */
export function parseDriveScript(raw: string | null): DriveScript | null {
  if (raw === null) return null
  const segments: Segment[] = []
  let length = 0
  for (const piece of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [body, valueRaw] = piece.split('@')
    const [nameRaw, range] = (body ?? '').split(':')
    const channel = ALIASES[(nameRaw ?? '').toLowerCase()]
    if (!channel) throw new Error(`drive: unknown channel "${nameRaw}" in "${piece}"`)
    let from = 0
    let to = Number.POSITIVE_INFINITY
    if (range !== undefined && range !== '') {
      const m = /^(\d+)-(\d+)$/.exec(range)
      if (!m) throw new Error(`drive: bad frame range "${range}" in "${piece}"`)
      from = Number(m[1])
      to = Number(m[2])
      if (to <= from) throw new Error(`drive: empty frame range "${range}"`)
      length = Math.max(length, to)
    }
    let value = DEFAULT_VALUE[channel]
    if (valueRaw !== undefined) {
      const v = Number(valueRaw)
      if (!Number.isFinite(v)) throw new Error(`drive: bad value "${valueRaw}"`)
      // `brake` and `steerLeft` are the negative-signed aliases, so an explicit
      // magnitude on them keeps its sign rather than flipping the channel.
      value = channel === 'brake' || channel === 'steerLeft' ? -Math.abs(v) : v
    }
    segments.push({ channel, from, to, value })
  }
  return { segments, length, raw }
}

/** Replays a parsed script against the deterministic frame counter. */
export class ScriptedInput implements InputSource {
  readonly label: string
  private readonly out: DriveInput = { steer: 0, throttle: 0, active: false }

  constructor(private readonly script: DriveScript) {
    this.label = `drive(${script.raw || 'parked'})`
  }

  sample(frame: number): DriveInput {
    let steer = 0
    let throttle = 0
    let active = false
    for (const s of this.script.segments) {
      if (frame < s.from || frame >= s.to) continue
      active = true
      if (s.channel === 'throttle' || s.channel === 'brake') throttle += s.value
      else steer += s.value
    }
    this.out.steer = Math.max(-1, Math.min(1, steer))
    this.out.throttle = Math.max(-1, Math.min(1, throttle))
    this.out.active = active
    return this.out
  }
}

export interface VehicleUrlOptions {
  /** Whether to build the car at all. */
  enabled: boolean
  /** Scripted input, or null for live keyboard. */
  script: DriveScript | null
  /** Frame at which `__ready` resolves, or null for the default warmup. */
  frame: number | null
  /** Spawn x, z. */
  spawn: [number, number] | null
  /** Spawn yaw, radians. Falls back to `look`'s yaw, which is unused in car
   *  mode because the chase camera owns the camera. */
  yaw: number | null
  /** CAPTURE-ONLY chase-camera framing. See `ChaseFraming` in camera.ts. */
  framing: ChaseFraming
}

/**
 * Read the vehicle's URL surface.
 *
 * Deliberately parsed here rather than folded into debug/urlState.ts: the M1
 * gate shots are pixel-compared through tools/regress.mjs against a best-ever
 * ledger, so the car must be OPT-IN under `?shot=1` — otherwise adding a
 * vehicle silently rewrites fifteen atmosphere and material baselines. Outside
 * shot mode it is opt-OUT, because this is a driving game and `npm run dev`
 * should hand you a car.
 */
export function readVehicleOptions(search = location.search): VehicleUrlOptions {
  const q = new URLSearchParams(search)
  const shot = q.has('shot')
  const script = parseDriveScript(q.get('drive'))
  const car = q.get('car')
  const asked = script !== null || (car !== null && car !== '0' && car !== 'false')
  const off = car === '0' || car === 'false' || q.has('freeCam')
  const frame = Number(q.get('frame'))
  const spawn = (q.get('spawn') ?? '').split(',').map(Number)
  const yaw = Number(q.get('caryaw'))
  const camyaw = Number(q.get('camyaw'))
  const camarm = Number(q.get('camarm'))
  return {
    enabled: off ? false : shot ? asked : true,
    script,
    frame: Number.isFinite(frame) && frame > 0 ? Math.floor(frame) : null,
    spawn: spawn.length === 2 && spawn.every(Number.isFinite)
      ? [spawn[0] as number, spawn[1] as number]
      : null,
    yaw: Number.isFinite(yaw) && q.has('caryaw') ? yaw : null,
    framing: {
      yaw: Number.isFinite(camyaw) && q.has('camyaw') ? camyaw : null,
      arm: Number.isFinite(camarm) && q.has('camarm') ? camarm : null,
    },
  }
}

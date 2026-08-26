// Engine audio. MILESTONES M3, "Engine audio, pitch by speed" — the one bullet
// of the milestone that had no implementation at all, and the reason M3's
// done-when ("each surface feels distinct to drive on WITHOUT LOOKING AT THE
// SCREEN") could not be claimed even in principle.
//
// Fully synthesised. There is no audio asset pipeline in this build and adding
// one for a single engine loop would be the wrong trade: a sampled loop needs
// a whole crossfaded RPM ladder to pitch convincingly, whereas an oscillator
// stack IS a pitch ladder. It is also ~2 kB and deterministic.
//
// Three layers, and each one is a different question the driver is asking:
//
//   engine   how hard am I working      three detuned saws, f0 by SPEED,
//                                        brightness by THROTTLE
//   tyres    what am I driving on       filtered noise, band by surface, gain
//                                        by speed
//   scrub    am I losing the back end   the same noise a fifth brighter, gain
//                                        by slipRatio
//
// The tyre layer is deliberately built around a per-surface parameter set even
// though the surface classifier is an M2 deliverable that does not exist yet:
// `setSurface` takes the id, everything downstream lerps, and when the splat
// map lands the only change here is who calls it. Getting that seam wrong later
// would mean rewriting the mixer.
//
// NOTHING IN HERE IS ALLOWED TO AFFECT THE SIMULATION. The whole module is
// skipped under `?shot=1`: a headless capture has no audio device, an
// AudioContext there would be suspended forever, and the screenshot harness
// must stay byte-identical.

import { Rng } from '../core/rng'
import { clamp, damp, saturate } from '../core/spring'
import type { VehicleTelemetry } from './vehicle'

/** How a surface sounds under a rolling tyre. */
interface SurfaceVoice {
  /** Centre of the tyre band, Hz. Loose grains are high, tarmac is low. */
  band: number
  /** Bandwidth as a Q. Low Q = broadband hiss, high Q = a pitched roar. */
  q: number
  /** Loudness of the rolling layer at top speed. */
  gain: number
  /** Extra loudness when the tyres let go. Snow says very little; road howls. */
  scrub: number
}

/**
 * Per-surface voices. Grass is the only one reachable today — the greybox is
 * one material — but the table is the point: M2's `classify()` will name these
 * ids, and M4's deformation feedback will move a wheel between them.
 */
const SURFACES: Record<string, SurfaceVoice> = {
  grass: { band: 900, q: 0.7, gain: 0.20, scrub: 0.45 },
  road: { band: 420, q: 1.4, gain: 0.13, scrub: 1.00 },
  sand: { band: 1700, q: 0.5, gain: 0.30, scrub: 0.55 },
  snow: { band: 620, q: 0.9, gain: 0.16, scrub: 0.22 },
  mud: { band: 300, q: 1.1, gain: 0.34, scrub: 0.30 },
  water: { band: 2400, q: 0.4, gain: 0.38, scrub: 0.40 },
}

const TUNE = {
  /** Engine fundamental at a standstill and at `FEEL.maxSpeed`, Hz. */
  idleHz: 41,
  redlineHz: 196,
  /**
   * How much of the pitch comes from ROAD SPEED rather than from engine load.
   *
   * A real gearbox steps the ratio, so pitch sawtooths as it climbs. This has
   * one ratio and instead borrows the trick every arcade racer uses: most of
   * the pitch tracks speed, and a slice of it tracks throttle, so stamping the
   * pedal at a constant 30 m/s still lifts the note. Without that second term
   * the engine is a speedometer, not an engine.
   */
  throttleHz: 26,
  /** Seconds for the note to follow a change in speed. Flywheel inertia. */
  revHalfLife: 0.11,
  /** Master level. Deliberately quiet: this is a cardboard box. */
  master: 0.5,
} as const

/** Three-oscillator engine + two noise layers, all synthesised. */
export class EngineAudio {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private readonly oscs: OscillatorNode[] = []
  private engineGain: GainNode | null = null
  private engineFilter: BiquadFilterNode | null = null
  private tyreFilter: BiquadFilterNode | null = null
  private tyreGain: GainNode | null = null
  private scrubFilter: BiquadFilterNode | null = null
  private scrubGain: GainNode | null = null
  private started = false
  private revs = 0
  private voice: SurfaceVoice = SURFACES['grass'] as SurfaceVoice
  private disposers: (() => void)[] = []

  /**
   * Arm the context on the first user gesture.
   *
   * Not optional and not a nicety: every browser refuses to start an
   * AudioContext outside a gesture, and one created eagerly lands in
   * `suspended` and stays there even after the player starts driving. Wiring it
   * to the same keys that drive the car means the engine starts on the first
   * throttle input, which is also when it should.
   */
  arm(): void {
    if (this.started) return
    const start = (): void => { void this.begin() }
    for (const ev of ['keydown', 'pointerdown'] as const) {
      addEventListener(ev, start, { once: true })
      this.disposers.push(() => removeEventListener(ev, start))
    }
  }

  private async begin(): Promise<void> {
    if (this.started) return
    this.started = true
    const Ctor = window.AudioContext
    if (!Ctor) return
    const ctx = new Ctor()
    this.ctx = ctx
    if (ctx.state === 'suspended') await ctx.resume()

    const master = ctx.createGain()
    master.gain.value = 0
    master.connect(ctx.destination)
    this.master = master

    // ── engine: three saws a beat apart ────────────────────────────────────
    // Detuning by a few cents is what turns one oscillator (a test tone) into
    // an engine: the beating between them IS the lumpiness of combustion.
    const engineFilter = ctx.createBiquadFilter()
    engineFilter.type = 'lowpass'
    engineFilter.frequency.value = 700
    engineFilter.Q.value = 0.9
    const engineGain = ctx.createGain()
    engineGain.gain.value = 0
    engineFilter.connect(engineGain).connect(master)
    for (const [mult, detune, level] of [
      [1, -7, 0.55], [2, 5, 0.3], [3, -11, 0.15],
    ] as const) {
      const o = ctx.createOscillator()
      o.type = 'sawtooth'
      o.frequency.value = TUNE.idleHz * mult
      o.detune.value = detune
      const g = ctx.createGain()
      g.gain.value = level
      o.connect(g).connect(engineFilter)
      o.start()
      this.oscs.push(o)
    }
    this.engineFilter = engineFilter
    this.engineGain = engineGain

    // ── tyres and scrub: one seeded noise buffer, two bandpasses ───────────
    // CLAUDE.md forbids `Math.random` in generation, and a noise buffer is
    // generation: two runs of the game must produce the same buffer.
    const rng = new Rng('engine-tyre-noise')
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = rng.range(-1, 1)
    const noise = ctx.createBufferSource()
    noise.buffer = buf
    noise.loop = true

    const tyreFilter = ctx.createBiquadFilter()
    tyreFilter.type = 'bandpass'
    tyreFilter.frequency.value = this.voice.band
    tyreFilter.Q.value = this.voice.q
    const tyreGain = ctx.createGain()
    tyreGain.gain.value = 0
    noise.connect(tyreFilter).connect(tyreGain).connect(master)

    const scrubFilter = ctx.createBiquadFilter()
    scrubFilter.type = 'bandpass'
    scrubFilter.frequency.value = this.voice.band * 1.5
    scrubFilter.Q.value = 2.2
    const scrubGain = ctx.createGain()
    scrubGain.gain.value = 0
    noise.connect(scrubFilter).connect(scrubGain).connect(master)
    noise.start()

    this.tyreFilter = tyreFilter
    this.tyreGain = tyreGain
    this.scrubFilter = scrubFilter
    this.scrubGain = scrubGain
  }

  /** Pick the voice the tyres are rolling on. M2's classifier will call this. */
  setSurface(id: string): void {
    this.voice = SURFACES[id] ?? (SURFACES['grass'] as SurfaceVoice)
  }

  /**
   * Drive the mixer from this frame's telemetry.
   *
   * Every parameter is written with `setTargetAtTime`, never assigned: a bare
   * assignment steps the value at a block boundary and a stepped gain or
   * frequency is an audible click on every frame. The 0.02 s constant is the
   * audio-rate equivalent of the springs everything visual goes through.
   */
  update(dt: number, t: VehicleTelemetry, throttle: number, maxSpeed: number): void {
    const ctx = this.ctx
    if (!ctx || !this.master) return
    const now = ctx.currentTime
    const set = (p: AudioParam, v: number, tau = 0.02): void => {
      p.setTargetAtTime(v, now, tau)
    }

    const speedNorm = saturate(t.speed / maxSpeed)
    const load = saturate(Math.abs(throttle))
    // Revs lag the road speed. A flywheel is an exponential, not a spring: it
    // has no restoring force and must never overshoot into a note the car is
    // not making.
    this.revs = damp(this.revs, speedNorm, TUNE.revHalfLife, dt)

    const f0 = TUNE.idleHz
      + (TUNE.redlineHz - TUNE.idleHz) * this.revs
      + TUNE.throttleHz * load
    for (let i = 0; i < this.oscs.length; i++) {
      set(this.oscs[i]!.frequency, f0 * (i + 1), 0.03)
    }
    // Brightness, not loudness, is what an engine under load actually does:
    // opening the throttle lets the harmonics through.
    if (this.engineFilter) {
      set(this.engineFilter.frequency, 380 + 2600 * load + 900 * this.revs, 0.05)
    }
    // Airborne the engine is unloaded, so it flares slightly and quietens.
    const air = t.airborne ? 0.55 : 1
    if (this.engineGain) {
      set(this.engineGain.gain, (0.05 + 0.16 * load + 0.07 * this.revs) * air)
    }

    // Tyres: a rolling band whose gain follows speed, and a brighter scrub
    // layer that only speaks when the car is actually sliding.
    const v = this.voice
    const contact = saturate(t.contacts / 4)
    if (this.tyreFilter) set(this.tyreFilter.frequency, v.band + 700 * speedNorm, 0.06)
    if (this.tyreGain) set(this.tyreGain.gain, v.gain * speedNorm * contact)
    if (this.scrubFilter) set(this.scrubFilter.frequency, v.band * 1.5, 0.06)
    if (this.scrubGain) {
      const slide = saturate((Math.abs(t.slipRatio) - 0.06) / 0.3)
      set(this.scrubGain.gain, v.scrub * slide * speedNorm * contact * 0.35)
    }

    // Landing thump: the same impact velocity the squash spring and the camera
    // FOV are kicked with, so the three land on the same frame.
    if (t.landingImpact > 0) this.thump(t.landingImpact);

    set(this.master.gain, TUNE.master, 0.08)
  }

  /** A short filtered noise burst. The box hitting the ground. */
  private thump(impact: number): void {
    const ctx = this.ctx
    if (!ctx || !this.master) return
    const now = ctx.currentTime
    const o = ctx.createOscillator()
    o.type = 'triangle'
    o.frequency.setValueAtTime(120, now)
    o.frequency.exponentialRampToValueAtTime(38, now + 0.16)
    const g = ctx.createGain()
    const peak = clamp(impact / 22, 0.05, 1) * 0.5
    g.gain.setValueAtTime(peak, now)
    g.gain.exponentialRampToValueAtTime(0.0005, now + 0.22)
    o.connect(g).connect(this.master)
    o.start(now)
    o.stop(now + 0.24)
  }

  dispose(): void {
    for (const d of this.disposers) d()
    this.disposers.length = 0
    for (const o of this.oscs) o.stop()
    void this.ctx?.close()
    this.ctx = null
  }
}

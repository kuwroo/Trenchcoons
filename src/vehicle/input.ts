// Couch co-op input. CLAUDE.md: "Two players, one keyboard, one car. P1 steers
// with A/D; P2 throttles and brakes with Up/Down. This is the hook, not a
// fallback."
//
// The single-player mapping gives one person all four axes (WASD *and* the
// arrows), because a solo dev iterating on vehicle feel should not need a second
// pair of hands — but it is the fallback, and the hint overlay says so by
// listing the two player rows first.

/** Normalised driver demand. Everything downstream reads only this. */
export interface DriveInput {
  /** -1 full left .. +1 full right. */
  steer: number
  /** +1 full throttle .. -1 full brake/reverse. */
  throttle: number
  /** True while either player is touching anything. Kills the idle layer. */
  active: boolean
}

export const NEUTRAL: DriveInput = { steer: 0, throttle: 0, active: false }

export interface InputSource {
  readonly label: string
  /** `frame` is the deterministic clock frame, for scripted sources. */
  sample(frame: number): DriveInput
}

const STEER_LEFT = ['KeyA', 'ArrowLeft']
const STEER_RIGHT = ['KeyD', 'ArrowRight']
const THROTTLE_UP = ['ArrowUp', 'KeyW']
const THROTTLE_DOWN = ['ArrowDown', 'KeyS']

export class KeyboardInput implements InputSource {
  readonly label = 'keyboard'
  private readonly held = new Set<string>()
  private readonly out: DriveInput = { steer: 0, throttle: 0, active: false }

  constructor(target: EventTarget = window) {
    const down = (e: Event): void => {
      const k = (e as KeyboardEvent).code
      if (this.owns(k)) {
        this.held.add(k)
        // Arrow keys scroll the page otherwise, which on a short viewport
        // shifts the canvas and makes the game look like it stuttered.
        e.preventDefault()
      }
    }
    const up = (e: Event): void => { this.held.delete((e as KeyboardEvent).code) }
    target.addEventListener('keydown', down)
    target.addEventListener('keyup', up)
    // A blur mid-press otherwise leaves the throttle stuck open forever.
    addEventListener('blur', () => this.held.clear())
  }

  private owns(code: string): boolean {
    return STEER_LEFT.includes(code) || STEER_RIGHT.includes(code)
      || THROTTLE_UP.includes(code) || THROTTLE_DOWN.includes(code)
  }

  private axis(neg: readonly string[], pos: readonly string[]): number {
    const n = neg.some((k) => this.held.has(k)) ? 1 : 0
    const p = pos.some((k) => this.held.has(k)) ? 1 : 0
    return p - n
  }

  sample(): DriveInput {
    this.out.steer = this.axis(STEER_LEFT, STEER_RIGHT)
    this.out.throttle = this.axis(THROTTLE_DOWN, THROTTLE_UP)
    this.out.active = this.held.size > 0
    return this.out
  }
}

/**
 * The on-screen binding hint.
 *
 * Built in JS rather than in index.html for one reason: it must not exist at
 * all in a capture. The gates diff PNGs against refs/, and two lines of white
 * monospace in the corner would poison palette, hue and structure on every
 * shot.
 */
export function mountControlHint(): HTMLElement | null {
  if (document.body.classList.contains('shot')) return null
  const el = document.createElement('div')
  el.id = 'controls'
  el.style.cssText = [
    'position:fixed', 'right:10px', 'bottom:10px', 'z-index:10',
    'font:11px/1.5 ui-monospace,Menlo,monospace', 'color:#e6f2f8',
    'background:#0b0d10a8', 'padding:7px 10px', 'border-radius:5px',
    'white-space:pre', 'pointer-events:none', 'backdrop-filter:blur(6px)',
    'text-align:right',
  ].join(';')
  el.textContent = [
    'P1  A / D        steer',
    'P2  Up / Down    throttle · brake',
    'solo  W A S D  or  arrows',
    'LMB drag         orbit camera',
  ].join('\n')
  document.body.appendChild(el)
  return el
}

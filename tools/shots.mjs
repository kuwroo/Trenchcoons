// Headless capture harness.
//
// The flag combination below is not optional and not obvious: plain
// --enable-unsafe-swiftshader yields NO WebGPU adapter at all in headless
// Chromium. --use-angle=metal is what actually gets a real Metal-backed
// adapter (verified: vendor=apple, architecture=metal-3, compute shaders OK).
import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'

export const WEBGPU_ARGS = ['--use-angle=metal', '--enable-unsafe-swiftshader']

// Two camera registers, and both are required.
//
// VISTA (y=180) is what judges atmosphere: layered receding hills for aerial
// perspective to eat, a horizon, sky.
//
// GROUND (y=3.5) is what judges the MATERIAL, and round 1 had none of it. Every
// shot was a vista, so the nearest ground was ~260m out, the fine brush octave
// was mathematically zero in all eight PNGs, and near-field albedo — the one
// place haze is ~0 and the palette should be at full chroma — was never
// captured. This is a driving game; y=3.5 is the camera the player actually has.
const VISTA = 'pos=0,180,700&warmup=64'
const GROUND = 'pos=280,14,760&warmup=64'
// NEAR (y=3.5) is the register the sentence above actually describes, and until
// now nothing captured it: GROUND sits at y=14, so the closest terrain in every
// gated PNG was 30 m+ out and the surface a driver spends the whole game looking
// at — the first ten metres of ground — was outside all five gates. That is
// where the worst material in the build was hiding: with the brush ladder
// clamped at its authored world scale (see `lod` in painterly.ts) the near
// ground came out as 60-200 px of soft camo blotches, and no gate could see it.
const NEAR = 'pos=280,3.5,760&warmup=64'

// M3 vehicle spawns. Hour 0.62 puts the sun behind the chase camera — at the
// 0.36 hero hour the kart is its own silhouette and none of the pose reads.
//
// The FLAT site was re-found by sweeping `__trench.heightAt` and
// `__trench.obstacles` over the near world for the gentlest cell that is also
// gentle across the 32 m the drive scripts cross. The greybox has 150 m of
// relief on a 380 m wavelength and there is no flat 70 m anywhere in it, so the
// captures that need level ground are kept SHORT and tight instead. (720, -540)
// is 1.1 deg of tilt at the spawn and 9.2 deg worst within 32 m; the previous
// site sat the parked car at 4.6 deg of pitch on ground that pitched to -30 deg
// two seconds into the corner run and launched it off a hillside.
const FLAT = 'time=0.62&warmup=64&spawn=720,-540&caryaw=0'
// The jump runs the other way down the valley, so 0.62 would put the sun in
// front of the camera and fill the frame with a shaded hillside: both jump
// frames measured shadowLuma 0.26-0.27 against the shadow gate's 0.299 floor.
// 0.45 lights the same slope instead of silhouetting it. The physics is
// identical either way — the sim does not read the clock.
const JUMP = 'time=0.45&warmup=64&spawn=-160,1040&caryaw=3.142'

export const SHOTS = [
  // Fixed vista camera, varying time. Five sun elevations, not four: with the
  // dusk declination in sunDirection() the arc is asymmetric, so 0.25 and 0.75
  // are genuinely different. The five elevations are 0, 34, 59, 22 and 7 deg.
  { name: 'greybox-morning',   q: `time=0.36&${VISTA}&look=0.42,-0.17` },
  { name: 'greybox-sunrise',   q: `time=0.25&${VISTA}&look=0.42,-0.17` },
  { name: 'greybox-noon',      q: `time=0.50&${VISTA}&look=0.42,-0.17` },
  { name: 'greybox-afternoon', q: `time=0.70&${VISTA}&look=0.42,-0.17` },
  { name: 'greybox-dusk',      q: `time=0.75&${VISTA}&look=0.42,-0.17` },

  // Sun-facing counterparts — where the scattering model actually shows. The
  // sunrise one is taken from the ground camera: a vista at the same hour and a
  // 51deg azimuth offset from the canonical shot was not a different picture
  // (mean abs diff 17.7), and `npm run distinct` says so.
  { name: 'atmos-sunrise-sunward', q: `time=0.25&${GROUND}&look=-0.471,-0.16` },
  { name: 'atmos-golden-sunward',  q: `time=0.72&${VISTA}&look=2.55,-0.06` },
  { name: 'atmos-dusk-sunward',    q: `time=0.75&${VISTA}&look=2.671,-0.06` },
  // Looking up: the only shot that judges cloud colour on its own terms.
  { name: 'atmos-clouds-noon',     q: `time=0.50&${VISTA}&look=0.6,0.34` },

  // Gameplay height. Brush texture, near-field chroma, cast-shadow contact.
  { name: 'ground-morning', q: `time=0.36&${GROUND}&look=-1.15,-0.12` },
  { name: 'ground-noon',    q: `time=0.50&${GROUND}&look=-1.15,-0.12` },
  { name: 'ground-dusk',    q: `time=0.75&${GROUND}&look=-1.15,-0.12` },
  // The lagoon: turquoise + cream + lime in one frame, as cliffs-tohad.jpg does.
  { name: 'lagoon-morning', q: `time=0.36&pos=100,150,-560&warmup=64&look=0.885,-0.115` },

  // Driver's eye. Two hours, because the near field's failure mode is different
  // in each: at noon it is the brush's own frequency, at dusk it is whether the
  // finest octave survives a raking key without stippling.
  { name: 'near-noon', q: `time=0.50&${NEAR}&look=-1.15,-0.20` },
  { name: 'near-dusk', q: `time=0.75&${NEAR}&look=-1.15,-0.20` },

  // ── M3: the vehicle, as five poses of one motion system ───────────────────
  //
  // A screenshot cannot show motion, so these do the next best thing: a fixed
  // input sequence on the deterministic clock, captured at an exact frame.
  // `drive=` is the script (see src/vehicle/replay.ts for the grammar) and
  // `frame=` counts from the first frame of that script, i.e. from the end of
  // the warmup. The clock freezes the moment `__ready` resolves, so each of
  // these is one reproducible pose rather than "whatever the car was doing".
  //
  // The car is OPT-IN under `?shot=1` — the fifteen shots above are ratcheted
  // against a best-ever ledger and must keep being the same pictures.
  //
  // `camyaw=` swings the chase arm round to a 3/4 rear view for the poses that
  // are invisible from dead astern, and `camarm=` pulls it in. Both are
  // CAPTURE-ONLY overrides on the real rig (src/vehicle/camera.ts) — the
  // simulated pose is identical either way, only the vantage differs. Pitch and
  // squash are the entire subject of the launch and landing frames and neither
  // survives being photographed from directly behind.
  //
  // The numbers in each comment are the telemetry measured at that exact frame,
  // so a change that breaks the animation shows up as a pose that no longer
  // matches its own caption.
  //
  // Parked and untouched, so the idle layer is what is on trial: the box
  // breathes, the occupants shift and blink, the coat settles.
  //   speed 0.00  4/4 contact  idle 1.00  all four wheels at 0.11 compression
  //   pitch +1.1 / roll -0.2, both entirely terrain. The car is AT REST, so any
  //   difference between two frames of this shot is the idle layer and nothing
  //   else.
  { name: 'car-idle',   q: `${FLAT}&drive=&frame=132` },
  // 0.47 s into a standing start, from over the left rear quarter so the nose
  // lift is against the horizon rather than end-on.
  //   pitch +10.3 with the terrain contributing only +1.1 of it, i.e. 9.2 deg
  //   of pure load transfer; front suspension extended to -0.12/-0.12 against
  //   the rear squatted to +0.22/+0.22; 24.9 m/s, 4/4 contact.
  { name: 'car-launch', q: `${FLAT}&drive=throttle:0-400&frame=28&camyaw=0.85&camarm=0.86` },
  // 1.67 s into a full-lock left. The throttle is held at 0.55 so the car takes
  // longer to wind up and the corner establishes inside the flat site rather
  // than 120 m downrange of it; top speed is unaffected, the demand cap is.
  //   roll -14.7 with the slope only -4.7 of it, so 10 deg is cornering load;
  //   inner wheels extended to -0.09/-0.04 against outer compressed to
  //   +0.18/+0.25; slip ratio 0.16 — the car is genuinely travelling sideways.
  { name: 'car-corner', q: `${FLAT}&drive=throttle:0-400@0.55,steerLeft:40-400&frame=100&camarm=0.82` },
  // One jump, two frames of it.
  // 170: mid-flight, 0.58 s after the crest. All four wheels at full droop
  //      (-0.26) with the struts visibly extended, nose down 14.2 following the
  //      flight path (TUNE.airPitch) while the ground below pitches -29.7, and
  //      the body stretched to -0.055 — a real negative squash, not a caption.
  //      The contact shadow underneath has spread and faded, which is what
  //      tells this frame from a parked one at 1:1.
  { name: 'car-airborne', q: `${JUMP}&drive=throttle:0-9999&frame=170&camyaw=0.6` },
  // 209: two frames after touchdown. Front and left rear bottomed at the full
  //      0.30 of travel and the right rear at 0.25, squash +0.173 — the frame
  //      the squash and stretch spring exists for — from the quarter so the
  //      flattening reads against the silhouette rather than end-on.
  { name: 'car-landing',  q: `${JUMP}&drive=throttle:0-9999&frame=209&camyaw=0.9&camarm=0.8` },
]

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5173'
const OUT = process.env.OUT_DIR ?? 'shots'
const W = Number(process.env.SHOT_W ?? 1600)
const H = Number(process.env.SHOT_H ?? 900)

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'))

async function main() {
  await fs.mkdir(OUT, { recursive: true })
  const browser = await chromium.launch({ headless: true, args: WEBGPU_ARGS })
  const page = await browser.newPage({ viewport: { width: W, height: H } })

  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

  const list = only.length ? SHOTS.filter((s) => only.includes(s.name)) : SHOTS
  let failed = 0

  for (const s of list) {
    const url = `${BASE}/?shot=1&${s.q}`
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 30_000 })
      await page.evaluate(() => window.__ready ?? Promise.reject(new Error('__ready missing')))
      const file = path.join(OUT, `${s.name}.png`)
      await page.screenshot({ path: file })
      console.log(`  ok   ${s.name.padEnd(20)} ${url}`)
    } catch (e) {
      failed++
      console.log(`  FAIL ${s.name.padEnd(20)} ${String(e).split('\n')[0]}`)
    }
  }

  if (errors.length) {
    console.log('\npage errors:')
    for (const e of [...new Set(errors)].slice(0, 10)) console.log('  ' + e)
    failed += errors.length
  }
  await browser.close()
  console.log(failed ? `\n${failed} problem(s)` : `\n${list.length} shot(s) ok`)
  process.exit(failed ? 1 : 0)
}
main()

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
// `eye=` is metres ABOVE THE GROUND; `pos`'s y is absolute. That distinction
// is not pedantry — it is a bug this list has carried since round 1. The
// terrain at (280, 760) sits at y = -100, so `pos=280,14,760` put the GROUND
// camera 114 m in the air and `pos=280,3.5,760` put the NEAR camera 104 m in
// the air. Both comments below describe a camera at gameplay height; neither
// captured one, and the near-field material every gate was calibrated to judge
// has therefore never been in a gated PNG.
const GROUND = 'pos=280,0,760&eye=14&warmup=64'
// NEAR (y=3.5) is the register the sentence above actually describes, and until
// now nothing captured it: GROUND sits at y=14, so the closest terrain in every
// gated PNG was 30 m+ out and the surface a driver spends the whole game looking
// at — the first ten metres of ground — was outside all five gates. That is
// where the worst material in the build was hiding: with the brush ladder
// clamped at its authored world scale (see `lod` in painterly.ts) the near
// ground came out as 60-200 px of soft camo blotches, and no gate could see it.
const NEAR = 'pos=280,0,760&eye=3.5&warmup=64'

// M3 vehicle spawns. Hour 0.62 puts the sun behind the chase camera — at the
// 0.36 hero hour the kart is its own silhouette and none of the pose reads.
//
// The FLAT site was re-found by sweeping `__trench.heightAt` and
// `__trench.obstacles` over the near world for the gentlest cell that is also
// gentle across the 32 m the drive scripts cross. The greybox has 150 m of
// relief on a 380 m wavelength and there is no flat 70 m anywhere in it, so the
// captures that need level ground are kept SHORT and tight instead. (720, -540)
// is 0.74 deg of tilt at the spawn — terrainPitch -0.15, terrainRoll -0.73,
// re-measured against `__trench.car()` after the greybox `groundAt`
// triangulation fix moved the drawn surface by up to 1.68 m; the "1.1 deg" this
// comment used to claim was measured before that fix and was never redone. The
// previous site sat the parked car at 4.6 deg of pitch on ground that pitched
// to -30 deg two seconds into the corner run.
const FLAT = 'time=0.62&warmup=64&spawn=720,-540&caryaw=0'
// Same site, car turned to face the sun.
//
// The parked captures need the OCCUPANTS' FACES, and at hour 0.62 the sun is
// behind the default chase camera, so any vantage that sees a face sees it
// backlit: swinging `camyaw` round to the front of a car at `caryaw=0` measured
// shadowLuma 0.159-0.199 against the shadow gate's 0.299 floor, i.e. four
// vantages in a row failed. Turning the CAR instead costs nothing — the site is
// the same, the drive script is empty — and puts the key on the faces with the
// camera's back to it. 0.339 at the framing below.
const PARKED = 'time=0.62&warmup=64&spawn=720,-540&caryaw=3.142'
// The jump runs the other way down the valley, so 0.62 would put the sun in
// front of the camera and fill the frame with a shaded hillside: both jump
// frames measured shadowLuma 0.26-0.27 against the shadow gate's 0.299 floor.
// 0.45 lights the same slope instead of silhouetting it. The physics is
// identical either way — the sim does not read the clock.
const JUMP = 'time=0.45&warmup=64&spawn=-160,1040&caryaw=3.142'

// M4's deformation site. Hour 0.62 for the same reason the M3 poses use it —
// the sun behind the chase camera — and it matters more here: a tyre mark is a
// low-contrast albedo change on a bright surface, and at a backlit hour the
// whole surface is its own shadow and the marks are invisible in it.
//
// `biome=coast` now, and that replaces the sand pan. Until this round the four
// tracks-* captures happened on a hand-placed 120x260 m rectangle of finely
// tessellated sand — the only surface in the build whose quads were small
// enough to show a rut — and that rectangle is exactly the bug behind "dont see
// tire marks": everywhere else in the world there was no mark surface.
//
// The clipmap puts 0.55 m cells under the camera wherever the camera is, so the
// pan is gone. Forcing the classifier to `coast` gives these four frames the
// same SURFACE the pan had (wet sand, the sharpest marks in the game, and the
// one ART_BIBLE has a literal photograph of) without giving it a special place
// in the world. `tracks-grass` below is the counterpart that proves the point:
// the same system, on ordinary ground, with nothing forced.
// THE SITE moved with the terrain. (-1000, 150) was the sand pan's corner and
// the pan was flat by construction; the same coordinates on real ground are a
// dune flank, and the car rolled downhill at 12 m/s for eight hundred frames
// after the brake released — which makes a "parked car, one variable is
// elapsed time" A/B impossible. (-1840, 360) was found by sweeping
// `__trench.heightAt` under `biome=coast` for the site with the least total
// drop over the 100 m the drive scripts cross: 1.19 m, against 26 m at the old
// one.
const PAN = 'time=0.62&deform=1&biome=coast&warmup=64&spawn=-1840,360&caryaw=0'
// Accelerate, brake, and COME TO REST. Shared by `tracks-fresh` and
// `tracks-decay`, and the resting matters as much as the driving: the car is
// stationary at (-971.2, 83.73) from frame 330 onward and never moves again, so
// both captures are taken with the chase camera settled at the same place. The
// A/B is elapsed time and nothing else.
//
// FRAMES 820 AND 1620, NOT 400 AND 1200, and re-measuring that is the whole
// point of quoting it. On the old sand pan the car was stationary from frame
// 330; on real terrain the same script runs out onto a gentle dune and is
// still reversing at 11.95 m/s at frame 400. Measured `__trench.car()`: frame
// 400 speed 11.954 at z 139.38, frame 800 speed 0.000 at z 165.23, frame 1200
// identical to frame 800 to the centimetre. So the pair moved to 820/1620,
// which is the same 13.3 s gap with both ends genuinely parked.
//
// MEASURED, `__trench.cam()`: frames 800 and 1200 (-992.54, -126.94, 184.73)
// and (-992.54, -126.94, 184.73) — identical,
// which is well under a tenth of a pixel. The previous pair took `fresh` at frame 270 with
// the car still rolling at 8.2 m/s, so the camera moved 1.5 m between the two
// and 94% of the pixels differed; the sky alone differed by a mean of 14.5/255
// and swamped the thing the pair was supposed to isolate.
//
// The brake input is the reverse channel (see replay.ts), so the last 1.6 s of
// this script backs the car up 9.7 m over its own tracks. That doubled patch is
// the deepest ground in the frame and it is the last thing to disappear.
const PAN_RUN = 'drive=throttle:0-150@0.62,brake:150-235'

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

  // ── M3: the vehicle, as seven poses of one motion system ──────────────────
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
  // `camyaw=` swings the chase arm round to a 3/4 view for the poses that are
  // invisible from dead astern, and `camarm=` pulls it in. Both are
  // CAPTURE-ONLY overrides on the real rig (src/vehicle/camera.ts) — the
  // simulated pose is identical either way, only the vantage differs, and that
  // was verified by running each drive script with and without them and
  // diffing `__trench.car()`.
  //
  // EVERY NUMBER IN THE COMMENTS BELOW WAS RE-MEASURED against `__trench.car()`
  // at the exact URL beside it, on the build that shipped them. The previous
  // round advertised these captions as the tripwire for animation breakage and
  // then let three of five drift — car-idle claimed "pitch +1.1 / roll -0.2"
  // against an actual +0.15 / +0.73 — which silently disables the tripwire.
  // Camera numbers are quoted too, for the same reason: a regression that
  // re-welds the rig to the chassis is caught by `cam dy` and `fov` no longer
  // matching, which is exactly the failure that survived the last two rounds.
  //
  // Parked and untouched, so the idle layer is what is on trial: the box
  // breathes, the occupants shift and blink, the coat settles.
  //   pitch -0.15 / roll -0.73, both ENTIRELY terrain (terrainPitch -0.15,
  //   terrainRoll -0.73). speed 0.00, 4/4 contact, idle 1.00, all four wheels
  //   at 0.110 compression, vy 0.000. cam dy 2.550, arm 3.90 m, fov 58.00.
  //   The car is AT REST and the camera is bit-identical between this frame and
  //   car-idle-b, so any difference between the two PNGs is the idle layer and
  //   nothing else.
  //   `camyaw=2.95` looks at the FACES. See `PARKED`: this is the only vantage
  //   on the pair that is not backlit, and until this round the mask, the eyes
  //   and the blink had never been photographed at all — every car-* frame in
  //   the set was the backs of two heads.
  { name: 'car-idle',   q: `${PARKED}&drive=&frame=102&camarm=0.6&camyaw=2.95` },
  // car-idle, 48 frames (0.8 s) later, same URL otherwise.
  //
  // This shot exists because "a parked car must never be a still image" is a
  // MILESTONES M3 done-when and a single PNG cannot show it. The camera is
  // bit-identical to car-idle's — verified, not asserted: (710.4181773320053,
  // 28.801449358268343, -537.8567111827165) at both frames — and the vehicle
  // telemetry is identical to the last digit (pitch -0.149, roll -0.726, speed
  // 0, idle 1.00, all four wheels 0.110), so the entire pixel difference
  // between the two files is breathing, glancing, blinking and coat settle.
  // MEASURED: 195,829 pixels differ by more than 2/255 between the two PNGs,
  // 13.60% of the frame, with a peak delta of 221. There is no longer anything
  // to take on trust here — `cmp shots/car-idle.png shots/car-idle-b.png`.
  { name: 'car-idle-b', q: `${PARKED}&drive=&frame=150&camarm=0.6&camyaw=2.95` },
  // 0.57 s into a standing start, from over the rear quarter so the nose lift
  // is against the horizon rather than end-on.
  //   pitch +9.47 with the terrain contributing +0.15, i.e. 9.3 deg of pure
  //   load transfer; front suspension extended to -0.144/-0.144 against the
  //   rear squatted to +0.205/+0.205; 30.3 m/s, aLong +51.9, 4/4 contact.
  //   cam dy 2.916, arm 6.01 m, fov 64.03 — the FOV is 6 deg into its punch,
  //   which is the launch half of "FOV punch on acceleration".
  //   `camarm=0.85`, up from 0.70: at the shorter arm the frame bottom cut both
  //   rear wheels off, and rear squat against front droop is the entire subject
  //   of this capture. All four contact patches are now inside the frame.
  { name: 'car-launch', q: `${FLAT}&drive=throttle:0-400&frame=34&camyaw=-0.6&camarm=0.85` },
  // 1.27 s into a full-lock left. The throttle is held at 0.55 so the car takes
  // longer to wind up and the corner establishes inside the flat site rather
  // than 120 m downrange of it; top speed is unaffected, the demand cap is.
  //   roll -11.33 with the slope only -3.06 of it, so 8.3 deg is cornering
  //   load; wheels -0.146 / +0.084 / +0.036 / +0.266, i.e. the outside rear is
  //   carrying the car and the inside front has lifted clean off its stop;
  //   slip ratio 0.162 and aLat -32.0 — the car is genuinely travelling
  //   sideways. speed 32.63, pitch +1.32 (terrain -3.64).
  //   cam dy 2.968, arm 5.60 m, fov 63.16.
  //   `camyaw` is NEGATIVE here: it swings the camera to the OUTSIDE of the
  //   turn, which is the only side the loaded flank and the lifted inner wheel
  //   are both visible from.
  //   FRAME 76, NOT 100, AND THAT IS A COMPOSITION FIX. The aim point leads the
  //   car by `RIG.lookahead` seconds of velocity, so the faster the car is
  //   going the further it sits from the centre of its own frame: at 35.5 m/s
  //   (frame 100) the 8.4 m lead pushed the kart into the bottom-right corner
  //   with the left 60% of the picture empty grass, which is what the last
  //   round shipped. Swinging wider or shortening the arm both make that worse,
  //   because neither changes the lead. Photographing the corner 0.4 s earlier
  //   at 32.6 m/s does: same slip ratio, 8.3 deg of load instead of 9.7, and
  //   the whole kart inside the frame at nearly twice the size.
  { name: 'car-corner', q: `${FLAT}&drive=throttle:0-400@0.55,steerLeft:40-400&frame=76&camyaw=-1.0&camarm=0.8` },
  // THE DEFAULT RIG. No `camyaw`, no `camarm`, nothing overridden.
  //
  // Every other car shot overrides the chase camera, which meant the camera
  // itself had no gated coverage at all: the arm could regress from 8.0 m back
  // to the 13.1 m bias the offset-frame fix removed and not one PNG would
  // change. This is the shot that catches that.
  //   speed 35.02 at 4/4 contact on a -14.3 deg descent, so the rig is solving
  //   terrain clearance as well as lag. cam dy 3.154, arm 7.72 m, fov 58.08 —
  //   arm and height at their nominal top-speed values (RIG.arm + armSpeed =
  //   8.0, RIG.height + heightSpeed = 3.10) with the terrain solve accounting
  //   for the rest, and the FOV relaxed because a car at a steady 35 m/s is not
  //   accelerating.
  //   pitch -14.20 (terrain -14.26), roll +3.80 (terrain +0.07), wheels
  //   0.136 / 0.034 / 0.155 / 0.053, vy -10.22.
  { name: 'car-chase',  q: `${FLAT}&drive=throttle:0-400@0.8,steerRight:60-400@0.35&frame=200` },
  // One jump, two frames of it.
  // 170: mid-flight, 0.60 s of airtime. All four wheels at full droop (-0.26)
  //      with the struts visibly extended, nose down 14.19 following the flight
  //      path (TUNE.airPitch) while the ground below pitches -29.66, and the
  //      body stretched to -0.055 — a real negative squash, not a caption.
  //      vy -16.63, aVert -26.0 (free fall), 0/4 contact.
  //      THE CAMERA IS THE OTHER HALF OF THIS FRAME. cam dy 3.197, arm 7.75 m,
  //      fov 58.00 — and the aim point sits `lookaheadVert * vy` = 2.66 m BELOW
  //      the chassis, which is what puts the kart high in the frame with a
  //      whole hillside of empty ground under it. Before the vertical channel
  //      existed this shot framed the kart dead centre at exactly the height a
  //      parked car sits at, and was indistinguishable from one.
  { name: 'car-airborne', q: `${JUMP}&drive=throttle:0-9999&frame=170&camyaw=0.6` },
  // 209: two frames after touchdown, sinceLanding 0.033 s. Front and left rear
  //      bottomed at the full 0.300 of travel and the right rear at 0.252,
  //      squash +0.173 — the frame the squash and stretch spring exists for —
  //      from the quarter so the flattening reads against the silhouette rather
  //      than end-on. aVert +123.5, i.e. the impact the vertical channel now
  //      carries; pitch -19.68 into a -17.14 slope.
  //      THE CAMERA REACTS. cam dy 2.699 against a 3.10 nominal, arm 3.10 m,
  //      and fov 61.96
  //      against 58: the rig is 0.40 m BELOW its steady-state height
  //      because it was falling at 31 m/s a frame ago and has overshot the
  //      target the touchdown snapped back up, and the FOV is mid-kick off the
  //      same impact velocity the squash spring is kicked with. Both numbers
  //      were 3.09 and 58.4 before this round — the camera did not react to the
  //      landing at all, on any axis.
  //      `camarm=0.42` is short, and it is the framing the gates chose: the
  //      landing sits at the bottom of a valley with no sky in shot, so a
  //      longer arm fills the frame with shaded hillside (shadowLuma 0.261 at
  //      the previous vantage, against the gate's 0.299 floor) and, because the
  //      kart's own kraft/teal/violet are most of the hue variety available
  //      down there, also costs hue entropy.
  { name: 'car-landing',  q: `${JUMP}&drive=throttle:0-9999&frame=209&camyaw=0.4&camarm=0.42` },

  // ── M4: the deformation field, as four states of one system ───────────────
  //
  // Same contract as the M3 poses above: a fixed input sequence on the
  // deterministic clock, captured at an exact frame.
  //
  // `deform=1` is OPT-IN under `?shot=1`, exactly as `car` is and for exactly
  // the reason src/vehicle/replay.ts spells out — the twenty captures above are
  // ratcheted against a best-ever ledger, and a system that adds new geometry
  // (the sand pan) and new albedo to a frame would silently rewrite all twenty
  // baselines. The four below are gated no more gently for it: `npm run gate`
  // reads every PNG in shots/.
  //
  // THE SITE is now ordinary terrain. It used to be `buildSandPan` in
  // src/world/greybox.ts — a finely tessellated sand flat laid on top of the
  // 19 m quads of the ground plane, because that was the only place in the
  // build with the resolution to take the field's vertical displacement as
  // geometry. src/terrain/clipmap.ts puts 0.55 m cells wherever the camera is,
  // so the pan is gone and `biome=coast` supplies the surface instead.
  //
  // `camarm=3.0` is not a preference. The chase rig looks along the car's
  // FORWARD axis and a tyre mark is behind the car, so at the gameplay arm
  // (6.5 m) the marks occupy the bottom eighth of the frame and the shot cannot
  // show what it is for. At 3x the arm the camera sits ~19 m back and the
  // ground between it and the car — which is precisely the fresh track — fills
  // the lower half. Capture-only, on the real rig; the simulated pose is
  // identical either way.
  //
  // FRESH. The car has just come to rest at the end of the run and the ground
  // between it and the camera is the track it laid getting there: two clean
  // parallel lines a couple of seconds old, plus the doubled patch where it
  // backed up under the brake.
  //   frame 400 — 1.2 s parked at (-971.238, 83.725), speed 0.00, 4/4 contact,
  //   camera settled (see PAN_RUN). MEASURED through `__trench.deform` along the
  //   wheel line at 2/5/8/12 m behind the car: mask 0.525 / 0.574 / 0.632 /
  //   0.494, depth 0.0047 / 0.0063 / 0.0089 / 0.0027 m. That is what a CRUISE
  //   writes on wet sand — half a centimetre — and `tracks-corner`, at 8.7 cm
  //   and mask 0.99, is the other end of the same scale.
  { name: 'tracks-fresh',   q: `${PAN}&${PAN_RUN}&frame=760&camarm=3.0` },
  // Full lock at 35 m/s, slip ratio 0.16 — the car is genuinely travelling
  // sideways. Against `tracks-fresh`, from the same camera on the same ground:
  // the two thin lines become one broad dark swathe. That is the spec's "hard
  // cornering MUST visibly cut deeper than cruising", and it is two terms
  // multiplied — `slipRatio * normalLoad` drives DEPTH (0.19 -> 0.90 of the
  // surface maximum, five times deeper) while scrub drives WIDTH (the stamp
  // capsule widens by up to 95%).
  { name: 'tracks-corner',  q: `${PAN}&drive=throttle:0-9999@0.55,steerLeft:44-9999&frame=130&camarm=3.0` },
  // Drive away and come back — MILESTONES M4's done-when, as one frame.
  //
  // Out along the pan at full throttle, a full-lock U-turn at the far end, back
  // up the far side, and a second full-lock turn that brings the car ACROSS its
  // own outward track at right angles. At the far point of the loop the car is
  // 205 m in z from the marks it laid on the way out — the near tier's half-span
  // is 128 m — so those marks are evicted from the 2048² tier entirely and
  // survive only in the 1024²/2 km committed one. Coming back demotes them.
  //
  // WHY IT CROSSES rather than merely passing near. The previous version drove a
  // 110 m-radius circle and came back alongside the outward leg, which put the
  // demoted band 13 m off the frame's axis in a haze of brushwork; both critics
  // said the one shot whose job is "find your tracks" did not carry its subject.
  // Crossing puts the old band perpendicular to the view, between the camera and
  // the car, with the fresh track running through it.
  //
  // MEASURED at frame 890, mapping `__trench.deform` on a 1 m grid around the
  // car: a 4-5 m wide band at x -973..-969 running the full 31 m of the window
  // at mask 0.22-0.44 and depth 0.000 — the rut has long since filled and only
  // the stain is left, which is what a 15-second-old mark on wet sand should be
  // — crossed by the fresh trail at mask 0.7-0.9. Two textures in one frame: the
  // committed tier's 2 m per texel against the near tier's 12.5 cm.
  //
  // It is also 510 frames cheaper to capture than the loop it replaces.
  { name: 'tracks-persist', q: `${PAN}&drive=throttle:0-9999,steerLeft:300-500@1.0,steerLeft:735-830@1.0&frame=890&camarm=2.6` },
  // The SAME drive script, the SAME parked car and the SAME camera as
  // `tracks-fresh`, 13.3 s later. One variable: elapsed time.
  //
  // THIS SHOT WAS THE ROUND'S BIGGEST FAILURE and it was two failures stacked.
  // It was taken at frame 930 with a comment claiming the shallow marks had
  // "gone completely", and they had not — measured through `__trench.deform`,
  // the mask 2 m behind the car was still 0.361 and 12 m behind still 0.342,
  // and since the material draws the mark almost entirely from that channel the
  // capture showed two full-length, fully readable ruts. It also called itself a
  // controlled A/B while the car rolled 3.2 m between the two frames and took
  // the chase camera with it.
  //
  // The camera half is fixed by parking both frames (see PAN_RUN). The decay
  // half was a real bug in the field, not a frame number: R decays at a rate
  // scaled to the surface while G decayed on an absolute `maskLife`, so a
  // half-centimetre scuff lost its rut in four seconds and kept its stain for
  // thirty-five. `STAIN_BARE` in src/deform/field.ts ties the two together.
  //
  // MEASURED HERE, same probe as `tracks-fresh`, same offsets: depth 0.0000 at
  // all four — the ruts are gone, not shallower — and mask 0.063 / 0.115 /
  // 0.187 / 0.032, an eighth to a third of what it was. Through the material's
  // toe and gamma that leaves at most a fifth of the mark's contrast, which is
  // what the frame shows: no readable track anywhere in it. The numbers are
  // quoted rather than rounded to zero because the last round's comment rounded
  // to zero and was wrong.
  //
  // The pair is gated, not asserted. `npm run distinct` measures the difference
  // between these two frames inside the track corridor and against bare sand
  // either side of it, and requires the first to be at least twice the second:
  // 8.65 vs 1.97, ratio 4.39. The capture this replaces scores 19.27 vs 18.94,
  // ratio 1.02 — a whole-frame difference with nothing in the subject.
  { name: 'tracks-decay',   q: `${PAN}&${PAN_RUN}&frame=3400&camarm=3.0` },

  // ── the biomes, as five states of one climate model ───────────────────────
  //
  // Every site below was FOUND, not chosen: a sweep of `__trench.biomeAt` over
  // the world on a 60 m lattice, filtered to ground under 12 degrees of slope,
  // keeping the highest biome weight for each class and the most evenly split
  // pair for the transition. The weights are quoted per shot. Re-running that
  // sweep is how these get re-sited if the climate fields are ever retuned;
  // .scratch is not in the repo, so the method is written down here instead.
  //
  // `eye=` is metres ABOVE THE GROUND. See main.ts: `pos`'s y is absolute, the
  // terrain runs -200 to +250 m, and every "driver's eye" capture in the list
  // above is in fact 100 m in the air because of it.
  //
  // MEADOW, weight 0.89. The hero biome and the Genshin reference frame:
  // saturated clean green, dense grass, scattered blue-grey rock, conifers
  // thinning toward the ridge, 0.7x haze so the distance stays legible.
  {
    name: 'biome-meadow',
    q: 'time=0.42&car=0&warmup=48&pos=2160,0,-420&eye=6&look=1.15,-0.06',
  },
  // ALPINE, weight 1.00. Against the meadow this must differ in FIVE ways at
  // once, which is the whole test: ground material (high-key snow over dark
  // exposed rock), scatter set (cliff-block and boulder, no broadleaf), rock
  // form (ridged relief at 26 m against the meadow's 6 m of roll), grass
  // density (zero against 0.9/m2) and light (1.8x haze, cool #EAF4FF sun).
  {
    name: 'biome-alpine',
    q: 'time=0.42&car=0&warmup=48&pos=2700,0,3000&eye=14&look=2.30,-0.05',
  },
  // DESERT, weight 0.98. Long smooth dunes, warm sand, slab rock and outcrop,
  // effectively no grass, 1.4x haze. ART_BIBLE §4 runs this biome in the Sky
  // register by default and that is what the fog multiplier does here.
  {
    name: 'biome-desert',
    q: 'time=0.42&car=0&warmup=48&pos=2820,0,-2220&eye=8&look=1.15,-0.05',
  },
  // THE TRANSITION. Desert 0.50 / meadow 0.50 at the camera, and there is no
  // transition code path anywhere in the build that produced it — ART_BIBLE §5:
  // "ambiguity IS the transition". The camera looks along the moisture
  // gradient, so the frame carries sand on one side and grass on the other with
  // the scatter sets interleaving through the middle.
  {
    name: 'biome-transition',
    q: 'time=0.42&car=0&warmup=48&pos=360,0,-540&eye=9&look=2.05,-0.07',
  },
  // GRASS AT CLOSE RANGE. 1.6 m off the ground, pitched down, in the meadow:
  // the near band at its full 0.45 clumps/m2 on a 1.1 m lattice, LOD0, moving
  // on the global wind field. This is the capture that judges the blade asset
  // and the density falloff, and no camera in the previous list could see
  // either — the closest ground in any of them was 30 m out.
  {
    name: 'grass-close',
    q: 'time=0.42&car=0&warmup=48&pos=2160,0,-420&eye=1.6&look=1.15,-0.30',
  },

  // ── the two complaints that need the car ──────────────────────────────────
  //
  // TYRE MARKS ON ORDINARY GROUND. No `biome=`, no pan, no special surface:
  // the meadow, classified by the climate fields like everywhere else, with
  // `BIOMES.grass` as its response. Two parallel ruts and the bruised band
  // between them, cut into grass by a car that drove past.
  //   MEASURED at this exact URL through `__trench.deform` on a 0.2 m grid
  //   (a 1 m grid walks straight past a 32 cm track — it did, for a round):
  //   287 cells above mask 0.05 with a peak of 0.788, the strongest at world
  //   (487.3, -68.8) against a car at (488.0, -84.1).
  {
    name: 'tracks-grass',
    q: 'time=0.62&car=1&deform=1&warmup=48&spawn=600,0&caryaw=0'
      + '&drive=throttle:0-240@0.9,steerLeft:150-200@0.5&frame=250&camarm=3.4',
  },
  // A ROCK COLLISION.
  //
  // RE-SITED AND RE-VERIFIED. The previous version of this entry claimed
  // "contact false at frame 70 and true from 90 on, the chassis pinned at
  // (2150.3, -416.1)", and replaying its own URL produced contact FALSE at
  // frames 70, 90 and 110 with the kart still doing 35 m/s and the five nearest
  // solids being 18-28 cm pebbles. Two critics caught it independently. The
  // comment was measured at a site the climate fields had since moved, which is
  // the failure mode this whole list is supposed to be immune to — so the
  // procedure is written down here as well as the numbers.
  //
  // HOW THIS SITE WAS FOUND, reproducibly, by a script and not by eye:
  //   1. spawn, then read `__trench.solids()` and `__trench.heightAt()`;
  //   2. keep proxies with `top - heightAt > 1.2 m` AND `radius > 1.0 m` AND
  //      12 m < distance < 90 m — i.e. things tall enough to stop a kart and far
  //      enough away to reach 35 m/s before arriving;
  //   3. aim with `yaw = atan2(-dx, -dz)`, which is the convention this build
  //      uses; the three other sign combinations were tried and all three drive
  //      past;
  //   4. run the script and REQUIRE `contact === true`.
  //
  // MEASURED at this exact URL through `__trench.car()`: the kart spawns at
  // (272.5, 755.1), the target is a 4.43 m-radius boulder at (258.2, 790.0)
  // standing 4.03 m above the ground 37.7 m away, and at frame 150 the chassis
  // is at (259.5, 786.5) doing 0.62 m/s with `contact` TRUE and the throttle
  // still at 0.9 — 3.7 m from the rock's centre, i.e. against its face. Aimed at
  // the same rock with any of the three wrong yaw conventions it ends up 54-96 m
  // away at the full 35 m/s.
  //
  // `camarm=5` asks for five times the solved arm and gets 13.2 m, which is
  // where the rig's own clamp lands; that is far enough back that the boulder,
  // the kart and the flattened grass between them are all in frame. The proxy is
  // the modeller's exact convex hull flattened to its XZ shadow — see
  // src/world/proxy.ts for why a horizontal solve is the only one a
  // raycast-suspension kart can consume.
  {
    name: 'rock-collision',
    q: 'time=0.42&car=1&warmup=48&spawn=280,760&caryaw=2.7537'
      + '&drive=throttle:0-9999@0.9&frame=150&camyaw=1.15&camarm=5',
  },
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

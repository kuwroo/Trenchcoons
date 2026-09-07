# Trenchcoons — agent operating instructions

Open-world driving game. Two raccoons in a trenchcoat in a cardboard box.
Mid-migration from Godot to a WebGPU/Three.js rebuild, on branch `web-rebuild`.

## Read first

- `docs/ART_BIBLE.md` — visual target. Read before touching any shader,
  material, palette, or post effect.
- `docs/ARCHITECTURE.md` — systems, render graph order, conventions, Asset Forge.
- `docs/MILESTONES.md` — the work queue.
- `refs/README.md` — what each reference image governs. For the CHARACTERS start
  with `refs/character/raccoon-boxkart-sheet-2.png`: it draws the raccoons and
  the kart as separate panels on flat grey, which is the only view that shows
  their form free of the box and of scene lighting.

The Godot project at the repo root is the **old** build, kept for assets and
reference. Do not add features to it.

## Stack

WebGPU only (no WebGL2 fallback) · Three.js + TSL · TypeScript strict · Vite ·
Rapier · vanilla Three for rendering, React for Forge/debug UI only.

## The look, in one box

**Genshin Impact's grasslands** — `refs/genshin/grasslands.jpg` is the primary
reference and the tie-breaker. Clean stylised realism: crisp shading, saturated
but not acid greens, flat sculptural rock planes, strong blue atmospheric
perspective, clean gradient skies with thin wispy cloud.

**The painterly direction is ABANDONED.** No brush-stroke overlay on terrain, no
hyper-saturation. It produced a mottled camouflage look that never resolved.
Capy Castaway now governs CHARACTER form language only.

```
Shadows:   coloured and lifted, tinted toward sky. Never grey, never crushed.
Specular:  water, wet surfaces, ice, vehicle paint. Never nature.
Lit surfaces warm ~50deg toward yellow and jump ~0.4 in VALUE while LOSING
           ~0.15 saturation. Measured across the references.
Distance:  blue haze + desaturation. The main fidelity lever.
Forms:     big, readable, sculptural. Flat rock planes.
Sky:       clean gradient, thin wispy cloud. NOT heavy blobs.
Biomes:    must be distinguishable by more than hue — ground, scatter, rock
           form, grass density and light all change together.
```

## Invariants — do not break these

- **Units are metres.**
- **NPR, not PBR.** No metal/roughness workflow for nature.
- **Tonemap is gentle filmic with highlight desaturation OFF.** Not AgX — it
  desaturates highlights, the opposite of the target.
- **No `Math.random()` in generation.** Seeded RNG only; determinism is what
  makes the screenshot harness meaningful.
- **Render calls live in `core/renderGraph.ts`.** Don't scatter them. New
  stateful systems must be listed in `RenderGraph.STATEFUL`, or `main.ts`'s
  `stateOnly` fast-forward will skip them and any accumulating field will be
  built out of four frames instead of eleven seconds.
- **Never block a frame on GPU readback.** Deformation → physics is async.
- **All vegetation samples the one global wind field.** No per-asset wobble.
- **No hardcoded assets.** Every asset is a JSON def in `assets/defs/` driven by
  a Forge generator — including imported and AI-generated meshes.
- **Ambient comes from the sky LUT**, never a constant.
- **The Forge must render exactly like the game.** Both go through
  `graded(surfaceId, params)`, inside `ScatterLibrary.material()` so neither
  caller has to remember. If you add another viewer, route it there. When the
  Forge used the raw def and the game used the GRADE override — for `stone`,
  ambient 4.9 against 1.75 — every rock in the preview was a flat cyan lump and
  a whole round went into respeccing geometry that was already correct.
- Perf: 16.6ms @ 1080p, <1500 draw calls, <400MB GPU memory.

## Controls — couch co-op (confirmed)

Two players, one keyboard, one car. P1 steers with `A`/`D`; P2 throttles and
brakes with `Up`/`Down`. This is the hook, not a fallback.

## Motion rule

Nothing in this game moves linearly. Every transition — camera, suspension,
body roll, UI, idle — goes through the shared spring/easing utility. A parked
car must still be visibly alive. See MILESTONES M3.

A kick ceiling has to be set against its spring's FREQUENCY, not by eye: peak
displacement is `kick / (2 * pi * freq)`, so on a 5.2 Hz spring a ceiling of 5
cannot produce more than 0.15 rad however hard the car lands. Two of the three
impact responses were nominal for exactly this reason and no amount of looking
at captures found them — `Kart.probe()` and a parked control did.

## Commands

```
npm run dev        # game (HMR)
npm run shots      # headless capture -> shots/*.png
npm run gate       # raccoon structure shadow hue distinct regress palette water popin
npm run popin      # scatter pop-in: density continuity + pixels per streaming step
npm run perf       # frame stability; needs `vite preview`, NOT dev (HMR
                   # reloads mid-measurement and kills the context)
npm run water      # the water suite, against refs/water/
npm run raccoon    # raccoon layout invariants (buried / detached / backfacing)
                   # + the M3 idle check (kart churn vs a meadow control)
npm run typecheck
npm run raccoon:ortho              # headless Blender front/side/rear turnaround
node tools/raccoon-export.mjs      # rest pose -> OBJ, in 0.18 s
node tools/raccoon-profile.mjs [front|side|rear]   # silhouette vs the sheet's,
                   # row by row. Trust the ROWS, not the aspect.
node tools/_det.mjs               # is a capture reproducible? same URL, N times
node tools/_pngdiff.mjs A B f.png # pixel diff two capture directories
```

Any world state is reproducible from a URL:
```
?seed=1234&pos=120,8,-340&look=0.3,-0.1&time=0.35&weather=snow&biome=alpine
```
Wait on `__ready` before capturing, or screenshots race the streaming system.

Readbacks worth knowing: `window.__trench.crew()` (paw miss, flap and ear
springs), `.car()`, `.solids()`, `.streamAt(x,z)`, `.scatterAt(x,z)` (every drawn
scatter instance with its band, scale and fade), `.deform(x,z)`,
`__trenchWater.scan()` and `.placement(x,z)`.

## The gates are the bar

Each is calibrated so the images in `refs/` pass. If a gate fails your output,
your output is wrong. **Do not loosen a threshold to pass** — adding new
diagnostic output is fine, moving the bar is not. Before trusting a new gate,
run it against `refs/` first; three of the first five were mis-calibrated and
only caught that way.

**Every gate needs a floor AND a ceiling.** Three one-sided metrics were gamed
during M1: `shadowSat` rewarded navy shadows, `vRange` rewarded crushed darks,
`medStd` rewarded high-frequency noise over brushwork. A slack ceiling is the
same fault: `foamShare` sat thirteen times above its reference and said nothing
while a sign error rendered the whole sea as near-white foam.

**Prefer subject-vs-control over whole-frame measurement.** A whole-frame metric
cannot tell you whether the thing you care about changed. `tracks-decay` scored a
19.27 whole-frame difference while its subject moved by nothing. A ratio between
subject and control cannot be satisfied by changing everything.

**Always run the OFF-CASE.** Two gates here passed with their feature disabled —
the bob-ripple check and the first two swash designs — and a gate that cannot
fail is worse than none. `npm run popin` records what each of its checks reads
with its mechanism switched off.

**A ratio needs a usable denominator.** The idle check's control is scenery
another session edits; it has read 12.9%, 23.7% and 0.0% within an hour, and at
0.0% the ratio was 26 million and the gate PASSED on a divide-by-zero. A metric
that cannot be computed has to say so rather than return a number.

**Watch for gates fighting features.** The structure gate's detail floor pushed a
builder to make the M4 sand pan noisier, and the surface's own blotches then
out-contrasted the tyre marks the pan exists to display. When a gate and a
feature disagree, the gate is usually measuring the wrong region.

### Which gates do not govern which frames

`structure` and `palette` skip `shots/water-*.png` and `car-crew`, on a
measurement rather than a preference — run either gate against the references
those frames are judged by and it fails them HARDER than the build:

```
shore-foam-wake.jpg     FORMLESS (0.0203 vs ref 0.0688), FLAT (range 0.192),
                        undersaturated 0.413, NO SHADOW PIXELS AT ALL
lake-cartoon-cells.jpg  OVER-DETAILED (0.0951 vs 0.0688), washed out
the reference driver portrait  FORMLESS at 0.0067, 53.4% flat, sat 0.141
```

Both gates are calibrated on landscapes with rock planes, foliage and cast
shadow. A frame that is 90% open water or one raccoon's cheek has none of those,
and the way to pass would be to put fake detail and fake darks in the sea.
`lagoon-morning` is NOT exempt — it has cliffs and vegetation and is the one
capture that checks sea against land in the same picture. Nothing else is exempt.

## Verifying visual work

"Done" on visual work means **compared against `refs/`**, not that it ran.
Screenshots are the feedback signal — not "it compiles".

**BUILD THE READBACK FIRST.** This is the single most expensive lesson in the
project. Three of the water's four bugs and every one of the raccoon rig's were
diagnosed by a whole-field readback, never by looking at the frame — the frame
was self-consistent and wrong every time. An invisible ocean rendered a plausible
picture of the SEABED; a wake field with 99% of its stamps never issued read as
a look problem for two rounds.

**Before believing a defect, check that the harness renders what ships.** Every
apparatus failure in this project produced a confident, specific, WRONG
diagnosis: HMR reloading mid-measurement, perf measuring the inside of a pit, a
dead preview server, concurrent builds, a blank `drawImage` on a WebGPU canvas,
the ungraded Forge, and a skipped `npm run build`.

**Reproduce a critic's number with your own instrument before acting.** Nine
findings were retracted this way, and the pattern is stable enough to state as a
rule: **a critic's judgement of how something LOOKS has been reliable
throughout; its judgement of WHERE something is, or whether it exists at all, has
been wrong about half the time.** Take the first on trust, verify the second. The
usual cause is crop-to-source mapping on a 2752 px sheet.

**Check where a measurement box actually lands.** Two boxes offered as "facets 70
degrees apart at identical luma" were on the same face. `SHEET_BOXES.rear` landed
entirely inside the animal and reported a perfect rectangle on all 24 rows. The
side crop cut through the middle of the torso while its own comment explained why
it stopped where it did — and it faked the head/body depth ratio for three
rounds. A box whose comment justifies its edges is not evidence about its edges.

**Measure first; three false defects came from LOOKING at a downscaled frame.** A
1600 px capture displayed at reading size is resampled, and the resampling
invents structure at exactly the scale the water is judged on. "Concentric
topographic bullseyes", "coloured dashes along the coastline" and "dark speckles
over the cell field" were all measured as absent — the last of them was ONE
pixel, 0.0001% of frame, against the reference's 0.1071%. The frame is still the
right place to form a SUSPICION; a native-resolution crop or a pixel readback has
to confirm it before anything changes.

**Measure a value against what it will appear NEXT TO**, not against the paper it
is printed on. The sheet's rear heads look pale and are 0.16-0.22 DARKER than the
box beside them, exactly as the build's are.

**One knob per measurement.** A `deep` saturation step that looked like a 0.44
transfer ratio was confounded by `saturationGain` moving at the same time; the
clean step measured 0.95, and an extrapolation from the fiction was wrong by
twice.

**Re-run a surprising SINGLE-metric change before acting on it.** A real
regression moves several numbers, or moves one for a reason you can name.
`monotone` read 0.60 on a frame it had passed minutes earlier with every other
metric identical to three decimals — a PNG being written while the gate read it.

**Hand a reviewer a frozen copy**, not `shots/`. Another session shares this repo
and rebuilds `dist/` — a capture run that overlaps one produces frames from two
different bundles, and its gate output is a blend. Measured: two `npm run shots`
runs of the SAME source differed on 65-75% of pixels on the car frames and
flipped `car-airborne` from FORMLESS to OVER-DETAILED. `tools/_det.mjs` settles
this in a minute: the same URL three times in one process is bit-identical, so a
difference between runs is never the build.

**Do not attribute the shared gates while another session is editing.**
`src/world/grass.ts`, `scatter.ts`, `registry.ts`, `collision.ts`, `proxy.ts`,
`src/vehicle/*` and `src/water/` all move under a measurement run. `distinct`'s
corridor figures moved from 0.49/0.73 to 3.51/7.61 between two runs minutes
apart. To tell your regression from an inherited one, measure a BASELINE the same
way — a `git worktree` at HEAD, or, if the tree is already dirty from another
session, revert only your own files and capture again.

**Flag a surface flat magenta and re-render.** The cheapest instrument there is,
and it answers "which surface is that" exactly. It identified the arm bones, the
tails through the box wall, and the steering wheel's far rim. **Flag FOUR
surfaces at once** — each single-surface probe costs a build and eliminates one
candidate; a four-colour probe costs the same build and eliminates four.

**SWEEP the constant.** `node tools/raccoon-export.mjs /tmp/x.obj` writes the
rest pose in 0.18 s, so any geometry question — where is the frontmost point, how
wide is the ruff, does the tail clear the rim — can be answered off the OBJ.
Thirteen probes cost less than one render, and sweeping is what makes CLIFFS
visible: the muzzle's ramp exponent is fine at 1.85 and jumps 0.064 m at 1.9, and
a single probe at 2.0 reads only as "worse than 1.8".

**But a sweep optimises exactly what you score and silently sacrifices what you
omit.** The first nose sweep's unconstrained optimum was 2.3x better on the front
edge and put the nose two thirds of the way down the pad, where the sheet has it
near the top — a constraint measured two rounds earlier and left out of the
objective. Enumerate the constraints BEFORE searching.

**A string replace that does not assert is a claim, not a change.** A tightened
`shoreMaxRun` ceiling silently did nothing for several rounds because the
anchor's comment body had changed, while this file said it was done. Two more
edits failed the same way in one round and the measurements that followed were
leftover probe state. Read every threshold and def back after writing it.
`npm run water -- --limits` exists for this: it prints every bracket beside the
reference values it was calibrated on, so a limit that never moved shows up as
slack rather than staying invisible.

**When reverting the data changes nothing, the code is the variable.** A whole
round went into restoring `waveAmp`, `cellAmp` and `seabedMix` to their green
values with no effect at all, because the fault was a sign error in the Voronoi
bake.

**When several independent knobs in one layer all fail the same way, the variable
is in a different layer.** Five mechanisms were tried against the dark
foreground — `toneGamma`, `BASE_EXPOSURE`, ground FILL, a polynomial lift, a
luminance-gated lift — and each regressed a gate. The ground was simply too STEEP
to catch the light; flattening the median slope from 28 to 8 degrees took the
foreground from V0.63 to V0.88 on its own. The same shape recurs as "an empty
window between two gates": grass density, the surf band's share-vs-stroke, and
the wake's pockets-vs-continuity all had no satisfying value, and in each case
the answer was a different mechanism (smaller features, lace, a second field).

**A self-test with known inputs is the only defence that does not cost a
render.** `reversals()` in `tools/raccoon-outline.mjs` tracked its peak under a
condition where both branches were true, and **returned 0 for every possible
input**. It read 0 on the baseline (correct by luck) and 0 on a probe, and that
second 0 was written up as a confirmed negative result one step from reverting a
change that works. Instruments here fail by returning a plausible WRONG answer,
never by erroring — the tail poisoning a profile's normaliser, smooth normals on
a snout, swapped front/rear views, a crop box measuring a rectangle, a gate
modelling one taper where the geometry had two. Seven of these, and the only
thing that ever caught one was a second measurement of a different kind.

**A per-axis normalisation makes a metric report aspect ratio, not the feature.**
`shoreMaxRun` divided horizontal runs by box width and vertical by box height,
then took the minimum — reporting a 51 px band as a fifth of the frame.

**Read the row profile, not the summary.** A ratio of two extents is blind to the
shape between them: head/body depth held at exactly 1.628 across a waist change
that had collapsed the neck. A bounding aspect approved a head hanging off the
front of the body, because it cannot tell whether depth comes from a deep body or
a protruding head.

**A single view cannot see a cross-section.** Depth is invisible from the front,
width from the side, and the error lives in the RATIO between them. Two
orthographic views is the minimum and they have to be reconciled with each other,
not just each with the model.

**A conformance check cannot see that the surface it conformed to is now the
wrong shape.** `npm run raccoon` passed throughout a skull taper change that
turned the grin into a dark gash, because the markings followed the taper exactly
as `conform` guarantees. The render caught it.

**Any number derived from a count has to be written as a function of it.** The
tail's splay was applied to `i >= 3` — "the top two segments" at five and "the top
four" at seven — and four segments of outward yaw turns the chain sideways
instead of upward. The geometry stayed valid, the gate stayed green, and the
feature quietly stopped working. Same fault twice in two rounds, plus once in
`bibGeometry`. A floor catches "absent"; it does not catch "diminished".

**A capture is the right way to judge whether a character WORKS and a terrible
way to judge FORM.** The box occludes the body, the warm key flattens creases,
and terrain sits behind every silhouette. Eighteen rounds of fine palette work
sat on top of a body that was a snowman with a 0.30 m gap between head and torso,
and the first clean turnaround showed it immediately. Both instruments are
necessary and neither is sufficient: the turnaround finds form, the capture finds
how form lights. A neutral turnaround also flatters a silhouette a warm key will
expose — the ruff's quills read as fur in Blender and as spines in the game.

**Judge anything on the vehicle from the camera the game actually uses.** A
vehicle seen from one vantage for its whole running time has, in effect, one
silhouette. The dorsal stripe, the tail's curl, the tail's splay, the stamp's
height on three walls and the driver's grip were every one of them correct in
isolation and wrong from behind — a fully developed face sat on the hemisphere
the player never sees for ten rounds. `car-back` and `car-chase` exist for this
and should be the FIRST frames checked after any crew or box change. The same
question applies to every mark: **which frames actually show this surface?** The
box has six faces, the flaps cover two, and the game shows one.

## Authoring rules that keep biting

**Author near-neutral to TAKE the light's colour; author saturated to RESIST
it.** The illuminant roughly ADDS its chroma rather than multiplying, and its own
floor is about S0.28 — so a pure grey albedo renders S0.22-0.33, and `fur`
authored at S0.18 and `cardboard` at S0.38 both land on S0.50. `fur` is therefore
authored at S0.05-0.11 to render near the reference. The rule is the PAIR:
getting it backwards is invisible in the def and obvious on screen. It caught the
hubcap (S0.14 lavender rendered PINK), the tyre (blue-grey rendered #334667 H218
S0.50, blue plastic) and `eye` (H341 rendered H300 S0.57, a gemstone).
`saturationGain` is chroma LOST at full light, so lowering it saturates — and it
is inert on these surfaces anyway.

**A low-chroma surface cannot be signed off from ONE light.** `helm` looked
correct on every capture it had ever been judged in, all at hour 0.62; on
`car-fall`'s cool alpine sky the exhaust rendered #445194 S0.54, saturated
cobalt, against a reference part at S0.15. Almost every car capture is hour 0.62.

**Anything bright that meets cyan has to be NEUTRAL, because warm plus cyan
passes through green.** Three instances of one piece of arithmetic: the cell rim
mixed toward mint came out 23-29 degrees off the water, `causticColour` near-white
took the LIGHT's hue at H155-162, and the dusk sun path added the sun's raw colour
and landed at H140. Addition alone is enough — there is no albedo multiply in the
glint. `glintNeutral` pulls it toward its own luminance first.

**A large flat face and a subdivided curved one cannot share an albedo.** The
material's ramp quantises, and a flat slab has one normal over its whole area so
it selects a single stop while a lofted tub averages several. The folded flap
rendered V0.89 against a V0.75 wall — the brightest thing on the vehicle — and
changing its ANGLE moved the figure by nothing, which is worth knowing because
the angle explanation is plausible and I asserted it in a comment before
measuring. Third appearance of this mechanism, after the steering wheel's spokes
reading as a white cross. Either break the flat face's normals up or author it a
stop lower; `graded()` is not enough on its own.

**The pipeline adds roughly 0.24 of chroma between def and screen, and about 1.5x
of value at the lit stop.** Only the RENDERED figure matters, so matching a
reference means authoring well under it: the cell rim is authored S0.11 to render
at the reference's S0.29, and the raccoon mask is authored V0.23 — darker than the
base fur stop, which looks wrong in the file and is right on screen. An authored
number in DISPLAY space multiplying LINEAR albedo needs the same treatment: the
rim's reference ratio is 1.22 and at a literal 1.22 the on-screen step measured
0.000, so 1.22^2.2 is where to start.

**THE (u, v) PARAMETERISATION IS LEFT-HANDED.** `cross(d/du, d/dv) = -cos(v) *
dir`, so an outline walked with both increasing is wound clockwise from outside —
back-facing, and the painterly material is single-sided. **The handedness also
FLIPS at the pole**, as the sign of `cos(v)` reverses past v = pi/2. Five losses
to this: the mask, the blaze, the driver's grin, the "!" glyph (authored facing
+Z when `Matrix4.lookAt` points -Z, so its bar survived culling and its dot did
not — which reads as "the dot is broken"), and 12% of the dorsal stripe. Every
one rendered a feature that was present, correctly placed, correctly sized,
correctly normalled, and drawing zero pixels. **Every new marking goes in
`tools/raccoon.mjs`'s list**, or the tool is decoration.

**`loft`'s `flat: false` takes radial normals in the XZ plane**, so it is only
meaningful for rings stacked along Y. Rings marching along -Z get garbage
normals, and chasing the resulting backfacing as a WINDING problem made it worse
three times running. Build along +Y and rotate.

**When a parameterisation degenerates where you need it, move the geometry into
the parameterisation rather than patching the singularity.** A ribbon along v has
its width applied in u, and u subtends `u * cos(v)` — so a constant-width stripe
up a meridian pinches to nothing at the crown, and whatever floor you pick for
`cos(v)` is exactly where it pinches. Build it along the EQUATOR and rotate the
finished geometry a quarter turn.

**`mergeGeometries` CANNOT SUBTRACT.** If a shape needs material removed, the
baseline has to move down and what is left standing gets added.

**`placeGeometry` composes `T * R * S`**, so a rotation passed to `place` happens
about the geometry's own origin and a `geo.rotateX()` AFTER `place` happens about
the world origin — which swings the part metres away in an arc and reads as a
font bug, not a transform-order bug.

**Derive reading direction, don't guess it.** Text runs left-to-right for a
viewer outside each wall, and which world axis that is flips per wall:
`right = cross(inward normal, up)`. Guessed, it came out mirrored on all four at
once, and the render says only "mirrored" — which gives no clue whether one wall
is wrong or all of them. Four lines of derivation beats four builds.

**Check which datum a ratio is measured from.** A review asked for a projection
of 0.30-0.35 of HEAD DEPTH; setting 0.55 of the RADIUS rendered a proboscis,
because the two differ by more than a factor of two. And `LIFT.muzzle` is
`mm(11.0)` — eleven millimetres — not a fraction of the radius; reading it as one
produced predictions 0.085 m out three times running. Read the constant, or
measure the export.

**A standoff wants to be a fixed small absolute distance.** `LIFT` is written as
fractions of the skull radius for convenience, so growing the skull 16% grew
every marking's real standoff by 16% and pushed the grin past DETACHED.

**Two markings at the same lift are COPLANAR** — they merge into one geometry per
surface, nothing sorts them, and their triangles interleave per pixel. `LIFT` is a
ladder, rungs 1.2 mm apart: invisible as a step, decisive in a depth test. **And a
marking drawn on another marking does not get an independent rung**: the muzzle
pad went in at 0.055 while the mouth was at 0.027 and hid it, which reads as a
missing mouth rather than as depth ordering.

**A check encodes an intent, so it changes when the intent does.** The muzzle was
held to `project` — stand 0.05 m clear or read as absent — which was right for a
snout and wrong for a pad. `conform` is not a loosened bar: it is two-sided where
`project` had only a floor.

**A larger CONCENTRIC sphere cannot reveal a smaller one.** A cream sclera at
1.3x a dark orb renders as two cream beads. The construction is inverted: a pale
eyeball with a small dark iris on its FRONT, offset outboard.

**A two-bone IK does not fail loudly, it clamps and aims** — a straight stick with
a paw in mid-air, which reads as a modelling error in the arm. With Euler order
'YXZ' the aim yaw is `atan2(-dx, -dz)`; the intuitive sign is pi out and swings
every arm to the opposite side of the body. An IDENTICAL miss across all four
paws is what names it: a reach failure varies with the target, a frame error does
not. Order 'YXZ' also applies Z INNERMOST, so a roll term turns the bone before
the aim and moves the chain off target — **the bend plane is fully determined by
(yaw, pitch) and there is no pole freedom here.** To bias which way an elbow
breaks, move the paw TARGET.

**Where two forms merge, the OUTER one has to be wider at every height they
share.** Anywhere the inner form is wider its edge shows; anywhere it is narrower
by more than the outer form's taper, a WAIST appears — and a pinch that flares
back out below it is the clearest possible statement that the animal is two
objects.

**A shape is read by its PROFILE, not its decoration.** Six observers read the
tail as an arm; two rounds of making the rings more legible all helped and none
fixed it, because the thing being misread was the silhouette. A steady linear
taper IS an arm; a raccoon's tail stays fat and pinches only near the end.

**Irregularity has to be in the axis the viewer sees, and it has to live in the
OVERLAP.** The torn flap edge varied tab HEIGHT, which is right face-on and
exactly wrong for a flap seen edge-on all game. And varying width around 1.0 of
the spacing grows teeth with sky between them — every tab must be wider than its
own spacing, with the variation in how much they overlap.

**A regular repeat reads as manufactured trim.** Thirty-one identical beads at
0.086 m — 17x real C-flute — read as extruded plastic; evenly pitched ruff teeth
at one length and one radius read as a gear. Hash the length, and push roughly
every fourth below the base radius so the ring is never a complete circle.

**When a small proud detail keeps reading as a blemish, the question is how far
it stands off the surface**, not where it is or how big. The cheek ruff at 0.02 m
proud selected the material's `top` stop while the face sat on `lit`, so every
clump was a pale SPOT; twice it was moved instead of sunk.

**An applied primitive on a smooth surface reads as applique at any size**,
because the sphere is still visible between the pieces. Four constructions for
one fur ruff — sunken balls (acne), a lofted collar (a sombrero), 26 aimed
pyramids (quills, then chips) — and what worked was a jagged skirt on the
SPHERE'S OWN profile, pushed out per-vertex. A shell taken from the form it sits
on hugs by construction and cannot drift when that form is retuned; `bibGeometry`
uses the same trick.

**An orthographic silhouette is the MAX OVER AZIMUTH**, so a feature that varies
with azimuth is erased from the outline while remaining plainly visible in
SHADING. That reconciles two sets of reviews that read as contradictory — "spiked
collar" and "gear" against "slab" and "poncho hem" — and it is why six rounds of
tuning the ruff's radial reach could never produce the sheet's soft bumps DOWN
each cheek. The mechanism is an ELEVATION lobe, and it has to multiply the whole
offset rather than the jag: applied to the jag alone the smooth ramp rises
exactly where the lobe falls and cancels it to +-0.008 m. The arithmetic to check
is whether the reach swing competes with the surface's OWN curvature over one
lobe period.

## Where the world stands

### Known issue: cast shadows go blue

The most visible fault in the build. Measured on one frame, meadow camera at noon:

```
lit ground          rgb(167,224,95)  H 87  S0.58  V0.88   correct green
cast shadow pool    rgb( 37, 90,117)  H201  S0.68  V0.46   blue, 114deg off
```

Shadowed ground takes the SKY's hue rather than a tint of the ground beneath it.
ART_BIBLE §2 requires about 40 degrees of bias staying in the material family;
the reference runs lit H99 -> shadow H136.

In shadow the direct term is ~0, so the surface renders as albedo x ambient — if
ambient carries full sky chroma the albedo is erased. **The fix belongs in how
ambient combines with albedo: ambient must TINT, not replace.** It is not
reachable from `assets/defs`.

`npm run complaints` gates this and reports 73 degrees, not 114 — it averages the
darkest fifth of the whole frame, so ordinary shading dilutes the pools. Trust
the pool measurement when judging a fix.

### Known issue: the palette only survives in mid-tones

Same frame, sampled across the value range:

```
brightest lit   rgb(175,184,188)  H198 S0.07  V0.74   washed to grey
mid-lit         rgb(109,169,120)  H131 S0.35  V0.66   green, correct
shadow          rgb( 35, 70,119)  H213 S0.70  V0.45   blue
```

**NO PALETTE VALUE FIXES EITHER END.** Two palette corrections were verified
present in the defs while the render did not move, because the authored shadow
colour is overwhelmed by ambient and the authored lit colour by exposure. The two
things to fix are in the material and atmosphere: ambient must tint the shade,
and highlights must retain chroma (the reference's brightest grass is H73 at
S0.34; ours reaches S0.07). This is also why rendered fur is S0.50 against the
reference's S0.28 — the illuminant, not the def.

### Known issue: close-range ground

Mid-distance already passes ABOVE the reference — biome-meadow's near band is
0.0704 against grasslands.jpg's 0.058 — and the deficit is the last couple of
metres, where the tuft lattice leaves the terrain plane visible between clumps.

**THE WINDOW IS EMPTY — do not just turn the density up.** The gate has a CEILING
as well as a floor and the frames pull opposite ways:

```
clutter thin   grass-close      near-noon        rock-collision
1.00           0.0322 passes    0.0943 OVER      0.0943 OVER
0.72           0.0275 FORMLESS  0.0912 ok        0.0943 OVER
0.55 (shipped) 0.0250 FORMLESS  0.0908 ok        0.0907 ok
```

`grass-close` needs >=0.031 to clear FORMLESS; the other two must stay <=0.0929.
Going further needs SMALLER FEATURES, not more of these. Also ruled out by
measurement: the ground material's own micro term (0.18 -> 0.45 reached only
0.0074 and pulled `distinct`'s corridor ratio 2.05 -> 1.74), and near-band tuft
density (already at its 3400 cap).

### Known issue: "I don't see tyre marks"

Marks ARE stamped world-wide (23 cells at peak 0.817, 500 m from the sand pan)
and the main ground material DOES sample the field. The cause is the RESPONSE:
`BIOMES.grass` is `maxDepth 0.07` against sand's 0.10 and snow's 0.35, with
`refill: 20`, so on the default surface a mark is shallow and gone in twenty
seconds. ART_BIBLE §4 authored that on purpose, and the consequence is that a
player driving normally never sees one. **This is an art-direction call about
grass, not a bug hunt in src/deform.** Any change must keep `distinct`'s corridor
ratio >= 1.25 — it was already 0.81 before any of this work.

### Resolved, kept because each was re-derived from scratch more than once

- **Rocks were buried.** `src/assets/generators/rock.ts` derives its lift from
  the solid's measured extent and THROWS if the buried fraction disagrees with
  the authored `embed`.
- **"Distance doesn't read as blue haze."** There was never an engine fault. The
  gate ran a camera at `eye=6` along a near hillside — a frame with no depth
  range, in which no aerial-perspective term can rotate anything. On a vista the
  build scores 111 degrees against the reference's 126. Two further faults in
  that gate: band means were confounded by shadow (shadowed ground goes blue, so
  a shadowed foreground reads as distant), and the metric was UNSIGNED, scoring
  an inverted ladder as highly as a correct one.
- **The foreground was too dark, and the cause was the TERRAIN.** See the
  five-knobs note under "Verifying visual work". Re-greening the palette was part
  of the fix, because stops tuned against the steep world read as straw on the
  flat one.
- **THE OLD `JUMP` SITE NO LONGER JUMPS.** The slope flattening removed it.
  Probed at the exact URLs, frames 150-215 all report `airborne=false` and a
  POSITIVE vy; the car is driving up a hill and the steepest 15 m drop on the
  path is 0.08 m. `car-airborne` and `car-landing` are left alone — repointing
  them rewrites two ratcheted baselines — but they do not test what they claim.
  `car-fall` and `car-thump` use a site found by scanning on a 60 m lattice for a
  lip and give a 3.6 s flight.

## Scatter: pop-in, and the fix that had to be measured in PIXELS

`npm run popin` is the gate; `__trench.scatterAt(x, z)` is the readback.

**THE REPORT HAS BEEN MADE TWICE and the first fix was aimed at the wrong
mechanism.** Bands originally sampled independent jittered lattices, so crossing
a band radius changed which WORLD POINTS could carry a form; that was real, and
fixing it (far bands visit every Nth FINE cell, same hash, same position) left
the actual fault untouched. A band that visits every 2nd cell can carry AT MOST a
quarter of the authored density, so density fell 4x at a hard radius:

```
45- 55 m  31.83/ha      200-230 m  9.87/ha      460-560 m  1.56/ha
55- 65 m   7.96/ha      230-260 m  2.17/ha      560-620 m  0.63/ha
```

Three quarters of everything between 55 m and 230 m did not exist and
materialised the moment the player crossed 55 m. It was the stride's CEILING, not
its alignment, and no amount of care in the lattice's phase could reach it.

**FOUR THINGS THE FIX NEEDED**, all in `src/world/scatter.ts`:

1. **Bands stopped being density steps.** Whether a cell is drawn is now a
   continuous function of distance — `(d0 / d)^1.5` — and bands are only LOD
   rungs and rebuild units. Strides remain as an ITERATION device, because a
   3.4 m lattice out to 1300 m is 460,000 cells; the band radii are pinned to
   `THIN_MAX * 4^(k/1.5)` so the density a form wants at a band's inner edge is
   exactly that band's stride ceiling, and the constructor throws if they drift.
2. **The rank is HIERARCHICAL, and this is the whole trick.** A flat hash would
   make the set a threshold asks for and the set a stride band can offer two
   DIFFERENT sets — continuous density, churning identity, which is the same
   flicker arrived at from the other direction. `cellRank` gives each lattice
   level its own disjoint slice of [0,1), coarser lattices ranking lower, so a
   threshold of exactly `4^-k` selects exactly the stride-`2^k` lattice. The
   threshold and the band agree by construction at every value.
3. **The exponent is 1.5, not 2.** 2 is the screen-area-preserving figure and it
   was tried first: it holds the near field beautifully and GUTS the far one,
   because the step ladder it replaced was much flatter than an inverse square.
   Integrating both against the old ladder, for a form at the 55 m floor:
   `old steps 167,419 m^2 · exponent 2 -> 69,638 (42%) · exponent 1.5 -> 156,353
   (93%)`. Measured whole-frame instance counts: 507 old, 193 at exponent 2, 502
   at 1.5. 1.5 keeps the content budget the build was perf-tuned around.
4. **The grow-in fade, and a streaming step small enough to carry it.** A rank
   cut is a binary event, so each form fades in over its approach by a multiply
   on its instance scale — which costs no shader work and shrinks the collision
   proxy with the mesh, so physics keeps agreeing with pixels.

**AND THE METRIC HAD TO BE PIXELS.** The first version of the gate measured the
fade as a FRACTION of full scale and failed the build on a clover arriving at
0.392 at 49 m — 0.078 m of plant subtending 1.5 px. Re-expressed as pixels of
drawn height it immediately found the real fault, which the fraction had hidden:
`qn-pine-1` arriving at 50 m at 0.18 of scale is **30 px**, because a 10.5 m form
at 50 m is 170 px when whole. A fraction of scale says nothing about whether an
appearance can be seen, and the whole design thins each form where it is SMALL ON
SCREEN — so the gate has to measure the quantity the fix is built on.

That found two more things:

- **`THIN_PER_M` 6 was too small and `THIN_MAX` 70 was a false economy.** Raising
  the ceiling to 100 roughly doubles the instances a tall form places and is very
  nearly FREE, because every one of them lands in the mid field at LOD1/LOD2 —
  band 0 draws everything within 55 m either way, and `THIN_MIN` guarantees
  nothing is thinned inside it. It also makes the lattice CHEAPER, moving cells
  from the fine-stride bands into the coarse ones: 39,553 cells a full rotation
  down to 30,623. The first pass had the trade backwards.
- **A pop is not really about what is drawn, it is about how much can change in
  ONE streaming update.** The old scheduler rebuilt band 0 after 12 m of drift
  and rotated the rest one band per frame. A form's grow-in window is
  proportional to its cut distance, so near the front of the near ring it is
  about 25 m — and a 12 m step therefore jumped half of it at once. Measured, the
  same pine arrived 30 px tall in one step at 12 m and 1.6 px at 3 m. Bands are
  now rebuilt on their OWN staleness against their own tolerance
  (`BAND_TOLERANCE` 3/6/15/40/80 m), one per call, stalest-relative-to-tolerance
  first — which refreshes the near ring four times as often, the 8,000-cell outer
  bands rarely, and costs LESS than the rotation it replaced (~1,600 cells a
  frame at 35 m/s against ~1,900). A ratio cannot starve a near band, because a
  rebuild zeroes that band's own staleness.

**THE GATE'S STEP IS NOT A FREE PARAMETER.** It must be `BAND_TOLERANCE[0]`,
because the metric is what one streaming update can change. Diffing across 12 m
when the near band rebuilds every 3 m measures four updates at once and reports a
pop that never happens.

Where it landed, with both off-cases run:

```
                                        continuity   worst appearance
shipped                                 1.50x        0.2 px     ok
THIN_FADE 0.55 -> 0.02 (cut, no fade)   1.50x       17.7 px     FAIL
BAND_STRIDE back to a ceiling per band  2.54x      138.4 px     FAIL
```

The last row is the original bug, quantified: a 9 m `qn-common-2` arriving whole
at 54 m in one 3 m step. `perf` is `runtime ok` with zero hitches on all three
scenes, and `structure` (52 failing), `distinct`, `hue`, `palette`, `shadow` (24)
and `regress` (99) are unchanged against a baseline captured the same way.

**STILL A HARD EDGE, deliberately:** `SCATTER_REACH`. Nothing is placed past
1300 m, so an instance there has nothing to fade in FROM — it simply enters the
circle. The outermost band tapers over its last 8% to keep the worst appearance
in the frame under the ceiling; every inner boundary is a rung change on a form
that goes on existing in the next band out.

**Two other consistency faults fixed in the same pass**, both of which presented
as pop: the slope test ran only for `band < 2`, so a boulder leaning out of a
cliff existed in the far bands and was REJECTED by the near ones and vanished as
you drove up to it; and the roll now has an exact free prefilter (`rollMax`, the
densest single biome's summed density — valid because weights are normalised and
every other factor is <= 1) which is what pays for the fine lattice reaching
200 m.

## M7: the water

`src/water/` — a cartoon sea with a depth ladder, a cell field, a surf band, a
foam wake, and a surface the car drives on. `npm run water` is 11/11 against
`refs/water/`. `refs/README.md` says what the references govern; the two images
disagree on purpose and the brief picks the CARTOON one for register.

Measured against them: deep water H187-191 / S0.67-0.74 / V0.74-0.76 against
`#31a2bd`; cell spread 0.116-0.155 against the lake's 0.133; border occupancy
0.099-0.168 against 0.157; shore stroke 0.34-0.95% of frame width against 0.63%.

### Four bugs that each presented as a look problem

1. **The whole ocean was invisible.** `polarSheet` wound its rings so the sheet
   faced DOWN and back-face culling removed all 48k triangles. An A/B against
   `?water=0` measured a mean absolute difference of 0.00 per channel over the
   entire frame — and the frames looked plausible, because what they showed was
   the SEABED, which in a coast biome is sand and reads as a beach. Fixed with
   `side = DoubleSide`.
2. **The wake accumulated over four frames**, because `RenderGraph.STATEFUL` did
   not list `water` and `main.ts` fast-forwards captures with `stateOnly`. 99% of
   the stamps had never been issued.
3. **The ring pulses drew nothing, twice.** A ring is stamped as a POINT, so
   `d = b - a` is (0,0), `d.div(len)` is not a unit vector, and every corner of
   the quad collapsed to the midpoint — zero area. Then its BAND was floored only
   through `radius`: a `radius * 0.05` core on a 2.3 m ring is a third of a texel
   and missed every pixel centre. **A ring's radius is not its line width, and
   the guard has to be on whichever is smaller.**
4. **`ringDebt` was deleted with a comment block**, taking the three lines that
   accumulate distance-since-last-pulse with it. `__trenchWater.scan` caught it:
   the field's PEAK was 0.443, exactly the wheel spray's authored amount, so
   nothing stamped at 1.0 had ever been written.

### The cell field, and why every parameter fix failed first

**It was drawing a topographic MAP, not a tiling.** It quantised a noise into
levels and drew the level boundaries, so one blob got about three NESTED contour
rings — the bullseye motif — and contours are level sets, which never cross, so
the field could not produce a T or Y junction at any setting. The per-cell tone
hashed the LEVEL INDEX, so disjoint regions at the same height shared a tone. The
reference is a PARTITION: one rim between neighbours, rims meeting at junctions.
`F2 - F1` of a Worley noise is the Voronoi edge distance and its rims meet at
junctions because Voronoi vertices are where three cells meet. **This is NOT the
lattice that was rejected earlier** — that was a domain-warped SQUARE GRID and it
read as a fishing net because a warp cannot hide a global axis.

**It is a BAKED texture now** (`voronoiTexture.ts`, 1024^2 RGBA, tileable over 8
cells, seeded, cached). `mx_worley_noise_vec2` returns distances, so a cell had no
IDENTITY and its interior could only be a low-frequency noise laid over the top,
which made neighbours shade into one another. A baked texture carries the cell
index. It is also cheaper — `perf` p50 went 14.4 -> 10.9 ms on `driving` — and the
mip chain does the minification the hand-written fades were approximating. One
consequence: mips BLUR the thin rim at distance, so the rim had to get wider and
brighter, which is the direction the reference wanted anyway.

Two bugs in that bake, both found by a pure-JS readback in seconds after three
render cycles had failed to explain them:

- **A log-sum-exp smooth min is BIASED**, by up to `ln(n)/K` — with eight
  neighbours at K=11 that is 0.189 in cell units, larger than `cellRim` itself,
  so every pixel read as inside the rim. Use the polynomial form
  (`min(a,b) - h^2 k/4`), which undershoots only where two distances are close.
- **THE SIGN.** For a pixel inside cell i, `dot(p - midpoint, s_j - s_i)` is
  NEGATIVE. The broken field had mean -1.98 against +0.27, so 100% of pixels fell
  inside `cellRim` and it covered the whole sea as near-white — which presented as
  "the water is opaque and washed out", `deepVal` 0.82 against 0.74, and 57% of
  the open sea scoring as FOAM.

Also: it bakes the ACCURATE border distance (the minimum over neighbours of the
distance to each BISECTOR) rather than `F2 - F1`, whose own literature calls the
result "angular cobblestones". Site jitter is 0.98 of a grid cell, just under the
1.0 that would let a site leave its cell and break the 3x3 search; below about
0.9 the cells come out near-equal in area and read as a regular hex net.

**The rim is a VALUE step, and any colour in it reads as netting.** It used to
`mix(albedo, causticColour, ...)` toward a mint, which rotated it 23-29 degrees
off the water at 0.40 below its saturation — that green net over cyan was the
whole lily-pad read, with 18-33% of water pixels below H180 where the reference
keeps 99.2% inside H180-200. It lifts the ALBEDO now (`cellRimValue` x1.95, then
`cellRimDesat` 0.21 toward the lifted colour's own luminance): a multiply cannot
rotate a hue and a pull toward luminance is hue-preserving.

**Cells are DOMED, not flat.** `flat: cell.z - 0.5` gave every cell a constant
tone and a hard border — "opaque, made of polygons". Fading each cell's tone
toward its own border makes neighbours meet in a gradient, so the partition
arrives as a rim network over a continuous ramp; `plateau` fell 0.575 -> 0.267.
**The per-cell variation itself has to stay** — the reference measures
`cellSpread` 0.133, and cutting `cellAmp` to 0.32 to kill the polygon read took it
to 0.040 against a 0.085 floor. Only the hard EDGE was the fault.

**THE CELL RIM IS ENERGY-PRESERVING.** `rimW = max(cellRim, vFoot * 3.1)` widens a
receding rim so it stays resolvable and `widthFade = cellRim / rimW` takes the
contrast back out — what a mip-map does for a texture. It fixed the aliasing AND
raised the register at once. A view-angle fade is the wrong axis: `dot(n, view)`
cost `water-open` cellBorder 0.170 -> 0.023, because the player's camera is always
grazing. **The quantity that predicts aliasing is contours-per-pixel.**

**The field is scale-invariant, and the pattern stays WORLD-LOCKED.** Cells per
frame width were 2.2 to 30 across the captures against the references' 14.5-28,
and the two frames that MATCHED were the two HIGH cameras — so the base scale was
already right at altitude and shrinking it was not the fix. A screen-locked cell
size is trivial and wrong: the pattern would slide and breathe as the camera
moved. So the octaves are the base scale times POWERS OF TWO, each a fixed
pattern in the world, and the two nearest the pixel footprint are blended. The
spread across frames collapsed from about 14x to 2.2x. Three things that needed:

- **A rim blends as a UNION, not a lerp.** A rim is a sparse presence feature and
  two octaves' rims almost never coincide, so `mix` at a half-and-half crossover
  halves the peak amplitude everywhere — `cellBorder` went 0.168 to 0.001.
  `1 - (1-a)(1-b)` holds 0.75. The flat masses are smooth fields and lerp
  correctly.
- **The rim had to get WIDER, not narrower.** Once cells are locked near 90 px,
  the rim's RELATIVE width is the only thing setting border occupancy. It had been
  cut to 0.095 to calm `water-close`, which was itself a symptom of the oversized
  cells. Fixing a symptom had hidden the cause.
- `causticFade` NO LONGER TOUCHES THE RIM. It falls to `causticDeep` 0.34 in open
  water, so the rim was arriving at 32% of its authored step. The fade is
  physically right for the RIDGE octaves and wrong for a graphic partition the
  reference draws at full strength over its deepest water.

**The tile is NOT legible and that was measured**, not assumed. `TILE_CELLS` 8 is
120 m at the base octave. Autocorrelating a high-passed scanline and looking for
LOCAL maxima beyond lag 60 (the naive version peaks at the smallest lag it is
given, which measures smoothness rather than periodicity): the strongest periodic
peak sits at lag ~380 at both 8 and 16 cells, so whatever has that period is not
the tile. The domain warp in `cellsAt` has a ~3.2-cell period, not commensurate
with the tile, so the sampled pattern never actually repeats.

### The depth ladder and saturation

**The two references CONFLICT on saturation and the ladder settles it.** `deep` is
authored S0.53, rendering deepSat 0.67-0.72 — BETWEEN the lake's 0.598 and the
shore's 0.741, deliberately not at the cartoon value. Pushing it to the lake's
figure was tried: authored S0.32 gave deepSat 0.506-0.54 (below the floor on two
frames), `monotone` 0.60 FAIL, `satDrop` -0.183 against a -0.10 ceiling, and nine
degrees of green-ward hue drift. `satDrop` runs shallow -> deep, so the shore
reference's -0.557 says its DEEP end is more saturated than its shallows, and
lowering the deep end compresses the ramp `monotone` and `satDrop` measure. The
lake is a small body with no sand-to-deep ramp and calibrates no drop. The ladder
metrics win, because they are the ones with a reference behind them on this axis.

`deepSat`'s bracket used to be [0.40, 0.86] — a ceiling 0.26 above the image the
brief names for register is not a ceiling. It is [0.52, 0.80], which brackets
both references. `cellSpread [0.085, 0.19]` and `cellBorder [0.090, 0.26]`
bracket the lake's 0.133 and 0.157; the previous band was a 2.9x over-grant on
the ceiling and let a bright green lily-pad mat through at 0.390 while the gate
said `water ok`.

**The AUTHORED COLOUR is the lever, and it is very nearly 1:1** — `saturationGain`
0.16 -> 0.31 moved the interior by only 0.05, because that term is gated on
`smoothstep(0.03, 0.7, lum)` and deep water sits below the knee.

**The ladder's warm end is the BEACH, and it is NOT a defect.** Band 0 is 29
degrees too orange and 2.4x too saturated against `shore-foam-wake.jpg` — and its
box is y 0.75-0.77 on a camera looking out to sea, which is dry SAND. ART_BIBLE
§4 specifies `wet sand #C9A96F` and `dry sand #EFE49A` and notes that Capy
Castaway sand is near-yellow; `BIOMES.coast` uses exactly those. The mismatch is
between the WATER reference's sand and the PROJECT's authored sand, and
`refs/water/` does not govern that. **Do not "fix" it.** `seabedMix` cannot touch
it either: 0.40 -> 0.26 changed every band by nothing, because that knob controls
how much seabed reads through water and has no reach over dry beach.

### Swash, ripples and the wake

**Waves washing up the beach are a WATERLINE SHIFT, not a depth.** `swashLift` in
`waves.ts`, mirrored in `surfaceAt` so the car floats on the surface being drawn.
Two mechanisms were wrong first, both about the flat shelf: adding the lift to
`depth` on a 1-in-250 coast turns 0.9 m into 225 m of distance-from-waterline, so
wet coverage went DOWN when the swash came on; and an along-shore phase that
turns over inside the VIEW (43 m, then 240 m) has one end running up while the
other drains, so the spatial average never moves. It has to be several times the
visible shore — 1250 m.

**Its gate is a REGRESSION gate and the first two designs passed with the feature
off.** `refs/water/` are stills, and a static surf line photographs exactly like a
moving one, so this metric cannot be calibrated on refs/ and must not claim to be.
The ordinary wave field sweeps the waterline about 80 m on its own, so no
two-frame difference can separate the two periodic terms. Six frames across one
13.3 s cycle can: the swash contributes a single coherent rise and fall, the wave
components contribute scatter. `0.0455 on / 0.0191 off`.

**Bob ripples are RE-STAMPED every frame at a radius from their age**, because a
stamp cannot grow — the field stores an amount per texel, not a shape. They ride
the CONTACT channel so they cannot pile into a slab, and are confined to under
6 m/s. Three failures, all one shape — a mark authored on the wrong side of a
step: amp 0.36 with an age fade was INVISIBLE (an A/B with ripples off gave an
identical radial profile to three decimals); amp 0.92 was a SOLID WHITE DISC; amp
0.60 with the fade was invisible again, and that is the instructive one — the fade
fought the step from the wrong end, dimming exactly the older, larger rings that
carry the spreading read. **The fade had to GO, not be retuned:** `CONTACT_LIFE`
already fades a ring, so the stamp holds one amplitude for its whole life.
`water-bob` exists because at 35 m/s the ripples are swamped by the wake, and
`rippleReach` catches an absent feature while `rippleAlt` catches a merged disc.

**The cornering wake enclosed the middle of the turn circle** — a 139x217 px hole
at 7.8% of frame width against a 5.5% ceiling, a shape a straight-line reference
cannot calibrate. It would have been easy to scope the metric off that frame, and
`shoreStroke` had already had to be scoped off `water-rocks`, so a second scoping
would have been avoidance. The fix is a FEATURE: an inner-arc pulse offset toward
the inside of the turn by `min(3.4, 1.9 * |yawRate|)` m — physically the inner
wheel's wash, with the offset scaling on yaw rate because that sets how tight the
arc is. `wakeFill` 0.439 -> 0.563 (ref 0.562), holes 36 -> 73, holeMax 7.81% ->
5.48%. Raising the wheel spray does NOT reach it: the scrub term 0.30 -> 0.55
moved `holeMax` by 0.03 points, because the spray follows each wheel's own path
and the void is inside the innermost of them.

**Shore lace.** The unconditional `surfLine` strip is gone;
`shoreField = max(wash*lace, surfLine*mix(1,lace,0.6))` stepped at 0.44..0.58.
**The surf band gets its share from OPACITY, not width** — opaque over the inner
45% of a 6.5 m band rather than ramping across 15 m, because wide-and-translucent
is pale WATER: it costs run length without buying share, and at every width that
satisfied `foamShare` the band was a slab. And when `foamShare`'s floor and
`shoreStroke`'s ceiling left no width that worked, LACE broke the tie —
`2 * area / perimeter` falls when a band is broken into more pieces at constant
area.

**`shoreStroke` IS camera-dependent** and is therefore not gated on
`water-rocks`: the same 8 m band reads 11.5 px on `water-vista`, 12.9 on
`water-shore` and 18.6 on `water-rocks`, because that camera stands 8 m from the
band. Normalising in world metres would fix it and nothing in a PNG gives the
gate a world scale.

### `fill` is 1.0 at BOTH extremes, so a FAIL on it is ambiguous

`fill` is `foamArea / (foamArea + enclosedHoleArea)`. A solid slab encloses
nothing and scores 1.000; a mass so broken that the background leaks through
everywhere also encloses nothing and also scores 1.000. Measured both ways in one
session: thickening the stroke gave 0.983, dashing it gave 1.000 with `wakeShare`
collapsed to 0.051. It is still worth having — the reference sits at 0.562, in the
middle — but read `wakeShare` and `holes` beside it. It also read 0.983 on
`water-wake` purely because the trail ran off the corner, so ring interiors
flood-filled as background: **a wake metric can only be trusted on a frame that
contains the wake.**

`holeMax` briefly had a floor and lost it: hole size in FRAME WIDTH depends on the
ring radius on screen, so a floor from the reference's large rings condemns any
frame whose rings are legitimately smaller. `fill` is a ratio inside the wake's
own footprint and carries the floor instead.

### Known issue: the missing pockets, and four mechanisms that failed

The reference's wake carries 121 enclosed pockets and ours carries 2-3. `hull`
matches well (0.485-0.530 against 0.507), so the shape of the envelope is right
and the interior's lace is not. All four attempts are reverted:

```
baseline (shipped)   wakeShare 0.138  hull 0.485  holes 2  fill 0.731
1 PERFORATED FROTH   wakeShare 0.138  hull 0.530  holes 3  fill 0.813 FAIL
2 SPACING THE RINGS  wakeShare 0.065  hull 1.000  holes 0  fill 1.000 FAIL
3 DASHING THE STROKE wakeShare 0.051  hull 0.915  holes 0  fill 1.000 FAIL
4 WIDE RADIUS SPREAD wakeShare 0.064  hull 0.628  holes 1  fill 0.813 FAIL
```

2 is the informative one: isolated hoops have no envelope to be porous INSIDE, so
the reference's 121 pockets are holes in a dense overlapping mass, not gaps
between rings. 4 was an AUTHORING error rather than a refutation — `h^2.2` on h in
0..1 puts most samples near the BOTTOM of the range, not mid-range as intended, so
the mean radius fell and the share halved. A distribution actually clustered
mid-range with rare outliers — triangular or beta, not a power of a uniform — has
not been tried.

A pocket needs a CLOSED boundary, so the strokes must stay continuous, and it
needs the interior not to be paved, so they must not overlap deeply. Those pull
against each other at a fixed stride. **FOUR ATTEMPTS IS ENOUGH TO SAY THE
COMPOSITION IS THE VARIABLE** — the gate is GREEN without any of them, and closing
the count probably needs the wake to stop being only a union of stamped hoops.
Do not spend a fifth round on a constant.

**Retracted on measurement: "every white mark is a solid lump."** Our marks are
EMPTIER than the reference's and their strokes THINNER, not 3x thicker.
`bboxFill` is confounded by chain orientation — ours runs diagonally across a
477x264 box where the reference's runs along a 355x96 one, and a diagonal ribbon
leaves most of its bounding box empty for purely geometric reasons. Same confound
`hull` was introduced to fix for the envelope, applied to per-component boxes.

### Known issue: a moving car has no contact froth, and the field cannot express it

Forward of the hull and to either side the water measures 0.000 foam at any
speed. Two fixes are reverted, and the reason they fail is structural:

- **A bow wave.** To be visible at all a mark has to be authored above the lace
  threshold, which at a fresh mark reaches 0.715; at 0.78 it swept into a slab
  within a second — `wakeShare` 0.15 -> 0.44, stroke 0.0064 -> 0.0167 against the
  reference's 0.0047. Exactly what the continuous hull capsule was deleted for,
  predicted in the comment and walked into anyway.
- **A floor under the hull collar at 0.28.** Invisible, for the same arithmetic
  from the other side: 0.25 is below 0.715, so it is dissolved before it is drawn.
  Removed rather than left in, on the principle that a term that provably cannot
  be seen reads as a feature in the source and is nothing on screen.

**THE CONFLICT IS NOT TUNABLE.** `WakeField` has ONE decay rate, so a mark is
either strong enough to be visible and therefore long-lived — and a continuous
long-lived stamp is a slab — or short-lived and invisible. Contact froth needs a
SECOND CHANNEL with its own faster decay; G and B in the wake target are unused
and the stamp material already writes four channels.

There IS hull darkening, and a claim that there is no contact at all was
retracted: the water under the box measures L0.425 against L0.539-0.575 either
side.

### Known issue: the swell cannot be raised, and the wake is what caps it

```
waveAmp 0.32 (shipped)  everything green
waveAmp 0.34            shoreMaxRun 0.056 FAIL (ceiling 0.055)
waveAmp 0.36            holeMax 0.0558 FAIL (ceiling 0.055)
waveAmp 0.62            deepVal 0.82, foamShare 0.57 — the sea washes out
```

**Raising amplitude alone washes the sea out**, and the mechanism is worth
keeping: amplitude over wavelength is steepness, steepness tilts the shading
normal, a tilted normal catches more sky, and the gate's foam test then scores the
open sea as foam. Scaling `waveScale` with `waveAmp` holds steepness and fixes it
completely. **What stops it is the WAKE**: a taller swell drapes the flat wake
field over a more undulating surface, so the chain breaks up, the cornering void
grows past its ceiling, and `wakeShare` falls to 0.019 at the gameplay camera.
Both attempts to close the void failed — enlarging the inner-arc pulse took
`holeMax` to 0.0578 (a bigger ring draws its own arc) and offsetting it deeper to
0.0603 (it leaves a gap).

### Known issue: near-field water detail, and why `fine` cannot be chased

```
ours water-shore shallows   coarse 0.0403   fine 0.0074
REF lake clean water        coarse 0.0417   fine 0.0164
REF shore pale band         coarse 0.0548   fine 0.0211
```

**COARSE IS DONE** — the cell rims carrying into the shallows filled it. Do not
re-open it from the old 0.0075 figure, which predates the rounded cells.

**FINE is 2-4x short and `causticStrength` is NOT the lever** (0.10 -> 0.17 moved
it 0.0077 -> 0.0074, i.e. nothing). The reason is WAVELENGTH: our shortest
surface feature is `causticFine` at 6.8 m and the reference's filigree is
sub-metre, so no term in the material has a scale that can produce it.

**A sub-metre term WAS built, proven dead, and removed.** A 0.42 m modulation
faded on the pixel footprint changed `fine` from 0.0074 to 0.0077 — and at EIGHT
TIMES the amplitude it read 0.0077 again, identical, because the fade zeroes it
everywhere in these frames. **The reason is camera geometry and it is not fixable
in the material:** `mPerPx` is the length of the world-space derivative, and at a
grazing angle the footprint along the view direction is metres. **The two
references are near-TOP-DOWN images**; their filigree is a product of a footprint
our oblique cameras never have.

**And there is no aliasing to fear anyway.** `npm run crawl` renders each frame
natively and at 2x, box-filters the 2x down, and divides the two `fine` figures.
Every ratio is UNDER 1 (0.66-0.80), so this water does not crawl at all — it is
mildly OVER-blurred. Adding near-field detail is safe rather than risky, and the
existing screen-space fades have room to relax. The supersampled frames still
measure 0.0134-0.0179 against the references' 0.0164-0.0211, which confirms the
wavelength diagnosis independently: the filigree is genuinely absent from the
SCENE.

**`fine`'s ceiling was mis-calibrated and it cost four rounds.** It was set from
`shore-foam-wake.jpg`'s 0.0049 with the cartoon reference left out over its JPEG
noise — and `lake-cartoon-cells.jpg` measures 0.0259 on the same code, i.e. the
image the brief names as the target register FAILS the ceiling on its own texture,
with our open water within 0.001 of it. Four consecutive screen-space fades each
measured as changing nothing, correctly, because there was nothing to fix; two of
them cost real texture. It is bracketed by both references now. **What it can no
longer do is tell cartoon texture from aliasing** — at that window they are the
same measurement. Do not use `fine` to justify removing texture.

Two things worth keeping from that sequence:

- **NEVER key a fade to `dFdx` of a noise.** A screen-space derivative is a finite
  difference over a 2x2 quad, so on a signal that is already aliasing it
  UNDER-reports the gradient and the fade never engages on exactly the content
  that needs it. Every fade in `src/water` keys off the derivative of
  `positionWorld`, which is smooth and therefore meaningful at any frequency;
  each feature divides it by its own wavelength.
- **The shading normal is MIPPED toward vertical.** `pow(dot(n, half), 320)` on a
  field whose shortest component is a 7.3 m sine is an aliasing amplifier — a
  half-pixel change swings the highlight from nothing to everything. Averaged
  over many wavelengths a wave surface IS flat, so blending toward up as the
  footprint grows is the correct limit, and it takes the glint, the diffuse
  flicker and the sky term with it in one move.

### Known issue: the nearest water is a dead wash, and nothing measures it

```
water-rocks px 48-448, 360-468   coarse 0.0075  fine 0.0017  cellBorder 0.000
water-shore px 80-560, 396-450                  fine 0.0034  cellBorder 0.000
REF lake clean water             coarse 0.0378  fine 0.0169  cellBorder 0.050
```

2.2x flatter than the flattest reference band over the part of the frame closest
to the player. `FRAMES` gives `water-rocks` only a `solidFoam` box — no `cells`,
no `ripple` — so this region is measured by nothing and passes.

### Known issue: `solidRings`, and it is FUSED not absent

Measured on `water-rocks` in the gate's own box, listing every connected
component of the foam mask and why the filter rejects it: a 624x303 mass
(rejected, too large), a 445x140 mass (rejected, aspect 3.18), one 104x128
component COUNTED, and a tail of thin fragments. The collars ARE drawn — they are
connected to the surf band and to each other, so they arrive as two enormous
non-compact masses instead of a set of rings. **The historical note for this
metric is "no rock stands in the water at all", which was true then and is not the
fault now:** the reference's 35 compact components come from a FRAGMENTED lacy
outline whose pieces are separate, and ours is over-connected. `foamLace` is not
the lever (2.4 -> 3.05 took the count 1 -> 2 and pushed `shoreMaxRun` onto its own
ceiling). What would reach it is separating the rocks from the surf band, which is
the shore-proximity density below — a change to `Scatter`.

### Coast scatter: a documented compromise, and the arithmetic behind it

**A LATTICE CELL PICKS ONE ASSET AND ONLY THEN CULLS ON WATER DEPTH** — no
fallback. That is the arithmetic behind "no rock is ever placed in the water", and
it survived four plausible fixes (the `wade` semantics, the density, the slope
limit, a missing key in `cloneBiomeStyle`) because none addressed it. Underwater,
every cell that picked a non-wading asset yields nothing, so the wading forms need
a large share of the biome's PICK DISTRIBUTION rather than a realistic density.
Re-picking after the cull would be the real fix and is a change to the scatter's
determinism.

The densities were cut once to protect `distinct`'s corridor ratio (0.81 -> 0.67)
and that was **reversed**: it took `solidRings` 5 -> 0, i.e. no rock standing in
water at all, and "a thick white foam outline around every rock" is the single
most characteristic mark in the cartoon reference. The corridor ratio was ALREADY
failing at HEAD, so the trade was a named art requirement against moving an
already-red metric. The real fix is a shore-proximity density.

**OBSERVED, NOT FIXED:** faceted green forest forms (`bush-round`,
`shrub-broadleaf`) appear on the beach, because `coastality` caps at 0.95 and the
residual 5% of land weight is enough for a high-density forest set to win picks.
The coast biome carries no vegetation on purpose, so the blend is defeating an
authored zero. Raising the coast rock densities made it more visible; it is not
caused by it.

### Known issue: water gate blind spots

- `solidRings`' floor is **1** against the reference's 35, and `water-rocks`
  measures 3. The floor sits 35x under the image it was calibrated on. Raising it
  fails this build immediately, which is the point; it stays a known issue rather
  than a green number.
- `water-dusk`'s sun path is H94-121 S0.33-0.35 against water at H178-180 — a
  57-86 degree rotation, where the MKW reference's glitter measures S0.00-0.11 and
  0-18 degrees off the water beside it. Same warm-plus-cyan arithmetic as the cell
  rim; the rim is fixed and this is not.
- `plateau` is ungated; `coarse`'s ceiling is 0.085 against REF 0.0173.
- `water-dusk` and `lagoon-morning` have no `FRAMES` entries.
- Three brackets are still slack and should stay that way, because the reference
  does not exercise the range the build legitimately uses: `foamShare`
  [0.04, 0.40] against ref 0.056 with ours reaching 0.244 on a surf frame, and
  `shoreRuns` [1.4, 12] against 1.95 with ours reaching 9.42.

**The `--limits` audit's own first formula was wrong**, and `fine` caught it:
taking the largest distance from either edge to any reference reports a reference
sitting exactly ON a bracket edge as 100% slack, because it is then far from the
other edge. It measures the room beyond the OUTERMOST reference on each side now.

### Water apparatus

**`assets/defs/water/*.json` are bundled through `import.meta.glob(..., { eager:
true })`, so editing one does nothing until you rebuild** — unlike a dev server. A
swash-on and swash-off series came out BYTE-IDENTICAL, which looked exactly like
`swashAmp` never reaching the shader; the "on" capture had skipped the build.

**The shot site's seaward heading is load-bearing.** `water-wake` and
`water-wake-turn` both read `wakeShare 0.000` once because the car drove ALONG the
beach — every ring metric in the suite was measuring sand while the material was
fine. `caryaw` was re-derived by sweeping 48 headings and taking the greatest mean
depth over the first 120 m; **the car's forward is `(-sin yaw, -cos yaw)`, hence
`+ PI`**, and three candidate headings drove uphill before that was checked. The
framing is matched to fixed pixel boxes in `tools/water.mjs` — moving `camyaw`
1.5 -> 2.2 to centre the trail took every wake metric to zero on its own. Retune
the boxes with the camera or not at all.

## M3: the raccoons and the kart

`src/vehicle/raccoon.ts` is the model and the rig; `kart.ts` poses it; `box.ts` is
the vehicle's shell and dressing. Twelve joints solved parent-before-child, world
matrices written straight into instanced batches, so a two-raccoon crew with
ringed tails, four-digit paws and a nine-part face is ~15 draw calls.

```
kart total   13,112 triangles   ~30 meshes -> ~150 draw calls with 4 cascades
skull incl. ruff x2  1640      body x2  552      tail x14  1680
```

The stroke font is the largest single item at 1,332 triangles, cheaper than the
shell it is printed on. The ruff is ~700 triangles a head and buys the
character's defining silhouette.

### The face is a THREE-VALUE SANDWICH, and it is spherical caps

Pale brow blaze ABOVE, one continuous dark band ACROSS both eyes and the bridge,
pale muzzle BELOW, plus a dark stripe down the forehead centre. Take any one away
and it is a small brown animal.

**Every marking is a CAP OF THE SKULL'S OWN SPHERE inflated 1.5%.** A flattened
sphere used as a patch is a LENS that intersects the skull — proud at its centre,
sunk at its edge — which is how the v1 mask survived as a crescent on one cheek
and nothing on the other. **Conform every head part to `skullScale`**: the skull is
squashed to (1.10, 0.94, 0.98) and the caps are caps of the UNSQUASHED sphere, so
skipping the squash on one puts it 0.03 m proud at the cheeks.

### The value ladder, from sheet 2

```
muzzle     #c2ad97  V0.76      <- the brightest mark on the animal
chest bib  #9b8375  V0.61
brow band  #99816e  V0.60
fur        #5b4448  V0.36
mask       #4b343d  V0.29
```

The two sheets disagree on ABSOLUTE value (sheet 1 is a lit scene, sheet 2 a flat
sheet) and agree exactly on ORDER, so the order is what gets authored to and the
absolute fur value stays where it is, because that is set by separation from the
cardboard which only sheet 1 shows.

**The mask must be DARK.** It measured #a54756 V0.65 against fur at V0.66 — a 0.01
step where the reference runs 0.16 at half the chroma. Warm-orange fur plus a
crimson mask at the fur's own value plus a fat cream brow IS a red panda's
pattern, and that is what the pair read as. The shaded stop was already right, so
the whole fault was the lit end — and a 0.29 m sphere in sun is nearly all lit
stop. **The muzzle and the brow are NOT the same value**: both drew off `furLight`,
so the muzzle rendered above V0.90 and became the brightest thing on the head,
which is the opposite of what a muzzle is for — at gameplay distance the eye went
to it instead of to the mask-and-eyes combination that is the diagnostic raccoon
read. `furMuzzle` is its own surface.

**The driver gets an open pink grin and the passenger a closed line**, and an
earlier pass ruled that out as "a two-value detail a 40-pixel head cannot hold".
That was wrong: the asymmetry is most of the pair's character — one is delighted
to be driving and the other is holding on. Two batches whose passenger instance is
written at zero scale.

**The coat's value was never wrong; the whole correction was chroma.** Measured
between the two backs at H188-207 S0.53-0.58 V0.23-0.30, it was the only cool
saturated thing anywhere near the subject in an otherwise brown-tan-olive frame,
and two independent critiques called it a teal prop. The joke is that one garment
contains two raccoons, and a garment nobody recognises as a garment tells no joke.

### The rear of the animal is the gameplay view

Quantised, six colours, same code both frames:

```
car-crew  (the FRONT of a head)   V0.20  V0.29  V0.44  V0.57  V0.65  V0.63
car-chase (the BACK of two)       V0.20  V0.43  V0.57   + sky and grass
```

From the front the face carries a 0.45 value spread; from behind there was no pale
stop and no dark mark at all. **The chase camera looks at the backs of two heads
for the entire game and every marking was on the front.** The fix is a dorsal
stripe over the crown, which real raccoons have. This is a knowing DEPARTURE from
the sheet, whose rear heads read by being pale and heavily tufted instead — if the
fur is ever lightened, try the sheet's answer and drop the stripe.

### Sizes that were solved rather than chosen

```
eyeSink        the orb sat 0.006 m UNDER the surface: no eyes on screen for three
               rounds, read as a shading problem on the mask. It depends on the
               eye RADIUS, so halving the eye re-buried it.
muzzleReach    solved so the tip clears the skull by 0.11 m; at 1.35 it cleared
               by 0.057 and read as a nub.
nose           the constraint is the SNOUT, not the face: 0.106 m across on a
               0.046 m muzzle tip is a wart on a cone.
HELM.radius/y  a window between the muzzle above and the box rim below. At y 0.90
               the rim's 9 and 3 o'clock sat 0.11 m BELOW the box rim, so both of
               the driver's paws were inside the box — the wheel was there and
               nobody was holding it.
HELM.grip      0.75 rad is correct from the front and shows from BEHIND as a small
               dark shape with finger ridges attached to nothing. 1.2 brings the
               paws to 1.03 m, near enough the 0.93 rim that the torso covers them
               from astern while they stay plainly on the wheel from the front.
HOVER.rise     0.30 m left the whole body 0.56 m INSIDE the box, so no gap ever
               opens and the pose reads as "they stood up". 1.05 m.
FLAP.rest      measured off VERTICAL, so at 1.0 rad a 0.66 m flap put its tip at
               head height leaning at the camera — every eye-level capture was
               four flaps with two pairs of ears behind them, and rounds went into
               adjusting the RACCOONS against an occluder. Past pi/2 a flap falls
               below its own hinge. 2.05 rad, from the sheet's own 30 degrees.
earOut         1.29, and SOLVED not dialled: `onSkull` does not project onto the
               sphere, it only applies `skullScale` and the taper, so `earOut` is a
               direct lateral multiplier on a root at x 0.1606. It is now at its
               CEILING — the root sits 0.010 m inside the surface and at positive
               values the ear detaches. The residual is at the TIP and grows toward
               it, which is the shape a CANT produces and an outward shift cannot.
earYaw/earTilt the ear is 36% of the head's width, which IS the reference's 30-35%,
               and it still read as a narrow nub: at 0.86 yaw and 0.42 cant it
               presents its EDGE to a front camera and foreshortens to a third.
               The number that matters is the PROJECTED width.
limb taper     the wrist must be narrower than the paw or the limb's end cap stands
               proud and renders as a pale CUFF. Wrong twice, because the paw
               radius and the taper are coupled and the paw shrank in between.
tail overlap   the constraint is at the TIP, not the root. At 0.62 taper a tip ball
               half-length of 0.115 against a neighbour's 0.143 sums to 0.258
               against a 0.25 m spacing — touching, not overlapping — so the root
               merged fine and the last two segments read as a string of pearls,
               exactly where the tail is thinnest against the sky. 1.5 elongation.
```

### The model is a BUST, because the game only ever shows a bust

The sheet's body is as wide as it is tall. Ours sits in a box whose interior
half-width is 0.785 m with two occupants at +/-0.37, which caps a body at 0.38 m
of half-width — so a body that ALSO spanned the 1.12 m from floor to head is 0.55
as wide as tall, which is a rugby ball and rendered as one. The two proportions
cannot both hold, and what resolves it is that everything below the rim is never
seen: a compact 0.76 x 0.76 m egg hung from the head, base floating 0.42 m above
the floor. **And the body's fullness has to be ABOVE the rim** — the widest station
was 0.43 m under it, so the only part of the torso the player could ever see was
the narrow neck above it, which is why the shoulders read as pinched in every
capture while the profile looked correct in the source.

**`BODY_STATIONS` carries width and DEPTH as separate columns**, and they have
opposite shapes: the sheet's side silhouette holds 126-146 px from the neck to 78%
of its height (a 1.16x variation) while its front widths sweep 1.9x. Depth per
station is set so `rad * depth` is roughly constant through the middle. Note that
the depth column MULTIPLIES rad, so cutting `rad` for a waist cuts the neck's
depth with it — nothing in the front view can see that, and the head/body depth
ratio held at exactly 1.628 across the change while the curve between the extents
had collapsed.

**The skull has TWO tapers** (`headDepthTaper`), because no single multiplier can
satisfy both views: the side was too shallow at the crown while the front had the
same stations correct across. A cranium IS deeper than it is wide. The two tapers
are identical from t -0.14 down, so the jaw, the muzzle and every marking on them
are untouched. **The gate failed this change, wrongly** — it modelled the skull as
isotropically tapered, so its implicit surface became shallower than the geometry
and correctly-hugging markings reported 0.042 m of standoff and were called
DETACHED. Acting on it would have meant thinning the `LIFT` ladder to fix a fault
in the ruler. **A per-axis term has to be added to `conform` and to the gate's `F`
in the same edit.**

### Where the silhouette fit stands

```
front   aspect  sheet 0.654  build 0.644   rows within 0.12 except row 23, the
                very base, where the sheet has FEET and this model has none
side    rows 0-22 all within 0.10, most within 0.06; row 23 is the feet again
body  d/w  0.590 (sheet 0.59)     head  d/w  0.901 (0.96)
head/body  w  1.048 (1.01)        head/body  d  1.600 (1.65)
```

**The waist's height cannot be settled from a silhouette.** Both landmarks the
alignment rests on are above y 1.320, so anything below the cheek is
extrapolation, and the two available methods disagree by 0.45 there. A third
landmark would fix it and neither image offers a clean one. The current placement
is ONE defensible choice, not a measured fact — do not spend a round moving it on
silhouette evidence.

**The snout's remaining fault is the NOSE and it is a CHAIN, not a free
parameter.** `push = LIFT.muzzle + t^1.8 * muzzleReach`, swept; 1.85 is marginally
best and 1.8 ships because y 1.337 jumps 0.064 m between 1.85 and 1.9 as the
frontmost point switches rings. Every sample the muzzle owns is inside 0.030 m;
both the nose's are 0.10-0.12 out. At the nose's own heights the muzzle is itself
0.041-0.051 too far forward, so a fully hidden nose would still leave that — **the
muzzle has to recede before the nose can follow.** `muzzleReach` is not the lever:
the tip already matches to +0.004 m. Two measured negatives from the same sweep:
top-edge taper 0.55 -> 0.80 made it WORSE (0.0333 -> 0.0351), and stations 5 -> 8
made it worse at every exponent, because more rings make the lofted surface FULLER
— the station count is load-bearing, not a quality dial, and raising it means
re-sweeping the exponent.

**Landmark alignment is the reusable part.** Pick two features both images
certainly share, map linearly between them, read targets in METRES. And
**decompose per station** — "is the bare sphere already wider than the target
here?" is the right way to split a silhouette fault between the skull and the
ruff. **A ROW INDEX IS NOT A LANDMARK**: `raccoon-profile.mjs` normalises over
total height, which aligns anatomy only if both subjects have the same
head-height fraction, and ours is 57% against the sheet's 48% because ours is a
bust. The 24-row table is actively misleading below the chin; use it for the head
and measure the body in metres against converted targets. Its headline count went
6 -> 7 on the change that cut the waist's metre error 4.5x.

`raccoon-profile.mjs rear` exits 2 on purpose. Both rear-view raccoons have the
TAIL across the bottom of the body and the build's ortho render excludes the tail
(it splays wide and poisons the normalisation), so any rear crop either includes a
mass the build does not have or clips the height and breaks the normaliser. **The
rear view's value was never silhouette; it is the seam down the spine and the
faceting across the shoulders, and no row profile measures either.**

### The tail took four rounds and taught the same lesson from four angles

- **Solve it against the CAMERA, not the rim.** At 0.55 rad a joint the chain
  totals 2.2 rad, which arcs the tip up and then FORWARD over the animal's own
  shoulders. It was correct, above the rim, and behind the body it belongs to.
  "Clears the rim" was the wrong constraint and the right SHAPE of one, which is
  why it survived three rounds: the question is never whether a feature is above
  an obstacle, it is whether a ray from the actual camera reaches it.
- **Solve the overlap at the TIP, not the root.**
- **Solve the splay PER SEGMENT against whatever that segment is inside.** 0.30 rad
  at the base plus 0.24 a joint sums to 0.64 m of lateral travel on a base already
  0.545 m out, putting the tip at x 1.19 against an outer wall at 0.86 — with two
  segments crossing the board. The splay starts at the first segment above the
  0.93 m rim.
- **A foreshortened ringed tail reads as a SLEEVE.** From directly behind, a row of
  alternating light and dark segments compressed along its length is exactly a
  sleeve with a cuff. Rings only read as rings when the thing they wrap has
  visible length; the splay above the rim went 0.30 -> 0.52 to turn it ACROSS the
  view.

### The box

**FRAGILE is a STROKE FONT, because the material has no UVs** — it works from
`positionLocal` / `positionWorld` / `normalWorld`, which is why `mergeParts` drops
every attribute except position and normal. `GLYPHS` in box.ts is a 13-letter
single-weight stencil, each stroke one thin box merged into the existing ink
batch. Single-weight and cornered on purpose: it is what a depot stencil looks
like, and the only style that survives at the size it is printed.

**The two flap pairs do different things**, and that is what unlocked it. Uniform
flaps had no working angle — near horizontal they shelf 0.66 m out at rim height
and occlude the crew's faces; drooping to 30-45 degrees they cover the FRAGILE
stamp. Three rounds went into moving one number between two failures.

```
side flaps  2.85 rad   folded flat DOWN the outside of the long walls. That pale
                       band across the top 60% of the side, with a notch where two
                       flaps meet, is the most distinctive thing about the sheet's
                       3/4 view and the build had nothing like it.
end flaps   1.78 rad   sticking out, 10 degrees below horizontal. This pair carries
                       the wind and the impact kick.
```

A flap folded flat has nowhere to swing, so its airflow term is scaled to 0.14 and
its impact share to 0.18 — at full strength the wind peeled it off the wall.

**EVERY MARK ON THIS BOX HAS BEEN MOVED DOWN ONCE**, always because a flap shelves
out from the rim and shadows the top of the wall beneath it. **The order is fixed:
decide the flap's rest angle, work out where its tip lands, and only then place
anything on that wall.** Doing it the other way round has cost four capture rounds.
Three faults were invisible at full frame and obvious at 4x: the rule around
FRAGILE cleared the F by 0.06 m which perspective closed to nothing, so it
rendered "|RAGILE"; "THIS" was buried under a tear line so the stamp read "SIDE
UP"; and the REAR stamp — the one that exists because the chase camera looks at
that wall all game — was completely hidden under the rear flap's 0.51 m shelf.

**Put the mark where the camera is.** FRAGILE goes on both long sides and on the
REAR, which is a deliberate departure from the sheet: the chase camera sits behind
the kart for the entire game, so the rear wall is the most-looked-at surface in
the project and it was carrying three abstract code bars. Those bars are gone —
an abstract mark reads as nothing on a vehicle where every other mark is a word or
a piece of tape.

**THE SHEET TEARS THE TAPE, NOT THE BOARD.** The hand-torn flap edge was mine, and
three separate critiques flagged it in three different words — saw-tooth fringe,
ribbed pegs, dentil moulding — each reading it as manufactured trim or as a WOODEN
crate, which is the one thing this box must not be. The sheet's top edge is a
smooth line and the only ragged thing on the vehicle is the zigzag bottom of a
tape patch. Reach is 0.26 of the board's thickness now, a waver in the silhouette
rather than a battlement.

**The tape is patches, not a band.** A girth band crossing all four corner folds
was its whole argument and is not what the sheet does: three or four separate
angled strips per face with torn ends. A continuous band reads as racing livery; a
scatter of patches reads as a box that has been opened and shut a few times.

**The exhaust is TAPED ON**, with a Y-branch at one end and a bolt-eye flange at
the other, in the same cool lavender as the hubcaps and the wheel. It is the
clearest single statement of what this vehicle is: two animals have taped a car
part to a box because cars have one, and it is connected to nothing. It goes on
the wall the FRAGILE stamp is NOT on — printing both lost both and made the
vehicle symmetric, which a scrounged one is not.

**Two things were reused from the wrong place.** The hub was built with
`wheelGeometry` at a smaller radius, so every wheel carried a 0.19 m toothed disc
inside a 0.40 m toothed tyre — read as a mechanical wheel housing, shifting the
vehicle from "wagon with bolted-on wheels" to "off-road buggy". A convenience
reuse that changed what the vehicle IS. And the tread lugs went 0.13 of the radius
(a cog) to 0.085, which keeps the rotation cue a bare cylinder under a
world-projected material has at no speed, without a toothed silhouette.

**THE "WAGON HANDLES" WERE THE END FLAPS**, seen edge-on — symmetric, the same
tan, the same height on both sides. There is no handle on this vehicle and there
never was. That was the third thing to turn out to be a misread of the sheet
rather than a gap in the build, after the tails and the empty box rear, and two
independent observers have since made the same misreading. **Zoom every view
before adding anything:** a 2752 px sheet viewed whole is about 700 px a view, and
at that size a flap and a handle are the same object.

### Three things that are ON-MODEL and were nearly "fixed"

- **The reference shows tails from directly above and nowhere else.** The front,
  3/4 and side views contain no tail at all. A tail tucked behind a body inside a
  box is what the reference draws; two rounds went into making them visible from
  the chase camera on the assumption that a hidden tail was a fault.
- **The empty rear of the box.** The sheet's top-down has the pair hard against the
  front with roughly 45% of the interior empty behind them.
- **The bold forehead stripe.** The reference's stripe measures #614a43 V0.38
  against its own eye-mask band at #65484d V0.40 — the same value.

**NOT TAKEN: a hard black outline on the muzzle.** The concept sheet is inked and
this build is not; nothing in `refs/` uses cartoon strokes, and adding ink to one
surface would make it the only outlined thing in the game.

### The idle layer, and the impact responses

`car-idle` and `car-idle-b` are the same URL 48 frames (0.8 s) apart, which is
what makes M3's oldest requirement measurable — nothing checked it, and every
spring in kart.ts could have settled to a constant without erroring. It has to be
subject-vs-control: the grass has its own wind and moves 12.9% of its pixels over
the same 0.8 s, so a completely dead kart in a live meadow scores well on a
whole-frame difference. The check is the kart's box against an equal area of empty
meadow, and the bar is a RATIO.

**A SPRING THAT RISES AND FALLS AT THE SAME RATE HAS NO LANDING.** `hover` is
0.9 Hz, so 0.07 s after touchdown it still measured 0.95 and the crew were
photographed floating above a box that had already hit and squashed. The fix is a
velocity KICK off `landingImpact`, not a faster spring, because the asymmetry is
the point: going up is free-fall drift, coming down is a cardboard box arriving
underneath them at 30 m/s. It needs a FLOOR — unbounded it rang to -0.48, the
whole crew through the bottom of the kart — and the floor has to **kill the
velocity, not just clamp the value**, or the spring winds up below the floor and
springs back out half a second after the landing it belongs to.

**A still cannot show a kick.** Two rounds went into reframing `car-thump` to
answer "do the flaps and ears react to a landing", and that is not a framing
question — a flap at 3.19 rad photographs identically whether it was kicked there
or authored there. The only honest form is a DIFFERENCE against a control:

```
                    front flap   ear flick   tail root
parked (control)      2.69 rad     0.00        -0.04
landing +0.03 s       3.16         0.10        -0.04     <- ears and tail: nothing
landing +0.03 s       3.16         0.47         0.18     <- after the fix
```

### The pair were one animal twice

Every geometry is a two-instance batch, so the two raccoons were identical down to
the ruff, and a critique of the gameplay frame called them "one clone pasted
twice". The sheet draws them different — the driver bulkier and shaggier, the
passenger smaller and smoother. `Occupant.size` is a per-instance UNIFORM scale on
the seat joint, 1.00 and 0.93: no geometry, no batch, no draw call. **Uniform is
not a preference** — `Joint` composes its scale into the world matrix and children
inherit it, so a non-uniform value shears everything below and would hand a
slightly skewed skull to every face marking. The IK survives it untouched, because
`aimArm` transforms the target into the shoulder's own scaled space and solves
against unscaled bone lengths there; paw miss stayed 0.000 and 0.006 m.

### Identify stray geometry by ELIMINATION

The critic reported "thin spiky slivers clipping through the belly fur near the
paws". Two hypotheses were mine and both wrong — the coat's lapels (flagging
`coat` magenta showed the coat is not in that frame at ALL, so the sample that
"matched" had landed on another surface) and the paws' digits. It was the ARM
BONES: two flat-capped tapered cones meeting at an elbow with no joint between
them, four sharp wedges radiating from the chest. `limbGeometry` is a capsule now,
so consecutive bones OVERLAP into a continuous form and need no joint ball — and a
limb that ends in a dome reads as a limb where one that ends in a point reads as a
spike whatever its length. The lapels came out in the same pass, and that is a
REMOVAL: they had produced an artifact every round since the crew moved forward, a
flat plate cannot describe a fold in cloth, and they are not in the reference.

A "thin pale spike past the near raccoon's jaw" took five successive eliminations
and turned out to be the steering wheel's far rim — geometrically correct, and at
a 0.038 m tube thickness the visible fragment is a thin curved taper, which is a
tusk.

### Known issue: the car frames all fail `structure`

All eleven, every one on flat-tile percentage (12.7% to 41.9% against a 2.7%
reference), because a frame with a kart in it is 30-60% sky against a gate
calibrated on landscapes. Seven predate this work and fail identically, and the
reference character sheet fails the same gate harder than the build does. A
regression check across eight rounds of character work moved these by ±1-2 points
on eight frames and improved `car-airborne` by 11.

`car-crew` and `car-back` had to be ADDED, and `camlift` had to go negative to get
them: the seven original M3 poses frame the kart at 2.3-3.9 m where a head is ~90
px — enough to see that a head is present, not enough to see whether the thing on
it is a mask, which is how a face with no brow blaze, no forehead stripe and no
sclera survived every round it was in. `camarm` alone cannot fix it, because the
rig's height is nearly constant so pulling in only steepens the view until it is
plan-on; the first `car-crew` was a photograph of the tops of two skulls. Solve
it: the real rig is 2.55 m up on a 3.90 m arm, 33 degrees, so at a 1.95 m arm the
same angle needs 1.27 m of height.

### Still open on the characters

- **The rendered fur is S0.50 against the reference's S0.28.** The illuminant, not
  the def. Same root cause as "the palette only survives in mid-tones", and the
  same reason `helm` lands at S0.31 rather than S0.15 — reaching it would mean
  authoring warm, which then tints warm under a warm sun.
- **A spherical cap has a HARD edge**, so it can draw a stripe or a patch and it
  cannot draw a soft broad area of lighter fur. The reference's pale cheek is
  exactly that, and the cheek-flash almond read as a blemish at every size tried.
  It needs a gradient — a vertex-coloured cap — not a bigger almond.
- **The ruff's teeth vary in WIDTH too little**, so it is still closer to a
  sawtooth than to pelt. Length is hashed; width is not.
- **The head's rear flows straight into the torso with no neck in profile**, a
  consequence of holding the neck's depth while narrowing only its width.

## Apparatus

**A uniform-colour capture means the browser never got a GPU**, and the first
thing to check is the launch arguments. Two tools rendered every frame as
rgb(11,13,16) and it was called an apparatus failure both times; the flags were
Vulkan ones written from memory, and Vulkan does not exist on macOS.
**`tools/shots.mjs` exports `WEBGPU_ARGS` — import it, never retype it.** It is
guarded with `if (import.meta.url === ...) main()` so the list and the args can be
imported without running a capture as a side effect.

**`npm run perf` needs `vite preview`, not `dev`.** HMR reloads mid-measurement
and kills the context. And absolute figures drift when another session holds a
browser and a GPU context — `ground-noon` read 10.70 ms in one run and 14.60 ms
with a 79 ms max in the next. **Within-run A/Bs are still sound**, which is why
comparisons should be structured as extra scenes inside one invocation. The A/B
that cleared the water of the `driving` cost was exactly that shape: disabling the
water changed nothing (19.10 -> 19.70 ms) and removing the car recovered 3.7 ms.

(`ps -o etime` is `[[dd-]hh:]mm:ss`. A two-part reading like `05:16` is five
MINUTES, not five hours — misreading that once produced a confident and wrong
claim that a healthy job was hung.)

**`prepareForCompile()` exists because WebGPU compiles a pipeline the first time a
(geometry, material) pair is DRAWN**, and `compileAsync` walks the scene graph, so
it skips anything currently `visible = false` — which is most of the scatter most
of the time. The result was a compile stall the first time each batch streamed in,
which is exactly when the player is driving somewhere new: the first six seconds
of the perf harness's driving scene ran at 24-25 ms against 17-18 for the last
six.

**An `InstancedMesh` with count 0 still issues a draw.** There are ~270 of them
and most are empty in any one biome, so `mesh.visible = count > 0` is most of the
scatter's draw-call cost recovered for one boolean.

### Blender

`npm run raccoon:ortho` runs `blender --background --factory-startup --python
tools/raccoon-ortho.py`. It used to be an ad-hoc script pushed through the
blender-mcp addon's socket into a running GUI Blender, and that apparatus failed
twice: the addon runs on `bpy.app.timers`, so there is no window context and every
`bpy.ops.*` that polls for one fails; and a staleness guard raising `SystemExit`
**took the whole application down**, needing a relaunch and a manual click in the
N-panel that no agent can perform. **Raise `RuntimeError` from anything driven
through that socket, never `SystemExit`.** Headless has neither failure mode. Build
meshes through the data API, not importers.

MCP servers load at session start, so the addon's TOOLS only appear in a later
session; `tools/_bl.py` talks to the socket on 9876 directly, which is the same
protocol, so the channel works in the session that set it up. Watch for a stale
second copy of the addon in the addons directory serving instead of the intended
one.

**Render an ORTHOGRAPHIC view to judge a profile.** A perspective silhouette
tapers with depth and is not the object's profile. And the game's forward is -Z,
the Y-up to Z-up rotation maps that to Blender's +Y, and a camera at yaw 0 sits at
-Y looking toward +Y — **which is standing BEHIND the animal.** Every view labelled
"front", including a whole silhouette fit, was the rear; a near-symmetric animal
made it survivable and invisible.

**A sanity check has to be sensitive to the thing you are changing.** An export
path typo meant the render, the import and the profile all ran, all succeeded, and
measured a four-hour-old OBJ — undetectable from the output, because the script's
sanity check printed the silhouette's bounding box and the bounding box is set by
the HEAD in both axes, so it printed the same three decimals across a 22% change
to the body. Two instruments on the same quantity is the only thing that catches
this class. There is an mtime guard now: if the OBJ is older than
`src/vehicle/raccoon.ts` the script refuses.

## The component map (Olympus)

This repo is indexed into a component map derived from the compiler, not from
guesses. Prefer it over grepping when you need to know where something lives or
what depends on what.

- `olympus_map` — the components and the links between them. Start here to
  orient. Pass `focus` with a block id or name plus `depth` to see one
  neighbourhood.
- `olympus_entries` — for one component, the symbols other components call, with
  `path:line`. This is the "what crosses this boundary" question.
- `olympus_propose` — draw a component or a link that SHOULD exist but does not
  yet. It records an intention; it never asserts the code is there.
- `olympus_highlight` — dim the user's map to the components you are talking
  about. Use it whenever an answer names specific components; it is a gesture at
  their screen, cleared by their next click.

Blocks are `solid` when the compiler found them and `dashed` when someone only
asserted them. Anything you propose stays dashed until real code exists and the
next index finds it, so build the code as well as the proposal.

The map is a snapshot written by the IDE. If it looks stale, say so rather than
working around it.

# Reference board

The diff target for the screenshot harness — not a mood board. Committed.

## What each reference governs

| File | Source | Governs |
|---|---|---|
| `character/raccoon-artstyle-capycastaway.jpg` | Capy Castaway | **Character art style.** Chunky rounded forms, painted fur strokes, dot eyes. Also: painterly foliage, faceted painted rocks, lime-green saturation. |
| `character/raccoon-boxkart-sheet.png` | commissioned concept | **THE CHARACTER AND VEHICLE TIE-BREAKER.** Four views of the actual subject: two raccoons in a FRAGILE box kart, one driving with paws on a steering wheel and an open pink grin, one with both paws hooked over the rim and a closed smile. Governs the face's three-value sandwich (pale brow blaze, one continuous dark band across both eyes and the bridge, pale muzzle below, dark forehead stripe), the ringed tail, the box's stamp and tape, the folded-flat side flaps, the drooping end flaps, the lavender hubcaps and steering wheel, and the taped-on exhaust. **CROP AND ZOOM EACH VIEW SEPARATELY.** Viewed whole, each view is about 700 px and details vanish — three separate "gaps in the build" turned out to be misreads at that size (the tails, which only the top-down shows; the empty box rear, which the top-down also has; and a "wagon handle" that is the end flaps seen edge-on). |
| `character/raccoon-boxkart-sheet-2.png` | commissioned concept | **THE BETTER GUIDE — prefer it over sheet 1.** Two clean panels, RACCOONS and CARDBOARD BOX KART, drawn separately on a flat grey ground: seven raccoon views (front, side, rear, two top-down) and six kart views. Because the character is drawn free of the box and of scene lighting, this is the sheet to take FORM and the VALUE LADDER from. Measured on its front view: muzzle #c2ad97 V0.76, brow band #99816e V0.60, chest bib #9b8375 V0.61, fur #5b4448 V0.36, mask #4b343d V0.29 — the muzzle is the brightest mark on the animal and the mask the darkest. It also shows a large pale CHEST BIB the build had missed entirely, a soft tufted cheek ruff (bumps, not teeth), and no projecting snout. Sheet 1 remains the reference for the pair IN the box and for scene lighting; where the two disagree on absolute value, sheet 1 is the lit scene and this one is the flat sheet, so take the ORDER from here and the separation-from-cardboard from there. |
| `capycastaway/water-lagoon.webp` | Capy Castaway | **Vibrance ceiling + shallow water.** Hyper-saturated teal, painted foam blobs, chromatic aberration, soft haze. |
| `painterly/cliffs-tohad.jpg` | Tohad (ArtStation) | **Master palette.** Pink-lavender clouds, turquoise sea, lime-to-emerald grass. Gouache flat-brush. |
| `genshin/grasslands.jpg` | Genshin Impact | **Historical landform notes / aerial-perspective craft.** No longer the meadow look governor — see `overgrown/`. |
| `overgrown/` (guide) | local `overgrown-portfolio` | **PRIMARY guide for everything except the sky.** Olive ground/grass, soft blue haze grade, warm sun tint, Quaternius vegetation, understory clustering, grass carpet. Living code: `/Users/chloeongsiyi/overgrown-portfolio`. **Sky / sky LUT / clouds stay Trenchcoons Atmosphere.** |
| `mkw/beach-wet-sand-tracks.jpg` | Mario Kart | **Deformation reference.** Dark wet tire tracks in sand, shore foam. The single most literal ref we have. |
| `mkw/water-lagoon-driving.jpg` | Mario Kart | Driving *through* shallow water — spray, sparkle, caustics. |
| `mkw/water-open-ocean.jpg` | Mario Kart World | Open-ocean driving — foam wake, sun glitter path. |
| `water/lake-cartoon-cells.jpg` | stylised concept | **The cartoon water register, and the tie-breaker for it.** Flat graphic cel water; big polygonal light cells with crisp pale borders; a thick white foam OUTLINE around every rock and along the whole shore; flat sculptural rock. Governs `cellSpread`/`cellEdge` and the shore-outline shape in `tools/water.mjs`. |
| `water/shore-foam-wake.jpg` | stylised concept | **Coast-to-sea transition and the WAKE.** A continuous ramp from warm sand through pale mint to saturated cyan (measured H71 S0.17 -> H191 S0.74 across six bands), fine ripple filigree, a white foam ring around a rock, and a chain of overlapping white foam rings trailing a moving object. Governs the depth ladder, the deep colour and wake laciness. |
| `mkw/desert-sunset-haze.jpg` | Mario Kart World | Heavy-atmosphere register. Near-monochrome warm haze, sun bloom. |
| `painterly/desert-hazy.jpeg` | painterly concept | Desert form language + atmospheric perspective depth. |
| `snow/snow.avif` | photographic | **Snow palette + landform.** Blue shadows, dark rock ridges, teal horizon, high-key low contrast. Photographic — governs colour and form only, *not* surface treatment. Snow still renders painterly. |

## Water: two references, one brief, and they disagree on purpose

The two `water/` images are a matched pair and neither one alone is the target.
`shore-foam-wake.jpg` is the photographic-register end — a smooth ramp, fine
low-contrast ripple — and `lake-cartoon-cells.jpg` is the graphic end: flat
masses, hard borders, thick outlines. The brief picks a side ("I want more
cartoony like the graphic"), so where they conflict the LAKE wins on register
and the SHORE image wins on colour and on the wake.

That split is wired into `tools/water.mjs` rather than left to memory: the
`cellSpread`/`cellEdge` floors come from the lake, the ladder and deep-colour
brackets from the shore image, and each metric names which reference calibrated
it. Both references pass the gate.

They are also the reason `tools/structure.mjs` and `tools/palette.mjs` now skip
`shots/water-*.png`. Those two gates fail BOTH water references — "FORMLESS",
"FLAT", "NO SHADOW PIXELS AT ALL", "undersaturated" — because they are
calibrated on landscapes with rock, foliage and cast shadow, and a frame that is
90% open water has none of that. See the note in either file.

## Still missing

- Trenchcoat / cardboard box concept art.

Biome transitions deliberately have no reference: they're derived from continuous
climate fields rather than authored, so there's nothing to match against. See
ART_BIBLE §5.

## Naming

`<source>/<subject>-<descriptor>.<ext>`

# Trenchcoons — Art Bible

Rewritten against the actual reference board in `refs/`. Palettes are read off
those images and are now grounded, not guessed.

## 1. The target

**Painterly, hyper-saturated, soft-lit.** Not photoreal, not flat-cel — *painted*.

Every reference in `refs/` shares four traits, and these are the whole brief:

1. **Saturation pushed well past natural** — lime greens, turquoise seas,
   pink-lavender clouds
2. **Painterly surface treatment** — visible brush character, not photo texture
3. **Soft, tinted, low-contrast shadows** — never neutral grey, never crushed
4. **Atmospheric perspective as the primary depth cue** — distance reads as haze
   and desaturation, not as detail falloff

Simple sculptural forms carry it. Detail lives in the *light and colour*, not in
the geometry or the texel density.

### Who governs what

| Domain | Reference |
|---|---|
| Character art style | **Capy Castaway** — `refs/character/` |
| Vibrance ceiling, shallow water | **Capy Castaway** — `refs/capycastaway/` |
| Master palette | **Tohad cliffs** — `refs/painterly/` |
| Terrain + foliage forms | **Genshin** — `refs/genshin/` |
| Open-world structure, water driving, tire tracks | **Mario Kart** — `refs/mkw/` |
| Heavy-atmosphere register | **MKW desert sunset**, **painterly desert** |

### Correction to the earlier direction

An earlier draft of this doc specced an MKW-forward, physically-plausible PBR
look with AgX tonemapping. **The reference board does not support that.** Capy
Castaway and the Tohad painting are non-photorealistic and far more saturated
than PBR-plus-grade will produce. Two concrete consequences:

- **The material model is NPR, not PBR.** No metal/roughness workflow for nature.
- **AgX is the wrong tonemap.** It desaturates highlights hard — exactly the
  opposite of what these references do. Use a gentle filmic curve with highlight
  desaturation disabled, then push saturation in the per-biome LUT.

Mario Kart still governs *structure* — biome variety, open-world flow, driving
through water, tracks in wet sand. It no longer governs *surface*.

### The honest ceiling

Painterly stylisation is genuinely cheaper than realism, so this direction is
well within reach in a browser. The hard part isn't fidelity, it's **coherence**:
procedural generation tends to produce noisy, evenly-detailed surfaces, and the
references are all about big simple shapes with restrained detail. Fighting that
tendency is the real work.

## 2. Non-negotiable rules

- **Shadows are coloured and lifted.** Tinted toward the sky hue, never neutral,
  never near-black. Deleting this rule deletes the entire look.
- **No PBR specular on nature.** Terrain, rock, bark, foliage are pure diffuse
  ramp. Sharp specular is reserved for water, wet surfaces, ice, and vehicle paint.
- **Light warms hue and raises value; it does NOT raise saturation.**
  Measured within the green material family, lit vs shaded:

  | reference | hue | saturation | value |
  |---|---|---|---|
  | genshin/grasslands | -52deg | **-0.14** | +0.40 |
  | painterly/cliffs-tohad | -53deg | **-0.15** | +0.33 |
  | capycastaway/water-lagoon | +18deg | **-0.17** | +0.43 |
  | character/raccoon | -41deg | +0.08 | +0.67 |

  So a lit surface rotates ~50deg toward yellow, jumps ~0.4 in value, and
  loses ~0.15 saturation. It goes bright and pale-warm, not deeply saturated.

  An earlier version of this rule said the opposite — "saturation increases
  with light... it is what makes the references glow" — and six builder rounds
  worked from it. It was derived from the WHOLE-IMAGE statistic, where
  saturation does rise with luminance because bright saturated sky dominates
  the top of the range, and then wrongly generalised to surfaces. Both are
  true at once; only the whole-image one is what `npm run palette` measures.

  The glow comes from hue warming and value range. Chasing it with saturation
  produces the acid-green plastic look.
- **Distance = haze + desaturation + hue shift toward sky.** Never a grey fog lerp.
- **Big shapes, restrained detail.** Every asset reads as a clear silhouette at
  its LOD2 distance. If it needs detail to read, it's badly shaped.
- **Motion is coherent.** One global wind field; all vegetation samples it.
- **Ambient comes from the sky LUT**, never a constant.

## 3. The painterly material

One shared material powers terrain, foliage, rock, and props. Per-asset params,
never per-asset shaders.

**Lighting**: 3-stop diffuse ramp (shadow / mid / lit), not N·L. Ramp is
authored per-biome so the shadow stop can be tinted independently.

**Colour**: base / shadow-tint / lit-tint as three separate authored colours,
plus a gradient along the object's up-axis (grass tip lighter, rock base darker).
This vertical gradient is doing enormous work in the Genshin and Capy references.

**Brush texture**: a triplanar-projected stroke overlay, modulating value and
saturation slightly. Low frequency, low amplitude. Turning this off should make
the scene look flat-cel; turning it up should look like gouache.

**Rim**: soft sky-coloured rim on foliage and characters. Sells volume without
specular.

**Wind**: vertex displacement from the global wind field, stiffness per asset.

## 4. Palette

Read from the references. Hex values are anchors, not law.

### Master (from Tohad cliffs — the palette spine)

```
sky              #3FA9F5     cloud pink    #F0A8D0
sea turquoise    #2FD5C8     cloud lavender#B8A8E0
grass lime       #A8D93C     path lavender #C8B8E8
grass mid        #6FB03F     cliff cream   #EFE4D0
```

Note the clouds are **pink and lavender**, not white. That single choice is
worth more than any amount of shader work.

### Meadow / hub
```
ground base #6FB03F   grass tip #B8E84F   grass shadow #3F7A3E (green, not grey)
rock lit #A6B8C4      rock shadow #6F86A8 (blue)   dirt #8B6A45
fog #BFE0F0           density 0.7x        sun warm white #FFF6DC, high
```
Deformation: shallow ruts, grass flattens and springs back over ~20s; mud shows
only under hard cornering.

### Coast / lagoon — *the showcase biome*
```
shallow water #5FE0D0   deep water #2FA8C8   foam #F8FFFC
wet sand #C9A96F        dry sand #EFE49A     (Capy Castaway sand is near-yellow)
fog #CDEFF0             density 0.5x, bright
```
Two water registers: **Capy Castaway painterly** for lagoon/shallows (opaque
turquoise, painted foam blobs, visible submerged terrain), **MKW** for open
ocean (foam wake, sun glitter path). Blend by depth.
Deformation: wet sand holds sharp dark tracks — see `refs/mkw/beach-wet-sand-tracks.jpg`,
the most literal reference we have. Tide erases on a cycle.

### Forest
```
canopy lit #7FB53C    canopy shadow #3F7A2E   bark #8B4A3A (warm red-brown,
understory #2F5F2E    leaf litter #A8823F      per Capy Castaway — not grey-brown)
fog #A8CF96 (green-tinted)   density 1.0x, god rays through canopy
```
Deformation: leaf litter scatters, mud beneath, marks persist long. Highest
contrast between disturbed and pristine.

### Alpine / snow — *the showcase biome*
Read from `refs/snow/snow.avif`. That reference is **photographic** — it governs
palette and landform, *not* surface treatment. Snow still renders painterly.
```
snow lit    #F4F8FC (near-white, faint cool cast — not pure white)
snow shadow #A8C4DC (unmistakably blue, low contrast against lit)
exposed rock #3A3F42 (dark, wet-looking — high contrast against snow)
meltwater   #6F93A8
sky horizon #7FC4C8 (teal — close to the lagoon turquoise, ties the palette)
sky zenith  #4A8FC4      cirrus #E8EEF2 (wispy, high, thin)
fog #DCEEFF   density 1.8x   sun cool #EAF4FF, low angle
```
**High key, low contrast.** The whole biome sits in the top third of the value
range. Resist adding contrast to "make it read" — the reference gets its
readability from the dark rock, not from darkening the snow.

**Landform**: smooth, rolling, wind-sculpted. Low-frequency noise, much smoother
than the faceted Genshin rock planes — with occasional **sharp dark rock ridges
punching through**. Those ridges are doing all the compositional work: they break
the white expanse, give the player landmarks to navigate by, and are the only
place high contrast is allowed. Terrain generation must produce them
deliberately, not as noise artefacts.

Deformation: **deepest ruts**, up to 0.35m. Refills over ~90s. Deep ruts expose
dirt and rock. Compacted snow is shinier than fresh. Tune this biome first — it
has the largest visible range between pristine and disturbed.

### Desert
```
sand lit #EFD08F      sand shadow #C08F5F (warm, never grey)
rock #B87A4F          distant haze #F0C89F
fog #F5D8B8           density 1.4x, rising to 2.5x at golden hour
```
Both desert references are heavily hazed — this biome runs the **Sky register**
by default, not the bright one. At sunset it goes near-monochrome warm-pink per
`refs/mkw/desert-sunset-haze.jpg`.
Deformation: ruts collapse fast (~8s), sand sprays at high slip.

### Wetland
```
mud #5A4632   disturbed mud #332618   standing water #5A7A4A   reeds #9FB855
fog #C8D8B8   density 1.6x, low-lying ground mist
```
Deformation: **longest persistence**, essentially permanent until rain. Highest
friction penalty.

## 5. Biome transitions — geographic, not authored

**Biomes are not painted regions with blend bands between them. They are a
classification of continuous climate fields.** Get the fields right and plausible
transitions fall out for free.

Three continuous fields, all smooth, all noise-perturbed:

| Field | Driven by |
|---|---|
| **Temperature** | falls with elevation, falls toward the world's polar axis |
| **Moisture** | noise + proximity to water |
| **Elevation** | the heightfield itself |

Biome = a lookup into those three (Whittaker-style). Where the classification is
ambiguous, blend the top 2–3 weights. There is no special-case "transition band"
code path — ambiguity *is* the transition, and its width is set by how fast the
fields change, which is exactly how it works in nature.

The payoff: impossible adjacencies become impossible by construction. Desert
cannot touch snow, because getting from hot-dry to cold-dry means crossing the
temperatures in between. No adjacency graph to hand-maintain.

**Coast is the exception.** Beach is a function of distance to sea level, not of
climate — so it appears wherever any land biome meets the water, and it always
terminates in sea. Grassland → beach → sea. Snowfield → beach → sea. The beach
band inherits a tint from whichever biome it borders, so a polar beach reads
colder than a temperate one.

The intended journeys, as a sanity check on field tuning:

```
grassland ──────────────────────────── beach ── sea
grassland ── cooler ── snowfield ───── beach ── sea
grassland ── drier ─── desert ──────── beach ── sea
```

Scatter sets overlap wherever weights overlap — a few pines survive into the
meadow's edge, marram grass creeps up off the beach. Fog colour, fog density,
and the grade LUT all lerp on the same weights as the splat.

## 6. Characters

**Capy Castaway is the style authority** — `refs/character/`.

- Chunky, rounded, low-poly forms. Volume reads from silhouette alone.
- Painted fur: directional brush strokes in the albedo, lighter at the tips.
  Not fur cards, not noise.
- Simple dot / slit eyes. Minimal facial geometry, expression from shape.
- Warm saturated browns for the raccoons; the mask reads as a strong dark shape.
- Soft sky-tinted rim, no specular except on the eyes.

The cardboard box is a strong asset: matte, fibrous, warm neutral against every
biome palette. Lean on it. The trenchcoat should get simple cloth motion from
the same wind field as vegetation.

## 7. Post

Order and intent:

```
bloom            generous, low threshold — the references glow
tonemap          gentle filmic, highlight desaturation OFF (not AgX)
per-biome LUT    lerped across transition bands; this is where saturation is won
chromatic ab.    subtle but present — clearly visible in both Capy refs
vignette         very slight
sharpen          none
```

Chromatic aberration is a deliberate signature here, not an artefact. Keep it
tasteful at the centre and let it grow toward the frame edge.

## 8. Time of day

Default and hero state: **mid-morning** — warm high sun, light haze, maximum
readability.

Golden hour and dusk escalate into the heavy-atmosphere register (see the MKW
desert sunset ref): fog density up sharply, palette collapses toward
near-monochrome warm, sun bloom dominates the frame. That escalation is free
range and should be used.

## 9. Weather

| Weather | Treatment |
|---|---|
| Clear | Default. Bright, saturated. |
| Rain | Desaturate ~25%, wet specular, screen droplets, **washes marks away** |
| Snowfall | Heavy fog, flat light, accumulation refills ruts |
| Fog | Heavy-atmosphere register — silhouettes only |
| Storm | Dark grade, lightning key flashes |

Weather driving the deformation system — rain erasing marks, snowfall refilling
ruts — is the highest-value systemic tie-in available. Don't defer it.

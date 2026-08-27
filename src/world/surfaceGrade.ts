// Corrections to the shared surface defs, applied at the point of use.
//
// WHY THIS EXISTS AND WHY IT IS NOT A DEF EDIT. `assets/defs/surfaces/*.json`
// was authored for the painterly direction, and the art direction has changed:
// no brush overlay, no hyper-saturation, clean colour. The defs are shared
// (`src/assets` resolves them for the whole scatter library, and the Forge
// reads and writes them) and they are outside this team's ownership, so the
// corrections live here and are applied wherever the WORLD builds a material.
// The defs stay the single authored source; this is a documented, measurable
// delta on top of them, and deleting this file returns the old look exactly.
//
// WHAT IS WRONG WITH THEM, measured off the build rather than asserted:
//
//   foliage  ambient 0.36 with base #2f7c1b and shadow #1c5226 — a conifer
//            renders as a near-black silhouette. ART_BIBLE §4 authors the
//            canopy at #7FB53C lit over #3F7A2E shaded, which is a whole value
//            register higher.
//   bush     ambient 0.30, base #1b4d26, shadow #143a38. The shadow stop is
//            blue-grey, not green, and the body reads as burnt charcoal.
//   bark     shadow #6b4560 is PURPLE (hue 292). ART_BIBLE §4: "bark #8B4A3A
//            (warm red-brown, per Capy Castaway — not grey-brown)".
//   sand     shadow #c98ba0 is PINK. ART_BIBLE §4 coast: "wet sand #C9A96F".
//   cliff    shadow #a08cc8 is lavender — a master-palette cloud colour that
//            arrived on a rock face.
//   rock     shadow #4d6288 measures luma 0.17 against the reference's darkest
//            rock facet at 0.40. Every rock in the frame is a navy chip.
//
//   ALL OF THEM  `reliefShade` 0.6-0.88. This is the one that is not a colour
//            problem. It modulates the AMBIENT by the brush field's height, and
//            it is NOT scaled by `brushStrength` — so zeroing the brush leaves
//            the mottle behind, on the ambient, at full strength. On the
//            modeller's faceted rock, whose entire premise is that a facet is
//            exactly planar so the 3-stop ramp reads it as one flat value, it
//            lands as leopard print. It is the last live piece of the abandoned
//            direction and it has to go with the rest of it.

import type { PainterlyParams } from '../material/painterly'

/**
 * Applied to EVERY surface the world builds, before the per-surface table.
 *
 * These four are the painterly overlay itself. `brushStrength` and
 * `brushHue` are the albedo marks, `detailStrength` the normal perturbation,
 * `regionStep` the coarse mass mask, `reliefShade` the ambient mottle.
 */
const CLEAN: Partial<PainterlyParams> = {
  brushStrength: 0,
  brushHue: 0,
  detailStrength: 0,
  regionStep: 0,
  reliefShade: 0,
}

/**
 * Per-surface colour and value corrections.
 *
 * Hexes are ART_BIBLE §4's, read off the biome block the surface belongs to.
 * Anything not listed keeps its authored value.
 */
const GRADE: Record<string, Partial<PainterlyParams>> = {
  // Forest canopy. ART_BIBLE §4: canopy lit #7FB53C, canopy shadow #3F7A2E.
  foliage: {
    base: 0x4f8f2c, shadow: 0x3f7a2e, lit: 0x9fd45c, top: 0xc2ef78,
    ambient: 0.86, rimStrength: 0.55, midLevel: 0.5,
  },
  // Understory #2F5F2E. The frame's dark anchor is allowed to be dark; it is
  // not allowed to be black, and it is not allowed to be blue.
  bush: {
    base: 0x2f5f2e, shadow: 0x2a5340, lit: 0x7fb53c, top: 0x93c74a,
    ambient: 0.78, midLevel: 0.48,
  },
  // The two grass surfaces. `gradientStrength` is pulled back from the authored
  // 0.6/0.35 because it lightens the blade TIP, and a field of tens of
  // thousands of high-contrast tips is a field of isolated bright pixels: the
  // driver's-eye capture measured 0.14% speckle against a 0.02% reference and
  // tile detail 1.5x the reference ceiling. The tip gradient is doing the right
  // thing on one tuft and the wrong thing on ten thousand.
  scrub: {
    base: 0x487f37, shadow: 0x2f6b39, lit: 0x8bbb52,
    ambient: 0.88, gradientStrength: 0.22,
  },
  // "bark #8B4A3A (warm red-brown ... not grey-brown)".
  bark: { shadow: 0x6b4436, ambient: 0.82 },
  // Meadow rock: lit #A6B8C4, shadow #6F86A8 (blue). The shadow stop is a
  // LIFTED blue-grey, not a navy: the reference's darkest rock facet sits at
  // luma 0.40, which is most of what makes Genshin's rock read as sculptural
  // rather than as a hole in the hillside.
  rock: {
    base: 0x8fa6b8, shadow: 0x6f86a8, lit: 0xc3d6e4, top: 0xdcebf6,
    ambient: 1.12, saturationGain: 0.22,
    // `midLevel` 0.62, against the 0.33 default. Measured off
    // refs/genshin/grasslands.jpg, a rock's shadow-to-lit facet ratio is about
    // 0.49; at the default the vertical faces of the modeller's blocks — which
    // are half of every form, by design, because they are cut by fracture
    // planes — received ambient and nothing else and rendered as navy holes.
    // This is the knob that makes a faceted rock read as a solid lit from one
    // side rather than as a silhouette with a bright top.
    midLevel: 0.62,
  },
  // Master palette: "cliff cream #EFE4D0". The shade is a warm grey, not the
  // cloud lavender it had.
  cliff: { shadow: 0xa89a86, ambient: 0.95, midLevel: 0.6 },
  // `mountain` used to dress the greybox's cone skyline, which is gone; the
  // only thing left on it is `outcrop-step`, a piece of scatter you drive past
  // at two metres. Graded to the same register as `rock` for that reason —
  // at the authored #33476c shadow a stepped outcrop in the desert rendered as
  // a navy cut-out against the sand.
  mountain: {
    base: 0x7f92b0, shadow: 0x66809f, lit: 0xb7d2ea,
    ambient: 1.05, midLevel: 0.6,
  },
  // Coast: "wet sand #C9A96F, dry sand #EFE49A".
  sand: { shadow: 0xc9a96f },
  sandPan: { shadow: 0xc9a96f },
  grassMound: { ambient: 1.0, gradientStrength: 0.34 },
}

/**
 * The world's version of a surface.
 *
 * @param surfaceId The def id the asset resolved to. Unknown ids still get the
 *   overlay switched off, which is the part that is not negotiable.
 */
export function graded(
  surfaceId: string, params: PainterlyParams,
): PainterlyParams {
  return { ...params, ...CLEAN, ...(GRADE[surfaceId] ?? {}) }
}

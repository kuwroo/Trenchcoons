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

import { float, mix, pow, vec3 } from 'three/tsl'
import type { Node } from 'three/webgpu'
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
  // ── the scatter library's own surface ids ─────────────────────────────────
  //
  // `stone`, `massif`, `needle` and `leaf` are new, and they were authored with
  // one measured constraint that has since changed under them: in painterly.ts
  // the shadow stop used to be `albedo x ambient` and NOTHING else, so the only
  // way to lift a turned facet to the reference's luma 0.40 was to run the sky
  // ambient at 4.9 — 4.4x the material default. The defs say so, and the fit is
  // sound arithmetic on a broken premise.
  //
  // The premise is now fixed: painterly.ts carries a sun-coloured FILL FLOOR on
  // the shadow stop (see the long note there), which is bounce light and the one
  // direct term a diffuse-only NPR model otherwise has no way to express. So the
  // ambient can come back down, and it has to, because at 4.9 the blue sky LUT
  // is the dominant term in `albedo * (ambient + direct)` and the authored hue
  // stops mattering: every lit rock facet in the build measured hue 176-192
  // against the reference's rock at 117-130. A near-neutral grey-green albedo
  // was arriving on screen as cyan.
  //
  // The numbers are solved, not guessed. Taking the defs' own measured
  // decomposition — sky irradiance x gain = 0.0388 per unit of `ambient`, direct
  // term 1.10, both in linear units at noon — the shadow stop was
  // 4.9 x 0.0388 = 0.190 and is now `A x 0.0388 + 0.11 x 1.10`. Solving that for
  // the same 0.190 gives A = 1.8; `midLevel` is raised by the matching amount so
  // the MID stop lands where it was measured too. The shaded facet therefore
  // stays at the reference's 0.40 and roughly two thirds of the light reaching it
  // is now the warm key rather than the blue sky, which is what moves the hue.
  //
  // `rampShadow` and `rampMid` are the second half, and they are the modelling
  // critic's measured finding rather than a preference. At the authored
  // `rampShadow: -0.05` the shadow stop needs `n.l < -0.05` — a facet more than
  // 93 degrees off the sun, i.e. one that does not exist on a convex solid — and
  // at `rampMid: 0.88` the lit stop needs a facet within 28 degrees of it.
  // Everything between, which is every interesting facet on a fractured rock,
  // was one flat `midLevel`. Measured: rock-medium's five facets read 0.764 /
  // 0.764 / 0.805 / 0.816 / 0.864, with the front and right faces — normals ~70
  // degrees apart — at IDENTICAL luma. Facet spread 0.10 against the reference
  // cliff's 0.28-0.30. Brought back toward the material defaults (0.3 / 0.88 ->
  // 0.26 / 0.74) a facet 75 degrees off the sun selects the shadow stop and one
  // within 42 degrees selects the lit stop, so a three-plane rock reads as three
  // values. The albedo stops are re-separated for the same reason: the def has
  // base #9AA5A4 / shadow #96A3AF / lit #9BA698, all within 0.01 luma, so there
  // was nothing for the ramp to select even where it did fire.
  //
  // The stops are also COOLED, and that is a measurement rather than a taste.
  // The def authors them near-neutral (base #9AA5A4, all three within 0.01 luma
  // of each other), and a neutral albedo under a warm key takes the key's colour:
  // the boulder in shots/rock-collision.png rendered pale CREAM. The reference's
  // rock is not neutral — its lit facets measure #AECBB3 (H129, green-grey) and
  // its turned ones #4281A9 (H204, blue) — so the lit stop goes green-grey, the
  // shadow stop goes properly blue, and the pair spans a hue range the ramp can
  // now actually select between.
  stone: {
    shadow: 0x7d97ba, base: 0x93a6a4, lit: 0xa8bda6,
    ambient: 1.75, midLevel: 0.60, rampShadow: 0.26, rampMid: 0.74,
  },
  massif: {
    shadow: 0x7b96bd, base: 0x8fa3ab, lit: 0xa2b7aa,
    ambient: 1.8, midLevel: 0.60, rampShadow: 0.28, rampMid: 0.76,
  },
  // Conifer tiers. The def's teal is the tie-breaker's own measurement and is
  // kept; only the light rig moves. `rampShadow` stays soft on foliage — a tier
  // plate is not a fracture plane and does not want a hard terminator — but it
  // has to be above zero for the underside of a plate to read as an underside.
  // Ambient 0.8 and midLevel 0.56, both measured against the tie-breaker rather
  // than fitted: refs/genshin/grasslands.jpg's conifers read luma 0.698 on a lit
  // plate and 0.347 on a shaded one, and at 1.1/0.70 over the new fill floor the
  // build's plates came back at 0.63 lit / 0.51 shaded — a pale mint tree with
  // almost no value range, where the reference's has a 2:1 spread. The teal
  // itself is the def's own reference measurement and is untouched.
  needle: { ambient: 0.62, midLevel: 0.54, rampShadow: 0.16, rampMid: 0.80 },
  // The dark anchor. Ambient down for the fill floor; nothing else, because the
  // def's own fit against the meadow ground (body at 0.84x the ground it sits
  // on) is the right relationship and this file must not undo it.
  leaf: { ambient: 0.8, midLevel: 0.48 },

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
  // Measured against refs/genshin/grasslands.jpg rather than authored: the
  // reference's lit grass is hue 93-96 at S0.61-0.64 and this lit stop was
  // 0x8bbb52, hue 84 — on the chartreuse side of the same measurement the
  // terrain palette was just corrected for, and the one surface in the frame
  // there are ten thousand instances of. Blue up, so the hue rotates into the
  // reference's band and the chroma falls into it at the same time. The shadow
  // stop goes sky-tinted for §2, matching the terrain's own new 0x3b6c9a rather
  // than fighting it — grass tufts standing in the shade of a hill that has gone
  // blue cannot stay green.
  scrub: {
    base: 0x477f42, shadow: 0x33655a, lit: 0x84bb5c,
    ambient: 0.88, gradientStrength: 0.16,
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
  grassMound: {
    base: 0x4d8544, shadow: 0x37685c, lit: 0x8ac262,
    ambient: 1.0, gradientStrength: 0.20,
  },
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


/**
 * A per-instance biome tint, as a RATIO against one reference colour.
 *
 * `map` is an sRGB-encoded tap from one of the terrain's baked palette maps —
 * `litMap` for anything growing out of the ground, `cliffMap` for anything made
 * of the same rock the slopes expose. `referenceHex` is what that tap reads in
 * the biome the surface was GRADED in, which for everything in this build is the
 * meadow. The result is 1 in that biome by construction, so adding this to a
 * surface already fitted against refs/genshin/grasslands.jpg cannot move the
 * frame the fit was measured in — it only expresses the DEPARTURE from the hub.
 *
 * Why a ratio and not the colour. Replacing an asset's albedo with the ground's
 * would throw away everything the surface def authors: its three ramp stops, its
 * vertical gradient, the fact that a rock's turned facet is bluer than its lit
 * one. A multiply keeps all of that and moves the whole family, which is what a
 * biome does to a material in the references — the alpine's rock is the meadow's
 * rock in colder light on darker stone, not a different object.
 *
 * @param strength 0 leaves the asset untinted, 1 takes the ground's full
 *   departure. Below 1 on purpose: scatter belongs to its biome without becoming
 *   camouflage against it.
 */
export function biomeTint(
  map: Node<'vec3'>, referenceHex: number, strength: number,
): Node<'vec3'> {
  const lin = vec3(pow(vec3(map), float(2.2)))
  const ref = vec3(
    ((referenceHex >> 16) & 0xff) / 255,
    ((referenceHex >> 8) & 0xff) / 255,
    (referenceHex & 0xff) / 255,
  )
  const refLin = vec3(pow(ref, float(2.2)))
  // Clamped, and both ends matter. Without a ceiling the alpine's near-white
  // snow map divided by the meadow's mid green sends the green channel past 4x
  // and every tuft in the snowfield blows out; without a floor a very dark biome
  // colour divides to near zero and the asset becomes a hole. The floor is 0.10
  // rather than 0.22 because at 0.22 all three channels of ART_BIBLE §4's alpine
  // rock (#3A3F42) hit it at once, which flattens the ratio to a neutral grey and
  // throws away the hue the clamp is supposed to be protecting.
  const ratio = vec3(lin.div(refLin.max(1e-4)).clamp(0.10, 2.4))
  return vec3(mix(vec3(1, 1, 1), ratio, float(strength)))
}

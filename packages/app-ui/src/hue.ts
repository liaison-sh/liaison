// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Identity hue for app surfaces: the SAME scheme the kernel shell colours its
// apps with (apps/web/src/modules/shell/app-color.ts), so a bundled app that
// colours its own items (a monitoring source, a channel) reads as one family
// with the activity rail and the tab strip. The hue is derived from an id,
// never stored; saturation and lightness are fixed per surface. A web unit
// test pins this formula to the shell's, so the two cannot drift apart.

/** Deterministic hue 0..359 for an id (`hash = (hash * 31 + charCode) % 360`). */
export function appHue(id: string): number {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) % 360
  return hash
}

/** A bare glyph or monogram on the app background (the shell's rail glyph colour). */
export function hueGlyphColor(hue: number): string {
  return `hsl(${hue} 48% 52%)`
}

/** A tint of the glyph colour, behind a monogram or as a faint wash. */
export function hueTintColor(hue: number, alpha = 0.14): string {
  return `hsl(${hue} 48% 52% / ${alpha})`
}

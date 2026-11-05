// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A stable colour per app, so a surface is recognisable by its icon before its
// label is read.
//
// It started on the phone Work list (one coloured square per row) and stayed
// there while the desktop rail, the tablet rail and the tab strip drew every
// app in the same grey: a column of a dozen identical monochrome glyphs is
// read letter by letter. The hue is derived from the app id, never stored, so
// a newly installed app colours itself and no registry needs an entry.
//
// Hue ONLY. Saturation and lightness are fixed per surface so the icons read as
// one family in both themes rather than as a bag of arbitrary colours, and a
// glyph on a plain background gets a lighter value than a white glyph on a
// filled square.

/** The app's hue, 0-359. Deterministic, collision-tolerant: two apps sharing a
 *  hue are still no worse off than the all-grey rail they replace. */
export function appHue(appId: string): number {
  let hash = 0
  for (let i = 0; i < appId.length; i++) hash = (hash * 31 + appId.charCodeAt(i)) % 360
  return hash
}

/** A filled square behind a white glyph (the phone Work rows). */
export function appSquareColor(appId: string): string {
  return `hsl(${appHue(appId)} 52% 45%)`
}

/**
 * A bare glyph on the app background (activity rail, tab strip). Lighter and a
 * little less saturated than the square so it clears the dark theme's
 * background without glowing on the light one.
 */
export function appIconColor(appId: string): string {
  return `hsl(${appHue(appId)} 48% 52%)`
}

/** The app that owns a tab type (`tickets:ticket` -> `tickets`). */
export function appIdOfTabType(tabType: string): string {
  const colon = tabType.indexOf(":")
  return colon === -1 ? tabType : tabType.slice(0, colon)
}

// ── Pills ────────────────────────────────────────────────────────────────────
//
// The action pills on approvals ("Tickets: reply", "Shopify: create discount")
// take their app's hue too, so a pile of approvals sorts itself by app at a
// glance. A pill is TEXT on a tint, so it needs its own lightness pair per
// theme: the square and icon values above are for glyphs, and black text on a
// 45% square or 52% text on a 94% tint both fail contrast.
//
// The colour says WHICH app, never how urgent: no hue is reserved for risk, and
// every pair clears WCAG AA (4.5:1) for its text at every hue in both themes
// (app-color.test.ts sweeps all 360). The worst cases are yellow in light
// (about 5.0:1) and blue in dark (about 7.0:1).

/** Saturation and lightness, in percent; the hue comes from the app id. */
export interface PillSL {
  s: number
  l: number
}

export interface PillPalette {
  background: PillSL
  text: PillSL
  border: PillSL
}

export const APP_PILL_PALETTE: Record<"light" | "dark", PillPalette> = {
  light: { background: { s: 60, l: 94 }, text: { s: 55, l: 28 }, border: { s: 50, l: 82 } },
  dark: { background: { s: 35, l: 18 }, text: { s: 60, l: 78 }, border: { s: 35, l: 32 } },
}

/**
 * Actions that belong to no app (the kernel's own: "Kernel: update skill")
 * keep a neutral pill. A missing app id is treated the same way, so an older
 * cached approval without a tool name never gets a colour it cannot justify.
 */
export function isSystemAppId(appId: string | null | undefined): boolean {
  return !appId || appId === "kernel"
}

function hsl(hue: number, sl: PillSL): string {
  return `hsl(${hue} ${sl.s}% ${sl.l}%)`
}

/** The pill's three colours for one theme. */
export function appPillColors(
  appId: string,
  theme: "light" | "dark",
): { background: string; text: string; border: string } {
  const hue = appHue(appId)
  const p = APP_PILL_PALETTE[theme]
  return { background: hsl(hue, p.background), text: hsl(hue, p.text), border: hsl(hue, p.border) }
}

/**
 * The pill's colours as CSS custom properties for BOTH themes. `.app-pill` in
 * index.css picks the pair matching `data-theme`, so a theme flip repaints
 * every pill without re-rendering one.
 */
export function appPillVars(appId: string): Record<string, string> {
  const light = appPillColors(appId, "light")
  const dark = appPillColors(appId, "dark")
  return {
    "--app-pill-bg-light": light.background,
    "--app-pill-fg-light": light.text,
    "--app-pill-border-light": light.border,
    "--app-pill-bg-dark": dark.background,
    "--app-pill-fg-dark": dark.text,
    "--app-pill-border-dark": dark.border,
  }
}

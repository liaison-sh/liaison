// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Colours a chart takes from its data, made to hold on the block's surface in either theme, and
// the same for the same category everywhere on a dashboard:
//   - readableOn: a data colour (a status's hex, picked once for one theme or none) nudged in
//     lightness until it clears 3:1 against the surface it is drawn on (WCAG 1.4.11), so a dark
//     teal stays visible on the dark card and a pale yellow on the light one.
//   - a colour scope: a category (a status, a series) without a colour of its own takes a palette
//     slot keyed by its VALUE, not its place in one chart, so "Received" reads in one colour in
//     the pipeline, the people rows and the time-in-status chart alike.
import { createContext, createRoot, createSignal, useContext } from "solid-js"

/** The contrast a mark (a bar, a segment, a legend dot) keeps against its surface. */
export const MARK_CONTRAST = 3

type Rgb = [number, number, number]

function parseHex(color: string): Rgb | null {
  const c = color.trim()
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(c)
  const full = short ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}` : c
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(full)
  if (!m) return null
  return [
    Number.parseInt(m[1] as string, 16),
    Number.parseInt(m[2] as string, 16),
    Number.parseInt(m[3] as string, 16),
  ]
}

function toHex([r, g, b]: Rgb): string {
  return `#${[r, g, b]
    .map((v) =>
      Math.round(Math.min(255, Math.max(0, v)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`
}

function channel(v: number): number {
  const s = v / 255
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

function luminance([r, g, b]: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/** The WCAG contrast ratio of two hex colours; null when either is not a hex colour. */
export function contrastRatio(a: string, b: string): number | null {
  const x = parseHex(a)
  const y = parseHex(b)
  if (!x || !y) return null
  const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

function toHsl([r, g, b]: Rgb): [number, number, number] {
  const [rr, gg, bb] = [r / 255, g / 255, b / 255]
  const max = Math.max(rr, gg, bb)
  const min = Math.min(rr, gg, bb)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h =
    max === rr
      ? (gg - bb) / d + (gg < bb ? 6 : 0)
      : max === gg
        ? (bb - rr) / d + 2
        : (rr - gg) / d + 4
  return [h / 6, s, l]
}

function fromHsl([h, s, l]: [number, number, number]): Rgb {
  if (s === 0) return [l * 255, l * 255, l * 255]
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const hue = (t0: number) => {
    const t = t0 < 0 ? t0 + 1 : t0 > 1 ? t0 - 1 : t0
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  return [hue(h + 1 / 3) * 255, hue(h) * 255, hue(h - 1 / 3) * 255]
}

/**
 * The colour as it can be drawn on `surface`: unchanged when it already clears `min` (3:1) or is
 * not a hex colour (a theme token, which the theme keeps readable itself); otherwise the same hue
 * made lighter on a dark surface, darker on a light one, by the least step that clears it.
 */
export function readableOn(color: string, surface: string, min = MARK_CONTRAST): string {
  const rgb = parseHex(color)
  const bg = parseHex(surface)
  if (!rgb || !bg) return color
  if ((contrastRatio(color, surface) ?? min) >= min) return color
  const lighter = luminance(bg) < 0.5
  const [h, s, l] = toHsl(rgb)
  let best = color
  for (let step = 1; step <= 50; step++) {
    const next = Math.min(1, Math.max(0, l + (lighter ? 0.02 : -0.02) * step))
    best = toHex(fromHsl([h, s, next]))
    if ((contrastRatio(best, surface) ?? 0) >= min) return best
    if (next === 0 || next === 1) break
  }
  return best
}

// The theme the document shows, as a signal: a colour adjusted for one surface is redone when the
// theme flips (data-theme on <html>).
const themeTick = createRoot(() => {
  const [tick, setTick] = createSignal(0)
  if (typeof MutationObserver !== "undefined" && typeof document !== "undefined") {
    new MutationObserver(() => setTick((n) => n + 1)).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    })
  }
  return tick
})

/** The surface blocks are drawn on, as the theme defines it (tracks the theme). */
export function blockSurface(): string {
  themeTick()
  const fallback = "#1a1a1e"
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") return fallback
  const v = getComputedStyle(document.documentElement).getPropertyValue("--color-surface").trim()
  return v || fallback
}

/** A data colour drawn on the block surface: readable in the theme shown. */
export function markColor(color: string): string {
  return readableOn(color, blockSurface())
}

/** The number of palette slots (theme.css --color-chart-1..8). */
const SLOTS = 8

function hashOf(value: string): number {
  let h = 2166136261
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** A category's palette colour, by its value (`var(--color-chart-N)`). */
export type ColourScope = (value: string) => string

/**
 * A scope that gives each category value one palette slot for its life: the slot its value hashes
 * to, or the next free one when another value holds it, so up to eight values in a scope never
 * share a colour; beyond eight, values share by their hash.
 */
export function createColourScope(): ColourScope {
  const slots = new Map<string, number>()
  const taken = new Set<number>()
  return (value) => {
    let slot = slots.get(value)
    if (slot === undefined) {
      const start = hashOf(value) % SLOTS
      slot = start
      if (taken.size < SLOTS) {
        while (taken.has(slot)) slot = (slot + 1) % SLOTS
      }
      slots.set(value, slot)
      taken.add(slot)
    }
    return `var(--color-chart-${slot + 1})`
  }
}

const ColourScopeContext = createContext<ColourScope>()

/** Every block under it shares one colour scope (a dashboard: one status, one colour). */
export const ColourScopeProvider = ColourScopeContext.Provider

/** The dashboard's colour scope, or one of the caller's own outside a dashboard. */
export function useColourScope(): ColourScope {
  return useContext(ColourScopeContext) ?? createColourScope()
}

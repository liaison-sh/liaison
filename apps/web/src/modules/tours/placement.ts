// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Where the tour's own UI sits so it never hides what matters: the panel keeps
 * clear of what the person works in (a sheet the beat opened, the field being
 * typed into), then of the element it spotlights (on a desktop, inside the
 * main panel area only: never over the rail or the sidebar); on a phone with
 * no free area left it folds to a one-line strip. The paused chip
 * sits where it covers no control. Pure geometry plus hit tests, so all of it
 * is unit-testable without a layout engine.
 */

import { isEditable, resolveVisibleAnchor } from "./visible-anchor"

/** Marks the tour's own UI: never an obstacle for itself. */
const TOUR_UI = "[data-tour-ui]"

export interface Rect {
  top: number
  left: number
  width: number
  height: number
}

export interface Candidate<T extends string> {
  id: T
  rect: Rect
}

/** Overlap area of two rects (0 when they only touch or are apart). */
export function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left)
  const h = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top)
  return w > 0 && h > 0 ? w * h : 0
}

/** The cheapest candidate; on a tie, the earliest (the preferred spot). */
export function pickPlacement<T extends string>(
  candidates: readonly Candidate<T>[],
  cost: (rect: Rect) => number,
): T {
  let best = candidates[0]
  let bestCost = Number.POSITIVE_INFINITY
  for (const c of candidates) {
    const value = cost(c.rect)
    if (value < bestCost) {
      best = c
      bestCost = value
      if (value === 0) break
    }
  }
  if (!best) throw new Error("pickPlacement needs at least one candidate")
  return best.id
}

// ── The panel ───────────────────────────────────────────────────────────

/** Desktop panel: a compact card in the main panel area, bottom left by default. */
export const PANEL_WIDTH = 330
/** Its top edge never above the tab strip. */
const PANEL_TOP = 64
const PANEL_EDGE = 16
/** Without the shell's main panel on the page: the area right of the activity bar. */
const PANEL_LEFT = 64
/** The right corners keep above the chat dock's bar and its windows' tabs. */
const PANEL_BOTTOM = 64
/** Phone sheet: above the five-seat tab bar (56px) / below the status bar. */
const SHEET_BOTTOM = 64
const SHEET_TOP = 8
const SHEET_INSET = 8
/** Breathing room kept around the spotlit element. */
const SPOT_PAD = 8

export type PanelPlacement =
  | "bottom-left"
  | "top-left"
  | "top-right"
  | "bottom-right"
  | "top-center"
  | "bottom-center"
export type SheetPlacement = "bottom" | "top"

/** Where the desktop card sits when nothing it must keep clear of is there. */
export const PANEL_HOME: PanelPlacement = "bottom-left"

export interface Viewport {
  width: number
  height: number
}

/** The shell's main panel: the card stays inside it, never over the rail or the sidebar. */
export const MAIN_AREA_SELECTOR = '[data-testid="main-panel"]'

/**
 * The area the desktop card may sit in: the shell's main panel (right of the
 * activity bar and the sidebar, whatever their width), clipped to the
 * viewport; without one on the page, everything right of the activity bar.
 */
export function mainArea(vp: Viewport, doc: Document = document): Rect {
  const el = doc.querySelector(MAIN_AREA_SELECTOR)
  const box = el ? boxOf(el) : null
  const left = Math.max(0, box?.left ?? PANEL_LEFT)
  const top = Math.max(0, box?.top ?? 0)
  const right = Math.min(vp.width, box ? box.left + box.width : vp.width)
  const bottom = Math.min(vp.height, box ? box.top + box.height : vp.height)
  return { top, left, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }
}

/** Where a desktop placement puts the card: its left edge, and its top or bottom edge. */
export interface PanelFrame {
  left: number
  /** Distance from the viewport's top (top placements). */
  top?: number
  /** Distance from the viewport's bottom (bottom placements: the card grows upward). */
  bottom?: number
}

export function panelFrame(p: PanelPlacement, area: Rect, vp: Viewport): PanelFrame {
  const minLeft = area.left + PANEL_EDGE
  const clampLeft = (left: number) => Math.max(minLeft, Math.round(left))
  const left = p.endsWith("left")
    ? minLeft
    : p.endsWith("right")
      ? clampLeft(area.left + area.width - PANEL_EDGE - PANEL_WIDTH)
      : clampLeft(area.left + (area.width - PANEL_WIDTH) / 2)
  const top = Math.max(PANEL_TOP, area.top + PANEL_EDGE)
  const areaBottom = vp.height - (area.top + area.height)
  // The bottom left corner is clear of the dock (it lies at the right); the
  // others keep above the dock's bar.
  const bottom = areaBottom + (p === "bottom-left" ? PANEL_EDGE : PANEL_BOTTOM)
  return p.startsWith("top") ? { left, top } : { left, bottom }
}

/**
 * The desktop card's spots, in order of preference: bottom left of the main
 * panel area, away from the chat dock at the right, then the other corners,
 * then the middle. Never over the activity bar or the sidebar.
 */
export function panelCandidates(
  vp: Viewport,
  height: number,
  area: Rect = mainArea(vp),
): Candidate<PanelPlacement>[] {
  const order: PanelPlacement[] = [
    "bottom-left",
    "top-left",
    "top-right",
    "bottom-right",
    "top-center",
    "bottom-center",
  ]
  return order.map((id) => {
    const f = panelFrame(id, area, vp)
    const top = f.top ?? vp.height - (f.bottom ?? 0) - height
    return { id, rect: { top, left: f.left, width: PANEL_WIDTH, height } }
  })
}

export function sheetCandidates(vp: Viewport, height: number): Candidate<SheetPlacement>[] {
  const width = vp.width - SHEET_INSET * 2
  return [
    {
      id: "bottom",
      rect: { top: vp.height - SHEET_BOTTOM - height, left: SHEET_INSET, width, height },
    },
    { id: "top", rect: { top: SHEET_TOP, left: SHEET_INSET, width, height } },
  ]
}

function padded(r: Rect): Rect {
  return {
    top: r.top - SPOT_PAD,
    left: r.left - SPOT_PAD,
    width: r.width + SPOT_PAD * 2,
    height: r.height + SPOT_PAD * 2,
  }
}

/** The head of a spotlit element: its first rows, at most this tall. */
const HEAD_MAX = 240
/** ...and at most this share of its height. */
const HEAD_SHARE = 0.4
/** Covering the head costs this much more than covering the rest. */
const HEAD_EXTRA = 2

/**
 * A spotlit element's head: where its content starts and new items appear
 * (the newest row of a list, the top of a page). Hiding it hides the step.
 */
export function spotHead(r: Rect): Rect {
  return { ...r, height: Math.min(HEAD_MAX, r.height * HEAD_SHARE) }
}

/**
 * How much of the spotlit element a rect covers, its head weighted above its
 * lower part: on a spot that fills the area, every corner covers about as
 * much, and the card keeps off the top, where the step happens.
 */
export function spotCost(r: Rect, spot: Rect): number {
  return overlapArea(r, spot) + HEAD_EXTRA * overlapArea(r, spotHead(spot))
}

/** The desktop corner (or phone edge) that covers least of the spotlit element. */
export function placePanel<T extends string>(
  candidates: readonly Candidate<T>[],
  spot: Rect | null,
): T {
  return layoutPanel(candidates, { spot, work: [] }).placement
}

export interface PanelLayoutInput<T extends string> {
  /** The spotlit element (null when there is none, or a later layer covers it). */
  spot: Rect | null
  /** What the person types into or works in now: kept clear before the spotlight. */
  work: readonly Rect[]
  /**
   * What the person must press to do the step (the button a `do` beat's Do it
   * for me clicks: a card's Approve): never covered, ahead of the work area
   * and the spotlit element's head.
   */
  press?: readonly Rect[]
  /** Controls a rect would cover: the tie-break between spots that hide nothing that matters. */
  controls?: (rect: Rect) => number
  /** Where the panel is now: kept on a tie, so it never hops between equal spots. */
  current?: T
  /** Where the panel returns whenever it hides nothing there (the desktop card's corner). */
  home?: T
}

export interface PanelLayout<T extends string> {
  placement: T
  /** Every spot covers part of the work area: on a phone the panel folds to a strip. */
  crowded: boolean
  /** The index in `press` of a target the chosen spot still covers (every spot does): scroll it clear. */
  covers: number | null
}

/** Covering one press target outweighs any overlap of the work area or the spotlight. */
const PRESS_WEIGHT = 1e12

/**
 * Where the panel goes: clear of the work area first (the sheet or editor the
 * beat opened, the field being typed into), then of the spotlit element, then
 * of as few controls as possible.
 */
export function layoutPanel<T extends string>(
  candidates: readonly Candidate<T>[],
  input: PanelLayoutInput<T>,
): PanelLayout<T> {
  const spot = input.spot ? padded(input.spot) : null
  const work = input.work.map(padded)
  const press = (input.press ?? []).map(padded)
  const workCost = (r: Rect) => work.reduce((sum, w) => sum + overlapArea(r, w), 0)
  const pressHits = (r: Rect) => press.filter((p) => overlapArea(r, p) > 0).length
  const cost = (r: Rect) =>
    pressHits(r) * PRESS_WEIGHT +
    (workCost(r) * 4 + (spot ? spotCost(r, spot) : 0)) * 100 +
    (input.controls?.(r) ?? 0)
  const crowded = work.length > 0 && candidates.every((c) => workCost(c.rect) > 0)
  const result = (id: T): PanelLayout<T> => {
    const rect = candidates.find((c) => c.id === id)?.rect
    const hit = rect ? press.findIndex((p) => overlapArea(rect, p) > 0) : -1
    return { placement: id, crowded, covers: hit < 0 ? null : hit }
  }
  let placement = pickPlacement(candidates, cost)
  const best = candidates.find((c) => c.id === placement)
  const home = candidates.find((c) => c.id === input.home)
  // Home wins any tie (also one where every spot covers the same): the card
  // returns to its corner rather than staying where an earlier step sent it.
  if (home && best && cost(home.rect) <= cost(best.rect)) return result(home.id)
  const current = candidates.find((c) => c.id === input.current)
  if (current && best && cost(current.rect) <= cost(best.rect)) placement = current.id
  return result(placement)
}

/**
 * How far a press target must move on screen (px, negative is up) to sit
 * clear of the card, staying inside `area`: above the card or below it,
 * whichever is the shorter move. Null when neither fits.
 */
export function clearOfCard(target: Rect, card: Rect, area: Rect): number | null {
  const up = card.top - SPOT_PAD - (target.top + target.height)
  const down = card.top + card.height + SPOT_PAD - target.top
  const fits = (d: number) =>
    target.top + d >= area.top && target.top + target.height + d <= area.top + area.height
  const moves = [up, down].filter(fits).sort((a, b) => Math.abs(a) - Math.abs(b))
  return moves[0] ?? null
}

/** The one-line strip a crowded phone panel folds to. */
export const STRIP_HEIGHT = 44

/** Kobalte dialogs and sheets carry these roles; an open one is where the person works. */
const LAYER = '[role="dialog"], [role="alertdialog"]'

function boxOf(el: Element): Rect | null {
  if (el.getClientRects().length === 0) return null
  const r = el.getBoundingClientRect()
  if (r.width <= 0 || r.height <= 0) return null
  return { top: r.top, left: r.left, width: r.width, height: r.height }
}

/**
 * What the person is working in now, for the panel to keep clear of: every
 * open dialog or sheet the app shows (often the beat's own), the field that
 * has focus, and the fields the beat's script types into once they are on
 * screen (an editor that opened after Edit).
 */
export function workAreas(typeTargets: readonly string[], doc: Document = document): Rect[] {
  const out: Rect[] = []
  const add = (el: Element | null) => {
    if (!el || el.closest(TOUR_UI)) return
    const box = boxOf(el)
    if (box) out.push(box)
  }
  for (const el of doc.querySelectorAll(LAYER)) add(el)
  const active = doc.activeElement
  if (active && active !== doc.body && isEditable(active)) add(active)
  for (const testid of typeTargets) add(resolveVisibleAnchor(testid, doc))
  return out
}

/**
 * The spotlit element is under a later layer (a sheet or dialog the beat
 * opened over it): the app's topmost element at its centre is neither it, in
 * it, nor one of its ancestors. The ring is not drawn over that layer.
 */
export function isCoveredByLayer(
  target: Element | readonly Element[],
  box: Rect,
  doc: Document = document,
): boolean {
  // A group (the subtasks just made) is one box: what shows at its centre is
  // any of its rows, not only the first.
  const els: readonly Element[] = target instanceof Element ? [target] : target
  if (typeof doc.elementsFromPoint !== "function") return false
  const x = box.left + box.width / 2
  const y = box.top + box.height / 2
  const vw = doc.defaultView?.innerWidth ?? 0
  const vh = doc.defaultView?.innerHeight ?? 0
  if (x < 0 || y < 0 || x > vw || y > vh) return false
  const top = doc.elementsFromPoint(x, y).find((hit) => !hit.closest(TOUR_UI))
  if (!top) return false
  return !els.some((el) => top === el || el.contains(top) || top.contains(el))
}

// ── The chip ────────────────────────────────────────────────────────────

export type ChipPlacement =
  | "bottom-left"
  | "bottom-center"
  | "bottom-right"
  | "top-right"
  /** A phone row above the bottom edge, over content: placed by its rect. */
  | `row${number}-${"left" | "center" | "right"}`

const CHIP_EDGE = 16
/** Desktop: right of the activity bar. */
const CHIP_LEFT_WIDE = 60

export function chipCandidates(
  vp: Viewport,
  size: { width: number; height: number },
  phone: boolean,
): Candidate<ChipPlacement>[] {
  const { width, height } = size
  // Phone: above the tab bar, or under the status bar; desktop: above the
  // panel's bottom edge, the right one above the chat dock.
  const bottomTop = vp.height - (phone ? SHEET_BOTTOM : CHIP_EDGE) - height
  const left = phone ? CHIP_EDGE : CHIP_LEFT_WIDE
  const right = vp.width - CHIP_EDGE - width
  return [
    { id: "bottom-left", rect: { top: bottomTop, left, width, height } },
    {
      id: "bottom-center",
      rect: { top: bottomTop, left: Math.round((vp.width - width) / 2), width, height },
    },
    {
      id: "bottom-right",
      rect: { top: bottomTop - (phone ? 0 : PANEL_BOTTOM - CHIP_EDGE), left: right, width, height },
    },
    { id: "top-right", rect: { top: phone ? SHEET_TOP : PANEL_TOP, left: right, width, height } },
    // Phone: a ticket's action bar or a banner can fill both edges. Rows up
    // the screen, over content rather than controls, down to its middle.
    ...(phone ? phoneChipRows(vp, size, bottomTop) : []),
  ]
}

const CHIP_ROW_GAP = 12

function phoneChipRows(
  vp: Viewport,
  size: { width: number; height: number },
  bottomTop: number,
): Candidate<ChipPlacement>[] {
  const out: Candidate<ChipPlacement>[] = []
  const lefts = {
    left: CHIP_EDGE,
    center: Math.round((vp.width - size.width) / 2),
    right: vp.width - CHIP_EDGE - size.width,
  }
  const step = size.height + CHIP_ROW_GAP
  for (let row = 1, top = bottomTop - step; top >= vp.height / 2; row++, top -= step) {
    for (const [side, left] of Object.entries(lefts)) {
      out.push({ id: `row${row}-${side}` as ChipPlacement, rect: { top, left, ...size } })
    }
  }
  return out
}

const INTERACTIVE =
  'button, a[href], input, select, textarea, summary, [role="button"], [role="tab"], [role="link"], [role="menuitem"], [role="checkbox"], [role="switch"], [contenteditable="true"], [tabindex]:not([tabindex="-1"])'

/**
 * How many controls a rect would cover: the app's topmost element at a few
 * points inside it (the tour's own UI looked through), counted when it is or
 * sits in something a person can press or type into.
 */
export function coveredControls(rect: Rect, doc: Document = document): number {
  if (typeof doc.elementsFromPoint !== "function") return 0
  const hits = new Set<Element>()
  // Near the edges too: a link's hit box under a chip's top edge counts.
  const xs = [0.03, 0.25, 0.5, 0.75, 0.97].map((f) => rect.left + rect.width * f)
  const ys = [0.08, 0.5, 0.92].map((f) => rect.top + rect.height * f)
  for (const x of xs) {
    for (const y of ys) {
      const top = doc.elementsFromPoint(x, y).find((el) => !el.closest(TOUR_UI))
      const control = top?.closest(INTERACTIVE)
      if (control) hits.add(control)
    }
  }
  return hits.size
}

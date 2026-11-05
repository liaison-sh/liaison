// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Keeps the tour panel where it hides least: re-placed as the beat's sheet or
 * editor opens, the spotlit element moves, or the window resizes. On a
 * desktop the card sits at the bottom left of the main panel area and leaves
 * it only while it would cover the ringed element or what the person works in
 * (a dialog, the field being typed into), never for the rail or the sidebar,
 * which it is never placed over. On a phone
 * with no free area left (every edge covers the field being typed into or the
 * sheet the beat opened) it folds to a one-line strip for the rest of the
 * step, and opens again when the step completes, when the person unfolds it,
 * or when it has something to say (a failure, an error). It also folds while
 * a page that is read beside a tour is on screen (`data-tour-clear`: the
 * demo's budget page), which the sheet would otherwise half cover.
 */
import { type EffectiveBeat, refCreated, refTestId, refWhere } from "@liaison/shared"
import {
  type Accessor,
  createEffect,
  createSignal,
  on,
  onCleanup,
  onMount,
  untrack,
} from "solid-js"
import {
  type Candidate,
  clearOfCard,
  coveredControls,
  layoutPanel,
  mainArea,
  PANEL_HOME,
  type PanelFrame,
  type PanelPlacement,
  panelCandidates,
  panelFrame,
  type Rect,
  type SheetPlacement,
  STRIP_HEIGHT,
  sheetCandidates,
  workAreas,
} from "./placement"
import { resolveVisibleAnchor } from "./visible-anchor"

/** How often the panel re-checks what is under it (sheets open, editors appear). */
export const PANEL_PLACE_MS = 500

/** The fields the beat's script types into: the work area once they are on screen. */
export function typeTargets(beat: EffectiveBeat): string[] {
  return (beat.autoplay ?? []).flatMap((step) => ("type" in step ? [step.type.testid] : []))
}

/**
 * What a `do` beat's script presses (its Do it for me clicks: a card's
 * Approve), as it is on screen now: the card never covers it. A click pinned
 * to an entity the tour has not recorded yet has no target.
 */
export function pressTargets(
  beat: EffectiveBeat,
  created: Readonly<Record<string, string>> = {},
  doc: Document = document,
): HTMLElement[] {
  if (beat.kind !== "do") return []
  const out: HTMLElement[] = []
  for (const step of beat.autoplay ?? []) {
    if (!("click" in step)) continue
    const ref = step.click
    const where = refWhere(ref)
    const pin = refCreated(ref)
    const value = pin ? created[pin.beat] : undefined
    if (pin && !value) continue
    const el = resolveVisibleAnchor(
      refTestId(ref),
      doc,
      where ?? (pin && value ? { attr: pin.attr, value } : undefined),
    )
    if (el && !out.includes(el)) out.push(el)
  }
  return out
}

function rectOf(el: Element): Rect | null {
  if (el.getClientRects().length === 0) return null
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0
    ? { top: r.top, left: r.left, width: r.width, height: r.height }
    : null
}

/** The element's nearest scrolling ancestor, else the page. */
function scrollerOf(el: HTMLElement): Element | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node)
    if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) return node
  }
  return document.scrollingElement
}

/**
 * Every spot of the card covers what the step presses: scroll it clear of
 * the card (above it or below it, inside the area), once per element.
 */
export function scrollPressClear(el: HTMLElement, card: Rect, area: Rect): boolean {
  const box = rectOf(el)
  if (!box) return false
  const move = clearOfCard(box, card, area)
  const scroller = scrollerOf(el)
  if (move === null || !scroller || typeof scroller.scrollBy !== "function") return false
  // Moving the element up on screen is scrolling its container down.
  scroller.scrollBy({ top: -move })
  return true
}

export interface PanelLayoutOptions {
  phone: Accessor<boolean>
  beat: Accessor<EffectiveBeat>
  /** The spotlit element; null when none, or when a later layer covers it. */
  spot: Accessor<Rect | null>
  /** The panel's rendered height (0 before it is laid out). */
  height: () => number
  /** The panel says something the person must read: it never stays folded. */
  attention: Accessor<boolean>
  /** The entities the tour recorded, by beat id: resolves a click pinned to one. */
  created?: Accessor<Readonly<Record<string, string>>>
}

/** A page read beside a tour carries this: on a phone the sheet folds over it. */
export const TOUR_CLEAR_ATTR = "data-tour-clear"

function clearPageOnScreen(): boolean {
  for (const el of document.querySelectorAll(`[${TOUR_CLEAR_ATTR}]`)) {
    if (el.getClientRects().length > 0) return true
  }
  return false
}

const DEFAULT_HEIGHT = 240

const PANEL_PLACEMENTS = new Set<string>([
  "bottom-left",
  "top-left",
  "top-right",
  "bottom-right",
  "top-center",
  "bottom-center",
])

function viewportNow() {
  return { width: window.innerWidth, height: window.innerHeight }
}

export function createPanelLayout(opts: PanelLayoutOptions) {
  const [placement, setPlacement] = createSignal<PanelPlacement | SheetPlacement>(
    untrack(opts.phone) ? "bottom" : PANEL_HOME,
  )
  /** Where the desktop card's placement puts it, inside the main panel area. */
  const [frame, setFrame] = createSignal<PanelFrame>(
    panelFrame(PANEL_HOME, mainArea(viewportNow()), viewportNow()),
  )
  const [crowded, setCrowded] = createSignal(false)
  /** Folded once this step found no free area; sticky until the step changes. */
  const [folded, setFolded] = createSignal(false)
  /** The person's own fold or unfold, for this step. */
  const [choice, setChoice] = createSignal<boolean | null>(null)
  /** A page read beside the tour is on screen (re-read on every placement pass). */
  const [away, setAway] = createSignal(false)
  const collapsed = () => opts.phone() && !opts.attention() && (choice() ?? (folded() || away()))
  /** The open panel's height, kept while it shows as a strip. */
  let fullHeight = DEFAULT_HEIGHT

  /** Press targets already scrolled clear of the card this step: never fought. */
  let scrolledClear: HTMLElement[] = []
  /** The card covers a press target from every spot: scroll that target clear once. */
  const keepPressClear = <T extends string>(
    layout: { placement: T; covers: number | null },
    candidates: readonly Candidate<T>[],
    targets: readonly HTMLElement[],
    area: Rect,
  ) => {
    if (layout.covers === null) return
    const el = targets[layout.covers]
    const card = candidates.find((c) => c.id === layout.placement)?.rect
    if (!el || !card || scrolledClear.includes(el)) return
    scrolledClear.push(el)
    scrollPressClear(el, card, area)
  }

  const place = () => {
    setAway(clearPageOnScreen())
    const vp = viewportNow()
    const spot = opts.spot()
    const work = workAreas(typeTargets(opts.beat()))
    const targets: HTMLElement[] = []
    const press: Rect[] = []
    for (const el of pressTargets(opts.beat(), opts.created?.() ?? {})) {
      const box = rectOf(el)
      if (!box) continue
      targets.push(el)
      press.push(box)
    }
    const current = placement()
    if (!collapsed()) fullHeight = opts.height() || fullHeight
    if (!opts.phone()) {
      setCrowded(false)
      const area = mainArea(vp)
      // No tie-break on the controls under it: the card stays in its corner
      // (opening a chat with its composer below it moved it over the sidebar).
      const candidates = panelCandidates(vp, fullHeight, area)
      const layout = layoutPanel(candidates, {
        spot,
        work,
        press,
        current: PANEL_PLACEMENTS.has(current) ? (current as PanelPlacement) : undefined,
        home: PANEL_HOME,
      })
      setPlacement(layout.placement)
      setFrame(panelFrame(layout.placement, area, vp))
      keepPressClear(layout, candidates, targets, area)
      return
    }
    const sheets = sheetCandidates(vp, fullHeight)
    const full = layoutPanel(sheets, {
      spot,
      work,
      press,
      current: current as SheetPlacement,
    })
    setCrowded(full.crowded)
    if (full.crowded) setFolded(true)
    const screen = { top: 0, left: 0, width: vp.width, height: vp.height }
    if (!collapsed()) {
      setPlacement(full.placement)
      keepPressClear(full, sheets, targets, screen)
      return
    }
    const strips = sheetCandidates(vp, STRIP_HEIGHT)
    const strip = layoutPanel(strips, {
      spot,
      work,
      press,
      controls: (r) => coveredControls(r),
      current: current as SheetPlacement,
    })
    setPlacement(strip.placement)
    keepPressClear(strip, strips, targets, screen)
  }

  // A new step starts open.
  createEffect(
    on(
      () => opts.beat().id,
      () => {
        setFolded(false)
        setChoice(null)
        scrolledClear = []
      },
    ),
  )
  createEffect(() => {
    opts.spot()
    opts.phone()
    opts.beat()
    opts.attention()
    choice()
    folded()
    untrack(place)
  })
  onMount(() => {
    const timer = setInterval(place, PANEL_PLACE_MS)
    window.addEventListener("resize", place)
    onCleanup(() => {
      clearInterval(timer)
      window.removeEventListener("resize", place)
    })
  })

  return {
    placement,
    /** The desktop card's position (left, and top or bottom), in px from the viewport's edges. */
    frame,
    collapsed,
    /** Folding is offered on a phone while the step has no free area. */
    canFold: () => opts.phone() && !opts.attention() && (crowded() || folded() || away()),
    toggle: () => setChoice(!collapsed()),
  }
}

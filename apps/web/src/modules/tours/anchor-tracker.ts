// SPDX-License-Identifier: FSL-1.1-ALv2
import { type Accessor, createEffect, createSignal, on, onCleanup } from "solid-js"
import { isCoveredByLayer } from "./placement"
import {
  resolveLatestFromTurn,
  resolveVisibleAnchor,
  resolveVisibleAnchors,
} from "./visible-anchor"

export interface AnchorBox {
  el: HTMLElement
  top: number
  left: number
  width: number
  height: number
  /** A later layer (a sheet or dialog the beat opened) is over it: no ring is drawn. */
  covered: boolean
  /**
   * What the element is seen through: the viewport cut to every ancestor that
   * clips it (a chat window, its message list). The ring stays inside it.
   */
  clip?: ClipRect
}

export interface ClipRect {
  top: number
  left: number
  bottom: number
  right: number
}

/** How often the anchor is re-resolved (tabs switch, lists render late). */
export const ANCHOR_POLL_MS = 250

function sameBox(a: AnchorBox | null, b: AnchorBox | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.el === b.el &&
    a.top === b.top &&
    a.left === b.left &&
    a.width === b.width &&
    a.height === b.height &&
    a.covered === b.covered &&
    a.clip?.top === b.clip?.top &&
    a.clip?.left === b.clip?.left &&
    a.clip?.bottom === b.clip?.bottom &&
    a.clip?.right === b.clip?.right
  )
}

/** An element whose overflow is not `visible` cuts off what lies outside its box. */
function clipsOverflow(el: Element): boolean {
  const style = el.ownerDocument.defaultView?.getComputedStyle(el)
  if (!style) return false
  return [style.overflow, style.overflowX, style.overflowY].some(
    (value) => value !== "" && value !== "visible",
  )
}

/** The viewport cut to every ancestor of `el` that clips its overflow. */
function clipOf(el: HTMLElement): ClipRect {
  const clip: ClipRect = {
    top: 0,
    left: 0,
    bottom: window.innerHeight,
    right: window.innerWidth,
  }
  for (let node = el.parentElement; node; node = node.parentElement) {
    if (!clipsOverflow(node)) continue
    const r = node.getBoundingClientRect()
    clip.top = Math.max(clip.top, r.top)
    clip.left = Math.max(clip.left, r.left)
    clip.bottom = Math.min(clip.bottom, r.bottom)
    clip.right = Math.min(clip.right, r.right)
  }
  return clip
}

/**
 * The part of `el` a person can see: its box cut to every ancestor that clips
 * its overflow (a scroll area, a window) and to the viewport, or null when
 * none of it shows. A tall block in a docked chat's message list is mostly
 * scrolled out of sight; ringed by its own box, the spotlight ran up off the
 * chat window over the page behind it (walk D76).
 */
export function visiblePart(
  el: HTMLElement,
  rect: DOMRect = el.getBoundingClientRect(),
): { top: number; left: number; width: number; height: number; clip: ClipRect } | null {
  const clip = clipOf(el)
  const top = Math.max(rect.top, clip.top)
  const left = Math.max(rect.left, clip.left)
  const bottom = Math.min(rect.bottom, clip.bottom)
  const right = Math.min(rect.right, clip.right)
  if (bottom <= top || right <= left) return null
  return { top, left, width: right - left, height: bottom - top, clip }
}

/**
 * Track where a tour anchor is on screen: the VISIBLE element carrying the
 * testid and the part of its box that shows, re-resolved on a short poll and on resize/scroll, null
 * while it is not on screen. The first time an anchor appears outside the
 * viewport it is scrolled into view once, so the spotlight never points off
 * screen. With `all` true, every visible match is ringed as one box (a group
 * of rows), scrolled to its first.
 */
export function createAnchorTracker(
  testid: Accessor<string | undefined>,
  all: Accessor<boolean> = () => false,
  /** A turn's anchor follows the agent's later turns in that conversation (`resolveLatestFromTurn`). */
  latest: Accessor<boolean> = () => false,
): Accessor<AnchorBox | null> {
  return createElementTracker(() => {
    const id = testid()
    if (!id) return undefined
    if (all()) return () => resolveVisibleAnchors(id)
    return latest() ? () => resolveLatestFromTurn(id) : () => resolveVisibleAnchor(id)
  })
}

/** The box around every part of `els` that shows, clipped as the first one is. */
function groupPart(
  els: readonly HTMLElement[],
): { top: number; left: number; width: number; height: number; clip: ClipRect } | null {
  let out: { top: number; left: number; bottom: number; right: number; clip: ClipRect } | null =
    null
  for (const el of els) {
    const part = visiblePart(el)
    if (!part) continue
    const bottom = part.top + part.height
    const right = part.left + part.width
    out = out
      ? {
          top: Math.min(out.top, part.top),
          left: Math.min(out.left, part.left),
          bottom: Math.max(out.bottom, bottom),
          right: Math.max(out.right, right),
          clip: out.clip,
        }
      : { top: part.top, left: part.left, bottom, right, clip: part.clip }
  }
  if (!out) return null
  return {
    top: out.top,
    left: out.left,
    width: out.right - out.left,
    height: out.bottom - out.top,
    clip: out.clip,
  }
}

/**
 * `createAnchorTracker` for an element found some other way than by one
 * testid (the live turn in the very conversation a request went into, else
 * that conversation): `find` is re-run on every poll. A list of elements is
 * ringed as one box.
 */
export function createElementTracker(
  target: Accessor<(() => HTMLElement | readonly HTMLElement[] | null) | undefined>,
): Accessor<AnchorBox | null> {
  const [box, setBox] = createSignal<AnchorBox | null>(null, { equals: sameBox })
  let scrolledFor: HTMLElement | null = null
  /** This anchor was on screen once already (any element of it, this target). */
  let shown = false

  const measure = () => {
    const find = target()
    const found = find ? find() : null
    const group = found && !(found instanceof HTMLElement) ? found : null
    const el = found instanceof HTMLElement ? found : (group?.[0] ?? null)
    if (!el) {
      setBox(null)
      return
    }
    let rect = el.getBoundingClientRect()
    // An element with no size of its own (a marker) keeps its box; anything
    // else is ringed only where it can be seen.
    const sized = rect.width > 0 && rect.height > 0
    const vh = window.innerHeight
    const vw = window.innerWidth
    // Out of sight: outside the viewport, or scrolled away inside a scroll
    // area (a turn's tool row above its answer in a docked chat). Scrolled to
    // once per element, so a list that keeps to its newest message is not
    // fought.
    const part = sized && !group ? visiblePart(el, rect) : undefined
    const offScreen =
      rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw || part === null
    // Cut off below the fold, less than half of it showing (a draft's top
    // edge under a long note): brought up with the least scroll, which only
    // ever scrolls down. One cut off at the TOP is left alone: that is a chat
    // following its newest message past it, and scrolling back up would stop
    // the chat following, so the answer would stream in below the fold.
    const cutBelow =
      !offScreen &&
      part != null &&
      rect.bottom > part.clip.bottom &&
      part.height < Math.min(rect.height, part.clip.bottom - part.clip.top) / 2
    // Gone off the TOP after it was seen (an approval card the chat's newest
    // message pushed up, or the card again once its Undo window passed): the
    // same following chat, left alone too. Only an anchor never seen yet is
    // scrolled back up to.
    const pushedUp = offScreen && shown && sized && !group && rect.bottom <= clipOf(el).top
    if (
      (offScreen || cutBelow) &&
      !pushedUp &&
      scrolledFor !== el &&
      typeof el.scrollIntoView === "function"
    ) {
      scrolledFor = el
      el.scrollIntoView({ block: offScreen ? "center" : "nearest", inline: "nearest" })
      rect = el.getBoundingClientRect()
    }
    const box = group
      ? groupPart(group)
      : sized
        ? visiblePart(el, rect)
        : { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
    if (!box) {
      setBox(null)
      return
    }
    shown = true
    setBox({ el, ...box, covered: isCoveredByLayer(group ?? el, box) })
  }

  createEffect(
    on(target, () => {
      scrolledFor = null
      shown = false
      measure()
    }),
  )
  const timer = setInterval(measure, ANCHOR_POLL_MS)
  window.addEventListener("resize", measure)
  window.addEventListener("scroll", measure, true)
  onCleanup(() => {
    clearInterval(timer)
    window.removeEventListener("resize", measure)
    window.removeEventListener("scroll", measure, true)
  })
  return box
}

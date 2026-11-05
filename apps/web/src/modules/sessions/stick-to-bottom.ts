// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE SESSION TRANSCRIPT FOLLOWS THE SESSION (2026-10-15). A live computer
// session grew below the fold: Thinking, Skill and Read rows arrived under the
// composer while the view stayed where it was, and the owner scrolled by hand.
// The chat's message list learned to follow its stream (MessageList, walk 3),
// but the Sessions view never had any follow logic at all.
//
// Behaviour, the same as a chat panel:
// - on open the view shows the end of the transcript;
// - while the reader is following (at or near the bottom) every new event and
//   every later growth (a row that expands, streams, or an image that decodes)
//   keeps the view pinned to the bottom;
// - following is STICKY: only a deliberate upward scroll clears it, so a tall
//   new row that opens a large gap never unpins a follower;
// - a reader who scrolled up is never yanked back: the new events are counted
//   for a "Jump to latest" button, and following resumes when she reaches the
//   bottom again (or presses the button, sends a message, answers a card);
// - the first frames of an upward scroll (a wheel tick, iOS touch inertia) can
//   come before their scroll event: a re-pin that finds the view moved up
//   since it last pinned treats it as the owner's scroll and leaves it alone;
// - browser scroll anchoring also moves the view up (a card above collapses
//   and a row is appended in the same task, a pull() catch-up batch): that is
//   not the owner. While following, the scroller sets `overflow-anchor:
//   none` (the view pins itself then, so anchoring has nothing to add and only
//   misleads the pin); while away it stays `auto`, so a reader scrolled up
//   keeps her place when rows above her change. This keeps the early-tick
//   guard above exact (an owner's tick in the same task as an append is still
//   hers), which a "content height unchanged" rule would not: every streamed
//   row changes the height. Chromium and WebKit honour the property; only an
//   engine that does not falls back to that height rule;
// - a focused request card owns the view while it scrolls into place, then
//   the gap is checked again: a card at the end of the transcript (the usual
//   case) leaves the owner at the bottom, following. A card that finished
//   while its pane was hidden is settled when the pane is shown;
// - a pane that was hidden (tabs stay mounted; `display: none` loses the
//   offset) comes back at the bottom when following, else where it was left.

import { type Accessor, createEffect, createSignal, on, onCleanup } from "solid-js"

/** Within this many px of the bottom, the reader is at the bottom. */
export const NEAR_BOTTOM_PX = 80

export interface StickToBottom {
  /** Ref for the scrolling element. */
  container(el: HTMLElement): void
  /** Ref for the element whose growth the view follows (the scroller's content). */
  content(el: HTMLElement): void
  /** True while the reader scrolled away from the bottom. */
  away: Accessor<boolean>
  /** Events that arrived while away. */
  unseen: Accessor<number>
  /** Follow again and go to the bottom (the button, a sent message, an answer). */
  jump(): void
  /** Another target owns the view (a focused card): no pin until `settle`. */
  hold(): void
  /** The other target is in place: follow again when the view is at the bottom. */
  settle(): void
  /** Re-pin if following, or restore a pane that was just shown. */
  pin(): void
}

/** The engine lets the scroller turn scroll anchoring off. */
function anchoringControllable(): boolean {
  return typeof CSS !== "undefined" && typeof CSS.supports === "function"
    ? CSS.supports("overflow-anchor", "none")
    : false
}

export function createStickToBottom(count: Accessor<number>): StickToBottom {
  /** Anchoring is off while following, so an upward move is always the owner's. */
  const anchorOff = anchoringControllable()
  let scroller: HTMLElement | undefined
  let following = true
  /** The scroll offset last pinned to or scrolled to by the owner. */
  let lastTop = 0
  /** The content height when `lastTop` was taken: a move with another height is layout's. */
  let lastHeight = 0
  /** The pane had no layout (`display: none`) when last looked at. */
  let hidden = false
  /** A focused card owns the view (`hold`) and has not settled yet. */
  let held = false
  /** Whether the view followed when the card took it. */
  let heldFollowing = true
  const [away, setAway] = createSignal(false)
  const [unseen, setUnseen] = createSignal(0)

  function follow(value: boolean): void {
    following = value
    setAway(!value)
    if (value) setUnseen(0)
    anchor()
  }

  /** Anchoring off while following (the pin owns the view), on while away. */
  function anchor(): void {
    scroller?.style.setProperty("overflow-anchor", following ? "none" : "auto")
  }

  function mark(el: HTMLElement): void {
    lastTop = el.scrollTop
    lastHeight = el.scrollHeight
  }

  function resolveHold(el: HTMLElement): void {
    held = false
    mark(el)
    follow(gapOf(el) < NEAR_BOTTOM_PX)
  }

  const bottomOf = (el: HTMLElement) => Math.max(0, el.scrollHeight - el.clientHeight)
  const gapOf = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight

  function toBottom(el: HTMLElement): void {
    if (el.scrollTop < bottomOf(el)) el.scrollTop = bottomOf(el)
    mark(el)
  }

  function pin(): void {
    const el = scroller
    if (!el) return
    if (el.clientHeight === 0) {
      hidden = true
      return
    }
    if (hidden) {
      hidden = false
      // A card that settled while hidden scrolled nothing: the follow is
      // what it was when the card took the view.
      if (held) {
        held = false
        follow(heldFollowing)
      }
      if (following) toBottom(el)
      else {
        el.scrollTop = lastTop
        mark(el)
      }
      return
    }
    if (!following) return
    // Moved up since the last pin, and not by a viewport that grew (that
    // clamps to the bottom, gap 0): the owner's scroll, whose event has not
    // arrived yet. Overwriting it would swallow it (and kill iOS inertia).
    // Where anchoring cannot be turned off, a move with a new content height
    // is anchoring's: re-pin.
    const owners = anchorOff || el.scrollHeight === lastHeight
    if (el.scrollTop < lastTop - 1 && owners && gapOf(el) > 1) {
      mark(el)
      follow(false)
      return
    }
    toBottom(el)
  }

  function onScroll(): void {
    const el = scroller
    if (!el || el.clientHeight === 0) return
    const gap = gapOf(el)
    const scrolledUp = el.scrollTop < lastTop - 1
    const relaid = !anchorOff && el.scrollHeight !== lastHeight
    mark(el)
    if (scrolledUp) {
      // A gap opened by growth (scrollTop unchanged) never lands here, nor
      // does a viewport that grew at the bottom (gap 0). Where anchoring is
      // on regardless, a move with a new content height is anchoring's.
      if (following && gap > 1) {
        if (relaid) toBottom(el)
        else follow(false)
      }
    } else if (gap < NEAR_BOTTOM_PX && !following) {
      follow(true)
    }
  }

  // Growth: a new row (mutation, before the next frame paints the gap), a row
  // that expands, a pane shown again, a font or image that lays out later
  // (resize), an image that decodes (load, which does not bubble: captured).
  const mutations =
    typeof MutationObserver !== "undefined" ? new MutationObserver(() => pin()) : undefined
  const resizes =
    typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => pin()) : undefined
  const onLoad = () => pin()
  let contentEl: HTMLElement | undefined

  onCleanup(() => {
    mutations?.disconnect()
    resizes?.disconnect()
    scroller?.removeEventListener("scroll", onScroll)
    contentEl?.removeEventListener("load", onLoad, true)
  })

  // New events: followed when following, counted otherwise.
  createEffect(
    on(count, (n, prev) => {
      if (prev === undefined || n <= prev) return
      if (following) pin()
      else setUnseen((u) => u + (n - prev))
    }),
  )

  return {
    container(el) {
      scroller = el
      anchor()
      el.addEventListener("scroll", onScroll, { passive: true })
      resizes?.observe(el)
      queueMicrotask(pin)
    },
    content(el) {
      contentEl = el
      mutations?.observe(el, { childList: true, subtree: true, characterData: true })
      resizes?.observe(el)
      el.addEventListener("load", onLoad, true)
    },
    away,
    unseen,
    jump() {
      held = false
      follow(true)
      if (scroller && scroller.clientHeight > 0) toBottom(scroller)
    },
    hold() {
      if (!held) heldFollowing = following
      held = true
      following = false
      anchor()
    },
    settle() {
      const el = scroller
      if (!el) return
      // Hidden: settled when the pane is shown again (pin).
      if (el.clientHeight === 0) {
        hidden = true
        return
      }
      resolveHold(el)
    },
    pin,
  }
}

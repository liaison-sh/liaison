// SPDX-License-Identifier: FSL-1.1-ALv2

import { X } from "lucide-solid"
import type { Component, JSX } from "solid-js"
import { createEffect, Show } from "solid-js"
import { cn } from "~/lib/cn"
import { Dialog } from "~/ui/Dialog"

export interface OverlaySheetProps {
  open: boolean
  onClose: () => void
  /** `full` covers the viewport (phone agent panel); `bottom` is a
   *  bottom-anchored action sheet; `side` is a drawer against one edge
   *  (`anchor`) that leaves the rest of the row scrimmed. */
  variant: "full" | "bottom" | "side"
  /** `side` only: the edge the drawer is held against. `left` (the default)
   *  is the tablet sidebar drawer; `right` is the phone thread map. */
  anchor?: "left" | "right"
  /** `side` with `anchor: "left"`: where the drawer (and its scrim) start, as
   *  a CSS length from the LEFT edge. The tablet drawer passes the activity
   *  rail's width so the rail stays uncovered, visible and clickable beside it. */
  offsetLeft?: string
  /** `side` with `anchor: "right"`: the same, measured from the RIGHT edge. */
  offsetRight?: string
  /** `side` only: the drawer's own width, as a CSS length. */
  width?: string
  title?: string
  /** Accessible name for the close control. Callers translate: `ui/` never
   *  imports the i18n module. Defaults to the English word. */
  closeLabel?: string
  /** `side` only: return true for an element that must NOT dismiss the sheet
   *  when it is interacted with, even though it sits outside the sheet. The
   *  activity rail is the case: a tap there swaps what the drawer shows (or
   *  closes it on the active entry), and Kobalte's default dismiss-on-outside
   *  would tear the drawer down before the rail's own handler decides. */
  keepOpenOutside?: (target: Element) => boolean
  children: JSX.Element
}

/**
 * The single sheet primitive every "sheet" surface in the responsive shell
 * wraps. It reuses Dialog's Kobalte root for the portal, the focus trap and
 * Escape-to-close rather than re-deriving any of them, and exposes
 * `data-overlay-sheet` plus `data-variant` on the sheet root so tests and the
 * layout oracle can key off the sheet shape. Query BOTH: `data-variant` alone
 * is also used by the Composer.
 */
/** The home indicator's inset, less whatever the native keyboard covers. */
const SHEET_SAFE_BOTTOM =
  "max(0px, calc(env(safe-area-inset-bottom, 0px) - var(--keyboard-inset, 0px)))"

export const OverlaySheet: Component<OverlaySheetProps> = (props) => {
  // Focus goes back to the control that opened the sheet. A caller that
  // UNMOUNTS the sheet to close it never gets here: the open -> closed
  // transition is the whole contract, so every caller keeps the sheet mounted
  // and drives `open`. Without this the viewer is left on document.body and
  // the next Tab restarts at the top of the page.
  let previouslyFocused: HTMLElement | null = null
  createEffect<boolean>((wasOpen) => {
    const open = props.open
    if (open && !wasOpen) {
      previouslyFocused = document.activeElement as HTMLElement | null
    } else if (!open && wasOpen) {
      const target = previouslyFocused
      previouslyFocused = null
      if (target?.isConnected) target.focus()
    }
    return open
  }, false)

  const isSide = () => props.variant === "side"
  const isRight = () => isSide() && props.anchor === "right"
  // The drawer's own header row exists only to carry a title. Untitled (the
  // tablet sidebar drawer is), it was a 61 px empty band holding a lone X,
  // which is the first thing the eye lands on and says nothing. The drawer has
  // two other ways out that a touch device can reach, the scrim beside it and
  // the rail entry that opened it, plus Escape on a keyboard.
  const showsHeader = () => !isSide() || props.title !== undefined
  // The scrim starts where the drawer starts, so everything to the LEFT of the
  // offset (the activity rail) is neither dimmed nor covered: the rail keeps
  // taking taps with no z-index games, because nothing is on top of it.
  // A right-anchored drawer mirrors it: the scrim stops where the drawer
  // starts, counted from the right edge.
  const sideOffset = () =>
    isSide()
      ? isRight()
        ? { right: props.offsetRight ?? "0px" }
        : { left: props.offsetLeft ?? "0px" }
      : undefined

  return (
    <Dialog
      open={props.open}
      // A side drawer is NOT modal: it sits beside the surface that opened it
      // and both stay reachable, by finger and by Tab. A modal dialog would
      // trap focus inside the drawer and hide the rail from screen readers.
      modal={!isSide()}
      onOpenChange={(open) => {
        if (!open) props.onClose()
      }}
    >
      <Dialog.Content
        overlayTestId={isSide() ? "overlay-sheet-scrim" : undefined}
        overlayStyle={sideOffset()}
        // The drawer is a raised layer, so what is behind it is DIMMED, the
        // same dark translucent wash the modal sheets use. `bg-overlay` is a
        // 55% WHITE veil in the light theme: it washes the content area out
        // rather than pushing it back, and the drawer's own shadow disappears
        // into it.
        overlayClass={isSide() ? "pointer-events-auto backdrop-blur-none" : undefined}
        onInteractOutside={(e) => {
          const target = e.detail.originalEvent.target
          if (target instanceof Element && props.keepOpenOutside?.(target)) e.preventDefault()
        }}
        // The positioner is `fixed inset-0`: it spans the WHOLE row, rail
        // included, and stacks over it. Left as a live surface it eats every
        // tap aimed at the rail beside the drawer (the rail entries, the
        // drawer toggle), and the tap that Kobalte does see lands on the
        // positioner, whose ancestors carry no `[data-activity-rail]`, so
        // `keepOpenOutside` says "not the rail" and the drawer is torn down.
        // The container therefore takes NO pointer events: only the panel and
        // the scrim, its two children that are actually painted, take them
        // back.
        positionerClass={cn(
          "p-0",
          props.variant === "bottom" && "items-end",
          isSide() && "pointer-events-none items-stretch",
          isSide() && (isRight() ? "justify-end" : "justify-start"),
        )}
        // The positioner is `fixed inset-0`, so the drawer is pushed off the
        // rail with a margin rather than a `left` (a static flex child ignores
        // `left`). `width` beats the `w-full` class: inline style wins.
        //
        // A `full` or `bottom` sheet reaches the screen's own edges, so it
        // keeps clear of them itself: a full sheet drew its header and close
        // button under the status bar. The bottom inset is only padded where
        // the native keyboard leaves it uncovered (index.css).
        style={
          isSide()
            ? isRight()
              ? { "margin-right": props.offsetRight ?? "0px", width: props.width }
              : { "margin-left": props.offsetLeft ?? "0px", width: props.width }
            : {
                "padding-top":
                  props.variant === "full" ? "env(safe-area-inset-top, 0px)" : undefined,
                "padding-bottom": SHEET_SAFE_BOTTOM,
              }
        }
        class={cn(
          "flex max-w-full flex-col overflow-hidden border-border bg-elevated p-0",
          props.variant === "full" && "h-full w-full rounded-none border-0",
          // No border: a border is what an inline COLUMN has. A drawer is told
          // apart from the surface under it by its elevation shadow, and
          // `shadow-popover` carries a 1px ring that draws one on every side.
          // The shadow falls away from the anchored edge, onto the content.
          isSide() && "pointer-events-auto h-full w-full rounded-none border-0",
          isSide() && (isRight() ? "shadow-drawer-end" : "shadow-drawer"),
          // Capped by its positioner too, which stops at the top of the
          // native keyboard (index.css): 80vh of a screen the keyboard has
          // taken a third of would push the sheet's header off the top.
          props.variant === "bottom" &&
            "max-h-[min(80vh,100%)] w-full rounded-b-none rounded-t-xl border-x-0 border-b-0",
        )}
      >
        <div
          data-overlay-sheet=""
          data-variant={props.variant}
          class="flex min-h-0 w-full flex-1 flex-col"
        >
          {/*
            The header row is always rendered for a `full` or `bottom` sheet,
            title or not: a touch device has no Escape key and those sheets
            cover what opened them, so without a close control the sheet is a
            trap. A `side` drawer is the exception (see `showsHeader`). The
            close button carries a 44 px minimum hit area, the oracle's touch
            target floor.
          */}
          <Show when={showsHeader()}>
            <div class="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2">
              <Show when={props.title} fallback={<div class="min-w-0 flex-1" />}>
                {(title) => (
                  <Dialog.Title class="min-w-0 flex-1 truncate text-base">{title()}</Dialog.Title>
                )}
              </Show>
              <Dialog.Close
                data-testid="overlay-sheet-close"
                aria-label={props.closeLabel ?? "Close"}
                class="-mr-2 flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-surface-hover"
              >
                <X size={20} />
              </Dialog.Close>
            </div>
          </Show>
          <div class="min-h-0 flex-1 overflow-y-auto">{props.children}</div>
        </div>
      </Dialog.Content>
    </Dialog>
  )
}

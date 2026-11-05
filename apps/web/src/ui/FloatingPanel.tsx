// SPDX-License-Identifier: FSL-1.1-ALv2
import { Popover } from "@kobalte/core/popover"
import {
  createContext,
  createSignal,
  type JSX,
  onCleanup,
  type ParentComponent,
  splitProps,
  useContext,
} from "solid-js"
import { cn } from "~/lib/cn"

interface FloatingPanelContextValue {
  hoverIn(): void
  hoverOut(): void
  toggleFromTouch(): void
  consumeTouchClick(): boolean
  viewportInset(): number
}

/**
 * Gutter kept between a floating panel and the viewport edge.
 *
 * On a phone the anchor is usually a trailing header button, so the panel is
 * flipped hard against the right edge: the 390px thread actions menu came out
 * of a gestalt walk with its border ON the screen edge, reading as a piece of
 * torn-off chrome rather than a card. A phone has no pointer margin to spare,
 * so the inset is a full 16px there, matching the shell's own phone gutter.
 * Desktop and tablet keep a tighter edge: the panel is small relative to the
 * viewport and the extra padding only makes it jump away from its anchor.
 */
export const PHONE_VIEWPORT_INSET_PX = 16
export const VIEWPORT_INSET_PX = 8

export function viewportInsetForTier(tier: string | null | undefined): number {
  return tier === "phone" ? PHONE_VIEWPORT_INSET_PX : VIEWPORT_INSET_PX
}

/**
 * The shell's current layout tier, read from the `data-shell-tier` attribute
 * the shell publishes on its root. This layer may not import the shell's own
 * signal (ui/ owns no domain imports), and re-deriving the breakpoints here
 * would be a second copy of them free to drift; the attribute is the contract
 * `index.css` already keys its touch floor off, so it is the one this reads.
 */
function currentShellTier(): string | null {
  if (typeof document === "undefined") return null
  return document.querySelector("[data-shell-tier]")?.getAttribute("data-shell-tier") ?? null
}

const FloatingPanelContext = createContext<FloatingPanelContextValue>()

function useFloatingPanelContext() {
  const ctx = useContext(FloatingPanelContext)
  if (!ctx) throw new Error("FloatingPanel.Trigger/Content must be used within FloatingPanel")
  return ctx
}

interface RootProps {
  open: boolean
  onOpenChange(open: boolean): void
  children: JSX.Element
  // Anchor the panel to an arbitrary element instead of a FloatingPanel.Trigger.
  // Without a Trigger AND without an anchorRef, Kobalte has no reference rect and
  // the content renders detached at the viewport edge.
  anchorRef?: () => HTMLElement | undefined
}

const HOVER_GRACE_MS = 300

// A tap produces pointerdown, then (on some engines) a synthesized click.
// Kobalte's Popover.Trigger cancels pointerdown and toggles on click, so on a
// touch device the tap either opens nothing (WebKit suppresses the synthesized
// click of a canceled pointerdown) or opens and immediately closes again.
// The trigger therefore owns the touch toggle itself and swallows the trailing
// click inside this window.
const TOUCH_CLICK_GRACE_MS = 700

const Root: ParentComponent<RootProps> = (props) => {
  const [local, forwarded] = splitProps(props, ["children"])
  let timer: number | undefined
  onCleanup(() => clearTimeout(timer))

  let touchToggledAt = 0

  const ctx: FloatingPanelContextValue = {
    hoverIn() {
      clearTimeout(timer)
    },
    hoverOut() {
      clearTimeout(timer)
      timer = window.setTimeout(() => forwarded.onOpenChange(false), HOVER_GRACE_MS)
    },
    toggleFromTouch() {
      clearTimeout(timer)
      touchToggledAt = Date.now()
      forwarded.onOpenChange(!forwarded.open)
    },
    consumeTouchClick() {
      if (touchToggledAt === 0) return false
      const withinGrace = Date.now() - touchToggledAt < TOUCH_CLICK_GRACE_MS
      touchToggledAt = 0
      return withinGrace
    },
    viewportInset: () => viewportInsetForTier(currentShellTier()),
  }

  return (
    <FloatingPanelContext.Provider value={ctx}>
      <Popover
        open={forwarded.open}
        onOpenChange={forwarded.onOpenChange}
        gutter={4}
        // Kobalte's collision padding. Without it the panel is allowed to sit
        // flush against the viewport edge.
        overflowPadding={ctx.viewportInset()}
        anchorRef={forwarded.anchorRef}
      >
        {local.children}
      </Popover>
    </FloatingPanelContext.Provider>
  )
}

interface TriggerProps extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
  as?: keyof JSX.IntrinsicElements
  class?: string
  "aria-label"?: string
}

const Trigger: ParentComponent<TriggerProps> = (props) => {
  const [local, others] = splitProps(props, [
    "children",
    "class",
    "aria-label",
    "onPointerEnter",
    "onPointerLeave",
    "onPointerOver",
    "onPointerOut",
    "onPointerDown",
    "onMouseDown",
    "onClick",
    "onKeyDown",
  ])
  const ctx = useFloatingPanelContext()

  // Kobalte listens for click through Solid's document-level delegation, so a
  // capture-phase listener on the button itself is the only place a synthesized
  // post-touch click can be stopped before Kobalte toggles the popover shut.
  function bindTrigger(el: HTMLButtonElement) {
    const swallow = (event: MouseEvent) => {
      if (!ctx.consumeTouchClick()) return
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
    }
    el.addEventListener("click", swallow, true)
    onCleanup(() => el.removeEventListener("click", swallow, true))
  }

  return (
    <Popover.Trigger
      {...others}
      ref={bindTrigger}
      class={cn("outline-none", local.class)}
      aria-label={local["aria-label"]}
      onPointerEnter={(event: PointerEvent) => {
        // A tap emits pointerenter then pointerleave around pointerup, so the
        // hover grace would close the panel the tap just opened.
        if (event.pointerType !== "touch") ctx.hoverIn()
        ;(local.onPointerEnter as any)?.(event)
      }}
      onPointerLeave={(event: PointerEvent) => {
        if (event.pointerType !== "touch") ctx.hoverOut()
        ;(local.onPointerLeave as any)?.(event)
      }}
      onPointerOver={(event: PointerEvent) => (local.onPointerOver as any)?.(event)}
      onPointerOut={(event: PointerEvent) => (local.onPointerOut as any)?.(event)}
      onPointerDown={(event: PointerEvent) => {
        ;(local.onPointerDown as any)?.(event)
        if (event.pointerType === "touch") ctx.toggleFromTouch()
      }}
      onMouseDown={(event: MouseEvent) => (local.onMouseDown as any)?.(event)}
      onClick={(event: MouseEvent) => (local.onClick as any)?.(event)}
      onKeyDown={(event: KeyboardEvent) => (local.onKeyDown as any)?.(event)}
    >
      {local.children}
    </Popover.Trigger>
  )
}

interface ContentProps {
  class?: string
  children: JSX.Element
  // Forwarded verbatim to the underlying Popover.Content via {...others}
  // (e.g. roving-focus key handlers on menu panels).
  onKeyDown?: JSX.EventHandlerUnion<HTMLDivElement, KeyboardEvent>
  // Called once the panel has closed, before focus returns to the trigger;
  // preventDefault keeps focus where a follow-up surface put it.
  onCloseAutoFocus?: (event: Event) => void
}

const Content: ParentComponent<ContentProps> = (props) => {
  const [local, others] = splitProps(props, ["children", "class"])
  const ctx = useFloatingPanelContext()

  return (
    <Popover.Portal>
      <Popover.Content
        // The resolved inset, restated in the markup: the padding itself is
        // consumed by the positioning engine, which does not run under jsdom,
        // so this is what a test can hold the phone gutter to.
        data-viewport-inset={ctx.viewportInset()}
        class={cn(
          "popup-menu z-50 rounded-lg border border-border bg-elevated py-1 shadow-popover outline-none",
          local.class,
        )}
        onPointerEnter={(event: PointerEvent) => {
          if (event.pointerType !== "touch") ctx.hoverIn()
        }}
        onPointerLeave={(event: PointerEvent) => {
          if (event.pointerType !== "touch") ctx.hoverOut()
        }}
        {...others}
      >
        {local.children}
      </Popover.Content>
    </Popover.Portal>
  )
}

interface UncontrolledProps {
  trigger: JSX.Element
  triggerClass?: string
  triggerLabel?: string
  contentClass?: string
  children: JSX.Element
}

const Uncontrolled: ParentComponent<UncontrolledProps> = (props) => {
  const [local] = splitProps(props, [
    "trigger",
    "triggerClass",
    "triggerLabel",
    "contentClass",
    "children",
  ])
  const [open, setOpen] = createSignal(false)

  return (
    <Root open={open()} onOpenChange={setOpen}>
      <Trigger class={local.triggerClass} aria-label={local.triggerLabel}>
        {local.trigger}
      </Trigger>
      <Content class={local.contentClass}>{local.children}</Content>
    </Root>
  )
}

export const FloatingPanel = Object.assign(Root, {
  Trigger,
  Content,
  Uncontrolled,
})

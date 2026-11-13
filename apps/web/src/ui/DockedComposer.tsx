// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE ONE WAY A SURFACE PUTS A TEXT INPUT AT ITS BOTTOM. Every composer (chat,
// reply thread, session, ticket, mail, task discussion) renders its root as a
// DockedComposer, and no surface writes keyboard code of its own.
//
// The native keyboard is handled once, in the layout (primitives/
// keyboardInset.ts): the shell's height stops at the keyboard's top, so the
// last row of a full-height column sits right above it. That is the `footer`
// mode, the default: the composer is the bottom row of its column and the
// primitive only marks it.
//
// A composer that lives INSIDE a scrolling page (the task discussion, between
// the task's body and its comments) has no bottom row to sit in: under the
// keyboard it would scroll away with the page. That is the `inline` mode:
// while focus is inside it and the native keyboard is up, it docks itself to
// the keyboard's top (`--keyboard-inset`) as a full-width bar, and a spacer
// keeps its place in the page so nothing behind it jumps. Focus leaving it or
// the keyboard going down puts it back in the page. In a browser the inset is
// always 0, so it never docks: desktop and web layouts are unchanged.
//
// A `footer` composer also rises above the desktop dock's bar once the bar
// grows far enough left to hide one of its controls (primitives/dockLift.ts),
// and drops back when the bar shrinks. A bar that only grazes the Send corner
// moves nothing.
import { createSignal, type JSX, type ParentComponent, Show, splitProps } from "solid-js"
import { cn } from "~/lib/cn"
import { createDockLift } from "~/primitives/dockLift"
import { keyboardOpen } from "~/primitives/keyboardInset"

export type DockedComposerMode = "footer" | "inline"

export interface DockedComposerProps extends Omit<JSX.HTMLAttributes<HTMLDivElement>, "style"> {
  /** `footer` (default): the bottom row of a full-height column. `inline`: inside a scrolling page. */
  mode?: DockedComposerMode
  style?: JSX.CSSProperties
}

/** The docked bar's chrome: full width, over the page, clear of the keys. */
const DOCKED_STYLE: JSX.CSSProperties = {
  position: "fixed",
  left: "0px",
  right: "0px",
  bottom: "var(--keyboard-inset, 0px)",
  "max-height": "calc((100dvh - var(--keyboard-inset, 0px)) * 0.6)",
}

export const DockedComposer: ParentComponent<DockedComposerProps> = (props) => {
  const [local, rest] = splitProps(props, ["mode", "class", "style", "ref", "children"])
  const mode = (): DockedComposerMode => local.mode ?? "footer"
  const [focused, setFocused] = createSignal(false)
  const [placeHeight, setPlaceHeight] = createSignal(0)
  const [root, setRoot] = createSignal<HTMLDivElement>()

  const docked = () => mode() === "inline" && focused() && keyboardOpen()
  // Only a footer sits at the panel's bottom, where the dock's bar lies.
  const lift = createDockLift(root, () => mode() === "footer" && !keyboardOpen())
  const style = (): JSX.CSSProperties | undefined => {
    if (docked()) return { ...local.style, ...DOCKED_STYLE }
    const l = lift()
    return l > 0 ? { ...local.style, "margin-bottom": `${l}px` } : local.style
  }

  const onFocusIn = (): void => {
    // Measured while still in the page: the spacer keeps exactly this place.
    const el = root()
    if (!focused() && el) setPlaceHeight(el.offsetHeight)
    setFocused(true)
  }
  const onFocusOut = (e: FocusEvent): void => {
    const next = e.relatedTarget as Node | null
    if (next && root()?.contains(next)) return
    setFocused(false)
  }

  return (
    <>
      <Show when={docked()}>
        <div aria-hidden="true" data-composer-spacer style={{ height: `${placeHeight()}px` }} />
      </Show>
      <div
        {...rest}
        ref={(el) => {
          setRoot(el)
          if (typeof local.ref === "function") local.ref(el)
        }}
        data-composer-dock={mode()}
        data-docked={docked() ? "" : undefined}
        data-dock-lift={lift() > 0 ? String(lift()) : undefined}
        class={cn(
          local.class,
          docked() && "z-40 overflow-y-auto border-t border-border bg-bg px-3 py-2",
        )}
        style={style()}
        onFocusIn={onFocusIn}
        onFocusOut={onFocusOut}
      >
        {local.children}
      </div>
    </>
  )
}

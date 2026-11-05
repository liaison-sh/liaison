// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What the software keyboard covers INSIDE THE NATIVE APP, as one signal and
// one CSS custom property.
//
// In a mobile browser the keyboard shrinks `window.visualViewport`, and
// createVisualViewport reads that. The iOS app is different: @capacitor/
// keyboard takes the keyboard notifications away from WKWebView, so the
// visual viewport, `innerHeight` and `100dvh` all keep their full height while
// the keyboard sits over the bottom third of the page. The shell is told
// instead, and publishes the keyboard's height on the bridge
// (`onKeyboardInset`, apps/mobile/src/native/keyboard.ts).
//
// ONE LIFT, IN THE LAYOUT, NOT PER SCREEN. The height lands on the root as
// `--keyboard-inset`, and the few things that are measured from the bottom
// of the screen subtract it: the shell's own height (every route inside it,
// thread, DM, ticket, mail, search, settings), the viewport-fixed overlays
// and the full-screen pages outside the shell (index.css). A screen never
// adds it to its own padding: that is the double lift the old `resize` modes
// produced. A text input at the bottom of a screen is a DockedComposer
// (ui/DockedComposer.tsx), any other field is scrolled back into view when
// the keyboard comes up (below). In a browser nothing is published, the
// property stays 0px and nothing changes.
import { type Accessor, createSignal } from "solid-js"
import { nativeOnKeyboardInset } from "~/lib/native-bridge"

/** The custom property every keyboard-aware rule reads. */
export const KEYBOARD_INSET_PROPERTY = "--keyboard-inset"

const [inset, setInset] = createSignal(0)

/** Pixels covered by the keyboard in the native app; 0 in a browser. */
export const keyboardInset: Accessor<number> = inset

/** Whether the native keyboard is up. */
export const keyboardOpen: Accessor<boolean> = () => inset() > 0

/**
 * The field being typed in, back in view. The web view is never told about
 * the keyboard, so it does not scroll the focused field out from under it as
 * a browser would; once the layout has lifted, the field is brought into the
 * area left visible. Any field, on any screen: no screen does it itself. A
 * composer (ui/DockedComposer.tsx) is already at the keyboard's top.
 *
 * The field's whole form comes into view when it fits, so its submit button
 * is not left under the keyboard ("Connect" under the server address on the
 * sign-in card); a form taller than the visible area reveals the field alone.
 */
function revealFocusedField(): void {
  if (typeof document === "undefined" || typeof requestAnimationFrame === "undefined") return
  requestAnimationFrame(() => {
    const el = document.activeElement
    if (!(el instanceof HTMLElement) || el === document.body) return
    if (el.closest("[data-composer-dock]")) return
    const form = el.closest("form")
    const visible = window.innerHeight - inset()
    const target = form && form.getBoundingClientRect().height <= visible ? form : el
    target.scrollIntoView?.({ block: "nearest" })
  })
}

/** Applies one reading: the signal, the root property and a root attribute. */
export function applyKeyboardInset(px: number, root?: HTMLElement): void {
  const value = Number.isFinite(px) && px > 0 ? Math.round(px) : 0
  const rising = value > inset()
  setInset(value)
  if (rising) revealFocusedField()
  const el = root ?? (typeof document !== "undefined" ? document.documentElement : undefined)
  if (!el) return
  el.style.setProperty(KEYBOARD_INSET_PROPERTY, `${value}px`)
  if (value > 0) el.setAttribute("data-keyboard-open", "")
  else el.removeAttribute("data-keyboard-open")
}

/**
 * Subscribes to the shell's keyboard inset, once, at boot. A no-op in a
 * browser and under an older shell that publishes no such member. Returns the
 * unsubscribe.
 */
export function startKeyboardInset(): () => void {
  const subscribe = nativeOnKeyboardInset()
  if (!subscribe) return () => {}
  try {
    const off = subscribe((px) => applyKeyboardInset(px))
    return typeof off === "function" ? off : () => {}
  } catch {
    return () => {}
  }
}

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHERE DICTATED TEXT LANDS. The place is taken when recording STARTS (the
// caret, or the selection to replace) and the text goes there when the
// transcript arrives, whatever the caret did in between. If the person typed
// meanwhile, what they typed is never replaced: a plain field then takes the
// text at its current caret, a rich editor after the typing (its anchor maps
// through every edit). Never the wand's `readTarget`: a collapsed caret there
// means "the whole input".
//
// A plain field writes through the browser's own insertText, so one native
// undo takes the text back out. A rich editor writes one ProseMirror
// transaction through its handle, so its own history undoes it. Either way
// the text lands focused and tinted for a moment.
import type { RichEditorHandle, TextAnchor } from "~/modules/editor"

/** The tint's length: index.css `.inserted-tint-field`, as the editor's own. */
const INSERTED_TINT_MS = 1600

export type DictationTarget = HTMLTextAreaElement | HTMLInputElement | RichEditorHandle

function isField(t: DictationTarget): t is HTMLTextAreaElement | HTMLInputElement {
  return t instanceof HTMLTextAreaElement || t instanceof HTMLInputElement
}

/** The element a person types in. */
export function targetElement(t: DictationTarget): HTMLElement {
  return isField(t) ? t : t.element
}

/** The place held from record start until the text arrives (or the take is dropped). */
export interface DictationAnchor {
  insert: (text: string) => void
  release: () => void
}

/**
 * Type `text` over `[start, end)` of a field the way a person would: the
 * browser's insertText keeps the native undo stack. Where the engine has no
 * insertText (it answered false), the value is spliced and an input event
 * fired so the surface's own state follows.
 */
function typeIntoField(
  el: HTMLTextAreaElement | HTMLInputElement,
  start: number,
  end: number,
  text: string,
): void {
  el.focus()
  el.setSelectionRange(start, end)
  const typed =
    typeof document.execCommand === "function" && document.execCommand("insertText", false, text)
  if (!typed) {
    el.setRangeText(text, start, end, "end")
    el.dispatchEvent(new Event("input", { bubbles: true }))
  }
}

/** A plain field cannot tint a range: the whole field takes the tint. */
function tintField(el: HTMLElement): void {
  el.classList.remove("inserted-tint-field")
  // Restart the animation when two takes land back to back.
  void el.offsetWidth
  el.classList.add("inserted-tint-field")
  setTimeout(() => el.classList.remove("inserted-tint-field"), INSERTED_TINT_MS)
}

/** Hold the target's caret or selection as it is now. */
export function captureAnchor(target: DictationTarget): DictationAnchor {
  if (isField(target)) {
    const el = target
    const start = el.selectionStart ?? el.value.length
    const end = el.selectionEnd ?? start
    const captured = el.value
    return {
      insert: (text) => {
        // The field changed meanwhile (the person kept typing): the held
        // offsets no longer name that place, so nothing is replaced and the
        // text goes in at the caret as it is now.
        if (el.value !== captured) {
          const at = el.selectionEnd ?? el.value.length
          typeIntoField(el, at, at, text)
        } else {
          typeIntoField(el, start, end, text)
        }
        tintField(el)
      },
      release: () => {},
    }
  }
  const editor = target
  const held: TextAnchor = editor.anchor()
  return {
    insert: (text) => {
      const range = editor.replaceText(held.range(), text)
      held.release()
      editor.tint(range)
    },
    release: () => held.release(),
  }
}

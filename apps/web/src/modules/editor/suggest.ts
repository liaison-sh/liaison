// SPDX-License-Identifier: FSL-1.1-ALv2
// What every list under the caret shares (emoji `:`, page `@` / `[[`, blocks `/`):
// the text its trigger is looked for in, where the list opens, and the keys it takes
// while open. The editor keeps the focus and the caret; the list never takes them.
import type { EditorState } from "@tiptap/pm/state"
import type { EditorView } from "@tiptap/pm/view"

/** Viewport position of the caret: a list opens under it, or above it near the bottom. */
export interface SuggestAnchor {
  left: number
  top: number
  bottom: number
}

/**
 * The text before the caret in its block (leaves as a placeholder), or null where no
 * trigger may open: a selection, code (a code block or a code mark) and a link.
 */
export function textBeforeCaret(state: EditorState): string | null {
  const { empty, $from } = state.selection
  if (!empty || $from.parent.type.spec.code) return null
  if ($from.marks().some((m) => m.type.name === "code" || m.type.name === "link")) return null
  return $from.parent.textBetween(0, $from.parentOffset, undefined, (leaf) =>
    leaf.type.name === "hardBreak" ? "\n" : "￼",
  )
}

/** Where `pos` is on screen; the corner when there is no layout (a test environment). */
export function caretAnchor(view: EditorView, pos: number): SuggestAnchor {
  try {
    const at = view.coordsAtPos(pos)
    return { left: at.left, top: at.top, bottom: at.bottom }
  } catch {
    return { left: 0, top: 0, bottom: 0 }
  }
}

/** An open list as its keys see it. */
export interface OpenSuggest<T> {
  items: readonly T[]
  active: number
}

/**
 * The keys an open list takes before the editor: the arrows move, Enter or Tab picks,
 * Escape closes. Answers whether the key was taken (then its default is prevented).
 */
export function suggestKey<T>(
  event: KeyboardEvent,
  open: OpenSuggest<T> | null,
  on: { move: (active: number) => void; pick: (item: T) => void; dismiss: () => void },
): boolean {
  if (!open || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return false
  const n = open.items.length
  switch (event.key) {
    case "ArrowDown":
    case "ArrowUp": {
      if (!n) return false
      const step = event.key === "ArrowDown" ? 1 : n - 1
      on.move((open.active + step) % n)
      break
    }
    case "Enter":
    case "Tab": {
      if (event.shiftKey || !n) return false
      on.pick(open.items[open.active]!)
      break
    }
    case "Escape":
      on.dismiss()
      break
    default:
      return false
  }
  event.preventDefault()
  return true
}

/** The id of a list's option, for the text field's aria-activedescendant. */
export function suggestOptionId(listId: string, index: number): string {
  return `${listId}-option-${index}`
}

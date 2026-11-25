// SPDX-License-Identifier: FSL-1.1-ALv2
// Where a page link is being typed: `@` or `[[` at the start of a word (the start of
// a line, after a space or an opening parenthesis), then the words looked for. An
// address (ana@site.example), a `a[[b` inside a word and code never open the picker.
import type { EditorState } from "@tiptap/pm/state"

/** `@` then up to 40 characters, the first not a space. */
const AT = /(?:^|[\s(])@((?:[^\s@][^@\n]{0,39})?)$/
/** `[[` then up to 40 characters without a bracket. */
const BRACKETS = /(?:^|[\s(])\[\[([^[\]\n]{0,40})$/

export interface PageQuery {
  trigger: "@" | "[["
  /** What was typed after the trigger. */
  text: string
  /** Document position of the trigger's first character. */
  from: number
}

/** The page link being typed at the caret, or null. */
export function pageQueryAt(state: EditorState): PageQuery | null {
  const { empty, $from } = state.selection
  if (!empty || $from.parent.type.spec.code) return null
  if ($from.marks().some((m) => m.type.name === "code" || m.type.name === "link")) return null
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, (leaf) =>
    leaf.type.name === "hardBreak" ? "\n" : "￼",
  )
  const brackets = BRACKETS.exec(before)
  if (brackets) {
    const text = brackets[1]!
    return { trigger: "[[", text, from: state.selection.from - text.length - 2 }
  }
  const at = AT.exec(before)
  if (at) {
    const text = at[1]!
    return { trigger: "@", text, from: state.selection.from - text.length - 1 }
  }
  return null
}

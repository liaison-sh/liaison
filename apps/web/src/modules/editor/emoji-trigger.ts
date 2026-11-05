// SPDX-License-Identifier: FSL-1.1-ALv2
// Where a `:` starts an emoji shortcode. Only at the start of a text or after
// whitespace or opening punctuation, so a time (10:30), a URL (https://x),
// a word:with:colons and code are never taken for one.
import type { EditorState } from "@tiptap/pm/state"

/** What may stand right before the colon: nothing, a space, or opening punctuation. */
const BEFORE = String.raw`(?:^|[\s(\[{"'<,;!?*>])`
const OPEN = new RegExp(`${BEFORE}:([A-Za-z][\\w+-]+)$`)
const CLOSED = new RegExp(`${BEFORE}:([A-Za-z0-9][\\w+-]*|\\+1|-1)$`)

export interface EmojiQuery {
  /** The letters typed after the colon. */
  text: string
  /** Document position of the colon. */
  from: number
}

/** Text before the caret in its block, leaves as a placeholder. */
function beforeCaret(state: EditorState): string | null {
  const { empty, $from } = state.selection
  if (!empty || $from.parent.type.spec.code) return null
  if ($from.marks().some((m) => m.type.name === "code" || m.type.name === "link")) return null
  return $from.parent.textBetween(0, $from.parentOffset, undefined, (leaf) =>
    leaf.type.name === "hardBreak" ? "\n" : "￼",
  )
}

/** The `:xx` being typed at the caret (two letters or more), or null. */
export function emojiQueryAt(state: EditorState): EmojiQuery | null {
  const before = beforeCaret(state)
  const match = before === null ? null : OPEN.exec(before)
  if (!match) return null
  const text = match[1]!
  return { text, from: state.selection.from - text.length - 1 }
}

/** `:name` right before the caret, for a closing colon about to be typed. */
export function emojiNameBeforeColon(state: EditorState): EmojiQuery | null {
  const before = beforeCaret(state)
  const match = before === null ? null : CLOSED.exec(before)
  if (!match) return null
  const text = match[1]!
  return { text, from: state.selection.from - text.length - 1 }
}

// SPDX-License-Identifier: FSL-1.1-ALv2
// The `/` menu of a page (document preset): the blocks the editor stores as markdown.
// `/` opens it at the start of a block or after a space, so a path (a/b), an address
// (https://x/y), a date (24/11) and code never do. What follows the slash filters the
// blocks by their name and their search words, in the reader's language.
import type { Editor } from "@tiptap/core"
import type { EditorState } from "@tiptap/pm/state"
import { textBeforeCaret } from "./suggest"

/** `/` at the start or after a space, then up to 24 letters, digits, spaces or dashes ("/to-do"). */
const SLASH = /(?:^|\s)\/([\p{L}\p{N}][\p{L}\p{N} -]{0,23}|)$/u

export interface SlashQuery {
  /** What was typed after the slash. */
  text: string
  /** Document position of the slash. */
  from: number
}

/** The `/` query being typed at the caret, or null. */
export function slashQueryAt(state: EditorState): SlashQuery | null {
  const before = textBeforeCaret(state)
  const match = before === null ? null : SLASH.exec(before)
  if (!match) return null
  const text = match[1]!
  return { text, from: state.selection.from - text.length - 1 }
}

/** What a block needs that only some editors have. */
export interface SlashContext {
  /** Open the image or file picker (a page with files). */
  pickFile?: (kind: "image" | "file") => void
  /** The editor links pages (`@` opens the page picker). */
  pages: boolean
}

export type SlashKey =
  | "text"
  | "heading1"
  | "heading2"
  | "heading3"
  | "taskList"
  | "bulletList"
  | "orderedList"
  | "quote"
  | "callout"
  | "codeBlock"
  | "table"
  | "divider"
  | "image"
  | "file"
  | "linkToPage"

export interface SlashBlock {
  key: SlashKey
  /** Markdown it is written as, shown at the end of its row ("" for none). */
  hint: string
  /** Shown only when the editor has what it needs. */
  available?: (ctx: SlashContext) => boolean
  run: (ed: Editor, ctx: SlashContext) => void
}

const chain = (ed: Editor) => ed.chain().focus()

/** In the order of the menu. Each is stored as markdown and reads back the same. */
export const SLASH_BLOCKS: readonly SlashBlock[] = [
  { key: "text", hint: "", run: (ed) => chain(ed).setParagraph().run() },
  { key: "heading1", hint: "#", run: (ed) => chain(ed).setHeading({ level: 1 }).run() },
  { key: "heading2", hint: "##", run: (ed) => chain(ed).setHeading({ level: 2 }).run() },
  { key: "heading3", hint: "###", run: (ed) => chain(ed).setHeading({ level: 3 }).run() },
  { key: "taskList", hint: "[ ]", run: (ed) => chain(ed).toggleTaskList().run() },
  { key: "bulletList", hint: "-", run: (ed) => chain(ed).toggleBulletList().run() },
  { key: "orderedList", hint: "1.", run: (ed) => chain(ed).toggleOrderedList().run() },
  { key: "quote", hint: ">", run: (ed) => chain(ed).toggleBlockquote().run() },
  {
    key: "callout",
    hint: "> [!NOTE]",
    run: (ed) => chain(ed).setParagraph().setCallout().run(),
  },
  { key: "codeBlock", hint: "```", run: (ed) => chain(ed).toggleCodeBlock().run() },
  {
    key: "table",
    hint: "",
    run: (ed) => chain(ed).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
  { key: "divider", hint: "---", run: (ed) => chain(ed).setHorizontalRule().run() },
  {
    key: "image",
    hint: "",
    available: (ctx) => !!ctx.pickFile,
    run: (_ed, ctx) => ctx.pickFile?.("image"),
  },
  {
    key: "file",
    hint: "",
    available: (ctx) => !!ctx.pickFile,
    run: (_ed, ctx) => ctx.pickFile?.("file"),
  },
  {
    key: "linkToPage",
    hint: "@",
    available: (ctx) => ctx.pages,
    // The `@` opens the page picker where it was typed.
    run: (ed) => chain(ed).insertContent("@").run(),
  },
]

/** Lower case, without accents or dashes: "Élément" finds "element", "to-do" finds "todo". */
const fold = (s: string) =>
  s.normalize("NFD").replace(/\p{M}/gu, "").replace(/-/g, "").toLowerCase()

/**
 * The blocks whose name or search words hold every word typed, the ones whose
 * name starts with it first; all of them for an empty query.
 */
export function slashBlocks(
  query: string,
  ctx: SlashContext,
  words: (block: SlashBlock) => { title: string; words: string },
): SlashBlock[] {
  const shown = SLASH_BLOCKS.filter((b) => !b.available || b.available(ctx))
  const typed = fold(query).trim()
  if (!typed) return shown
  const parts = typed.split(/\s+/)
  const scored = shown.flatMap((b) => {
    const { title, words: extra } = words(b)
    const name = fold(title)
    const hay = `${name} ${fold(extra)} ${b.key.toLowerCase()}`
    if (!parts.every((p) => hay.includes(p))) return []
    return [{ b, first: name.startsWith(typed) ? 0 : 1 }]
  })
  return scored.sort((a, z) => a.first - z.first).map((s) => s.b)
}

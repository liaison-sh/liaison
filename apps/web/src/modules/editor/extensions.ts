// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The editor's schema and markdown dialect, per preset. Markdown in and out
// goes through TipTap's markdown extension; the two rules our renderers add
// (underline, mention chips) are taught to it here with the SAME matchers the
// renderers use, so a field reads back exactly as it was written.

import { matchUnderline } from "@liaison/shared"
import {
  type AnyExtension,
  type Editor,
  Extension,
  InputRule,
  type JSONContent,
  markInputRule,
  markPasteRule,
  Node,
} from "@tiptap/core"
import { Link } from "@tiptap/extension-link"
import { TaskItem, TaskList } from "@tiptap/extension-list"
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table"
import { Underline } from "@tiptap/extension-underline"
import { Placeholder } from "@tiptap/extensions"
import { Markdown, type MarkdownExtensionOptions } from "@tiptap/markdown"
import type { MarkType } from "@tiptap/pm/model"
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"
import { StarterKit } from "@tiptap/starter-kit"
import { Marked, type Token, type Tokens } from "marked"
import { wrapMarkdownTables } from "~/lib/markdown-tables"
import { sanitizeHtml } from "~/lib/sanitize"
import {
  getMentionPrefix,
  isEntityRefHref,
  isMentionRef,
  matchMention,
  mentionMarked,
} from "~/modules/shell/markdown-content"
import { rawHtml } from "./raw-html"

/**
 * A range just written by dictation, tinted for a moment (`.inserted-tint`
 * fades by itself, index.css). A transaction carrying the key's meta sets the
 * range (`{ from, to }`) or clears it (`null`); edits in between map it.
 */
export const insertedTintKey = new PluginKey<DecorationSet>("insertedTint")

const InsertedTint = Extension.create({
  name: "insertedTint",
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: insertedTintKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, set) {
            const meta: { from: number; to: number } | null | undefined =
              tr.getMeta(insertedTintKey)
            if (meta === null) return DecorationSet.empty
            if (meta && meta.to > meta.from) {
              return DecorationSet.create(tr.doc, [
                Decoration.inline(meta.from, meta.to, { class: "inserted-tint" }),
              ])
            }
            return set.map(tr.mapping, tr.doc)
          },
        },
        props: {
          decorations: (state) => insertedTintKey.getState(state),
        },
      }),
    ]
  },
})

/** `document`: the full tools plus H1 to H3 and editable tables (knowledge documents). */
export type EditorPreset = "full" | "minimal" | "inline" | "document"

export interface EditorKeys {
  /** Mod-Enter, and Enter itself in the inline preset or with `enterSubmits`. */
  onSubmit?: () => void
  /** Enter submits and Shift+Enter starts the next line (a message). */
  enterSubmits?: boolean
  onCancel?: () => void
  onLink: () => void
}

/** The heading level the toolbar toggles. One level in tasks; H1 to H3 in a document. */
export const TOOLBAR_HEADING = 2

const UNDERLINE_INPUT = /(?:^|\s)(\+\+(?!\s)([^+]+)(?<!\s)\+\+)$/
const UNDERLINE_PASTE = /(?:^|\s)(\+\+(?!\s)([^+]+)(?<!\s)\+\+)/g

const MarkdownUnderline = Underline.extend({
  addInputRules() {
    return [markInputRule({ find: UNDERLINE_INPUT, type: this.type })]
  },
  addPasteRules() {
    return [markPasteRule({ find: UNDERLINE_PASTE, type: this.type })]
  },
  markdownTokenizer: {
    name: "underline",
    level: "inline",
    start: (src) => src.indexOf("++"),
    tokenize(src, tokens, lexer) {
      const match = matchUnderline(src, tokens)
      if (!match) return undefined
      return { type: "underline", ...match, tokens: lexer.inlineTokens(match.text) }
    },
  },
})

/** A bare URL stays bare: `[https://x](https://x)` is noise to whoever reads the markdown. */
const MarkdownLink = Link.extend({
  renderMarkdown(node, h, ctx) {
    const text = h.renderChildren(node)
    const { href = "", title } = (node.attrs ?? {}) as { href?: string; title?: string | null }
    if (title) return `[${text}](${href} "${title}")`
    return ctx?.meta?.markText === href ? text : `[${text}](${href})`
  },
}).configure({
  openOnClick: false,
  autolink: true,
  defaultProtocol: "https",
  isAllowedUri: (url, ctx) => ctx.defaultValidate(url) || isEntityRefHref(url),
})

/** The inline preset's document: one paragraph, written back as that paragraph's markdown. */
const InlineDocument = Node.create({
  name: "doc",
  topNode: true,
  content: "paragraph",
  renderMarkdown: (node, h) => h.renderChildren(node.content ?? []),
})

const escapeLabel = (label: string) => label.replace(/[[\]\\]/g, "\\$&")

/** An `@[Label](app:type:id)` reference: a chip in the editor, the same token in markdown. */
const Mention = Node.create({
  name: "mention",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      label: { default: "" },
      ref: { default: "", parseHTML: (el) => el.getAttribute("data-mention-ref") },
    }
  },
  parseHTML() {
    return [{ tag: "span[data-mention-ref]", getAttrs: (el) => ({ label: el.dataset.label }) }]
  },
  renderHTML({ node }) {
    const { label, ref } = node.attrs as { label: string; ref: string }
    return [
      "span",
      { class: "mention-pill", "data-mention-ref": ref, "data-label": label },
      `${getMentionPrefix(ref)}${label}`,
    ]
  },
  renderText: ({ node }) => `@${node.attrs.label}`,
  markdownTokenizer: {
    name: "mention",
    level: "inline",
    start: (src) => src.search(/\[?@\[/),
    tokenize: (src) => {
      const match = matchMention(src)
      return match ? { type: "mention", ...match } : undefined
    },
  },
  parseMarkdown: (token) => ({
    type: "mention",
    attrs: { label: token.label as string, ref: token.ref as string },
  }),
  renderMarkdown: (node) => {
    const label = escapeLabel(node.attrs?.label ?? "")
    const ref: string = node.attrs?.ref ?? ""
    // A ref outside the grammar would close the token early and let its tail
    // write another mention nobody saw: such a chip is written as its label.
    return isMentionRef(ref) ? `@[${label}](${ref})` : label
  },
})

/**
 * A markdown table (agents write them) kept verbatim: shown as the reader sees
 * it, written back character for character. Without it the parser drops the
 * table and the first edit elsewhere in the field deletes it.
 */
const MarkdownTable = Node.create({
  name: "markdownTable",
  group: "block",
  atom: true,
  selectable: true,
  markdownTokenName: "table",
  addAttributes() {
    return { raw: { default: "" } }
  },
  parseHTML() {
    return [{ tag: "div[data-markdown-table]", getAttrs: (el) => ({ raw: el.dataset.raw }) }]
  },
  renderHTML({ node }) {
    return ["div", { "data-markdown-table": "", "data-raw": node.attrs.raw }]
  },
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("div")
      dom.contentEditable = "false"
      dom.innerHTML = wrapMarkdownTables(
        sanitizeHtml(mentionMarked.parse(node.attrs.raw, { async: false }) as string),
      )
      return { dom }
    }
  },
  parseMarkdown: (token) => ({
    type: "markdownTable",
    attrs: { raw: (token.raw ?? "").trimEnd() },
  }),
  renderMarkdown: (node) => node.attrs?.raw ?? "",
})

// What a table cell may hold for the editor to write it back unchanged.
const CELL_INLINE = new Set(["text", "escape", "strong", "em", "codespan", "del", "link"])
const CELL_EXTRA = new Set(["underline", "mention"])

function cellEditable(tokens: Token[] | undefined): boolean {
  return (tokens ?? []).every((t) => {
    const known =
      CELL_INLINE.has(t.type) ||
      CELL_EXTRA.has(t.type) ||
      (t.type === "html" && /^<br\s*\/?>$/i.test(t.raw))
    return known && cellEditable((t as { tokens?: Token[] }).tokens)
  })
}

/** Cells on a table line: unescaped pipes outside code spans, the outer ones aside. */
function cellCount(line: string): number {
  const bare = line
    .trim()
    .replace(/\\./g, "")
    .replace(/(`+)[\s\S]*?\1/g, "")
  return bare.replace(/^\|/, "").replace(/\|$/, "").split("|").length
}

/**
 * Whether a markdown table survives being edited as a table: every line has
 * at most the header's cells (marked drops the extra ones) and every cell
 * holds only text the editor writes back (no image, no HTML but a line
 * break). Any other table stays verbatim.
 */
function isEditableTable(token: Tokens.Table): boolean {
  const columns = token.header.length
  const lines = token.raw.split("\n").filter((line) => line.trim())
  if (lines.some((line) => cellCount(line) > columns)) return false
  return [token.header, ...token.rows].every((row) =>
    row.every((cell) => cellEditable(cell.tokens)),
  )
}

/** A cell holds lines of text, as a markdown cell does: no list or heading to lose. */
const cellContent = { content: "paragraph+" }

/** Tables a document edits as tables; tried before the verbatim fallback. */
const documentTable = [
  Table.extend({
    priority: 101,
    parseMarkdown(token, helpers) {
      return isEditableTable(token as Tokens.Table) ? (this.parent?.(token, helpers) ?? []) : []
    },
    // The extension pads its table with blank lines; the blocks around it already are.
    renderMarkdown(node, helpers, context) {
      return (this.parent?.(node, helpers, context) ?? "").trim()
    },
  }),
  TableRow,
  TableHeader.extend(cellContent),
  TableCell.extend(cellContent),
]

type TextEncoder = (text: string, node: JSONContent, parent?: JSONContent) => string

/**
 * Text is written as typed. TipTap's serializer turns `<`, `>` and `&` into
 * HTML entities, so "a > b" was stored as "a &gt; b": agents read the
 * entities and a one-line field showed them. Only what would otherwise change
 * meaning keeps an escape: a `<` that would open a tag, an `&` that would
 * start an entity, and a `>` opening a block (a quote). Nor does it escape
 * what markdown reads as text anyway: the `_` inside a word (`kpi_run`) and a
 * `[[name]]` link between memory files.
 */
function plainText(inline: boolean) {
  return Extension.create({
    name: "plainTextMarkdown",
    onBeforeCreate() {
      const manager = this.editor.markdown as unknown as { encodeTextForMarkdown: TextEncoder }
      const encode = manager.encodeTextForMarkdown.bind(manager)
      manager.encodeTextForMarkdown = (text, node, parent) => {
        const encoded = encode(text, node, parent)
        if (encoded === text) return encoded
        const plain = encoded
          .replace(/&gt;/g, ">")
          .replace(/&lt;(?![A-Za-z/!?])/g, "<")
          .replace(/&amp;(?!#?[A-Za-z0-9]+;)/g, "&")
          .replace(/(?<=[\p{L}\p{N}])\\_(?=[\p{L}\p{N}])/gu, "_")
          .replace(/\\\[\\\[([^\]\n]+?)\\\]\\\](?!\()/g, "[[$1]]")
        const opensBlock = !inline && parent?.content?.[0] === node && plain.startsWith(">")
        return opensBlock ? `\\${plain}` : plain
      }
      const handlers = this.editor.markdown as unknown as MarkdownHandlers
      // A code block holding a fence is fenced with a longer one: its ``` ended it.
      for (const handler of handlers.getHandlersForNodeType("codeBlock")) {
        const render = handler.renderMarkdown
        if (!render) continue
        handler.renderMarkdown = (...args) => {
          const out = render(...args)
          const node = args[0] as JSONContent | undefined
          const text = node?.content?.map((c) => c.text ?? "").join("") ?? ""
          const longest = Math.max(0, ...(text.match(/`{3,}/g) ?? []).map((run) => run.length))
          if (!longest) return out
          const fence = "`".repeat(longest + 1)
          return out.replace(/^```/, fence).replace(/```$/, fence)
        }
      }
      // An empty line is a blank line: TipTap wrote the second one in a row as
      // `&nbsp;`, which readers and agents saw as text. Blank lines read back
      // as the same empty lines, one per pair of newlines.
      for (const handler of handlers.getHandlersForNodeType("paragraph")) {
        const render = handler.renderMarkdown
        if (!render) continue
        handler.renderMarkdown = (...args) =>
          (args[0] as JSONContent | undefined)?.content?.length ? render(...args) : ""
      }
    },
  })
}

type MarkdownHandlers = {
  getHandlersForNodeType: (type: string) => { renderMarkdown?: (...args: unknown[]) => string }[]
}

/**
 * A message (minimal) is written exactly as typed, as the chat field always
 * sent it: no escape at all, and a line break is a newline, not `"  \n"`. A
 * message without formatting is stored byte for byte as it was before the
 * editor, and `snake_case` or `C:\temp` reach the reader unchanged.
 */
/**
 * Typed emphasis in a message converts only where the reader's renderer
 * (marked, CommonMark) shows emphasis too, so typing never changes what a
 * message means: an opening delimiter at the start of a word, no space inside
 * either delimiter. `*` closes at once (`**a**b` is bold for marked too); `_`
 * closes only once the next character typed ends the word (a space or
 * punctuation), because `_private_var` and `snake_case_word` are literal.
 * Anything less clear stays as typed, and is sent as typed.
 */
function emphasis(find: RegExp, type: MarkType, wordEnd: boolean): InputRule {
  return new InputRule({
    find,
    handler: ({ state, range, match }) => {
      const [whole, delimited = "", text = "", after = ""] = match
      const start = range.from + whole.indexOf(delimited)
      const width = (delimited.length - text.length) / 2
      const { tr } = state
      tr.delete(start + width + text.length, range.to)
      tr.delete(start, start + width)
      tr.addMark(start, start + text.length, type.create())
      tr.removeStoredMark(type)
      if (wordEnd) {
        const end = start + text.length
        tr.insert(end, state.schema.text(after))
        tr.setSelection(TextSelection.create(tr.doc, end + after.length))
      }
    },
  })
}

const EMPHASIS: Record<string, (type: MarkType) => InputRule[]> = {
  bold: (type) => [
    emphasis(/(?:^|\s)(\*\*(?=[^\s*])([^*]*[^\s*])\*\*)$/, type, false),
    emphasis(/(?:^|\s)(__(?=[^\s_])([^_]*[^\s_])__)([^\p{L}\p{N}_])$/u, type, true),
  ],
  italic: (type) => [
    emphasis(/(?:^|\s)(\*(?=[^\s*])([^*]*[^\s*])\*)$/, type, false),
    emphasis(/(?:^|\s)(_(?=[^\s_])([^_]*[^\s_])_)([^\p{L}\p{N}_])$/u, type, true),
  ],
}

/** `__x__` and `_x_` closed by the end of the line rather than by a typed character. */
const UNDERSCORE_AT_LINE_END: [string, RegExp][] = [
  ["bold", /(?:^|\s)(__(?=[^\s_])([^_]*[^\s_])__)$/u],
  ["italic", /(?:^|\s)(_(?=[^\s_])([^_]*[^\s_])_)$/u],
]

/**
 * A line break or a new line ends the word as a space does: `_x_` typed last
 * on a line converts then, as it would have before a space (it stayed
 * literal, and a reply showed underscores the customer received as italic).
 */
function closeUnderscoreEmphasis(editor: Editor): void {
  const { state } = editor
  const { $from, empty } = state.selection
  if (!empty || $from.parent.type.spec.code) return
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, "\ufffc")
  for (const [name, find] of UNDERSCORE_AT_LINE_END) {
    const match = find.exec(before)
    const type = state.schema.marks[name]
    if (!match || !type) continue
    const [whole, delimited = "", text = ""] = match
    const start = $from.start() + match.index + whole.indexOf(delimited)
    const width = (delimited.length - text.length) / 2
    const tr = state.tr
    tr.delete(start + width + text.length, start + delimited.length)
    tr.delete(start, start + width)
    tr.addMark(start, start + text.length, type.create())
    tr.removeStoredMark(type)
    editor.view.dispatch(tr)
    return
  }
}

const LineEndEmphasis = Extension.create({
  name: "lineEndEmphasis",
  // Before the base keymap's Enter and Shift+Enter, after the field's own keys.
  priority: 101,
  addKeyboardShortcuts() {
    const close = () => {
      closeUnderscoreEmphasis(this.editor)
      return false
    }
    return { Enter: close, "Shift-Enter": close }
  },
})

/**
 * Backspace at the start of a code block turns it back into text, each of its
 * lines on its own line: a paste taken as code is never stuck as code. The base
 * keymap joined it onto the line above (or cleared it at the top), its lines
 * run together as one.
 */
const CodeBlockToText = Extension.create({
  name: "codeBlockToText",
  // Before the code block's own Backspace.
  priority: 101,
  addKeyboardShortcuts() {
    return {
      Backspace: ({ editor }) => {
        const { state } = editor
        const { $from, empty } = state.selection
        if (!empty || $from.parent.type.name !== "codeBlock" || $from.parentOffset !== 0) {
          return false
        }
        const { schema } = state
        const hardBreak = schema.nodes.hardBreak
        const paragraph = schema.nodes.paragraph
        if (!hardBreak || !paragraph) return false
        const content = $from.parent.textContent
          .split("\n")
          .flatMap((line, i) => [
            ...(i > 0 ? [hardBreak.create()] : []),
            ...(line ? [schema.text(line)] : []),
          ])
        const start = $from.before()
        const tr = state.tr.replaceWith(start, $from.after(), paragraph.create(null, content))
        tr.setSelection(TextSelection.create(tr.doc, start + 1))
        editor.view.dispatch(tr.scrollIntoView())
        return true
      },
    }
  },
})

/**
 * Cmd/Ctrl+Shift+X also toggles strikethrough, the chord other chat tools use.
 * The base mark keeps its own Cmd/Ctrl+Shift+S.
 */
const StrikeAlias = Extension.create({
  name: "strikeShortcutAlias",
  addKeyboardShortcuts() {
    return { "Mod-Shift-x": ({ editor }) => editor.commands.toggleStrike() }
  },
})

const AsTyped = Extension.create({
  name: "asTypedMarkdown",
  onBeforeCreate() {
    // This editor's own bold and italic (fresh instances per editor) take the
    // message's emphasis rules, and paste nothing of their own: a paste is
    // taken as copied.
    for (const ext of this.editor.extensionManager.extensions) {
      const rules = EMPHASIS[ext.name]
      if (!rules) continue
      ext.config = {
        ...ext.config,
        addInputRules() {
          return rules(this.type as unknown as MarkType)
        },
        addPasteRules: () => [],
      } as typeof ext.config
    }
    const manager = this.editor.markdown as unknown as MarkdownHandlers & {
      encodeTextForMarkdown: TextEncoder
    }
    manager.encodeTextForMarkdown = (text) => text
    for (const handler of manager.getHandlersForNodeType("hardBreak")) {
      handler.renderMarkdown = () => "\n"
    }
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          // The list's own marker, typed out of habit at the start of the next
          // item ("- " after Shift+Enter), is that item's marker, not text: it
          // went out as "- - b", a nested list.
          handleTextInput: (view, from, to, text) => {
            const { $from } = view.state.selection
            if (text !== " " || from !== to || $from.depth < 2 || $from.index(-1) !== 0)
              return false
            const marker = $from.parent.textContent
            if ($from.parentOffset !== marker.length) return false
            const list = $from.node(-2).type.name
            const own =
              (list === "bulletList" && /^[-*+]$/.test(marker)) ||
              (list === "orderedList" && /^\d+[.)]$/.test(marker))
            if (!own) return false
            view.dispatch(view.state.tr.delete($from.start(), from))
            return true
          },
        },
      }),
    ]
  },
})

/**
 * A line break reads as a newline to the typed-markdown rules: `**x**` typed
 * right after Shift+Enter converts as it does after a space. The rules read
 * the break as "\n" but checked it against the document as "", so no rule
 * after a break ever matched.
 */
const LineBreakText = Extension.create({
  name: "lineBreakText",
  extendNodeSchema: (extension) => (extension.name === "hardBreak" ? { leafText: () => "\n" } : {}),
})

function keys(handlers: EditorKeys, inline: boolean) {
  const submit = () => {
    if (!handlers.onSubmit) return false
    handlers.onSubmit()
    return true
  }
  return Extension.create({
    name: "editorKeys",
    priority: 1000,
    addKeyboardShortcuts() {
      // Shift+Enter is the Enter a message cannot have: the next line of a
      // code block or a list, out of an empty item or quote, else a line break.
      const nextLine = () => {
        closeUnderscoreEmphasis(this.editor)
        return this.editor.commands.first(({ commands }) => [
          () => commands.newlineInCode(),
          () => commands.splitListItem("listItem"),
          () => commands.liftEmptyBlock(),
          () => commands.setHardBreak(),
        ])
      }
      return {
        ...(handlers.enterSubmits ? { Enter: submit, "Shift-Enter": nextLine } : {}),
        "Mod-Enter": submit,
        "Mod-k": () => {
          handlers.onLink()
          return true
        },
        Escape: () => {
          if (!handlers.onCancel) return false
          handlers.onCancel()
          return true
        },
        ...(inline ? { Enter: submit, "Shift-Enter": () => true } : {}),
      }
    },
  })
}

export function editorExtensions(
  preset: EditorPreset,
  options: { placeholder?: string; keys: EditorKeys },
): AnyExtension[] {
  const inline = preset === "inline"
  const doc = preset === "document"
  const full = preset === "full" || doc
  const block = inline ? false : undefined
  return [
    StarterKit.configure({
      document: inline ? false : undefined,
      heading: full ? { levels: [1, 2, 3, 4, 5, 6] } : false,
      bulletList: block,
      orderedList: block,
      listItem: block,
      listKeymap: block,
      blockquote: block,
      codeBlock: block,
      horizontalRule: full ? undefined : false,
      hardBreak: block,
      underline: false,
      link: false,
    }),
    ...(inline ? [InlineDocument] : []),
    ...(full ? [TaskList, TaskItem.configure({ nested: true })] : []),
    ...(doc ? documentTable : []),
    ...(inline ? [] : [MarkdownTable, ...rawHtml]),
    MarkdownUnderline,
    StrikeAlias,
    // A message links only a URL typed with its scheme, which it keeps as
    // typed: a file name (README.md), a domain or an address stays text.
    preset === "minimal"
      ? MarkdownLink.configure({ shouldAutoLink: (url) => /^[a-z][\w+.-]*:\/\//i.test(url) })
      : MarkdownLink,
    Mention,
    Placeholder.configure({ placeholder: options.placeholder ?? "" }),
    // A single newline is a line break where messages and tasks are read
    // (shell/markdown-content.tsx parses with `breaks: true`), and a soft wrap
    // in a document (knowledge/markdown.ts). Each editor has its own parser:
    // on the shared one, the last editor made set the rule for all of them.
    Markdown.configure({
      // The renderers' marked, not the extension's own (older) copy: what the
      // editor reads is what a reader is shown. Typed as that copy's `marked`.
      marked: new Marked() as unknown as MarkdownExtensionOptions["marked"],
      markedOptions: { gfm: true, breaks: !doc },
    }),
    plainText(inline),
    LineBreakText,
    ...(inline ? [] : [CodeBlockToText]),
    ...(preset === "minimal" ? [AsTyped, LineEndEmphasis] : []),
    keys(options.keys, inline),
    InsertedTint,
  ]
}

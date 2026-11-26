// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A callout: an icon and a tinted box around blocks. Stored as a GitHub-style alert,
// which GitHub, Obsidian and most markdown readers draw as a callout, and any other
// as a quote:
//
//   > [!NOTE]
//   > Ask your buddy before you ask the channel.
//
// The kind (NOTE, TIP, IMPORTANT, WARNING, CAUTION) picks the icon. The editor and the
// reader (knowledge/markdown.ts) draw it the same way: `<blockquote class="md-callout"
// data-callout="<kind>">`, the icon from the stylesheet.
import { Node } from "@tiptap/core"

export const CALLOUT_KINDS = ["note", "tip", "important", "warning", "caution"] as const
export type CalloutKind = (typeof CALLOUT_KINDS)[number]

export function calloutKindOf(value: unknown): CalloutKind {
  const v = String(value ?? "").toLowerCase()
  return (CALLOUT_KINDS as readonly string[]).includes(v) ? (v as CalloutKind) : "note"
}

/** A callout at the start of markdown source: its marker line and every quoted line after it. */
export const CALLOUT_AT_START =
  /^ {0,3}> ?\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\n|$)((?: {0,3}>.*(?:\n|$))*)/i

/** Where a callout may start in `src`, or -1. */
export function calloutStart(src: string): number {
  return src.search(/(?:^|\n) {0,3}> ?\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i)
}

/** The callout's inner markdown: its quoted lines without their `>`. */
export function calloutInner(quoted: string): string {
  return quoted
    .replace(/\n$/, "")
    .split("\n")
    .map((line) => line.replace(/^ {0,3}> ?/, ""))
    .join("\n")
}

export const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,
  addAttributes() {
    return {
      kind: {
        default: "note",
        parseHTML: (el) => calloutKindOf(el.getAttribute("data-callout")),
        renderHTML: (attrs) => ({ "data-callout": calloutKindOf(attrs.kind) }),
      },
    }
  },
  parseHTML() {
    // Before the quote's own rule: a callout is a blockquote with a kind. (A node priority
    // would make it the schema's first block, the one an empty page is filled with.)
    return [{ tag: "blockquote[data-callout]", priority: 60 }]
  },
  renderHTML({ HTMLAttributes }) {
    return ["blockquote", { ...HTMLAttributes, class: "md-callout" }, 0]
  },
  markdownTokenizer: {
    name: "callout",
    level: "block",
    start: (src) => calloutStart(src),
    tokenize: (src, _tokens, lexer) => {
      const match = CALLOUT_AT_START.exec(src)
      if (!match) return undefined
      return {
        type: "callout",
        raw: match[0],
        kind: match[1]!.toLowerCase(),
        tokens: lexer.blockTokens(calloutInner(match[2] ?? "")),
      }
    },
  },
  parseMarkdown: (token, helpers) => {
    const children = (helpers.parseBlockChildren ?? helpers.parseChildren)(token.tokens || [])
    return helpers.createNode(
      "callout",
      { kind: calloutKindOf(token.kind) },
      children.length > 0 ? children : [helpers.createNode("paragraph", undefined, [])],
    )
  },
  renderMarkdown: (node, h) => {
    const kind = calloutKindOf(node.attrs?.kind).toUpperCase()
    const inner = (node.content ?? [])
      .map((child, index) => h.renderChild?.(child, index) ?? h.renderChildren([child]))
      .join("\n\n")
    const lines = inner.split("\n").map((line) => (line ? `> ${line}` : ">"))
    return [`> [!${kind}]`, ...lines].join("\n")
  },
  addCommands() {
    return {
      setCallout:
        () =>
        ({ commands }) =>
          commands.wrapIn(this.name, { kind: "note" }),
    }
  },
})

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    callout: {
      /** Wrap the current block in a note callout. */
      setCallout: () => ReturnType
    }
  }
}

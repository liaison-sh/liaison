// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What the user did not edit is written back as it was read.
//
// The editor writes markdown its own way: `~` escaped, lists made tight, a
// list item's continuation indent dropped, a table padded. Serializing the
// whole field at each edit rewrote every block of an agent's document. So
// each top-level block of the editor is tied to the markdown source it came
// from on load, and on save a block still equal to the one loaded is written
// as that source; only the blocks that changed are serialized.
import type { Editor, JSONContent } from "@tiptap/core"
import { extractAbsorbedBlankLines, type MarkdownManager } from "@tiptap/markdown"
import type { Node as PMNode } from "@tiptap/pm/model"
import type { Token } from "marked"

/** One top-level markdown token, and the editor blocks it was read into. */
interface SourceBlock {
  raw: string
  nodes: PMNode[]
}

export type SourceMap = SourceBlock[]

/** The manager's per-token parsing, as `parse` runs it (not in its public types). */
interface TokenParser {
  parseToken(token: Token, implicitEmptyParagraphs: boolean): JSONContent | JSONContent[] | null
  createImplicitEmptyParagraphsFromSpace(
    token: Token,
    previous: number,
    next: number,
  ): JSONContent[]
}

/**
 * The blocks of the document just loaded from `markdown`, each with its
 * source. Null when the blocks cannot be tied to the source one by one; the
 * field is then written whole, as before.
 */
export function mapSource(ed: Editor, markdown: string): SourceMap | null {
  const manager = ed.markdown as MarkdownManager | undefined
  if (!manager) return null
  try {
    const source = markdown.replace(/\r\n?/g, "\n")
    const tokens = extractAbsorbedBlankLines(manager.instance.lexer(source) as never) as Token[]
    if (tokens.map((t) => t.raw).join("") !== source) return null
    const parser = manager as unknown as TokenParser
    const solid = tokens.flatMap((t, i) => (t.type === "space" ? [] : [i]))
    const children: PMNode[] = []
    ed.state.doc.forEach((node) => {
      children.push(node)
    })
    let at = 0
    const blocks = tokens.map((token, i): SourceBlock => {
      // The very split `MarkdownManager.parseTokens` makes, token by token.
      let parsed: JSONContent | JSONContent[] | null
      if (token.type === "space") {
        const previous = solid.filter((s) => s < i).at(-1) ?? -1
        const next = solid.find((s) => s > i) ?? -1
        parsed = parser.createImplicitEmptyParagraphsFromSpace(token, previous, next)
      } else parsed = parser.parseToken(token, true)
      const json = parsed === null ? [] : Array.isArray(parsed) ? parsed : [parsed]
      const nodes = children.slice(at, at + json.length)
      at += json.length
      if (nodes.length !== json.length) throw new Error("fewer blocks than tokens")
      json.forEach((j, k) => {
        if (!ed.schema.nodeFromJSON(j).eq(nodes[k]!)) throw new Error("block mismatch")
      })
      return { raw: token.raw, nodes }
    })
    // The empty paragraph the editor adds after a closing list or table is not content.
    if (children.slice(at).some((n) => n.type.name !== "paragraph" || n.content.size > 0)) {
      return null
    }
    return blocks
  } catch {
    return null
  }
}

/** For each loaded block, its index among the current ones, or -1 (longest common subsequence). */
function match(before: PMNode[], after: PMNode[]): number[] {
  const out = before.map(() => -1)
  let head = 0
  while (head < before.length && head < after.length && before[head]!.eq(after[head]!)) {
    out[head] = head
    head++
  }
  let tail = 0
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail]!.eq(after[after.length - 1 - tail]!)
  ) {
    out[before.length - 1 - tail] = after.length - 1 - tail
    tail++
  }
  const a = before.slice(head, before.length - tail)
  const b = after.slice(head, after.length - tail)
  const table = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i]![j] = a[i]!.eq(b[j]!)
        ? table[i + 1]![j + 1]! + 1
        : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
    }
  }
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    if (a[i]!.eq(b[j]!)) {
      out[head + i] = head + j
      i++
      j++
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) i++
    else j++
  }
  return out
}

/** An empty line: written as a blank line, one per pair of newlines. */
const isBlank = (node: PMNode) => node.type.name === "paragraph" && node.content.size === 0

/** Ends `text` on a blank line, so a block written next starts a block of its own. */
const blankLineAfter = (text: string) => (text ? text.replace(/\n*$/, "\n\n") : text)

/**
 * The document's markdown: each block that is as it was loaded written as
 * its source, the rest (edited, added) serialized by the editor.
 */
export function spliceMarkdown(ed: Editor, map: SourceMap): string {
  const manager = ed.markdown as MarkdownManager
  const current: PMNode[] = []
  ed.state.doc.forEach((node) => {
    current.push(node)
  })
  const at = match(
    map.flatMap((block) => block.nodes),
    current,
  )
  let out = ""
  let next = 0 // the first current block not written yet
  let index = 0 // the first loaded block's position in `at`
  let dirty = false // loaded blocks were left out since the last one written
  let held: string[] = [] // source with no block (a link definition) met meanwhile
  let wrote = false // the last thing written was serialized, not source
  let blanks = 0 // empty lines typed at the edge of an edit, owed before what comes next
  const flush = (upTo: number) => {
    let edited = current.slice(next, upTo)
    // Empty lines at either edge of the edit are counted, not serialized: the
    // serializer's text is trimmed, and they would be lost with its edges.
    while (edited[0] && isBlank(edited[0])) {
      blanks++
      edited = edited.slice(1)
    }
    let trailing = 0
    while (edited.length && isBlank(edited.at(-1)!)) {
      trailing++
      edited = edited.slice(0, -1)
    }
    const text = edited.length
      ? manager.serialize({ type: "doc", content: edited.map((n) => n.toJSON()) }).trim()
      : ""
    for (const part of text ? [text, ...held] : held) {
      out = blankLineAfter(out) + "\n\n".repeat(blanks) + part
      blanks = 0
      wrote = true
    }
    blanks += trailing
    held = []
    next = Math.max(next, upTo)
    dirty = false
  }
  for (const block of map) {
    const first = at[index] ?? -1
    const kept =
      block.nodes.length > 0 &&
      first >= next &&
      block.nodes.every((_, k) => at[index + k] === first + k)
    index += block.nodes.length
    if (kept) {
      if (dirty || first > next) flush(first)
      // A blank line before the block, counting the one its source may open with.
      if (wrote)
        out = out.replace(/\n*$/, "\n".repeat(Math.max(0, 2 - /^\n*/.exec(block.raw)![0].length)))
      out += "\n\n".repeat(blanks)
      blanks = 0
      wrote = false
      out += block.raw
      next = first + block.nodes.length
    } else if (block.nodes.length > 0) dirty = true
    // A blank line between blocks: written as it was, unless it borders an edit.
    else if (!dirty) out += block.raw
    else if (block.raw.trim()) held.push(block.raw.trim())
  }
  // Blocks deleted at the end leave the blank line that came before them.
  const droppedAtEnd = dirty
  if (dirty || next < current.length || held.length) flush(current.length)
  return droppedAtEnd && !wrote ? out.trimEnd() : out
}

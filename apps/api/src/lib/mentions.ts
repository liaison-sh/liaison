// SPDX-License-Identifier: FSL-1.1-ALv2
import { messagePlainText } from "@liaison/shared"
import { UUID_RE } from "~/lib/uuid"

export type Mention =
  | { type: "user"; id: string }
  | { type: "thread"; id: string }
  | { type: "entity"; app: string; entityType: string; id: string }
  // An agent mention NAMES the agent (P4b-T12): the bare marker addressed
  // whichever agent the reader happened to resolve, which stops working the
  // moment an org has more than one.
  | { type: "agent"; id: string }

/**
 * The content with every fenced block and inline code span removed. QUOTING a
 * mention is not addressing it: a token shown inside backticks is an example of
 * the syntax, and rendering the docs for `@[Name](agent:<id>)` must not summon
 * the agent it names. Fences are stripped first, so a stray backtick inside a
 * code block cannot open a span across the rest of the message; an unterminated
 * fence swallows the remainder, which is what a reader sees too.
 */
function withoutCode(content: string): string {
  return content
    .replace(/^[ \t]*(`{3,}|~{3,})[^\n]*(?:\n[\s\S]*?^[ \t]*\1[^\n]*$|[\s\S]*$)/gm, "")
    .replace(/(`+)[^\n]*?\1/g, "")
}

export function parseMentions(content: string): Mention[] {
  const scannable = withoutCode(content)
  const regex = /@\[([^\]]+)\]\(([^)]+)\)/g
  const result: Mention[] = []

  for (let match = regex.exec(scannable); match !== null; match = regex.exec(scannable)) {
    const parts = match[2].split(":")

    if (parts.length === 2) {
      const [type, id] = parts
      if (id && UUID_RE.test(id)) {
        if (type === "user") result.push({ type: "user", id })
        else if (type === "thread") result.push({ type: "thread", id })
        else if (type === "agent") result.push({ type: "agent", id })
      }
    } else if (parts.length === 3) {
      const [app, entityType, id] = parts
      if (id && UUID_RE.test(id)) result.push({ type: "entity", app, entityType, id })
    }
  }

  return result
}

/**
 * The short plain preview of a message a notification row or a push shows:
 * the shared plain-text rendering (each `@[Label](type:id)` as `@Label`, links
 * as their text, emphasis dropped), capped at 140 characters. The raw markup is
 * for the renderer and the dispatcher, never for a reader.
 */
export function messagePreview(content: string): string {
  const text = messagePlainText(content)
  return text.length > 140 ? `${text.slice(0, 140)}…` : text
}

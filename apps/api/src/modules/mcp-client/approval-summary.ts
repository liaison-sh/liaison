// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The approval card for a call to a remote MCP server's tool. An MCP tool has no
// summarizer of its own, and the generic fallback printed the tool id
// ("Mcp: <slug>:manage crm objects") over the arguments' top-level keys
// ("Create request, objects: 1 item"): the text that would be written and the
// record it would be written to sat in the collapsed payload. This summary names
// the server and the action, and lists every readable value of the arguments,
// the free text first, so a person approving sees WHAT is written and WHERE.
//
// Generic over every server: nothing here knows any server's tools. Labels come
// from the tool's input schema descriptions where it has them, else the
// argument names as words. Every value is plain text (one line, control
// characters removed); the web renders summary lines as text, never markdown or
// HTML, so argument text cannot inject markup into the card.
import { APPROVAL_SUMMARY_LINE_MAX, type ApprovalSummary } from "@liaison/shared"
import { isRecord } from "~/lib/guards"
import type { ApprovalSummarizer } from "~/modules/apps/app-registries"

export interface McpToolSummaryMeta {
  /** The connection's display name ("HubSpot"); the slug when it has none. */
  serverName: string
  /** The server's own tool name (`manage_crm_objects`). */
  toolName: string
  /** The projected id, kept as the summary's `kind` (`<slug>:<segment>`). */
  kind: string
  description?: string
  inputSchema?: Record<string, unknown>
}

/** A value's cap on the card; a longer value ends on "…" (the full payload stays below). */
export const MCP_SUMMARY_VALUE_CAP = APPROVAL_SUMMARY_LINE_MAX
/** Lines the card shows (the shared schema's cap). */
const MAX_LINES = 8
/** Items of one array rendered before the rest are only counted. */
const ARRAY_ITEMS_SHOWN = 3
/** Nesting depth walked; deeper values are shown as compact JSON. */
const MAX_DEPTH = 6
/** A description longer than this is not shown as the card's subtitle. */
const SUBTITLE_CAP = 160
/** A schema description longer than this is not used as a label. */
const LABEL_CAP = 60

/** Free text a person must read first, by its argument name. */
const TEXT_KEY =
  /(body|content|text|note|message|comment|title|subject|summary|name|email|description|query)/i
/**
 * Boilerplate a tool asks for to confirm a call the person is approving anyway
 * (`confirmationStatus: CONFIRMED`, `confirm: true`). Only these exact names.
 */
const NOISE_KEY = /^(confirm|confirmed|confirmation|confirmation_?status)$/i

/** Words a sentence-cased tool name keeps upper case. */
const ACRONYMS = new Set([
  "api",
  "crm",
  "csv",
  "html",
  "http",
  "id",
  "ids",
  "json",
  "pdf",
  "sms",
  "sql",
  "ui",
  "url",
  "urls",
  "uuid",
])

/** `manage_crm_objects` -> "Manage CRM objects"; `createIssue` -> "Create issue". */
export function humanizeMcpToolName(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[_\-.\s:/]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase())
  if (words.length === 0) return name
  return words
    .map((w, i) => {
      if (ACRONYMS.has(w))
        return w === "ids" || w === "urls" ? `${w.slice(0, -1).toUpperCase()}s` : w.toUpperCase()
      return i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w
    })
    .join(" ")
}

/** An argument name as words, first letter upper case: `hs_note_body` -> "Hs note body". */
function keyWords(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[_\-.\s]+/)
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
  return words.length > 0 ? words.charAt(0).toUpperCase() + words.slice(1) : key
}

/**
 * Text as one inert line: control and bidirectional-override characters dropped,
 * every run of whitespace (newlines included) one space, cut at `cap` with "…".
 */
export function plainLine(text: string, cap = MCP_SUMMARY_VALUE_CAP): string {
  const flat = Array.from(text, (ch) => (isInvisible(ch.codePointAt(0) ?? 0) ? "" : ch))
    .join("")
    .replace(/\s+/g, " ")
    .trim()
  return flat.length > cap ? `${flat.slice(0, cap - 1)}…` : flat
}

/**
 * A control character other than whitespace, a zero-width character, or a bidirectional
 * override or isolate (which could make an argument's text read backwards on the card).
 */
function isInvisible(code: number): boolean {
  if (code === 0x09 || code === 0x0a || code === 0x0d) return false
  return (
    code < 0x20 ||
    code === 0x7f ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  )
}

/** One sentence of a schema description, when it is short enough to be a label. */
function schemaLabel(schema: Record<string, unknown> | undefined): string | null {
  const d = schema?.description ?? schema?.title
  if (typeof d !== "string") return null
  const first = plainLine(d.split(/\n/)[0] ?? "", 1000)
    .replace(/\.\s.*$/, "")
    .replace(/\.$/, "")
  return first.length > 0 && first.length <= LABEL_CAP ? first : null
}

/** A local `$ref` resolved against the root schema (one hop; remote refs are left alone). */
function deref(
  node: unknown,
  root: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!isRecord(node)) return undefined
  const ref = node.$ref
  if (typeof ref !== "string" || !ref.startsWith("#/") || !root) return node
  let at: unknown = root
  for (const part of ref.slice(2).split("/")) {
    if (!isRecord(at)) return undefined
    at = at[part.replace(/~1/g, "/").replace(/~0/g, "~")]
  }
  return isRecord(at) ? at : undefined
}

function childSchema(
  schema: Record<string, unknown> | undefined,
  key: string,
  root: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const props = schema?.properties
  if (isRecord(props) && key in props) return deref(props[key], root)
  return undefined
}

function itemSchema(
  schema: Record<string, unknown> | undefined,
  root: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return deref(schema?.items, root)
}

interface Line {
  text: string
  /** Free text, shown before ids and enums. */
  prose: boolean
}

/** The last two segments of a label path: "Properties › Hs note body". */
function labelOf(path: string[]): string {
  return path.slice(-2).join(" › ")
}

function scalarText(value: unknown): string {
  if (value === null || value === undefined) return "(none)"
  if (typeof value === "boolean") return value ? "yes" : "no"
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "bigint") return String(value)
  try {
    return JSON.stringify(value) ?? ""
  } catch {
    return "[unserializable]"
  }
}

function isScalar(value: unknown): boolean {
  return value === null || ["string", "number", "boolean"].includes(typeof value)
}

/** A string a person reads as text, not an id or an enum value. */
function isProse(key: string, value: string): boolean {
  if (/\s/.test(value.trim()) && value.trim().length > 0) return true
  return TEXT_KEY.test(key) && !/(^|_)id$|Id$|ids?$/i.test(key)
}

function walk(
  value: unknown,
  key: string,
  path: string[],
  schema: Record<string, unknown> | undefined,
  root: Record<string, unknown> | undefined,
  depth: number,
  out: Line[],
): void {
  const label = labelOf(path)
  if (isScalar(value)) {
    const text = scalarText(value)
    const prose = typeof value === "string" && isProse(key, value)
    out.push({ text: plainLine(`${label}: ${text}`), prose })
    return
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      out.push({ text: plainLine(`${label}: (empty list)`), prose: false })
      return
    }
    if (
      value.every((v) => isScalar(v) && typeof v !== "string") ||
      value.every((v) => typeof v === "string" && v.length <= 40)
    ) {
      const shown = value.slice(0, 6).map(scalarText).join(", ")
      const more = value.length > 6 ? ` (and ${value.length - 6} more)` : ""
      out.push({ text: plainLine(`${label}: ${shown}${more}`), prose: false })
      return
    }
    const count = `${value.length} item${value.length === 1 ? "" : "s"}`
    const shownNote = value.length > ARRAY_ITEMS_SHOWN ? `, first ${ARRAY_ITEMS_SHOWN} shown` : ""
    out.push({ text: plainLine(`${label}: ${count}${shownNote}`), prose: false })
    const items = itemSchema(schema, root)
    const last = path[path.length - 1] ?? keyWords(key)
    value.slice(0, ARRAY_ITEMS_SHOWN).forEach((item, i) => {
      const seg = value.length > 1 ? `${last} ${i + 1}` : last
      walk(item, key, [...path.slice(0, -1), seg], items, root, depth + 1, out)
    })
    return
  }
  if (isRecord(value)) {
    const entries = Object.entries(value).filter(([k]) => !NOISE_KEY.test(k))
    if (entries.length === 0) {
      if (path.length > 0) out.push({ text: plainLine(`${label}: (empty)`), prose: false })
      return
    }
    if (depth >= MAX_DEPTH) {
      out.push({ text: plainLine(`${label}: ${scalarText(value)}`), prose: false })
      return
    }
    for (const [k, v] of entries) {
      const sub = childSchema(schema, k, root)
      walk(v, k, [...path, schemaLabel(sub) ?? keyWords(k)], sub, root, depth + 1, out)
    }
    return
  }
  out.push({ text: plainLine(`${label}: ${scalarText(value)}`), prose: false })
}

/** The arguments as card lines: free text first, then ids and enums, in argument order. */
export function mcpArgumentLines(params: unknown, inputSchema?: Record<string, unknown>): string[] {
  const out: Line[] = []
  const root = isRecord(inputSchema) ? inputSchema : undefined
  if (isRecord(params)) walk(params, "", [], root, root, 0, out)
  else if (params !== undefined && params !== null)
    walk(params, "value", ["Value"], undefined, root, 0, out)
  const ordered = [...out.filter((l) => l.prose), ...out.filter((l) => !l.prose)].map((l) => l.text)
  if (ordered.length === 0) return ["(no arguments)"]
  if (ordered.length <= MAX_LINES) return ordered
  const kept = ordered.slice(0, MAX_LINES - 1)
  return [...kept, `(and ${ordered.length - kept.length} more values in the full arguments)`]
}

/** The first line of the tool's description, when it is short enough for a subtitle. */
function subtitleOf(description: string | undefined): string | undefined {
  if (!description) return undefined
  const first = plainLine(description.split(/\n/).find((l) => l.trim().length > 0) ?? "", 1000)
  if (first.length === 0) return undefined
  if (first.length <= SUBTITLE_CAP) return first
  const sentence = first.match(/^.+?[.!?](\s|$)/)?.[0]?.trim()
  return sentence && sentence.length <= SUBTITLE_CAP ? sentence : undefined
}

export function summarizeMcpToolCall(meta: McpToolSummaryMeta, params: unknown): ApprovalSummary {
  const server = plainLine(meta.serverName, 80)
  const title = `${server} · ${plainLine(humanizeMcpToolName(meta.toolName), 110)}`
  const subtitle = subtitleOf(meta.description)
  return {
    kind: meta.kind,
    title,
    ...(subtitle ? { subtitle } : {}),
    lines: mcpArgumentLines(params, meta.inputSchema),
  }
}

export function mcpToolApprovalSummarizer(meta: McpToolSummaryMeta): ApprovalSummarizer {
  return async (params) => summarizeMcpToolCall(meta, params)
}

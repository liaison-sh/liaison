// SPDX-License-Identifier: FSL-1.1-ALv2
import {
  type ApprovalSummary,
  approvalSummarySchema,
  truncateApprovalSummary,
} from "@liaison/shared"
import { z } from "zod"
import { isRecord } from "~/lib/guards"
import { appsLogger as log } from "~/lib/logger"
import { isUuid, UUID_RE } from "~/lib/uuid"
import { humanizeToolName, shownToolCall, splitToolName } from "~/modules/approvals/tool-name"
import { type ApprovalSummarizer, approvalSummarizerRegistry } from "~/modules/apps/app-registries"
import {
  asStoredSummary,
  NO_REFS,
  outsideTokens,
  type RecordRefs,
  recordWords,
  resolveRecordRefs,
} from "~/modules/apps/approval-record-names"
import { recordToken, withoutMarks } from "~/modules/apps/approval-record-token"

const rawApprovalSummarySchema = z.object({
  kind: z.string().min(1),
  title: z.string().min(1),
  subtitle: z.string().optional(),
  // Per-call blast-radius override — mirrors the shared approvalSummarySchema.
  impact: z.enum(["external", "internal"]).optional(),
  // The record's id shown first on the card (`ticket-B2B-123`); bounded to 40
  // by truncateApprovalSummary.
  ref: z.string().optional(),
  // The last day it can be decided in time (`YYYY-MM-DD`): mirrors the shared schema.
  latestOn: z.string().optional(),
  lines: z.array(z.string()).default([]),
  links: z
    .array(
      z.union([
        z.object({
          label: z.string().min(1),
          app: z.string().min(1),
          entityType: z.string().min(1),
          entityId: z.string().min(1),
        }),
        // External https link — mirrors the shared approvalSummaryLinkSchema.
        z.object({
          label: z.string().min(1),
          url: z.string().min(1),
        }),
      ]),
    )
    .optional(),
})

export function registerApprovalSummarizer(
  orgId: string,
  appName: string,
  toolName: string,
  summarize: ApprovalSummarizer,
): void {
  approvalSummarizerRegistry.set([orgId, appName, toolName], summarize)
}

/** Render one param value compactly for a fallback line: a boolean as a word. */
function compactValue(value: unknown): string {
  if (value === null || value === undefined) return "(none)"
  if (typeof value === "string") return value
  if (typeof value === "boolean") return value ? "yes" : "no"
  if (typeof value === "number") return String(value)
  if (Array.isArray(value)) {
    if (value.length === 0) return "(empty list)"
    const scalar = value.every((v) => ["string", "number", "boolean"].includes(typeof v))
    if (scalar && value.length <= 4) return value.map(String).join(", ")
    return `${value.length} item${value.length === 1 ? "" : "s"}`
  }
  try {
    return JSON.stringify(value)
  } catch {
    return "[unserializable]"
  }
}

/** A parameter name as words: "basicCodeDiscount" -> "basic code discount". */
function fieldWords(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[_\-.\s]+/)
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
}

/** Leaf fields as [key path, value], a nested object read field by field. */
function leafFields(
  value: Record<string, unknown>,
  path: string[] = [],
): Array<[string[], unknown]> {
  const out: Array<[string[], unknown]> = []
  for (const [key, v] of Object.entries(value)) {
    const at = [...path, key]
    if (isRecord(v) && Object.keys(v).length > 0 && at.length < 3) out.push(...leafFields(v, at))
    else out.push([at, v])
  }
  return out
}

const sentenceCase = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/** The ids a value is (one, or a list of nothing else), or null for any other value. */
function idsIn(value: unknown): string[] | null {
  if (isUuid(value)) return [value]
  return Array.isArray(value) && value.length > 0 && value.every(isUuid) ? value : null
}

/** What an id nothing names is called: the field still says that it is set. */
const SOME_RECORD = "a record"

/** What a field of ids says: the records, and how many more there are. */
function namedValue(ids: string[], refs: RecordRefs): string {
  const known = ids.flatMap((id) => {
    const ref = refs.get(id)
    return ref ? [recordToken(ref)] : []
  })
  if (known.length === 0) return ids.length === 1 ? SOME_RECORD : `${ids.length} items`
  const shown = known.slice(0, 4)
  const more = ids.length - shown.length
  return `${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}`
}

/** An id in a text; never one inside an `@ref:<id>:<key>` token, which names an earlier step. */
const ANY_UUID = /(?<!@ref:)\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi

/** A text with each id replaced by its record; an id nothing names becomes `other`. */
function withRefs(text: string, refs: RecordRefs, other: (id: string) => string): string {
  return withoutMarks(text).replace(ANY_UUID, (id) => {
    const ref = refs.get(id) ?? refs.get(id.toLowerCase())
    return ref ? recordToken(ref) : other(id)
  })
}

/** The words before a field's value; an id's field is named by the record's kind ("Task"). */
function fieldLabel(path: string[], ids: string[] | null, refs: RecordRefs): string {
  if (!ids) return sentenceCase(path.map(fieldWords).join(", "))
  const words = path.map((key, i) =>
    i === path.length - 1 ? recordWords(key).join(" ") : fieldWords(key),
  )
  if (words[words.length - 1] === "") {
    const kind = ids.map((id) => refs.get(id)?.entityType).find(Boolean)
    words[words.length - 1] = kind ? fieldWords(kind) : "record"
  }
  return sentenceCase(words.join(", "))
}

/**
 * The params as readable lines, "Basic code discount, starts at: ..." rather
 * than `basicCodeDiscount.startsAt: ...`: a nested object is read field by
 * field, names are words, booleans are "yes"/"no", and a record named by id is
 * read by its name. A bare id never shows. Times stay ISO-8601 so the reader's
 * client shows them in the reader's own zone.
 */
function defaultLines(params: unknown, refs: RecordRefs): string[] {
  const lines: string[] = []
  const hideIds = (text: string) => withRefs(text, refs, () => "…")
  if (isRecord(params)) {
    const fields = leafFields(params).map(([path, value]) => {
      const ids = idsIn(value)
      const said = ids ? namedValue(ids, refs) : hideIds(compactValue(value))
      return `${fieldLabel(path, ids, refs)}: ${said}`
    })
    lines.push(...fields.slice(0, 7))
    if (fields.length > 7) lines.push(`(and ${fields.length - 7} more fields)`)
  } else if (params !== undefined && params !== null) {
    lines.push(hideIds(compactValue(params)))
  }
  if (lines.length === 0) lines.push("(no parameters)")
  return lines
}

/** Params that say what a new record is called. */
const OWN_NAME_KEYS = ["title", "name", "subject"]
const TITLE_DETAIL_MAX = 120

/**
 * What the call is about, for its title: a new record by its own name, else the record of the
 * tool's app that the first of its ids names (`id`, then `taskId`, ...).
 */
function titleDetail(toolName: string, params: unknown, refs: RecordRefs): string | null {
  if (!isRecord(params)) return null
  const { appName, toolShortName } = splitToolName(toolName)
  if (/(^|[._])(create|add)/i.test(toolShortName)) {
    for (const key of OWN_NAME_KEYS) {
      const value = params[key]
      if (typeof value !== "string" || !value.trim() || UUID_RE.test(value.trim())) continue
      const flat = withRefs(value.replace(/\s+/g, " ").trim(), refs, () => "…")
      return flat.length > TITLE_DETAIL_MAX ? `${flat.slice(0, TITLE_DETAIL_MAX - 1)}…` : flat
    }
    return null
  }
  const ids = Object.entries(params).filter(([, v]) => isUuid(v)) as Array<[string, string]>
  ids.sort(([a], [b]) => Number(b === "id") - Number(a === "id"))
  for (const [, id] of ids) {
    const ref = refs.get(id)
    if (ref?.app === appName) return recordToken(ref)
  }
  return null
}

/**
 * No summarizer registered: the humanized action ("Tickets: reply", never the
 * raw `tickets:reply` id the card would then print as its title) and the
 * params as readable lines. Still a fallback (a real summarizer names entities
 * and consequences).
 */
async function defaultSummary(
  toolName: string,
  params: unknown,
  ctx: Parameters<ApprovalSummarizer>[1],
): Promise<ApprovalSummary> {
  return bounded(genericCard(toolName, params, await refsFor(toolName, params, ctx)))
}

/** The card as it is stored: cut to a card's limits, no record's name in it. */
const bounded = (made: ApprovalSummary): ApprovalSummary =>
  asStoredSummary(made, truncateApprovalSummary)

/** The records the call names, found with the access of whoever asked; none when they cannot be. */
async function refsFor(
  toolName: string,
  params: unknown,
  ctx: Parameters<ApprovalSummarizer>[1],
): Promise<RecordRefs> {
  return resolveRecordRefs(ctx, toolName, params).catch((err) => {
    log.warn({ err, tool: toolName }, "Records of an approval card could not be read")
    return NO_REFS
  })
}

/**
 * The generic summary of a tool call: computed host-side from the tool id and
 * the payload, no summarizer runs. What a summarizer's failure falls back to,
 * and what serving an approval shows while its stored summary is missing
 * (approvals/served-summary.ts).
 */
export function genericApprovalSummary(toolName: string, params: unknown): ApprovalSummary {
  const shown = shownToolCall(toolName, params)
  return {
    ...bounded(genericCard(shown.toolName, shown.payload, NO_REFS)),
    kind: toolName,
  }
}

function genericCard(toolName: string, params: unknown, refs: RecordRefs): ApprovalSummary {
  const detail = titleDetail(toolName, params, refs)
  return {
    kind: toolName,
    title: detail ? `${humanizeToolName(toolName)}: ${detail}` : humanizeToolName(toolName),
    subtitle: "Pending approval",
    lines: defaultLines(params, refs),
  }
}

function paramAt(params: unknown, path: string[]): unknown {
  let node: unknown = params
  for (const part of path) {
    if (!isRecord(node)) return undefined
    node = node[part]
  }
  return node
}

/** A template's card for a call. */
function templateSummary(
  template: string,
  toolName: string,
  params: unknown,
  refs: RecordRefs,
): ApprovalSummary {
  const title = template
    .replace(/\{\{\s*params\.([\w.]+)\s*\}\}/g, (_m, path: string) => {
      const v = paramAt(params, path.split("."))
      if (v === undefined || v === null || isRecord(v)) return ""
      const ids = idsIn(v)
      if (ids) return namedValue(ids, refs)
      return withRefs(compactValue(v), refs, () => "…")
    })
    .replace(/\(\s*\)/g, "")
    .replace(/\s{2,}/g, " ")
    .trim()
  return {
    kind: toolName,
    title: title.length > 0 ? title : humanizeToolName(toolName),
    subtitle: "Pending approval",
    lines: defaultLines(params, refs),
  }
}

/** The template a summarizer was built from, so its card can be given the call's records. */
const templates = new WeakMap<ApprovalSummarizer, { template: string; toolName: string }>()

/**
 * A summarizer built from a manifest tool's `approvalCard.summary` template
 * ("Create inbox {{params.name}}"), for a gated tool that declares no
 * summarizer of its own. A placeholder the payload lacks drops out.
 */
export function templateApprovalSummarizer(template: string, toolName: string): ApprovalSummarizer {
  const summarize: ApprovalSummarizer = async (params) =>
    bounded(templateSummary(template, toolName, params, NO_REFS))
  templates.set(summarize, { template, toolName })
  return summarize
}

/** A summarizer's own words, each id a record of the call. Its own `recordToken`s stand. */
async function withRecordRefs(
  summary: ApprovalSummary,
  toolName: string,
  params: unknown,
  ctx: Parameters<ApprovalSummarizer>[1],
): Promise<ApprovalSummary> {
  const texts = [summary.title, summary.subtitle ?? "", ...summary.lines]
  if (!texts.some((t) => t.match(ANY_UUID))) return summary
  const refs = await refsFor(toolName, params, ctx)
  const read = (text: string) => outsideTokens(text, (part) => withRefs(part, refs, (id) => id))
  return {
    ...summary,
    title: read(summary.title),
    ...(summary.subtitle !== undefined ? { subtitle: read(summary.subtitle) } : {}),
    lines: summary.lines.map(read),
  }
}

export async function generateApprovalSummary(
  orgId: string,
  appName: string,
  toolName: string,
  params: unknown,
  ctx: Parameters<ApprovalSummarizer>[1],
  fullToolName: string,
): Promise<ApprovalSummary> {
  // A call through the stable entry reads as the tool it calls; the card stays the entry's.
  const shown = shownToolCall(fullToolName, params)
  if (shown.toolName !== fullToolName) {
    const inner = splitToolName(shown.toolName)
    const summary = await generateApprovalSummary(
      orgId,
      inner.appName,
      inner.toolShortName,
      shown.payload,
      ctx,
      shown.toolName,
    )
    return { ...summary, kind: fullToolName }
  }
  const summarizer = approvalSummarizerRegistry.get([orgId, appName, toolName])
  if (!summarizer) return defaultSummary(fullToolName, params, ctx)

  try {
    const made = templates.get(summarizer)
    const raw = made
      ? templateSummary(
          made.template,
          made.toolName,
          params,
          await refsFor(fullToolName, params, ctx),
        )
      : await summarizer(params, ctx)
    const permissive = rawApprovalSummarySchema.safeParse(raw)
    if (!permissive.success) {
      log.warn(
        { tool: fullToolName, err: permissive.error.format() },
        "Summarizer output invalid; using fallback",
      )
      return defaultSummary(fullToolName, params, ctx)
    }

    const validated = approvalSummarySchema.safeParse(
      bounded(await withRecordRefs(permissive.data, fullToolName, params, ctx)),
    )
    if (!validated.success) {
      log.warn(
        { tool: fullToolName, err: validated.error.format() },
        "Bounded summarizer output invalid; using fallback",
      )
      return defaultSummary(fullToolName, params, ctx)
    }

    return validated.data
  } catch (err) {
    log.warn({ err, tool: fullToolName }, "Summarizer threw; using fallback")
    return defaultSummary(fullToolName, params, ctx)
  }
}

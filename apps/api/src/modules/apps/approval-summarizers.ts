// SPDX-License-Identifier: FSL-1.1-ALv2
import {
  type ApprovalSummary,
  approvalSummarySchema,
  truncateApprovalSummary,
} from "@liaison/shared"
import { z } from "zod"
import { isRecord } from "~/lib/guards"
import { appsLogger as log } from "~/lib/logger"
import { humanizeToolName } from "~/modules/approvals/tool-name"
import { type ApprovalSummarizer, approvalSummarizerRegistry } from "~/modules/apps/app-registries"

const rawApprovalSummarySchema = z.object({
  kind: z.string().min(1),
  title: z.string().min(1),
  subtitle: z.string().optional(),
  // Per-call blast-radius override — mirrors the shared approvalSummarySchema.
  impact: z.enum(["external", "internal"]).optional(),
  // The record's id shown first on the card (`ticket-B2B-123`); bounded to 40
  // by truncateApprovalSummary.
  ref: z.string().optional(),
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

/** Leaf fields as [words path, value], a nested object read field by field. */
function leafFields(
  value: Record<string, unknown>,
  path: string[] = [],
): Array<[string[], unknown]> {
  const out: Array<[string[], unknown]> = []
  for (const [key, v] of Object.entries(value)) {
    const at = [...path, fieldWords(key)]
    if (isRecord(v) && Object.keys(v).length > 0 && at.length < 3) out.push(...leafFields(v, at))
    else out.push([at, v])
  }
  return out
}

const sentenceCase = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/**
 * The params as readable lines, "Basic code discount, starts at: ..." rather
 * than `basicCodeDiscount.startsAt: ...`: a nested object is read field by
 * field, names are words, booleans are "yes"/"no". Times stay ISO-8601 so the
 * reader's client shows them in the reader's own zone.
 */
function defaultLines(params: unknown): string[] {
  const lines: string[] = []
  if (isRecord(params)) {
    const fields = leafFields(params)
    for (const [path, value] of fields.slice(0, 7)) {
      lines.push(`${sentenceCase(path.join(", "))}: ${compactValue(value)}`.slice(0, 200))
    }
    if (fields.length > 7) lines.push(`(and ${fields.length - 7} more fields)`)
  } else if (params !== undefined && params !== null) {
    lines.push(compactValue(params).slice(0, 200))
  }
  if (lines.length === 0) lines.push("(no parameters)")
  return lines
}

/**
 * No summarizer registered: the humanized action ("Tickets: reply", never the
 * raw `tickets:reply` id the card would then print as its title) and the
 * params as readable lines. Still a fallback (a real summarizer names entities
 * and consequences).
 */
function defaultSummary(toolName: string, params: unknown): ApprovalSummary {
  return genericApprovalSummary(toolName, params)
}

/**
 * The generic summary of a tool call: computed host-side from the tool id and
 * the payload, no summarizer runs. What a summarizer's failure falls back to,
 * and what serving an approval shows while its stored summary is missing
 * (approvals/served-summary.ts).
 */
export function genericApprovalSummary(toolName: string, params: unknown): ApprovalSummary {
  return {
    kind: toolName,
    title: humanizeToolName(toolName),
    subtitle: "Pending approval",
    lines: defaultLines(params),
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

/**
 * A summarizer built from a manifest tool's `approvalCard.summary` template
 * ("Create inbox {{params.name}}"), for a gated tool that declares no
 * summarizer of its own. A placeholder the payload lacks drops out.
 */
export function templateApprovalSummarizer(template: string, toolName: string): ApprovalSummarizer {
  return async (params) => {
    const title = template
      .replace(/\{\{\s*params\.([\w.]+)\s*\}\}/g, (_m, path: string) => {
        const v = paramAt(params, path.split("."))
        return v === undefined || v === null || isRecord(v) ? "" : compactValue(v)
      })
      .replace(/\(\s*\)/g, "")
      .replace(/\s{2,}/g, " ")
      .trim()
    return {
      kind: toolName,
      title: title.length > 0 ? title : humanizeToolName(toolName),
      subtitle: "Pending approval",
      lines: defaultLines(params),
    }
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
  const summarizer = approvalSummarizerRegistry.get([orgId, appName, toolName])
  if (!summarizer) return defaultSummary(fullToolName, params)

  try {
    const raw = await summarizer(params, ctx)
    const permissive = rawApprovalSummarySchema.safeParse(raw)
    if (!permissive.success) {
      log.warn(
        { tool: fullToolName, err: permissive.error.format() },
        "Summarizer output invalid; using fallback",
      )
      return defaultSummary(fullToolName, params)
    }

    const bounded = truncateApprovalSummary(permissive.data)
    const validated = approvalSummarySchema.safeParse(bounded)
    if (!validated.success) {
      log.warn(
        { tool: fullToolName, err: validated.error.format() },
        "Bounded summarizer output invalid; using fallback",
      )
      return defaultSummary(fullToolName, params)
    }

    return validated.data
  } catch (err) {
    log.warn({ err, tool: fullToolName }, "Summarizer threw; using fallback")
    return defaultSummary(fullToolName, params)
  }
}

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Kernel tools over the needed-template rules (modules/documents/rules-store.ts):
// `document_rules_list` (read only) and `document_rules_upsert` /
// `document_rules_delete` (gated, auto-approvable by policy, with a card that
// says what the rule checks and which templates it asks for). They hold
// kernel:org:admin, the scope the REST routes ask.

import type { ApprovalSummary } from "@liaison/shared"
import { inArray } from "drizzle-orm"
import type { RlsClient } from "~/db"
import { documentTemplates } from "~/db/schema/kernel"
import type { RuleWhen } from "~/modules/documents/rules"
import {
  type CreateRuleInput,
  createRule,
  DocumentRuleError,
  type DocumentTemplateRule,
  deleteRule,
  getRule,
  listRules,
  matchRecordsNamed,
  type PatchRuleInput,
  updateRule,
} from "~/modules/documents/rules-store"

interface DocumentRuleToolContext {
  userId: string
  orgId: string
  db: RlsClient
}

type ToolError = { error: { code: string; message: string; status: number; field?: string } }

export interface DocumentRulesUpsertParams {
  ruleId?: string
  recordType?: string
  name?: string
  when?: RuleWhen
  templateIds?: string[]
  note?: string | null
  enabled?: boolean
}

const ID_HINT =
  "Only pass ids you saw in a kernel__document_rules_list or document template list result."

function ruleToolError(err: unknown): ToolError | null {
  if (!(err instanceof DocumentRuleError)) return null
  const code = err.code === "not_found" ? "NOT_FOUND" : "INVALID_ARGUMENT"
  return {
    error: {
      code,
      message: `${err.message}. ${ID_HINT}`,
      status: err.status,
      ...(err.field !== undefined ? { field: err.field } : {}),
    },
  }
}

async function templateNames(tx: RlsClient, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map()
  const rows = await tx
    .select({ id: documentTemplates.id, name: documentTemplates.name })
    .from(documentTemplates)
    .where(inArray(documentTemplates.id, [...ids]))
  return new Map(rows.map((r) => [r.id, r.name]))
}

/** A rule as an agent reads it: its templates by id and name (a template that is gone reads null). */
async function ruleViews(tx: RlsClient, rules: DocumentTemplateRule[]) {
  const names = await templateNames(tx, [...new Set(rules.flatMap((r) => r.templateIds))])
  return rules.map((r) => ({
    id: r.id,
    recordType: r.recordType,
    name: r.name,
    when: r.when,
    templates: r.templateIds.map((id) => ({ id, name: names.get(id) ?? null })),
    note: r.note,
    enabled: r.enabled,
    updatedAt: r.updatedAt,
  }))
}

export async function handleDocumentRulesList(
  params: { recordType?: string },
  ctx: DocumentRuleToolContext,
) {
  const rules = await listRules(
    ctx.db,
    params.recordType !== undefined ? { recordType: params.recordType } : {},
  )
  return { rules: await ruleViews(ctx.db, rules) }
}

export interface DocumentRulesMatchParams {
  recordType: string
  records: Array<{
    id: string
    skus?: string[] | null
    countryIso2?: string | null
    carrier_family?: string | null
  }>
}

/**
 * Which document templates each record needs, for a whole list at once (one
 * read of the rules, one of the templates). Only records that need something
 * come back. Read only: it never prints and never says a document exists.
 */
export async function handleDocumentRulesMatch(
  params: DocumentRulesMatchParams,
  ctx: DocumentRuleToolContext,
) {
  return { matches: await matchRecordsNamed(ctx.db, params.recordType, params.records) }
}

function missingForCreate(params: DocumentRulesUpsertParams): string[] {
  const missing: string[] = []
  if (!params.recordType) missing.push("recordType")
  if (!params.name) missing.push("name")
  if (!params.when) missing.push("when")
  if (!params.templateIds || params.templateIds.length === 0) missing.push("templateIds")
  return missing
}

function createInput(params: DocumentRulesUpsertParams): CreateRuleInput | ToolError {
  const missing = missingForCreate(params)
  if (missing.length > 0 || !params.recordType || !params.name || !params.when) {
    return {
      error: {
        code: "INVALID_ARGUMENT",
        message: `A new rule needs ${missing.join(", ")} (pass ruleId to change an existing rule)`,
        status: 400,
      },
    }
  }
  return {
    recordType: params.recordType,
    name: params.name,
    when: params.when,
    templateIds: params.templateIds ?? [],
    ...(params.note !== undefined ? { note: params.note } : {}),
    ...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
  }
}

function patchInput(params: DocumentRulesUpsertParams): PatchRuleInput {
  const { ruleId: _ruleId, ...rest } = params
  return rest
}

export async function handleDocumentRulesUpsert(
  params: DocumentRulesUpsertParams,
  ctx: DocumentRuleToolContext,
) {
  const actor = { orgId: ctx.orgId, userId: ctx.userId }
  try {
    if (params.ruleId) {
      const rule = await updateRule(ctx.db, actor, params.ruleId, patchInput(params))
      const [view] = await ruleViews(ctx.db, [rule])
      return { rule: view, created: false }
    }
    const input = createInput(params)
    if ("error" in input) return input
    const rule = await createRule(ctx.db, actor, input)
    const [view] = await ruleViews(ctx.db, [rule])
    return { rule: view, created: true }
  } catch (err) {
    const mapped = ruleToolError(err)
    if (mapped) return mapped
    throw err
  }
}

/**
 * STAGE-TIME preflight for the gated upsert: a new rule has everything it
 * needs, a changed rule exists, so a card is only raised for a call that can
 * run. Template checks run again when the approved call runs.
 */
export async function documentRulesUpsertPreflight(
  params: DocumentRulesUpsertParams,
  ctx: DocumentRuleToolContext,
): Promise<unknown> {
  if (params.ruleId) {
    const rule = await getRule(ctx.db, params.ruleId)
    if (!rule) return ruleToolError(new DocumentRuleError("not_found", "Rule not found"))
    return { ok: true }
  }
  const input = createInput(params)
  return "error" in input ? input : { ok: true }
}

export async function handleDocumentRulesDelete(
  params: { ruleId: string },
  ctx: DocumentRuleToolContext,
) {
  try {
    const rule = await deleteRule(ctx.db, params.ruleId)
    return { deleted: true, rule: { id: rule.id, name: rule.name } }
  } catch (err) {
    const mapped = ruleToolError(err)
    if (mapped) return mapped
    throw err
  }
}

export async function documentRulesDeletePreflight(
  params: { ruleId: string },
  ctx: DocumentRuleToolContext,
): Promise<unknown> {
  const rule = await getRule(ctx.db, params.ruleId)
  return rule ? { ok: true } : ruleToolError(new DocumentRuleError("not_found", "Rule not found"))
}

// ---------------------------------------------------------------------------
// Approval cards
// ---------------------------------------------------------------------------

const WHEN_LABEL: Record<Exclude<keyof RuleWhen, "attribute">, string> = {
  sku: "Product SKU is",
  countryIso2: "Destination country is",
  carrier: "Carrier is",
}

/** One line per condition, e.g. "Destination country is US or CA". */
export function describeWhen(when: unknown): string[] {
  if (!when || typeof when !== "object") return []
  const source = when as Record<string, unknown>
  const lines: string[] = []
  for (const key of Object.keys(WHEN_LABEL) as (keyof typeof WHEN_LABEL)[]) {
    const values = source[key]
    if (!Array.isArray(values) || values.length === 0) continue
    const norm = (v: unknown) =>
      key === "countryIso2"
        ? String(v).toUpperCase()
        : key === "carrier"
          ? String(v).toLowerCase()
          : String(v)
    const shown = values.slice(0, 10).map(norm)
    const more = values.length > shown.length ? ` (and ${values.length - shown.length} more)` : ""
    lines.push(`${WHEN_LABEL[key]} ${shown.join(" or ")}${more}`)
  }
  const attr = source.attribute
  if (attr && typeof attr === "object" && !Array.isArray(attr)) {
    for (const [k, values] of Object.entries(attr as Record<string, unknown>)) {
      if (!Array.isArray(values) || values.length === 0) continue
      const shown = values.slice(0, 10).map((v) => (v === "*" ? "any value" : String(v)))
      const more = values.length > shown.length ? ` (and ${values.length - shown.length} more)` : ""
      lines.push(`A product has attribute ${k} = ${shown.join(" or ")}${more}`)
    }
  }
  return lines
}

async function templateLine(tx: RlsClient, ids: readonly string[]): Promise<string> {
  const names = await templateNames(tx, ids)
  return ids.map((id) => names.get(id) ?? `unknown template ${id}`).join(", ")
}

export async function summarizeDocumentRulesUpsert(
  params: unknown,
  ctx: { tx: RlsClient; orgId: string; userId: string },
): Promise<ApprovalSummary> {
  const p = (params ?? {}) as DocumentRulesUpsertParams
  const current = p.ruleId ? await getRule(ctx.tx, p.ruleId) : null
  const name = p.name ?? current?.name ?? "(unnamed)"
  const recordType = p.recordType ?? current?.recordType
  const when = p.when ?? current?.when
  const templateIds = p.templateIds ?? current?.templateIds ?? []
  const lines: string[] = []
  if (recordType) lines.push(`Applies to: ${recordType}`)
  const conditions = describeWhen(when)
  lines.push(
    conditions.length > 0
      ? `When all of: ${conditions.join("; ")}`
      : "When: no condition (never matches)",
  )
  lines.push(`Needs: ${(await templateLine(ctx.tx, templateIds)) || "(no template)"}`)
  const note = p.note !== undefined ? p.note : current?.note
  if (note) lines.push(`Note: ${note}`)
  const enabled = p.enabled ?? current?.enabled ?? true
  if (!enabled) lines.push("Saved switched off: it marks no record until switched on.")
  return {
    kind: "document_rules_upsert",
    title: current ? `Change the document rule "${name}"` : `Add the document rule "${name}"`,
    lines,
  }
}

export async function summarizeDocumentRulesDelete(
  params: unknown,
  ctx: { tx: RlsClient; orgId: string; userId: string },
): Promise<ApprovalSummary> {
  const ruleId = (params as { ruleId?: string } | null)?.ruleId
  const current = ruleId ? await getRule(ctx.tx, ruleId) : null
  if (!current) {
    return { kind: "document_rules_delete", title: "Delete a document rule", lines: [] }
  }
  return {
    kind: "document_rules_delete",
    title: `Delete the document rule "${current.name}"`,
    lines: [
      `Applies to: ${current.recordType}`,
      ...describeWhen(current.when),
      `Needed: ${await templateLine(ctx.tx, current.templateIds)}`,
      "Records it marked no longer ask for these templates.",
    ],
  }
}

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The organisation's needed-template rules (kernel.document_template_rules,
// migration 0256): store, read, change, delete, and match records against them
// (the matcher itself is rules.ts, pure).
//
// Every function runs inside the caller's RLS transaction (FORCE RLS, org
// scoped); who may write is the route's scope check, or the agent tool's
// required scope and approval (kernel:org:admin). A saved `when` holds only the
// known keys (sku, countryIso2, carrier), each a non-empty list: any other key
// is refused by the schema. A rule's templates must be live templates of the
// org whose record type is the rule's (or unset).

import { and, asc, eq, inArray } from "drizzle-orm"
import { z } from "zod"
import type { RlsClient } from "~/db"
import {
  type DocumentTemplateRuleRow,
  documentTemplateRules,
  documentTemplates,
} from "~/db/schema/kernel"
import {
  type MatchableTemplate,
  matchRecords,
  type RecordMatch,
  type RuleRecord,
  type RuleWhen,
} from "./rules"

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type DocumentRuleErrorCode = "not_found" | "template_invalid"

const STATUS_OF: Record<DocumentRuleErrorCode, number> = {
  not_found: 404,
  template_invalid: 422,
}

export class DocumentRuleError extends Error {
  readonly status: number
  constructor(
    readonly code: DocumentRuleErrorCode,
    message: string,
    readonly field?: string,
  ) {
    super(message)
    this.name = "DocumentRuleError"
    this.status = STATUS_OF[code]
  }
}

// ---------------------------------------------------------------------------
// Input schemas (the routes and the agent tools validate with these)
// ---------------------------------------------------------------------------

/** Most templates one rule may name. */
export const RULE_MAX_TEMPLATES = 20
/** Most values one condition may list. */
export const RULE_MAX_VALUES = 500

export const ruleRecordTypeSchema = z
  .string()
  .max(200)
  .regex(/^[a-z][a-z0-9_-]*:[a-z][a-z0-9_]*$/, "record type is <app>:<entity>")
  .describe('The records the rule applies to, "<app>:<entity>" (e.g. "boxtal:shipment").')

function valueList(item: z.ZodString) {
  return z.array(item).min(1).max(RULE_MAX_VALUES)
}

/**
 * A rule's conditions. Strict: a key other than sku, countryIso2 and carrier
 * is refused, and at least one condition is required (an empty `when` would
 * never match).
 */
export const ruleWhenSchema = z
  .object({
    sku: valueList(z.string().trim().min(1).max(255))
      .optional()
      .describe(
        "Product SKUs, exact (case-insensitive): the record needs it when ANY of its SKUs is listed.",
      ),
    countryIso2: valueList(
      z
        .string()
        .trim()
        .regex(/^[A-Za-z]{2}$/, "a two-letter country code (ISO 3166-1 alpha-2)"),
    )
      .optional()
      .describe("Destination countries, two-letter codes (US, CA, GB)."),
    carrier: valueList(z.string().trim().min(1).max(64))
      .optional()
      .describe('Carrier families (e.g. "ups", "dhl"), compared without case.'),
  })
  .strict()
  .refine(
    (w) => w.sku !== undefined || w.countryIso2 !== undefined || w.carrier !== undefined,
    "a rule needs at least one condition (sku, countryIso2 or carrier)",
  )

const ruleNameSchema = z.string().trim().min(1).max(200)
const ruleNoteSchema = z.string().max(2000).nullable()
const ruleTemplateIdsSchema = z
  .array(z.string().uuid())
  .min(1)
  .max(RULE_MAX_TEMPLATES)
  .describe("The document templates a matching record needs (ids from the template list).")

export const createRuleSchema = z
  .object({
    recordType: ruleRecordTypeSchema,
    name: ruleNameSchema,
    when: ruleWhenSchema,
    templateIds: ruleTemplateIdsSchema,
    note: ruleNoteSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
export type CreateRuleInput = z.infer<typeof createRuleSchema>

export const patchRuleSchema = z
  .object({
    recordType: ruleRecordTypeSchema.optional(),
    name: ruleNameSchema.optional(),
    when: ruleWhenSchema.optional(),
    templateIds: ruleTemplateIdsSchema.optional(),
    note: ruleNoteSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
export type PatchRuleInput = z.infer<typeof patchRuleSchema>

export const listRulesQuerySchema = z.object({ recordType: ruleRecordTypeSchema.optional() })

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface RuleActor {
  orgId: string
  userId: string
}

export interface DocumentTemplateRule {
  id: string
  recordType: string
  name: string
  when: Record<string, unknown>
  templateIds: string[]
  note: string | null
  enabled: boolean
  createdBy: string | null
  updatedBy: string | null
  createdAt: Date
  updatedAt: Date
}

function toRule(row: DocumentTemplateRuleRow): DocumentTemplateRule {
  return {
    id: row.id,
    recordType: row.recordType,
    name: row.name,
    when: row.when,
    templateIds: row.templateIds,
    note: row.note,
    enabled: row.enabled,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/** A saved `when`: values trimmed, countries upper case, carriers lower case, no repeats. */
export function normalizeWhen(when: z.infer<typeof ruleWhenSchema>): RuleWhen {
  const out: RuleWhen = {}
  const uniq = (values: string[]) => [...new Set(values)]
  if (when.sku) out.sku = uniq(when.sku.map((v) => v.trim()))
  if (when.countryIso2) out.countryIso2 = uniq(when.countryIso2.map((v) => v.trim().toUpperCase()))
  if (when.carrier) out.carrier = uniq(when.carrier.map((v) => v.trim().toLowerCase()))
  return out
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** The org's rules, by record type then name. */
export async function listRules(
  tx: RlsClient,
  filter: { recordType?: string } = {},
): Promise<DocumentTemplateRule[]> {
  const rows = await tx
    .select()
    .from(documentTemplateRules)
    .where(filter.recordType ? eq(documentTemplateRules.recordType, filter.recordType) : undefined)
    .orderBy(
      asc(documentTemplateRules.recordType),
      asc(documentTemplateRules.name),
      asc(documentTemplateRules.id),
    )
  return rows.map(toRule)
}

/** One rule; null when it is not visible to the caller. */
export async function getRule(tx: RlsClient, id: string): Promise<DocumentTemplateRule | null> {
  const [row] = await tx
    .select()
    .from(documentTemplateRules)
    .where(eq(documentTemplateRules.id, id))
    .limit(1)
  return row ? toRule(row) : null
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** Every template must be a live template of the org whose record type is the rule's, or unset. */
async function assertTemplates(
  tx: RlsClient,
  recordType: string,
  templateIds: readonly string[],
): Promise<void> {
  const rows = await tx
    .select({
      id: documentTemplates.id,
      recordType: documentTemplates.recordType,
      archivedAt: documentTemplates.archivedAt,
    })
    .from(documentTemplates)
    .where(inArray(documentTemplates.id, [...templateIds]))
  const byId = new Map(rows.map((r) => [r.id, r]))
  for (const id of templateIds) {
    const t = byId.get(id)
    if (!t) {
      throw new DocumentRuleError("template_invalid", `No document template ${id}`, "templateIds")
    }
    if (t.archivedAt) {
      throw new DocumentRuleError(
        "template_invalid",
        `The document template ${id} is archived`,
        "templateIds",
      )
    }
    if (t.recordType !== null && t.recordType !== recordType) {
      throw new DocumentRuleError(
        "template_invalid",
        `The document template ${id} prints from ${t.recordType}, not ${recordType}`,
        "templateIds",
      )
    }
  }
}

export async function createRule(
  tx: RlsClient,
  actor: RuleActor,
  input: CreateRuleInput,
): Promise<DocumentTemplateRule> {
  const templateIds = [...new Set(input.templateIds)]
  await assertTemplates(tx, input.recordType, templateIds)
  const [row] = await tx
    .insert(documentTemplateRules)
    .values({
      orgId: actor.orgId,
      recordType: input.recordType,
      name: input.name,
      when: normalizeWhen(input.when),
      templateIds,
      note: input.note ?? null,
      enabled: input.enabled ?? true,
      createdBy: actor.userId,
      updatedBy: actor.userId,
    })
    .returning()
  if (!row) throw new Error("document template rule insert returned no row")
  return toRule(row)
}

export async function updateRule(
  tx: RlsClient,
  actor: RuleActor,
  id: string,
  patch: PatchRuleInput,
): Promise<DocumentTemplateRule> {
  const current = await getRule(tx, id)
  if (!current) throw new DocumentRuleError("not_found", "Rule not found")
  const recordType = patch.recordType ?? current.recordType
  const templateIds = patch.templateIds ? [...new Set(patch.templateIds)] : undefined
  // A changed record type re-checks the templates the rule keeps.
  if (templateIds || patch.recordType !== undefined) {
    await assertTemplates(tx, recordType, templateIds ?? current.templateIds)
  }
  const [row] = await tx
    .update(documentTemplateRules)
    .set({
      ...(patch.recordType !== undefined ? { recordType: patch.recordType } : {}),
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.when !== undefined ? { when: normalizeWhen(patch.when) } : {}),
      ...(templateIds !== undefined ? { templateIds } : {}),
      ...(patch.note !== undefined ? { note: patch.note } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      updatedBy: actor.userId,
      updatedAt: new Date(),
    })
    .where(eq(documentTemplateRules.id, id))
    .returning()
  if (!row) throw new DocumentRuleError("not_found", "Rule not found")
  return toRule(row)
}

/** Delete a rule. Returns the deleted rule. */
export async function deleteRule(tx: RlsClient, id: string): Promise<DocumentTemplateRule> {
  const [row] = await tx
    .delete(documentTemplateRules)
    .where(eq(documentTemplateRules.id, id))
    .returning()
  if (!row) throw new DocumentRuleError("not_found", "Rule not found")
  return toRule(row)
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** The rules of a record type and the templates they name, in one read each. */
async function loadMatchInputs(tx: RlsClient, recordType: string) {
  const rules = await tx
    .select()
    .from(documentTemplateRules)
    .where(
      and(
        eq(documentTemplateRules.recordType, recordType),
        eq(documentTemplateRules.enabled, true),
      ),
    )
    .orderBy(asc(documentTemplateRules.name), asc(documentTemplateRules.id))
  const ids = [...new Set(rules.flatMap((r) => r.templateIds))]
  const templates = new Map<string, MatchableTemplate & { name: string }>()
  if (ids.length > 0) {
    const rows = await tx
      .select({
        id: documentTemplates.id,
        name: documentTemplates.name,
        enabled: documentTemplates.enabled,
        archivedAt: documentTemplates.archivedAt,
      })
      .from(documentTemplates)
      .where(inArray(documentTemplates.id, ids))
    for (const t of rows) templates.set(t.id, t)
  }
  return { rules, templates }
}

/**
 * What each record of `recordType` needs: one read of the type's rules, one of
 * the templates they name, then the pure matcher. A template that is gone,
 * disabled or archived never comes back.
 */
export async function matchRecordsForType(
  tx: RlsClient,
  recordType: string,
  records: readonly RuleRecord[],
): Promise<RecordMatch[]> {
  if (records.length === 0) return []
  const { rules, templates } = await loadMatchInputs(tx, recordType)
  return matchRecords(
    rules.map((r) => ({
      id: r.id,
      name: r.name,
      enabled: r.enabled,
      when: r.when,
      templateIds: r.templateIds,
    })),
    templates,
    records,
  )
}

/** A record's match with the names a person reads: the rules that matched and the templates they ask for. */
export interface NamedRecordMatch {
  recordId: string
  rules: Array<{ id: string; name: string }>
  templates: Array<{ id: string; name: string }>
}

/**
 * The same match as matchRecordsForType, with rule and template names, and
 * only the records that need something (a record no rule matched is left out).
 * Still one read of the rules and one of the templates, whatever the number of
 * records.
 */
export async function matchRecordsNamed(
  tx: RlsClient,
  recordType: string,
  records: readonly RuleRecord[],
): Promise<NamedRecordMatch[]> {
  if (records.length === 0) return []
  const { rules, templates } = await loadMatchInputs(tx, recordType)
  const ruleNames = new Map(rules.map((r) => [r.id, r.name]))
  const matches = matchRecords(
    rules.map((r) => ({
      id: r.id,
      name: r.name,
      enabled: r.enabled,
      when: r.when,
      templateIds: r.templateIds,
    })),
    templates,
    records,
  )
  return matches
    .filter((m) => m.ruleIds.length > 0)
    .map((m) => ({
      recordId: m.recordId,
      rules: m.ruleIds.map((id) => ({ id, name: ruleNames.get(id) ?? "" })),
      templates: m.templateIds.map((id) => ({ id, name: templates.get(id)?.name ?? "" })),
    }))
}

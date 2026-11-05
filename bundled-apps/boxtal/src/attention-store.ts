// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Storage and management for attention rules (see attention.ts for the matcher and for WHY the
// rules are data). Three small tools: list, upsert, delete. Nothing here interprets a rule; it
// only validates the shape so a malformed one is refused at write time rather than going quiet at
// evaluation time, where a silent rule is indistinguishable from a parcel that needs nothing.
import { ToolError } from "@liaison/app-sdk"
import type { BoxtalToolCtx } from "./ctx"
import {
  RULE_FIELDS,
  RULE_OPS,
  type AttentionCondition,
  type AttentionDocument,
  type AttentionRule,
} from "./attention"

interface StoredRule extends AttentionRule {
  id: string
}

export async function loadAttentionRules(ctx: BoxtalToolCtx): Promise<StoredRule[]> {
  try {
    const rows = (await ctx.db.findMany("attention_rule", { limit: 200 })) as StoredRule[]
    return rows.filter((r) => r && typeof r.name === "string")
  } catch {
    // A worklist read must not fail because the rule table is unavailable: no rules simply means
    // no marks, which is exactly the behaviour before any rule existed.
    return []
  }
}

export async function attentionRulesList(
  ctx: BoxtalToolCtx,
): Promise<{ rules: StoredRule[]; fields: readonly string[]; ops: readonly string[] }> {
  const rules = await loadAttentionRules(ctx)
  // The vocabulary rides along with the list so a caller writing a new rule does not have to
  // guess it (and cannot invent a field the matcher would silently ignore).
  return { rules, fields: RULE_FIELDS, ops: RULE_OPS }
}

function validateConditions(input: unknown): AttentionCondition[] {
  if (!Array.isArray(input)) {
    throw new ToolError("conditions must be a list.", { code: "invalid_params", retryable: false })
  }
  if (input.length === 0) {
    throw new ToolError(
      "A rule needs at least one condition: a rule with none would mark every parcel, which is a mistake rather than a wildcard.",
      { code: "invalid_params", retryable: false },
    )
  }
  return input.map((raw, i) => {
    const c = raw as Partial<AttentionCondition>
    if (!c || typeof c !== "object") {
      throw new ToolError(`conditions[${i}] must be an object.`, { code: "invalid_params", retryable: false })
    }
    if (!RULE_FIELDS.includes(c.field as never)) {
      throw new ToolError(
        `conditions[${i}].field must be one of: ${RULE_FIELDS.join(", ")} (got ${String(c.field)}).`,
        { code: "invalid_params", retryable: false },
      )
    }
    if (!RULE_OPS.includes(c.op as never)) {
      throw new ToolError(
        `conditions[${i}].op must be one of: ${RULE_OPS.join(", ")} (got ${String(c.op)}).`,
        { code: "invalid_params", retryable: false },
      )
    }
    if (c.value === undefined || c.value === null) {
      throw new ToolError(`conditions[${i}].value is required.`, { code: "invalid_params", retryable: false })
    }
    if (c.op === "in" && !Array.isArray(c.value)) {
      throw new ToolError(`conditions[${i}] uses op "in", so value must be a list.`, {
        code: "invalid_params",
        retryable: false,
      })
    }
    return { field: c.field as AttentionCondition["field"], op: c.op as AttentionCondition["op"], value: c.value }
  })
}

function validateDocuments(input: unknown): AttentionDocument[] {
  if (input == null) return []
  if (!Array.isArray(input)) {
    throw new ToolError("documents must be a list.", { code: "invalid_params", retryable: false })
  }
  return input.map((raw, i) => {
    const d = raw as Partial<AttentionDocument>
    const name = typeof d?.name === "string" ? d.name.trim() : ""
    if (name === "") {
      throw new ToolError(`documents[${i}].name is required.`, { code: "invalid_params", retryable: false })
    }
    return { name, note: typeof d?.note === "string" && d.note.trim() !== "" ? d.note.trim() : null }
  })
}

export interface AttentionRuleUpsertInput {
  id?: string
  name?: string
  enabled?: boolean
  conditions?: unknown
  documents?: unknown
  knowledge_ref?: string
}

export async function attentionRuleUpsert(
  ctx: BoxtalToolCtx,
  input: AttentionRuleUpsertInput,
): Promise<{ rule: StoredRule }> {
  const name = typeof input.name === "string" ? input.name.trim() : ""
  if (name === "") {
    throw new ToolError("name is required: it is what the operator reads on the marker.", {
      code: "invalid_params",
      retryable: false,
    })
  }
  const patch = {
    name,
    enabled: input.enabled ?? true,
    conditions: validateConditions(input.conditions),
    documents: validateDocuments(input.documents),
    knowledge_ref:
      typeof input.knowledge_ref === "string" && input.knowledge_ref.trim() !== ""
        ? input.knowledge_ref.trim()
        : null,
  }
  if (input.id) {
    await ctx.db.update("attention_rule", input.id, patch)
    return { rule: { id: input.id, ...patch } }
  }
  const inserted = (await ctx.db.insert("attention_rule", patch)) as { id: string }
  return { rule: { id: inserted.id, ...patch } }
}

export async function attentionRuleDelete(
  ctx: BoxtalToolCtx,
  input: { id?: string },
): Promise<{ deleted: string }> {
  const id = typeof input.id === "string" ? input.id.trim() : ""
  if (id === "") {
    throw new ToolError("id is required.", { code: "invalid_params", retryable: false })
  }
  await ctx.db.delete("attention_rule", id)
  return { deleted: id }
}

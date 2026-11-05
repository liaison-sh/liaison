// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Attention rules: "this parcel needs paperwork nobody would guess from the row".
//
// The example that prompted it is a controller shipped to the USA, which needs a smelt-and-cast
// declaration for its aluminium: nothing on the shipment says so, the carrier only asks once the
// parcel is already at customs, and by then it is a hold, a chase and a week. The operator needs
// to see it at the packing bench.
//
// THE RULES ARE DATA, NEVER CODE. That is the whole design:
//
//   * a rule is a row in `attention_rule` — conditions in, an attention mark and a document list
//     out. Adding "lithium battery paperwork for air freight" or "REACH statement for the UK" is
//     an INSERT, not a deploy, and can be done by the agent from a knowledge-base article
//     (`knowledge_ref` points back at the article the rule was written from);
//   * the condition language is deliberately tiny and closed (see `RULE_FIELDS` / `RULE_OPS`).
//     Every field is one already on a queue row, so a rule can never need data the screen does
//     not have, and an unknown field or operator makes the rule INERT rather than throwing: one
//     bad rule must not take the print station down;
//   * matching is pure and total. No I/O, no clock, no ordering surprises: the marks a row gets
//     are a function of the row's own facts.
//
// A rule says what is NEEDED, never that it is DONE. Nothing here tracks whether the operator
// actually attached the document; claiming that would be worse than saying nothing.

/** The shipment facts a rule may look at. Every one is already on the worklist row. */
export interface AttentionFacts {
  /** ISO country of the destination, uppercased. */
  destination: string | null
  /** Boxtal offer code, e.g. "FEDX-InternationalEconomy". */
  carrier: string | null
  /** sale / repair / gift / sample. */
  category: string | null
  /** The products summary the queues show, e.g. "1xET2, 2xHC". */
  products: string | null
  /** Total gross weight, kg. */
  weight: number | null
  /** Declared customs value, in the document's currency. */
  declared_value: number | null
  /** Unit count. */
  items: number | null
}

export const RULE_FIELDS = [
  "destination",
  "carrier",
  "category",
  "products",
  "weight",
  "declared_value",
  "items",
] as const
export type RuleField = (typeof RULE_FIELDS)[number]

export const RULE_OPS = ["eq", "in", "contains", "starts_with", "gte", "lte"] as const
export type RuleOp = (typeof RULE_OPS)[number]

export interface AttentionCondition {
  field: RuleField
  op: RuleOp
  /** A string, a number, or a list for `in`. Compared case-insensitively for strings. */
  value: unknown
}

/** One document the parcel needs, as the operator should read it. */
export interface AttentionDocument {
  name: string
  /** Where it comes from / what it must contain. One short line. */
  note?: string | null
  /** The kernel document template that prints it, when the need came from a document rule. */
  template_id?: string | null
}

export interface AttentionRule {
  id?: string
  /** Short operator-facing name, e.g. "Aluminium: smelt and cast (US import)". */
  name: string
  /** false parks a rule without deleting it (a carrier changes its mind, seasonally). */
  enabled?: boolean | null
  /** ALL conditions must hold. An empty list never matches: a rule that marks everything is
   *  almost certainly a mistake, and treating it as "always" would flood every row. */
  conditions?: AttentionCondition[] | null
  documents?: AttentionDocument[] | null
  /** The knowledge-base article this rule was written from, so the rule can be re-derived and the
   *  operator can read the full procedure behind the hover. */
  knowledge_ref?: string | null
}

/** What a row carries when one or more rules match. Null when none do. */
export interface AttentionMark {
  /** The matched rule names, for the marker's own label. */
  rules: string[]
  /** The union of every matched rule's documents, de-duplicated by name, in rule order. */
  documents: AttentionDocument[]
  /** Knowledge-base articles behind the matched rules, de-duplicated. */
  knowledge_refs: string[]
  /** One line for a tooltip / an agent's answer. */
  summary: string
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null
}

function asNumber(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

/** Field value from the facts, normalized for comparison. */
function factValue(facts: AttentionFacts, field: RuleField): string | number | null {
  switch (field) {
    case "destination":
      return facts.destination ? facts.destination.toUpperCase() : null
    case "carrier":
      return facts.carrier ?? null
    case "category":
      return facts.category ?? null
    case "products":
      return facts.products ?? null
    case "weight":
      return facts.weight ?? null
    case "declared_value":
      return facts.declared_value ?? null
    case "items":
      return facts.items ?? null
    default:
      return null
  }
}

/**
 * Evaluate ONE condition. Returns false for anything it cannot answer — an unknown field or
 * operator, a missing fact, a value of the wrong shape. A rule that cannot be evaluated does not
 * fire: a false "needs paperwork" mark on every row trains the operator to ignore the marker,
 * which is worse than no marker at all.
 */
export function conditionMatches(facts: AttentionFacts, cond: AttentionCondition): boolean {
  if (!RULE_FIELDS.includes(cond.field)) return false
  if (!RULE_OPS.includes(cond.op)) return false
  const actual = factValue(facts, cond.field)
  if (actual === null) return false

  if (cond.op === "gte" || cond.op === "lte") {
    const a = asNumber(actual)
    const b = asNumber(cond.value)
    if (a === null || b === null) return false
    return cond.op === "gte" ? a >= b : a <= b
  }

  const a = String(actual).toLowerCase()
  if (cond.op === "in") {
    if (!Array.isArray(cond.value)) return false
    return cond.value.some((v) => asString(v)?.toLowerCase() === a)
  }
  const b = asString(cond.value)?.toLowerCase()
  if (b === null || b === undefined) return false
  if (cond.op === "eq") return a === b
  if (cond.op === "contains") return a.includes(b)
  if (cond.op === "starts_with") return a.startsWith(b)
  return false
}

/** A rule fires when it is enabled, has at least one condition, and every condition holds. */
export function ruleMatches(facts: AttentionFacts, rule: AttentionRule): boolean {
  if (rule.enabled === false) return false
  const conditions = Array.isArray(rule.conditions) ? rule.conditions : []
  if (conditions.length === 0) return false
  return conditions.every((c) => c != null && conditionMatches(facts, c))
}

/** Evaluate every rule against one row. Pure and total. Null when nothing matches. */
export function evaluateAttention(
  facts: AttentionFacts,
  rules: AttentionRule[],
): AttentionMark | null {
  const matched = rules.filter((r) => ruleMatches(facts, r))
  if (matched.length === 0) return null
  const documents: AttentionDocument[] = []
  const seen = new Set<string>()
  for (const rule of matched) {
    for (const doc of rule.documents ?? []) {
      const name = asString(doc?.name)
      if (!name || seen.has(name.toLowerCase())) continue
      seen.add(name.toLowerCase())
      documents.push({ name, note: asString(doc?.note) })
    }
  }
  const knowledge_refs = [
    ...new Set(matched.map((r) => asString(r.knowledge_ref)).filter((r): r is string => r != null)),
  ]
  return {
    rules: matched.map((r) => r.name),
    documents,
    knowledge_refs,
    summary: summarize(matched.map((r) => r.name), documents),
  }
}

/** "Needs: commercial invoice, smelt and cast declaration (Aluminium: smelt and cast)". One line,
 *  no dash punctuation, because it is read in a tooltip and by the agent. */
export function summarize(ruleNames: string[], documents: AttentionDocument[]): string {
  const docs = documents.map((d) => d.name).join(", ")
  const why = ruleNames.join("; ")
  if (documents.length === 0) return `Attention: ${why}`
  return `Needs: ${docs} (${why})`
}

/** What the kernel's document rules say one row needs (kernel:document_rules_match). */
export interface TemplateNeed {
  rules: string[]
  templates: Array<{ id: string; name: string }>
}

/**
 * Fold the kernel document rules' match into the row's ONE attention mark: the templates join
 * the documents (carrying their template id, de-duplicated by name like the app's own rules),
 * the rule names join the rules, and the summary is re-worded the same way. Pure.
 */
export function mergeTemplateNeed(mark: AttentionMark | null, need: TemplateNeed | undefined): AttentionMark | null {
  if (!need || need.rules.length === 0) return mark
  const documents: AttentionDocument[] = [...(mark?.documents ?? [])]
  const seen = new Map(documents.map((d, i) => [d.name.toLowerCase(), i]))
  for (const t of need.templates) {
    const name = asString(t.name)
    if (!name) continue
    const at = seen.get(name.toLowerCase())
    if (at !== undefined) {
      const doc = documents[at]
      if (doc && !doc.template_id) documents[at] = { ...doc, template_id: t.id }
      continue
    }
    seen.set(name.toLowerCase(), documents.length)
    documents.push({ name, note: null, template_id: t.id })
  }
  const rules = [...(mark?.rules ?? [])]
  for (const r of need.rules) if (!rules.includes(r)) rules.push(r)
  return {
    rules,
    documents,
    knowledge_refs: mark?.knowledge_refs ?? [],
    summary: summarize(rules, documents),
  }
}

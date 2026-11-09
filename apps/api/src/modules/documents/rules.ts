// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Needed-template rules: which document templates a record needs, as org data
// (kernel.document_template_rules, migration 0256). This file is the pure
// matcher; the store is rules-store.ts.
//
// A rule's `when` holds up to three conditions, each a list:
//  - sku: the record needs it when ANY of its SKUs is listed (case-insensitive,
//    exact, no prefix or pattern);
//  - countryIso2: the record's destination country is listed (ISO 3166-1
//    alpha-2, compared upper case);
//  - carrier: the record's carrier family is listed (compared lower case).
//  - attribute: { <product attribute key>: [values] }: ANY of the record's
//    SKUs holds the attribute with one of the values (compared lower case;
//    "*" means any non-empty value). Several keys must all hold. The record
//    carries its SKUs' attributes (`attributes`, looked up by the store).
// Conditions combine with AND; the values inside one condition with OR. A
// `when` with no condition never matches (a rule that marks every record is
// almost certainly a mistake, the same rule as the Boxtal attention rules).
// Keys other than these three are refused when a rule is saved; if one is
// ever found in stored data it has no effect, and a rule left with no known
// condition never matches. A rule only names templates that can print: a
// template that is missing, disabled or archived is dropped from the result.

/** The list condition keys a rule's `when` may hold (beside `attribute`). */
export const RULE_WHEN_KEYS = ["sku", "countryIso2", "carrier"] as const
export type RuleWhenKey = (typeof RULE_WHEN_KEYS)[number]
/** The product-attribute condition key. */
export const RULE_ATTRIBUTE_KEY = "attribute"
/** The value meaning "any non-empty value" in an attribute condition. */
export const ANY_ATTRIBUTE_VALUE = "*"

/** A rule's conditions: every present key must hold, any listed value satisfies its key. */
export type RuleWhen = Partial<Record<RuleWhenKey, string[]>> & {
  attribute?: Record<string, string[]>
}

/** The facts of one record a rule is checked against. */
export interface RuleRecord {
  id: string
  skus?: readonly string[] | null
  countryIso2?: string | null
  carrier_family?: string | null
  /** The product attributes of the record's SKUs: attribute key -> the values its SKUs hold. */
  attributes?: Readonly<Record<string, readonly string[]>> | null
}

/** A rule as the matcher needs it (`when` as stored: it is read defensively). */
export interface MatchableRule {
  id: string
  name: string
  enabled: boolean
  when: unknown
  templateIds: readonly string[]
}

/** A template as the matcher needs it: whether it can print. */
export interface MatchableTemplate {
  id: string
  enabled: boolean
  archivedAt: Date | string | null
}

/** What one record needs: the matched rules and their usable templates, in rule order, de-duplicated. */
export interface RecordMatch {
  recordId: string
  ruleIds: string[]
  templateIds: string[]
}

type Normalized = { [K in RuleWhenKey]?: Set<string> } & { attribute?: Map<string, Set<string>> }

const NORMALIZE: Record<RuleWhenKey, (value: string) => string> = {
  sku: (v) => v.trim().toLowerCase(),
  countryIso2: (v) => v.trim().toUpperCase(),
  carrier: (v) => v.trim().toLowerCase(),
}

/**
 * The known conditions of a stored `when`, each as a set of normalized values.
 * Null when the `when` cannot match: not an object, no known key, or a known
 * key that is not a non-empty list of strings.
 */
function normalizeWhen(when: unknown): Normalized | null {
  if (when === null || typeof when !== "object" || Array.isArray(when)) return null
  const source = when as Record<string, unknown>
  const out: Normalized = {}
  let present = 0
  for (const key of RULE_WHEN_KEYS) {
    if (!Object.hasOwn(source, key)) continue
    const raw = source[key]
    if (!Array.isArray(raw) || raw.length === 0) return null
    const values = new Set<string>()
    for (const v of raw) {
      if (typeof v !== "string") return null
      const n = NORMALIZE[key](v)
      if (n !== "") values.add(n)
    }
    if (values.size === 0) return null
    out[key] = values
    present += 1
  }
  if (Object.hasOwn(source, RULE_ATTRIBUTE_KEY)) {
    const raw = source[RULE_ATTRIBUTE_KEY]
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null
    const attrs = new Map<string, Set<string>>()
    for (const [k, list] of Object.entries(raw as Record<string, unknown>)) {
      if (!Array.isArray(list) || list.length === 0) return null
      const values = new Set<string>()
      for (const v of list) {
        if (typeof v !== "string") return null
        const n = v.trim().toLowerCase()
        if (n !== "") values.add(n)
      }
      if (values.size === 0) return null
      attrs.set(k.trim().toLowerCase(), values)
    }
    if (attrs.size === 0) return null
    out.attribute = attrs
    present += 1
  }
  return present > 0 ? out : null
}

/** Whether a rule's `when` holds for a record. An empty or unreadable `when` never does. */
export function whenMatches(when: unknown, record: RuleRecord): boolean {
  const conditions = normalizeWhen(when)
  if (!conditions) return false
  if (conditions.sku) {
    const listed = conditions.sku
    const skus = record.skus ?? []
    if (!skus.some((s) => typeof s === "string" && listed.has(NORMALIZE.sku(s)))) return false
  }
  if (conditions.countryIso2) {
    const country = record.countryIso2 ? NORMALIZE.countryIso2(record.countryIso2) : ""
    if (!conditions.countryIso2.has(country)) return false
  }
  if (conditions.carrier) {
    const carrier = record.carrier_family ? NORMALIZE.carrier(record.carrier_family) : ""
    if (!conditions.carrier.has(carrier)) return false
  }
  if (conditions.attribute) {
    const held = new Map<string, string[]>()
    for (const [k, values] of Object.entries(record.attributes ?? {})) {
      if (!Array.isArray(values)) continue
      held.set(
        k.trim().toLowerCase(),
        values.filter((v): v is string => typeof v === "string").map((v) => v.trim().toLowerCase()),
      )
    }
    for (const [key, wanted] of conditions.attribute) {
      const values = (held.get(key) ?? []).filter((v) => v !== "")
      const ok = wanted.has(ANY_ATTRIBUTE_VALUE)
        ? values.length > 0
        : values.some((v) => wanted.has(v))
      if (!ok) return false
    }
  }
  return true
}

function canPrint(template: MatchableTemplate | undefined): boolean {
  return template?.enabled === true && template.archivedAt === null
}

/**
 * What each record needs: the enabled rules whose `when` holds, and the union
 * of their templates that can print. A rule whose templates are all unusable
 * still counts as matched (its id is listed) but adds no template.
 */
export function matchRecords(
  rules: readonly MatchableRule[],
  templates: ReadonlyMap<string, MatchableTemplate>,
  records: readonly RuleRecord[],
): RecordMatch[] {
  const live = rules.filter((r) => r.enabled)
  return records.map((record) => {
    const ruleIds: string[] = []
    const templateIds: string[] = []
    const seen = new Set<string>()
    for (const rule of live) {
      if (!whenMatches(rule.when, record)) continue
      ruleIds.push(rule.id)
      for (const id of rule.templateIds) {
        if (seen.has(id) || !canPrint(templates.get(id))) continue
        seen.add(id)
        templateIds.push(id)
      }
    }
    return { recordId: record.id, ruleIds, templateIds }
  })
}

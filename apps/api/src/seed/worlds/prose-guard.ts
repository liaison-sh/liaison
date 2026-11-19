// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The pack prose guard: a world pack's strings are seeded once and read later,
// so a relative day word ("this morning"), a weekday, a literal date or a year
// in them turns false as soon as the org is handed out a day after its seed.
// Dates enter prose through the story clock's formatter (`story-clock.ts`
// `fmt`), computed from the anchor, never as literals.
//
// `scanPackProse` walks every string value of a pack's data; `scanWorldPackDir`
// does it over every module of a `seed/worlds/<world>/` directory and names the
// file and the field. Fields whose value is an identifier rather than prose (a
// document number such as "F-2026-0362", an email, a URL) are on an allow-list.
import { readdirSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

export type ProseViolationKind = "date" | "year" | "weekday" | "relative-day"

export interface ProseViolation {
  /** Path of the string inside the scanned value, e.g. `briefs[0].body`. */
  field: string
  kind: ProseViolationKind
  /** The text that matched. */
  match: string
  /** The whole string. */
  value: string
}

export interface WorldProseViolation extends ProseViolation {
  /** The module, relative to the world directory, with `/` separators. */
  file: string
}

/** Field names whose values are identifiers, not prose. */
export const PROSE_GUARD_ALLOWED_FIELDS: readonly string[] = [
  "id",
  "key",
  "slug",
  "number",
  "email",
  "domain",
  "url",
  "href",
  "sku",
  "iban",
  "vatNumber",
  "currency",
  "locale",
  "timeZone",
  "timezone",
]

// Letters and digits on either side end a word, accented letters included.
const W_START = "(?<![\\p{L}\\p{N}])"
const W_END = "(?![\\p{L}\\p{N}])"
const word = (alternatives: string) => new RegExp(`${W_START}(?:${alternatives})${W_END}`, "iu")

const MONTHS_EN =
  "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec"
const MONTHS_FR =
  "janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|septembre|octobre|novembre|décembre|decembre|janv|févr|fevr|avr|juil|sept|oct|nov|déc|dec"
const MONTHS = `${MONTHS_EN}|${MONTHS_FR}`

/** Checked in this order; a string reports its first hit. */
const RULES: ReadonlyArray<{ kind: ProseViolationKind; pattern: RegExp }> = [
  {
    kind: "date",
    pattern: new RegExp(
      [
        // 2026-11-30
        `${W_START}\\d{4}-\\d{1,2}-\\d{1,2}${W_END}`,
        // 12/03, 12/03/2026 (not "24/7")
        `${W_START}(?!24/7${W_END})\\d{1,2}/\\d{1,2}(?:/\\d{2,4})?${W_END}`,
        // 12.03.2026 (a decimal such as 4.8 is not a date)
        `${W_START}\\d{1,2}\\.\\d{1,2}\\.\\d{2,4}${W_END}`,
        // 3 Nov, 1er mai, 3 novembre
        `${W_START}\\d{1,2}(?:er|st|nd|rd|th)?\\s+(?:${MONTHS})${W_END}`,
        // November 3
        `${W_START}(?:${MONTHS_EN})\\.?\\s+\\d{1,2}${W_END}`,
      ].join("|"),
      "iu",
    ),
  },
  { kind: "year", pattern: new RegExp(`${W_START}(?:19|20)\\d{2}${W_END}`, "u") },
  {
    kind: "weekday",
    pattern: word(
      "monday|tuesday|wednesday|thursday|friday|saturday|sunday|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche",
    ),
  },
  {
    kind: "relative-day",
    pattern: word(
      [
        "today",
        "tonight",
        "yesterday",
        "tomorrow",
        "this morning",
        "this afternoon",
        "this evening",
        "last night",
        "aujourd'hui",
        "aujourd’hui",
        "avant-hier",
        "après-demain",
        "hier",
        "demain",
        "ce matin",
        "cet après-midi",
        "ce soir",
      ].join("|"),
    ),
  },
]

function check(value: string): { kind: ProseViolationKind; match: string } | null {
  for (const rule of RULES) {
    const m = rule.pattern.exec(value)
    if (m) return { kind: rule.kind, match: m[0] }
  }
  return null
}

/**
 * Every string value under `value` that holds a literal date, a year, a weekday
 * or a relative day word, with the path that reaches it. Functions are skipped
 * (a pack's layer computes its dates from the clock), and so is any string held
 * by a field on `allowFields`.
 */
export function scanPackProse(
  value: unknown,
  opts: { allowFields?: readonly string[]; root?: string } = {},
): ProseViolation[] {
  const allow = new Set(opts.allowFields ?? PROSE_GUARD_ALLOWED_FIELDS)
  const seen = new Set<object>()
  const out: ProseViolation[] = []

  const walk = (node: unknown, field: string, name: string | null) => {
    if (typeof node === "string") {
      if (name !== null && allow.has(name)) return
      const hit = check(node)
      if (hit) out.push({ field, kind: hit.kind, match: hit.match, value: node })
      return
    }
    if (node === null || typeof node !== "object") return
    if (seen.has(node)) return
    seen.add(node)
    if (Array.isArray(node)) {
      for (const [i, item] of node.entries()) walk(item, `${field}[${i}]`, name)
      return
    }
    if (node instanceof Map) {
      for (const [k, v] of node) walk(v, field ? `${field}.${String(k)}` : String(k), String(k))
      return
    }
    if (node instanceof Set) {
      let i = 0
      for (const v of node) walk(v, `${field}[${i++}]`, name)
      return
    }
    for (const [k, v] of Object.entries(node)) walk(v, field ? `${field}.${k}` : k, k)
  }

  walk(value, opts.root ?? "", null)
  return out
}

function moduleFiles(dir: string, rel = ""): string[] {
  const files: string[] = []
  for (const entry of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name
    if (entry.isDirectory()) files.push(...moduleFiles(dir, relPath))
    else if (/\.(ts|js)$/.test(entry.name) && !/\.(test|d)\.ts$/.test(entry.name))
      files.push(relPath)
  }
  return files.sort()
}

/**
 * The guard over one world pack directory (`seed/worlds/<world>/`): every
 * module except tests, every export, every string value.
 */
export async function scanWorldPackDir(
  dir: string,
  opts: { allowFields?: readonly string[] } = {},
): Promise<WorldProseViolation[]> {
  const out: WorldProseViolation[] = []
  for (const file of moduleFiles(dir)) {
    const mod = (await import(pathToFileURL(path.join(dir, file)).href)) as Record<string, unknown>
    for (const name of Object.keys(mod).sort()) {
      for (const v of scanPackProse(mod[name], { allowFields: opts.allowFields, root: name })) {
        out.push({ file, ...v })
      }
    }
  }
  return out
}

// ── Claims a demo's prose never makes ─────────────────────────────────────────
//
// A world's prose says what the product does in that world, nothing more: no
// legal or market claim. A short denylist catches the usual three (a reviewer
// reads the rest): a compliance promise, a statistic from outside the world, and
// a comparison with a named product. English and French.

export type ClaimKind = "compliance" | "statistic" | "comparison"

export interface ClaimHit {
  kind: ClaimKind
  /** The text that matched. */
  match: string
}

/** Products a demo's copy never compares itself with. */
const NAMED_PRODUCTS =
  "salesforce|hubspot|zendesk|freshdesk|intercom|pipedrive|odoo|jira|asana|trello|clickup|basecamp|monday\\.com|toggl|quickbooks|xero|chatgpt"

/** Checked in this order; a string reports every rule it breaks, once each. */
export const CLAIM_DENYLIST: ReadonlyArray<{ kind: ClaimKind; pattern: RegExp }> = [
  {
    kind: "compliance",
    pattern: word(
      [
        "gdpr[- ]compliant",
        "rgpd[- ]compliant",
        "conforme (?:au|à la|aux) (?:rgpd|gdpr|règlement|loi)",
        "compliant with",
        "fully compliant",
        "certified",
        "certifiée?s?",
        "soc ?2",
        "iso ?27001",
        "hipaa",
        "legally binding",
        "juridiquement contraignante?",
        "guaranteed?",
        "garantie?s?",
        "100 ?% (?:secure|sécurisée?|compliant|conforme)",
      ].join("|"),
    ),
  },
  {
    kind: "statistic",
    pattern: new RegExp(
      [
        `${W_START}\\d+(?:[.,]\\d+)?\\s?%\\s+(?:of|des|de)\\s+(?:companies|businesses|teams|agencies|studios|firms|people|users|entreprises|équipes|agences|studios|sociétés|utilisateurs)${W_END}`,
        `${W_START}(?:according to (?:a|an|the|recent|one) (?:\\w+ )?(?:study|studies|survey|surveys|report|research|poll)|studies show|research shows|surveys show|selon (?:une|les|des|la) (?:\\p{L}+ )?(?:étude|études|enquête|enquêtes|sondage))${W_END}`,
        `${W_START}\\d+(?:[.,]\\d+)?\\s?(?:x|times|fois) (?:faster|more|less|cheaper|plus|moins)${W_END}`,
      ].join("|"),
      "iu",
    ),
  },
  {
    kind: "comparison",
    pattern: new RegExp(
      [
        `${W_START}(?:better than|faster than|cheaper than|unlike|instead of|replaces?|versus|vs\\.?|mieux que|plus (?:rapide|simple) que|contrairement à|au lieu de|remplace)\\s+(?:${NAMED_PRODUCTS})${W_END}`,
        `${W_START}(?:${NAMED_PRODUCTS})${W_END}`,
      ].join("|"),
      "iu",
    ),
  },
]

/** Every claim a demo's prose must not make, found in `text`. */
export function claimHits(text: string): ClaimHit[] {
  const out: ClaimHit[] = []
  for (const rule of CLAIM_DENYLIST) {
    const m = rule.pattern.exec(text)
    if (m) out.push({ kind: rule.kind, match: m[0] })
  }
  return out
}

/** Every string value under `value`, with its path, skipping functions and identifier fields. */
export function packStrings(
  value: unknown,
  opts: { allowFields?: readonly string[]; root?: string } = {},
): Array<{ field: string; value: string }> {
  const allow = new Set(opts.allowFields ?? PROSE_GUARD_ALLOWED_FIELDS)
  const seen = new Set<object>()
  const out: Array<{ field: string; value: string }> = []
  const walk = (node: unknown, field: string, name: string | null) => {
    if (typeof node === "string") {
      if (name === null || !allow.has(name)) out.push({ field, value: node })
      return
    }
    if (node === null || typeof node !== "object" || seen.has(node)) return
    seen.add(node)
    if (Array.isArray(node)) {
      for (const [i, item] of node.entries()) walk(item, `${field}[${i}]`, name)
      return
    }
    if (node instanceof Map) {
      for (const [k, v] of node) walk(v, field ? `${field}.${String(k)}` : String(k), String(k))
      return
    }
    if (node instanceof Set) {
      let i = 0
      for (const v of node) walk(v, `${field}[${i++}]`, name)
      return
    }
    for (const [k, v] of Object.entries(node)) walk(v, field ? `${field}.${k}` : k, k)
  }
  walk(value, opts.root ?? "", null)
  return out
}

/** The claims denylist over one world pack directory: every module except tests, every string. */
export async function scanWorldPackClaims(
  dir: string,
): Promise<Array<{ file: string; field: string; kind: ClaimKind; match: string }>> {
  const out: Array<{ file: string; field: string; kind: ClaimKind; match: string }> = []
  for (const file of moduleFiles(dir)) {
    const mod = (await import(pathToFileURL(path.join(dir, file)).href)) as Record<string, unknown>
    for (const name of Object.keys(mod).sort()) {
      for (const s of packStrings(mod[name], { root: name })) {
        for (const hit of claimHits(s.value)) out.push({ file, field: s.field, ...hit })
      }
    }
  }
  return out
}

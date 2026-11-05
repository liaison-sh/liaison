// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Pure anonymization functions for the audit usage export (A44,
// brainstorm-decisions.md). Given audit_log / threads / messages-shape rows
// read WITHOUT any message body, these functions replace every direct
// identifier (email, UUID, known person name, phone number, IBAN-like
// string, street address) with a stable pseudonym, and collapse long free
// text found inside `changes`/`metadata` JSON to a shape token. Nothing here
// touches a database or the filesystem; the export script (`bun
// scripts/bench/audit-usage-export.ts`) is the only caller and owns the
// mapping's lifetime (one Anonymizer per run, kept only in memory, written
// nowhere).

/** Free text values in `changes`/`metadata` longer than this are collapsed to a shape token. */
export const FREE_TEXT_MAX_CHARS = 40

/**
 * JSON object keys whose STRING value survives verbatim even past the free
 * text cutoff: tool names and action names are the whole point of the audit
 * trail (A44 — "the call sequence"), never redacted.
 */
const VERBATIM_KEYS = new Set([
  "tool",
  "toolName",
  "tool_name",
  "action",
  "actionName",
  "action_name",
  "app",
  "entityType",
  "entity_type",
])

/** `ABC-1234`-shaped identifiers (2-5 uppercase letters, dash, 3-6 digits) survive verbatim. */
const SHORT_IDENTIFIER_RE = /^[A-Z]{2,5}-\d{3,6}$/

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g
// IBAN: 2 letter country code, 2 check digits, 10-30 alnum, no separators.
const IBAN_RE = /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g
// Phone: an optional leading +, then digit groups (space/dot/dash separated)
// totalling at least 7 digits. Deliberately permissive — false positives on
// long numeric ids are acceptable for an anonymization pass (over-redaction
// is the safe failure mode here), false negatives on real phone numbers are
// not.
const PHONE_RE = /\+?\d[\d][\d .\-()]{5,}\d/g
// Street address: a leading house number followed by 1-5 words and a common
// street-type suffix.
const ADDRESS_RE =
  /\b\d{1,5}[A-Za-z]?\s+[A-Za-z0-9.'\s]{2,40}?\b(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Way|Court|Ct|Place|Pl|Square|Sq)\b\.?/gi

export interface Anonymizer {
  /** Replaces every recognized PII pattern in free text with a stable pseudonym. */
  anonymizeText(text: string): string
  /**
   * Walks a `changes`/`metadata` JSON value: keys and value SHAPES survive,
   * PII is pseudonymized, free text over FREE_TEXT_MAX_CHARS collapses to a
   * shape token. `key` is the parent object key this value was read from
   * (used for the tool/action-name verbatim carve-out); omit at the root.
   */
  anonymizeJsonValue(value: unknown, key?: string): unknown
}

function shapeToken(value: unknown): string {
  if (typeof value === "string") return `<text:${value.length}chars>`
  return `<unknown>`
}

/** Builds one pseudonym counter+map pair (e.g. "email"). */
function pseudonymFactory(label: string) {
  const map = new Map<string, string>()
  let counter = 0
  return (raw: string): string => {
    const existing = map.get(raw)
    if (existing) return existing
    counter += 1
    const pseudonym = `${label}_${counter}`
    map.set(raw, pseudonym)
    return pseudonym
  }
}

/**
 * Builds an Anonymizer. `knownNames` is the read-only name list fetched from
 * kernel.users / kernel.contacts by the export script (a person's full name
 * as stored, e.g. "Stephanie Aubert") — every occurrence of any of those
 * strings inside free text is replaced. Longest names are matched first so a
 * shorter name that happens to be a substring of a longer one never shadows
 * it (e.g. "Stephanie" inside "Stephanie Aubert").
 */
export function createAnonymizer(knownNames: readonly string[]): Anonymizer {
  const nextEmail = pseudonymFactory("email")
  const nextUuid = pseudonymFactory("uuid")
  const nextPhone = pseudonymFactory("phone")
  const nextIban = pseudonymFactory("iban")
  const nextAddress = pseudonymFactory("address")
  const nextName = pseudonymFactory("person")

  const orderedNames = [...new Set(knownNames.filter((n) => n.trim().length > 0))].sort(
    (a, b) => b.length - a.length,
  )
  // One alternation regex over every known name, longest first, word-ish
  // boundaries via lookaround so "Stephanie" doesn't also eat "Stephanieson".
  const nameRe =
    orderedNames.length > 0
      ? new RegExp(
          `(?<![A-Za-z0-9])(${orderedNames
            .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
            .join("|")})(?![A-Za-z0-9])`,
          "g",
        )
      : null

  function anonymizeText(text: string): string {
    let out = text
    out = out.replace(UUID_RE, (m) => nextUuid(m.toLowerCase()))
    out = out.replace(EMAIL_RE, (m) => nextEmail(m.toLowerCase()))
    out = out.replace(IBAN_RE, (m) => nextIban(m))
    out = out.replace(ADDRESS_RE, (m) => nextAddress(m))
    out = out.replace(PHONE_RE, (m) => nextPhone(m))
    if (nameRe) {
      // A fresh RegExp per call: the shared `nameRe` carries lastIndex state
      // on a global regex, which corrupts repeated calls on separate inputs.
      const re = new RegExp(nameRe.source, nameRe.flags)
      out = out.replace(re, (m) => nextName(m))
    }
    return out
  }

  function anonymizeJsonValue(value: unknown, key?: string): unknown {
    if (value === null || value === undefined) return value
    if (typeof value === "number" || typeof value === "boolean") return value
    if (typeof value === "string") {
      if (key && VERBATIM_KEYS.has(key)) return value
      if (SHORT_IDENTIFIER_RE.test(value)) return value
      if (value.length > FREE_TEXT_MAX_CHARS) return shapeToken(value)
      return anonymizeText(value)
    }
    if (Array.isArray(value)) {
      return value.map((item) => anonymizeJsonValue(item))
    }
    if (typeof value === "object") {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = anonymizeJsonValue(v, k)
      }
      return out
    }
    return shapeToken(value)
  }

  return { anonymizeText, anonymizeJsonValue }
}

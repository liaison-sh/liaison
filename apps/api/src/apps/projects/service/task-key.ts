// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Pure helpers for Jira-style task keys: a short uppercase project `key`
// (e.g. "ERB") plus a per-project sequential task `number`, displayed as
// "ERB-12". `deriveProjectKey` mirrors the backfill DO block in migration
// 0043_project_task_keys.sql exactly — keep both in sync on any rule change.

/** Prod project names seeded with an explicit, memorable key instead of the
 *  mechanical derivation below. Matched case-insensitively, trimmed. */
const NAMED_KEYS: Record<string, string> = {
  "feature requests": "FRQ",
  "qa to-do": "QAT",
  "website bugs": "WEB",
  "dealer shipments": "DSH",
  "support shipments & repairs": "SSR",
  "logistique & litiges transporteurs": "LLT",
}

/**
 * Derive a short uppercase project key from a project name:
 *   - one word  -> first 3 letters
 *   - 2+ words  -> first 2 letters of word 1 + first letter of word 2
 *   - pad from any remaining letters in the name if still under 3 chars
 *   - fall back to "PRJ" if still under 2 chars (e.g. an all-punctuation or
 *     empty name)
 *
 * This does NOT handle org-scoped collisions (that is a stateful concern —
 * see the migration's suffix-replacement loop and `projectKeyCandidates`).
 */
export function deriveProjectKey(name: string): string {
  const trimmed = name.trim()
  const lowered = trimmed.toLowerCase()
  if (Object.hasOwn(NAMED_KEYS, lowered)) return NAMED_KEYS[lowered]!

  const letters = trimmed.replace(/[^a-zA-Z]/g, "").toUpperCase()
  const words = trimmed
    .replace(/[^a-zA-Z]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)

  let candidate: string | null = null
  if (words.length === 1) {
    candidate = words[0]!.slice(0, 3).toUpperCase()
  } else if (words.length >= 2) {
    candidate = (words[0]!.slice(0, 2) + words[1]!.slice(0, 1)).toUpperCase()
  }

  if (candidate && candidate.length < 3 && letters.length > candidate.length) {
    candidate = letters.slice(0, 3)
  }

  if (!candidate || candidate.length < 2) {
    return "PRJ"
  }
  return candidate
}

const SUFFIX_CHARS = "23456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
const MAX_KEY_LENGTH = 10

/**
 * Every key to try, in order, for a derived project key that may already be
 * taken in the org. The sequence never runs dry, so a free key always exists:
 *   1. the base key itself ("ARS")
 *   2. the base with its last character swapped for 2..9, A..Z ("AR2".."ARZ")
 *   3. the base plus one character ("ARS2".."ARSZ")
 *   4. the base plus a growing number ("ARS10", "ARS11", ...), up to the
 *      10-character key limit
 * Every candidate matches the stored key format `^[A-Z][A-Z0-9]{1,9}$` when the
 * base does, and no candidate repeats.
 */
export function* projectKeyCandidates(baseKey: string): Generator<string> {
  yield baseKey
  const stem = baseKey.slice(0, -1)
  const last = baseKey.slice(-1)
  for (const c of SUFFIX_CHARS) {
    if (c !== last) yield stem + c
  }
  if (baseKey.length >= MAX_KEY_LENGTH) return
  for (const c of SUFFIX_CHARS) yield baseKey + c
  for (let n = 10; `${baseKey}${n}`.length <= MAX_KEY_LENGTH; n++) yield `${baseKey}${n}`
}

const TASK_KEY_RE = /^([A-Z][A-Z0-9]{1,9})-(\d+)$/

/**
 * Parse a display task key like "ERB-12" into its project key and task
 * number. Case-insensitive on input (a user may type "erb-12"); the returned
 * key is always uppercase. Returns null for anything that doesn't match,
 * including a bare UUID (so a caller can try UUID first, then this).
 */
export function parseTaskKey(input: string): { key: string; number: number } | null {
  const trimmed = input.trim().toUpperCase()
  const match = TASK_KEY_RE.exec(trimmed)
  if (!match) return null
  return { key: match[1]!, number: Number(match[2]) }
}

/** Format a project key + task number as the display key, e.g. ("ERB", 12) -> "ERB-12". */
export function formatTaskKey(projectKey: string, number: number): string {
  return `${projectKey}-${number}`
}

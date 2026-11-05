// SPDX-License-Identifier: FSL-1.1-ALv2
//
// skill_search relevance — rank the skill catalog against a free-text query.
//
// THE PROBLEM. `skill_search` used to build its haystack as `name + description`
// and test it with a raw `haystack.includes(token)`. Two consequences, both hit
// in the field (an operator's MCP shipping session, 2026-08-04):
//
//   1. NO ACCENT FOLDING and NO MORPHOLOGY. A French operator's query
//      ("préparer commandes expédition boxtal impression étiquette") scored ZERO
//      against an English-authored org skill ("Prepare the shipment for a
//      customer order and buy the carrier label") — `préparer` is not a
//      substring of `prepare`, `commandes` is not a substring of `commande`.
//   2. THE DECLARED TRIGGER VOCABULARY WAS IGNORED. Skills carry
//      `auto_attach.keywords` — the author's explicit, multilingual trigger list
//      (`prepare-shipment` declares expedition/expedie/envoi/colis/...). The
//      auto-surface matcher consults it; skill_search did not, so the one piece
//      of data that exists precisely to solve (1) was dead weight on this path.
//
// The net effect: the FR query returned exactly one hit, `boxtal-overview` (a
// generic app blurb that matched only on the brand name), while the actual
// playbook was filtered out entirely. The agent followed the MCP instructions,
// searched, and was handed the wrong answer.
//
// THE MODEL. A skill has two vocabularies and they are not equally reliable:
//
//   * TRIGGER surface — `auto_attach.keywords`, `auto_attach.apps`, and the
//     owning `appName`. Author-curated, deliberately multilingual, written to be
//     matched. Weighted ABOVE the label.
//   * LABEL surface — `name + description`. Descriptive prose, usually English,
//     matched incidentally.
//
// Matching is accent-folded on both sides, and a query token matches a bag token
// when one is a PREFIX of the other sharing >= MIN_STEM_PREFIX characters. That
// is deliberately strict containment (not fuzzy distance): it buys plurals and
// verb endings — préparer/prepare, commandes/commande — with no room for the
// coincidental collisions an edit-distance matcher would admit.
//
// Unlike the auto-surface matcher this is PRECISION-SECOND: skill_search returns
// a RANKED LIST the agent then chooses from, so a marginal extra hit costs one
// line of output, whereas a miss costs the whole playbook. Recall wins here; the
// single-clear-winner gate stays where it belongs, in skill-autosurface.ts.
//
// Pure + deterministic (no I/O) so it is unit-testable in isolation.

import { significantTokens } from "~/modules/agent/skills/skill-autosurface"

/**
 * Accent-folded lowercase tokens, split on any non-alphanumeric run.
 *
 * Unlike `keywordTokens` (skill-autosurface.ts, min length 2) this keeps
 * SINGLE-character tokens: a search query may legitimately be `"s-"` or a bare
 * identifier fragment, and dropping those makes the query empty and the result
 * silently blank. Short tokens are harmless here because `tokenMatches` only
 * accepts them on an EXACT hit — the prefix rule needs MIN_STEM_PREFIX chars —
 * so a 1-char token cannot fan out across the catalog.
 */
export function searchTokens(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0)
}

/** A query token hitting the author-declared trigger surface. */
export const TRIGGER_TOKEN_WEIGHT = 2
/** A query token hitting the skill's name + description. */
export const LABEL_TOKEN_WEIGHT = 1
/** A declared multi-word keyword ("create shipment") appearing verbatim in the query. */
export const KEYWORD_PHRASE_BONUS = 3
/** The whole query appearing verbatim in a skill's text — scaled by query length. */
export const PHRASE_BONUS_PER_TOKEN = 1
/**
 * Shortest shared prefix that counts as a morphological match. 4 keeps
 * préparer/prepare and commandes/commande while rejecting short-token noise
 * (`col`/`colis`, `ship`/`shipping` are fine; `pre`/`prepare` is not).
 */
export const MIN_STEM_PREFIX = 4

export type SkillSearchSource = "personal" | "org" | "app"

/** The minimal shape the ranker needs from a resolved skill. */
export interface SearchCandidate {
  name: string
  description: string
  /** auto_attach.keywords — the author's explicit trigger vocabulary. */
  keywords?: readonly string[] | null
  /** auto_attach.apps — app anchors, matched so "boxtal" finds the boxtal playbook. */
  apps?: readonly string[] | null
  /** Owning app for app-shipped skills (null for DB skills). */
  appName?: string | null
  source: SkillSearchSource
}

export interface RankedSkill<T> {
  candidate: T
  score: number
}

/** Length of the longest common prefix of two strings. */
function sharedPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length)
  let i = 0
  while (i < max && a[i] === b[i]) i++
  return i
}

/**
 * True when `queryToken` and `bagToken` are the same word up to morphology:
 * identical, or one is a prefix of the other sharing >= MIN_STEM_PREFIX chars.
 */
export function tokenMatches(queryToken: string, bagToken: string): boolean {
  if (queryToken === bagToken) return true
  const shared = sharedPrefixLength(queryToken, bagToken)
  if (shared < MIN_STEM_PREFIX) return false
  // Strict prefix containment: the shorter token must be fully consumed.
  return shared === Math.min(queryToken.length, bagToken.length)
}

/** Count DISTINCT query tokens that match at least one token in the bag. */
function countMatchingQueryTokens(
  queryTokens: readonly string[],
  bag: ReadonlySet<string>,
): number {
  let matched = 0
  for (const q of queryTokens) {
    for (const b of bag) {
      if (tokenMatches(q, b)) {
        matched++
        break
      }
    }
  }
  return matched
}

/** The author-declared trigger vocabulary: keywords + app anchors + owning app. */
export function triggerTokens(candidate: SearchCandidate): Set<string> {
  const parts: string[] = []
  for (const k of candidate.keywords ?? []) parts.push(k)
  for (const a of candidate.apps ?? []) parts.push(a)
  if (candidate.appName) parts.push(candidate.appName)
  return new Set(searchTokens(parts.join(" ")))
}

/** The descriptive vocabulary: name + description. */
export function labelTokens(candidate: SearchCandidate): Set<string> {
  return new Set(searchTokens(`${candidate.name} ${candidate.description}`))
}

/**
 * Score one candidate against pre-folded query tokens + the folded query string.
 * Exported for tests and for the create_skill duplicate preflight, which reuses
 * this scorer so "would a search have found this?" and "does this already
 * exist?" can never drift apart.
 */
export function scoreCandidate(
  candidate: SearchCandidate,
  queryTokens: readonly string[],
  foldedQuery: string,
): number {
  const trigger = triggerTokens(candidate)
  const label = labelTokens(candidate)

  let score =
    TRIGGER_TOKEN_WEIGHT * countMatchingQueryTokens(queryTokens, trigger) +
    LABEL_TOKEN_WEIGHT * countMatchingQueryTokens(queryTokens, label)

  // A declared multi-word keyword appearing verbatim in the query is the
  // strongest signal there is — the author wrote that phrase to catch this ask.
  const paddedQuery = ` ${foldedQuery} `
  for (const kw of candidate.keywords ?? []) {
    const folded = searchTokens(kw).join(" ")
    if (folded.includes(" ") && paddedQuery.includes(` ${folded} `)) {
      score += KEYWORD_PHRASE_BONUS
    }
  }

  // Whole-query substring match against the label — preserves the old
  // behaviour's strong bias for an exact-phrase hit.
  if (queryTokens.length > 0) {
    const foldedLabel = searchTokens(`${candidate.name} ${candidate.description}`).join(" ")
    if (foldedLabel.includes(foldedQuery)) score += PHRASE_BONUS_PER_TOKEN * queryTokens.length
  }

  return score
}

/**
 * Rank `candidates` against `query`, returning positive-scoring entries only,
 * best first. Ties break toward the more SPECIFIC skill: a curated org/personal
 * playbook outranks an app's generic overview blurb (the FR shipping query ties
 * `prepare-shipment` with `boxtal-overview` on raw score, and the playbook is
 * unambiguously the better answer). Final tiebreak is name, for stable output.
 */
export function rankSkills<T extends SearchCandidate>(
  candidates: readonly T[],
  query: string,
): RankedSkill<T>[] {
  const queryTokens = Array.from(new Set(searchTokens(query)))
  const foldedQuery = searchTokens(query).join(" ")

  // An empty/degenerate query ranks nothing rather than everything — the caller
  // already has list_skills for "show me the catalog".
  if (queryTokens.length === 0) return []

  const sourceRank: Record<SkillSearchSource, number> = { personal: 0, org: 1, app: 2 }

  return candidates
    .map((candidate) => ({ candidate, score: scoreCandidate(candidate, queryTokens, foldedQuery) }))
    .filter((e) => e.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        sourceRank[a.candidate.source] - sourceRank[b.candidate.source] ||
        a.candidate.name.localeCompare(b.candidate.name),
    )
}

// ---------------------------------------------------------------------------
// Duplicate detection (create_skill preflight)
// ---------------------------------------------------------------------------

/**
 * Content-bearing tokens: accent-folded, stopwords and <3-char tokens dropped.
 *
 * The RANKER deliberately keeps every token (a search query may be `"s-"`), but
 * a DUPLICATE check needs the opposite bias: counting "and"/"the"/"for" toward
 * overlap would make every pair of skills look alike. Reuses the auto-surface
 * stopword list so all three matchers share one notion of a meaningful word.
 */
export function contentTokens(text: string): Set<string> {
  return significantTokens(text.normalize("NFD").replace(/[\u0300-\u036f]/g, ""))
}

export interface DuplicateMatch {
  name: string
  /** Fraction of the PROPOSED skill's content tokens the existing skill covers. */
  coverage: number
  matched: number
}

/** A proposal must overlap this much of its own vocabulary to count as a dupe. */
export const DUPLICATE_MIN_COVERAGE = 0.6
/** ...and on at least this many distinct content words, so a 2-word name cannot trip it. */
export const DUPLICATE_MIN_MATCHED = 3

/**
 * Find existing skills that already cover what `proposed` describes.
 *
 * Directional on purpose: coverage is measured over the PROPOSED skill's own
 * vocabulary, so a narrow new skill whose every content word already appears in
 * a broad existing playbook is flagged, while a broad new skill that merely
 * touches a narrow existing one is not.
 *
 * Deliberately conservative (0.6 of content tokens AND >= 3 of them): creation
 * is gated and human-reviewed anyway, so the cost of a miss is a duplicate a
 * human catches, while the cost of a false positive is blocking legitimate
 * authoring. Best matches first.
 */
export function findDuplicateSkills(
  proposed: { name: string; description: string },
  existing: readonly SearchCandidate[],
  minCoverage: number = DUPLICATE_MIN_COVERAGE,
  minMatched: number = DUPLICATE_MIN_MATCHED,
): DuplicateMatch[] {
  const proposedTokens = contentTokens(`${proposed.name} ${proposed.description}`)
  if (proposedTokens.size === 0) return []

  const out: DuplicateMatch[] = []
  for (const candidate of existing) {
    const bag = new Set<string>([
      ...contentTokens(`${candidate.name} ${candidate.description}`),
      ...contentTokens([...(candidate.keywords ?? []), ...(candidate.apps ?? [])].join(" ")),
    ])
    if (bag.size === 0) continue
    let matched = 0
    for (const t of proposedTokens) {
      for (const b of bag) {
        if (tokenMatches(t, b)) {
          matched++
          break
        }
      }
    }
    const coverage = matched / proposedTokens.size
    if (matched >= minMatched && coverage >= minCoverage) {
      out.push({ name: candidate.name, coverage, matched })
    }
  }
  return out.sort((a, b) => b.coverage - a.coverage || a.name.localeCompare(b.name))
}

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Skill auto-surfacing — make a CLEARLY-matching skill's BODY reach the agent
// without relying on the weak model to proactively call `skill_read`.
//
// THE PROBLEM (BL-265). Skills are listed in the system prompt by NAME +
// description, and the agent is told it can `skill_read` one to load its full
// playbook. On a single-step task this is enough. But on a multi-step / multi-app
// task the weak model (gemini-flash-lite, every reasoning rung) reliably does NOT
// invoke `skill_read` — it jumps straight to acting from its own plan and drops
// the steps the skill teaches (e.g. the third gated leg of an RMA bundle, the KB
// grounding). A system-prompt directive ("scan the Skills list, skill_read a
// match before a multi-step task") only intermittently bites.
//
// THE MECHANISM. When the user's task text CLEARLY matches exactly one available
// skill, inject that one skill's BODY directly into the system prompt (the same
// `## Skill: <name>` framing a prior `skill_read` produces), so the playbook is
// in-context the moment the agent starts — no tool call required. This is
// PRECISION-FIRST: it fires only on an unambiguous single-winner match so it
// never surfaces the wrong playbook or bloats context with several bodies. A
// genuinely ambiguous task (no clear winner) falls back to the existing
// skill_search / skill_read path untouched.
//
// Pure + deterministic (no I/O) so it is unit-testable in isolation; the context
// assembler calls `selectAutoSurfacedSkills` with the resolved skills + the
// concatenated user-turn text.

/** The minimal shape the matcher needs from a resolved skill. */
export interface AutoSurfaceCandidate {
  name: string
  description: string
  /**
   * Author-declared trigger keywords (from `kernel.skills.auto_attach.keywords`).
   * A keyword hit BYPASSES the token-overlap gate: phrasing variety ("create
   * shipment", "expedie la commande") cannot be covered by name+description
   * tokens without wrecking the coverage denominator, so authors declare the
   * trigger vocabulary explicitly. Single words match as whole tokens; multi-word
   * keywords match as an ordered token phrase. Accent-folded on both sides.
   */
  keywords?: readonly string[] | null
  /**
   * Author-declared app anchors (from `kernel.skills.auto_attach.apps`). A skill
   * anchored to an app is surfaced whenever the CONVERSATION is demonstrably
   * about that app — the thread already carries that app's tool calls — even
   * when the current user turn has zero matching vocabulary ("make this reply
   * friendlier" while finetuning a ticket draft). See selectAppAnchoredSkills.
   */
  apps?: readonly string[] | null
}

export interface AutoSurfaceTuning {
  /**
   * Minimum number of distinct significant skill tokens that must appear in the
   * task text for a skill to be eligible. Guards against a one-word coincidence.
   */
  minMatchedTokens: number
  /**
   * Minimum fraction of the skill's own significant tokens that the task must
   * cover. A high bar keeps precision up (the task is really ABOUT this skill).
   */
  minCoverage: number
  /**
   * The single winner must beat the runner-up by at least this many matched
   * tokens. Enforces "exactly one clear match" — an ambiguous task surfaces none.
   */
  winnerMargin: number
  /** Defensive cap on how many skills may be auto-surfaced in one turn. */
  maxSurfaced: number
}

export const DEFAULT_AUTO_SURFACE_TUNING: AutoSurfaceTuning = {
  minMatchedTokens: 3,
  minCoverage: 0.4,
  winnerMargin: 2,
  maxSurfaced: 1,
}

// Common English + product-domain filler that carries no matching signal. Kept
// small + deterministic; the coverage/margin gates do the real precision work.
const STOPWORDS = new Set<string>([
  "the",
  "and",
  "for",
  "with",
  "all",
  "set",
  "use",
  "how",
  "are",
  "not",
  "but",
  "you",
  "your",
  "our",
  "its",
  "into",
  "from",
  "this",
  "that",
  "then",
  "them",
  "they",
  "him",
  "her",
  "his",
  "she",
  "his",
  "out",
  "now",
  "one",
  "two",
  "three",
  "once",
  "when",
  "what",
  "who",
  "whom",
  "each",
  "every",
  "some",
  "any",
  "can",
  "will",
  "would",
  "should",
  "could",
  "have",
  "has",
  "had",
  "been",
  "being",
  "get",
  "got",
  "make",
  "made",
  "also",
  "just",
  "like",
  "about",
  "over",
  "under",
  "than",
  "more",
  "most",
  "such",
  "only",
  "via",
  "per",
  "off",
  "yet",
  "let",
  "tell",
  "ask",
  "want",
  "need",
  "please",
  "thanks",
  "hello",
])

/**
 * Normalize free text into a SET of distinct significant tokens: lowercase,
 * split on non-alphanumerics, drop stopwords and tokens shorter than 3 chars.
 * A set (not a bag) so repetition in a long task description cannot inflate a
 * match — presence is what matters.
 */
export function significantTokens(text: string): Set<string> {
  const out = new Set<string>()
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3) continue
    if (STOPWORDS.has(raw)) continue
    out.add(raw)
  }
  return out
}

interface ScoredSkill {
  name: string
  matched: number
  coverage: number
  skillTokenCount: number
}

/**
 * Score every candidate skill against the task text, then return the BODY-worthy
 * winners under the precision gate. Deterministic + side-effect free.
 *
 * A skill is a winner only when ALL hold:
 *   - it matched >= minMatchedTokens distinct significant skill tokens, AND
 *   - it covered >= minCoverage of its own significant tokens, AND
 *   - it beat the runner-up by >= winnerMargin matched tokens (single clear win).
 *
 * `alreadyLoaded` skills (a prior skill_read already re-injects their body) are
 * excluded so we never double-inject.
 */
/**
 * Accent-folded normalized token sequence ("Expédie la commande" -> ["expedie",
 * "la", "commande"] minus short/stopword tokens is NOT applied here — keyword
 * matching keeps ALL tokens >= 2 chars so short trigger words like "colis" or a
 * phrase's connecting words survive). Used only for keyword matching;
 * significantTokens stays the vocabulary for the statistical gate.
 */
export function keywordTokens(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2)
}

/** True when `keyword` (word or ordered phrase) appears in the task text. */
export function keywordMatches(keyword: string, taskTokenText: string): boolean {
  const kw = keywordTokens(keyword).join(" ")
  if (kw.length === 0) return false
  return ` ${taskTokenText} `.includes(` ${kw} `)
}

/** Defensive cap on how many app-anchored skill bodies may be injected per turn. */
export const MAX_APP_ANCHORED_SKILLS = 3

/**
 * APP-ANCHORED surfacing — the second trigger, orthogonal to the task-text
 * matcher above. The task-text gate fails by design on a follow-up turn that
 * carries no domain vocabulary ("shorten it", "make it friendlier") even though
 * the conversation is unambiguously anchored to an app surface (a ticket draft
 * was produced right there). So: a skill that declares `auto_attach.apps`
 * surfaces whenever the thread's ACTIVE apps (apps whose tools were already
 * called or discovered in this thread) intersect its anchors. Precision comes
 * from the anchor being conversation evidence, not text similarity.
 *
 * Deterministic + pure. Returns names in candidate order, capped, excluding
 * skills already loaded via a prior skill_read.
 */
export function selectAppAnchoredSkills(
  candidates: readonly AutoSurfaceCandidate[],
  activeApps: ReadonlySet<string>,
  alreadyLoaded: ReadonlySet<string> = new Set(),
  maxSurfaced: number = MAX_APP_ANCHORED_SKILLS,
): string[] {
  if (activeApps.size === 0) return []
  const out: string[] = []
  for (const c of candidates) {
    if (out.length >= maxSurfaced) break
    if (alreadyLoaded.has(c.name)) continue
    if ((c.apps ?? []).some((a) => activeApps.has(a))) out.push(c.name)
  }
  return out
}

export function selectAutoSurfacedSkills(
  candidates: readonly AutoSurfaceCandidate[],
  taskText: string,
  alreadyLoaded: ReadonlySet<string> = new Set(),
  tuning: AutoSurfaceTuning = DEFAULT_AUTO_SURFACE_TUNING,
): string[] {
  const taskTokens = significantTokens(taskText)
  if (taskTokens.size === 0) return []

  // Keyword fast-path: author-declared triggers bypass the statistical gate.
  // Exactly one keyword-hit skill -> surface it. Several -> most distinct
  // keyword hits wins; a tie is ambiguous and falls through to the token gate.
  const taskTokenText = keywordTokens(taskText).join(" ")
  const keywordHits: Array<{ name: string; hits: number }> = []
  for (const c of candidates) {
    if (alreadyLoaded.has(c.name)) continue
    const kws = c.keywords ?? []
    let hits = 0
    for (const kw of kws) if (keywordMatches(kw, taskTokenText)) hits++
    if (hits > 0) keywordHits.push({ name: c.name, hits })
  }
  if (keywordHits.length === 1) return [keywordHits[0].name]
  if (keywordHits.length > 1) {
    keywordHits.sort((a, b) => b.hits - a.hits)
    if (keywordHits[0].hits > keywordHits[1].hits) return [keywordHits[0].name]
    // tie: ambiguous, fall through to the statistical gate below
  }

  const scored: ScoredSkill[] = []
  for (const c of candidates) {
    if (alreadyLoaded.has(c.name)) continue
    // The skill's own vocabulary = its name + description tokens. The name is a
    // strong distinctive signal (e.g. "rma", "rma-full-setup"); the description
    // is a curated one-line statement of the task it is for.
    const skillTokens = significantTokens(`${c.name} ${c.description}`)
    if (skillTokens.size === 0) continue
    let matched = 0
    for (const t of skillTokens) if (taskTokens.has(t)) matched++
    const coverage = matched / skillTokens.size
    scored.push({ name: c.name, matched, coverage, skillTokenCount: skillTokens.size })
  }

  // Eligible = clears the per-skill bars.
  const eligible = scored
    .filter((s) => s.matched >= tuning.minMatchedTokens && s.coverage >= tuning.minCoverage)
    .sort((a, b) => b.matched - a.matched || b.coverage - a.coverage)

  if (eligible.length === 0) return []

  // Single-clear-winner gate: the top must beat the next eligible by the margin.
  // (If there is only one eligible skill, there is no contender — it wins.)
  const top = eligible[0]
  const runnerUp = eligible[1]
  if (runnerUp && top.matched - runnerUp.matched < tuning.winnerMargin) {
    // Ambiguous — two skills are about equally about this task. Fall back to the
    // skill_search / skill_read path rather than guess; surface none.
    return []
  }

  return eligible.slice(0, tuning.maxSurfaced).map((s) => s.name)
}

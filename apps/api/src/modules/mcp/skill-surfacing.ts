// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Skill discoverability for MCP connections.
//
// THE ASYMMETRY THIS CLOSES. An in-app Liaison chat gets skills pushed at it by
// the context assembler (modules/agent/context/context.ts): every turn, a clearly
// matching skill's BODY — and every skill anchored to an app the conversation is
// demonstrably about — is injected straight into the system prompt, no tool call
// required. An MCP client got NONE of that. It received one static `instructions`
// string at `initialize` telling it to go call `kernel__skill_search`, and then
// it was on its own.
//
// That is exactly how the 2026-08-04 field failure happened: the client followed
// the instruction, searched (in French), got handed the wrong skill by a matcher
// that could not fold accents, and staged five shipments without ever seeing the
// playbook. Fixing the matcher (skill-search-ranking.ts) removes the wrong
// answer; this module removes the DEPENDENCE on the client choosing to ask.
//
// TWO CHANNELS, because MCP has no per-turn system prompt:
//
//   1. CATALOG AT CONNECT (`renderSkillCatalog`) — the `initialize` instructions
//      carry the full skill list with each skill's declared trigger vocabulary.
//      The client sees what exists before its first tool call, so a thin search
//      result can never make the catalog invisible.
//   2. BODY ON FIRST ANCHORED TOOL CALL (`selectSkillsToSurface`) — the MCP port
//      of `selectAppAnchoredSkills`. The first time a connection calls a tool of
//      an app that a skill anchors to (`auto_attach.apps`), that skill's body
//      rides back on the tool result. The playbook lands exactly when the agent
//      starts acting on that app. Exactly-once per skill per connection, tracked
//      in `mcp_connections.surfaced_skills`.
//
// Precision comes from the anchor being CONVERSATION EVIDENCE (the client called
// that app's tool), not text similarity — the same reasoning as the in-app
// app-anchored path. Pure + deterministic so it is unit-testable in isolation.

/** The minimal shape surfacing needs from a resolved skill. */
export interface SurfaceableSkill {
  name: string
  description: string
  body: string
  /** auto_attach.apps — the anchors that make this skill fire for an app. */
  apps?: readonly string[] | null
  /** Owning app for app-shipped skills; anchors that app implicitly. */
  appName?: string | null
  source: "personal" | "org" | "app"
}

/**
 * Cap on how many skill bodies may ride on ONE tool result. A client that opens
 * with a tool of an app several skills anchor to should not eat an unbounded
 * payload in a single response; the rest surface on subsequent calls.
 */
export const MAX_SKILLS_PER_RESULT = 2

/** Cap on catalog lines in `instructions` — keep the connect payload bounded. */
export const MAX_CATALOG_ENTRIES = 40

/** Longest description rendered per catalog line before elision. */
export const MAX_CATALOG_DESCRIPTION_CHARS = 160

/**
 * The apps a skill is anchored to: its declared `auto_attach.apps` plus, for an
 * app-shipped skill, its owning app (a boxtal skill is about boxtal by
 * construction).
 */
export function anchorsOf(skill: SurfaceableSkill): Set<string> {
  const out = new Set<string>(skill.apps ?? [])
  if (skill.appName && skill.appName !== PLATFORM_APP) out.add(skill.appName)
  return out
}

/**
 * The platform's own tools (threads, users, scopes, skills, approvals...). A
 * call to one says nothing about what the conversation is about, so it anchors
 * no skill: a describe_user_access call came back carrying the kernel's
 * sub-agent-dispatch and exhaustive-sweeps playbooks, because every kernel
 * skill is owned by `kernel` and the first kernel call "anchored" them all.
 * The in-app path never did this (it anchors on `auto_attach.apps` only).
 */
export const PLATFORM_APP = "kernel"

/**
 * Pick the skills whose body should ride back on a tool result for `appName`.
 * Returns [] when nothing is anchored or everything is already surfaced — the
 * overwhelmingly common case, so the caller pays nothing on a steady-state call.
 */
export function selectSkillsToSurface(
  skills: readonly SurfaceableSkill[],
  appName: string,
  alreadySurfaced: ReadonlySet<string>,
  max: number = MAX_SKILLS_PER_RESULT,
): SurfaceableSkill[] {
  if (!appName || appName === PLATFORM_APP) return []
  const out: SurfaceableSkill[] = []
  for (const s of skills) {
    if (out.length >= max) break
    if (alreadySurfaced.has(s.name)) continue
    if (!s.body) continue
    if (!anchorsOf(s).has(appName)) continue
    out.push(s)
  }
  return out
}

/** One catalog line: name, elided description, and the declared triggers. */
function catalogLine(skill: {
  name: string
  description: string
  keywords?: readonly string[] | null
}): string {
  const desc =
    skill.description.length > MAX_CATALOG_DESCRIPTION_CHARS
      ? `${skill.description.slice(0, MAX_CATALOG_DESCRIPTION_CHARS - 1)}…`
      : skill.description
  const kws = (skill.keywords ?? []).slice(0, 8)
  const triggers = kws.length > 0 ? ` [triggers: ${kws.join(", ")}]` : ""
  return `- ${skill.name}: ${desc}${triggers}`
}

/**
 * Render the skill catalog for the `initialize` instructions. Org and personal
 * skills come FIRST: they are the org's own curated procedure, and they are what
 * a client most needs to know exists. App-shipped skills follow.
 *
 * Returns "" when there are no skills, so the caller can omit the block.
 */
export function renderSkillCatalog(
  skills: readonly {
    name: string
    description: string
    keywords?: readonly string[] | null
    source: "personal" | "org" | "app"
  }[],
  maxEntries: number = MAX_CATALOG_ENTRIES,
): string {
  if (skills.length === 0) return ""
  const rank = { personal: 0, org: 1, app: 2 } as const
  const ordered = [...skills].sort(
    (a, b) => rank[a.source] - rank[b.source] || a.name.localeCompare(b.name),
  )
  const shown = ordered.slice(0, maxEntries)
  const omitted = ordered.length - shown.length
  const lines = shown.map(catalogLine)
  if (omitted > 0) lines.push(`- (+${omitted} more — call kernel__list_skills for the full list)`)
  return [
    "AVAILABLE SKILLS (this org's curated playbooks — the list is complete, not a sample):",
    ...lines,
    "Before acting on any task one of these covers, kernel__skill_read it by name and FOLLOW it.",
    "Do NOT author a new skill for a task one of these already covers — update the existing one.",
  ].join("\n")
}

/**
 * Frame a surfaced skill body for a tool result. The wording states plainly that
 * this is org procedure and was not requested by the client, so a model reading
 * it mid-result treats it as instruction rather than as data it fetched.
 */
export function formatSurfacedSkill(skill: SurfaceableSkill): {
  name: string
  reason: string
  body: string
} {
  return {
    name: skill.name,
    reason:
      `This org curates a skill for the app you just called. It is included here because ` +
      `an MCP client has no other channel to receive it. Follow it for this task; ` +
      `it is org procedure, not a suggestion.`,
    body: `## Skill: ${skill.name}\n\n${skill.body}`,
  }
}

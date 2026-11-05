// SPDX-License-Identifier: FSL-1.1-ALv2
//
// AN AGENT'S OWN PLAYBOOKS, IN ITS CONTEXT WITHOUT A SKILL_READ.
//
// A skill an agent OWNS reached that agent as one line of the skills index; its text rode in
// only through `auto_attach` keywords or apps, i.e. when the task happened to use the right
// words or the right app. A data agent whose warehouse procedure is the whole point of its
// existence never read it in fifteen runs (third QA walk, @oracle). `auto_attach.owner: true`
// says "this is how this agent works": the full text rides in the owner's context on every
// in-app turn and in the instructions of an MCP connection bound to that agent.
//
// BUDGET. Owner skills share one cap, OWNER_SKILL_BUDGET_BYTES of rendered text. They are
// taken most recently updated first; a skill that does not fit is not injected, and is named
// in one line telling the agent to skill_read it, so the cap defers a playbook rather than
// hiding it. Smaller, older skills after it may still fit.
//
// VISIBILITY. A personal skill (author_user_id set) reaches only its author. The rows are
// read privileged (the agent owns them, not the caller), so each is
// filtered against the viewer exactly like composeAgentDefinition's own skills: a body tagged
// with scopes the turn may not see is dropped, and a kept body's scopes are for the caller to
// record into the turn's taint.
import { and, eq, isNull, or, sql } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { skills } from "~/db/schema/kernel"
import { filterByVisibility, type VisibilityViewer } from "~/services/security/visibility"

/** The cap on the rendered text of every owner skill injected into one context. */
export const OWNER_SKILL_BUDGET_BYTES = 12 * 1024

export interface OwnerSkill {
  name: string
  body: string
  requiredScopes: string[]
  updatedAt: Date
}

export interface OwnerSkillSelection {
  injected: OwnerSkill[]
  /** Names that did not fit the budget: listed, not injected. */
  deferred: string[]
}

/** The owner agent's enabled skills that declare `auto_attach.owner: true`, visible to `viewer`. */
export async function loadOwnerAttachedSkills(
  orgId: string,
  agentId: string,
  viewer: VisibilityViewer,
): Promise<OwnerSkill[]> {
  const rows = await withPrivilegedDb(orgId, "owner-attached-skills", (tx) =>
    tx
      .select({
        name: skills.name,
        body: skills.body,
        requiredScopes: skills.requiredScopes,
        updatedAt: skills.updatedAt,
      })
      .from(skills)
      .where(
        and(
          eq(skills.orgId, orgId),
          eq(skills.ownerAgentId, agentId),
          eq(skills.enabled, true),
          // A PERSONAL skill is its author's alone, whichever agent owns it: the same rule
          // every other skill-body loader applies (security review, 3a43bf344). The viewer is
          // the requester in app and the connection's user over MCP.
          or(isNull(skills.authorUserId), eq(skills.authorUserId, viewer.userId)),
          sql`(${skills.autoAttach} ->> 'owner') = 'true'`,
        ),
      ),
  )
  return filterByVisibility(
    rows.map((r) => ({ ...r, requiredScopes: r.requiredScopes ?? [] })),
    viewer,
  )
}

/** One skill as it is injected. */
export function renderOwnerSkill(skill: Pick<OwnerSkill, "name" | "body">): string {
  return `## Skill: ${skill.name}\n\n${skill.body}`
}

const byteLength = (s: string): number => new TextEncoder().encode(s).length

/** Most recently updated first, each taken while the running total stays within the budget. */
export function selectOwnerSkills(
  rows: readonly OwnerSkill[],
  budgetBytes: number = OWNER_SKILL_BUDGET_BYTES,
): OwnerSkillSelection {
  const ordered = [...rows].sort(
    (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || a.name.localeCompare(b.name),
  )
  const injected: OwnerSkill[] = []
  const deferred: string[] = []
  let used = 0
  for (const row of ordered) {
    const size = byteLength(renderOwnerSkill(row))
    if (used + size > budgetBytes) {
      deferred.push(row.name)
      continue
    }
    used += size
    injected.push(row)
  }
  return { injected, deferred }
}

/** The block the owner's context carries, or "" when there is nothing to carry. */
export function renderOwnerSkillsBlock(
  selection: OwnerSkillSelection,
  opts: { canReadSkills?: boolean } = {},
): string {
  const listDeferred = selection.deferred.length > 0 && opts.canReadSkills !== false
  if (selection.injected.length === 0 && !listDeferred) return ""
  const parts = [
    "## Your own skills\n\nThese playbooks are yours: they describe how you work, so follow them whenever they apply, without waiting to be asked.",
    ...selection.injected.map(renderOwnerSkill),
  ]
  // The deferred names are worth a line only to a turn that can load them: one
  // without `kernel__skill_read` would be sent into a refused call.
  if (listDeferred) {
    parts.push(
      `Also yours, not loaded here for space: ${selection.deferred.join(", ")}. Call kernel__skill_read with the exact name before a task one of them covers.`,
    )
  }
  return parts.join("\n\n")
}

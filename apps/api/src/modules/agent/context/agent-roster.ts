// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P3b-T03: the org roster an agent carries in its system prompt.
//
// spec-agents.md: an agent "knows the org roster via a kernel lookup". The
// block is rendered from `kernel.agents` and nothing else, so it is a pure
// function of the roster: no time, no room, no member list, no per turn field
// of any kind. That is what lets it sit in the STABLE prefix beside the
// charter and cost no per turn cache miss (spec-memory.md I2, I6).
//
// A roster CHANGE (an agent added, archived, renamed or repurposed) does
// invalidate the cached prefix once for every agent of the org. That is the
// price of a roster that cannot desync, and it is paid on roster edits only.
import { and, asc, eq, isNull, ne } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { type Agent, agents } from "~/db/schema/kernel/agents"
import { estimateTokens } from "~/modules/agent/context/compaction"
import { deriveAgentPurpose, loadPrompt } from "~/modules/agent/context/context"

/** The literal the roster opens with; the budget line locates it by this. */
export const AGENT_ROSTER_OPEN_TAG = "<agent-roster>"

/** The roster's budget in tokens (spec-memory.md "Budgets"). ENFORCED: a cap
 *  that is only logged is not a cap, and a 200 agent org would otherwise push
 *  every other stable part out of the prefix. */
export const AGENT_ROSTER_TOKEN_CAP = 600

/** The line a cut roster ends on, so a partial list never reads as the whole
 *  org and the agent is told how to reach the rest. */
function moreAgentsLine(remaining: number): string {
  return `and ${remaining} more agents: ask any of them by handle with kernel__agents_ask`
}

/** The built in system agent is not a specialist anyone delegates to. */
const BASE_AGENT_HANDLE = "@base"

/**
 * Nor is a PERSONAL agent: it acts for one person and owns no area of the org.
 * Listed as "- @tobias (personal):", a colleague's personal agent read as the
 * colleague, and an agent asked to "answer tobias" asked Tobias's agent
 * instead of answering Tobias. A person is answered in the conversation.
 */
function isRosterAgent(row: Pick<RosterRow, "id" | "handle" | "kind">, selfAgentId: string) {
  return row.id !== selfAgentId && row.handle !== BASE_AGENT_HANDLE && row.kind !== "personal"
}

export type RosterRow = Pick<
  Agent,
  "id" | "handle" | "kind" | "displayName" | "systemPrompt" | "purpose"
>

/**
 * The org's live agents, minus the asking agent, `@base` and every personal
 * agent (`isRosterAgent`), ordered by
 * handle so the rendered bytes depend on the roster and on nothing else (not
 * on insertion order, not on a planner's whim). Privileged: an agent may know
 * its colleagues exist whatever the reading member holds, and the row carries
 * no scoped data beyond a handle and a purpose.
 */
export async function loadRosterRows(orgId: string, selfAgentId: string): Promise<RosterRow[]> {
  return withPrivilegedDb(orgId, "agent-roster", (tx) =>
    tx
      .select({
        id: agents.id,
        handle: agents.handle,
        kind: agents.kind,
        displayName: agents.displayName,
        systemPrompt: agents.systemPrompt,
        // The purpose column is what a role agent's line is made of: roster
        // role agents carry an EMPTY system prompt, so without it every line
        // rendered as a bare handle and agents routed by guessing.
        purpose: agents.purpose,
      })
      .from(agents)
      .where(
        and(
          eq(agents.orgId, orgId),
          isNull(agents.archivedAt),
          ne(agents.handle, BASE_AGENT_HANDLE),
          ne(agents.kind, "personal"),
          ne(agents.id, selfAgentId),
        ),
      )
      .orderBy(asc(agents.handle)),
  )
}

async function getAgentRosterTemplate(): Promise<string> {
  return loadPrompt("agent-roster.md", "")
}

/**
 * Render the roster block. The membership rules are applied here too, not only
 * in the query: a caller that hands over an unfiltered read still gets a block
 * with no `@base` line and no line naming the asking agent.
 *
 * An org of one agent renders NOTHING, never a hollow header telling a lone
 * agent to delegate to colleagues it does not have.
 */
export async function renderAgentRoster(params: {
  orgId: string
  selfAgentId: string
  rows: RosterRow[]
}): Promise<string> {
  const template = await getAgentRosterTemplate()
  if (!template) return ""
  const lines = params.rows
    .filter((row) => isRosterAgent(row, params.selfAgentId))
    .sort((a, b) => (a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0))
    .map((row) =>
      // The purpose comes from `deriveAgentPurpose`, the one derivation the
      // charter already uses; it is never re-derived here, so a roster line and
      // the named agent's own charter cannot drift apart.
      `- ${row.handle} (${row.kind}): ${deriveAgentPurpose(row)}`.trimEnd(),
    )
  if (lines.length === 0) return ""
  const render = (body: string[]) =>
    template.replaceAll("{{rosterLines}}", body.join("\n")).trimEnd()
  const whole = render(lines)
  if (estimateTokens(whole) <= AGENT_ROSTER_TOKEN_CAP) return whole
  // Over budget: keep the roster in handle order and cut from the end, always
  // leaving room for the line that says what was cut. Zero kept lines is still
  // a roster with a remainder line, never a silently empty block.
  let kept = lines.length
  while (kept > 0) {
    kept--
    const candidate = render([...lines.slice(0, kept), moreAgentsLine(lines.length - kept)])
    if (estimateTokens(candidate) <= AGENT_ROSTER_TOKEN_CAP) return candidate
  }
  return render([moreAgentsLine(lines.length)])
}

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The org's named agents, rendered into the MCP `initialize` instructions.
//
// An in-app turn carries the roster in its system prompt (agent-roster.ts). An
// MCP client has no system prompt of ours beyond `instructions`, so without
// this block it holds `kernel__agents_ask` and no handle to pass it: asked to
// talk to "the Growth agent", it found only `kernel__subagent_list` (spawnable
// roles, a different thing) and told the person no such agent existed.
//
// Same rows and same purpose derivation as the in-app roster, so the two lists
// cannot drift apart. Rendered only when the connection can call agents_ask.
import { and, asc, eq, isNull, ne, or } from "drizzle-orm"
import { withRlsContext } from "~/db/rls"
import { agents } from "~/db/schema/kernel/agents"
import type { RosterRow } from "~/modules/agent/context/agent-roster"
import { deriveAgentPurpose } from "~/modules/agent/context/context"

/** Cap on directory lines, so the connect payload stays bounded. */
export const MAX_DIRECTORY_ENTRIES = 30

/**
 * The agents this person may address, the rule the app's DM picker applies
 * (`addressableAgents`): live, not a system agent, and no colleague's personal
 * agent. This block reaches the person's own client, so it may show no more
 * than the app does. The connection's own agent is left out.
 */
export async function loadMcpAgentDirectory(
  orgId: string,
  userId: string,
  selfAgentId: string | undefined,
): Promise<RosterRow[]> {
  // kernel.agents is readable org wide under RLS (agents_select), so an
  // org-bound system context lists this org's agents with no bypass; the
  // personal-agent rule below is the visibility the roster applies.
  return withRlsContext({ actorType: "system", orgId, purpose: "job" }, (tx) =>
    tx
      .select({
        id: agents.id,
        handle: agents.handle,
        kind: agents.kind,
        displayName: agents.displayName,
        systemPrompt: agents.systemPrompt,
        purpose: agents.purpose,
      })
      .from(agents)
      .where(
        and(
          eq(agents.orgId, orgId),
          isNull(agents.archivedAt),
          ne(agents.kind, "system"),
          or(ne(agents.kind, "personal"), eq(agents.ownerUserId, userId)),
          ...(selfAgentId ? [ne(agents.id, selfAgentId)] : []),
        ),
      )
      .orderBy(asc(agents.handle)),
  )
}

/**
 * An MCP client keeps only the first 2048 characters of `instructions`
 * (measured on Claude Code: the rest is cut mid-sentence), so the directory
 * rides where it is read whole: one short line at the very top of the
 * instructions, and the full list on the agents_ask tool description, which a
 * client reads exactly when it considers asking.
 */
export const MAX_HEADLINE_ENTRIES = 12

/** Longest purpose rendered per directory line before elision. */
export const MAX_PURPOSE_CHARS = 90

function byHandle(rows: readonly RosterRow[]): RosterRow[] {
  return [...rows].sort((a, b) => (a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0))
}

/** The line that opens the instructions: handles and names only. */
export function renderMcpAgentHeadline(rows: readonly RosterRow[]): string {
  if (rows.length === 0) return ""
  const ordered = byHandle(rows)
  const named = ordered
    .slice(0, MAX_HEADLINE_ENTRIES)
    .map((row) => `${row.handle} (${row.displayName})`)
  const more =
    ordered.length > MAX_HEADLINE_ENTRIES
      ? `, and ${ordered.length - MAX_HEADLINE_ENTRIES} more`
      : ""
  return `NAMED AGENTS of this organization: ${named.join(", ")}${more}. To talk to one, call kernel__agents_ask with its handle; kernel__subagent_list never lists them.`
}

/** The full list, appended to the agents_ask description on this connection. */
export function renderMcpAgentDirectory(
  rows: readonly RosterRow[],
  maxEntries: number = MAX_DIRECTORY_ENTRIES,
): string {
  if (rows.length === 0) return ""
  const ordered = byHandle(rows)
  const lines = ordered.slice(0, maxEntries).map((row) => {
    const raw = deriveAgentPurpose(row)
    const purpose = raw.length > MAX_PURPOSE_CHARS ? `${raw.slice(0, MAX_PURPOSE_CHARS - 1)}…` : raw
    return `- ${row.handle} (${row.displayName})${purpose ? `: ${purpose}` : ""}`
  })
  if (ordered.length > maxEntries) {
    lines.push(`- and ${ordered.length - maxEntries} more: ask by handle`)
  }
  return [
    'The agents you can ask, by agentHandle. When the person names one ("the Growth agent") or asks for something in its area, ask it:',
    ...lines,
  ].join("\n")
}

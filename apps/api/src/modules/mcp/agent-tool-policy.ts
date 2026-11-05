// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The bound agent's tool allow/deny policy for an agent-bound MCP connection.
//
// Read FRESH from `kernel.agents` on every call: no module-level cache, no
// memoization, no per-process map. An admin who adds a tool to an agent's
// denylist must see the next request refused, exactly as a narrowed ceiling
// applies on the next request (connection-service recomputes scopes the same
// way). A cache here would serve a policy nobody is curating any more.
//
// The policy is a SECOND filter stage, applied after the fail-closed
// requiredScopes catalog check: it can only ever remove tools, never add one
// the caller's scopes do not already admit.

import { and, eq, isNull } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { agents } from "~/db/schema/kernel"

export interface AgentToolPolicy {
  toolAllowlist: string[]
  toolDenylist: string[]
  /**
   * True when no live (non-archived, same-org) agent row backs this policy.
   * Nothing is admitted: an agent taken out of service must not keep a catalog
   * open, and an id that resolves to nothing is not evidence of permission.
   */
  agentMissing: boolean
}

/** The bound agent's live allow/deny lists. Never cached. */
export async function loadAgentToolPolicy(
  orgId: string,
  agentId: string,
): Promise<AgentToolPolicy> {
  const [row] = await withSystemDb("mcp-agent-tool-policy", (db) =>
    db
      .select({ toolAllowlist: agents.toolAllowlist, toolDenylist: agents.toolDenylist })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId), isNull(agents.archivedAt))),
  )
  if (!row) return { toolAllowlist: [], toolDenylist: [], agentMissing: true }
  return {
    toolAllowlist: row.toolAllowlist ?? [],
    toolDenylist: row.toolDenylist ?? [],
    agentMissing: false,
  }
}

/**
 * Does the bound agent's policy admit this tool?
 *
 * A tool answers to TWO names: the CANONICAL `app:tool`, which is the form
 * `kernel.agents` documents and the in-app tool bridge matches its own
 * allow/deny lists against, and the BARE SDK key `app__tool`, which is what
 * the gateway catalog and `tools/call` carry (the `mcp__liaison__` prefix is a
 * client-side namespacing convention this codebase never emits or strips).
 * A list entry in EITHER form matches, so one curated policy governs the
 * in-app agent and its MCP connection identically; matching only the SDK key
 * here made a canonical denylist entry silently admit the tool over MCP.
 *
 * `names` is that tool's forms, derived from its app + name exactly as
 * `tool-bridge` derives them (`toolPolicyNames`, or the registry walk the
 * callers already hold).
 *
 * The two always-appended meta tools are exempt and never reach here.
 */
export function isToolAllowedByAgentPolicy(
  policy: AgentToolPolicy,
  names: string | readonly string[],
): boolean {
  if (policy.agentMissing) return false
  const forms = typeof names === "string" ? [names] : names
  if (forms.some((n) => policy.toolDenylist.includes(n))) return false
  if (policy.toolAllowlist.length > 0 && !forms.some((n) => policy.toolAllowlist.includes(n))) {
    return false
  }
  return true
}

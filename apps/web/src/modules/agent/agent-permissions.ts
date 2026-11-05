// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * P4c-T36: the one place the web asks "may this viewer author things FOR this
 * agent", so the ownership tabs and the agent page answer it the same way.
 *
 * THE WEB NEVER RECOMPUTES ROW AUTHORITY. Whether an EXISTING skill or routine
 * may be edited is `canWrite`, which the API puts on every listed row (T32b):
 * A15 lives on the server and the client reads its answer. This helper covers
 * only the other half, the `New ...` actions, where there is no row yet to
 * carry an answer: an agents admin, or the OWNER of a personal agent.
 *
 * It is the same rule `AgentPage` calls `canAdminister`. The page passes its
 * own value down as `canCreate`; this module exists so a surface mounted
 * without the page (a test, a future embed) can derive it identically instead
 * of inventing a second rule.
 */

export interface AgentWriteSubject {
  kind?: "role" | "personal" | "system"
  /** Disclosed to the owner and to an admin; null/undefined otherwise. */
  ownerUserId?: string | null
}

export interface AgentWriteViewer {
  userId?: string | null
  /** `kernel:agents:admin`. */
  isAgentsAdmin: boolean
}

/**
 * May this viewer administer this agent, and so author skills and routines
 * owned by it? An admin always may. Otherwise only a PERSONAL agent's owner
 * does: a role agent's belongings are an admin's to author.
 */
export function canAdministerAgent(
  agent: AgentWriteSubject | null | undefined,
  viewer: AgentWriteViewer,
): boolean {
  if (!agent) return false
  if (viewer.isAgentsAdmin) return true
  if (agent.kind !== "personal") return false
  const me = viewer.userId
  if (!me) return false
  return agent.ownerUserId === me
}

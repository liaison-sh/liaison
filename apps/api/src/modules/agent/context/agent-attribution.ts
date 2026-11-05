// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHOSE WORDS A STORED MESSAGE IS.
//
// `kernel.messages` stores an agent row with the agent that wrote it
// (`author_agent_id`), but every renderer used to throw that away and emit a
// bare `role: "assistant"` message. In a room with one agent that is exactly
// right. In a room with two it is a lie: the running agent reads its
// colleague's answers, and its colleague's tool calls, as its own earlier
// turn. That is how an agent continues somebody else's topic and answers in
// another's name, and once a checkpoint is written over such a region the mix
// up outlives the raw tail.
//
// The rule lives here, in ONE place, because three renderers apply it (the
// turn's transcript, the brief extractor and the checkpoint writer) and a
// second copy of it would drift until one of the three told the truth.
import { eq } from "drizzle-orm"
import { withRlsContext } from "~/db/rls"
import { agents } from "~/db/schema/kernel"
import { rootLogger } from "~/lib/logger"

const log = rootLogger.child({ module: "agent-attribution" })

/** The label a colleague's row carries when the roster read gave none. */
export const UNKNOWN_AGENT_LABEL = "another agent"

/** How a colleague's message is attributed when it is replayed. */
export function foreignAgentLine(label: string, content: string): string {
  return `[${label}] ${content}`
}

/**
 * The metadata key stamped on a thread message a PERSON's external client (an
 * MCP connection bound to no agent, e.g. Claude Code) posted. The row is
 * agent-authored, attributed to "{User}'s agent" and never to the person, but
 * it is a REQUEST to whichever agent reads it: no in-app agent said it, so it is
 * never replayed as the reader's own prior speech, even when the row's
 * `author_agent_id` fell back to that reader (the requester's personal agent).
 */
export const EXTERNAL_CLIENT_POST_KEY = "externalClientPost"

/** The attributed label of an external-client row, or null for any other row. */
export function externalClientLabel(row: { metadata?: unknown }): string | null {
  const meta = row.metadata as Record<string, unknown> | null | undefined
  if (!meta || meta[EXTERNAL_CLIENT_POST_KEY] !== true) return null
  const label = typeof meta.agentAuthorLabel === "string" ? meta.agentAuthorLabel.trim() : ""
  return `${label || "The user's agent"}, writing from an external app`
}

/**
 * Whether a row is a REQUEST the reading agent answers: a person's own row, or
 * one their external client posted under their agent's name.
 */
export function isRequestRow(row: { authorType: string; metadata?: unknown }): boolean {
  return row.authorType === "user" || externalClientLabel(row) !== null
}

/**
 * The colleague that wrote this row, or null when the row is the running
 * agent's own speech (or carries no agent at all, which is every row written
 * before agents were named and every human row).
 */
export function foreignAuthorOf(
  row: { authorAgentId?: string | null },
  selfAgentId: string | null | undefined,
): string | null {
  if (selfAgentId == null || row.authorAgentId == null) return null
  return row.authorAgentId === selfAgentId ? null : row.authorAgentId
}

/**
 * Display label per live agent id. One privileged read: an agent may know its
 * colleagues' names whatever the reading member holds, and a handle carries no
 * scoped data of its own.
 */
export async function loadAgentLabels(orgId: string): Promise<Map<string, string>> {
  // kernel.agents is readable org wide under RLS (agents_select): an org-bound
  // system context reads this org's labels with no bypass.
  const rows = await withRlsContext({ actorType: "system", orgId, purpose: "job" }, (tx) =>
    tx
      .select({ id: agents.id, handle: agents.handle, displayName: agents.displayName })
      .from(agents)
      .where(eq(agents.orgId, orgId)),
  )
  return new Map(rows.map((r) => [r.id, r.displayName || r.handle || UNKNOWN_AGENT_LABEL]))
}

let labelLoader: (orgId: string) => Promise<Map<string, string>> = loadAgentLabels

/**
 * The labels a REGION actually needs, best effort.
 *
 * Two rules, both of them about not making a summary or an advance depend on
 * this read. A region whose every agent row is the running agent's own needs
 * NO read at all, which is every single agent thread, so the common case pays
 * nothing. And a read that fails costs the region its labels and nothing else:
 * the caller falls back to the generic label, because a checkpoint advance
 * that previously could not fail here must not start failing for a name.
 */
export async function labelsForRegion(
  orgId: string,
  rows: Array<{ authorAgentId?: string | null }>,
  selfAgentId: string | null | undefined,
): Promise<Map<string, string>> {
  const needed = rows.some((row) => foreignAuthorOf(row, selfAgentId) !== null)
  if (!needed) return new Map()
  try {
    return await labelLoader(orgId)
  } catch (err) {
    log.warn({ err, orgId }, "Agent labels could not be read, attributing generically")
    return new Map()
  }
}

/**
 * Test access to this module's private state, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const AgentAttributionTestAccess = {
  /** Counts the reads, or makes one fail. Call with no argument to restore. */
  setLabelLoader(fn?: (orgId: string) => Promise<Map<string, string>>): void {
    labelLoader = fn ?? loadAgentLabels
  },
}

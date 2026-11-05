// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE DISCOVERY WINDOW. A thread persists the deferred tools its agent has
// unlocked so a follow up turn keeps them callable, and every unlocked app pulls
// its FULL instruction guide into the cached system prefix. That set only ever
// grew: a personal agent's DM is one thread for the life of the account, so
// after a few days it carried 142 discoveries across every installed app and
// each step shipped 184 schemas and 48,000 tokens of app guides, four times
// the fresh thread cost. The history the model sees is bounded by the agent's
// checkpoint; the tools it is shown are bounded here by the same line. A tool
// stays loaded while the rows after the checkpoint still show it (the turn that
// unlocked it, or a call to it); anything older left the conversation with the
// rows that used it and is one cheap tool_search away.
//
// THE LAST TURNS ARE EVIDENCE WHATEVER THE COLUMN SAYS. The thread column is
// what the turn ENDED with, after the tool schema budget shed the tools it
// started over budget with. A tool a turn just used could be shed at the start
// of the next one, and the column then forgot it: the window above could no
// longer bring it back, and a conversation booking a shipment lost its
// shipping tools for good (a demo thread, live). The tools the last
// RECENT_TOOL_TURNS agent rows unlocked or called stay loaded, past the
// checkpoint boundary and whether or not the column still lists them, and how
// many turns ago each tool was last used is returned so the budget sheds the
// least recently useful first (turn-tool-budget.ts).
import { and, asc, eq, isNull } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { messages, threads } from "~/db/schema/kernel"
import { rootLogger } from "~/lib/logger"
import { loadCurrentCheckpoint } from "~/modules/agent/context/checkpoint"

const log = rootLogger.child({ module: "discovery-window" })

/** The metadata key an agent row carries the tools unlocked during ITS turn under. */
export const DISCOVERED_TOOLS_META_KEY = "discoveredTools"

/** How many of a thread's latest agent turns keep their tools loaded whatever else applies. */
export const RECENT_TOOL_TURNS = 3

interface EvidenceRow {
  metadata: unknown
}

/**
 * The tools a set of stored rows is evidence for: the names each agent row
 * recorded as unlocked in its turn, plus every tool it actually called. Rows
 * written before turns recorded their unlocks still count their calls.
 */
export function evidencedTools(rows: ReadonlyArray<EvidenceRow>): Set<string> {
  const out = new Set<string>()
  for (const row of rows) for (const n of rowEvidence(row)) out.add(n)
  return out
}

function rowEvidence(row: EvidenceRow): string[] {
  const meta = row.metadata as {
    discoveredTools?: unknown
    toolCalls?: Array<{ toolName?: unknown }>
  } | null
  const out: string[] = []
  if (Array.isArray(meta?.discoveredTools)) {
    for (const n of meta.discoveredTools) if (typeof n === "string") out.push(n)
  }
  if (Array.isArray(meta?.toolCalls)) {
    for (const c of meta.toolCalls) if (typeof c?.toolName === "string") out.push(c.toolName)
  }
  return out
}

/** The metadata key an agent row carries the tools its turn sent under, in the order sent. */
export const TOOL_ORDER_META_KEY = "toolOrder"

/**
 * The tool list the acting agent's own latest turn sent, in its order: its
 * next turn in the thread lists its tools in the same order, so a provider's
 * prompt cache still reads that list (orderStartingToolsFirst). Only rows the
 * same agent wrote count (`authorAgentId`): in a shared thread where two agents
 * take turns, each keeps its own list instead of taking the other's. A turn no
 * agent acts in (`agentId` null) reads the latest row whoever wrote it: its
 * reply is filed under a fallback agent (the person's own or the org's built-in
 * one, threads/message.ts), so no row of its own says null. Empty when no such
 * row recorded one.
 */
export function lastToolOrder(
  rows: ReadonlyArray<EvidenceRow & { authorAgentId?: string | null }>,
  agentId: string | null,
): string[] {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (agentId !== null && rows[i]?.authorAgentId !== agentId) continue
    const order = (rows[i]?.metadata as { toolOrder?: unknown } | null)?.toolOrder
    if (Array.isArray(order)) return order.filter((n): n is string => typeof n === "string")
  }
  return []
}

/**
 * How many agent turns ago each tool was last unlocked or called: 0 is the
 * latest row. `rows` is in conversation order, oldest first. A tool no row
 * shows is absent (never used).
 */
export function toolRecency(rows: ReadonlyArray<EvidenceRow>): Map<string, number> {
  const out = new Map<string, number>()
  for (let i = rows.length - 1; i >= 0; i--) {
    const turnsAgo = rows.length - 1 - i
    for (const n of rowEvidence(rows[i])) if (!out.has(n)) out.set(n, turnsAgo)
  }
  return out
}

/** The tools the last `turns` agent turns unlocked or called. */
export function recentTools(recency: ReadonlyMap<string, number>, turns = RECENT_TOOL_TURNS) {
  return new Set([...recency].filter(([, ago]) => ago < turns).map(([name]) => name))
}

/**
 * The persisted discoveries that the rows in the window still show. `null`
 * rows means no window could be established (callers pass the whole thread
 * when there is no boundary, so this is the escape hatch, not the norm) and
 * every persisted discovery stays.
 */
export function windowDiscoveries(
  persisted: Iterable<string>,
  rowsAfterBoundary: ReadonlyArray<EvidenceRow> | null,
): Set<string> {
  if (rowsAfterBoundary === null) return new Set(persisted)
  const evidence = evidencedTools(rowsAfterBoundary)
  const kept = new Set<string>()
  for (const name of persisted) if (evidence.has(name)) kept.add(name)
  return kept
}

/**
 * Load a thread's persisted discoveries windowed to the history the acting
 * agent sees: the rows after its checkpoint boundary, or the whole thread when
 * it has none. A name no stored turn unlocked or called is dropped; the turn
 * that needs it again is one tool_search away.
 */
export async function loadWindowedDiscoveries(params: {
  threadId: string
  orgId: string
  actor: UserContext
  agentId?: string | null
}): Promise<{
  discovered: Set<string>
  persisted: string[]
  recency: Map<string, number>
  /** The tools the acting agent's latest turn in the thread sent, in the order it sent them. */
  toolOrder: string[]
}> {
  const { threadId, orgId, actor, agentId } = params
  const row = await withPrivilegedDb(orgId, "agent-discovered-tools", async (tx) => {
    const [r] = await tx
      .select({ agentDiscoveredTools: threads.agentDiscoveredTools })
      .from(threads)
      .where(and(eq(threads.id, threadId), eq(threads.orgId, orgId)))
      .limit(1)
    return r
  })
  const persisted = (Array.isArray(row?.agentDiscoveredTools) ? row.agentDiscoveredTools : [])
    .filter((n): n is string => typeof n === "string")
    .sort()

  // The boundary is the acting agent's checkpoint. No agent, no checkpoint, a
  // stale checkpoint or a deleted boundary message all mean the whole thread
  // is the history the model sees, so the whole thread is the window.
  const checkpoint = agentId
    ? await loadCurrentCheckpoint({ agentId, threadId, orgId, actor })
    : null
  const boundaryId =
    checkpoint?.uptoMessageId && checkpoint.staleAt == null ? checkpoint.uptoMessageId : null

  const { rowsAfter, recency, toolOrder } = await withPrivilegedDb(
    orgId,
    "agent-discovery-window",
    async (tx) => {
      const [boundary] = boundaryId
        ? await tx
            .select({ createdAt: messages.createdAt })
            .from(messages)
            .where(and(eq(messages.id, boundaryId), eq(messages.orgId, orgId)))
            .limit(1)
        : [undefined]
      const rows = await tx
        .select({
          id: messages.id,
          createdAt: messages.createdAt,
          metadata: messages.metadata,
          authorAgentId: messages.authorAgentId,
        })
        .from(messages)
        .where(
          and(
            eq(messages.threadId, threadId),
            eq(messages.orgId, orgId),
            eq(messages.authorType, "agent"),
            isNull(messages.deletedAt),
          ),
        )
        .orderBy(asc(messages.createdAt), asc(messages.id))
      const recency = toolRecency(rows)
      const toolOrder = lastToolOrder(rows, agentId ?? null)
      if (!boundary || !boundaryId) return { rowsAfter: rows, recency, toolOrder }
      // Same (created_at, id) order the history tail is sliced on.
      return {
        rowsAfter: rows.filter(
          (r) =>
            r.createdAt > boundary.createdAt ||
            (r.createdAt.getTime() === boundary.createdAt.getTime() && r.id > boundaryId),
        ),
        recency,
        toolOrder,
      }
    },
  )

  const discovered = windowDiscoveries(persisted, rowsAfter)
  const windowedCount = discovered.size
  const revived: string[] = []
  for (const name of recentTools(recency)) {
    if (discovered.has(name)) continue
    discovered.add(name)
    if (!persisted.includes(name)) revived.push(name)
  }
  if (windowedCount < persisted.length || revived.length > 0) {
    log.info(
      {
        threadId,
        agentId,
        persisted: persisted.length,
        kept: discovered.size,
        expired: persisted.filter((n) => !discovered.has(n)),
        revived,
      },
      "agent_discoveries_windowed",
    )
  }
  return { discovered, persisted, recency, toolOrder }
}

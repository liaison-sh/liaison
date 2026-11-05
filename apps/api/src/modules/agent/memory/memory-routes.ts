// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Memory tab's read and write surface (batch C2 H1-H3, spec-memory.md
// "Human controls"). Three routes, mounted beside the composition API so they
// share its auth middleware:
//
//   GET   /api/agents/:agentId/memory/tree   kernel:agent:memory:read
//   GET   /api/agents/:agentId/memory/file   kernel:agent:memory:read
//   PATCH /api/agents/:agentId/memory/file   kernel:agent:memory:write
//   GET   /api/agents/:agentId/memory/search kernel:agent:memory:read
//   POST  /api/agents/:agentId/memory/forget kernel:agent:memory:write
//
// TWO GATES, DELIBERATELY. The scope on the route says "this caller may look at
// agent memory at all". WHOSE memory is a second question, answered per agent:
// a personal agent's tree belongs to its owner and to `kernel:agents:admin`,
// nobody else, and within a tree every row still goes through the verbs' own
// `filterByVisibility`, so a row whose `requiredScopes` the caller lacks is
// absent rather than redacted.
//
// THE WRITE IS THE VERBS' WRITE. `memoryWriteFile` is `rewriteFile` plus
// `memoryCreate`'s upsert, which is the same body every verb ends in: the index
// caps, the scope stamping and the `lastConfirmedAt` stamp are the ones the
// model's writes already obey. A second write path here would be a second set
// of rules to keep in step, which is how the caps quietly stop applying.

import { MEMORY_INDEX_PATH } from "@liaison/shared"
import { and, eq, inArray, isNull, or } from "drizzle-orm"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import type { AppEnv } from "~/app"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { agentMemory, agents, agentThreadCheckpoints, threads } from "~/db/schema/kernel"
import { success } from "~/lib/response"
import { requireScope } from "~/middleware/require-scope"
import {
  MEMORY_INDEX_MAX_LINES,
  MemoryIndexFullError,
  memoryIndexFill,
  memoryWriteFile,
} from "~/modules/agent/memory/memory"
import { pathForRow } from "~/modules/agent/memory/memory-tree"
import { writeAuditLog } from "~/modules/audit/service"
import { hasScope } from "~/modules/permissions/permissions"
import { filterByVisibility } from "~/services/security/visibility"

export const agentMemoryRoutes = new Hono<AppEnv>()

interface ResolvedAgent {
  id: string
  kind: string
  ownerUserId: string | null
}

/**
 * The agent this request is about, or a refusal. An agent of another org, an
 * absent one and an archived one are all the same 404: archived reads as
 * missing (the slice wide rule) and the route is not an existence oracle on
 * another org's agents. A personal agent that is not the caller's is 403, not
 * 404, because the roster already names it: pretending it does not exist would
 * be a lie the caller can disprove in one click.
 */
async function resolveAgent(
  c: {
    req: { param: (k: string) => string }
    get: (k: string) => unknown
  },
  access: "read" | "write" = "read",
): Promise<ResolvedAgent> {
  const orgId = c.get("orgId") as string
  const userId = c.get("userId") as string
  const scopes = (c.get("scopes") as string[]) ?? []
  const agentId = c.req.param("agentId")
  const [row] = await withSystemDb("agent-memory-route-agent", (tx) =>
    tx
      .select({
        id: agents.id,
        orgId: agents.orgId,
        kind: agents.kind,
        ownerUserId: agents.ownerUserId,
        archivedAt: agents.archivedAt,
      })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1),
  )
  if (!row || row.orgId !== orgId || row.archivedAt !== null) {
    throw new HTTPException(404, { message: "Not found" })
  }
  const isAdmin = hasScope("kernel:agents:admin", scopes)
  if (row.kind === "personal" && row.ownerUserId !== userId && !isAdmin) {
    throw new HTTPException(403, { message: "This agent's memory is private to its owner" })
  }
  if (access === "write") {
    // Writing (edit, forget) is narrower than reading. A personal agent's tree
    // is its owner's alone; a role or system agent's tree is shared by every
    // user it serves, so only an explicit agent admin may rewrite or erase it.
    // Members keep read access. The RLS write policies enforce the same rule
    // (migration 0147) so this is not the only gate.
    const allowed = row.kind === "personal" ? row.ownerUserId === userId : isAdmin
    if (!allowed) {
      throw new HTTPException(403, {
        message:
          row.kind === "personal"
            ? "Only the owner can change this agent's memory"
            : "Changing a shared agent's memory needs the agents admin scope",
      })
    }
  }
  return { id: row.id, kind: row.kind, ownerUserId: row.ownerUserId }
}

interface TreeRow {
  sourceThreadId: string | null
  type: string
  name: string
  path: string | null
  description: string
  content: string
  requiredScopes: string[]
  updatedAt: Date
  sourceKind: string
  threadHandle: string | null
}

/**
 * Every row of this agent's tree the caller may read. The owner filter matches
 * the verbs' own keying: the rekey moved ownership to `owner_agent_id`, and a
 * row written before the backfill still carries only the owning human's
 * `user_id`, so both are accepted and nothing else is.
 */
async function readTree(
  c: { get: (k: string) => unknown },
  agent: ResolvedAgent,
): Promise<TreeRow[]> {
  const orgId = c.get("orgId") as string
  const userId = c.get("userId") as string
  const scopes = (c.get("scopes") as string[]) ?? []
  const actor = {
    actorType: "user" as const,
    userId,
    orgId,
    scopes,
    dimensionGrants: (c.get("dimensionGrants") as Record<string, string[]>) ?? {},
  }
  const rows = await withRlsContext(actor, (tx) =>
    tx
      .select({
        type: agentMemory.type,
        name: agentMemory.name,
        path: agentMemory.path,
        description: agentMemory.description,
        content: agentMemory.content,
        requiredScopes: agentMemory.requiredScopes,
        updatedAt: agentMemory.updatedAt,
        sourceKind: agentMemory.sourceKind,
        sourceThreadId: agentMemory.sourceThreadId,
      })
      .from(agentMemory)
      .where(
        and(
          eq(agentMemory.orgId, orgId),
          agent.ownerUserId
            ? or(
                eq(agentMemory.ownerAgentId, agent.id),
                and(isNull(agentMemory.ownerAgentId), eq(agentMemory.userId, agent.ownerUserId)),
              )
            : eq(agentMemory.ownerAgentId, agent.id),
        ),
      ),
  )
  // The verbs' filter, not a second one: what the tab shows and what the agent
  // reads are the same set by construction.
  const visible = filterByVisibility(rows as Array<Omit<TreeRow, "threadHandle">>, {
    userId,
    grants: scopes,
  })
  // The provenance HANDLE, read privileged and only for rows that already
  // passed the filter above. It is not a second read of the thread: the caller
  // is reading a memory file they are entitled to, and the file says which
  // conversation it came from. Joining under the caller's own RLS answered null
  // for every thread the caller is not a member of, which is most of them for
  // an admin looking at somebody else's agent, and left the tab unable to group
  // episodes by conversation at all.
  const threadIds = [...new Set(visible.map((r) => r.sourceThreadId).filter(Boolean))] as string[]
  const handles = new Map<string, string>()
  if (threadIds.length > 0) {
    const rows = await withSystemDb("agent-memory-route-thread-handles", (tx) =>
      tx
        .select({ id: threads.id, handle: threads.handle })
        .from(threads)
        .where(and(eq(threads.orgId, orgId), inArray(threads.id, threadIds))),
    )
    for (const r of rows) handles.set(r.id, r.handle)
  }
  const files = visible.map((r) => ({
    ...r,
    threadHandle: r.sourceThreadId ? (handles.get(r.sourceThreadId) ?? null) : null,
  }))
  return [...files, ...(await readCheckpoints(agent, actor))]
}

/**
 * The Conversation summaries group: one row per thread, the CURRENT checkpoint
 * version, rendered as the `checkpoints/<thread handle>.md` file the tree and
 * the memory verbs already name (spec-memory.md L2: "Checkpoints (L4) are
 * `checkpoints/<thread-handle>.md` files, one per thread the agent has
 * checkpointed, readable in the tree and in the Memory tab").
 *
 * Not an `agent_memory` row, which is why the group was always empty: the rows
 * live in `kernel.agent_thread_checkpoints`, one immutable row per version.
 * Only the highest version of each thread is a file; an older version is
 * history, not a second file at the same path.
 *
 * TWO FILTERS, both the ones the rest of the tree uses. `requiredScopes` goes
 * through `filterByVisibility`, exactly as a memory row does. The THREAD goes
 * through the caller's own RLS: a checkpoint is one agent's summary of one
 * room, and a room the caller may not read is not a room they may read a
 * summary of. That is the one place this differs from an episode's provenance
 * handle, which is read privileged because the episode row itself is the thing
 * the caller is entitled to.
 *
 * The rows are read privileged because a checkpoint is the AGENT's row: it is
 * unreadable under a human's RLS session, so reading it as the human would
 * empty the group again for every caller.
 */
async function readCheckpoints(
  agent: ResolvedAgent,
  actor: {
    actorType: "user"
    userId: string
    orgId: string
    scopes: string[]
    dimensionGrants: Record<string, string[]>
  },
): Promise<TreeRow[]> {
  const rows = await withPrivilegedDb(actor.orgId, "agent-memory-route-checkpoints", (tx) =>
    tx
      .select({
        threadId: agentThreadCheckpoints.threadId,
        summary: agentThreadCheckpoints.summary,
        requiredScopes: agentThreadCheckpoints.requiredScopes,
        version: agentThreadCheckpoints.version,
        createdAt: agentThreadCheckpoints.createdAt,
      })
      .from(agentThreadCheckpoints)
      .where(
        and(
          eq(agentThreadCheckpoints.orgId, actor.orgId),
          eq(agentThreadCheckpoints.agentId, agent.id),
        ),
      ),
  )
  if (rows.length === 0) return []
  const latest = new Map<string, (typeof rows)[number]>()
  for (const row of rows) {
    const held = latest.get(row.threadId)
    if (!held || row.version > held.version) latest.set(row.threadId, row)
  }
  const visible = filterByVisibility([...latest.values()], {
    userId: actor.userId,
    grants: actor.scopes,
  })
  if (visible.length === 0) return []
  const readable = await withRlsContext(actor, (tx) =>
    tx
      .select({ id: threads.id, handle: threads.handle, title: threads.title })
      .from(threads)
      .where(
        and(
          eq(threads.orgId, actor.orgId),
          inArray(
            threads.id,
            visible.map((r) => r.threadId),
          ),
        ),
      ),
  )
  const byId = new Map(readable.map((t) => [t.id, t]))
  const files: TreeRow[] = []
  for (const row of visible) {
    const thread = byId.get(row.threadId)
    if (!thread) continue
    files.push({
      sourceThreadId: row.threadId,
      type: "checkpoint",
      // Named by the conversation: a summary is of a room, not of a slug.
      name: thread.title ?? thread.handle,
      path: `checkpoints/${thread.handle}.md`,
      description: "",
      content: row.summary,
      requiredScopes: row.requiredScopes,
      updatedAt: row.createdAt,
      // Written by consolidation, like an episode: never a human edit, which
      // is what the tab reads to keep the editor read only.
      sourceKind: "consolidation",
      threadHandle: thread.handle,
    })
  }
  return files
}

agentMemoryRoutes.get(
  "/:agentId/memory/tree",
  requireScope("kernel:agent:memory:read"),
  async (c) => {
    const agent = await resolveAgent(c)
    const rows = await readTree(c, agent)
    const indexRow = rows.find((r) => r.type === "_index")
    const fill = memoryIndexFill(indexRow?.content ?? "")
    // THE INDEX ROW IS A FILE, and the one a human is most likely to open. It
    // used to be read only for its fill and then dropped from the listing, so
    // the tab's Index group had nothing to list on an agent whose tree was
    // full. Its fill is a second claim ABOUT this file, not a substitute for
    // it, and `pathForRow` already gives it the `MEMORY.md` name the tab and
    // the memory verbs both use.
    return success(c, {
      files: rows
        .map((r) => ({
          path: pathForRow(r),
          name: r.name,
          description: r.description,
          type: r.type,
          modified: r.updatedAt.toISOString(),
          requiredScopes: r.requiredScopes,
          sourceKind: r.sourceKind,
          threadHandle: r.threadHandle,
        }))
        .sort((a, b) => a.path.localeCompare(b.path)),
      index: {
        lines: fill.lines,
        nearLimit: fill.nearLimit,
        full: fill.lines >= MEMORY_INDEX_MAX_LINES,
      },
    })
  },
)

agentMemoryRoutes.get(
  "/:agentId/memory/file",
  requireScope("kernel:agent:memory:read"),
  async (c) => {
    const agent = await resolveAgent(c)
    const path = c.req.query("path")
    if (!path) throw new HTTPException(400, { message: "path is required" })
    const rows = await readTree(c, agent)
    const row = rows.find((r) => pathForRow(r) === path)
    // Absent and invisible are the same answer: a 403 here would tell the
    // caller a file exists at a path they may not read.
    if (!row) throw new HTTPException(404, { message: "Not found" })
    return success(c, { path, content: row.content })
  },
)

agentMemoryRoutes.patch(
  "/:agentId/memory/file",
  requireScope("kernel:agent:memory:write"),
  async (c) => {
    const agent = await resolveAgent(c, "write")
    const body = (await c.req.json().catch(() => null)) as {
      path?: unknown
      content?: unknown
    } | null
    const path = typeof body?.path === "string" ? body.path : ""
    const content = typeof body?.content === "string" ? body.content : null
    if (!path || content === null) {
      throw new HTTPException(400, { message: "path and content are required" })
    }
    // Episodes and checkpoints are written by consolidation and rendered from
    // the transcript: editing one by hand would be editing a derivation, and
    // the next consolidation run would overwrite it anyway. Forget this
    // conversation is the control over those, not an edit box.
    if (path.startsWith("checkpoints/") || path.startsWith("episodes/")) {
      throw new HTTPException(409, {
        message: "This file is written by consolidation and cannot be edited here",
      })
    }
    if (path !== MEMORY_INDEX_PATH && !path.includes("/")) {
      throw new HTTPException(400, { message: "not a path inside this agent's memory tree" })
    }

    const orgId = c.get("orgId")
    const userId = c.get("userId")
    const scopes = (c.get("scopes") as string[]) ?? []
    const actor = {
      actorType: "user" as const,
      userId,
      orgId,
      scopes,
      dimensionGrants: c.get("dimensionGrants") ?? {},
    }
    try {
      await withRlsContext(actor, async (tx) => {
        // `sourceKind: "human"` is what stamps the row; `lastConfirmedAt` is
        // stamped by the shared write itself, as it is for every other write.
        //
        // THE TREE IS THE TARGET AGENT'S, THE CALLER IS THE EDITOR. `userId` is
        // who is writing (what the visibility filter answers against); the
        // OWNER of the rows is the agent in the URL, which is the same key the
        // tree route reads back. Resolving the owner from the caller instead
        // sent a role agent's edit into the editor's own personal tree, where
        // the tab could never show it again.
        const ctx = {
          userId,
          orgId,
          db: tx,
          scopes,
          sourceKind: "human" as const,
          ownerAgentId: agent.id,
          ownerLegacyUserId: agent.ownerUserId,
        } as never
        await memoryWriteFile({ path, content }, ctx)
        await writeAuditLog(tx, {
          orgId,
          actorId: userId,
          actorType: "user",
          app: "kernel",
          entityType: "agent_memory",
          entityId: agent.id,
          action: "memory_file_edited",
          agentId: agent.id,
          metadata: { path },
        })
      })
    } catch (err) {
      if (err instanceof MemoryIndexFullError) {
        return c.json({ error: { message: err.message, code: "memory_index_full" } }, 409)
      }
      throw err
    }
    return success(c, { path })
  },
)

// --- The search box and Forget this conversation (P4m-T31) -----------------
//
// The web app has no tool invoke surface, so REST is the only path to
// `memory_search` for a human. It is the SAME service the model calls, run with
// the CALLER's scopes and keyed on the agent in the URL, so the tab can never
// show a human a row the agent's own search would hide from them.

agentMemoryRoutes.get(
  "/:agentId/memory/search",
  requireScope("kernel:agent:memory:read"),
  async (c) => {
    const agent = await resolveAgent(c)
    const query = (c.req.query("q") ?? "").trim()
    if (!query) return success(c, { hits: [] })
    const rawLimit = Number.parseInt(c.req.query("limit") ?? "", 10)
    const orgId = c.get("orgId") as string
    const userId = c.get("userId") as string
    const scopes = (c.get("scopes") as string[]) ?? []
    const actor = {
      actorType: "user" as const,
      userId,
      orgId,
      scopes,
      dimensionGrants: (c.get("dimensionGrants") as Record<string, string[]>) ?? {},
    }
    const { memorySearch } = await import("~/modules/agent/memory/memory-search")
    const { hits } = await withRlsContext(actor, (tx) =>
      memorySearch(
        { query, ...(Number.isFinite(rawLimit) && rawLimit > 0 ? { limit: rawLimit } : {}) },
        {
          userId,
          orgId,
          db: tx,
          scopes,
          ownerAgentId: agent.id,
        } as never,
      ),
    )
    return success(c, { hits })
  },
)

/**
 * Forget one conversation. What goes is what the agent REMEMBERS about it: its
 * episode files for that thread and its checkpoint versions of it. The messages
 * stay, and so does every other agent's memory of the same room, which is the
 * whole point of per agent memory (invariant I5).
 *
 * Privileged deletes, after the route's own two gates. The rows belong to the
 * AGENT: a checkpoint is not readable or writable under the human's own RLS
 * session (it carries a thread membership predicate), and refusing the delete
 * because the admin is not in the room would leave the tab with a button that
 * does nothing.
 */
agentMemoryRoutes.post(
  "/:agentId/memory/forget",
  requireScope("kernel:agent:memory:write"),
  async (c) => {
    const agent = await resolveAgent(c, "write")
    const body = (await c.req.json().catch(() => null)) as { threadHandle?: unknown } | null
    const threadHandle = typeof body?.threadHandle === "string" ? body.threadHandle.trim() : ""
    if (!threadHandle) throw new HTTPException(400, { message: "threadHandle is required" })
    const orgId = c.get("orgId") as string
    const userId = c.get("userId") as string

    // The thread is looked up under the CALLER's RLS unless the caller is an
    // agent admin cleaning a shared agent: otherwise a handle probe would
    // confirm that a private thread exists. An admin may not be in the room,
    // which is the reason the delete below is privileged.
    const forgetScopes = (c.get("scopes") as string[]) ?? []
    const [thread] = hasScope("kernel:agents:admin", forgetScopes)
      ? await withSystemDb("agent-memory-route-forget-thread", (tx) =>
          tx
            .select({ id: threads.id })
            .from(threads)
            .where(and(eq(threads.orgId, orgId), eq(threads.handle, threadHandle)))
            .limit(1),
        )
      : await withRlsContext(
          {
            actorType: "user" as const,
            userId,
            orgId,
            scopes: forgetScopes,
            dimensionGrants: (c.get("dimensionGrants") as Record<string, string[]>) ?? {},
          },
          (tx) =>
            tx
              .select({ id: threads.id })
              .from(threads)
              .where(and(eq(threads.orgId, orgId), eq(threads.handle, threadHandle)))
              .limit(1),
        )
    if (!thread) throw new HTTPException(404, { message: "Not found" })

    const { episodesDeleted, checkpointsDeleted } = await withPrivilegedDb(
      orgId,
      "agent-memory-route-forget",
      async (tx) => {
        const episodes = await tx
          .delete(agentMemory)
          .where(
            and(
              eq(agentMemory.orgId, orgId),
              eq(agentMemory.ownerAgentId, agent.id),
              eq(agentMemory.type, "episode"),
              eq(agentMemory.sourceThreadId, thread.id),
            ),
          )
          .returning({ id: agentMemory.id })
        const checkpoints = await tx
          .delete(agentThreadCheckpoints)
          .where(
            and(
              eq(agentThreadCheckpoints.orgId, orgId),
              eq(agentThreadCheckpoints.agentId, agent.id),
              eq(agentThreadCheckpoints.threadId, thread.id),
            ),
          )
          .returning({ id: agentThreadCheckpoints.id })
        // The index line that pointed at the folder goes with it: a pointer to
        // a folder that no longer exists is a file the model cannot open.
        const [index] = await tx
          .select({
            id: agentMemory.id,
            content: agentMemory.content,
            requiredScopes: agentMemory.requiredScopes,
          })
          .from(agentMemory)
          .where(
            and(
              eq(agentMemory.orgId, orgId),
              eq(agentMemory.ownerAgentId, agent.id),
              eq(agentMemory.type, "_index"),
            ),
          )
          .limit(1)
        if (index) {
          const kept = index.content
            .split("\n")
            .filter((line) => !line.includes(`](episodes/${threadHandle}/`))
            .join("\n")
          if (kept !== index.content) {
            await tx
              .update(agentMemory)
              // THE TAG IS NAMED, and it is the row's OWN: this write only
              // REMOVES lines, so the index can never come to quote something
              // its tag does not already cover, and a forget must not widen it.
              .set({ content: kept, requiredScopes: index.requiredScopes, updatedAt: new Date() })
              .where(eq(agentMemory.id, index.id))
          }
        }
        await writeAuditLog(tx, {
          orgId,
          actorId: userId,
          actorType: "user",
          app: "kernel",
          entityType: "thread",
          entityId: thread.id,
          action: "memory_thread_forgotten",
          agentId: agent.id,
          metadata: {
            threadHandle,
            episodesDeleted: episodes.length,
            checkpointsDeleted: checkpoints.length,
          },
        })
        return { episodesDeleted: episodes.length, checkpointsDeleted: checkpoints.length }
      },
    )
    return success(c, { episodesDeleted, checkpointsDeleted })
  },
)

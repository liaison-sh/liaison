// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The agent activity factory: what the two record tabs of an agent's page
// read. Its knowledge pointers (the collections it is pointed at) and its
// activity timeline (`kernel.audit_log` rows filtered to the agent, in the
// closed list of actions the Activity route summarises).
//
// Privileged: neither table has a product write path a seeder could call.
// The audit writer runs inside the transaction of the thing being audited
// (an agent turn, a routine run, a sub run, a decided approval), which is
// history only time produces, so the timeline copies each real writer's row
// SHAPE per action. Both converge on a deterministic id (the tables have no
// natural key), so a re-seed rewrites its own rows and nothing else.
import { and, eq, inArray, sql } from "drizzle-orm"
import { knowledgeRel } from "~/apps/knowledge/schema-refs"
import { withPrivilegedDb } from "~/db/privileged"
import { agentKnowledgePointers } from "~/db/schema/kernel/agent-knowledge-pointers"
import { agentMemory } from "~/db/schema/kernel/agent-memory"
import { agentSkillIndex } from "~/db/schema/kernel/agent-skill-index"
import { auditLog } from "~/db/schema/kernel/audit-log"
import { routines } from "~/db/schema/kernel/routines"
import { skills } from "~/db/schema/kernel/skills"
import type { SeedContext } from "~/seed/context"

const HOUR_MS = 3_600_000

/** The org's live knowledge collections, by name. */
export async function knowledgeCollectionsByName(ctx: SeedContext): Promise<Map<string, string>> {
  const result = await withPrivilegedDb(ctx.orgId, "seed-knowledge-collections", (tx) =>
    tx.execute(sql`
      SELECT id, name FROM ${knowledgeRel("collections")}
      WHERE org_id = ${ctx.orgId}::uuid AND archived_at IS NULL
    `),
  )
  const rows = (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as {
    id: string
    name: string
  }[]
  return new Map(rows.map((r) => [r.name, r.id]))
}

/** Point an agent at a collection, `hoursAgo` before `ctx.now`. Returns the row id. */
export async function seedKnowledgePointer(
  ctx: SeedContext,
  input: { agentId: string; collectionId: string; hoursAgo: number },
): Promise<string> {
  const { agentId, collectionId } = input
  const id = ctx.id("agent-knowledge-pointer", `${agentId}:${collectionId}`)
  const createdAt = new Date(ctx.now.getTime() - input.hoursAgo * HOUR_MS)
  await withPrivilegedDb(ctx.orgId, "seed-knowledge-pointer", (tx) =>
    tx
      .insert(agentKnowledgePointers)
      .values({ id, orgId: ctx.orgId, agentId, collectionId, createdAt })
      .onConflictDoUpdate({
        target: agentKnowledgePointers.id,
        set: { agentId, collectionId, createdAt },
      }),
  )
  return id
}

export type ActivityAction =
  | "message.create"
  | "agent.local_session.reply"
  | "agent.local_session.turn"
  | "routine.status"
  | "routine.run_completed"
  | "sub_run.create"
  | "sub_run.update"
  | "memory_file_edited"
  | "memory_fact_written"
  | "memory_episode_written"
  | "approval_request.create"
  | "approval_request.update"

export interface ActivityRowSeed {
  /** Unique per agent: the row's deterministic id is derived from it. */
  key: string
  action: ActivityAction
  agentId: string
  /** The person a local session row or a memory edit is attributed to. */
  personUserId: string
  /** How long ago it happened, in hours before `ctx.now`. */
  hoursAgo: number
  threadId: string | null
  routineId: string | null
  /** Set on a `message.create` that is one agent asking another. */
  asks: { agentId: string; handle: string } | null
  subAgentType?: string
  memoryPath?: string
  factName?: string
}

/** One audit row, written or rewritten under its deterministic id. Returns the id. */
export async function seedActivityRow(ctx: SeedContext, row: ActivityRowSeed): Promise<string> {
  const id = ctx.id("agent-activity", `${row.agentId}:${row.key}`)
  const values = activityValues(ctx, id, row)
  await withPrivilegedDb(ctx.orgId, "seed-activity-row", (tx) =>
    tx
      .insert(auditLog)
      .values(values)
      .onConflictDoUpdate({
        target: auditLog.id,
        set: {
          timestamp: values.timestamp,
          actorId: values.actorId,
          actorType: values.actorType,
          app: values.app,
          entityType: values.entityType,
          entityId: values.entityId,
          action: values.action,
          changes: values.changes ?? null,
          metadata: values.metadata ?? null,
          agentId: values.agentId,
        },
      }),
  )
  return id
}

/**
 * What an agent layer actually landed, read back rather than counted from the
 * specs: the org's skills and skill index rows, its remembered conversations
 * (the Memory tab's own predicate: an `episode` row), its routines still off,
 * and how many of the given pointer and timeline ids exist.
 */
export async function agentLayerCounts(
  ctx: SeedContext,
  input: { pointerIds: string[]; activityIds: string[] },
): Promise<{
  skills: number
  skillIndexRows: number
  episodes: number
  routinesDisabled: number
  pointers: number
  activity: number
}> {
  const { orgId } = ctx
  return withPrivilegedDb(orgId, "seed-agent-layer-counts", async (tx) => {
    const count = async (q: Promise<unknown[]>) => (await q).length
    return {
      skills: await count(tx.select({ id: skills.id }).from(skills).where(eq(skills.orgId, orgId))),
      skillIndexRows: await count(
        tx.select().from(agentSkillIndex).where(eq(agentSkillIndex.orgId, orgId)),
      ),
      episodes: await count(
        tx
          .select({ id: agentMemory.id })
          .from(agentMemory)
          .where(and(eq(agentMemory.orgId, orgId), eq(agentMemory.type, "episode"))),
      ),
      routinesDisabled: await count(
        tx
          .select({ id: routines.id })
          .from(routines)
          .where(and(eq(routines.orgId, orgId), eq(routines.enabled, false))),
      ),
      pointers:
        input.pointerIds.length === 0
          ? 0
          : await count(
              tx
                .select({ id: agentKnowledgePointers.id })
                .from(agentKnowledgePointers)
                .where(
                  and(
                    eq(agentKnowledgePointers.orgId, orgId),
                    inArray(agentKnowledgePointers.id, input.pointerIds),
                  ),
                ),
            ),
      activity:
        input.activityIds.length === 0
          ? 0
          : await count(
              tx
                .select({ id: auditLog.id })
                .from(auditLog)
                .where(and(eq(auditLog.orgId, orgId), inArray(auditLog.id, input.activityIds))),
            ),
    }
  })
}

/**
 * One audit row, in the shape its REAL writer writes. The three shapes the
 * route finds a conversation in are each used by the writer that really uses
 * it, and nothing else is invented.
 */
function activityValues(
  ctx: SeedContext,
  id: string,
  row: ActivityRowSeed,
): typeof auditLog.$inferInsert {
  const { threadId } = row
  const base = {
    id,
    orgId: ctx.orgId,
    timestamp: new Date(ctx.now.getTime() - row.hoursAgo * HOUR_MS),
    app: "kernel",
    agentId: row.agentId,
  }
  const entityId = (kind: string) => ctx.id(kind, `${row.agentId}:${row.key}`)

  switch (row.action) {
    // Event sourced, through the audit consumer: the event's own data lands in
    // `changes`, which is where the thread and the mentions are.
    case "message.create":
    case "approval_request.create":
    case "approval_request.update": {
      const changes: Record<string, unknown> = {}
      if (threadId) changes.threadId = threadId
      if (row.asks) {
        changes.mentions = [{ type: "agent", id: row.asks.agentId, handle: row.asks.handle }]
      }
      return {
        ...base,
        actorType: "agent",
        actorId: row.agentId,
        entityType: row.action === "message.create" ? "message" : "approval_request",
        entityId: entityId(
          row.action === "message.create" ? "activity-message" : "activity-approval",
        ),
        action: row.action,
        changes,
      }
    }
    // The local session routes: the machine the turn ran on posts it, as the
    // person, and stamps `runLocation` on every row.
    case "agent.local_session.turn":
    case "agent.local_session.reply":
      return {
        ...base,
        actorType: row.action === "agent.local_session.reply" ? "agent" : "user",
        actorId: row.personUserId,
        entityType: row.action === "agent.local_session.reply" ? "message" : "agent_local_session",
        entityId: entityId("activity-local-session"),
        action: row.action,
        metadata: {
          sessionId: entityId("activity-local-session-id"),
          ...(threadId ? { threadId } : {}),
          runLocation: "local",
        },
      }
    // A routine tick belongs to the routine, and to no conversation.
    case "routine.status":
    case "routine.run_completed":
      return {
        ...base,
        actorType: "system",
        actorId: null,
        entityType: "routine",
        entityId: row.routineId,
        action: row.action,
        metadata: { routineId: row.routineId },
      }
    case "sub_run.create":
    case "sub_run.update":
      return {
        ...base,
        actorType: "agent",
        actorId: row.agentId,
        entityType: "sub_run",
        entityId: entityId("activity-sub-run"),
        action: row.action,
        metadata: { agentType: row.subAgentType ?? null },
      }
    // The consolidation writer files a fact and an episode against the THREAD
    // they were learned in, which is the route's first shape.
    case "memory_fact_written":
    case "memory_episode_written":
      return {
        ...base,
        actorType: "system",
        actorId: null,
        entityType: "thread",
        entityId: threadId,
        action: row.action,
        metadata: { ...(row.factName ? { name: row.factName } : {}), jobId: null },
      }
    // A person editing a memory file: the agent's own row, no conversation.
    case "memory_file_edited":
      return {
        ...base,
        actorType: "user",
        actorId: row.personUserId,
        entityType: "agent_memory",
        entityId: row.agentId,
        action: row.action,
        metadata: { path: row.memoryPath ?? "MEMORY.md" },
      }
  }
}

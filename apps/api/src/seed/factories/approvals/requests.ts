// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The approval requests factory: gated tool calls in a conversation, pending
// or already decided, with whom each notifies, and the titled conversation a
// request can be staged in. The one approval writer every tier uses.
//
// The ONLY real creation path for an approval is a gated tool call through
// `executeTool`, which needs the whole agent runtime and tool registry booted,
// and a decided one is history only time produces. So the rows are written
// directly (`seedApprovalRequests`, privileged, category HISTORY: the requests
// an agent turn left behind and the decisions taken on them), Drizzle on the
// kernel table with the columns the runtime writes, keyed on a deterministic id.
//
// Who may be notified is decided by reads under each person's own RLS
// context (`ticketReadableBy`), never the privileged one. The conversation a
// request hangs off is created through the kernel's own thread service.
import { and, eq, isNotNull, sql } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { approvalRequests } from "~/db/schema/kernel/agent-memory"
import { contacts } from "~/db/schema/kernel/contacts"
import { skills } from "~/db/schema/kernel/skills"
import { threads } from "~/db/schema/kernel/threads"
import { schemaRef } from "~/db/schema-ref"
import { SEEDED_METADATA } from "~/modules/notifications/seeded"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { createThread } from "~/modules/threads/thread"
import type { SeedContext } from "~/seed/context"
import { asUser, rowsOf } from "~/seed/factories/people/actors"

/**
 * Whether `actor` can open the ticket, read through their own RLS exactly as
 * the product reads it: role scopes AND the ticket's team and sensitivity
 * dimensions.
 */
export async function ticketReadableBy(actor: UserContext, ticketId: string): Promise<boolean> {
  return asUser(actor, async (tx) => {
    const rows = rowsOf<{ id: string }>(
      await tx.execute(
        sql`SELECT id FROM ${sql.raw(schemaRef("app_tickets"))}.tickets WHERE id = ${ticketId}::uuid LIMIT 1`,
      ),
    )
    return rows.length > 0
  })
}

/** The ids an approval payload may name: skills by name, contacts by lower-cased email. */
export async function approvalLookups(
  ctx: SeedContext,
): Promise<{ skillIdByName: Map<string, string>; contactIdByEmail: Map<string, string> }> {
  return withPrivilegedDb(ctx.orgId, "seed-approvals:lookups", async (tx) => {
    const skillRows = await tx
      .select({ id: skills.id, name: skills.name })
      .from(skills)
      .where(eq(skills.orgId, ctx.orgId))
    const contactRows = await tx
      .select({ id: contacts.id, email: sql<string>`lower(${contacts.email})` })
      .from(contacts)
      .where(and(eq(contacts.orgId, ctx.orgId), isNotNull(contacts.email)))
    return {
      skillIdByName: new Map(skillRows.map((r) => [r.name, r.id])),
      contactIdByEmail: new Map(contactRows.map((r) => [r.email, r.id])),
    }
  })
}

/** The kernel's default lifetime of a gated call's approval (execute-tool.ts). */
export const APPROVAL_EXPIRY_HOURS = 168

export interface ApprovalRequestSeed {
  /** Deterministic: a re-run lands on the row it wrote last time. */
  id: string
  handle: string
  /** The conversation the card shows in. */
  threadId: string
  /** The conversation the gated call was made in, when it is another one. */
  originatingThreadId?: string
  toolName: string
  payload: unknown
  /** The person whose turn made the call. */
  requestedBy: string
  /** The agent whose turn proposed it; null for a call made from a person's own surface. */
  agentId: string | null
  notifyUserIds: readonly string[]
  /** People a row an earlier seed wrote must stop notifying. */
  droppedUserIds?: readonly string[]
  status: "pending" | "approved" | "denied"
  reason?: string | null
  decidedBy?: string | null
  decidedAt?: Date | null
  createdAt: Date
  /**
   * When the request lapses. Left out, the kernel's default lifetime from
   * when it was staged, as the runtime writes it; a pending request then
   * never lapses before the database's clock says it was written, so a seed
   * against a fixed clock in the past still leaves it awaiting a decision.
   * Given, a lifetime the tool declares (or a request already lapsed).
   */
  expiresAt?: Date
  bundleId?: string | null
  bundlePosition?: number | null
  metadata?: Record<string, unknown>
}

function expiresAtOf(r: ApprovalRequestSeed) {
  if (r.expiresAt) return r.expiresAt
  const staged = r.createdAt.toISOString()
  return r.status === "pending"
    ? sql`GREATEST(${staged}::timestamptz, now()) + make_interval(hours => ${APPROVAL_EXPIRY_HOURS})`
    : sql`${staged}::timestamptz + make_interval(hours => ${APPROVAL_EXPIRY_HOURS})`
}

const uuidArray = (ids: readonly string[]) =>
  ids.length > 0
    ? sql`ARRAY[${sql.join(
        ids.map((v) => sql`${v}::uuid`),
        sql`, `,
      )}]::uuid[]`
    : sql`'{}'::uuid[]`

/**
 * HISTORY: write each request in one privileged transaction, the columns the
 * runtime writes when it parks a gated call (and, for a decided one, what the
 * decision adds). A row an earlier seed wrote keeps everyone else it notifies
 * and loses only `droppedUserIds`; its payload is brought to the current one
 * unless somebody edited it on the card since. A seed's approval notifies
 * nobody (notifications/seeded.ts) unless `seeded: false`: a world whose
 * readers expect the feed rows a live request raises (the standard tier).
 */
export async function seedApprovalRequests(
  ctx: SeedContext,
  rows: readonly ApprovalRequestSeed[],
  opts: { seeded?: boolean } = {},
): Promise<string[]> {
  const marker = opts.seeded === false ? {} : SEEDED_METADATA
  const { orgId } = ctx
  if (rows.length === 0) return []
  await withPrivilegedDb(orgId, "seed-approvals:write", async (tx) => {
    for (const r of rows) {
      const payload = JSON.parse(JSON.stringify(r.payload ?? {}))
      await tx
        .insert(approvalRequests)
        .values({
          id: r.id,
          orgId,
          handle: r.handle,
          threadId: r.threadId,
          originatingThreadId: r.originatingThreadId ?? r.threadId,
          toolName: r.toolName,
          toolParams: payload,
          currentPayload: payload,
          expiresAt: expiresAtOf(r),
          notifyUserIds: [...r.notifyUserIds],
          requestedBy: r.requestedBy,
          agentId: r.agentId,
          status: r.status,
          reason: r.reason ?? null,
          decidedBy: r.decidedBy ?? null,
          decidedAt: r.decidedAt ?? null,
          bundleId: r.bundleId ?? null,
          bundlePosition: r.bundlePosition ?? null,
          metadata: { ...(r.metadata ?? {}), ...marker },
          createdAt: r.createdAt,
        })
        .onConflictDoUpdate({
          target: approvalRequests.id,
          set: {
            notifyUserIds: sql`ARRAY(
              SELECT u FROM unnest(${approvalRequests.notifyUserIds}) AS u
              WHERE NOT (u = ANY(${uuidArray(r.droppedUserIds ?? [])}))
            )`,
            toolName: sql`excluded.tool_name`,
            currentPayload: sql`CASE
              WHEN ${approvalRequests.currentPayload} = ${approvalRequests.toolParams}
              THEN excluded.current_payload
              ELSE ${approvalRequests.currentPayload}
            END`,
            toolParams: sql`excluded.tool_params`,
            metadata: sql`${approvalRequests.metadata} || excluded.metadata`,
          },
        })
    }
  })
  return rows.map((r) => r.id)
}

/**
 * The database's clock, for a request written when a person acts (a scenario
 * they start): the write time, read where every other write time comes from.
 */
export async function databaseNow(orgId: string): Promise<Date> {
  const [row] = await withPrivilegedDb(orgId, "seed-approvals:now", async (tx) =>
    rowsOf<{ now: string | Date }>(await tx.execute(sql`SELECT now() AS now`)),
  )
  if (!row) throw new Error("approvals seed: the database returned no time")
  return new Date(row.now)
}

/**
 * The conversation titled `title` that `userId` is in, created through the
 * thread service as that person when the org has none by that title yet.
 * Found again by its title, so a re-run adopts it.
 */
export async function findOrCreateTitledThread(
  ctx: SeedContext,
  userId: string,
  title: string,
): Promise<string> {
  const { orgId } = ctx
  const perms = await withPrivilegedDb(orgId, "seed-titled-thread-actor", (tx) =>
    loadEffectivePermissions(tx, userId, orgId),
  )
  return withRlsContext(
    {
      actorType: "user",
      userId,
      orgId,
      scopes: perms.scopes,
      dimensionGrants: perms.dimensionGrants,
      roles: perms.roles,
    },
    async (tx) => {
      const [existing] = await tx
        .select({ id: threads.id })
        .from(threads)
        .where(and(eq(threads.orgId, orgId), eq(threads.title, title)))
        .limit(1)
      if (existing) return existing.id
      const created = await createThread(tx as never, {
        orgId,
        userId,
        participantIds: [userId],
        title,
        // The title lookup above is what keeps this idempotent; this only stops
        // the titled-thread guard refusing a second room for the same people.
        forceCreate: true,
      })
      return created.id as string
    },
  )
}

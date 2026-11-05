// SPDX-License-Identifier: FSL-1.1-ALv2
// Regression: tickets:search gained a `sort` param (oldest/newest/recently_updated)
// + an assigneeName enrichment, and backlogHealth.oldest gained assigneeName — the
// affordances that turn the "10 oldest still-open tickets, how long open, what
// state they're stuck in, and who owns them" backlog-burndown read
// (modular-expo-backlog-burndown-digest) from a bounded best-effort into a clean
// one-call works_today. WITHOUT sort='oldest' the default order is recency, not
// age, so the agent cannot get the GLOBAL N oldest in one bounded call; WITHOUT
// assigneeName the owner is an opaque UUID. Both are asserted fails-without /
// passes-with here.
import { beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { backlogHealth } from "~/apps/tickets/backlog-health"
import { searchTickets } from "~/apps/tickets/search"
import { withSystemDb } from "~/db/privileged"
import type { ActorContext } from "~/db/rls"
import { executeTool } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"

let orgId: string
let userId: string
let liamId: string
let sofiaId: string
let inboxId: string
let actor: ActorContext

function rows<T>(r: unknown): T[] {
  const x = r as { rows?: T[] } & T[]
  return x.rows ?? x
}

/** Seed one OPEN ticket created `daysAgo` ago, optionally assigned. Returns its id. */
async function seedTicket(
  daysAgo: number,
  assignedTo: string | null,
  subject: string,
): Promise<string> {
  const id = crypto.randomUUID()
  const handle = `so-${Math.floor(Math.random() * 1e12)}`
  const replyToken = `SO${Math.floor(Math.random() * 1e16)}`
  await withSystemDb("sort-oldest-seed", async (tx) => {
    await tx.execute(drizzleSql`
      INSERT INTO app_tickets.tickets (
        id, org_id, handle, subject, status, priority, channel, sensitivity,
        reply_token, sla_target_seconds, sla_deadline,
        sla_active_started_at, sla_elapsed_seconds, message_count,
        source_inbox_id, assigned_to, last_inbound_at, last_message_at, created_at, updated_at
      ) VALUES (
        ${id}, ${orgId}, ${handle}, ${subject}, 'open', 'normal', 'manual', 'internal',
        ${replyToken}, 14400, now() + interval '1 hour',
        now() - (${daysAgo} * interval '1 day'), 0, 1, ${inboxId}, ${assignedTo},
        -- last_message_at tracks created_at, so the DEFAULT (last_message_at DESC =
        -- recency) order puts the NEWEST-created ticket first — the OPPOSITE of an age
        -- sort. That proves sort='oldest' genuinely re-orders by created_at, not recency.
        now() - (${daysAgo} * interval '1 day'),
        now() - (${daysAgo} * interval '1 day'),
        now() - (${daysAgo} * interval '1 day'), now()
      )
    `)
  })
  return id
}

beforeAll(async () => {
  const slug = `sort-oldest-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await withSystemDb("sort-oldest-fixture", async (tx) => {
    orgId = rows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.organizations (id, name, slug)
        VALUES (gen_random_uuid(), 'Sort Oldest', ${slug}) RETURNING id`),
    )[0]!.id
    userId = rows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
        VALUES (gen_random_uuid(), ${orgId}, ${`u-${slug}@test.com`}, 'Caller', 'active', 'h', 1, 1) RETURNING id`),
    )[0]!.id
    liamId = rows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
        VALUES (gen_random_uuid(), ${orgId}, ${`liam-${slug}@test.com`}, 'Liam Support', 'active', 'h', 1, 1) RETURNING id`),
    )[0]!.id
    sofiaId = rows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
        VALUES (gen_random_uuid(), ${orgId}, ${`sofia-${slug}@test.com`}, 'Sofia Support', 'active', 'h', 1, 1) RETURNING id`),
    )[0]!.id
    inboxId = rows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO app_tickets.inboxes (id, org_id, connected_account_id, name, email_address, default_sensitivity, is_default_for_create, created_at, updated_at)
        VALUES (gen_random_uuid(), ${orgId}, gen_random_uuid(), 'Inbox', ${`in-${slug}@x.test`}, 'internal', true, now(), now()) RETURNING id`),
    )[0]!.id
  })
  await ensureAppsForOrg(orgId, {})
  actor = {
    actorType: "user",
    userId,
    orgId,
    scopes: ["tickets:tickets:read"],
    dimensionGrants: { team: ["*"], sensitivity: ["restricted"] },
  } as ActorContext

  // Oldest → newest. The oldest two are assigned (Liam, Sofia); the newest is unassigned.
  await seedTicket(80, liamId, "Oldest — Liam owns it")
  await seedTicket(60, sofiaId, "Second oldest — Sofia owns it")
  await seedTicket(40, liamId, "Third oldest — Liam")
  await seedTicket(20, null, "Newest — unassigned")
})

describe("tickets:search sort='oldest' + assigneeName enrichment", () => {
  it("sort='oldest' orders by created_at ASC (the actual oldest first), NOT by recency", async () => {
    await withSystemDb("sort-oldest-run", async (tx) => {
      const res = await searchTickets(tx as never, orgId, {
        smartFilter: "all-open",
        sort: "oldest",
        limit: 10,
      } as never)
      const subjects = res.items.map((r) => String((r as { subject: string }).subject))
      // Oldest-first: the 80-day ticket comes first, the 20-day ticket last.
      expect(subjects[0]).toContain("Oldest")
      expect(subjects[1]).toContain("Second oldest")
      expect(subjects[2]).toContain("Third oldest")
      expect(subjects[3]).toContain("Newest")
    })
  })

  it("the DEFAULT (no sort) is recency, the OPPOSITE order — proving sort='oldest' is load-bearing", async () => {
    await withSystemDb("sort-default-run", async (tx) => {
      const res = await searchTickets(tx as never, orgId, {
        smartFilter: "all-open",
        limit: 10,
      } as never)
      const subjects = res.items.map((r) => String((r as { subject: string }).subject))
      // last_message_at is inverted vs created_at in the seed, so recency order puts the
      // NEWEST-created (most-recent activity) first — the opposite of oldest. If the agent
      // presented this page as "the oldest", it would be wrong; that is the affordance gap.
      expect(subjects[0]).not.toContain("Oldest")
    })
  })

  it("every search row carries assigneeName (the owner) resolved from assigned_to", async () => {
    await withSystemDb("sort-oldest-assignee", async (tx) => {
      const res = await searchTickets(tx as never, orgId, {
        smartFilter: "all-open",
        sort: "oldest",
        limit: 10,
      } as never)
      const bySubject = (needle: string) =>
        res.items.find((r) => String((r as { subject: string }).subject).includes(needle)) as
          | Record<string, unknown>
          | undefined
      expect(bySubject("Oldest")?.assignee_name).toBe("Liam Support")
      expect(bySubject("Second oldest")?.assignee_name).toBe("Sofia Support")
      // Unassigned ticket → null name (not a fabricated owner).
      expect(bySubject("Newest")?.assignee_name ?? null).toBeNull()
    })
  })

  it("surfaces sort='oldest' + camelCase assigneeName through the tickets:search tool (manifest → rpc bridge)", async () => {
    const out = await executeTool({
      toolName: "tickets:search",
      orgId,
      actor,
      params: { smartFilter: "all-open", sort: "oldest", limit: 10 },
    })
    const data = out.data as {
      items: Array<{
        subject: string
        createdAt: string | null
        status: string
        assigneeName: string | null
      }>
    }
    expect(data.items[0]!.subject).toContain("Oldest")
    expect(data.items[0]!.assigneeName).toBe("Liam Support")
    expect(data.items[0]!.createdAt).not.toBeNull()
    expect(data.items[0]!.status).toBe("open")
  })

  it("backlogHealth.oldest carries assigneeName (the owner) alongside ageDays + status", async () => {
    await withSystemDb("sort-oldest-backlog", async (tx) => {
      const res = await backlogHealth(tx as never, orgId, {})
      if ("error" in res) throw new Error(`unexpected error: ${res.error.message}`)
      const top = res.oldest[0]!
      expect(top.subject).toContain("Oldest")
      expect(top.assigneeName).toBe("Liam Support")
      expect(top.ageDays).toBeGreaterThanOrEqual(79)
      expect(top.status).toBe("open")
      // Oldest-first ordering by created_at.
      expect(res.oldest[1]!.assigneeName).toBe("Sofia Support")
    })
  })
})

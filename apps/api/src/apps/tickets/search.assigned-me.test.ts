// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Regression: tickets:search `assignedTo:'me'` self-sentinel resolution.
//
// The tickets manifest documents `assignedTo: "User UUID, or 'me' for the calling user"`, but the
// search handler previously filtered `assigned_to = 'me'` LITERALLY — so an agent that followed the
// documented contract (or a routine tick running AS a user that does not know its own UUID) got an
// EMPTY result and reported "you have no assigned tickets" on a NON-EMPTY queue. That false-empty was
// caught by the liam-weekly-eu-language-backlog-routine BL-275 runtime gate (the tick searched its own
// queue, passed 'me' / a hallucinated UUID, and got nothing). These tests pin that `'me'`/`'self'`/
// `'@me'` resolve to the actor's userId (so the documented contract holds), that the resolution is
// scoped to the actor (a teammate's tickets are excluded), and that an unresolvable self-sentinel
// (no actor context) returns EMPTY — never a silent whole-org read.
import { beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { searchTickets } from "~/apps/tickets/search"
import { withSystemDb } from "~/db/privileged"

let orgId: string
let meId: string
let otherId: string
let inboxId: string

async function seedTicket(assignedTo: string | null): Promise<string> {
  const id = crypto.randomUUID()
  const handle = `am-${Math.floor(Math.random() * 1e12)}`
  const replyToken = `RT${Math.floor(Math.random() * 1e16)}`
  await withSystemDb("search-assigned-me-seed", async (tx) => {
    await tx.execute(drizzleSql`
      INSERT INTO app_tickets.tickets (
        id, org_id, handle, subject, status, priority, channel, sensitivity,
        reply_token, sla_target_seconds, sla_deadline,
        sla_active_started_at, sla_elapsed_seconds, message_count,
        source_inbox_id, assigned_to, last_inbound_at, last_message_at, created_at, updated_at
      ) VALUES (
        ${id}, ${orgId}, ${handle}, 'Assigned-me test', 'open', 'normal', 'manual', 'internal',
        ${replyToken}, 3600, now() + interval '1 hour',
        now(), 0, 1, ${inboxId}, ${assignedTo}, now() - interval '5 minutes',
        now() - interval '5 minutes', now(), now()
      )
    `)
  })
  return id
}

beforeAll(async () => {
  const slug = `search-assigned-me-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await withSystemDb("search-assigned-me-fixture", async (tx) => {
    const orgRows = (await tx.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Search Assigned Me', ${slug}) RETURNING id
    `)) as unknown as { rows?: { id: string }[] } & { id: string }[]
    orgId = (orgRows.rows ?? orgRows)[0]!.id
    const me = (await tx.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}, ${`me-${slug}@test.com`}, 'Me', 'active', 'h', 1, 1) RETURNING id
    `)) as unknown as { rows?: { id: string }[] } & { id: string }[]
    meId = (me.rows ?? me)[0]!.id
    const other = (await tx.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}, ${`other-${slug}@test.com`}, 'Other', 'active', 'h', 1, 1) RETURNING id
    `)) as unknown as { rows?: { id: string }[] } & { id: string }[]
    otherId = (other.rows ?? other)[0]!.id
    const inboxRows = (await tx.execute(drizzleSql`
      INSERT INTO app_tickets.inboxes (id, org_id, connected_account_id, name, email_address, default_sensitivity, is_default_for_create, created_at, updated_at)
      VALUES (gen_random_uuid(), ${orgId}, gen_random_uuid(), 'Inbox', ${`in-${slug}@x.test`}, 'internal', true, now(), now()) RETURNING id
    `)) as unknown as { rows?: { id: string }[] } & { id: string }[]
    inboxId = (inboxRows.rows ?? inboxRows)[0]!.id
  })

  // 3 OPEN tickets assigned to ME, 2 to a teammate.
  for (let i = 0; i < 3; i++) await seedTicket(meId)
  for (let i = 0; i < 2; i++) await seedTicket(otherId)
  // One awaiting_customer + one CLOSED ticket assigned to ME, for the my-backlog scope test
  // (my-backlog = my NON-CLOSED set: includes awaiting_customer, EXCLUDES closed).
  await seedTicketStatus(meId, "awaiting_customer")
  await seedTicketStatus(meId, "closed")
})

async function seedTicketStatus(assignedTo: string, status: string): Promise<void> {
  const id = crypto.randomUUID()
  const handle = `ams-${Math.floor(Math.random() * 1e12)}`
  const replyToken = `RT${Math.floor(Math.random() * 1e16)}`
  await withSystemDb("search-assigned-me-status-seed", async (tx) => {
    await tx.execute(drizzleSql`
      INSERT INTO app_tickets.tickets (
        id, org_id, handle, subject, status, priority, channel, sensitivity,
        reply_token, sla_target_seconds, sla_deadline,
        sla_active_started_at, sla_elapsed_seconds, message_count,
        source_inbox_id, assigned_to, last_inbound_at, last_message_at, created_at, updated_at
      ) VALUES (
        ${id}, ${orgId}, ${handle}, 'Assigned-me status test', ${status}, 'normal', 'manual', 'internal',
        ${replyToken}, 3600, now() + interval '1 hour',
        now(), 0, 1, ${inboxId}, ${assignedTo}, now() - interval '5 minutes',
        now() - interval '5 minutes', now(), now()
      )
    `)
  })
}

describe("searchTickets — assignedTo:'me' self-sentinel resolution", () => {
  it("resolves assignedTo:'me' to the actor's userId (returns the actor's tickets, not the whole org)", async () => {
    await withSystemDb("search-assigned-me-run", async (tx) => {
      const res = await searchTickets(tx as never, orgId, {
        assignedTo: "me",
        actorUserId: meId,
        limit: 50,
      } as never)
      // ME has 5 tickets total (3 open + 1 awaiting_customer + 1 closed). assignedTo:'me' (no status
      // filter) returns all 5 — the teammate's 2 are excluded.
      expect(res.totalCount).toBe(5)
      // Every returned row is assigned to ME — the teammate's tickets are excluded.
      for (const row of res.items) {
        expect(String((row as Record<string, unknown>).assigned_to)).toBe(meId)
      }
    })
  })

  it("WITHOUT the literal-'me' bug a passed 'me' no longer matches NOTHING on a non-empty queue", async () => {
    // The pre-fix behavior filtered assigned_to = 'me' literally → 0 rows. Assert the actor's tickets are
    // found (the false-empty the routine gate caught is gone).
    await withSystemDb("search-assigned-me-nonzero", async (tx) => {
      const res = await searchTickets(tx as never, orgId, {
        assignedTo: "me",
        actorUserId: meId,
      } as never)
      expect(res.totalCount).toBeGreaterThan(0)
    })
  })

  it("'self' and '@me' resolve the same way (documented self-sentinel aliases)", async () => {
    await withSystemDb("search-assigned-me-aliases", async (tx) => {
      for (const sentinel of ["self", "@me", "ME"]) {
        const res = await searchTickets(tx as never, orgId, {
          assignedTo: sentinel,
          actorUserId: meId,
        } as never)
        expect(res.totalCount, `sentinel ${sentinel}`).toBe(5)
      }
    })
  })

  it("a literal UUID still filters by that exact user (no over-eager sentinel match)", async () => {
    await withSystemDb("search-assigned-me-uuid", async (tx) => {
      const res = await searchTickets(tx as never, orgId, {
        assignedTo: otherId,
        actorUserId: meId,
      } as never)
      expect(res.totalCount).toBe(2)
      for (const row of res.items) {
        expect(String((row as Record<string, unknown>).assigned_to)).toBe(otherId)
      }
    })
  })

  it("an unresolvable self-sentinel (no actor context) returns EMPTY — never a silent whole-org read", async () => {
    await withSystemDb("search-assigned-me-noactor", async (tx) => {
      const res = await searchTickets(tx as never, orgId, {
        assignedTo: "me",
        // no actorUserId
      } as never)
      // Must NOT fall through to the whole-org backlog (5 tickets); resolves to an impossible id.
      expect(res.totalCount).toBe(0)
    })
  })
})

describe("searchTickets — smartFilter:'my-backlog' (the one-call self-scoped non-closed read)", () => {
  it("returns the caller's NON-CLOSED tickets only (open + awaiting_customer), excluding closed and teammates'", async () => {
    await withSystemDb("search-my-backlog-run", async (tx) => {
      const res = await searchTickets(tx as never, orgId, {
        smartFilter: "my-backlog",
        actorUserId: meId,
        limit: 50,
      } as never)
      // ME has 3 open + 1 awaiting_customer + 1 closed. my-backlog = the 4 non-closed, mine only.
      expect(res.totalCount).toBe(4)
      for (const row of res.items) {
        expect(String((row as Record<string, unknown>).assigned_to)).toBe(meId)
        expect(String((row as Record<string, unknown>).status)).not.toBe("closed")
      }
    })
  })

  it("auto-scopes to the actor — without an actor it returns EMPTY, never a whole-org read", async () => {
    await withSystemDb("search-my-backlog-noactor", async (tx) => {
      const res = await searchTickets(tx as never, orgId, {
        smartFilter: "my-backlog",
        // no actorUserId — the impossible-id fallback yields empty, never the whole org
      } as never)
      expect(res.totalCount).toBe(0)
    })
  })

  it("each my-backlog row carries the server-computed `aging` boolean so the digest renders it", async () => {
    await withSystemDb("search-my-backlog-aging", async (tx) => {
      const res = await searchTickets(tx as never, orgId, {
        smartFilter: "my-backlog",
        actorUserId: meId,
        limit: 50,
      } as never)
      // Every row exposes `aging` (these fixtures are fresh → aging:false); the field is PRESENT so the
      // tick renders it rather than recomputing — the whole point of the server-side discrimination.
      for (const row of res.items) {
        expect((row as Record<string, unknown>).aging).toBeDefined()
      }
    })
  })
})

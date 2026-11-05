// SPDX-License-Identifier: FSL-1.1-ALv2
// Slice B (exhaustive-sweep substrate): `includeTotal` / `countOnly` on
// tickets:search. The total is a server-side COUNT(*) over the SAME filter the
// page query uses — so a routine sweeping "every open ticket" gets an honest,
// measured remaining count that tracks the predicate (process one → its status
// flips → it leaves the set → the next count drops), never a page-size tally.
import { beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { searchTickets } from "~/apps/tickets/search"
import { withSystemDb } from "~/db/privileged"
import type { ActorContext } from "~/db/rls"
import { executeTool } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"

let orgId: string
let userId: string
let inboxId: string
let actor: ActorContext

async function seedTicket(status: string): Promise<string> {
  const id = crypto.randomUUID()
  const handle = `tot-${Math.floor(Math.random() * 1e12)}`
  const replyToken = `RT${Math.floor(Math.random() * 1e16)}`
  await withSystemDb("search-total-seed", async (tx) => {
    await tx.execute(drizzleSql`
      INSERT INTO app_tickets.tickets (
        id, org_id, handle, subject, status, priority, channel, sensitivity,
        reply_token, sla_target_seconds, sla_deadline,
        sla_active_started_at, sla_elapsed_seconds, message_count,
        source_inbox_id, last_inbound_at, last_message_at, created_at, updated_at
      ) VALUES (
        ${id}, ${orgId}, ${handle}, 'Total test', ${status}, 'normal', 'manual', 'internal',
        ${replyToken}, 3600, now() + interval '1 hour',
        now(), 0, 1, ${inboxId}, now() - interval '5 minutes', now() - interval '5 minutes', now(), now()
      )
    `)
  })
  return id
}

beforeAll(async () => {
  const slug = `search-total-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await withSystemDb("search-total-fixture", async (tx) => {
    const orgRows = (await tx.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Search Total', ${slug}) RETURNING id
    `)) as unknown as { rows?: { id: string }[] } & { id: string }[]
    orgId = (orgRows.rows ?? orgRows)[0]!.id
    const userRows = (await tx.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}, ${`u1-${slug}@test.com`}, 'A', 'active', 'h', 1, 1) RETURNING id
    `)) as unknown as { rows?: { id: string }[] } & { id: string }[]
    userId = (userRows.rows ?? userRows)[0]!.id
    const inboxRows = (await tx.execute(drizzleSql`
      INSERT INTO app_tickets.inboxes (id, org_id, connected_account_id, name, email_address, default_sensitivity, is_default_for_create, created_at, updated_at)
      VALUES (gen_random_uuid(), ${orgId}, gen_random_uuid(), 'Inbox', ${`in-${slug}@x.test`}, 'internal', true, now(), now()) RETURNING id
    `)) as unknown as { rows?: { id: string }[] } & { id: string }[]
    inboxId = (inboxRows.rows ?? inboxRows)[0]!.id
  })
  await ensureAppsForOrg(orgId, {})
  actor = {
    actorType: "user",
    userId,
    orgId,
    scopes: ["tickets:tickets:read"],
    dimensionGrants: { team: ["*"], sensitivity: ["restricted"] },
  } as ActorContext

  // 7 open, 3 closed.
  for (let i = 0; i < 7; i++) await seedTicket("open")
  for (let i = 0; i < 3; i++) await seedTicket("closed")
})

describe("searchTickets — totalCount (always-on) / countOnly", () => {
  it("totalCount is a server COUNT over the filter, not the page size", async () => {
    await withSystemDb("search-total-run", async (tx) => {
      const res = await searchTickets(tx as never, orgId, { status: "open", limit: 3 } as never)
      // page is capped at the limit, but totalCount counts the WHOLE matching set
      expect(res.items.length).toBe(3)
      expect(res.nextCursor).not.toBeNull()
      expect(res.totalCount).toBe(7)
    })
  })

  it("totalCount counts the full set even when a cursor pages past the first results", async () => {
    await withSystemDb("search-total-cursor", async (tx) => {
      const first = await searchTickets(tx as never, orgId, { status: "open", limit: 3 } as never)
      const second = await searchTickets(tx as never, orgId, {
        status: "open",
        limit: 3,
        cursor: first.nextCursor!,
      } as never)
      // The cursor must NOT shrink the count — it is the full predicate total.
      expect(second.totalCount).toBe(7)
    })
  })

  it("countOnly returns the number with no item payload (cheap countdown)", async () => {
    await withSystemDb("search-total-countonly", async (tx) => {
      const res = await searchTickets(tx as never, orgId, {
        status: "open",
        countOnly: true,
      } as never)
      expect(res.totalCount).toBe(7)
      expect(res.items).toEqual([])
      expect(res.nextCursor).toBeNull()
    })
  })

  it("the count tracks the predicate: closing one open ticket drops it by one", async () => {
    const id = await seedTicket("open") // now 8 open
    await withSystemDb("search-total-flip-before", async (tx) => {
      const before = await searchTickets(tx as never, orgId, {
        status: "open",
        countOnly: true,
      } as never)
      expect(before.totalCount).toBe(8)
    })
    await withSystemDb("search-total-flip", async (tx) => {
      await tx.execute(
        drizzleSql`UPDATE app_tickets.tickets SET status = 'closed', updated_at = now() WHERE id = ${id}`,
      )
    })
    await withSystemDb("search-total-flip-after", async (tx) => {
      const after = await searchTickets(tx as never, orgId, {
        status: "open",
        countOnly: true,
      } as never)
      expect(after.totalCount).toBe(7)
    })
  })

  it("surfaces totalCount through the tickets:search tool (manifest → rpc bridge)", async () => {
    const out = await executeTool({
      toolName: "tickets:search",
      orgId,
      actor,
      params: { status: "open", limit: 2 },
    })
    const data = out.data as { items: unknown[]; totalCount?: number }
    expect(data.totalCount).toBe(7)
    expect(data.items.length).toBe(2)
  })
})

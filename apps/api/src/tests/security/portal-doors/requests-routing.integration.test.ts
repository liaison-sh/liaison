// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Where a client's portal request and their replies go on Home: the company's account
// manager, their next in line while away, the new manager once it changed, the person
// assigned once someone is, the surviving company's manager after a merge. The portal
// itself never says the manager is away nor names who stands in.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import type { AppEvent } from "~/infra/events/event-bus"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { processTranslationEvent } from "~/modules/attention/translator"
import { createPortalSession } from "~/modules/auth/auth"
import { appendPortalReply } from "~/modules/tickets/ingest-core"
import { insertSql } from "~/seed/factories/org/test-rows"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { createDoorWorld, type DoorWorld, dropDoorWorld, insertShare } from "./fixture"
import { dropReadsWorld } from "./reads-world"

let w: DoorWorld
let standIn: string
const STAND_IN_NAME = "Quentin Relay"
const tokens: Record<string, string> = {}

async function tokenOf(userId: string) {
  tokens[userId] ??= (await createPortalSession(userId, w.orgId)).accessToken
  return tokens[userId] as string
}

async function portal(path: string, init: RequestInit = {}, userId = w.clientA.userId) {
  return app.request(`/api/portal${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${await tokenOf(userId)}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  })
}

async function request(subject: string, userId = w.clientA.userId): Promise<string> {
  const res = await portal(
    "/requests",
    { method: "POST", body: JSON.stringify({ subject, text: "Please look." }) },
    userId,
  )
  expect(res.status).toBe(200)
  return ((await res.json()) as { data: { id: string } }).data.id
}

/** Translates the queued event of `entity` `entityId` and returns who got a portal row. */
async function homeOf(entity: "ticket" | "message", entityId: string): Promise<string[]> {
  const [event] = await sql<{ payload: AppEvent }[]>`
    SELECT payload FROM kernel.pending_events
     WHERE org_id = ${w.orgId} AND payload->>'entityId' = ${entityId}
       AND payload->>'action' = 'create' AND payload->>'entity' = ${entity}`
  if (!event) throw new Error(`no ${entity} create event`)
  await processTranslationEvent(event.payload)
  const rows = await sql<{ user_id: string }[]>`
    SELECT user_id::text AS user_id FROM kernel.attention_events
     WHERE org_id = ${w.orgId} AND app = 'tickets' AND entity_id = ${entityId}
       AND kind = 'tickets:portal_request'`
  return rows.map((r) => r.user_id).sort()
}

async function reply(ticketId: string): Promise<string> {
  return appendPortalReply(w.orgId, {
    ticketId,
    fromEmail: w.clientA.email,
    fromName: w.clientA.name,
    textBody: "Any news?",
  })
}

async function setManager(companyId: string, userId: string | null) {
  await sql`UPDATE kernel.companies SET owner_user_id = ${userId} WHERE id = ${companyId}`
}

async function away(userId: string, nextInLine: string): Promise<string> {
  const id = crypto.randomUUID()
  await sql`
    INSERT INTO kernel.away_ranges (id, org_id, user_id, starts_on, ends_on, next_in_line_id, source, status)
    VALUES (${id}, ${w.orgId}, ${userId}, (now() - interval '2 days')::date,
            (now() + interval '2 days')::date, ${nextInLine}, 'said', 'active')`
  return id
}

const sorted = (ids: string[]) => [...ids].sort()

beforeAll(async () => {
  await acquireTestLock()
  w = await createDoorWorld()
  await insertShare(w, { company_id: w.companyA, kind: "requests" })
  standIn = crypto.randomUUID()
  await sql.unsafe(
    insertSql("kernel.users", {
      id: standIn,
      org_id: w.orgId,
      email: `relay-${standIn.slice(0, 8)}@doors.example.com`,
      name: STAND_IN_NAME,
    }),
  )
  // The tickets app's Home translations are registered for the org when its apps load.
  await ensureAppsForOrg(w.orgId, {})
}, 180_000)

afterAll(async () => {
  if (w) {
    await sql`DELETE FROM kernel.away_ranges WHERE org_id = ${w.orgId}`.catch(() => {})
    await sql`DELETE FROM kernel.pending_events WHERE org_id = ${w.orgId}`.catch(() => {})
    await sql`DELETE FROM kernel.attention_events WHERE org_id = ${w.orgId}`.catch(() => {})
    await dropReadsWorld(w)
    await sql`DELETE FROM kernel.users WHERE id = ${standIn}`.catch(() => {})
    await dropDoorWorld(w)
  }
  await sql.unsafe("REVOKE liaison_portal FROM liaison_request GRANTED BY liaison").catch(() => {})
  await releaseTestLock()
})

describe("portal request routing", () => {
  it("a request reaches the manager and, while they are away, their next in line; it grants the request to nobody", async () => {
    await setManager(w.companyA, w.member.userId)
    const range = await away(w.member.userId, standIn)
    try {
      const id = await request("Header looks off")
      expect(await homeOf("ticket", id)).toEqual(sorted([w.member.userId, standIn]))
      const [t] = await sql<{ assigned_to: string | null }[]>`
        SELECT assigned_to FROM app_tickets.tickets WHERE id = ${id}`
      expect(t?.assigned_to).toBeNull()
    } finally {
      await sql`DELETE FROM kernel.away_ranges WHERE id = ${range}`
    }
  })

  it("a reply reaches the manager as they are now, the person assigned once someone is, and the inbox admins with neither", async () => {
    await setManager(w.companyA, w.member.userId)
    const id = await request("Invoice question")
    expect(await homeOf("ticket", id)).toEqual([w.member.userId])
    // The manager changed while the request is open: the next row goes to the new one.
    await setManager(w.companyA, w.admin.userId)
    expect(await homeOf("message", await reply(id))).toEqual([w.admin.userId])
    // Someone took the request: they hear the client first.
    await sql`UPDATE app_tickets.tickets SET assigned_to = ${w.member.userId} WHERE id = ${id}`
    expect(await homeOf("message", await reply(id))).toEqual([w.member.userId])
    // Nobody on it and no manager: the inbox admins, never the client.
    await sql`UPDATE app_tickets.tickets SET assigned_to = NULL WHERE id = ${id}`
    await setManager(w.companyA, null)
    const admins = await homeOf("message", await reply(id))
    expect(admins).toContain(w.admin.userId)
    expect(admins).not.toContain(w.clientA.userId)
  })

  it("a reply on a request of a company merged away reaches the surviving company's manager", async () => {
    await setManager(w.companyA, w.admin.userId)
    const id = await request("Before the merge")
    // The request's company was merged into company B, whose manager is the member
    // (not an inbox admin, so the fallback could not pass for the survivor's manager).
    const gone = crypto.randomUUID()
    await sql`UPDATE app_tickets.tickets SET company_id = ${gone} WHERE id = ${id}`
    await sql`
      INSERT INTO kernel.audit_log (org_id, actor_type, entity_type, entity_id, action, changes)
      VALUES (${w.orgId}, 'system', 'company', ${gone}, 'company.delete',
              ${JSON.stringify({ mergedInto: w.companyB })}::jsonb)`
    await setManager(w.companyB, w.member.userId)
    try {
      expect(await homeOf("message", await reply(id))).toEqual([w.member.userId])
    } finally {
      await setManager(w.companyB, null)
    }
  })

  it("no portal body says the manager is away or names who stands in for them", async () => {
    await setManager(w.companyA, w.member.userId)
    const range = await away(w.member.userId, standIn)
    try {
      const id = await request("While she is out")
      await homeOf("ticket", id)
      await reply(id)
      const bodies: string[] = []
      for (const path of ["/me", "/home", "/requests", "/documents", "/projects", "/invoices"]) {
        const res = await portal(path)
        expect({ path, status: res.status }).toEqual({ path, status: 200 })
        bodies.push(await res.text())
      }
      // Their contact is still named, whatever their range.
      expect(bodies[0]).toContain(w.member.name)
      for (const body of bodies) {
        expect(body).not.toMatch(
          /\baway\b|absent|\buntil\b|out of office|next.?in.?line|stand.?in/i,
        )
        expect(body).not.toContain(STAND_IN_NAME)
        expect(body).not.toContain(standIn)
      }
    } finally {
      await sql`DELETE FROM kernel.away_ranges WHERE id = ${range}`
    }
  })
})

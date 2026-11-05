// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A ticket that names its customer only by address (no inbound message to
// carry it) and whose address the organisation has no contact for: the
// address is kept as the ticket team's own contact (nobody owns it; the
// creator is recorded), shared with the people who see the ticket. Never
// org-wide, never dropped. An inbound message, or an organisation contact,
// needs no such contact.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { createTicket } from "~/apps/tickets/create"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withRlsContext } from "~/db/rls"
import { ensureAppsForOrg } from "~/modules/apps/init"

const suffix = crypto.randomUUID().slice(0, 8)
let orgId: string
let creator: string
let teammate: string
let outsider: string

const TICKETS = ["tickets:tickets:read", "tickets:tickets:write", "kernel:contacts:read"]

function as<T>(userId: string, team: string[], fn: (tx: never) => Promise<T>): Promise<T> {
  return withRlsContext(
    {
      actorType: "user",
      userId,
      orgId,
      scopes: TICKETS,
      dimensionGrants: { "tickets:team": team, "tickets:sensitivity": ["restricted"] },
    },
    (tx) => fn(tx as never),
  )
}

async function create(params: Record<string, unknown>) {
  const out = (await as(creator, ["support-eu", "support-us"], (tx) =>
    createTicket(
      tx,
      orgId,
      {
        subject: "Customer named by address",
        channel: "manual",
        team: "support-eu",
        ...params,
      } as never,
      { actorType: "user", userId: creator } as never,
    ),
  )) as { ticketId?: string; error?: unknown }
  expect(out.error).toBeUndefined()
  const [row] = extractRows<{ contact_id: string | null }>(
    await db.execute(drizzleSql`
      SELECT contact_id::text AS contact_id FROM app_tickets.tickets WHERE id = ${out.ticketId}::uuid`),
  )
  return row.contact_id
}

async function sees(userId: string, team: string[], contactId: string): Promise<boolean> {
  return as(
    userId,
    team,
    async (tx: any) =>
      extractRows(
        await tx.execute(drizzleSql`SELECT 1 FROM kernel.contacts WHERE id = ${contactId}::uuid`),
      ).length === 1,
  )
}

beforeAll(async () => {
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Ticket audience', ${`ticket-audience-${suffix}`}) RETURNING id`),
  )
  orgId = org.id
  const users = extractRows<{ id: string; name: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}, ${`c-${suffix}@corp.example`}, 'C', 'active', 'h', 1, 1),
             (gen_random_uuid(), ${orgId}, ${`t-${suffix}@corp.example`}, 'T', 'active', 'h', 1, 1),
             (gen_random_uuid(), ${orgId}, ${`o-${suffix}@corp.example`}, 'O', 'active', 'h', 1, 1)
      RETURNING id, name`),
  )
  creator = users.find((u) => u.name === "C")!.id
  teammate = users.find((u) => u.name === "T")!.id
  outsider = users.find((u) => u.name === "O")!.id
  await ensureAppsForOrg(orgId)
}, 120_000)

afterAll(async () => {
  await db.execute(drizzleSql`DELETE FROM app_tickets.tickets WHERE org_id = ${orgId}::uuid`)
  await db.execute(drizzleSql`DELETE FROM kernel.contacts WHERE org_id = ${orgId}::uuid`)
})

describe("createTicket: a customer named only by address", () => {
  it("is kept as the ticket team's contact, shared with that team", async () => {
    const email = `new-${suffix}@customer.example`
    const contactId = await create({ contactEmail: email, contactName: "New Customer" })
    expect(contactId).not.toBeNull()
    const [row] = extractRows<{
      org_access: string
      owner_user_id: string | null
      created_by: string
      email: string
      acl_role_ids: string[]
    }>(
      await db.execute(drizzleSql`
        SELECT org_access, owner_user_id::text AS owner_user_id, created_by::text AS created_by,
               email, acl_role_ids
          FROM kernel.contacts WHERE id = ${contactId}::uuid`),
    )
    expect(row).toMatchObject({
      org_access: "none",
      owner_user_id: null,
      created_by: creator,
      email,
    })
    expect(row.acl_role_ids).toContain("dim:tickets:team=support-eu")
    // Who sees the ticket sees its customer; nobody else does.
    expect(await sees(creator, ["support-eu"], contactId!)).toBe(true)
    expect(await sees(teammate, ["support-eu"], contactId!)).toBe(true)
    expect(await sees(outsider, ["support-us"], contactId!)).toBe(false)
    // A second ticket for the same address reuses it.
    expect(await create({ contactEmail: email })).toBe(contactId)
    // Another team's ticket gets that team's own contact: teams stay apart.
    const otherTeam = await create({ contactEmail: email, team: "support-us" })
    expect(otherTeam).not.toBe(contactId)
    expect(await sees(teammate, ["support-eu"], otherTeam!)).toBe(false)
    expect(await sees(outsider, ["support-us"], otherTeam!)).toBe(true)
  })

  it("creates nothing when an inbound message carries the address, or the org knows it", async () => {
    const carried = `carried-${suffix}@customer.example`
    expect(
      await create({
        contactEmail: carried,
        initialMessage: { kind: "inbound", textBody: "hello" },
      }),
    ).toBeNull()
    const [n] = extractRows<{ n: number }>(
      await db.execute(drizzleSql`
        SELECT count(*)::int AS n FROM kernel.contacts WHERE org_id = ${orgId}::uuid AND email = ${carried}`),
    )
    expect(n.n).toBe(0)

    const known = `known-${suffix}@customer.example`
    const [org] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        INSERT INTO kernel.contacts (org_id, handle, email) VALUES (${orgId}, ${`@k-${suffix}`}, ${known})
        RETURNING id::text AS id`),
    )
    expect(await create({ contactEmail: known })).toBe(org.id)
  })
})

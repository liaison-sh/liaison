// SPDX-License-Identifier: FSL-1.1-ALv2
// D11: a pending ticket approval's `ref` is written once, at creation. After a
// reclassify, or once the org turns segmentation on, the stored ref is stale.
// Every surface that serves the approval summary (list, detail, Home attention
// row) recomputes it from the ticket's CURRENT display handle; the stored row
// is never rewritten.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { app } from "~/app"
import { extractRows, type PrivilegedDb } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { env } from "~/lib/env"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { signAccessToken } from "~/modules/auth/jwt"

let orgId = ""
let userId = ""
let token = ""
let ticketId = ""
let otherTicketId = ""
const approvalIds: string[] = []
const seq = 800_000_000 + Math.floor(Math.random() * 1e8)

const sys = <T>(fn: (tx: PrivilegedDb) => Promise<T>) => withSystemDb("approval-ref-live", fn)

async function setSegment(value: unknown): Promise<void> {
  await sys((tx) =>
    tx.execute(drizzleSql`
      UPDATE kernel.organizations
      SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{tickets}',
        COALESCE(settings->'tickets', '{}'::jsonb) || jsonb_build_object('idSegment', ${JSON.stringify(value)}::jsonb), true)
      WHERE id = ${orgId}
    `),
  )
}

async function seedTicket(handle: string, audience: string): Promise<string> {
  return sys(
    async (tx) =>
      extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
        INSERT INTO app_tickets.tickets (
          id, org_id, handle, subject, status, priority, channel, sensitivity, audience,
          reply_token, sla_target_seconds, sla_deadline, created_at, updated_at
        ) VALUES (
          gen_random_uuid(), ${orgId}, ${handle}, 'Facturation partenaire', 'open', 'normal',
          'email', 'internal', ${audience}, ${`RT${handle}`}, 3600, now() + interval '1 hour',
          now(), now()
        ) RETURNING id
      `),
      )[0]!.id,
  )
}

async function seedApproval(forTicket: string, frozenRef: string): Promise<string> {
  return sys(async (tx) => {
    const thread = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.threads (id, org_id, handle, title, type, created_by)
        VALUES (gen_random_uuid(), ${orgId}::uuid, ${`approval-${randomUUID()}`}, 'Approval', 'approval', ${userId}::uuid)
        RETURNING id
      `),
    )[0]!.id
    const id = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.approval_requests (
          id, org_id, handle, thread_id, originating_thread_id, tool_name,
          tool_params, current_payload, expires_at, notify_user_ids, requested_by,
          status, summary
        ) VALUES (
          gen_random_uuid(), ${orgId}::uuid, ${`request-${randomUUID().slice(0, 8)}`},
          ${thread}::uuid, ${thread}::uuid, 'tickets:reply',
          ${JSON.stringify({ ticketId: forTicket, textBody: "Bonjour" })}::jsonb,
          ${JSON.stringify({ ticketId: forTicket, textBody: "Bonjour" })}::jsonb,
          now() + interval '30 minutes', ARRAY[${userId}::uuid], ${userId}::uuid, 'pending',
          ${JSON.stringify({
            kind: "tickets.reply",
            ref: frozenRef,
            title: "Facturation partenaire",
            subtitle: "Reply to Claire Durand",
            lines: [],
          })}::jsonb
        ) RETURNING id
      `),
    )[0]!.id
    approvalIds.push(id)
    return id
  })
}

async function servedRefs(approvalId: string, forTicket: string): Promise<Record<string, unknown>> {
  const headers = { Authorization: `Bearer ${token}` }
  const list = (await (
    await app.request(`/api/approvals?ticketId=${forTicket}`, { headers })
  ).json()) as {
    data: Array<{ id: string; summary: { ref?: string } }>
  }
  const detail = (await (
    await app.request(`/api/approvals/${approvalId}`, { headers })
  ).json()) as {
    data: { summary: { ref?: string } }
  }
  const feed = (await (await app.request("/api/attention-items", { headers })).json()) as {
    data: { items: Array<{ entityId: string; metadata?: { ref?: string } }> }
  }
  return {
    list: list.data.find((a) => a.id === approvalId)?.summary.ref,
    detail: detail.data.summary.ref,
    attention: feed.data.items.find((i) => i.entityId === approvalId)?.metadata?.ref,
  }
}

beforeAll(async () => {
  const slug = `ref-live-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  orgId = await sys(
    async (tx) =>
      extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
        INSERT INTO kernel.organizations (id, name, slug) VALUES (gen_random_uuid(), 'RefLive', ${slug}) RETURNING id
      `),
      )[0]!.id,
  )
  await ensureAppsForOrg(orgId, {})
  userId = await sys(
    async (tx) =>
      extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
        VALUES (gen_random_uuid(), ${orgId}, ${`u-${slug}@test.com`}, 'U', 'active', 'h', 1, 1) RETURNING id
      `),
      )[0]!.id,
  )
  token = await signAccessToken(
    {
      userId,
      orgId,
      name: "U",
      roles: ["admin"],
      scopes: ["*"],
      dimensionGrants: { "*": ["*"] },
      authVersion: 1,
      permissionVersion: 1,
    },
    env.JWT_SECRET,
  )
  ticketId = await seedTicket(`ticket-${seq}`, "b2b")
  otherTicketId = await seedTicket(`ticket-${seq + 1}`, "b2c")
})

afterAll(async () => {
  await sys(async (tx) => {
    await tx.execute(drizzleSql`DELETE FROM kernel.approval_requests WHERE org_id = ${orgId}`)
    await tx.execute(drizzleSql`DELETE FROM app_tickets.tickets WHERE org_id = ${orgId}`)
  })
})

describe("a ticket approval's ref is served live", () => {
  it("follows segmentation turned on after creation, and a later reclassify", async () => {
    // Created while the org did not segment: the frozen ref is the bare form.
    const approvalId = await seedApproval(ticketId, `ticket-${seq}`)
    // A second pending approval on another ticket, so the batch covers two.
    const otherId = await seedApproval(otherTicketId, `ticket-${seq + 1}`)
    await setSegment({ by: "audience", codes: { b2b: "B2B", b2c: "B2C" } })

    const b2b = `ticket-B2B-${seq}`
    expect(await servedRefs(approvalId, ticketId)).toEqual({
      list: b2b,
      detail: b2b,
      attention: b2b,
    })
    expect((await servedRefs(otherId, otherTicketId)).detail).toBe(`ticket-B2C-${seq + 1}`)

    await sys((tx) =>
      tx.execute(
        drizzleSql`UPDATE app_tickets.tickets SET audience = 'b2c' WHERE id = ${ticketId}`,
      ),
    )
    const b2c = `ticket-B2C-${seq}`
    expect(await servedRefs(approvalId, ticketId)).toEqual({
      list: b2c,
      detail: b2c,
      attention: b2c,
    })

    // Segmentation off again: the bare stored form.
    await setSegment({ by: "none", codes: {} })
    const bare = `ticket-${seq}`
    expect(await servedRefs(approvalId, ticketId)).toEqual({
      list: bare,
      detail: bare,
      attention: bare,
    })

    // The stored summary is never rewritten.
    const stored = await sys(async (tx) =>
      extractRows<{ ref: string }>(
        await tx.execute(drizzleSql`
          SELECT summary->>'ref' AS ref FROM kernel.approval_requests WHERE id = ${approvalId}
        `),
      ),
    )
    expect(stored[0]!.ref).toBe(`ticket-${seq}`)
  }, 30_000)
})

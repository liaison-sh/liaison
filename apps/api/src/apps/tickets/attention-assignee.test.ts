// SPDX-License-Identifier: FSL-1.1-ALv2
// D21: Home files "tickets awaiting a reply" under Your queues (volume work, not
// in the Home badge) UNLESS the ticket is assigned to the viewer, which is a
// personal decision. The awaiting row says who the ticket is assigned to so the
// client can tell the two apart.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { computeAttentionItems } from "~/apps/tickets/attention"
import { extractRows, type PrivilegedDb } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { asOrgMember } from "~/tests/helpers/org-caller"

const sys = <T>(fn: (tx: PrivilegedDb) => Promise<T>) =>
  withSystemDb("tickets-attention-assignee", fn)

let orgId = ""
let userId = ""

async function seedAwaiting(handle: string, assignedTo: string | null): Promise<string> {
  return sys(
    async (tx) =>
      extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
        INSERT INTO app_tickets.tickets (
          id, org_id, handle, subject, status, priority, channel, sensitivity, audience,
          reply_token, sla_target_seconds, sla_deadline, created_at, updated_at,
          last_inbound_at, assigned_to
        ) VALUES (
          gen_random_uuid(), ${orgId}, ${handle}, 'Question', 'open', 'normal',
          'email', 'internal', 'b2c', ${`RT${handle}`}, 86400, now() + interval '1 day',
          now(), now(), now(), ${assignedTo}::uuid
        ) RETURNING id
      `),
      )[0]!.id,
  )
}

beforeAll(async () => {
  const slug = `att-assignee-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  orgId = await sys(
    async (tx) =>
      extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
        INSERT INTO kernel.organizations (id, name, slug) VALUES (gen_random_uuid(), 'AttAssignee', ${slug}) RETURNING id
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
})

afterAll(async () => {
  await sys((tx) => tx.execute(drizzleSql`DELETE FROM app_tickets.tickets WHERE org_id = ${orgId}`))
})

describe("tickets attention: awaiting a reply carries the assignee (D21)", () => {
  it("names the assignee on an assigned ticket and null on an unassigned one", async () => {
    const mine = await seedAwaiting(`AA${Date.now()}`, userId)
    const nobody = await seedAwaiting(`AB${Date.now()}`, null)
    const items = await asOrgMember(orgId, userId, (tx) => computeAttentionItems(tx, orgId))
    const awaiting = (id: string) =>
      items.find((i) => i.kind === "awaiting_agent" && i.entityId === id)
    expect(awaiting(mine)?.metadata?.assignedTo).toBe(userId)
    expect(awaiting(nobody)?.metadata?.assignedTo).toBeNull()
  })
})

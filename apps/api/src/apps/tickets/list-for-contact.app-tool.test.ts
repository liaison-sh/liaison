// SPDX-License-Identifier: FSL-1.1-ALv2
// [Task 12 / Task 4 boundary] tickets:listForContact via the app-tool path.
import { beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import type { ActorContext } from "~/db/rls"
import { executeTool } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"

let orgId: string
let userId: string
let contactId: string
let actor: ActorContext

beforeAll(async () => {
  const slug = `lfc-app-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await withSystemDb("lfc-app-fixture", async (tx) => {
    const o = (await tx.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'LFC App', ${slug}) RETURNING id
    `)) as any
    orgId = (o.rows ?? o)[0].id
    const u = (await tx.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}, ${`u-${slug}@x.test`}, 'A', 'active', 'h', 1, 1) RETURNING id
    `)) as any
    userId = (u.rows ?? u)[0].id
    const c = (await tx.execute(drizzleSql`
      INSERT INTO kernel.contacts (id, org_id, handle, name, email, created_at, updated_at)
      VALUES (gen_random_uuid(), ${orgId}, ${`c-${slug}`}, 'C', ${`c-${slug}@x.test`}, now(), now())
      RETURNING id
    `)) as any
    contactId = (c.rows ?? c)[0].id
    for (const minsAgo of [60, 5, 1]) {
      await tx.execute(drizzleSql`
        INSERT INTO app_tickets.tickets (
          id, org_id, handle, subject, status, priority, channel, sensitivity,
          contact_id, reply_token, sla_target_seconds, sla_deadline,
          sla_active_started_at, sla_elapsed_seconds, message_count,
          last_message_at, created_at, updated_at
        ) VALUES (
          gen_random_uuid(), ${orgId}, ${`tk-${slug}-${minsAgo}`}, ${`Sub ${minsAgo}`},
          'open', 'normal', 'manual', 'internal',
          ${contactId}, ${`RT${slug.replace(/-/g, "").slice(0, 12)}${minsAgo}`}, 3600,
          now() + interval '1 hour',
          now(), 0, 1,
          now() - (${minsAgo} || ' minutes')::interval,
          now(), now()
        )
      `)
    }
  })
  await ensureAppsForOrg(orgId, {})
  actor = {
    actorType: "user",
    userId,
    orgId,
    scopes: ["tickets:tickets:read"],
    dimensionGrants: { team: ["*"], sensitivity: ["restricted"] },
  } as ActorContext
})

describe("tickets.list-for-contact.app-tool", () => {
  it("returns ordered items via tickets:listForContact tool dispatch", async () => {
    const out = await executeTool({
      toolName: "tickets:listForContact",
      orgId,
      actor,
      params: { contactId, limit: 25 },
    })
    const items = (out.data as any).items as Array<{
      id: string
      handle: string
      subject: string
      status: string
      lastActivityAt: string | null
    }>
    expect(items.length).toBe(3)
    // Sorted by lastActivityAt desc.
    expect(items[0].subject).toBe("Sub 1")
    expect(items[1].subject).toBe("Sub 5")
    expect(items[2].subject).toBe("Sub 60")
    // No snake_case keys.
    for (const r of items) for (const k of Object.keys(r)) expect(k.includes("_")).toBe(false)
  })

  it("respects limit", async () => {
    const out = await executeTool({
      toolName: "tickets:listForContact",
      orgId,
      actor,
      params: { contactId, limit: 1 },
    })
    expect(((out.data as any).items as unknown[]).length).toBe(1)
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
// S23/A9/A10: every ticket approval card leads with the ticket id. The
// summarizers set `ref` = the DISPLAY handle (`ticket-B2B-123`), the title is
// the subject and the subtitle is the action plus the customer, with the
// handle out of it. Driven through generateApprovalSummary, the path the
// approval row is written from, so a `ref` the bounding step drops fails here.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type PrivilegedDb } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { type ActorContext, withRlsContext } from "~/db/rls"
import { generateApprovalSummary } from "~/modules/apps/approval-summarizers"
import { ensureAppsForOrg } from "~/modules/apps/init"

let orgId = ""
let userId = ""
let ticketId = ""
let noteId = ""
const seq = 600_000_000 + Math.floor(Math.random() * 1e8)

const sys = <T>(fn: (tx: PrivilegedDb) => Promise<T>) => withSystemDb("summarizers-ref", fn)

beforeAll(async () => {
  const slug = `summ-ref-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  orgId = await sys(
    async (tx) =>
      extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
        INSERT INTO kernel.organizations (id, name, slug, settings)
        VALUES (gen_random_uuid(), 'SummRef', ${slug},
          '{"tickets":{"idSegment":{"by":"audience","codes":{"b2b":"B2B","b2c":"B2C"}}}}'::jsonb)
        RETURNING id
      `),
      )[0]!.id,
  )
  // The tickets app's own columns (audience, ...) come with its install: this
  // file must not rely on another one having installed it first.
  await ensureAppsForOrg(orgId, {})
  await sys(async (tx) => {
    userId = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
        VALUES (gen_random_uuid(), ${orgId}, ${`u-${slug}@test.com`}, 'U', 'active', 'h', 1, 1) RETURNING id
      `),
    )[0]!.id
    const contactId = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.contacts (id, org_id, handle, name, email)
        VALUES (gen_random_uuid(), ${orgId}, ${`c-${slug}`}, 'Jean Dupont', 'jean@client.test') RETURNING id
      `),
    )[0]!.id
    ticketId = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO app_tickets.tickets (
          id, org_id, handle, subject, status, priority, channel, sensitivity, audience,
          reply_token, sla_target_seconds, sla_deadline, contact_id, created_at, updated_at
        ) VALUES (
          gen_random_uuid(), ${orgId}, ${`ticket-${seq}`}, 'Where is my order', 'open', 'normal',
          'email', 'internal', 'b2b', ${`RT${seq}`}, 3600, now() + interval '1 hour', ${contactId},
          now(), now()
        ) RETURNING id
      `),
    )[0]!.id
    noteId = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO app_tickets.messages (id, org_id, ticket_id, kind, text_body, sent_at, created_at, updated_at)
        VALUES (gen_random_uuid(), ${orgId}, ${ticketId}, 'note', 'call back', now(), now(), now())
        RETURNING id
      `),
    )[0]!.id
  })
})

afterAll(async () => {
  await sys((tx) =>
    tx.execute(drizzleSql`DELETE FROM app_tickets.messages WHERE org_id = ${orgId}`),
  )
  await sys((tx) => tx.execute(drizzleSql`DELETE FROM app_tickets.tickets WHERE org_id = ${orgId}`))
})

async function summarize(tool: string, params: Record<string, unknown>) {
  const actor = {
    actorType: "user",
    userId,
    orgId,
    scopes: ["tickets:tickets:read", "tickets:tickets:write"],
    dimensionGrants: { team: ["*"], sensitivity: ["restricted"] },
  } as ActorContext
  return withRlsContext(actor, (tx) =>
    generateApprovalSummary(
      orgId,
      "tickets",
      tool,
      params,
      { tx, orgId, userId },
      `tickets:${tool}`,
    ),
  )
}

describe("ticket approval summaries lead with the ticket id", () => {
  it("reply: ref, subject title, action + customer subtitle", async () => {
    const s = await summarize("reply", { ticketId, textBody: "Bonjour" })
    expect(s.ref).toBe(`ticket-B2B-${seq}`)
    expect(s.title).toBe("Where is my order")
    expect(s.subtitle).toBe("Reply to Jean Dupont")
  })

  it("a call staged by a stale handle still carries the current display id", async () => {
    const s = await summarize("reply", { ticketId: `ticket-B2C-${seq}`, textBody: "x" })
    expect(s.ref).toBe(`ticket-B2B-${seq}`)
  })

  it("nudge and close", async () => {
    const n = await summarize("nudge", { ticketId, textBody: "?" })
    expect(n.ref).toBe(`ticket-B2B-${seq}`)
    expect(n.subtitle).toBe("Nudge Jean Dupont")
    const c = await summarize("close", { ticketId })
    expect(c.ref).toBe(`ticket-B2B-${seq}`)
    expect(c.subtitle).toBe("Close")
  })

  it("internal note edit/delete", async () => {
    const e = await summarize("editNote", { ticketId, messageId: noteId, text: "call Monday" })
    expect(e.ref).toBe(`ticket-B2B-${seq}`)
    expect(e.subtitle).toBe("Edit internal note")
    const d = await summarize("deleteNote", { ticketId, messageId: noteId })
    expect(d.ref).toBe(`ticket-B2B-${seq}`)
    expect(d.subtitle).toBe("Delete internal note")
  })
})

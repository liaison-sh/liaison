// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Per-inbox ingest: `POST /webhooks/:orgId/inboxes/:inboxId/tickets/create` --
// a copyable, self-contained endpoint per API inbox (bug reports, website
// contact, a per-tenant endpoint). Proves: the URL pins the destination inbox;
// a body `sourceInboxId` that disagrees is rejected; the per-inbox path needs an
// API key; and an inbox-scoped API key can ONLY write to its inbox (and defaults
// to it on the generic endpoint).

import { beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { Hono } from "hono"
import { runAdminOp } from "~/apps/tickets/admin"
import { extractRows } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { ticketsPublicRoutes } from "./tickets-public"

const app = new Hono().route("/webhooks", ticketsPublicRoutes)

let orgId: string
let userId: string
let bugInboxId: string
let otherInboxId: string
let orgKey: string // unscoped org key (plaintext)
let scopedKey: string // key scoped to bugInboxId (plaintext)

const rows = (r: unknown): any[] => (r as any).rows ?? r
let n = 0
const ref = () => `ext-${Date.now()}-${n++}`

beforeAll(async () => {
  const slug = `apiingest-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await withSystemDb("api-ingest-fixture", async (tx) => {
    orgId = rows(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.organizations (id, name, slug)
        VALUES (gen_random_uuid(), 'API Ingest', ${slug}) RETURNING id`),
    )[0].id
    userId = rows(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
        VALUES (gen_random_uuid(), ${orgId}, ${`u-${slug}@x.test`}, 'A', 'active', 'h', 1, 1) RETURNING id`),
    )[0].id
  })
  await ensureAppsForOrg(orgId, {})
  const actor = { actorType: "user" as const, userId }
  await withPrivilegedDb(orgId, "api-ingest-setup", async (tx) => {
    bugInboxId = (
      (await runAdminOp(
        tx as never,
        orgId,
        "inboxesCreate",
        { kind: "api", name: "Bug Reports" },
        actor,
      )) as any
    ).id
    otherInboxId = (
      (await runAdminOp(
        tx as never,
        orgId,
        "inboxesCreate",
        { kind: "api", name: "Website" },
        actor,
      )) as any
    ).id
    orgKey = (
      (await runAdminOp(tx as never, orgId, "apiKeysCreate", { label: "org-wide" }, actor)) as any
    ).key
    scopedKey = (
      (await runAdminOp(
        tx as never,
        orgId,
        "apiKeysCreate",
        { label: "bug-scoped", inboxId: bugInboxId },
        actor,
      )) as any
    ).key
  })
})

function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return Promise.resolve(
    app.fetch(
      new Request(`http://x/webhooks/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    ),
  )
}
const bearer = (k: string) => ({ Authorization: `Bearer ${k}` })
const rj = (res: Response): Promise<any> => res.json() as Promise<any>

async function sourceInboxOf(ticketId: string): Promise<string | null> {
  const row = extractRows<{ source_inbox_id: string | null }>(
    await withPrivilegedDb(orgId, "verify-source-inbox", (tx) =>
      tx.execute(drizzleSql`
        SELECT source_inbox_id FROM app_tickets.tickets
        WHERE id = ${ticketId}::uuid AND org_id = ${orgId}::uuid`),
    ),
  )[0]
  return row?.source_inbox_id ?? null
}

describe("tickets public: per-inbox ingest endpoint", () => {
  it("routes a ticket to the inbox named in the URL", async () => {
    const res = await post(
      `${orgId}/inboxes/${bugInboxId}/tickets/create`,
      {
        subject: "Crash on boot",
        fromEmail: "user@x.test",
        textBody: "it crashed",
        externalRef: ref(),
      },
      bearer(orgKey),
    )
    expect(res.status).toBe(200)
    const ticketId = (await rj(res)).data.ticketId
    expect(ticketId).toBeTruthy()
    expect(await sourceInboxOf(ticketId)).toBe(bugInboxId)
  })

  it("rejects a body sourceInboxId that conflicts with the URL inbox", async () => {
    const res = await post(
      `${orgId}/inboxes/${bugInboxId}/tickets/create`,
      {
        subject: "x",
        fromEmail: "u@x.test",
        textBody: "y",
        sourceInboxId: otherInboxId,
        externalRef: ref(),
      },
      bearer(orgKey),
    )
    expect(res.status).toBe(400)
    expect((await rj(res)).error.code).toBe("inbox_conflict")
  })

  it("requires an API key on the per-inbox path (anonymous is 401)", async () => {
    const res = await post(`${orgId}/inboxes/${bugInboxId}/tickets/create`, {
      subject: "x",
      fromEmail: "u@x.test",
      textBody: "y",
    })
    expect(res.status).toBe(401)
  })

  it("an inbox-scoped key can post to its own inbox", async () => {
    const res = await post(
      `${orgId}/inboxes/${bugInboxId}/tickets/create`,
      { subject: "scoped ok", fromEmail: "u@x.test", textBody: "y", externalRef: ref() },
      bearer(scopedKey),
    )
    expect(res.status).toBe(200)
    expect(await sourceInboxOf((await rj(res)).data.ticketId)).toBe(bugInboxId)
  })

  it("an inbox-scoped key is rejected on a different inbox (403)", async () => {
    const res = await post(
      `${orgId}/inboxes/${otherInboxId}/tickets/create`,
      { subject: "scoped bad", fromEmail: "u@x.test", textBody: "y", externalRef: ref() },
      bearer(scopedKey),
    )
    expect(res.status).toBe(403)
    expect((await rj(res)).error.code).toBe("inbox_scope_violation")
  })

  it("an inbox-scoped key on the GENERIC endpoint still lands in its inbox", async () => {
    const res = await post(
      `${orgId}/tickets/create`,
      { subject: "scoped generic", fromEmail: "u@x.test", textBody: "y", externalRef: ref() },
      bearer(scopedKey),
    )
    expect(res.status).toBe(200)
    expect(await sourceInboxOf((await rj(res)).data.ticketId)).toBe(bugInboxId)
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// /api/trusted-senders: read by anyone who reads contacts or tickets, changed only by a contacts
// admin or a tickets settings admin, every change recorded as an audited event, and a public mail
// provider's domain refused (single addresses there only).
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { KERNEL_DECLARED_EMITS } from "~/infra/events/event-bus"
import { env } from "~/lib/env"
import { declaredEmits } from "~/modules/apps/app-registries"
import { signAccessToken } from "~/modules/auth/jwt"

const ORG = "00000000-0000-4000-8000-0000007a5e01"
// Fresh users per run: resolved scopes are cached per user.
const ADMIN = crypto.randomUUID()
const READER = crypto.randomUUID()
const ADMIN_ROLE = "00000000-0000-4000-8000-0000007a5e04"
const READER_ROLE = "00000000-0000-4000-8000-0000007a5e05"
const CONTACT = "00000000-0000-4000-8000-0000007a5e06"
const CONTACTS_ADMIN = crypto.randomUUID()
const CONTACTS_ADMIN_ROLE = "00000000-0000-4000-8000-0000007a5e07"

let adminToken: string
let readerToken: string
let contactsAdminToken: string
let priorKernelEmits: Set<string> | undefined

function token(userId: string, scopes: string[]) {
  return signAccessToken(
    { userId, orgId: ORG, name: "T", authVersion: 1, permissionVersion: 1, scopes },
    env.JWT_SECRET,
  )
}

function call(t: string, method: string, path = "", body?: unknown) {
  return app.request(`/api/trusted-senders${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
}

describe("/api/trusted-senders", () => {
  beforeAll(async () => {
    // Arm the boot-time check (initEventBus) that refuses an undeclared kernel event: without it
    // the outbox insert is unchecked here, and a "Trust this sender" click that 500s in a running
    // server passes this file.
    priorKernelEmits = declaredEmits.get("kernel")
    declaredEmits.set("kernel", new Set(KERNEL_DECLARED_EMITS))
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'TrustRoutes', 'trust-routes-org') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES
      (${ADMIN}, ${ORG}, ${`trust-admin-${ADMIN}@test.com`}, 'Admin'),
      (${READER}, ${ORG}, ${`trust-reader-${READER}@test.com`}, 'Reader'),
      (${CONTACTS_ADMIN}, ${ORG}, ${`trust-cadmin-${CONTACTS_ADMIN}@test.com`}, 'Contacts admin')
      ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.contacts (id, org_id, handle, name, email)
      VALUES (${CONTACT}, ${ORG}, 'victor-hansen', 'Victor Hansen', 'victor.hansen@bolgelyd.example')
      ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.roles (id, org_id, name) VALUES
      (${ADMIN_ROLE}, ${ORG}, 'trust-contacts-admin'), (${READER_ROLE}, ${ORG}, 'trust-tickets-reader'),
      (${CONTACTS_ADMIN_ROLE}, ${ORG}, 'trust-kernel-contacts-admin')
      ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.role_scope_grants (role_id, scope) VALUES
      (${ADMIN_ROLE}, 'tickets:settings:admin'), (${READER_ROLE}, 'tickets:tickets:read'),
      (${CONTACTS_ADMIN_ROLE}, 'kernel:contacts:admin')
      ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_roles (user_id, role_id, org_id) VALUES
      (${ADMIN}, ${ADMIN_ROLE}, ${ORG}), (${READER}, ${READER_ROLE}, ${ORG}),
      (${CONTACTS_ADMIN}, ${CONTACTS_ADMIN_ROLE}, ${ORG}) ON CONFLICT DO NOTHING`
    adminToken = await token(ADMIN, ["tickets:settings:admin"])
    readerToken = await token(READER, ["tickets:tickets:read"])
    contactsAdminToken = await token(CONTACTS_ADMIN, ["kernel:contacts:admin"])
  })

  afterAll(async () => {
    if (priorKernelEmits) declaredEmits.set("kernel", priorKernelEmits)
    else declaredEmits.delete("kernel")
    await sql`DELETE FROM kernel.contacts WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.trusted_senders WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.user_roles WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.role_scope_grants WHERE role_id IN (${ADMIN_ROLE}, ${READER_ROLE}, ${CONTACTS_ADMIN_ROLE})`
    await sql`DELETE FROM kernel.roles WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
  })

  it("a tickets settings admin trusts a domain and removes it, each change audited", async () => {
    const created = await call(adminToken, "POST", "", { kind: "domain", value: "@Partner.Test" })
    expect(created.status).toBe(201)
    const row = ((await created.json()) as { data: { id: string; value: string } }).data
    expect(row.value).toBe("partner.test")

    const listed = await call(readerToken, "GET")
    expect(listed.status).toBe(200)
    expect(
      ((await listed.json()) as { data: { value: string }[] }).data.map((r) => r.value),
    ).toEqual(["partner.test"])

    expect((await call(adminToken, "DELETE", `/${row.id}`)).status).toBe(200)
    expect((await call(adminToken, "DELETE", `/${row.id}`)).status).toBe(404)

    const events = await sql`SELECT payload->>'action' AS action FROM kernel.pending_events
      WHERE org_id = ${ORG} AND payload->>'entity' = 'trusted_sender'
        AND payload->>'entityId' = ${row.id}
      ORDER BY created_at`
    expect(events.map((e) => e.action)).toEqual(["create", "delete"])
  })

  it("a contacts admin trusts a seeded contact's address from the contact page", async () => {
    // The contact page's trust menu posts the contact's own address (TrustedSenderControl).
    const res = await call(contactsAdminToken, "POST", "", {
      kind: "address",
      value: "victor.hansen@bolgelyd.example",
    })
    expect(res.status).toBe(201)
    const row = ((await res.json()) as { data: { id: string; kind: string; value: string } }).data
    expect(row).toMatchObject({ kind: "address", value: "victor.hansen@bolgelyd.example" })
    // Idempotent: trusting it again returns the same entry.
    const again = await call(contactsAdminToken, "POST", "", {
      kind: "address",
      value: "Victor.Hansen@bolgelyd.example",
    })
    expect(again.status).toBe(201)
    expect(((await again.json()) as { data: { id: string } }).data.id).toBe(row.id)
  })

  it("a reader may not change the list", async () => {
    const res = await call(readerToken, "POST", "", { kind: "address", value: "x@partner.test" })
    expect(res.status).toBe(403)
  })

  it("refuses a public mail provider's domain, accepts one address there", async () => {
    expect(
      (await call(adminToken, "POST", "", { kind: "domain", value: "gmail.com" })).status,
    ).toBe(400)
    expect(
      (await call(adminToken, "POST", "", { kind: "address", value: "Dana@Gmail.com" })).status,
    ).toBe(201)
  })
})

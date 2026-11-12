// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One active account per (org, app, connection, identifier), whoever owns it:
// `connected_accounts_unique_active_idx` is keyed on the identifier, not the
// owner. What a credentials save does when it meets someone else's account:
//
//  - A connection whose fields name no account keys an ORG save on the org,
//    never on the saver, so it never meets anybody's personal account.
//  - An org save of an account another member holds personally is a 409 that
//    names the member, unless the request says `takeOver: true`.
//  - A takeover retires the personal row, emits its disconnect (audited) and
//    tells the former owner in their attention feed.
//  - A personal save of an account the org (or someone else) holds is a 409.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import type { AppEvent } from "~/infra/events/event-bus"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { processTranslationEvent } from "~/modules/attention/translator"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

type Json = Record<string, any>

let orgId: string
let adminId: string
let adminToken: string
let memberId: string
let memberToken: string

async function post(token: string, path: string, body: unknown) {
  const res = await app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as Json }
}

async function active(appName: string, connection: string) {
  const rows = await sql<{ owner_type: string; owner_id: string | null; identifier: string }[]>`
    SELECT owner_type, owner_id, identifier FROM kernel.connected_accounts
    WHERE org_id = ${orgId} AND app_name = ${appName} AND connection_name = ${connection}
      AND status = 'active'
    ORDER BY owner_type`
  return rows.map((r) => ({
    owner_type: r.owner_type,
    owner_id: r.owner_id,
    identifier: r.identifier,
  }))
}

function imap(address: string) {
  return {
    email: address,
    imapHost: "imap.example.com",
    imapPort: "993",
    smtpHost: "smtp.example.com",
    smtpPort: "465",
    username: address,
    password: "mailbox-password",
  }
}

describe("credentials route: an account held by another owner", () => {
  beforeAll(async () => {
    await acquireTestLock()
    orgId = (await createTestOrg()).id
    adminId = (await minimal.person(orgId, { role: "admin" })).id
    adminToken = await minimal.token(adminId)
    memberId = (await minimal.person(orgId, { role: "member" })).id
    memberToken = await minimal.token(memberId)
    await sql`UPDATE kernel.users SET name = 'Morgan Member' WHERE id = ${memberId}`
    await ensureAppsForOrg(orgId)
  }, 180_000)

  afterAll(releaseTestLock)

  it("an org save of a connection that names no account never meets the saver's personal one", async () => {
    const personal = await post(adminToken, "/api/connections/test/service/credentials", {
      mode: "personal",
      credentials: { token: "glpat-personal", group: "acme" },
    })
    expect(personal.status).toBe(201)
    const org = await post(adminToken, "/api/connections/test/service/credentials", {
      mode: "org",
      credentials: { token: "glpat-org", group: "acme" },
    })
    expect(org.status).toBe(201)
    expect(await active("test", "service")).toEqual([
      { owner_type: "org", owner_id: null, identifier: orgId },
      { owner_type: "user", owner_id: adminId, identifier: adminId },
    ])
  })

  it("an org save of a mailbox a member holds personally is a 409 that names the member", async () => {
    const address = `shared-${crypto.randomUUID().slice(0, 8)}@example.com`
    expect(
      (
        await post(memberToken, "/api/connections/mail/imap/credentials", {
          mode: "personal",
          credentials: imap(address),
        })
      ).status,
    ).toBe(201)
    const org = await post(adminToken, "/api/connections/mail/imap/credentials", {
      mode: "org",
      credentials: imap(address),
    })
    expect(org.status).toBe(409)
    expect(org.body.error.code).toBe("connection_held_by_member")
    expect(org.body.error.message).toContain("Morgan Member")
    expect(org.body.error.details).toMatchObject({ memberName: "Morgan Member" })
    // Nothing changed: the member's account is still theirs and active.
    const rows = (await active("mail", "imap")).filter((r) => r.identifier === address)
    expect(rows).toEqual([{ owner_type: "user", owner_id: memberId, identifier: address }])
  })

  it("takeOver: true retires the member's account, emits its disconnect and tells the member", async () => {
    const address = `taken-${crypto.randomUUID().slice(0, 8)}@example.com`
    await post(memberToken, "/api/connections/mail/imap/credentials", {
      mode: "personal",
      credentials: imap(address),
    })
    const org = await post(adminToken, "/api/connections/mail/imap/credentials", {
      mode: "org",
      takeOver: true,
      credentials: imap(address),
    })
    expect(org.status).toBe(201)
    const rows = (await active("mail", "imap")).filter((r) => r.identifier === address)
    expect(rows).toEqual([{ owner_type: "org", owner_id: null, identifier: address }])

    const [queued] = await sql<{ payload: AppEvent }[]>`
      SELECT payload FROM kernel.pending_events
      WHERE org_id = ${orgId}
        AND payload->>'entity' = 'connected_account' AND payload->>'action' = 'disconnect'
        AND payload->'data'->>'identifier' = ${address}`
    expect(queued?.payload.data).toMatchObject({
      reason: "taken_over",
      ownerType: "user",
      ownerId: memberId,
      appName: "mail",
      connectionName: "imap",
    })
    expect(queued?.payload.actorId).toBe(adminId)

    await processTranslationEvent(queued?.payload as AppEvent)
    const [alert] = await sql<{ kind: string; summary: string }[]>`
      SELECT kind, summary FROM kernel.attention_events
      WHERE org_id = ${orgId} AND user_id = ${memberId} AND kind = 'system_alert'
      ORDER BY created_at DESC LIMIT 1`
    expect(alert?.summary).toContain(address)
  })

  it("a personal save of an account the organization holds is a 409 that names the conflict", async () => {
    const address = `ops-${crypto.randomUUID().slice(0, 8)}@example.com`
    const org = await post(adminToken, "/api/connections/mail/imap/credentials", {
      mode: "org",
      credentials: imap(address),
    })
    expect(org.status).toBe(201)
    const personal = await post(memberToken, "/api/connections/mail/imap/credentials", {
      mode: "personal",
      credentials: imap(address),
    })
    expect(personal.status).toBe(409)
    expect(personal.body.error.message).toContain("already connected for the whole organization")
    const rows = (await active("mail", "imap")).filter((r) => r.identifier === address)
    expect(rows).toEqual([{ owner_type: "org", owner_id: null, identifier: address }])
  })
})

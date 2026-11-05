// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A helper that catches a unique violation (23505) and answers a typed result must
// leave its caller's transaction USABLE. Postgres aborts the whole transaction on
// the first error, so a catch that is not inside its own SAVEPOINT (or an INSERT that
// is not ON CONFLICT DO NOTHING) turns the caller's next statement into 25P02
// "current transaction is aborted". Every case below triggers the conflict inside a
// transaction and then issues ANOTHER statement on that same transaction.
//
// The static ratchet for this class is swallowed-db-error.guard.test.ts.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { createMcpConnection } from "~/apps/mcp-manager/service/connections"
import { buildMcpWorld, type McpTestWorld } from "~/apps/mcp-manager/test-helpers/world"
import { runAdminOp } from "~/apps/tickets/admin"
import { createTicket } from "~/apps/tickets/create"
import { extractRows } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { contacts } from "~/db/schema/kernel"
import { hashToken } from "~/lib/crypto"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { inviteRegister } from "~/modules/auth/auth"
import { autoProvisionUser, OAuthEmailTakenError } from "~/modules/auth/oauth"
import { resolveContact } from "~/modules/contacts/service"
import { setContactSharing } from "~/modules/contacts/sharing"
import { pgLockWaiters } from "~/tests/helpers/pg-lock-waiters"
import { waitFor } from "~/tests/helpers/wait-for"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const rows = (r: unknown): any[] => (r as any).rows ?? r

/** One statement on the transaction under test: throws 25P02 if it is aborted. */
async function probe(tx: { execute: (q: any) => Promise<unknown> }): Promise<number> {
  return Number(extractRows<{ ok: number }>(await tx.execute(drizzleSql`SELECT 1 AS ok`))[0]?.ok)
}

function pgCode(err: unknown): string | undefined {
  let e: any = err
  for (let i = 0; i < 5 && e; i++) {
    if (typeof e.code === "string") return e.code
    e = e.cause
  }
  return undefined
}

let orgId: string
let userId: string
let roleId: string
const actor = () => ({ actorType: "user" as const, userId })

beforeAll(async () => {
  await acquireTestLock()
  const slug = `swallow-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await withSystemDb("swallowed-db-error-fixture", async (tx) => {
    orgId = rows(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.organizations (id, name, slug)
        VALUES (gen_random_uuid(), 'Swallow Test', ${slug}) RETURNING id`),
    )[0].id
    userId = rows(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
        VALUES (gen_random_uuid(), ${orgId}, ${`u-${slug}@x.test`}, 'A', 'active', 'h', 1, 1) RETURNING id`),
    )[0].id
    roleId = rows(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.roles (id, org_id, name) VALUES (gen_random_uuid(), ${orgId}, 'member')
        RETURNING id`),
    )[0].id
  })
  await ensureAppsForOrg(orgId, {})
})

afterAll(async () => {
  await releaseTestLock()
})

describe("a caught unique violation leaves the caller's transaction usable", () => {
  it("tickets templatesCreate: a lost name race answers name_exists and the tx lives on", async () => {
    const params = { name: `Race macro ${Date.now()}`, bodyText: "hello" }
    let releaseA!: () => void
    const gateA = new Promise<void>((r) => {
      releaseA = r
    })
    let markInserted!: () => void
    const aInserted = new Promise<void>((r) => {
      markInserted = r
    })
    const txA = withPrivilegedDb(orgId, "swallow-template-a", async (tx) => {
      const r = await runAdminOp(tx as never, orgId, "templatesCreate", params, actor())
      markInserted()
      await gateA
      return r
    })
    await aInserted
    const txB = withPrivilegedDb(orgId, "swallow-template-b", async (tx) => {
      const r = await runAdminOp(tx as never, orgId, "templatesCreate", params, actor())
      return { r, ok: await probe(tx) }
    })
    // B's conflicting INSERT is queued behind A's uncommitted row.
    await waitFor(async () => (await pgLockWaiters()) > 0, { label: "B to block on A" })
    releaseA()
    const a = (await txA) as { id?: string }
    const b = await txB
    expect(a.id).toBeTruthy()
    expect((b.r as { error?: { code: string } }).error?.code).toBe("name_exists")
    expect(b.ok).toBe(1)
  })

  // tryQueueEvent treats the audit event as non-fatal and swallowed ANY error
  // from it on the caller's own transaction: a failed outbox INSERT then made
  // the admin op's result a lie, since the caller's commit could not happen.
  it("tickets tryQueueEvent: a failing event insert stays non-fatal and the tx lives on", async () => {
    const out = await withPrivilegedDb(orgId, "swallow-queue-event", async (tx) => {
      // Every queueEvent issues a statement Postgres rejects (22012), on
      // whichever transaction handle it was called on.
      const failing = (t: any): any =>
        new Proxy(t, {
          get(target, prop, recv) {
            if (prop === "queueEvent")
              return async () => void (await target.execute(drizzleSql`SELECT 1/0`))
            if (prop === "transaction")
              return (fn: (sp: any) => Promise<unknown>) =>
                target.transaction((sp: any) => fn(failing(sp)))
            return Reflect.get(target, prop, recv)
          },
        })
      const r = await runAdminOp(
        failing(tx),
        orgId,
        "templatesCreate",
        { name: `Event macro ${Date.now()}`, bodyText: "hi" },
        actor(),
      )
      return { r, ok: await probe(tx) }
    })
    expect((out.r as { id?: string }).id).toBeTruthy()
    expect(out.ok).toBe(1)
  })

  it("tickets inboxesCreate: a taken email answers inbox_email_taken and the tx lives on", async () => {
    const email = `inbox-${Date.now()}@x.test`
    const acct = await withSystemDb(
      "swallow-inbox-account",
      async (tx) =>
        rows(
          await tx.execute(drizzleSql`
          INSERT INTO kernel.connected_accounts
            (id, org_id, app_name, connection_name, owner_type, owner_id, provider_type, identifier, status, created_by, access_token_encrypted)
          VALUES (gen_random_uuid(), ${orgId}, 'tickets', ${email}, 'org', null, 'oauth2', ${email}, 'active', ${userId}, 'enc')
          RETURNING id`),
        )[0].id as string,
    )
    const out = await withPrivilegedDb(orgId, "swallow-inbox", async (tx) => {
      const p = { kind: "mailbox", name: "Dup", emailAddress: email, connectedAccountId: acct }
      const first = (await runAdminOp(tx as never, orgId, "inboxesCreate", p, actor())) as {
        id?: string
      }
      const second = await runAdminOp(tx as never, orgId, "inboxesCreate", p, actor())
      return { first, second, ok: await probe(tx) }
    })
    expect(out.first.id).toBeTruthy()
    expect((out.second as { error?: { code: string } }).error?.code).toBe("inbox_email_taken")
    expect(out.ok).toBe(1)
  })

  it("tickets createTicket: a duplicate external_message_id answers the typed drop, rolls back only its ticket, and the tx lives on", async () => {
    const subject = `dup-msg-${Date.now()}`
    const params = {
      subject,
      channel: "api" as const,
      initialMessage: {
        kind: "inbound" as const,
        fromEmail: "c@x.test",
        textBody: "hi",
        externalMessageId: `<${subject}@x.test>`,
      },
    }
    const out = await withPrivilegedDb(orgId, "swallow-ticket-msg", async (tx) => {
      const first = (await createTicket(tx as never, orgId, params as never, actor() as never)) as {
        ticketId?: string
      }
      const second = await createTicket(tx as never, orgId, params as never, actor() as never)
      const n = rows(
        await tx.execute(drizzleSql`
          SELECT count(*)::int AS n FROM app_tickets.tickets WHERE org_id = ${orgId} AND subject = ${subject}`),
      )[0].n as number
      return { first, second, n }
    })
    expect(out.first.ticketId).toBeTruthy()
    expect((out.second as { error?: { code: string } }).error?.code).toBe(
      "duplicate_external_message_id",
    )
    expect(out.n).toBe(1)
  })

  it("tickets createTicket: a duplicate externalRef surfaces the 23505 (webhook idempotency) and the tx lives on", async () => {
    const externalRef = `ext-${Date.now()}`
    const out = await withPrivilegedDb(orgId, "swallow-ticket-ref", async (tx) => {
      const params = { subject: "ref", channel: "api" as const, externalRef }
      const first = (await createTicket(tx as never, orgId, params as never, actor() as never)) as {
        ticketId?: string
      }
      let second: unknown
      let secondErr: unknown
      try {
        second = await createTicket(tx as never, orgId, params as never, actor() as never)
      } catch (err) {
        secondErr = err
      }
      return { first, second, secondErr, ok: await probe(tx) }
    })
    expect(out.first.ticketId).toBeTruthy()
    expect(out.second).toBeUndefined()
    expect(pgCode(out.secondErr)).toBe("23505")
    expect(out.ok).toBe(1)
  })

  it("auth autoProvisionUser: an existing user with that email is refused with the typed error, nothing is linked, the tx stays usable", async () => {
    const email = `oauth-${Date.now()}@x.test`
    const existingId = await withSystemDb("swallow-oauth-user", async (tx) => {
      return rows(
        await tx.execute(drizzleSql`
          INSERT INTO kernel.users (id, org_id, email, name, status, auth_version, permission_version)
          VALUES (gen_random_uuid(), ${orgId}, ${email}, 'Pre', 'active', 1, 1) RETURNING id`),
      )[0].id as string
    })
    const providerId = await withSystemDb("swallow-oauth-provider", async (tx) => {
      return rows(
        await tx.execute(drizzleSql`
          INSERT INTO kernel.oauth_providers (id, org_id, name, issuer_url, client_id, client_secret_encrypted)
          VALUES (gen_random_uuid(), ${orgId}, ${`idp-${Date.now()}`}, 'https://idp.example', 'cid', 'enc')
          RETURNING id`),
      )[0].id as string
    })
    const out = await withRlsContext(
      { actorType: "system", orgId, purpose: "webhook", scopes: ["kernel"] } as never,
      async (tx) => {
        const err = await autoProvisionUser(tx, {
          orgId,
          email,
          name: "New",
          providerId,
          externalSubject: `sub-${Date.now()}`,
          externalEmail: email,
          externalProfile: {},
        }).catch((e) => e)
        return { err, ok: await probe(tx) }
      },
    )
    expect(out.err).toBeInstanceOf(OAuthEmailTakenError)
    expect(out.ok).toBe(1)
    const linked = await withSystemDb("swallow-oauth-linked", async (tx) =>
      rows(
        await tx.execute(drizzleSql`
          SELECT id FROM kernel.oauth_accounts WHERE user_id = ${existingId}`),
      ),
    )
    expect(linked.length).toBe(0)
  })

  it("auth inviteRegister: an invite for an already registered email answers the typed error and keeps the invite", async () => {
    const email = `invitee-${Date.now()}@x.test`
    const token = `tok-${crypto.randomUUID()}`
    await withSystemDb("swallow-invite", async (tx) => {
      await tx.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status, auth_version, permission_version)
        VALUES (gen_random_uuid(), ${orgId}, ${email}, 'Pre', 'active', 1, 1)`)
      await tx.execute(drizzleSql`
        INSERT INTO kernel.invitations (org_id, email, role_id, token_hash, invited_by, expires_at)
        VALUES (${orgId}, ${email}, ${roleId}, ${hashToken(token)}, ${userId}, now() + interval '1 day')`)
    })
    const res = await inviteRegister(token, undefined, "Dup")
    expect(res).toEqual({ success: false, error: "Email already registered" })
    const accepted = await withSystemDb("swallow-invite-check", async (tx) =>
      rows(
        await tx.execute(drizzleSql`
          SELECT accepted_at FROM kernel.invitations WHERE token_hash = ${hashToken(token)}`),
      ),
    )
    expect(accepted[0].accepted_at).toBeNull()
  })

  it("contacts resolveContact: a handle collision answers 409 and the tx lives on", async () => {
    const out = await withPrivilegedDb(orgId, "swallow-contact", async (tx) => {
      // Occupy the handle the next nextval() will hand out.
      const n = Number(
        rows(await tx.execute(drizzleSql`SELECT nextval('kernel.contact_handle_seq') AS n`))[0].n,
      )
      await tx.insert(contacts).values({ orgId, handle: `@contact-${n + 1}`, name: "Squatter" })
      let status: number | undefined
      try {
        await resolveContact(
          tx as never,
          orgId,
          userId,
          { name: "No email, no phone" },
          { audience: "org" },
        )
      } catch (err) {
        status = (err as { status?: number }).status
      }
      return { status, ok: await probe(tx) }
    })
    expect(out.status).toBe(409)
    expect(out.ok).toBe(1)
  })

  it("contacts setContactSharing: sharing an address the org already has answers 409 and the tx lives on", async () => {
    const email = `share-clash-${Date.now()}@x.example`
    await withSystemDb("swallow-share-fixture", async (tx) => {
      await tx.insert(contacts).values({ orgId, handle: `@clash-org-${Date.now()}`, email })
    })
    const out = await withRlsContext(
      {
        actorType: "user",
        userId,
        orgId,
        scopes: ["kernel:contacts:read", "kernel:contacts:write"],
        dimensionGrants: {},
      },
      async (tx) => {
        const { contact } = await resolveContact(
          tx as never,
          orgId,
          userId,
          { email },
          { audience: "owner", ownerUserId: userId },
        )
        // resolveContact links the organisation's contact when one exists: make
        // a private one directly to reach the clash.
        const mine = contact?.orgAccess === "none" ? contact.id : null
        const privateId =
          mine ??
          rows(
            await tx.execute(drizzleSql`
              INSERT INTO kernel.contacts (org_id, handle, email, org_access, owner_user_id)
              VALUES (${orgId}, ${`@clash-mine-${Date.now()}`}, ${email}, 'none', ${userId})
              RETURNING id`),
          )[0].id
        let status: number | undefined
        try {
          await setContactSharing(tx as never, {
            orgId,
            userId,
            contactId: privateId,
            sharing: { orgAccess: "editor" },
          })
        } catch (err) {
          status = (err as { status?: number }).status
        }
        return { status, ok: await probe(tx) }
      },
    )
    expect(out.status).toBe(409)
    expect(out.ok).toBe(1)
  })

  // Last: buildMcpWorld's createTestOrg resets the org fixtures the cases above use.
  it("mcp-manager createMcpConnection: a lost slug race answers slug_exists and the tx lives on", async () => {
    const world: McpTestWorld = await buildMcpWorld()
    const input = { displayName: "Race ERP", httpUrl: "https://mcp.race-erp.example" }
    let releaseA!: () => void
    const gateA = new Promise<void>((r) => {
      releaseA = r
    })
    let markInserted!: () => void
    const aInserted = new Promise<void>((r) => {
      markInserted = r
    })
    // Tx A inserts the slug and holds its transaction open, so tx B's pre-check sees
    // nothing and B's INSERT blocks on A's uncommitted row: the real race.
    const txA = withRlsContext(world.admin, async (db) => {
      const r = await createMcpConnection({
        tx: db,
        orgId: world.org.id,
        actor: world.admin,
        input,
      })
      markInserted()
      await gateA
      return r
    })
    await aInserted
    const txB = withRlsContext(world.admin, async (db) => {
      const r = await createMcpConnection({
        tx: db,
        orgId: world.org.id,
        actor: world.admin,
        input,
      })
      return { r, ok: await probe(db) }
    })
    // B's conflicting INSERT is queued behind A's uncommitted row.
    await waitFor(async () => (await pgLockWaiters()) > 0, { label: "B to block on A" })
    releaseA()
    const a = await txA
    const b = await txB
    expect(a.ok).toBe(true)
    expect(b.r.ok).toBe(false)
    if (!b.r.ok) expect(b.r.error.code).toBe("slug_exists")
    expect(b.ok).toBe(1)
  })
})

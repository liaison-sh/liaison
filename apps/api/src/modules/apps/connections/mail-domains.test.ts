// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Allowed mail domains per org: a mailbox outside them is refused on connect,
// an empty list restricts nothing, and non-mailbox connections are untouched.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { updateOrgSchema } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withPrivilegedDb } from "~/db/privileged"
import {
  assertMailboxAllowed,
  isMailDomainAllowed,
  MailDomainNotAllowedError,
  normalizeMailDomains,
} from "~/modules/apps/connections/mail-domains"
import { createCredentialConnection } from "~/modules/apps/connections/service"

const suffix = crypto.randomUUID().slice(0, 8)
let orgId: string
let userId: string

async function setDomains(domains: unknown) {
  await db.execute(drizzleSql`
    UPDATE kernel.organizations
       SET settings = settings || jsonb_build_object('allowedMailDomains', ${JSON.stringify(domains)}::jsonb)
     WHERE id = ${orgId}::uuid`)
}

beforeAll(async () => {
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Mail domains', ${`mail-domains-${suffix}`}) RETURNING id`),
  )
  orgId = org.id
  const [user] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}, ${`u-${suffix}@corp.example`}, 'U', 'active', 'h', 1, 1)
      RETURNING id`),
  )
  userId = user.id
})

afterAll(async () => {
  await db.execute(drizzleSql`DELETE FROM kernel.connected_accounts WHERE org_id = ${orgId}::uuid`)
})

describe("allowed mail domains", () => {
  it("matches the address domain exactly, case-insensitively; empty allows all", () => {
    expect(isMailDomainAllowed("Ana@Acme.example", ["acme.example"])).toBe(true)
    expect(isMailDomainAllowed("ana@fabrikam.example", ["acme.example"])).toBe(false)
    expect(isMailDomainAllowed("ana@mail.acme.example", ["acme.example"])).toBe(false)
    expect(isMailDomainAllowed("ana@acme.example.evil.example", ["acme.example"])).toBe(false)
    expect(isMailDomainAllowed("not-an-address", ["acme.example"])).toBe(false)
    expect(isMailDomainAllowed("anyone@anywhere.example", [])).toBe(true)
    expect(normalizeMailDomains([" @Acme.example ", "acme.example", 3, ""])).toEqual([
      "acme.example",
    ])
  })

  it("the org settings PATCH accepts domains and refuses anything else", () => {
    expect(
      updateOrgSchema.safeParse({ settings: { allowedMailDomains: ["acme.example"] } }).success,
    ).toBe(true)
    expect(updateOrgSchema.safeParse({ settings: { allowedMailDomains: [] } }).success).toBe(true)
    expect(
      updateOrgSchema.safeParse({ settings: { allowedMailDomains: ["not a domain"] } }).success,
    ).toBe(false)
  })

  it("refuses connecting a mailbox outside the allowed domains, with a clear 403", async () => {
    await setDomains(["acme.example"])
    const attempt = withPrivilegedDb(orgId, "mail-domains-test", (tx) =>
      createCredentialConnection(tx, orgId, userId, "mail", "imap", {
        identifier: `someone-${suffix}@fabrikam.example`,
        credentials: { email: `someone-${suffix}@fabrikam.example`, password: "x" },
      }),
    )
    const err = await attempt.then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(MailDomainNotAllowedError)
    expect((err as MailDomainNotAllowedError).status).toBe(403)
    expect((err as Error).message).toContain("@acme.example")
    // Nothing was stored.
    const [row] = extractRows<{ n: number }>(
      await db.execute(drizzleSql`
        SELECT count(*)::int AS n FROM kernel.connected_accounts WHERE org_id = ${orgId}::uuid`),
    )
    expect(row.n).toBe(0)
    // Gmail (the OAuth callback's check) and Tickets' mailboxes follow the same rule.
    await expect(
      assertMailboxAllowed(orgId, "gmail", `someone-${suffix}@fabrikam.example`),
    ).rejects.toBeInstanceOf(MailDomainNotAllowedError)
    await expect(
      assertMailboxAllowed(orgId, "gmail", `someone-${suffix}@acme.example`),
    ).resolves.toBeUndefined()
    // A connection that is not a mailbox is not concerned.
    await expect(assertMailboxAllowed(orgId, "shopify", "shop.example")).resolves.toBeUndefined()
  })

  it("an IMAP login on another domain or account is refused, whatever the display address", async () => {
    await setDomains(["acme.example"])
    const address = `ana-${suffix}@acme.example`
    await expect(
      assertMailboxAllowed(orgId, "imap", address, `ana-${suffix}@gmail.com`),
    ).rejects.toBeInstanceOf(MailDomainNotAllowedError)
    await expect(
      assertMailboxAllowed(orgId, "imap", address, "someoneelse"),
    ).rejects.toBeInstanceOf(MailDomainNotAllowedError)
    await expect(
      assertMailboxAllowed(orgId, "imap", address, address.toUpperCase()),
    ).resolves.toBeUndefined()
    await expect(
      assertMailboxAllowed(orgId, "imap", address, `ana-${suffix}`),
    ).resolves.toBeUndefined()
    // Through the real connect path, the login is checked too.
    const err = await withPrivilegedDb(orgId, "mail-domains-login", (tx) =>
      createCredentialConnection(tx, orgId, userId, "mail", "imap", {
        identifier: address,
        credentials: { email: address, username: "boss@gmail.com", password: "x" },
      }),
    ).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(MailDomainNotAllowedError)
  })

  it("admins are told about a mailbox connected before the restriction", async () => {
    await setDomains([])
    await db.execute(drizzleSql`
      INSERT INTO kernel.connected_accounts
        (org_id, app_name, connection_name, owner_type, owner_id, provider_type, identifier, status, created_by)
      VALUES (${orgId}, 'mail', 'imap', 'user', ${userId}, 'credentials', ${`old-${suffix}@fabrikam.example`}, 'active', ${userId})`)
    const { computeConnectionHealthAttentionItems } = await import(
      "~/modules/apps/connections/attention"
    )
    const reasons = async () =>
      (await computeConnectionHealthAttentionItems(null as never, orgId, userId)).map(
        (i) => i.metadata?.reason,
      )
    expect(await reasons()).not.toContain("mail_domain_not_allowed")
    await setDomains(["acme.example"])
    expect(await reasons()).toContain("mail_domain_not_allowed")
  })

  it("an empty list lifts the restriction", async () => {
    await setDomains([])
    await expect(
      assertMailboxAllowed(orgId, "imap", `someone-${suffix}@fabrikam.example`),
    ).resolves.toBeUndefined()
  })
})

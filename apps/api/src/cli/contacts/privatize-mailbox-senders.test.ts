// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The one-time cleanup of the org contacts personal mailboxes created (design
// audit 2026-09-30, #6), in the sharing model: it classifies every org contact,
// makes exactly the personal-source ones their mailbox owner's private
// contacts (deleting nothing), the dry run writes nothing, and the backup
// restores every row.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { sql as drizzleSql } from "drizzle-orm"
import {
  executePrivatize,
  inspectPrivatize,
  parsePrivatizeArgv,
  restorePrivatize,
} from "~/cli/contacts/privatize-mailbox-senders"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withRlsContext } from "~/db/rls"

const suffix = crypto.randomUUID().slice(0, 8)
let orgId: string
let personId: string
let colleagueId: string
let colleagueAccountId: string
let personalAccountId: string
let sharedAccountId: string
const contact: Record<string, string> = {}
let strangerConversationId: string
const dir = mkdtempSync(path.join(tmpdir(), "privatize-senders-"))

async function one<T>(query: ReturnType<typeof drizzleSql>): Promise<T> {
  return extractRows<T>(await db.execute(query))[0] as T
}

async function newContact(key: string, extra: Record<string, unknown> = {}): Promise<void> {
  const row = await one<{ id: string }>(drizzleSql`
    INSERT INTO kernel.contacts (org_id, handle, email, name, created_by, tags, phone, external_ids)
    VALUES (${orgId}, ${`P-${key}-${suffix}`}, ${`${key}-${suffix}@x.example`}, ${key},
            ${(extra.createdBy as string) ?? null}, ${`{${((extra.tags as string[]) ?? []).join(",")}}`}::text[],
            ${(extra.phone as string) ?? null}, ${JSON.stringify(extra.externalIds ?? {})}::jsonb)
    RETURNING id`)
  contact[key] = row.id
  await db.execute(drizzleSql`
    INSERT INTO kernel.timeline_entries (org_id, app, entity_type, entity_id, actor_type, action, summary)
    VALUES (${orgId}, 'kernel', 'contact', ${row.id}, 'system', 'contact.create', 'created')`)
}

async function inbound(accountId: string, key: string): Promise<string> {
  const email = `${key}-${suffix}@x.example`
  const conversation = await one<{ id: string }>(drizzleSql`
    INSERT INTO app_mail.conversations
      (org_id, account_id, owner_type, external_thread_id, status, from_email, contact_id, message_count)
    VALUES (${orgId}, ${accountId}, 'user', ${`t-${key}-${accountId}`}, 'open', ${email},
            ${contact[key] ?? null}, 1)
    RETURNING id`)
  await db.execute(drizzleSql`
    INSERT INTO app_mail.messages
      (org_id, conversation_id, account_id, external_message_id, from_address, direction)
    VALUES (${orgId}, ${conversation.id}, ${accountId}, ${`<${key}-${accountId}@x>`},
            ${JSON.stringify({ email, name: key })}::jsonb, 'inbound')`)
  return conversation.id
}

async function sharing(key: string) {
  return one<{ org_access: string; owner_user_id: string | null; acl_user_ids: string[] }>(
    drizzleSql`SELECT org_access, owner_user_id::text AS owner_user_id, acl_user_ids
                 FROM kernel.contacts WHERE id = ${contact[key]}::uuid`,
  )
}

async function visibleTo(userId: string, key: string): Promise<boolean> {
  return withRlsContext(
    { actorType: "user", userId, orgId, scopes: ["kernel:contacts:read"], dimensionGrants: {} },
    async (tx) =>
      extractRows(
        await tx.execute(
          drizzleSql`SELECT 1 FROM kernel.contacts WHERE id = ${contact[key]}::uuid`,
        ),
      ).length === 1,
  )
}

beforeAll(async () => {
  orgId = (
    await one<{ id: string }>(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Privatize senders', ${`privatize-${suffix}`}) RETURNING id`)
  ).id
  personId = (
    await one<{ id: string }>(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
      VALUES (gen_random_uuid(), ${orgId}, ${`u-${suffix}@x.example`}, 'U', 'active', 'h')
      RETURNING id`)
  ).id
  colleagueId = (
    await one<{ id: string }>(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
      VALUES (gen_random_uuid(), ${orgId}, ${`c-${suffix}@x.example`}, 'C', 'active', 'h')
      RETURNING id`)
  ).id
  const { ensureAppsForOrg } = await import("~/modules/apps/init")
  await ensureAppsForOrg(orgId)
  // Mailboxes first: the provenance rule wants contacts created AFTER the
  // personal mailbox was connected.
  personalAccountId = (
    await one<{ id: string }>(drizzleSql`
      INSERT INTO app_mail.accounts
        (org_id, connected_account_id, owner_type, owner_id, provider, email_address, sync_status, created_at)
      VALUES (${orgId}, gen_random_uuid(), 'user', ${personId}, 'gmail', ${`me-${suffix}@x.example`},
              'active', now() - interval '1 day')
      RETURNING id`)
  ).id
  colleagueAccountId = (
    await one<{ id: string }>(drizzleSql`
      INSERT INTO app_mail.accounts
        (org_id, connected_account_id, owner_type, owner_id, provider, email_address, sync_status, created_at)
      VALUES (${orgId}, gen_random_uuid(), 'user', ${colleagueId}, 'gmail', ${`col-${suffix}@x.example`},
              'active', now() - interval '1 day')
      RETURNING id`)
  ).id
  sharedAccountId = (
    await one<{ id: string }>(drizzleSql`
      INSERT INTO app_mail.accounts
        (org_id, connected_account_id, owner_type, provider, email_address, sync_status, created_at)
      VALUES (${orgId}, gen_random_uuid(), 'org', 'gmail', ${`team-${suffix}@x.example`},
              'active', now() - interval '1 day')
      RETURNING id`)
  ).id

  await newContact("stranger") // personal mailbox only: privatized
  await newContact("newsletter") // personal mailbox only, never linked: privatized
  await newContact("twopeople") // wrote to two people's personal mailboxes: unclear
  await newContact("fromapp", { externalIds: { shopify: "gid://1" } }) // an app made it: kept
  await newContact("teamcustomer") // also wrote to the shared inbox: kept
  await newContact("humanmade", { createdBy: personId }) // a person made it: kept
  await newContact("tagged", { tags: ["vip"] }) // someone curated it: kept
  await newContact("phoned", { phone: `+33${Date.now()}` }) // carries more than mail sets: kept
  await newContact("ticketed") // a ticket points at it: kept
  await newContact("edited") // a person edited it (audit trail): kept
  await newContact("touched") // changed after creation, no audit row: kept
  await db.execute(drizzleSql`
    UPDATE kernel.contacts SET updated_at = created_at + interval '1 hour'
     WHERE id = ${contact.touched}::uuid`)

  strangerConversationId = await inbound(personalAccountId, "stranger")
  contact.newsletterUnlinked = contact.newsletter
  await inbound(personalAccountId, "newsletter")
  await db.execute(drizzleSql`
    UPDATE app_mail.conversations SET contact_id = NULL
     WHERE org_id = ${orgId}::uuid AND from_email = ${`newsletter-${suffix}@x.example`}`)
  await inbound(personalAccountId, "twopeople")
  await inbound(colleagueAccountId, "twopeople")
  await inbound(personalAccountId, "fromapp")
  for (const key of [
    "teamcustomer",
    "humanmade",
    "tagged",
    "phoned",
    "ticketed",
    "edited",
    "touched",
  ]) {
    await inbound(personalAccountId, key)
  }
  await inbound(sharedAccountId, "teamcustomer")
  await db.execute(drizzleSql`
    INSERT INTO app_tickets.tickets
      (org_id, handle, subject, status, priority, channel, reply_token, sla_target_seconds, contact_id)
    VALUES (${orgId}, ${`T-${suffix}`}, 's', 'open', 'normal', 'manual', ${`rt-${suffix}`}, 3600,
            ${contact.ticketed})`)
  await db.execute(drizzleSql`
    INSERT INTO kernel.audit_log (org_id, actor_id, actor_type, app, entity_type, entity_id, action)
    VALUES (${orgId}, ${personId}, 'user', 'kernel', 'contact', ${contact.edited}, 'contact.update')`)
}, 120_000)

afterAll(async () => {
  rmSync(dir, { recursive: true, force: true })
})

describe("contacts privatize-mailbox-senders", () => {
  it("parses a dry run by default and demands a backup to execute or restore", () => {
    const org = crypto.randomUUID()
    expect(parsePrivatizeArgv("privatize", ["--org", org])).toMatchObject({
      ok: true,
      args: { execute: false },
    })
    expect(parsePrivatizeArgv("privatize", ["--org", org, "--execute"]).ok).toBe(false)
    expect(parsePrivatizeArgv("restore", ["--org", org]).ok).toBe(false)
    expect(parsePrivatizeArgv("privatize", ["--org", "not-a-uuid"]).ok).toBe(false)
  })

  it("the dry run classifies every org contact and writes nothing", async () => {
    const report = await inspectPrivatize(orgId)
    expect(report.ids.sort()).toEqual([contact.newsletter, contact.stranger].sort())
    expect(report.byClass).toEqual({ org_intended: 3, personal_source: 2, unclear: 6 })
    expect(report.byReason).toMatchObject({
      "used by a team object": 1,
      "created by an app": 1,
      "wrote to a shared mailbox": 1,
      "created by a person, not used by any team object": 1,
      "wrote to several people's personal mailboxes": 1,
      "personal mailbox sender, but carries fields mail sync never sets": 2,
      "personal mailbox sender, but edited since it was created": 2,
      "personal mailbox sender": 2,
    })
    expect(report.byOwner).toEqual([{ ownerId: personId, name: "U", contacts: 2 }])
    // Read-only: every contact is still the organisation's.
    expect((await sharing("stranger")).org_access).toBe("editor")
  })

  it("execute backs up then makes them the owner's private contacts; restore puts them back", async () => {
    const backup = path.join(dir, "backup.json")
    const result = await executePrivatize(orgId, backup)
    expect(result).toMatchObject({ privatized: 2, skipped: 0 })
    expect(existsSync(backup)).toBe(true)
    expect(statSync(backup).mode & 0o777).toBe(0o600)
    for (const key of ["stranger", "newsletter"]) {
      expect(await sharing(key)).toEqual({
        org_access: "none",
        owner_user_id: personId,
        acl_user_ids: [personId],
      })
      // The owner still sees it; a colleague no longer does.
      expect(await visibleTo(personId, key)).toBe(true)
      expect(await visibleTo(colleagueId, key)).toBe(false)
    }
    // Nothing deleted, nothing else touched; the conversation keeps its link.
    for (const kept of [
      "teamcustomer",
      "humanmade",
      "tagged",
      "ticketed",
      "twopeople",
      "fromapp",
    ]) {
      expect((await sharing(kept)).org_access).toBe("editor")
    }
    const linked = await one<{ contact_id: string | null }>(drizzleSql`
      SELECT contact_id::text AS contact_id FROM app_mail.conversations WHERE id = ${strangerConversationId}::uuid`)
    expect(linked.contact_id).toBe(contact.stranger)
    const shareEvents = await one<{ n: number }>(drizzleSql`
      SELECT count(*)::int AS n FROM kernel.pending_events
       WHERE org_id = ${orgId}::uuid AND payload->>'entity' = 'contact' AND payload->>'action' = 'share'`)
    expect(shareEvents.n).toBe(2)
    // A second backup to the same path is refused, never overwritten.
    await expect(executePrivatize(orgId, backup)).rejects.toThrow(/already exists/)

    const restored = await restorePrivatize(orgId, backup)
    expect(restored).toEqual({ restored: 2, skipped: 0 })
    for (const key of ["stranger", "newsletter"]) {
      expect(await sharing(key)).toMatchObject({ org_access: "editor", owner_user_id: null })
      expect(await visibleTo(colleagueId, key)).toBe(true)
    }
  })
})

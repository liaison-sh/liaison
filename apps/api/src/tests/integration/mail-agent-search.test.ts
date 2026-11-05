// SPDX-License-Identifier: FSL-1.1-ALv2
//
// T-INT-8 part one (blueprint Task 9.6): `mail:search` against a sealed personal
// mailbox answers the STRUCTURED half server-side, unchanged, and routes only the
// free-text half to the client. It never silently drops the free-text term, and
// it never returns the structured rows as if they were the whole answer.
//
// The account fixture is the real one: a personal mailbox at
// `encryption_state = 'ready'` whose plaintext columns are NULL, exactly as they
// are after the backfill purge, plus a shared org mailbox that is untouched by
// any of this and proves the negatives are not vacuous.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db/connection"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { env } from "~/lib/env"
import { initializedOrgRuntimes, registeredApps, toolRegistry } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const orgId = "00000000-0000-0000-0000-00000058e001"
const userId = "00000000-0000-0000-0000-00000058e002"
const threadId = "00000000-0000-0000-0000-00000058e003"
const connectedAccountId = "00000000-0000-0000-0000-00000058e004"
const sealedAccountId = "00000000-0000-0000-0000-00000058e005"
const sharedAccountId = "00000000-0000-0000-0000-00000058e006"
const sealedConversationId = "00000000-0000-0000-0000-00000058e007"
const sharedConversationId = "00000000-0000-0000-0000-00000058e008"
// A second sealed conversation, so an id-narrowed retry has something to leave out.
const otherSealedConversationId = "00000000-0000-0000-0000-00000058e009"
const sealedMessageId = "00000000-0000-0000-0000-00000058e00a"
const otherSealedMessageId = "00000000-0000-0000-0000-00000058e00b"

const SHARED_PHRASE = "aardvark pricing question"

const actor = {
  actorType: "user" as const,
  userId,
  orgId,
  scopes: ["mail:conversations:read", "mail:accounts:read", "mail:messages:read"],
  dimensionGrants: { "mail:inbox": [sealedAccountId, sharedAccountId] },
}

async function search(params: Record<string, unknown>): Promise<any> {
  const result = await executeTool({
    toolName: "mail:search",
    orgId,
    actor,
    params,
    threadId,
    origin: "in-app-agent",
  })
  return (result as any).data ?? (result as any).result ?? result
}

describe("mail:search against a sealed personal mailbox", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await initSandboxPool()
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${orgId}, 'Mail Agent Search Org', 'mail-agent-search-org')
      ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (${userId}, ${orgId}, 'mail-agent-search@test.com', 'Search Tester', 'active', 'hash', 1, 1)
      ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${threadId}, ${orgId}, 'mail-agent-search-thread', 'agent_chat', ${userId})
      ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
      VALUES (${threadId}, ${userId}, ${orgId}, 'admin')
      ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
      VALUES
        (${userId}, ${orgId}, 'mail:conversations:read'),
        (${userId}, ${orgId}, 'mail:accounts:read'),
        (${userId}, ${orgId}, 'mail:messages:read')
      ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_dimension_grants (user_id, org_id, dimension_key, dimension_values)
      VALUES (${userId}, ${orgId}, 'mail:inbox', ${JSON.stringify([sealedAccountId, sharedAccountId])}::jsonb)
      ON CONFLICT DO NOTHING`

    await ensureAppsForOrg(orgId)

    await sql`INSERT INTO kernel.connected_accounts (
        id, org_id, app_name, connection_name, owner_type, owner_id,
        provider_type, identifier, status, created_by, access_token_encrypted
      ) VALUES (
        ${connectedAccountId}, ${orgId}, 'mail', 'gmail', 'user', ${userId},
        'oauth2', 'owner@example.com', 'active', ${userId},
        ${encryptSecret("mail-access-token", env.ENCRYPTION_KEY, CryptoContext.connectedAccountAccessToken)}
      ) ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO app_mail.accounts (
        id, org_id, connected_account_id, owner_type, owner_id, provider,
        email_address, display_name, sync_status, encryption_state
      ) VALUES (
        ${sealedAccountId}, ${orgId}, ${connectedAccountId}, 'user', ${userId}, 'gmail',
        'owner@example.com', 'Owner', 'active', 'ready'
      ) ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO app_mail.accounts (
        id, org_id, connected_account_id, owner_type, owner_id, provider,
        email_address, display_name, sync_status
      ) VALUES (
        ${sharedAccountId}, ${orgId}, ${connectedAccountId}, 'org', null, 'gmail',
        'support@example.com', 'Support', 'active'
      ) ON CONFLICT (id) DO NOTHING`

    // The sealed conversation: envelope columns present, every content column NULL.
    await sql`INSERT INTO app_mail.conversations (
        id, org_id, account_id, owner_type, owner_id, external_thread_id,
        subject, snippet, status, labels, is_read, is_starred, internal_thread_id,
        last_message_at, message_count
      ) VALUES (
        ${sealedConversationId}, ${orgId}, ${sealedAccountId}, 'user', ${userId}, 'gmail-thread-sealed',
        null, null, 'open', '["INBOX"]'::jsonb, false, false, null,
        now(), 1
      ) ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO app_mail.conversations (
        id, org_id, account_id, owner_type, owner_id, external_thread_id,
        subject, snippet, status, labels, is_read, is_starred, internal_thread_id,
        last_message_at, message_count
      ) VALUES (
        ${sharedConversationId}, ${orgId}, ${sharedAccountId}, 'org', null, 'gmail-thread-shared',
        ${SHARED_PHRASE}, ${SHARED_PHRASE}, 'open', '["INBOX"]'::jsonb, false, false, null,
        now(), 1
      ) ON CONFLICT (id) DO NOTHING`

    // A SECOND sealed conversation, and one sealed message in each. Phase two of
    // the client-search exchange narrows to the ids the browser matched, so
    // there has to be a row it must leave out for the narrowing to mean anything.
    await sql`INSERT INTO app_mail.conversations (
        id, org_id, account_id, owner_type, owner_id, external_thread_id,
        subject, snippet, status, labels, is_read, is_starred, internal_thread_id,
        last_message_at, message_count
      ) VALUES (
        ${otherSealedConversationId}, ${orgId}, ${sealedAccountId}, 'user', ${userId}, 'gmail-thread-sealed-2',
        null, null, 'open', '["INBOX"]'::jsonb, false, false, null,
        now() - interval '1 hour', 1
      ) ON CONFLICT (id) DO NOTHING`
    for (const [messageId, conversationId, externalId] of [
      [sealedMessageId, sealedConversationId, "sealed-1"],
      [otherSealedMessageId, otherSealedConversationId, "sealed-2"],
    ] as const) {
      // Content columns stay NULL: the plaintext invariant trigger rejects any
      // plaintext on an account at `encryption_state = 'ready'`.
      await sql`INSERT INTO app_mail.messages (
          id, org_id, conversation_id, account_id, external_message_id, message_references,
          from_address, to_addresses, cc_addresses, bcc_addresses, subject, text_body,
          html_body, snippet, is_read, is_starred, labels, direction, raw_headers, owner_type, owner_id
        ) VALUES (
          ${messageId}, ${orgId}, ${conversationId}, ${sealedAccountId}, ${externalId}, '[]'::jsonb,
          '{"email":"customer@example.com"}'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
          null, null, null, null, false, false, '[]'::jsonb, 'inbound', '{}'::jsonb, 'user', ${userId}
        ) ON CONFLICT (id) DO NOTHING`
    }
  })

  afterAll(async () => {
    await shutdownSandboxPool()
    toolRegistry.deleteByPrefix([orgId])
    registeredApps.delete(`${orgId}:mail`)
    registeredApps.delete(`${orgId}:test`)
    registeredApps.delete(`${orgId}:contacts`)
    initializedOrgRuntimes.delete(orgId)
    await sql`DELETE FROM app_mail.messages WHERE org_id = ${orgId}`
    await sql`DELETE FROM app_mail.conversations WHERE org_id = ${orgId}`
    await sql`DELETE FROM app_mail.accounts WHERE org_id = ${orgId}`
    await sql`DELETE FROM kernel.connected_accounts WHERE org_id = ${orgId}`
    await sql`DELETE FROM kernel.user_dimension_grants WHERE org_id = ${orgId}`
    await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${orgId}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${orgId}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${orgId}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${orgId}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${orgId}`
    await releaseTestLock()
  })

  it("non-vacuity: a structured-only query returns at least one envelope row", async () => {
    const result = await search({ accountId: sealedAccountId })
    expect(Array.isArray(result.items)).toBe(true)
    expect(result.items.length).toBeGreaterThan(0)
    expect(result.items[0].id).toBe(sealedConversationId)
    // Envelope columns are cleartext by design and still answer.
    expect(result.items[0].accountEmail).toBe("owner@example.com")
    // No free text was asked for, so nothing was left unanswered.
    expect(result.needsClientSearch).toBeUndefined()
  })

  it("a free-text query returns the marker and never a body or a snippet", async () => {
    const result = await search({ accountId: sealedAccountId, query: "aardvark" })
    expect(result.needsClientSearch.query).toBe("aardvark")
    expect(typeof result.unanswered).toBe("string")
    const serialized = JSON.stringify(result.items ?? [])
    expect(serialized).not.toContain(SHARED_PHRASE)
  })

  it("a mixed query answers the structured half AND names what went unanswered", async () => {
    const result = await search({
      accountId: sealedAccountId,
      unreadOnly: true,
      query: "aardvark",
    })
    expect(result.items.length).toBeGreaterThan(0)
    expect(result.items[0].id).toBe(sealedConversationId)
    expect(result.needsClientSearch).toBeDefined()
    expect(result.unanswered).toContain("aardvark")
  })

  // T-INT-8 part two: the retry. The browser answered with ids and the broker
  // hands them back on `__mailboxSearchIds`. Before this was wired, the retry ran
  // the identical query, raised the identical marker, and the browser's answer
  // was thrown away, so an agent free-text search over a sealed mailbox could
  // never return a hit.
  it("the retry narrows to the ids the browser matched and asks nothing further", async () => {
    // Non-vacuity: unnarrowed, this query sees BOTH sealed conversations.
    const wide = await search({ accountId: sealedAccountId })
    expect(wide.items.map((i: { id: string }) => i.id).sort()).toEqual(
      [sealedConversationId, otherSealedConversationId].sort(),
    )

    const result = await search({
      accountId: sealedAccountId,
      query: "aardvark",
      __mailboxSearchIds: [sealedMessageId],
      __mailboxSearchIndexComplete: true,
    })

    expect(result.needsClientSearch).toBeUndefined()
    expect(result.items.map((i: { id: string }) => i.id)).toEqual([sealedConversationId])
  })

  it("a browser that matched nothing narrows to nothing, and still does not ask again", async () => {
    const result = await search({
      accountId: sealedAccountId,
      query: "aardvark",
      __mailboxSearchIds: [],
      __mailboxSearchIndexComplete: true,
    })

    expect(result.needsClientSearch).toBeUndefined()
    expect(result.items).toEqual([])
  })

  it("a browser with no index leaves the structured rows alone and names the unanswered half", async () => {
    const result = await search({
      accountId: sealedAccountId,
      query: "aardvark",
      __mailboxSearchIds: [],
      __mailboxSearchIndexComplete: false,
    })

    expect(result.needsClientSearch).toBeUndefined()
    // An unbuilt index is not "no matches", so the structured answer stands.
    expect(result.items.length).toBeGreaterThan(0)
    expect(result.unanswered).toContain("aardvark")
  })

  it("the same free-text query against a shared mailbox is unchanged", async () => {
    const result = await search({ accountId: sharedAccountId, query: "aardvark" })
    expect(result.needsClientSearch).toBeUndefined()
    expect(result.unanswered).toBeUndefined()
  })
})

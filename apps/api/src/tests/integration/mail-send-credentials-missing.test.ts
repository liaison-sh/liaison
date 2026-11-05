// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Sending from a mailbox whose connection has no stored credentials (an IMAP
// mailbox added without its password, or one whose secret was cleared) is the
// person's to fix, not a server fault: the send answers 422
// `connection_credentials_missing` with what to do (reconnect it in Settings →
// Connections), never a 500 "No credentials stored". Both send paths: the tool
// (mail:reply) and the web's draft send (mail service sendReply).
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db/connection"
import { withRlsContext } from "~/db/rls"
import { initializedOrgRuntimes, registeredApps, toolRegistry } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { sendReply } from "~/modules/mail/service"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const orgId = "00000000-0000-0000-0000-0000005e8101"
const userId = "00000000-0000-0000-0000-0000005e8102"
const connectedAccountId = "00000000-0000-0000-0000-0000005e8104"
const accountId = "00000000-0000-0000-0000-0000005e8105"
const conversationId = "00000000-0000-0000-0000-0000005e8106"
const MAILBOX = "support-nocreds@example.com"

const SCOPES = [
  "mail:conversations:read",
  "mail:conversations:write",
  "mail:accounts:read",
  "mail:messages:read",
  "mail:messages:write",
]
const actor = {
  actorType: "user" as const,
  userId,
  orgId,
  scopes: SCOPES,
  dimensionGrants: { "mail:inbox": [accountId] },
}

describe("sending from a mailbox without stored credentials", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await initSandboxPool()
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${orgId}, 'Mail No Creds Org', 'mail-no-creds-org') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (${userId}, ${orgId}, 'mail-no-creds@test.com', 'No Creds', 'active', 'hash', 1, 1)
      ON CONFLICT (id) DO NOTHING`
    for (const scope of SCOPES) {
      await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
        VALUES (${userId}, ${orgId}, ${scope}) ON CONFLICT DO NOTHING`
    }
    await sql`INSERT INTO kernel.user_dimension_grants (user_id, org_id, dimension_key, dimension_values)
      VALUES (${userId}, ${orgId}, 'mail:inbox', ${JSON.stringify([accountId])}::jsonb)
      ON CONFLICT DO NOTHING`
    await ensureAppsForOrg(orgId)
    // An IMAP mailbox whose credentials were never stored.
    await sql`INSERT INTO kernel.connected_accounts (
        id, org_id, app_name, connection_name, owner_type, owner_id, status,
        provider_type, identifier, created_by
      ) VALUES (
        ${connectedAccountId}, ${orgId}, 'mail', 'imap', 'org', null, 'active',
        'credentials', ${MAILBOX}, ${userId}
      ) ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO app_mail.accounts (
        id, org_id, connected_account_id, owner_type, owner_id, provider,
        email_address, display_name, sync_status
      ) VALUES (
        ${accountId}, ${orgId}, ${connectedAccountId}, 'org', null, 'imap',
        ${MAILBOX}, 'Support', 'active'
      ) ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO app_mail.conversations (
        id, org_id, account_id, owner_type, owner_id, external_thread_id,
        subject, snippet, status, labels, is_read, is_starred, last_message_at, message_count
      ) VALUES (
        ${conversationId}, ${orgId}, ${accountId}, 'org', null, 'imap-thread-1',
        'Order question', 'When does it ship?', 'open', '["INBOX"]'::jsonb, false, false, now(), 1
      ) ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO app_mail.messages (
        id, org_id, conversation_id, account_id, external_message_id, external_provider_id,
        in_reply_to, message_references, from_address, to_addresses, cc_addresses,
        bcc_addresses, subject, text_body, html_body, snippet, is_read, is_starred,
        labels, direction, sent_at, synced_at, raw_headers, owner_type, owner_id
      ) VALUES (
        gen_random_uuid(), ${orgId}, ${conversationId}, ${accountId}, '<no-creds-1@example.com>', 'imap-1',
        null, '[]'::jsonb, '{"name":"Casey Customer","email":"casey@example.com"}'::jsonb,
        ${JSON.stringify([{ email: MAILBOX }])}::jsonb, '[]'::jsonb,
        '[]'::jsonb, 'Order question', 'When does it ship?', null, 'When does it ship?', false, false,
        '["INBOX"]'::jsonb, 'inbound', now(), now(), '{}'::jsonb, 'org', null
      ) ON CONFLICT DO NOTHING`
  })

  afterAll(async () => {
    await shutdownSandboxPool()
    toolRegistry.deleteByPrefix([orgId])
    registeredApps.delete(`${orgId}:mail`)
    initializedOrgRuntimes.delete(orgId)
    await sql`DELETE FROM kernel.pending_events WHERE org_id = ${orgId}`
    await sql`DELETE FROM kernel.user_dimension_grants WHERE org_id = ${orgId}`
    await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${orgId}`
    await sql`DELETE FROM app_mail.messages WHERE org_id = ${orgId}`
    await sql`DELETE FROM app_mail.conversations WHERE org_id = ${orgId}`
    await sql`DELETE FROM app_mail.accounts WHERE org_id = ${orgId}`
    await sql`DELETE FROM kernel.connected_accounts WHERE org_id = ${orgId}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${orgId}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${orgId}`
    await releaseTestLock()
  })

  type Typed = Error & { status?: number; code?: string }
  const expectCredentialsMissing = (err: Typed | null) => {
    expect(err).not.toBeNull()
    expect({ status: err?.status, code: err?.code }).toEqual({
      status: 422,
      code: "connection_credentials_missing",
    })
    expect(err?.message).toContain("Reconnect it in Settings → Connections")
    expect(err?.message).not.toContain("No credentials stored")
  }

  it("the person's reply (mail:reply) answers 422 connection_credentials_missing, saying to reconnect", async () => {
    const err = (await executeTool({
      toolName: "mail:reply",
      orgId,
      actor,
      params: { conversationId, textBody: "It ships tomorrow." },
      origin: "human-ui",
    }).then(
      () => null,
      (e: unknown) => e,
    )) as Typed | null
    expectCredentialsMissing(err)
  })

  it("the web's draft send (mail service sendReply) answers the same", async () => {
    const err = (await withRlsContext(actor, (tx) =>
      sendReply(tx, {
        orgId,
        userId,
        conversationId,
        htmlBody: "<p>It ships tomorrow.</p>",
        textBody: "It ships tomorrow.",
      }),
    ).then(
      () => null,
      (e: unknown) => e,
    )) as Typed | null
    expectCredentialsMissing(err)
  })
})

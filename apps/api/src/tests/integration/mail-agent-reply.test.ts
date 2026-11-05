// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { __privileged_db__ as db, sql } from "~/db/connection"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { env } from "~/lib/env"
import { ALL_DEFERRED_TOOLS_UNLOCKED, buildToolSet } from "~/modules/agent/tools/tool-bridge"
import { decideApproval } from "~/modules/approvals/decide"
import { initializedOrgRuntimes, registeredApps, toolRegistry } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { SandboxBridgeTestAccess } from "~/modules/apps/sandbox/rpc-bridge"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const orgId = "00000000-0000-0000-0000-0000005d3101"
const userId = "00000000-0000-0000-0000-0000005d3102"
const threadId = "00000000-0000-0000-0000-0000005d3103"
const connectedAccountId = "00000000-0000-0000-0000-0000005d3104"
const accountId = "00000000-0000-0000-0000-0000005d3105"
const conversationId = "00000000-0000-0000-0000-0000005d3106"

const actor = {
  actorType: "user" as const,
  userId,
  orgId,
  scopes: [
    "mail:conversations:read",
    "mail:conversations:write",
    "mail:accounts:read",
    "mail:messages:read",
    "mail:messages:write",
    "mail:approve",
  ],
  dimensionGrants: { "mail:inbox": [accountId] },
}

const noGrantActor = {
  ...actor,
  dimensionGrants: {},
}

async function messageCount(): Promise<number> {
  const [row] = extractRows<{ count: number }>(
    await db.execute(drizzleSql`
    SELECT COUNT(*)::int AS count
    FROM app_mail.messages
    WHERE conversation_id = ${conversationId}
  `),
  )
  return row.count
}

describe("agent-driven mail.reply gated flow", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await initSandboxPool()
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${orgId}, 'Mail Agent Reply Org', 'mail-agent-reply-org')
      ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (${userId}, ${orgId}, 'mail-agent-reply@test.com', 'Reply Tester', 'active', 'hash', 1, 1)
      ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${threadId}, ${orgId}, 'mail-agent-reply-thread', 'agent_chat', ${userId})
      ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
      VALUES (${threadId}, ${userId}, ${orgId}, 'admin')
      ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id)
      VALUES (${userId}, ${threadId}, ${orgId})
      ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
      VALUES
        (${userId}, ${orgId}, 'mail:conversations:read'),
        (${userId}, ${orgId}, 'mail:conversations:write'),
        (${userId}, ${orgId}, 'mail:accounts:read'),
        (${userId}, ${orgId}, 'mail:messages:read'),
        (${userId}, ${orgId}, 'mail:messages:write'),
        (${userId}, ${orgId}, 'mail:approve')
      ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_dimension_grants (user_id, org_id, dimension_key, dimension_values)
      VALUES (${userId}, ${orgId}, 'mail:inbox', ${JSON.stringify([accountId])}::jsonb)
      ON CONFLICT DO NOTHING`

    await ensureAppsForOrg(orgId)

    await sql`INSERT INTO kernel.connected_accounts (
        id, org_id, app_name, connection_name, owner_type, owner_id,
        provider_type, identifier, status, created_by, access_token_encrypted
      ) VALUES (
        ${connectedAccountId}, ${orgId}, 'mail', 'gmail', 'org', null,
        'oauth2', 'support@example.com', 'active', ${userId}, ${encryptSecret("mail-access-token", env.ENCRYPTION_KEY, CryptoContext.connectedAccountAccessToken)}
      ) ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO app_mail.accounts (
        id, org_id, connected_account_id, owner_type, owner_id, provider,
        email_address, display_name, sync_status
      ) VALUES (
        ${accountId}, ${orgId}, ${connectedAccountId}, 'org', null, 'gmail',
        'support@example.com', 'Support', 'active'
      ) ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO app_mail.conversations (
        id, org_id, account_id, owner_type, owner_id, external_thread_id,
        subject, snippet, status, labels, is_read, is_starred, internal_thread_id,
        last_message_at, message_count
      ) VALUES (
        ${conversationId}, ${orgId}, ${accountId}, 'org', null, 'gmail-thread-1',
        'Customer Question', 'Can you help?', 'open', '["INBOX"]'::jsonb, false, false, ${threadId},
        now(), 1
      ) ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO app_mail.messages (
        id, org_id, conversation_id, account_id, external_message_id, external_provider_id,
        in_reply_to, message_references, from_address, to_addresses, cc_addresses,
        bcc_addresses, subject, text_body, html_body, snippet, is_read, is_starred,
        labels, direction, sent_at, synced_at, raw_headers, owner_type, owner_id
      ) VALUES (
        gen_random_uuid(), ${orgId}, ${conversationId}, ${accountId}, '<mail-agent-reply-1>', 'gmail-message-1',
        null, '[]'::jsonb, '{"name":"Casey Customer","email":"casey@example.com"}'::jsonb,
        '[{"email":"support@example.com"}]'::jsonb, '[]'::jsonb,
        '[]'::jsonb, 'Customer Question', 'Can you help?', null, 'Can you help?', false, false,
        '["INBOX"]'::jsonb, 'inbound', now(), now(), '{}'::jsonb, 'org', null
      ) ON CONFLICT DO NOTHING`
  })

  beforeEach(async () => {
    SandboxBridgeTestAccess.setFetch(null)
    await sql`DELETE FROM app_mail.messages WHERE org_id = ${orgId} AND direction = 'outbound'`
    await sql`DELETE FROM kernel.pending_events WHERE org_id = ${orgId}`
    await sql`DELETE FROM kernel.approved_handler_executions WHERE org_id = ${orgId}`
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${orgId}`
  })

  afterAll(async () => {
    SandboxBridgeTestAccess.setFetch(null)
    await shutdownSandboxPool()
    toolRegistry.deleteByPrefix([orgId])
    registeredApps.delete(`${orgId}:mail`)
    registeredApps.delete(`${orgId}:test`)
    registeredApps.delete(`${orgId}:contacts`)
    initializedOrgRuntimes.delete(orgId)
    await sql`DELETE FROM kernel.pending_events WHERE org_id = ${orgId}`
    await sql`DELETE FROM kernel.approved_handler_executions WHERE org_id = ${orgId}`
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${orgId}`
    await sql`DELETE FROM kernel.user_dimension_grants WHERE org_id = ${orgId}`
    await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${orgId}`
    await sql`DELETE FROM app_mail.messages WHERE org_id = ${orgId}`
    await sql`DELETE FROM app_mail.conversations WHERE org_id = ${orgId}`
    await sql`DELETE FROM app_mail.accounts WHERE org_id = ${orgId}`
    await sql`DELETE FROM kernel.connected_accounts WHERE org_id = ${orgId}`
    await sql`DELETE FROM kernel.user_thread_state WHERE org_id = ${orgId}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${orgId}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${orgId}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${orgId}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${orgId}`
    await releaseTestLock()
  })

  it("returns blocked summary, persists approval row, and does not send", async () => {
    const beforeCount = await messageCount()

    const result = await executeTool({
      toolName: "mail:reply",
      orgId,
      actor,
      params: { conversationId, textBody: "Hi from agent" },
      threadId,
      origin: "in-app-agent",
    })

    expect(result.blocked?.reason).toBe("gated")
    expect(result.blocked?.summary?.kind).toBe("mail.reply")
    expect(result.blocked?.summary?.title).toBe("Customer Question")

    const rows = extractRows<{ summary: any; status: string }>(
      await db.execute(drizzleSql`
      SELECT summary, status
      FROM kernel.approval_requests
      WHERE id = ${result.blocked!.approvalRequestId!}
    `),
    )
    expect(rows[0].summary.title).toBe(result.blocked!.summary!.title)
    expect(rows[0].status).toBe("pending")
    expect(await messageCount()).toBe(beforeCount)
  })

  it("agent SDK bridge returns flattened blocked summary from mail__reply", async () => {
    // App tools are DEFERRED: the chat agent only sees one after tool_search
    // has surfaced it, and a caller with no discovery context sees none. This
    // case is about what the SDK bridge returns for a GATED call, not about
    // discovery, so it asks for the unlocked set the same way a sub-agent with
    // an explicit allowlist does.
    const toolSet = buildToolSet(orgId, actor, threadId, ALL_DEFERRED_TOOLS_UNLOCKED)

    const result = await toolSet.mail__reply.execute({ conversationId, textBody: "Hi from agent" })

    expect(result).toMatchObject({
      blocked: true,
      reason: "gated",
      approvalRequestId: expect.any(String),
      summary: expect.objectContaining({ kind: "mail.reply" }),
    })
  })

  it("approves mail.reply, sends through Gmail, and records external_ref", async () => {
    const providerMessageId = `gmail-message-approved-${Date.now()}`
    SandboxBridgeTestAccess.setFetch(
      (async () =>
        new Response(JSON.stringify({ id: providerMessageId, threadId: "gmail-thread-1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })) as unknown as typeof fetch,
    )

    const result = await executeTool({
      toolName: "mail:reply",
      orgId,
      actor,
      params: { conversationId, textBody: "Approved reply" },
      threadId,
      origin: "in-app-agent",
    })
    const approved = await decideApproval({
      orgId,
      requestId: result.blocked!.approvalRequestId!,
      actor,
      decision: "approve",
    })
    expect(approved.status).toBe("approved")
    const [exec] = await sql`
      SELECT status, external_ref
      FROM kernel.approved_handler_executions
      WHERE approval_request_id = ${result.blocked!.approvalRequestId!}
    `
    expect(exec.status).toBe("succeeded")
    expect(exec.external_ref).toMatchObject({
      provider: "gmail",
      messageId: providerMessageId,
      externalThreadId: "gmail-thread-1",
    })

    // The sent copy is announced so an open conversation and the list refresh
    // live: a message create naming the conversation and the mailbox (ids
    // only, never the body), and the conversation's own update.
    const [sent] = await sql`
      SELECT id FROM app_mail.messages
      WHERE conversation_id = ${conversationId} AND direction = 'outbound'
    `
    expect(sent?.id).toBeString()
    const events = await sql`
      SELECT payload FROM kernel.pending_events
      WHERE org_id = ${orgId} AND payload->>'app' = 'mail'
    `
    type MailEventRow = { entity: string; action: string; entityId: string; data: unknown }
    const payloads: MailEventRow[] = events.map((e) =>
      typeof e.payload === "string" ? JSON.parse(e.payload) : e.payload,
    )
    const created = payloads.find(
      (p) => p.entity === "message" && p.action === "create" && p.entityId === sent.id,
    )
    expect(created?.data).toMatchObject({
      id: sent.id,
      conversationId,
      accountId,
      direction: "outbound",
    })
    expect(JSON.stringify(created?.data)).not.toContain("Approved reply")
    expect(
      payloads.some(
        (p) =>
          p.entity === "conversation" && p.action === "update" && p.entityId === conversationId,
      ),
    ).toBe(true)
  })

  it("does not expose shared-inbox mail tools without the account dimension grant", async () => {
    const beforeCount = await messageCount()

    const search = await executeTool({
      toolName: "mail:search",
      orgId,
      actor: noGrantActor,
      params: { query: "Customer", limit: 10 },
    })
    expect(search.data).toMatchObject({ items: [], totalCount: 0 })

    let readErr: any = null
    try {
      await executeTool({
        toolName: "mail:read",
        orgId,
        actor: noGrantActor,
        params: { conversationId },
      })
    } catch (e) {
      readErr = e
    }
    expect(readErr?.code).toBe("NOT_FOUND")

    let replyErr: any = null
    try {
      await executeTool({
        toolName: "mail:reply",
        orgId,
        actor: noGrantActor,
        params: { conversationId, textBody: "This should not gate" },
        threadId,
      })
    } catch (e) {
      replyErr = e
    }
    expect(replyErr?.code).toBe("NOT_FOUND")

    const approvals = extractRows<{ count: number }>(
      await db.execute(drizzleSql`
        SELECT COUNT(*)::int AS count
        FROM kernel.approval_requests
        WHERE org_id = ${orgId}
      `),
    )
    expect(approvals[0].count).toBe(0)
    expect(await messageCount()).toBe(beforeCount)
  })
})

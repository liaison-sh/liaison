// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A person's own mailbox is read by them and their personal agent only. A SHARED agent (kind role
// or system) acting in that person's turn, holding every mail scope, still never reaches it: row
// level security leaves user-owned mailboxes out of its lists and searches (db/rls.ts marks the
// transaction, the mail tables' personalAgentOnly policies read the mark), and a call aimed at the
// person's own mailbox is refused with the personal agent to ask instead. Org mailboxes stay open
// to it, and the person's own personal agent keeps full access.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db/connection"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { env } from "~/lib/env"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { executeTool } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const orgId = "00000000-0000-0000-0000-00000059a001"
const userId = "00000000-0000-0000-0000-00000059a002"
const threadId = "00000000-0000-0000-0000-00000059a003"
const connectedAccountId = "00000000-0000-0000-0000-00000059a004"
const personalAccountId = "00000000-0000-0000-0000-00000059a005"
const orgAccountId = "00000000-0000-0000-0000-00000059a006"
const personalConversationId = "00000000-0000-0000-0000-00000059a007"
const orgConversationId = "00000000-0000-0000-0000-00000059a008"
const roleAgentId = "00000000-0000-0000-0000-00000059a009"
const personalAgentId = "00000000-0000-0000-0000-00000059a00a"

const MAIL_SCOPES = ["mail:conversations:read", "mail:conversations:write", "mail:accounts:read"]

const actor = {
  actorType: "user" as const,
  userId,
  orgId,
  scopes: MAIL_SCOPES,
  dimensionGrants: { "mail:inbox": [personalAccountId, orgAccountId] },
}

function frameOf(agentId: string, agentKind: "role" | "personal"): RunContext {
  return {
    runId: `run-${agentKind}`,
    parentRunId: null,
    rootRunId: `run-${agentKind}`,
    nestingDepth: 0,
    agentId,
    agentKind,
    agentCeiling: MAIL_SCOPES,
    effectiveScope: MAIL_SCOPES,
    turnScopeAccumulator: createTurnScopeAccumulator(),
  } as RunContext
}

async function call(
  as: "role" | "personal",
  toolName: string,
  params: Record<string, unknown>,
): Promise<any> {
  const frame = as === "role" ? frameOf(roleAgentId, "role") : frameOf(personalAgentId, "personal")
  // executeTool throws a refused call as a typed error (status, code, message): keep it as the
  // `error` envelope the agent's tool bridge would hand the model.
  try {
    return await runContextStore.run(frame, () =>
      executeTool({ toolName, orgId, actor, params, threadId, origin: "in-app-agent" }),
    )
  } catch (err) {
    const e = err as { code?: string; message?: string; status?: number }
    return { error: { code: e.code, message: e.message, status: e.status } }
  }
}

const data = (r: any) => r?.data ?? r

describe("a shared agent and a person's own mailbox", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await initSandboxPool()
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${orgId}, 'Shared Agent Mailbox Org', 'shared-agent-mailbox-org')
      ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (${userId}, ${orgId}, 'shared-agent-mailbox@test.com', 'Mailbox Owner', 'active', 'hash', 1, 1)
      ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${threadId}, ${orgId}, 'shared-agent-mailbox-thread', 'agent_chat', ${userId})
      ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
      VALUES (${threadId}, ${userId}, ${orgId}, 'admin')
      ON CONFLICT DO NOTHING`
    for (const scope of MAIL_SCOPES) {
      await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
        VALUES (${userId}, ${orgId}, ${scope}) ON CONFLICT DO NOTHING`
    }
    await sql`INSERT INTO kernel.user_dimension_grants (user_id, org_id, dimension_key, dimension_values)
      VALUES (${userId}, ${orgId}, 'mail:inbox', ${JSON.stringify([personalAccountId, orgAccountId])}::jsonb)
      ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling, system_prompt)
      VALUES (${roleAgentId}, ${orgId}, 'role', '@sam-commerce', 'Commerce', ${JSON.stringify(MAIL_SCOPES)}::jsonb, 'You help.')
      ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, owner_user_id, handle, display_name, scope_ceiling, system_prompt)
      VALUES (${personalAgentId}, ${orgId}, 'personal', ${userId}, '@owner-agent', 'Personal agent', ${JSON.stringify(MAIL_SCOPES)}::jsonb, 'You help.')
      ON CONFLICT (id) DO NOTHING`

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
        email_address, display_name, sync_status
      ) VALUES
        (${personalAccountId}, ${orgId}, ${connectedAccountId}, 'user', ${userId}, 'gmail',
         'owner@example.com', 'Owner', 'active'),
        (${orgAccountId}, ${orgId}, ${connectedAccountId}, 'org', null, 'gmail',
         'support@example.com', 'Support', 'active')
      ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO app_mail.conversations (
        id, org_id, account_id, owner_type, owner_id, external_thread_id,
        subject, snippet, status, labels, is_read, is_starred, last_message_at, message_count
      ) VALUES
        (${personalConversationId}, ${orgId}, ${personalAccountId}, 'user', ${userId}, 'thread-personal',
         'Order question', 'Order question', 'open', '["INBOX"]'::jsonb, false, false, now(), 0),
        (${orgConversationId}, ${orgId}, ${orgAccountId}, 'org', null, 'thread-org',
         'Order question', 'Order question', 'open', '["INBOX"]'::jsonb, false, false, now(), 0)
      ON CONFLICT (id) DO NOTHING`
  })

  afterAll(async () => {
    await shutdownSandboxPool()
    await sql`DELETE FROM app_mail.conversations WHERE org_id = ${orgId}`
    await sql`DELETE FROM app_mail.accounts WHERE org_id = ${orgId}`
    await sql`DELETE FROM kernel.connected_accounts WHERE org_id = ${orgId}`
    await sql`DELETE FROM kernel.agents WHERE org_id = ${orgId}`
    await sql`DELETE FROM kernel.user_dimension_grants WHERE org_id = ${orgId}`
    await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${orgId}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${orgId}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${orgId}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${orgId}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${orgId}`
    await releaseTestLock()
  })

  it("a shared agent's search leaves the personal mailbox out and keeps the org one", async () => {
    const ids = data(await call("role", "mail:search", {})).items.map((i: { id: string }) => i.id)
    expect(ids).toContain(orgConversationId)
    expect(ids).not.toContain(personalConversationId)
  })

  it("a shared agent's account list leaves the personal mailbox out", async () => {
    const out = JSON.stringify(data(await call("role", "mail:listAccounts", {})))
    expect(out).toContain(orgAccountId)
    expect(out).not.toContain(personalAccountId)
  })

  it("a shared agent's read of the personal mailbox is refused and names the personal agent", async () => {
    const result = await call("role", "mail:read", { conversationId: personalConversationId })
    expect(result.error?.code).toBe("personal_mailbox_shared_agent")
    expect(result.error?.message).toContain(
      "Personal mailboxes can only be read by their owner's personal agent",
    )
    expect(result.error?.message).toContain("@owner-agent")
    expect(result.error?.status).toBe(403)
  })

  it("a shared agent's reply on the personal mailbox is refused the same way", async () => {
    const result = await call("role", "mail:reply", {
      conversationId: personalConversationId,
      body: "Thanks, on its way.",
    })
    expect(result.error?.code).toBe("personal_mailbox_shared_agent")
    expect(result.error?.message).toContain("@owner-agent")
  })

  it("a shared agent still reads an org mailbox", async () => {
    const result = await call("role", "mail:read", { conversationId: orgConversationId })
    expect(result.error).toBeUndefined()
  })

  it("the person's own personal agent still sees and reads their mailbox", async () => {
    const ids = data(await call("personal", "mail:search", {})).items.map(
      (i: { id: string }) => i.id,
    )
    expect(ids).toContain(personalConversationId)
    expect(ids).toContain(orgConversationId)
    const read = await call("personal", "mail:read", { conversationId: personalConversationId })
    expect(read.error?.code).not.toBe("personal_mailbox_shared_agent")
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A person's own mailbox is read by them and their personal agent only. A SHARED agent (kind role
// or system) acting in that person's turn, holding every mail scope, still never reaches it: row
// level security leaves user-owned mailboxes out of its lists and searches (db/rls.ts marks the
// transaction, the mail tables' personalAgentOnly policies read the mark), and a call aimed at the
// person's own mailbox is refused with the personal agent to ask instead. Org mailboxes stay open
// to it, and the person's own personal agent keeps full access.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { executeTool } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { seedContext } from "~/seed/context"
import { seedPersonalAgent, upsertRoleAgent } from "~/seed/factories/agent/agents"
import { insertUnarmedMail, type MailMessageSpec } from "~/seed/factories/mail/conversations"
import { setUserDimension } from "~/seed/factories/people/user-dimensions"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const MAIL_SCOPES = ["mail:conversations:read", "mail:conversations:write", "mail:accounts:read"]

let orgId = ""
let userId = ""
let threadId = ""
let personalAccountId = ""
let orgAccountId = ""
let personalConversationId = ""
let orgConversationId = ""
let roleAgentId = ""
let personalAgentId = ""
let personalAgentHandle = ""

function actorOf() {
  return {
    actorType: "user" as const,
    userId,
    orgId,
    scopes: MAIL_SCOPES,
    dimensionGrants: { "mail:inbox": [personalAccountId, orgAccountId] },
  }
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
      executeTool({
        toolName,
        orgId,
        actor: actorOf(),
        params,
        threadId,
        origin: "in-app-agent",
      }),
    )
  } catch (err) {
    const e = err as { code?: string; message?: string; status?: number }
    return { error: { code: e.code, message: e.message, status: e.status } }
  }
}

const data = (r: any) => r?.data ?? r

const inbound = (fromEmail: string, toEmail: string): MailMessageSpec => ({
  direction: "inbound",
  fromName: "Customer",
  fromEmail,
  toName: "Mailbox",
  toEmail,
  hoursAgo: 2,
  body: "Where is my order?",
})

describe("a shared agent and a person's own mailbox", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await initSandboxPool()
    orgId = (await createTestOrg()).id
    await ensureAppsForOrg(orgId)
    const admin = await minimal.orgAdmin(orgId)
    const owner = await minimal.person(orgId, { name: "Mailbox Owner" })
    userId = owner.id
    threadId = await minimal.thread(orgId, userId, { title: "Shared agent mailbox" })
    for (const scope of MAIL_SCOPES) await minimal.grantScope(userId, scope)

    roleAgentId = (
      await upsertRoleAgent(orgId, {
        handle: "@sam-commerce",
        displayName: "Commerce",
        purpose: "Commerce",
        systemPrompt: "You help.",
        scopes: MAIL_SCOPES,
        toolAllowlist: null,
        modelPreference: null,
      })
    ).agentId
    const personal = await seedPersonalAgent(orgId, userId, "@owner-agent")
    personalAgentId = personal.agentId
    personalAgentHandle = personal.handle

    const mail = await insertUnarmedMail(seedContext({ orgId, now: new Date() }), {
      domain: "shared-agent-mailbox.test",
      mailboxes: [
        { box: "owner", ownerUserId: userId, email: "owner@example.com", displayName: "Owner" },
        { box: "org", ownerUserId: null, email: "support@example.com", displayName: "Support" },
      ],
      conversations: [
        {
          key: "personal",
          box: "owner",
          subject: "Order question",
          status: "open",
          labels: ["INBOX"],
          isRead: false,
          isStarred: false,
          messages: [inbound("customer@example.net", "owner@example.com")],
        },
        {
          key: "org",
          box: "org",
          subject: "Order question",
          status: "open",
          labels: ["INBOX"],
          isRead: false,
          isStarred: false,
          messages: [inbound("customer@example.net", "support@example.com")],
        },
      ],
    })
    ;[personalAccountId = "", orgAccountId = ""] = mail.accountIds
    ;[personalConversationId = "", orgConversationId = ""] = mail.conversationIds
    await setUserDimension(orgId, {
      adminUserId: admin.id,
      userId,
      dimension: "mail:inbox",
      values: [personalAccountId, orgAccountId],
    })
  }, 120_000)

  afterAll(async () => {
    await shutdownSandboxPool()
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
    expect(result.error?.message).toContain(personalAgentHandle)
    expect(result.error?.status).toBe(403)
  })

  it("a shared agent's reply on the personal mailbox is refused the same way", async () => {
    const result = await call("role", "mail:reply", {
      conversationId: personalConversationId,
      body: "Thanks, on its way.",
    })
    expect(result.error?.code).toBe("personal_mailbox_shared_agent")
    expect(result.error?.message).toContain(personalAgentHandle)
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

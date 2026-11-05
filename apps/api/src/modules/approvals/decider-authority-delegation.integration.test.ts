// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Approval is delegation: the approving human lends the execution their own
 * authority.
 *
 * An approved handler used to execute on the REQUESTER's scopes and dimension
 * grants alone, the decider being nothing but an audit id. So a teammate who
 * proposed a change needing a grant they lack (here: raising a Knowledge
 * document to `confidential` while holding only `internal`) produced a card an
 * org admin approved and watched fail with "Forbidden by Knowledge sensitivity
 * grant", a refusal no approver could ever clear.
 *
 * Driven end to end through the real path: executeTool parks the approval,
 * decideApproval re-reads BOTH parties' grants from the database, and the
 * handler writes through the production Knowledge bridge with whatever actor
 * the approval execution handed it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import knowledgeManifest from "~/apps/knowledge/app.manifest.json"
import { createKnowledgeDocument, knowledgeActorFromContext } from "~/apps/knowledge/service"
import { sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import { SINK_APP_KNOWLEDGE_DOCUMENTS } from "~/modules/agent/scopes/scope-taint"
import { ApprovalDecisionError, decideApproval } from "~/modules/approvals/decide"
import { toolRegistry } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = "00000000-0000-4000-8000-000000071001"
const REQUESTER = "00000000-0000-4000-8000-000000071002"
const ADMIN = "00000000-0000-4000-8000-000000071003"
const PLAIN_APPROVER = "00000000-0000-4000-8000-000000071004"
const THREAD = "00000000-0000-4000-8000-000000071005"

const WRITE = "delegation_test:gated:write"
const APPROVE = "delegation_test:approve"
const KNOWLEDGE = [
  "knowledge:documents:read",
  "knowledge:documents:create",
  "knowledge:documents:update",
]
const REQUESTER_SCOPES = [WRITE, "kernel:threads:write", ...KNOWLEDGE]
/** Holds the approve scope and the Knowledge scopes, but no sensitivity grant. */
const PLAIN_APPROVER_SCOPES = [APPROVE, ...KNOWLEDGE]

function context(
  userId: string,
  scopes: string[],
  dimensionGrants: Record<string, string[]>,
): UserContext {
  return { actorType: "user", userId, orgId: ORG, scopes, dimensionGrants }
}

const requester = () => context(REQUESTER, REQUESTER_SCOPES, { sensitivity: ["internal"] })

async function grant(userId: string, scopes: string[], dimensions: Record<string, string[]>) {
  await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG} AND user_id = ${userId}`
  await sql`DELETE FROM kernel.user_dimension_grants WHERE org_id = ${ORG} AND user_id = ${userId}`
  for (const scope of scopes) {
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
      VALUES (${userId}, ${ORG}, ${scope}) ON CONFLICT DO NOTHING`
  }
  for (const [key, values] of Object.entries(dimensions)) {
    await sql`INSERT INTO kernel.user_dimension_grants (user_id, org_id, dimension_key, dimension_values)
      VALUES (${userId}, ${ORG}, ${key}, ${JSON.stringify(values)}::jsonb)`
  }
}

/** An org document the requester owns, at the sensitivity they are granted. */
async function seedInternalDoc(title: string) {
  const actor = requester()
  return withRlsContext(actor, (tx) =>
    createKnowledgeDocument(
      tx,
      {
        documentScope: "organization",
        title,
        body: "v1",
        collectionIds: [],
        tagNames: [],
        team: [],
        sensitivity: "internal",
        orgAccess: "viewer",
        verifyNow: false,
      } as never,
      knowledgeActorFromContext(actor),
      [],
    ),
  )
}

async function proposeRaise(docId: string, revision: number): Promise<string> {
  const result = await executeTool({
    toolName: "delegation_test:raiseSensitivity",
    orgId: ORG,
    actor: requester(),
    params: { id: docId, revision, sensitivity: "confidential" },
    threadId: THREAD,
    origin: "in-app-agent",
  })
  return result.blocked!.approvalRequestId!
}

async function docRow(id: string) {
  const [row] = await sql`SELECT sensitivity, created_by, updated_by
    FROM app_knowledge.documents WHERE id = ${id}`
  return row as { sensitivity: string; created_by: string; updated_by: string | null }
}

describe("an approver lends the approved execution their own authority", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'Delegation Org', 'delegation-org') ON CONFLICT DO NOTHING`
    for (const [id, email, name] of [
      [REQUESTER, "delegation-requester@test.com", "Requester"],
      [ADMIN, "delegation-admin@test.com", "Admin"],
      [PLAIN_APPROVER, "delegation-plain@test.com", "Plain Approver"],
    ] as const) {
      await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
        VALUES (${id}, ${ORG}, ${email}, ${name}, 'active', 'hash') ON CONFLICT DO NOTHING`
    }
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${THREAD}, ${ORG}, 'delegation-thread', 'agent_chat', ${REQUESTER})
      ON CONFLICT DO NOTHING`
    for (const id of [REQUESTER, ADMIN, PLAIN_APPROVER]) {
      await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
        VALUES (${THREAD}, ${id}, ${ORG}, 'member') ON CONFLICT DO NOTHING`
    }
    await grant(REQUESTER, REQUESTER_SCOPES, { sensitivity: ["internal"] })
    await grant(ADMIN, ["*"], { "*": ["*"] })
    await grant(PLAIN_APPROVER, PLAIN_APPROVER_SCOPES, {})

    // A gated tool that updates a Knowledge document through the production
    // bridge, acting as exactly the actor the execution handed it: nothing in
    // the handler knows an approval, a requester or a decider exists.
    toolRegistry.set([ORG, "delegation_test", "raiseSensitivity"], {
      appName: "delegation_test",
      name: "raiseSensitivity",
      description: "Changes a Knowledge document's sensitivity",
      requiredScopes: [WRITE],
      gated: true,
      approveScope: APPROVE,
      approvalImpact: "internal",
      writesToTable: SINK_APP_KNOWLEDGE_DOCUMENTS,
      handler: async (params: any, ctx: any) => {
        const bridge = createRpcBridge(
          "knowledge",
          ctx.userId,
          ORG,
          ctx.db as never,
          knowledgeManifest as never,
          ctx.scopes,
          "user",
          undefined,
          { actor: context(ctx.userId, ctx.scopes, ctx.dimensionGrants) as never },
        ) as Record<string, (p: string) => Promise<string>>
        return JSON.parse(await bridge.knowledge_update!(JSON.stringify(params)))
      },
    } as any)
  })

  afterEach(async () => {
    await sql`DELETE FROM kernel.approved_handler_executions WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.pending_events WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
    await sql`DELETE FROM app_knowledge.documents WHERE org_id = ${ORG}`
  })

  afterAll(async () => {
    toolRegistry.deleteByPrefix([ORG])
    await releaseTestLock()
  })

  it("an admin approving a change the requester lacks the grant for executes it, attributed to the requester", async () => {
    const doc = await seedInternalDoc("Pricing rules")
    const approvalId = await proposeRaise(doc.id, doc.revision)

    const decided = await decideApproval({
      orgId: ORG,
      requestId: approvalId,
      actor: context(ADMIN, ["*"], { "*": ["*"] }),
      decision: "approve",
    })

    expect(decided.status).toBe("approved")
    const row = await docRow(doc.id)
    expect(row.sensitivity).toBe("confidential")
    // Authority is lent, identity is not: the write is still the requester's.
    expect(row.created_by).toBe(REQUESTER)
    expect(row.updated_by).toBe(REQUESTER)
  })

  it("an approver who does not hold the grant either cannot conjure it", async () => {
    const doc = await seedInternalDoc("Dealer margins")
    const approvalId = await proposeRaise(doc.id, doc.revision)

    let failure: unknown
    try {
      await decideApproval({
        orgId: ORG,
        requestId: approvalId,
        actor: context(PLAIN_APPROVER, PLAIN_APPROVER_SCOPES, {}),
        decision: "approve",
      })
    } catch (err) {
      failure = err
    }

    expect(failure).toBeInstanceOf(ApprovalDecisionError)
    expect((await docRow(doc.id)).sensitivity).toBe("internal")
  })
})

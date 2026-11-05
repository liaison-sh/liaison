// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An agent @-mentioned in a thread reads with the access of the person who
// asked, roles included. The thread route, a mention and a routine tick hand
// `invokeAgentForThread` the asker's scopes and grants but no roles; the turn
// then ran with an empty `app.current_roles`, so a Knowledge document shared
// only with a role (document_role_shares) was invisible there, even to a
// member of that role. The turn now loads the asker's roles. The read below is
// the real RLS policy, under the very actor the turn hands its tools.

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test"
import crypto from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { knowledgeRel } from "~/apps/knowledge/schema-refs"
import {
  createKnowledgeDocument,
  knowledgeActorFromContext,
  setDocumentSharing,
} from "~/apps/knowledge/service"
import { extractRows, type RlsClient, sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { threadParticipants, threads } from "~/db/schema/kernel"
import { AgentServiceTestAccess, invokeAgentForThread } from "~/modules/agent/runtime/agent-service"
import * as toolBridgeModule from "~/modules/agent/tools/tool-bridge"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { sendMessage } from "~/modules/threads/message"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORIG_ANTHROPIC_KEY = process.env.LIAISON_ANTHROPIC_API_KEY
const MODEL_ID = "claude-haiku-4-5-mention-roles"
const READ = "knowledge:documents:read"

function stubStreamText() {
  return {
    fullStream: (async function* () {
      yield { type: "text-delta", text: "ok" }
      yield {
        type: "finish-step",
        usage: { inputTokens: 10, outputTokens: 1 },
        finishReason: "stop",
      }
      yield { type: "finish", finishReason: "stop" }
    })(),
  } as never
}

let orgId: string
let roleId: string
let member: string
let outsider: string
let documentId: string
let threadId: string

/** The actor a mention turn hands its tools, for a message `userId` posted in the thread. */
async function mentionTurnActor(userId: string): Promise<UserContext> {
  const msg = await withPrivilegedDb(orgId, "test-mention-roles-msg", (tx) =>
    sendMessage(tx as unknown as RlsClient, {
      requiredScopes: [],
      orgId,
      userId,
      threadId,
      content: "@Liaison what does the finance plan say?",
      authorType: "user",
    }),
  )
  if (!msg) throw new Error("the asker could not post into the test thread")
  const { scopes, dimensionGrants } = await withPrivilegedDb(
    orgId,
    "test-mention-roles-perms",
    (tx) => loadEffectivePermissions(tx, userId, orgId),
  )
  const buildSpy = spyOn(toolBridgeModule, "buildToolSet")
  try {
    // What the thread route and the mention dispatch pass: no roles.
    await invokeAgentForThread(threadId, msg.id, { userId, orgId, scopes, dimensionGrants }, orgId)
    const turnActor = buildSpy.mock.calls[0]?.[1]
    if (turnActor?.actorType !== "user") throw new Error("the turn handed its tools no user actor")
    return turnActor
  } finally {
    buildSpy.mockRestore()
  }
}

async function visibleTo(actor: UserContext): Promise<number> {
  const rows = await withRlsContext(actor, async (tx) =>
    extractRows<{ id: string }>(
      await tx.execute(
        drizzleSql`SELECT id FROM ${knowledgeRel("documents")} WHERE id = ${documentId}::uuid`,
      ),
    ),
  )
  return rows.length
}

describe("a mention turn reads with the asker's roles", () => {
  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    AgentServiceTestAccess.setStreamText(stubStreamText as never)
    orgId = (await createTestOrg()).id
    const owner = (await minimal.person(orgId)).id
    member = (await minimal.person(orgId)).id
    outsider = (await minimal.person(orgId)).id
    for (const userId of [member, outsider]) await minimal.grantScope(userId, READ)
    roleId = crypto.randomUUID()
    await withPrivilegedDb(orgId, "test-mention-roles-setup", async (tx) => {
      await tx.execute(drizzleSql`INSERT INTO kernel.roles (id, org_id, name)
        VALUES (${roleId}::uuid, ${orgId}::uuid, ${`finance-${roleId.slice(0, 8)}`})`)
      await tx.execute(drizzleSql`INSERT INTO kernel.user_roles (user_id, role_id, org_id)
        VALUES (${member}::uuid, ${roleId}::uuid, ${orgId}::uuid)`)
      const [t] = await tx
        .insert(threads)
        .values({
          orgId,
          handle: `roles-${crypto.randomUUID().slice(0, 8)}`,
          type: "thread",
          createdBy: owner,
        })
        .returning({ id: threads.id })
      threadId = t.id
      for (const userId of [owner, member, outsider]) {
        await tx.insert(threadParticipants).values({ threadId, userId, orgId })
      }
    })
    // The document, written and shared the way the app writes it: shared with
    // the role only, so nobody else in the org can open it.
    const ownerScopes = [READ, "knowledge:documents:create", "knowledge:documents:update"]
    const ownerActor = knowledgeActorFromContext({
      orgId,
      userId: owner,
      scopes: ownerScopes,
      dimensionGrants: { sensitivity: ["*"], team: ["*"] },
      roles: [],
    })
    const ownerCtx: UserContext = {
      actorType: "user",
      orgId,
      userId: owner,
      scopes: ownerScopes,
      dimensionGrants: { sensitivity: ["*"], team: ["*"] },
    }
    const doc = await withRlsContext(ownerCtx, (tx) =>
      createKnowledgeDocument(
        tx,
        {
          documentScope: "organization",
          title: "Finance plan",
          body: "Margins.",
          collectionIds: [],
          tagNames: [],
          team: [],
          sensitivity: "confidential",
          orgAccess: "none",
          verifyNow: false,
        },
        ownerActor,
        [],
      ),
    )
    documentId = doc.id
    await withRlsContext(ownerCtx, (tx) =>
      setDocumentSharing(
        tx,
        documentId,
        {
          orgAccess: "none",
          editScope: null,
          shares: [],
          roleShares: [{ roleId, role: "viewer" }],
        },
        ownerActor,
      ),
    )
    await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency)
      VALUES (${orgId}, '10.00000000', '0', 'EUR')
      ON CONFLICT (org_id) DO UPDATE SET included_balance = '10.00000000'`
    await sql`INSERT INTO kernel.model_pricing (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum)
      VALUES ('anthropic', ${MODEL_ID}, 'Claude Haiku Mention Roles', '1.00', '5.00', 200000, true, 'starter')
      ON CONFLICT DO NOTHING`
  })

  afterAll(async () => {
    AgentServiceTestAccess.setStreamText()
    await sql`DELETE FROM kernel.model_pricing WHERE model_id = ${MODEL_ID}`
    if (ORIG_ANTHROPIC_KEY !== undefined) process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
    else delete process.env.LIAISON_ANTHROPIC_API_KEY
    await releaseTestLock()
  })

  test("a member of the role reads the role-shared document through the mentioned agent", async () => {
    const actor = await mentionTurnActor(member)
    expect(actor.roles).toContain(roleId)
    expect(await visibleTo(actor)).toBe(1)
  })

  test("a member without the role does not", async () => {
    const actor = await mentionTurnActor(outsider)
    expect(actor.roles ?? []).not.toContain(roleId)
    expect(await visibleTo(actor)).toBe(0)
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// spec-security.md "requiredScopes on messages": every agent message records
// the union of the declared scopes of every tool the turn invoked, and that tag
// is what the read-time visibility predicate gates the reply on. A reply that
// read scoped data and landed untagged is readable by the whole room, and
// `meta.hiddenRuns` stays empty for a reader who should have seen a marker
// instead of the body.
//
// The turn here is a REAL turn through the real dispatch: the tool set is the
// turn's own, the tool is scoped, and the reply is read back through
// `listMessages` as each viewer.

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test"
import crypto from "node:crypto"
import { z } from "zod"
import type { RlsClient } from "~/db"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { threadParticipants, threads } from "~/db/schema/kernel"
import { agents } from "~/db/schema/kernel/agents"
import { AgentServiceTestAccess, invokeAgentForThread } from "~/modules/agent/runtime/agent-service"
import { toolRegistry } from "~/modules/apps/app-registries"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { listMessages, sendMessage } from "~/modules/threads/message"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

setDefaultTimeout(60_000)

const ORIG_ANTHROPIC_KEY = process.env.LIAISON_ANTHROPIC_API_KEY
const MODEL_ID = "claude-haiku-4-5-reply-scope-tag"
const SCOPE = "rst:invoices:read"
const TOOL = "rst__supplierInvoicesList"
const ANSWER = "Three supplier invoices are unpaid, 4,120 EUR outstanding."

let orgId = ""
let requesterId = ""
let lackerId = ""
let agentId = ""
let threadId = ""

type StreamTools = Record<string, { execute?: (args: unknown) => Promise<unknown> }>

/** A turn that calls the scoped tool and then answers out of its result. */
function toolCallingStream(toolName: string) {
  return (opts: { tools?: StreamTools }) => ({
    fullStream: (async function* () {
      const toolDef = opts.tools?.[toolName]
      if (!toolDef?.execute) throw new Error(`${toolName} is not in the turn tool set`)
      yield { type: "tool-call", toolCallId: "call-rst-0", toolName, input: {} }
      const output = await toolDef.execute({})
      yield { type: "tool-result", toolCallId: "call-rst-0", toolName, input: {}, output }
      yield { type: "text-delta", text: ANSWER }
      yield {
        type: "finish-step",
        usage: { inputTokens: 10, outputTokens: 1 },
        finishReason: "stop",
      }
      yield { type: "finish", finishReason: "stop" }
    })(),
  })
}

async function actorFor(userId: string): Promise<UserContext> {
  const { scopes } = await withPrivilegedDb(orgId, "rst-actor", (tx) =>
    loadEffectivePermissions(tx, userId, orgId),
  )
  return { actorType: "user", userId, orgId, scopes, dimensionGrants: {} }
}

beforeAll(async () => {
  await acquireTestLock()
  process.env.LIAISON_ANTHROPIC_API_KEY = "sk-reply-scope-tag"
  orgId = (await createTestOrg()).id

  const requester = await minimal.person(orgId)
  requesterId = requester.id
  for (const scope of ["kernel:threads:read", "kernel:threads:write", SCOPE]) {
    await minimal.grantScope(requesterId, scope)
  }
  const lacker = await minimal.person(orgId)
  lackerId = lacker.id
  for (const scope of ["kernel:threads:read", "kernel:threads:write"]) {
    await minimal.grantScope(lackerId, scope)
  }

  agentId = await withPrivilegedDb(orgId, "rst-agent", async (tx) => {
    const [a] = await tx
      .insert(agents)
      .values({
        orgId,
        kind: "personal",
        ownerUserId: requesterId,
        handle: `@rst-${crypto.randomUUID().slice(0, 8)}`,
        displayName: "Finance Desk",
        scopeCeiling: [SCOPE, "kernel:threads:read", "kernel:threads:write"],
      })
      .returning({ id: agents.id })
    return a.id
  })

  toolRegistry.set([orgId, "rst", "supplierInvoicesList"], {
    appName: "rst",
    name: "supplierInvoicesList",
    description: `Supplier invoices, requiring ${SCOPE}`,
    requiredScopes: [SCOPE],
    handler: async () => ({ invoices: [{ id: "si-1", total: 412000 }] }),
    params: z.object({}),
  })

  await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency)
    VALUES (${orgId}, '10.00000000', '0', 'EUR')
    ON CONFLICT (org_id) DO UPDATE SET included_balance = '10.00000000'`
  await sql`INSERT INTO kernel.model_pricing (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum)
    VALUES ('anthropic', ${MODEL_ID}, 'Claude Haiku Reply Scope Tag', '1.00', '5.00', 200000, true, 'starter')
    ON CONFLICT DO NOTHING`

  // The room is the requester alone WHILE THE TURN RUNS: the room floor is the
  // intersection over its human members, so seating the low-scope reader first
  // would take the scoped tool out of the catalog and there would be nothing to
  // tag. The reader joins afterwards, which is the "later joiners" case: they
  // still need the scope on read (spec-security.md D3).
  threadId = await withPrivilegedDb(orgId, "rst-thread", async (tx) => {
    const [t] = await tx
      .insert(threads)
      .values({
        orgId,
        handle: `rst-${crypto.randomUUID().slice(0, 8)}`,
        type: "agent_chat",
        createdBy: requesterId,
      })
      .returning({ id: threads.id })
    await tx.insert(threadParticipants).values({ threadId: t.id, userId: requesterId, orgId })
    await tx
      .insert(threadParticipants)
      .values({ threadId: t.id, agentId, orgId, participantType: "agent" })
    return t.id
  })
})

afterAll(async () => {
  toolRegistry.deleteByPrefix([orgId, "rst"])
  AgentServiceTestAccess.setStreamText()
  if (ORIG_ANTHROPIC_KEY === undefined) delete process.env.LIAISON_ANTHROPIC_API_KEY
  else process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
  await sql`DELETE FROM kernel.messages WHERE org_id = ${orgId}`
  await sql`DELETE FROM kernel.model_pricing WHERE model_id = ${MODEL_ID}`
  await releaseTestLock()
})

describe("a turn that read scoped data", () => {
  it("tags its reply with the scope, and a reader without it sees a marker, not the body", async () => {
    const actor = await actorFor(requesterId)
    const msg = await withPrivilegedDb(orgId, "rst-user-msg", (tx) =>
      sendMessage(tx as unknown as RlsClient, {
        requiredScopes: [],
        orgId,
        userId: requesterId,
        threadId,
        content: "list our unpaid supplier invoices and the total outstanding",
        authorType: "user",
      }),
    )
    if (!msg) throw new Error("the requester could not post into the test thread")

    AgentServiceTestAccess.setStreamText(toolCallingStream(TOOL) as never)
    await invokeAgentForThread(
      threadId,
      msg.id,
      { userId: requesterId, orgId, scopes: actor.scopes, dimensionGrants: {} },
      orgId,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      agentId,
    )
    AgentServiceTestAccess.setStreamText()

    // THE TAG ON THE ROW. Not `{}` and not null: the turn read scoped data and
    // says so, which is the only thing the read-time predicate can gate on.
    const [reply] = await sql<{ id: string; required_scopes: string[] | null }[]>`
      SELECT id, required_scopes FROM kernel.messages
      WHERE thread_id = ${threadId} AND author_type = 'agent'
      ORDER BY created_at DESC LIMIT 1`
    expect(reply).toBeDefined()
    expect(reply.required_scopes).toContain(SCOPE)

    // The reader joins the room AFTER the turn, holding everything but SCOPE.
    await withPrivilegedDb(orgId, "rst-join", (tx) =>
      tx.insert(threadParticipants).values({ threadId, userId: lackerId, orgId }),
    )

    const requesterView = await withRlsContext(await actorFor(requesterId), (tx) =>
      listMessages(tx, { orgId, userId: requesterId, threadId, limit: 50 }),
    )
    if (!requesterView) throw new Error("the requester's read returned nothing")
    expect(requesterView.messages.some((m) => m.content === ANSWER)).toBe(true)

    const lackerActor = await actorFor(lackerId)
    const lackerView = await withRlsContext(lackerActor, (tx) =>
      listMessages(tx, { orgId, userId: lackerId, threadId, limit: 50 }),
    )
    if (!lackerView) throw new Error("the lacker's read returned nothing")
    expect(lackerView.messages.some((m) => m.content === ANSWER)).toBe(false)
    expect(lackerView.hiddenRuns.length).toBeGreaterThan(0)
  })
})

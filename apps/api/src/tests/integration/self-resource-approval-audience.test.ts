// SPDX-License-Identifier: FSL-1.1-ALv2
//
// EVERY APPROVAL A TAINTED TURN PARKS IS NARROWED; A WRITE TO ONE'S OWN RESOURCE IS ONE'S OWN TO
// DECIDE (scope-taint.ts, rule 13, 2026-11-03).
//
// Seen live: a personal agent read its owner's invoicing documents and orders on a turn whose
// thread also held outside text (the owner's mail), then wrote a memory note about a customer.
// Memory is an enforcing sink, so the taint let it through and named no audience; the
// outside-content hold parked it with the tool's own deciding scope (`kernel:agent:memory`, held
// by every Full Member), so every teammate was notified of a pending body made of invoicing data,
// and could read and decide it. These cases pin, through the real dispatch (executeTool):
//
//   1. a personal agent's tainted memory write parks for its owner alone: only the owner is
//      notified, reads and decides it; a teammate holding `kernel:agent:memory` (with or without
//      the turn's scopes) cannot read or decide it and gets no feed item;
//   2. the user's own memory (no acting agent) is routed the same way;
//   3. a role agent's tainted memory write (memory every user of the agent reads) keeps the org's
//      deciders, narrowed to holders of what the turn read (`taintAudienceMustHold`): a teammate
//      lacking it is not notified, cannot read the pending body and cannot decide it.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { sql } from "~/db/connection"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import type { RunContext } from "~/modules/agent/runtime/run-context"
import { runContextStore } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { computeApprovalAttentionItems } from "~/modules/approvals/attention"
import { ApprovalDecisionError, decideApproval } from "~/modules/approvals/decide"
import { toolRegistry } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { seedPersonalAgent, upsertRoleAgent } from "~/seed/factories/agent/agents"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

// Set up in beforeAll through createTestOrg and the minimal seed tier.
let ORG = ""
let OWNER = ""
/** The org's admin (holds every scope, so a decider of any approval). */
let ADMIN = ""
/** A teammate holding the memory scope and every scope the turn read. */
let HOLDER = ""
/** A teammate holding the memory scope only (the base "Full Member" role's grant). */
let LACKER = ""
let DM = ""
let PERSONAL_AGENT = ""
let ROLE_AGENT = ""

/** What the turn read before writing memory: invoicing documents and Shopify orders. */
const TURN_READ = ["invoicing:documents:read", "shopify:orders:read"]
const MEMORY = "kernel:agent:memory"

let owner: UserContext
let holder: UserContext
let lacker: UserContext

/** The person's context with the scopes they hold now (roles and direct grants). */
async function ctxOf(userId: string): Promise<UserContext> {
  const perms = await withPrivilegedDb(ORG, "self-resource-test-perms", (tx) =>
    loadEffectivePermissions(tx, userId, ORG),
  )
  return {
    actorType: "user",
    userId,
    orgId: ORG,
    scopes: perms.scopes,
    dimensionGrants: perms.dimensionGrants,
  }
}

/** A live turn of `agentId` (none: the user's own turn) that has read TURN_READ. */
function turnFrame(agentId: string | undefined): RunContext {
  const runId = crypto.randomUUID()
  const turnScopeAccumulator = createTurnScopeAccumulator({ orgId: ORG })
  turnScopeAccumulator.recordInjected(TURN_READ)
  return {
    runId,
    parentRunId: null,
    rootRunId: runId,
    nestingDepth: 0,
    turnScopeAccumulator,
    ...(agentId ? { agentId } : {}),
  }
}

async function parkMemoryWrite(
  agentId: string | undefined,
  toolName: string,
  params: Record<string, unknown>,
): Promise<string> {
  // The thread holds outside text (the owner's mail): a memory write is held for a person.
  await sql`UPDATE kernel.threads SET tainted = true WHERE id = ${DM}`
  const result = await runContextStore.run(turnFrame(agentId), () =>
    executeTool({ toolName, orgId: ORG, actor: owner, params, threadId: DM }),
  )
  const id = result.blocked?.approvalRequestId
  if (typeof id !== "string") throw new Error(`${toolName} did not park: ${JSON.stringify(result)}`)
  return id
}

async function row(id: string) {
  const [r] = (await sql`SELECT resource_owner_id, notify_user_ids, approve_scope, metadata, status
    FROM kernel.approval_requests WHERE id = ${id}`) as Array<{
    resource_owner_id: string | null
    notify_user_ids: string[]
    approve_scope: string
    metadata: { taintAudienceMustHold?: string[] } | null
    status: string
  }>
  if (!r) throw new Error(`approval ${id} not found`)
  return r
}

async function readableBy(as: UserContext, id: string): Promise<boolean> {
  const rows = await withRlsContext(as, async (tx) =>
    extractRows<{ id: string }>(
      await tx.execute(
        drizzleSql`SELECT id FROM kernel.approval_requests WHERE id = ${id}::uuid AND current_payload IS NOT NULL`,
      ),
    ),
  )
  return rows.length === 1
}

async function feedHas(as: UserContext, id: string): Promise<boolean> {
  const items = await withRlsContext(as, (tx) => computeApprovalAttentionItems(tx, ORG, as.userId))
  return items.some((i) => i.entityId === id)
}

async function decideError(as: UserContext, id: string): Promise<unknown> {
  return decideApproval({ orgId: ORG, requestId: id, actor: as, decision: "deny" }).then(
    () => null,
    (err: unknown) => err,
  )
}

describe("scope taint: a tainted turn's approvals are narrowed, one's own resource is one's own", () => {
  beforeAll(async () => {
    await acquireTestLock()
    ORG = (await createTestOrg()).id
    ADMIN = (await minimal.orgAdmin(ORG)).id
    OWNER = (await minimal.person(ORG)).id
    HOLDER = (await minimal.person(ORG)).id
    LACKER = (await minimal.person(ORG)).id
    // The owner and the holder hold the memory scope and what the turn read; the lacker only
    // what the base "Full Member" role gives (the memory scope).
    for (const userId of [OWNER, HOLDER]) {
      for (const scope of [MEMORY, ...TURN_READ]) await minimal.grantScope(userId, scope)
    }
    owner = await ctxOf(OWNER)
    holder = await ctxOf(HOLDER)
    lacker = await ctxOf(LACKER)

    PERSONAL_AGENT = (await seedPersonalAgent(ORG, OWNER, "owner-agent")).agentId
    ROLE_AGENT = (
      await upsertRoleAgent(ORG, {
        handle: "support",
        displayName: "Support",
        purpose: "Answers support questions",
        systemPrompt: "You answer support questions.",
        scopes: owner.scopes,
        toolAllowlist: null,
        modelPreference: null,
      })
    ).agentId
    DM = await minimal.thread(ORG, OWNER, { title: "Self resource DM" })
    await sql`UPDATE kernel.threads SET type = 'agent_chat' WHERE id = ${DM}`
    const { registerKernelAgentTools } = await import("~/modules/agent/tools/kernel-tools")
    await registerKernelAgentTools(ORG)
  }, 180_000)

  afterAll(async () => {
    toolRegistry.deleteByPrefix([ORG])
    await releaseTestLock()
  })

  it("a personal agent's tainted memory_create is notified to, readable by and decided by its owner only", async () => {
    const id = await parkMemoryWrite(PERSONAL_AGENT, "kernel:memory_create", {
      path: "reference/customer-acme.md",
      body: "Acme orders: 12 units at 40 EUR, order 1042, ships to 1 Rue de la Paix",
    })
    const r = await row(id)
    expect(r.resource_owner_id).toBe(OWNER)
    expect(r.notify_user_ids).toEqual([OWNER])
    expect(r.metadata?.taintAudienceMustHold).toEqual([...TURN_READ].sort())

    expect(await readableBy(owner, id)).toBe(true)
    expect(await feedHas(owner, id)).toBe(true)
    for (const teammate of [holder, lacker]) {
      expect(await readableBy(teammate, id)).toBe(false)
      expect(await feedHas(teammate, id)).toBe(false)
      const err = await decideError(teammate, id)
      expect(err).toBeInstanceOf(ApprovalDecisionError)
    }
    expect((await row(id)).status).toBe("pending")

    // The owner decides it.
    await decideApproval({ orgId: ORG, requestId: id, actor: owner, decision: "deny" })
    expect((await row(id)).status).toBe("denied")
  })

  it("the user's own memory write (no acting agent) is routed to the user alone", async () => {
    const id = await parkMemoryWrite(undefined, "kernel:user_memory_set", {
      type: "reference",
      name: "acme-pricing",
      description: "Acme pricing",
      content: "Acme pays 40 EUR a unit",
    })
    const r = await row(id)
    expect(r.resource_owner_id).toBe(OWNER)
    expect(r.notify_user_ids).toEqual([OWNER])
    expect(await readableBy(lacker, id)).toBe(false)
    expect(await feedHas(holder, id)).toBe(false)
  })

  it("a role agent's tainted memory write keeps the org's deciders, narrowed to holders of what the turn read", async () => {
    const id = await parkMemoryWrite(ROLE_AGENT, "kernel:memory_create", {
      path: "reference/acme-orders.md",
      body: "Acme order 1042: 12 units at 40 EUR",
    })
    const r = await row(id)
    expect(r.resource_owner_id).toBeNull()
    expect(r.approve_scope).toBe(MEMORY)
    expect(r.metadata?.taintAudienceMustHold).toEqual([...TURN_READ].sort())
    expect([...r.notify_user_ids].sort()).toEqual([ADMIN, OWNER, HOLDER].sort())

    expect(await feedHas(lacker, id)).toBe(false)
    expect(await readableBy(lacker, id)).toBe(false)
    // Even once notified, a decider lacking the turn's scopes cannot decide it.
    await sql`UPDATE kernel.approval_requests
      SET notify_user_ids = array_append(notify_user_ids, ${LACKER}::uuid) WHERE id = ${id}`
    expect(await decideError(lacker, id)).toBeInstanceOf(ApprovalDecisionError)
    expect(await readableBy(holder, id)).toBe(true)
  })
})

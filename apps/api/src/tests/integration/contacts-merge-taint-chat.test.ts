// SPDX-License-Identifier: FSL-1.1-ALv2
//
// FX-C2 (C10 ledger): a chat turn that reads a contact in scope and then proposes
// contacts_merge on that same contact used to be refused by scope taint —
// `contacts_merge` declared no `writesToTable`, so it was an UNDECLARED write and
// E_SCOPE_TAINT_BLOCKED regardless of what the turn had read (see
// apps/web/src/tests/e2e/agent-contact-tools.scenario.test.ts, which works around
// this today by splitting the read and the merge into two separate turns).
//
// The fix (kernel-tools.ts): contacts_merge now declares writesToTable
// "kernel.contacts" + targetRowParam "targetId", and contacts_read now declares
// readsFromTable "kernel.contacts" + targetRowParam "contactId" + resultRowPath
// "contact.id" — the same A46 same-resource machinery tickets:get/reply already
// use. Reading the survivor contact files an origin row for it, so a merge
// targeting that same contact as `targetId` passes the same-resource allowance
// instead of being refused as an undeclared (or non-enforcing) write. The merge
// stays GATED: this only lets the turn reach the gate, it does not skip it.
//
// Real in-tree registration (registerKernelAgentTools / ensureAppsForOrg), real
// contacts_read and contacts_merge handlers, two real seeded duplicate contacts —
// nothing spied except what merely observes the outcome.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db/connection"
import type { UserContext } from "~/db/rls"
import type { RunContext } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { ALL_DEFERRED_TOOLS_UNLOCKED, buildToolSet } from "~/modules/agent/tools/tool-bridge"
import {
  agentInstructionsRegistry,
  initializedOrgRuntimes,
  skillRegistry,
  toolRegistry,
} from "~/modules/apps/app-registries"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

// zod's z.string().uuid() enforces the RFC4122 version/variant nibbles, so
// these cannot be the zero-padded style used for org/user ids elsewhere —
// contactId is validated through contacts_read/contacts_merge's schemas.
const ORG = "11111111-1111-4111-8111-1111111fc201"
const USER = "11111111-1111-4111-8111-1111111fc202"
const SOURCE_CONTACT = "11111111-1111-4111-8111-1111111fc203"
const TARGET_CONTACT = "11111111-1111-4111-8111-1111111fc204"

const actor: UserContext = {
  actorType: "user",
  userId: USER,
  orgId: ORG,
  scopes: ["*"],
  dimensionGrants: {},
}

function chatTurnFrame(): RunContext {
  const runId = crypto.randomUUID()
  return {
    runId,
    parentRunId: null,
    rootRunId: runId,
    nestingDepth: 0,
    turnScopeAccumulator: createTurnScopeAccumulator(),
  } as RunContext
}

function call(frame: RunContext, sdkName: string, args: Record<string, unknown>): Promise<any> {
  const tools = buildToolSet(ORG, actor, undefined, ALL_DEFERRED_TOOLS_UNLOCKED, "agent", frame)
  const t = tools[sdkName]
  if (!t) throw new Error(`${sdkName} is not in the catalog`)
  return (t as unknown as { execute: (a: unknown) => Promise<unknown> }).execute(args)
}

describe("chat turn: a read-then-merge contacts turn is allowed under scope taint", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'ContactsMergeTaintOrg', 'contacts-merge-taint-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
      VALUES (${USER}, ${ORG}, 'contacts-merge-taint@test.com', 'Contacts Merge Taint', 'x')
      ON CONFLICT DO NOTHING`
    // Two seeded duplicates: the source (to be deleted) and the target (the survivor).
    await sql`INSERT INTO kernel.contacts (id, org_id, handle, name, email)
      VALUES
        (${SOURCE_CONTACT}, ${ORG}, '@fc2-source', 'S. Rossi', 'srossi-fc2@example.com'),
        (${TARGET_CONTACT}, ${ORG}, '@fc2-target', 'Sofia Rossi', 'sofia.rossi-fc2@example.com')
      ON CONFLICT DO NOTHING`
    await ensureAppsForOrg(ORG)
  })

  afterAll(async () => {
    toolRegistry.deleteByPrefix([ORG])
    skillRegistry.deleteByPrefix([ORG])
    agentInstructionsRegistry.deleteByPrefix([ORG])
    initializedOrgRuntimes.delete(ORG)
    // The merge stages an approval, which lazily creates a fallback thread
    // (kernel-tools's gated-tool-approval-thread path) — clean that up before
    // the user/org rows it references.
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.contacts WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
    await releaseTestLock()
  })

  it("a read-then-merge contacts turn is allowed under scope taint", async () => {
    const frame = chatTurnFrame()

    // Step 1: a scoped contacts read. Taints the turn, and — now that
    // contacts_read declares readsFromTable/targetRowParam/resultRowPath —
    // files an origin row for the SURVIVOR contact.
    const read = await call(frame, "kernel__contacts_read", { contactId: TARGET_CONTACT })
    expect(read?.contact?.id).toBe(TARGET_CONTACT)
    expect(frame.turnScopeAccumulator?.snapshot()).toContain("kernel:contacts:read")
    expect(frame.turnScopeAccumulator?.originRows()).toEqual({
      "kernel.contacts": [TARGET_CONTACT],
    })

    // Step 2: the merge, same turn, still tainted. Must NOT be refused by
    // scope taint — it must reach the gate and stage its approval as before.
    const merge = await call(frame, "kernel__contacts_merge", {
      sourceId: SOURCE_CONTACT,
      targetId: TARGET_CONTACT,
    })
    expect(merge?.code).not.toBe("E_SCOPE_TAINT_BLOCKED")
    expect(merge?.status).toBe("pending_approval")
    expect(typeof merge?.approvalRequestId).toBe("string")
    // The merge's own write scope classifies no data: it lands on its read sibling
    // (scope-taint.ts, rule 5), never as a write scope in the taint.
    expect(frame.turnScopeAccumulator?.snapshot()).toContain("kernel:contacts:read")
    expect(frame.turnScopeAccumulator?.snapshot()).not.toContain("kernel:contacts:write")
  })

  it("a merge targeting a DIFFERENT contact than the one read is not executed: it parks for a human", async () => {
    const frame = chatTurnFrame()
    await call(frame, "kernel__contacts_read", { contactId: SOURCE_CONTACT })
    // targetId (TARGET_CONTACT) was NOT read, so the same-resource allowance does
    // not apply. contacts_merge is gated: under scope-taint rule 2 a gated write on
    // a tainted turn is never executed inline; it parks as an approval when everyone
    // it will be shown to holds the turn's scopes (a person who holds them decides).
    const merge = await call(frame, "kernel__contacts_merge", {
      sourceId: SOURCE_CONTACT,
      targetId: TARGET_CONTACT,
    })
    expect(merge?.status).toBe("pending_approval")
    expect(merge?.code).not.toBe("E_SCOPE_TAINT_BLOCKED")
    expect(typeof merge?.approvalRequestId).toBe("string")
  })
})

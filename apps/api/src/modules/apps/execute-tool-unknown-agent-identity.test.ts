// SPDX-License-Identifier: FSL-1.1-ALv2
//
// FX22 item 2 -- what `persistableAgentId` actually guarantees when the acting
// agent id is a well-formed uuid that names NO agent row.
//
// The helper is a REGEX check, so it screens the shape of the value and nothing
// else. A malformed id is coerced to null and the approval still stages: the
// identity fails closed and the row survives. A well-formed id that is not an
// agent passes the regex, reaches the INSERT, and the foreign key refuses it
// (23503) -- the approval is never staged and the staging call fails.
//
// This file pins BOTH halves so the distinction cannot drift silently, and so
// the comment on `persistableAgentId` is checkable rather than aspirational.
// After migration 0071 the only way to reach the second half is an agent id
// that names no row of this org at all: a hard delete during user erasure, or
// a caller inventing an id. A cross-org id used to reach it too.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { ActorContext, UserContext } from "~/db/rls"
import { agents } from "~/db/schema/kernel/agents"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { SINK_KERNEL_MESSAGES } from "~/modules/agent/scopes/scope-taint"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { toolRegistry } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = "00000000-0000-4000-8000-000000f2a001"
const USER = "00000000-0000-4000-8000-000000f2a002"
const THREAD = "00000000-0000-4000-8000-000000f2a003"
const AGENT = "00000000-0000-4000-8000-000000f2a004"
/** Pass 8's input: a well-formed uuid that names no agent. */
const GHOST_AGENT = "00000000-0000-4000-8000-00000000a8ff"
/** Not a uuid at all: the shape the regex screens out. */
const MALFORMED_AGENT = "not-an-agent-id"
/** A real agent that is HARD-DELETED mid turn, as user erasure does. */
const ERASED_AGENT = "00000000-0000-4000-8000-00000000a8ee"

const APP = "fx22b_test"
const WRITE = `${APP}:write`

const actor: ActorContext & UserContext = {
  actorType: "user",
  userId: USER,
  orgId: ORG,
  scopes: [WRITE],
  dimensionGrants: {},
}

function turnFrame(agentId: string): RunContext {
  const turnScopeAccumulator = createTurnScopeAccumulator()
  turnScopeAccumulator.recordInjected([])
  const runId = "00000000-0000-4000-8000-000000f2a0ff"
  return {
    runId,
    parentRunId: null,
    rootRunId: runId,
    nestingDepth: 0,
    effectiveScope: [WRITE],
    turnScopeAccumulator,
    agentId,
  }
}

type StageOutcome =
  | { kind: "threw"; message: string }
  | { kind: "blocked"; approvalRequestId: string }
  | { kind: "other"; envelope: unknown }

/** Stage the gated call inside a turn frame and report EXACTLY how it ended:
 *  a thrown error, a staged approval, or anything else. */
async function stage(frame: RunContext): Promise<StageOutcome> {
  try {
    const r = await runContextStore.run(frame, () =>
      executeTool({
        toolName: `${APP}:ship`,
        orgId: ORG,
        actor,
        params: { note: "gate me" },
        threadId: THREAD,
        origin: "in-app-agent",
      }),
    )
    if (r.blocked?.approvalRequestId) {
      return { kind: "blocked", approvalRequestId: r.blocked.approvalRequestId }
    }
    return { kind: "other", envelope: r }
  } catch (err) {
    return { kind: "threw", message: err instanceof Error ? err.message : String(err) }
  }
}

async function stagedRows(): Promise<{ id: string; agent_id: string | null }[]> {
  return await sql<{ id: string; agent_id: string | null }[]>`
    SELECT id, agent_id FROM kernel.approval_requests WHERE org_id = ${ORG}`
}

describe("FX22: an agent id that names no agent row", () => {
  beforeAll(async () => {
    await acquireTestLock()

    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'FX22 Ghost Agent Org', 'fx22-ghost-agent-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
      VALUES (${USER}, ${ORG}, 'fx22-ghost@test.com', 'Requester', 'active', 'hash')
      ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${THREAD}, ${ORG}, 'fx22-ghost-thread', 'agent_chat', ${USER}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
      VALUES (${THREAD}, ${USER}, ${ORG}, 'admin') ON CONFLICT DO NOTHING`
    await withPrivilegedDb(ORG, "fx22-seed-agent", (tx) =>
      tx
        .insert(agents)
        .values({
          id: AGENT,
          orgId: ORG,
          kind: "personal",
          handle: "@fx22b",
          displayName: "Logistics",
          ownerUserId: USER,
          scopeCeiling: [WRITE],
        })
        .onConflictDoNothing(),
    )

    toolRegistry.set([ORG, APP, "ship"], {
      appName: APP,
      name: "ship",
      description: "A gated shipment",
      requiredScopes: [WRITE],
      gated: true,
      approvalImpact: "internal",
      writesToTable: SINK_KERNEL_MESSAGES,
      handler: async () => ({ ok: true }),
    } as never)
  })

  afterEach(async () => {
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.pending_events WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.audit_log WHERE org_id = ${ORG}`
  })

  afterAll(async () => {
    toolRegistry.deleteByPrefix([ORG])
    await releaseTestLock()
  })

  it("a real agent of the org stages the approval and is recorded on it", async () => {
    // The control: the same call with a resolvable identity stages normally, so
    // the two cases below are about the identity and nothing else.
    const outcome = await stage(turnFrame(AGENT))
    expect(outcome.kind).toBe("blocked")
    const rows = await stagedRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.agent_id).toBe(AGENT)
  })

  it("a MALFORMED agent id records no agent and the approval still stages", async () => {
    // Fail closed on identity, not on the row: this is the half the regex
    // genuinely delivers.
    const outcome = await stage(turnFrame(MALFORMED_AGENT))
    expect(outcome.kind).toBe("blocked")
    const rows = await stagedRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.agent_id).toBeNull()
  })

  it("a well-formed agent id that names NO agent records no agent and still stages", async () => {
    // The regex passes it and only the foreign key can refuse it, so the insert
    // is retried once with a null agent. Same outcome as the malformed branch
    // above: the proposer's name is lost, the approval survives.
    const outcome = await stage(turnFrame(GHOST_AGENT))
    expect(outcome.kind).toBe("blocked")
    const rows = await stagedRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.agent_id).toBeNull()
  })

  it("erasing the proposer mid turn still leaves the human an approval card", async () => {
    // The reachable input, not an invented id: `erase-user.ts` HARD-DELETES the
    // erased user's personal agent, so an agent id stops naming a row while that
    // agent's turn is staging a gated call. Before the retry this rolled the
    // staging transaction back and the human got no card at all -- the action
    // neither done nor pending, with nothing saying why.
    await withPrivilegedDb(ORG, "fx24-seed-erased-agent", (tx) =>
      tx
        .insert(agents)
        .values({
          id: ERASED_AGENT,
          orgId: ORG,
          kind: "personal",
          handle: "@fx24erased",
          displayName: "Erased Owner's Agent",
          ownerUserId: USER,
          scopeCeiling: [WRITE],
        })
        .onConflictDoNothing(),
    )
    const frame = turnFrame(ERASED_AGENT)
    await sql`DELETE FROM kernel.agents WHERE id = ${ERASED_AGENT}`

    const outcome = await stage(frame)

    // The caller sees the ordinary gated envelope, not raw postgres text.
    expect(outcome.kind).toBe("blocked")
    const rows = await stagedRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.agent_id).toBeNull()
  })
})

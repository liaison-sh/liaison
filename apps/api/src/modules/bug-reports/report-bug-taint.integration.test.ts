// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `kernel:report_bug` on a tainted turn. Filing a bug report about Liaison into
// the org's own Bug Reports inbox is an internal action: the scope taint never
// judges it (`taintUnjudgedWrite`), so it runs with no approval row whatever
// the turn read, even when some reader of tickets lacks it.
//
// Driven through the real chat seam (buildToolSet's execute closure).

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import type { UserContext } from "~/db/rls"
import type { RunContext } from "~/modules/agent/runtime/run-context"
import { runContextStore } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { ALL_DEFERRED_TOOLS_UNLOCKED, buildToolSet } from "~/modules/agent/tools/tool-bridge"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId: string
let actor: UserContext

function turnFrame(injected: string[]): RunContext {
  const runId = crypto.randomUUID()
  const turnScopeAccumulator = createTurnScopeAccumulator()
  turnScopeAccumulator.recordInjected(injected)
  return {
    runId,
    parentRunId: null,
    rootRunId: runId,
    nestingDepth: 0,
    humanTurn: true,
    turnScopeAccumulator,
  }
}

async function reportBug(frame: RunContext, title: string): Promise<Record<string, unknown>> {
  const tools = buildToolSet(orgId, actor, undefined, ALL_DEFERRED_TOOLS_UNLOCKED, "agent", frame)
  const t = tools.kernel__report_bug
  if (!t) throw new Error("kernel__report_bug is not in the catalog")
  return (await runContextStore.run(frame, () =>
    (t as unknown as { execute: (a: unknown, o: unknown) => Promise<unknown> }).execute(
      { title, description: "The save button spins forever." },
      {},
    ),
  )) as Record<string, unknown>
}

const approvals = async () => {
  const [r] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM kernel.approval_requests
     WHERE org_id = ${orgId}::uuid AND tool_name = 'kernel:report_bug'`
  return r?.n ?? 0
}
const tickets = async (subject: string) => {
  const [r] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM app_tickets.tickets
     WHERE org_id = ${orgId}::uuid AND subject = ${`Bug report: ${subject}`}`
  return r?.n ?? 0
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await createTestOrg()).id
  const admin = await minimal.adminSession(orgId)
  actor = { actorType: "user", userId: admin.userId, orgId, scopes: ["*"], dimensionGrants: {} }
}, 60_000)

afterAll(async () => {
  await releaseTestLock()
})

describe("kernel:report_bug on a tainted turn", () => {
  it("runs with no approval row when every reader of tickets holds what the turn read", async () => {
    const result = await reportBug(turnFrame(["kernel:agent:memory"]), "After a memory read")
    expect(result.filed).toBe(true)
    expect(await tickets("After a memory read")).toBe(1)
    expect(await approvals()).toBe(0)
  })

  it("a reader of tickets lacking the turn's scope: still filed inline, no approval", async () => {
    // A tickets reader who does not hold what the turn read.
    const reader = await minimal.person(orgId)
    await minimal.grantScope(reader.id, "tickets:tickets:read")
    const result = await reportBug(turnFrame(["kernel:org:admin"]), "After an admin read")
    expect(result.blocked).not.toBe(true)
    expect(result.filed).toBe(true)
    expect(await tickets("After an admin read")).toBe(1)
    expect(await approvals()).toBe(0)
  })
})

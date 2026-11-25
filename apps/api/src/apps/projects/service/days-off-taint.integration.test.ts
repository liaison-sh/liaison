// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE HOLD ON A COMPANY DAYS-OFF WRITE IS THE TURN'S OWN. An agent's `days_off_set` waits for a
// person only when the turn that makes it read something some readers of the days off may not
// see. Outside text read earlier in the conversation does not hold it, and the turn after a
// tainted one starts clean. (A person's own days off, `set_away`, park only on a turn marked by
// outside text: users/set-away.test.ts.)
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { executeTool } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { forgetOrgApps, primeOrgApps } from "~/modules/apps/org-apps"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { awaitTimeFeatureSync } from "./time-feature"

let orgId = ""
let owner: minimal.Session
let threadId = ""

const actor = (): UserContext => ({
  actorType: "user",
  userId: owner.userId,
  orgId,
  scopes: ["*"],
  dimensionGrants: { "*": ["*"] },
})

/** A day at least three weeks ahead, one per call so no two cases share a row. */
let dayOffset = 21
function nextDay(): string {
  const d = new Date(Date.now() + dayOffset++ * 86_400_000)
  return d.toISOString().slice(0, 10)
}

function turn(readScopes: string[] = []): RunContext {
  const runId = crypto.randomUUID()
  const acc = createTurnScopeAccumulator()
  if (readScopes.length > 0) acc.recordInjected(readScopes)
  return {
    runId,
    parentRunId: null,
    rootRunId: runId,
    nestingDepth: 0,
    turnScopeAccumulator: acc,
    humanTurn: true,
  }
}

async function agentDaysOff(on: string, frame: RunContext): Promise<Record<string, unknown>> {
  try {
    const res = await runContextStore.run(frame, () =>
      executeTool({
        toolName: "projects:days_off_set",
        orgId,
        actor: actor(),
        origin: "in-app-agent",
        params: { on, label: "Closure" },
        threadId,
      }),
    )
    return res as unknown as Record<string, unknown>
  } catch (err) {
    return { error: err }
  }
}

const dayRows = async (on: string) =>
  extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      SELECT id::text FROM app_projects.days_off
       WHERE org_id = ${orgId}::uuid AND starts_on = ${on}::date`),
  )

const parked = async () =>
  extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      SELECT id::text FROM kernel.approval_requests
       WHERE org_id = ${orgId}::uuid AND tool_name = 'projects:days_off_set'
         AND status = 'pending'`),
  )

async function call(method: string, input: unknown): Promise<Record<string, unknown>> {
  const a = actor()
  return withRlsContext(a, async (tx) => {
    const bridge = createRpcBridge(
      "projects",
      a.userId,
      orgId,
      tx,
      { name: "projects" },
      a.scopes,
      "user",
      undefined,
      { origin: "human-ui" } as never,
    )
    return JSON.parse(await bridge[method](JSON.stringify(input))) as Record<string, unknown>
  })
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await createTestOrg()).id
  owner = await minimal.adminSession(orgId)
  // A colleague who reads the company days off: the readers a tainted write is judged by.
  await minimal.session(orgId)
  await ensureAppsForOrg(orgId)
  await primeOrgApps(orgId, 0)
  const made = (await call("projects_createProject", { name: "Days off studio" })) as {
    id: string
  }
  await call("projects_updateProject", { projectId: made.id, timeBudgets: true })
  await awaitTimeFeatureSync(orgId)
  threadId = await minimal.thread(orgId, owner.userId)
}, 120_000)

afterAll(async () => {
  await db.execute(drizzleSql`DELETE FROM app_projects.days_off WHERE org_id = ${orgId}::uuid`)
  await db.execute(drizzleSql`DELETE FROM kernel.approval_requests WHERE org_id = ${orgId}::uuid`)
  forgetOrgApps(orgId)
  await releaseTestLock()
})

describe("the taint hold on a company days-off write", () => {
  it("a turn that read nothing scoped records it at once, even on a conversation marked by outside text", async () => {
    await db.execute(
      drizzleSql`UPDATE kernel.threads SET tainted = true WHERE id = ${threadId}::uuid`,
    )
    const on = nextDay()
    const res = await agentDaysOff(on, turn())
    expect(res.blocked).toBeUndefined()
    expect(res.error).toBeUndefined()
    expect(await dayRows(on)).toHaveLength(1)
    expect(await parked()).toHaveLength(0)
    await db.execute(
      drizzleSql`UPDATE kernel.threads SET tainted = false WHERE id = ${threadId}::uuid`,
    )
  })

  it("a turn that read what the days off's readers may not see does not record it", async () => {
    const on = nextDay()
    const res = await agentDaysOff(on, turn(["ledger:entries:read"]))
    expect(res.blocked !== undefined || res.error !== undefined).toBe(true)
    expect(await dayRows(on)).toHaveLength(0)
  })

  it("the next turn starts clean: the same write runs at once", async () => {
    const on = nextDay()
    const res = await agentDaysOff(on, turn())
    expect(res.blocked).toBeUndefined()
    expect(res.error).toBeUndefined()
    expect(await dayRows(on)).toHaveLength(1)
  })
})

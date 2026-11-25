// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A manifest EVENT handler can ASK for approval (ctx.requestApproval) for one of its own app's
// tools, exactly as its jobs can: a milestone moved to done drafts its invoice from the event, and
// the draft parks for its issue approval like the sweep job's. Driven through the bridges the
// runtime hands an event subscriber (both the per-call session form and the run-wide transaction
// form), on the real database: the request is filed pending under a real org member, with the
// deciding scope and expiry the app asked for, and is never decided by the handler.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { withRlsContext } from "~/db/rls"
import { approvalExpiryRegistry } from "~/modules/apps/app-registries"
import {
  createEventHandlerBridge,
  createEventHandlerSessionBridge,
} from "~/modules/apps/sandbox/event-handler-bridge"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const APP = "eventapp"
const manifest = { name: APP, schema: {}, events: {}, connections: {}, network: {} }

let ORG = ""
let ADMIN = ""

beforeAll(async () => {
  await acquireTestLock()
  ORG = (await createTestOrg()).id
  ADMIN = (await minimal.orgAdmin(ORG)).id
  approvalExpiryRegistry.set([ORG, APP, "issue"], 24)
})

afterAll(async () => {
  approvalExpiryRegistry.delete([ORG, APP, "issue"])
  await releaseTestLock()
})

/** The identity a non-core app's cross-app event handler runs under (runtime.ts, inTx). */
const appSystem = () => ({
  actorType: "system" as const,
  orgId: ORG,
  purpose: "job" as const,
  scopes: [`${APP}:*`],
})

/** Ask through the session bridge: each bridge call in its own short transaction. */
async function askBySession(input: Record<string, unknown>) {
  const bridge = createEventHandlerSessionBridge({
    appName: APP,
    actorId: ADMIN,
    orgId: ORG,
    session: { run: (fn) => withRlsContext(appSystem(), fn, { pool: "jobs" }) },
    manifest: manifest as never,
    actorType: "system",
  })
  return JSON.parse(await bridge.requestApproval(JSON.stringify(input))) as {
    approval_id?: string
  }
}

/** Ask through the run-wide transaction bridge. */
async function askByTx(input: Record<string, unknown>) {
  return withRlsContext(
    appSystem(),
    async (tx) => {
      const bridge = createEventHandlerBridge({
        appName: APP,
        actorId: ADMIN,
        orgId: ORG,
        txDb: tx,
        manifest: manifest as never,
        actorType: "system",
      })
      return JSON.parse(await bridge.requestApproval(JSON.stringify(input))) as {
        approval_id?: string
      }
    },
    { pool: "jobs" },
  )
}

const issueAsk = (draftId: string) => ({
  tool_name: `${APP}:issue`,
  summary: "Issue the milestone invoice",
  summary_detail: { lines: ["Milestone: Beta delivered"] },
  current_payload: { draft_id: draftId },
  approve_scope: `${APP}:documents:write`,
  expiry_hours: 24,
})

async function rowOf(id: string) {
  const [row] = await sql<
    Array<{
      requested_by: string
      status: string
      tool_name: string
      approve_scope: string | null
      draft: string
    }>
  >`
    SELECT requested_by::text, status, tool_name, approve_scope,
           current_payload->>'draft_id' AS draft
    FROM kernel.approval_requests WHERE id = ${id}`
  return row
}

describe("an event handler's approval request", () => {
  for (const [form, ask] of [
    ["session", askBySession],
    ["transaction", askByTx],
  ] as const) {
    it(`parks pending under a member, with the asked deciding scope (${form} bridge)`, async () => {
      const draftId = crypto.randomUUID()
      const out = await ask(issueAsk(draftId))
      expect(typeof out.approval_id).toBe("string")
      expect(await rowOf(String(out.approval_id))).toEqual({
        requested_by: ADMIN,
        status: "pending",
        tool_name: `${APP}:issue`,
        approve_scope: `${APP}:documents:write`,
        draft: draftId,
      })
    })
  }

  it("refuses a request for another app's tool", async () => {
    const out = await askBySession({
      tool_name: "otherapp:send",
      summary: "s",
      current_payload: {},
    }).catch((e: Error) => e)
    expect(out).toBeInstanceOf(Error)
    expect((out as Error).message).toContain("own app's tools")
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import {
  clearStaleTerminalFailure,
  hasLandedEffect,
  promoteLandedEffect,
  readHandlerExecution,
  recordAmbiguous,
  recordEffectLanded,
  recordFailedNoEffect,
  recordStarted,
  recordSucceeded,
} from "~/modules/approvals/handler-protocol"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = "00000000-0000-4000-8000-000000062001"
const USER = "00000000-0000-4000-8000-000000062002"
const THREAD = "00000000-0000-4000-8000-000000062003"
const REQUEST = "00000000-0000-4000-8000-000000062004"
const TOOL = "protocol:tool"

async function seedRequest() {
  await sql`INSERT INTO kernel.approval_requests (
    id, org_id, handle, thread_id, originating_thread_id, tool_name, tool_params,
    current_payload, expires_at, notify_user_ids, requested_by, status, reason
  ) VALUES (
    ${REQUEST}, ${ORG}, 'protocol-request', ${THREAD}, ${THREAD}, ${TOOL}, '{}'::jsonb,
    '{}'::jsonb, now() + interval '1 hour', ARRAY[${USER}]::uuid[], ${USER}, 'approving', 'gated'
  )`
}

function ctx(toolName = TOOL) {
  return { orgId: ORG, approvalRequestId: REQUEST, approvalDeciderId: USER, toolName }
}

describe("handler-protocol", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'Handler Protocol Org', 'handler-protocol-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
      VALUES (${USER}, ${ORG}, 'protocol@test.com', 'Protocol User', 'active', 'hash') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${THREAD}, ${ORG}, 'protocol-thread', 'agent_chat', ${USER}) ON CONFLICT DO NOTHING`
  })

  afterEach(async () => {
    await sql`DELETE FROM kernel.approved_handler_executions WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
  })

  afterAll(async () => {
    await releaseTestLock()
  })

  it("records started then succeeded with external_ref", async () => {
    await seedRequest()
    await withPrivilegedDb(ORG, "protocol-start", (tx) => recordStarted(tx, ctx(), TOOL))
    await withPrivilegedDb(ORG, "protocol-succeed", (tx) =>
      recordSucceeded(tx, ctx(), TOOL, { messageId: "m-1" }),
    )
    const row = await readHandlerExecution(ORG, REQUEST, TOOL)
    expect(row).toMatchObject({ status: "succeeded", externalRef: { messageId: "m-1" } })
  })

  it("records failed_no_effect error shape", async () => {
    await seedRequest()
    await withPrivilegedDb(ORG, "protocol-start", (tx) => recordStarted(tx, ctx(), TOOL))
    await withPrivilegedDb(ORG, "protocol-fail", (tx) =>
      recordFailedNoEffect(tx, ctx(), TOOL, { code: "REJECTED" }),
    )
    const row = await readHandlerExecution(ORG, REQUEST, TOOL)
    expect(row).toMatchObject({ status: "failed_no_effect", error: { code: "REJECTED" } })
  })

  it("records ambiguous error shape", async () => {
    await seedRequest()
    await withPrivilegedDb(ORG, "protocol-start", (tx) => recordStarted(tx, ctx(), TOOL))
    await withPrivilegedDb(ORG, "protocol-ambiguous", (tx) =>
      recordAmbiguous(tx, ctx(), TOOL, { code: "TIMEOUT" }),
    )
    const row = await readHandlerExecution(ORG, REQUEST, TOOL)
    expect(row).toMatchObject({ status: "ambiguous", error: { code: "TIMEOUT" } })
  })

  it("increments attempts when retrying started on the unique key", async () => {
    await seedRequest()
    await withPrivilegedDb(ORG, "protocol-start", (tx) => recordStarted(tx, ctx(), TOOL))
    await withPrivilegedDb(ORG, "protocol-retry", (tx) => recordStarted(tx, ctx(), TOOL))
    const [row] =
      await sql`SELECT attempts, status FROM kernel.approved_handler_executions WHERE approval_request_id = ${REQUEST}`
    expect(row).toMatchObject({ attempts: 2, status: "started" })
  })

  it("rejects protocol writes for a non-canonical tool name", async () => {
    await seedRequest()
    await expect(
      withPrivilegedDb(ORG, "protocol-mismatch", (tx) => recordStarted(tx, ctx(), "other:tool")),
    ).rejects.toThrow("approval protocol toolName does not match approval request")
    const rows = await sql`SELECT id FROM kernel.approved_handler_executions WHERE org_id = ${ORG}`
    expect(rows.length).toBe(0)
  })

  // Regression (prod 2026-08-06): a leftover failed_no_effect row from a
  // previous attempt was read as THIS attempt's outcome, so a successful retry
  // re-threw the old error and the request stayed pending forever. The clear
  // removes terminal failures only -- a 'started' crash marker must survive
  // (it is the double-send protection).
  it("clearStaleTerminalFailure removes a failed row but never a crash marker", async () => {
    await seedRequest()
    const c = ctx()
    await withPrivilegedDb(c.orgId, "test", async (tx) => {
      await recordStarted(tx, c, c.toolName)
      await recordFailedNoEffect(tx, c, c.toolName, { code: "forbidden" })
    })
    await withPrivilegedDb(c.orgId, "test", (tx) => clearStaleTerminalFailure(tx, c, c.toolName))
    expect(await readHandlerExecution(c.orgId, c.approvalRequestId, c.toolName)).toBeNull()

    // A fresh attempt that crashed mid-effect leaves 'started' -- must survive.
    await withPrivilegedDb(c.orgId, "test", (tx) => recordStarted(tx, c, c.toolName))
    await withPrivilegedDb(c.orgId, "test", (tx) => clearStaleTerminalFailure(tx, c, c.toolName))
    const row = await readHandlerExecution(c.orgId, c.approvalRequestId, c.toolName)
    expect(row?.status).toBe("started")
  })

  // A landed external effect (the provider accepted the send) is a fact no later
  // write may erase: a no-effect record would revert the approval to pending and
  // a retry would send again; clearing it before a retry would do the same.
  describe("a landed external effect", () => {
    const sent = {
      provider: "gmail",
      messageId: "<sent-1@mail.gmail.com>",
      externalThreadId: "t-1",
    }

    async function landed() {
      await seedRequest()
      const c = ctx()
      await withPrivilegedDb(ORG, "test", async (tx) => {
        await recordStarted(tx, c, TOOL)
        await recordEffectLanded(tx, c, TOOL, sent)
      })
      return c
    }

    it("is stamped onto the started row with the provider ref", async () => {
      await landed()
      const row = await readHandlerExecution(ORG, REQUEST, TOOL)
      expect(row?.status).toBe("started")
      expect(row?.externalRef).toMatchObject(sent)
      expect(hasLandedEffect(row?.externalRef)).toBe(true)
    })

    it("is never downgraded to failed_no_effect", async () => {
      const c = await landed()
      await withPrivilegedDb(ORG, "test", (tx) =>
        recordFailedNoEffect(tx, c, TOOL, { code: "REJECTED" }),
      )
      expect((await readHandlerExecution(ORG, REQUEST, TOOL))?.status).toBe("started")
    })

    it("survives clearStaleTerminalFailure once ambiguous", async () => {
      const c = await landed()
      await withPrivilegedDb(ORG, "test", async (tx) => {
        await recordAmbiguous(tx, c, TOOL, { code: "TIMEOUT" })
        await clearStaleTerminalFailure(tx, c, TOOL)
      })
      expect((await readHandlerExecution(ORG, REQUEST, TOOL))?.status).toBe("ambiguous")
    })

    it("promotes started or ambiguous to succeeded with the ref as the result", async () => {
      const c = await landed()
      await withPrivilegedDb(ORG, "test", (tx) => recordAmbiguous(tx, c, TOOL, { code: "TIMEOUT" }))
      const result = await withPrivilegedDb(ORG, "test", (tx) =>
        promoteLandedEffect(tx, REQUEST, TOOL),
      )
      expect(result).toEqual(sent)
      const [row] = await sql`SELECT status, result FROM kernel.approved_handler_executions
        WHERE approval_request_id = ${REQUEST}`
      expect(row).toMatchObject({ status: "succeeded", result: sent })
    })

    it("does not promote a row with no landed effect", async () => {
      await seedRequest()
      await withPrivilegedDb(ORG, "test", (tx) => recordStarted(tx, ctx(), TOOL))
      const result = await withPrivilegedDb(ORG, "test", (tx) =>
        promoteLandedEffect(tx, REQUEST, TOOL),
      )
      expect(result).toBeNull()
      expect((await readHandlerExecution(ORG, REQUEST, TOOL))?.status).toBe("started")
    })
  })
})

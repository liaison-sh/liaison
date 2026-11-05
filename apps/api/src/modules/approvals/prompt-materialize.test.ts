// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An approval reaches its approvers' phones when the attention state
// materializer first sees it. That materializer is a once-a-minute job, so a
// gated call was pushed 0 to 60 s later (48 s and 18 s measured on demo,
// 2026-10-07), past the matrix's 30 s window half the time. The approval's own
// `create` event now runs the materializer for its notify audience at once.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { DurableEventContext } from "~/infra/events/durable-consumers"
import {
  APPROVAL_MATERIALIZE_CONSUMER,
  handleApprovalCreatedMaterialize,
} from "~/modules/approvals/prompt-materialize"

const ORG = "00000000-0000-0000-0000-0000000000a1"
const APPROVAL = "00000000-0000-0000-0000-0000000000b2"

function ctx(entity: string, action: string, orgId: string | null = ORG): DurableEventContext {
  return {
    eventId: "e1",
    event: {
      app: "kernel",
      entity,
      action,
      entityId: APPROVAL,
      orgId,
    } as DurableEventContext["event"],
  }
}

function fakes(audience: string[] = ["u-approver", "u-requester"]) {
  const runs: Array<{ orgId: string; users: string[] }> = []
  const loads: Array<{ orgId: string; approvalId: string }> = []
  return {
    runs,
    loads,
    deps: {
      loadAudience: async (orgId: string, approvalId: string) => {
        loads.push({ orgId, approvalId })
        return audience
      },
      materialize: async (orgId: string, users: string[]) => {
        runs.push({ orgId, users })
      },
    },
  }
}

describe("approval create -> materialize its audience now", () => {
  it("runs the materializer for the approval's active notify audience, in its org", async () => {
    const f = fakes()
    await handleApprovalCreatedMaterialize(ctx("approval_request", "create"), f.deps)
    expect(f.loads).toEqual([{ orgId: ORG, approvalId: APPROVAL }])
    expect(f.runs).toEqual([{ orgId: ORG, users: ["u-approver", "u-requester"] }])
  })

  it("ignores every other event, and an approval with nobody to notify", async () => {
    const f = fakes()
    await handleApprovalCreatedMaterialize(ctx("approval_request", "update"), f.deps)
    await handleApprovalCreatedMaterialize(ctx("message", "create"), f.deps)
    await handleApprovalCreatedMaterialize(ctx("approval_request", "create", null), f.deps)
    expect(f.runs).toEqual([])
    const empty = fakes([])
    await handleApprovalCreatedMaterialize(ctx("approval_request", "create"), empty.deps)
    expect(empty.runs).toEqual([])
  })

  it("never throws: a failure costs the prompt push, never the outbox row (the minute job still runs)", async () => {
    const f = fakes()
    await handleApprovalCreatedMaterialize(ctx("approval_request", "create"), {
      ...f.deps,
      materialize: async () => {
        throw new Error("boom")
      },
    })
  })

  it("is registered as a durable consumer with the other event subscribers", () => {
    const src = readFileSync(
      join(import.meta.dir, "..", "..", "infra", "events", "event-subscribers.ts"),
      "utf8",
    )
    expect(src).toContain("registerApprovalMaterializeConsumer()")
    expect(APPROVAL_MATERIALIZE_CONSUMER).toBe("approval-materialize")
  })
})

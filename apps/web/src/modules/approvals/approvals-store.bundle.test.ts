// SPDX-License-Identifier: FSL-1.1-ALv2
import type { ApprovalRequestSummary } from "@liaison/shared"
import { beforeEach, describe, expect, test, vi } from "vitest"
import {
  approvalsStore,
  decide,
  getBundleSteps,
  handleWsCreate,
  resetApprovalsStore,
  updatePayloadAction,
} from "./approvals-store"

const CURRENT_USER = "u1"

function mkRow(over: Partial<ApprovalRequestSummary>): ApprovalRequestSummary {
  return {
    id: "x",
    handle: "AR-1",
    status: "pending",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    toolName: "test:tool",
    summary: { kind: "test", title: "t", lines: [] },
    editableFields: [],
    currentPayload: {},
    threadId: "t1",
    originatingThreadId: "t1",
    requestedBy: { id: "u1" },
    requester: { kind: "user", id: "u1", name: "User" },
    notifyUserIds: ["u1"],
    bundleId: null,
    bundlePosition: null,
    dependsOnId: null,
    lastEdit: null,
    lastFailure: null,
    ...over,
  }
}

describe("step-bundle store: position-based head detection", () => {
  beforeEach(() => {
    resetApprovalsStore()
  })

  test("position-0 row whose bundleId !== id is still treated as head", () => {
    const bundleId = "bundle-uuid-1"
    handleWsCreate(mkRow({ id: "appr-1", bundleId, bundlePosition: 0 }), CURRENT_USER)
    expect(approvalsStore.byId["appr-1"]).toBeDefined()
    handleWsCreate(mkRow({ id: "appr-2", bundleId, bundlePosition: 1 }), CURRENT_USER)
    const steps = getBundleSteps(bundleId)
    expect(steps.map((s) => s.id)).toEqual(["appr-1", "appr-2"])
  })

  test("siblings arriving out of order sort by bundlePosition", () => {
    const bundleId = "bundle-uuid-2"
    handleWsCreate(mkRow({ id: "b", bundleId, bundlePosition: 1 }), CURRENT_USER)
    handleWsCreate(mkRow({ id: "a", bundleId, bundlePosition: 0 }), CURRENT_USER)
    expect(getBundleSteps(bundleId).map((s) => s.id)).toEqual(["a", "b"])
  })

  test("1-member bundle renders the row", () => {
    const bundleId = "bundle-uuid-3"
    handleWsCreate(mkRow({ id: "only", bundleId, bundlePosition: 0 }), CURRENT_USER)
    expect(getBundleSteps(bundleId).map((s) => s.id)).toEqual(["only"])
  })

  test("legacy bundle shape (bundleId === id) still resolves via getBundleSteps(bundleId)", () => {
    // The old invariant (bundleId === head.id) is a subset of the new rule
    // (position === 0). It must keep working.
    const legacy = "legacy-bundle-and-head"
    handleWsCreate(mkRow({ id: legacy, bundleId: legacy, bundlePosition: 0 }), CURRENT_USER)
    expect(getBundleSteps(legacy).map((s) => s.id)).toEqual([legacy])
  })
})

describe("an approve waits for the person's own step edit", () => {
  beforeEach(() => {
    resetApprovalsStore()
  })

  // Save a deferred step's edit and press Approve at once: the approve used to
  // leave first, bound to the step's previous version, and the server refused
  // it (409 payload_changed). It now waits for the save and binds to the edit.
  test("the head's approve carries the edited step's new version", async () => {
    const bundleId = "bundle-edit"
    handleWsCreate(
      mkRow({ id: "head", bundleId, bundlePosition: 0, payloadHash: "h-head" }),
      CURRENT_USER,
    )
    handleWsCreate(
      mkRow({
        id: "step",
        bundleId,
        bundlePosition: 1,
        status: "deferred",
        dependsOnId: "head",
        payloadHash: "h-before",
      }),
      CURRENT_USER,
    )
    let finishSave: (v: unknown) => void = () => {}
    const posts: Array<{ path: string; body: any }> = []
    const api = {
      post: vi.fn((path: string, body: unknown) => {
        posts.push({ path, body })
        if (path.endsWith("/payload")) {
          return new Promise((r) => {
            finishSave = r
          })
        }
        return Promise.resolve({ id: "head", status: "approved" })
      }),
    }
    const saving = updatePayloadAction(api as never, "step", { label: "edited" })
    const approving = decide(api as never, "head", "approve")
    await Promise.resolve()
    // The approve has not left while the edit is in flight.
    expect(posts.map((p) => p.path)).toEqual(["/approvals/step/payload"])
    finishSave({ id: "step", currentPayload: { label: "edited" }, payloadHash: "h-after" })
    await saving
    await approving
    const decided = posts.find((p) => p.path === "/approvals/head/decide")
    expect(decided?.body.stepPayloadHashes).toEqual({ step: "h-after" })
  })
})

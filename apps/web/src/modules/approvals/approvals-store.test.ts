// SPDX-License-Identifier: FSL-1.1-ALv2
import { createRoot } from "solid-js"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ApiClient } from "~/lib/api-client"
import {
  acknowledgePayloadChanges,
  approvalsStore,
  decidableByMe,
  decide,
  decisionLabel,
  ensureLoaded,
  handleWsCreate,
  handleWsUpdate,
  hasPendingDecisions,
  loadDecidableByMe,
  payloadChangedSinceReview,
  resetApprovalsStore,
  updatePayloadAction,
} from "./approvals-store"

vi.mock("~/modules/auth/auth-store", () => ({
  hasScope: (s: string) => s === "mail:approve",
  userFromToken: () => ({ userId: "u-1", scopes: ["mail:approve"] }),
}))

const baseRow = (over: Partial<any> = {}): any => ({
  id: "ar-1",
  handle: "request-0001",
  status: "pending",
  createdAt: "2026-04-30T12:00:00.000Z",
  expiresAt: "2026-04-30T13:00:00.000Z",
  toolName: "mail:reply",
  summary: { kind: "mail.reply", title: "Re:", lines: [] },
  editableFields: [],
  currentPayload: {},
  threadId: "t-1",
  originatingThreadId: "t-1",
  requestedBy: { id: "u-2" },
  requester: { kind: "user", id: "u-2", name: "Bob" },
  notifyUserIds: ["u-1", "u-2"],
  lastEdit: null,
  ...over,
})

/** An api client whose POST answers with `post`; every other call fails the test. */
function apiWithPost(post: (path: string, body?: unknown) => Promise<unknown>): ApiClient {
  const unused = () => Promise.reject(new Error("not used by this test"))
  return {
    get: unused,
    post: <T>(path: string, body?: unknown) => post(path, body) as Promise<T>,
    put: unused,
    patch: unused,
    delete: unused,
    getEnvelope: unused,
    rawPost: unused,
    rawGet: unused,
  }
}

beforeEach(() => resetApprovalsStore())

describe("approvals store", () => {
  it("loadDecidableByMe populates byId and decidableIds in createdAt-asc order", async () => {
    const get = vi
      .fn()
      .mockResolvedValue([
        baseRow({ id: "ar-2", createdAt: "2026-04-30T13:00:00.000Z" }),
        baseRow({ id: "ar-1", createdAt: "2026-04-30T12:00:00.000Z" }),
      ])
    await loadDecidableByMe({ get } as any)
    createRoot(() => {
      expect(decidableByMe().map((r) => r.id)).toEqual(["ar-1", "ar-2"])
      expect(approvalsStore.byId["ar-1"]).toBeDefined()
      expect(hasPendingDecisions()).toBe(true)
    })
  })

  it("ensureLoaded coalesces concurrent calls into one HTTP request", async () => {
    const row = baseRow()
    const get = vi
      .fn()
      .mockImplementation(() => new Promise((res) => setTimeout(() => res(row), 10)))
    const api: any = { get }
    const [a, b, c] = await Promise.all([
      ensureLoaded(api, "ar-1"),
      ensureLoaded(api, "ar-1"),
      ensureLoaded(api, "ar-1"),
    ])
    expect(get).toHaveBeenCalledTimes(1)
    expect(a).toEqual(row)
    expect(b).toEqual(row)
    expect(c).toEqual(row)
  })

  it("handleWsCreate adds rows to decidableIds only when locally provable as decidable", () => {
    handleWsCreate(baseRow({ id: "ar-A", notifyUserIds: ["u-1"] }), "u-1")
    handleWsCreate(baseRow({ id: "ar-B", notifyUserIds: ["u-2"] }), "u-1")
    handleWsCreate(
      baseRow({ id: "ar-C", notifyUserIds: ["u-1"], toolName: "tickets:close" }),
      "u-1",
    )
    createRoot(() => {
      const ids = decidableByMe().map((r) => r.id)
      expect(ids).toEqual(["ar-A"])
      expect(approvalsStore.byId["ar-B"]).toBeDefined()
      expect(approvalsStore.byId["ar-C"]).toBeDefined()
    })
  })

  it("handleWsCreate is idempotent on duplicate events", () => {
    const row = baseRow()
    handleWsCreate(row, "u-1")
    handleWsCreate(row, "u-1")
    createRoot(() => expect(decidableByMe().filter((r) => r.id === "ar-1")).toHaveLength(1))
  })

  it("handleWsUpdate removes terminal-status rows from decidableIds and updates byId", () => {
    handleWsCreate(baseRow(), "u-1")
    handleWsUpdate(baseRow({ status: "approved", decidedBy: "u-1" }))
    createRoot(() => {
      expect(approvalsStore.byId["ar-1"].status).toBe("approved")
      expect(decidableByMe()).toEqual([])
    })
  })

  it("handleWsUpdate to approving removes the row from decidableByMe", () => {
    handleWsCreate(baseRow(), "u-1")
    handleWsUpdate(baseRow({ status: "approving" }))
    createRoot(() => expect(decidableByMe()).toEqual([]))
  })

  it("ignores stale pending creates after a newer non-pending update", () => {
    handleWsUpdate(baseRow({ status: "approved", decidedBy: "u-1" }))
    handleWsCreate(baseRow({ status: "pending" }), "u-1")
    createRoot(() => {
      expect(approvalsStore.byId["ar-1"].status).toBe("approved")
      expect(decidableByMe()).toEqual([])
    })
  })

  it("decidableByMe omits rows whose required scope cannot be locally proved", () => {
    handleWsCreate(baseRow({ id: "ar-X", toolName: "tickets:close" }), "u-1")
    createRoot(() => expect(decidableByMe()).toEqual([]))
  })

  it("handleWsCreate merges rows before setting needsDecidableRefresh when notify_user_ids is missing", () => {
    handleWsCreate(baseRow({ id: "ar-missing", notifyUserIds: undefined as any }), "u-1")
    expect(approvalsStore.byId["ar-missing"]).toBeDefined()
    expect(approvalsStore.needsDecidableRefresh).toBe(true)
    createRoot(() => expect(decidableByMe()).toEqual([]))
  })

  it("decide(approve) applies the decision optimistically before any WS arrives", async () => {
    // Seed a pending row in the store, then drive decide() with a mocked API
    // that returns the decision result. The store must reflect status=approved
    // synchronously after the await — without waiting on a WS broadcast.
    handleWsCreate(baseRow({ status: "pending" }), "u-1")
    expect(approvalsStore.byId["ar-1"]?.status).toBe("pending")
    createRoot(() => expect(decidableByMe().map((r) => r.id)).toEqual(["ar-1"]))

    const post = vi.fn().mockResolvedValue({
      id: "ar-1",
      status: "approved" as const,
      decidedBy: "u-1",
      decidedAt: "2026-04-30T12:30:00.000Z",
    })
    const api = { post } as any
    await decide(api, "ar-1", "approve")

    expect(post).toHaveBeenCalledWith(
      "/approvals/ar-1/decide",
      { decision: "approve" },
      { suppressGlobalError: true },
    )
    expect(approvalsStore.byId["ar-1"]?.status).toBe("approved")
    expect(approvalsStore.byId["ar-1"]?.decidedBy).toBe("u-1")
    expect(approvalsStore.byId["ar-1"]?.decidedAt).toBe("2026-04-30T12:30:00.000Z")
    createRoot(() => expect(decidableByMe()).toEqual([]))
  })

  it("decide(deny) applies the decision optimistically and carries the reason", async () => {
    handleWsCreate(baseRow({ status: "pending" }), "u-1")
    const post = vi.fn().mockResolvedValue({
      id: "ar-1",
      status: "denied" as const,
      decidedBy: "u-1",
      decidedAt: "2026-04-30T12:30:00.000Z",
      reason: "looks risky",
    })
    await decide({ post } as any, "ar-1", "deny", { reason: "looks risky" })

    expect(post).toHaveBeenCalledWith(
      "/approvals/ar-1/decide",
      { decision: "deny", reason: "looks risky" },
      { suppressGlobalError: true },
    )
    expect(approvalsStore.byId["ar-1"]?.status).toBe("denied")
    expect(approvalsStore.byId["ar-1"]?.reason).toBe("looks risky")
    createRoot(() => expect(decidableByMe()).toEqual([]))
  })

  it("a late WS update with the same approved status is an idempotent no-op", async () => {
    handleWsCreate(baseRow({ status: "pending" }), "u-1")
    await decide(
      {
        post: vi.fn().mockResolvedValue({
          id: "ar-1",
          status: "approved" as const,
          decidedBy: "u-1",
          decidedAt: "2026-04-30T12:30:00.000Z",
        }),
      } as any,
      "ar-1",
      "approve",
    )
    // Simulate the WS broadcast arriving after the optimistic update. The
    // store must remain consistent; specifically, the row must not regress
    // and decidableIds must stay empty.
    handleWsUpdate(baseRow({ status: "approved", decidedBy: "u-1" }))
    expect(approvalsStore.byId["ar-1"]?.status).toBe("approved")
    createRoot(() => expect(decidableByMe()).toEqual([]))
  })
})

describe("approve binds to the version the person saw", () => {
  const ok = {
    id: "ar-1",
    status: "approved",
    decidedBy: "u-1",
    decidedAt: "2026-04-30T12:30:00.000Z",
  }

  it("a live edit by someone else does not move the version an approve is bound to", async () => {
    handleWsCreate(baseRow({ payloadHash: "seen" }), "u-1")
    handleWsUpdate(baseRow({ payloadHash: "edited", currentPayload: { bcc: ["x@outside.test"] } }))
    expect(payloadChangedSinceReview("ar-1")).toBe(true)
    const post = vi.fn().mockResolvedValue(ok)
    await decide({ post } as any, "ar-1", "approve")
    expect(post.mock.calls[0]?.[1]).toEqual({ decision: "approve", payloadHash: "seen" })
  })

  it("once the person reads the new version, the approve binds to it", async () => {
    handleWsCreate(baseRow({ payloadHash: "seen" }), "u-1")
    handleWsUpdate(baseRow({ payloadHash: "edited" }))
    acknowledgePayloadChanges(["ar-1"])
    expect(payloadChangedSinceReview("ar-1")).toBe(false)
    const post = vi.fn().mockResolvedValue(ok)
    await decide({ post } as any, "ar-1", "approve")
    expect(post.mock.calls[0]?.[1]).toEqual({ decision: "approve", payloadHash: "edited" })
  })

  it("the person's own edit is the version they reviewed", async () => {
    handleWsCreate(baseRow({ payloadHash: "seen" }), "u-1")
    const post = vi
      .fn()
      .mockResolvedValue({ id: "ar-1", currentPayload: {}, payloadHash: "mine", lastEdit: null })
    await updatePayloadAction({ post } as any, "ar-1", { textBody: "x" })
    handleWsUpdate(baseRow({ payloadHash: "mine" }))
    expect(payloadChangedSinceReview("ar-1")).toBe(false)
  })

  // The live update carrying the edit can arrive after the save's response
  // (a loaded server, a reconnecting socket). Until it did, the card showed the
  // old payload under the new reviewed version: "changed since you opened it"
  // about the person's own edit, and their Approve was refused.
  it("the person's own edit shows at once, before the live update arrives", async () => {
    handleWsCreate(baseRow({ payloadHash: "seen", currentPayload: { textBody: "old" } }), "u-1")
    const post = vi.fn().mockResolvedValue({
      id: "ar-1",
      currentPayload: { textBody: "mine" },
      payloadHash: "mine",
      lastEdit: { editorUserId: "u-1", at: "2026-04-30T12:10:00.000Z", diff: [] },
    })
    await updatePayloadAction(apiWithPost(post), "ar-1", { textBody: "mine" })
    expect(payloadChangedSinceReview("ar-1")).toBe(false)
    expect(approvalsStore.byId["ar-1"]?.currentPayload).toEqual({ textBody: "mine" })
    expect(approvalsStore.byId["ar-1"]?.payloadHash).toBe("mine")
    expect(approvalsStore.byId["ar-1"]?.lastEdit?.editorUserId).toBe("u-1")
    // The late live update of the same edit changes nothing.
    handleWsUpdate(baseRow({ payloadHash: "mine", currentPayload: { textBody: "mine" } }))
    expect(payloadChangedSinceReview("ar-1")).toBe(false)
  })

  it("a later edit by someone else that landed first is not overwritten by the save's answer", async () => {
    handleWsCreate(baseRow({ payloadHash: "seen", currentPayload: { textBody: "old" } }), "u-1")
    let answer: (v: unknown) => void = () => {}
    const post = vi.fn(() => new Promise((r) => (answer = r)))
    const saving = updatePayloadAction(apiWithPost(post), "ar-1", { textBody: "mine" })
    handleWsUpdate(baseRow({ payloadHash: "theirs", currentPayload: { textBody: "theirs" } }))
    answer({
      id: "ar-1",
      currentPayload: { textBody: "mine" },
      payloadHash: "mine",
      lastEdit: null,
    })
    await saving
    expect(approvalsStore.byId["ar-1"]?.currentPayload).toEqual({ textBody: "theirs" })
    // The person reviewed their own version, so the newer one is flagged.
    expect(payloadChangedSinceReview("ar-1")).toBe(true)
  })

  it("approving a bundle head carries the version of every later step the person saw", async () => {
    handleWsCreate(
      baseRow({ id: "head", bundleId: "b-1", bundlePosition: 0, payloadHash: "h0" }),
      "u-1",
    )
    handleWsCreate(
      baseRow({
        id: "step",
        bundleId: "b-1",
        bundlePosition: 1,
        status: "deferred",
        payloadHash: "h1",
      }),
      "u-1",
    )
    handleWsUpdate(
      baseRow({
        id: "step",
        bundleId: "b-1",
        bundlePosition: 1,
        status: "deferred",
        payloadHash: "h1-edited",
      }),
    )
    expect(payloadChangedSinceReview("step")).toBe(true)
    const post = vi.fn().mockResolvedValue({ ...ok, id: "head" })
    await decide({ post } as any, "head", "approve")
    expect(post.mock.calls[0]?.[1]).toEqual({
      decision: "approve",
      payloadHash: "h0",
      stepPayloadHashes: { step: "h1" },
    })
  })
})

// Commerce walk 2026-10-27: the "Approved" toast read "Pending approval, nothing
// is shipped or bought yet", the subtitle the label's summary was written with.
describe("decisionLabel", () => {
  it("names the approval by its title and a subtitle that holds once decided", () => {
    expect(
      decisionLabel({
        summary: { title: "Reply to Lena", subtitle: "Tickets: reply" },
        handle: "request-1",
      }),
    ).toEqual({ title: "Reply to Lena", detail: "Tickets: reply" })
  })

  it("drops a subtitle that speaks of the pending state for the request's handle", () => {
    for (const subtitle of [
      "Pending approval",
      "Pending approval, nothing is shipped or bought yet",
    ]) {
      expect(
        decisionLabel({
          summary: { title: "Buy label for order #1097", subtitle },
          handle: "request-1",
        }),
      ).toEqual({ title: "Buy label for order #1097", detail: "request-1" })
    }
  })
})

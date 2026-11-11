// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P2-T06 (S8 list, S10), S9: the Sessions list groups every row the session
// store holds (Needs you / Running / Done / Failed or stopped / Older), so a
// live `node_session` frame lands in its group with no fetch; each group loads
// by cursor and keeps its own loading, error and ready state; the rail badge
// counts the Needs-you group. A row's true status is `state ?? status` (D14).
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ApiClient } from "~/lib/api-client"
import { ApiError } from "~/lib/api-error"
import { teardownSession } from "~/lib/session-lifecycle"
import type { NodeSessionGroup, NodeSessionRow } from "./session-api"
import {
  countsByNode,
  ensureListLoaded,
  groupOf,
  groupRows,
  groupState,
  loadGroup,
  loadMore,
  needsYouCount,
  resetSessionList,
  setSessionListApi,
} from "./session-list"
import { applyRow, resetSessionStore, sessionStore } from "./session-store"

const NOW = Date.parse("2026-10-13T12:00:00.000Z")
const DAY = 86_400_000

function row(over: Partial<NodeSessionRow> = {}): NodeSessionRow {
  return {
    id: "s1",
    ownerUserId: "u1",
    nodeId: "n1",
    jobId: "j1",
    agentId: "a1",
    source: "dispatch",
    configKind: "owner",
    sourceThreadId: null,
    sourceMessageId: null,
    title: "Fix the flaky test",
    folderName: "code",
    repo: null,
    branch: null,
    pushed: false,
    prUrl: null,
    model: "claude-haiku-4-5",
    level: "strict",
    status: "running",
    pendingCount: 0,
    waitingReason: null,
    claudeCode: null,
    lastSeq: 0,
    latestActivity: null,
    tokensIn: 0,
    tokensOut: 0,
    resultSummary: null,
    error: null,
    createdAt: "2026-10-13T10:00:00.000Z",
    startedAt: "2026-10-13T10:00:01.000Z",
    endedAt: null,
    updatedAt: "2026-10-13T10:00:00.000Z",
    ...over,
  }
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

type Pages = Partial<Record<NodeSessionGroup, Record<string, unknown>>>

/** An API whose list route answers per group and cursor ("" = the first page). */
function fakeApi(pages: Pages, fail: NodeSessionGroup[] = []) {
  const get = vi.fn(async (path: string) => {
    const url = new URL(path, "http://x")
    const group = url.searchParams.get("group") as NodeSessionGroup
    if (fail.includes(group)) throw new Error("boom")
    const cursor = url.searchParams.get("cursor") ?? ""
    return pages[group]?.[cursor] ?? { sessions: [], nextCursor: null }
  })
  return { get, client: { get } as unknown as Pick<ApiClient, "get"> }
}

afterEach(() => {
  resetSessionList()
  resetSessionStore()
})

describe("session list", () => {
  it("rows land in their group by status and end date (31 days ago is older)", () => {
    expect(groupOf(row({ status: "waiting" }), NOW)).toBe("needs_you")
    expect(groupOf(row({ status: "queued" }), NOW)).toBe("running")
    expect(groupOf(row({ status: "running" }), NOW)).toBe("running")
    expect(groupOf(row({ status: "paused" }), NOW)).toBe("running")
    expect(groupOf(row({ status: "done", endedAt: iso(NOW - 2 * DAY) }), NOW)).toBe("done")
    for (const status of ["stopped", "failed"] as const) {
      expect(groupOf(row({ status, endedAt: iso(NOW - 2 * DAY) }), NOW)).toBe("failed")
    }
    for (const status of ["done", "stopped", "failed"] as const) {
      expect(groupOf(row({ status, endedAt: iso(NOW - 31 * DAY) }), NOW)).toBe("older")
    }
  })

  it("S9: a needs_you row is in the Needs-you group, failed in Failed, the badge counts waiting + needs_you", () => {
    const ended = iso(NOW - DAY)
    // As the API serves it (D14): status waiting for older clients, the true state beside it.
    applyRow(row({ id: "n", status: "waiting", state: "needs_you", endedAt: ended }))
    applyRow(row({ id: "w", status: "waiting", state: "waiting", pendingCount: 1 }))
    applyRow(row({ id: "f", status: "failed", state: "failed", endedAt: ended }))
    applyRow(row({ id: "s", status: "stopped", state: "stopped", endedAt: ended }))
    applyRow(row({ id: "d", status: "done", state: "done", endedAt: ended }))
    applyRow(row({ id: "r", status: "running", state: "running" }))
    expect(groupOf(sessionStore.row("n")!, NOW)).toBe("needs_you")
    expect(
      groupRows("needs_you", NOW)
        .map((r) => r.id)
        .sort(),
    ).toEqual(["n", "w"])
    expect(
      groupRows("failed", NOW)
        .map((r) => r.id)
        .sort(),
    ).toEqual(["f", "s"])
    expect(groupRows("done", NOW).map((r) => r.id)).toEqual(["d"])
    expect(groupRows("running", NOW).map((r) => r.id)).toEqual(["r"])
    expect(needsYouCount(NOW)).toBe(2)
    expect(countsByNode("n1", NOW)).toEqual({ running: 1, needsYou: 2 })
  })

  it("S9: an unknown state files the row in Running", () => {
    expect(groupOf(row({ status: "running", state: "hibernating" }), NOW)).toBe("running")
    expect(groupOf(row({ status: "hibernating" as never }), NOW)).toBe("running")
  })

  it("a node_session frame for an unknown session appears in its group without a fetch", () => {
    const api = fakeApi({})
    setSessionListApi(() => api.client)
    applyRow(row({ id: "new", status: "running" }))
    expect(groupRows("running", NOW).map((r) => r.id)).toEqual(["new"])
    expect(api.get).not.toHaveBeenCalled()
  })

  it("a session moving to waiting moves group and needsYouCount goes 0 → 1", () => {
    applyRow(row({ id: "s1", status: "running" }))
    expect(needsYouCount(NOW)).toBe(0)
    applyRow(row({ id: "s1", status: "waiting", pendingCount: 1 }))
    expect(needsYouCount(NOW)).toBe(1)
    expect(groupRows("needs_you", NOW).map((r) => r.id)).toEqual(["s1"])
    expect(groupRows("running", NOW)).toEqual([])
    expect(countsByNode("n1", NOW)).toEqual({ running: 0, needsYou: 1 })
  })

  it("sorts needs-you oldest first, running newest first, done and failed by end", () => {
    applyRow(row({ id: "w-new", status: "waiting", updatedAt: iso(NOW - 1000) }))
    applyRow(row({ id: "w-old", status: "waiting", updatedAt: iso(NOW - 9000) }))
    applyRow(row({ id: "r-old", status: "running", startedAt: iso(NOW - 9000) }))
    applyRow(row({ id: "r-new", status: "running", startedAt: iso(NOW - 1000) }))
    applyRow(row({ id: "d-old", status: "done", endedAt: iso(NOW - 2 * DAY) }))
    applyRow(row({ id: "d-new", status: "done", endedAt: iso(NOW - DAY) }))
    applyRow(row({ id: "f-old", status: "failed", endedAt: iso(NOW - 2 * DAY) }))
    applyRow(row({ id: "f-new", status: "stopped", endedAt: iso(NOW - DAY) }))
    expect(groupRows("needs_you", NOW).map((r) => r.id)).toEqual(["w-old", "w-new"])
    expect(groupRows("running", NOW).map((r) => r.id)).toEqual(["r-new", "r-old"])
    expect(groupRows("done", NOW).map((r) => r.id)).toEqual(["d-new", "d-old"])
    expect(groupRows("failed", NOW).map((r) => r.id)).toEqual(["f-new", "f-old"])
  })

  it("loadMore appends the next page by cursor", async () => {
    const api = fakeApi({
      running: {
        "": { sessions: [row({ id: "a" })], nextCursor: "c2" },
        c2: { sessions: [row({ id: "b", startedAt: iso(NOW - DAY) })], nextCursor: null },
      },
    })
    setSessionListApi(() => api.client)
    await loadGroup("running")
    expect(groupState("running")).toEqual({ status: "ready", nextCursor: "c2" })
    await loadMore("running")
    expect(api.get).toHaveBeenLastCalledWith(
      "/me/node-sessions?group=running&v=2&cursor=c2",
      expect.anything(),
    )
    expect(groupRows("running", NOW).map((r) => r.id)).toEqual(["a", "b"])
    expect(groupState("running").nextCursor).toBeNull()
  })

  it("a failed load sets the group's error state, not empty", async () => {
    setSessionListApi(() => fakeApi({}, ["needs_you"]).client)
    await loadGroup("needs_you")
    expect(groupState("needs_you").status).toBe("error")
  })

  it("ensureListLoaded loads needs_you, running, done and failed once", async () => {
    const api = fakeApi({})
    setSessionListApi(() => api.client)
    await ensureListLoaded()
    await ensureListLoaded()
    const groups = api.get.mock.calls.map(([p]) => new URL(p, "http://x").searchParams.get("group"))
    expect(groups.sort()).toEqual(["done", "failed", "needs_you", "running"])
  })

  it("S9: the list says it is of this wave (v=2), so the API's done group is done only", async () => {
    const api = fakeApi({})
    setSessionListApi(() => api.client)
    await loadGroup("done")
    const asked = new URL(api.get.mock.calls[0][0], "http://x").searchParams
    expect([asked.get("group"), asked.get("v")]).toEqual(["done", "2"])
  })

  it("S9: an older API that refuses the new group ids is read with the old ones", async () => {
    // The desktop and phone ship before the API (S45): group=needs_you|failed is a 400 there.
    const get = vi.fn(async (path: string) => {
      const group = new URL(path, "http://x").searchParams.get("group")
      if (group === "needs_you" || group === "failed") {
        throw new ApiError("Invalid query", 400, "VALIDATION_ERROR")
      }
      if (group === "waiting")
        return { sessions: [row({ id: "w", status: "waiting" })], nextCursor: null }
      if (group === "done") {
        return {
          sessions: [
            row({ id: "d", status: "done", endedAt: iso(Date.now() - DAY) }),
            row({ id: "f", status: "failed", endedAt: iso(Date.now() - DAY) }),
          ],
          nextCursor: null,
        }
      }
      return { sessions: [], nextCursor: null }
    })
    setSessionListApi(() => ({ get }) as unknown as Pick<ApiClient, "get">)
    await ensureListLoaded()
    for (const g of ["needs_you", "running", "done", "failed"] as const) {
      expect(groupState(g).status).toBe("ready")
    }
    expect(groupRows("needs_you").map((r) => r.id)).toEqual(["w"])
    expect(groupRows("done").map((r) => r.id)).toEqual(["d"])
    expect(groupRows("failed").map((r) => r.id)).toEqual(["f"])
  })

  it("teardown forgets everything", async () => {
    setSessionListApi(
      () => fakeApi({ running: { "": { sessions: [row()], nextCursor: null } } }).client,
    )
    await loadGroup("running")
    expect(groupState("running").status).toBe("ready")
    teardownSession()
    expect(groupState("running").status).toBe("idle")
    expect(sessionStore.rows()).toEqual([])
    expect(groupRows("running", NOW)).toEqual([])
  })
})

describe("imports in the list (W3, S9)", () => {
  it("S9: an import sorts into its group by status like any session", () => {
    const imp = { source: "import" as const, importMode: "follow" as const, following: true }
    expect(groupOf(row({ ...imp, status: "running" }), NOW)).toBe("running")
    expect(
      groupOf(
        row({ ...imp, following: false, status: "waiting", state: "needs_you", endedAt: iso(NOW) }),
        NOW,
      ),
    ).toBe("needs_you")
    applyRow(row({ id: "i1", ...imp, status: "running" }))
    expect(groupRows("running", NOW).map((r) => r.id)).toEqual(["i1"])
  })
})

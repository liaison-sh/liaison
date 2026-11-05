// SPDX-License-Identifier: FSL-1.1-ALv2
// Home's "Mark all as read" (D21 follow-up): one action in the main panel's
// header, scoped to the slice the sidebar (or a phone chip) selected. It reads
// what that slice shows in ONE request, never a row that needs a decision, and
// says what is left.
import type { AttentionItem } from "@liaison/shared"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("~/modules/auth/auth-store", () => ({
  onAuthCleared: () => () => {},
  hasScope: () => true,
  userFromToken: () => ({ userId: "u-1", name: "Tester" }),
}))

// The server's unread rows: a bulk read removes them, so the reload after the
// action returns what is left, as the real feed does.
let serverItems: AttentionItem[] = []
const apiStub = {
  get: vi.fn(async () => []),
  getEnvelope: vi.fn(async () => ({ data: { items: serverItems, errors: [] } })),
  post: vi.fn(async (_path: string, _body?: unknown): Promise<unknown> => ({})),
  patch: vi.fn(async () => ({})),
  put: vi.fn(async () => ({})),
}
vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => apiStub,
  useOptionalApi: () => apiStub,
}))

import { resetRegistry } from "~/framework/app-registry"
import { attentionStore } from "~/modules/shell/attention-store"
import Home from "~/modules/shell/Home"
import { resetHomeCardLayout } from "~/modules/shell/home-card-layout"
import { setHomeFilter } from "~/modules/shell/home-filter"
import { resetTabStore } from "~/modules/shell/tab-store"
import { resetToastStore, toasts } from "~/modules/shell/toast-store"
import { setShellTier } from "~/tests/helpers/shell-tier"

const item = (over: Partial<AttentionItem> & { id: string }): AttentionItem => ({
  app: "kernel",
  entity: "system",
  entityId: over.id,
  kind: "system_alert",
  summary: `summary ${over.id}`,
  urgency: 50,
  occurredAt: "2026-10-12T08:00:00.000Z",
  action: { type: "open_entity", tabType: "kernel:system", entityId: over.id },
  persisted: true,
  ...over,
})
const approval = (id: string): AttentionItem =>
  item({
    id,
    entity: "approval_request",
    kind: "approval_pending",
    action: { type: "decide_approval", approvalId: id },
    metadata: { toolName: "contacts:group_delete", actionLabel: "contacts:group_delete" },
    persisted: false,
  })

const feed: AttentionItem[] = [
  approval("a1"),
  approval("a2"),
  // An access request and a node permission prompt: persisted, but decisions.
  item({ id: "s1", entity: "scope_request", kind: "scope_request" }),
  item({
    id: "np",
    entity: "node_permission_prompt",
    metadata: { nodePermissionPromptId: "p-1" },
  }),
  // Two system alerts (one cluster) and a computed SLA alert (not persisted).
  item({ id: "sys1" }),
  item({ id: "sys2" }),
  item({ id: "sla", app: "tickets", entity: "ticket", kind: "sla_risk", persisted: false }),
  // A ticket awaiting a reply: a computed queue row.
  item({ id: "w1", app: "tickets", entity: "ticket", kind: "awaiting_agent", persisted: false }),
  // Agents: an FYI and a routine that paused.
  item({ id: "n1", entity: "notification", kind: "agent_notification", urgency: 30 }),
  item({
    id: "r1",
    entity: "routine",
    kind: "agent_notification",
    urgency: 30,
    metadata: { routineAlert: { status: "paused" } },
  }),
]

// The store reconciles IN PLACE into the array it was given: every test (and
// the fake server) gets its own copy of the feed.
const fresh = (items: AttentionItem[] = feed) => structuredClone(items)

const ref = (id: string, entity = "system", app = "kernel") => ({
  app,
  entityType: entity,
  entityId: id,
})

beforeEach(() => {
  setShellTier("desktop")
  resetRegistry()
  resetTabStore()
  resetHomeCardLayout()
  resetToastStore()
  setHomeFilter("overview")
  apiStub.post.mockReset()
  apiStub.post.mockImplementation(async (path: string, body?: unknown) => {
    if (path === "/attention-items/mark-read-bulk") {
      const items = (body as { items: { entityId: string }[] }).items
      const read = new Set(items.map((i) => i.entityId))
      serverItems = serverItems.filter((i) => !read.has(i.entityId))
      return { marked: items.length, eventIds: items.map((_, i) => `e-${i}`) }
    }
    return { restored: 2 }
  })
  serverItems = fresh()
  attentionStore._setForTest({ items: fresh(), errors: [], loading: false })
})

// The action reloads the feed; let that settle so it cannot land in the next test.
const settled = () => waitFor(() => expect(attentionStore.loading).toBe(false))

afterEach(async () => {
  await settled()
  cleanup()
  vi.unstubAllGlobals()
})

function bulkCalls() {
  return apiStub.post.mock.calls.filter((c) => c[0] === "/attention-items/mark-read-bulk")
}

async function clickReadAll() {
  fireEvent.click(screen.getByTestId("home-read-all"))
  await waitFor(() => expect(toasts().length).toBe(1))
}

describe("Home: mark all as read", () => {
  it("Overview reads every dismissible item in one request and names the decisions left", async () => {
    render(() => <Home entityId="home" />)
    await clickReadAll()
    expect(bulkCalls()).toHaveLength(1)
    const sent = (bulkCalls()[0]![1] as { items: unknown[] }).items
    expect(sent).toEqual(
      expect.arrayContaining([
        ref("sys1"),
        ref("sys2"),
        ref("n1", "notification"),
        ref("r1", "routine"),
      ]),
    )
    expect(sent).toHaveLength(4)
    // Two approvals, the access request and the node prompt stay.
    expect(toasts()[0]!.message).toBe("Marked 4 as read. 4 decisions still need you.")
  })

  // Walk 2026-10-12: a social reply suggestion (kind approval_pending, a QUEUE
  // row) was counted as a decision left, so Overview said "32 decisions still
  // need you" beside a Needs-you total of 30. Only Needs-you decisions count.
  it("the decisions it names are the Needs-you ones, not queue rows of a decision kind", async () => {
    const suggestion = item({
      id: "sug",
      app: "social",
      entity: "reply_suggestion",
      kind: "approval_pending",
      action: { type: "open_entity", tabType: "social:reply", entityId: "sug" },
      persisted: false,
    })
    serverItems = fresh([...feed, suggestion])
    attentionStore._setForTest({ items: fresh([...feed, suggestion]), errors: [], loading: false })
    render(() => <Home entityId="home" />)
    await clickReadAll()
    expect(toasts()[0]!.message).toBe("Marked 4 as read. 4 decisions still need you.")
  })

  it("Alerts reads only the alerts, and a cluster only its own", async () => {
    render(() => <Home entityId="home" />)
    setHomeFilter("needs:alerts")
    await clickReadAll()
    expect((bulkCalls()[0]![1] as { items: unknown[] }).items).toEqual([ref("sys1"), ref("sys2")])
    expect(toasts()[0]!.message).toBe("Marked 2 as read.")

    await settled()
    resetToastStore()
    serverItems = fresh()
    attentionStore._setForTest({ items: fresh(), errors: [], loading: false })
    setHomeFilter("needs:alerts:kernel::system_alert")
    await clickReadAll()
    expect((bulkCalls()[1]![1] as { items: unknown[] }).items).toEqual([ref("sys1"), ref("sys2")])
  })

  it("Agents entries read just their own rows", async () => {
    render(() => <Home entityId="home" />)
    setHomeFilter("agents:notifications")
    await clickReadAll()
    expect((bulkCalls()[0]![1] as { items: unknown[] }).items).toEqual([ref("n1", "notification")])

    resetToastStore()
    await waitFor(() => expect(attentionStore.items.some((i) => i.id === "n1")).toBe(false))
    setHomeFilter("agents:failed")
    await clickReadAll()
    expect((bulkCalls()[1]![1] as { items: unknown[] }).items).toEqual([ref("r1", "routine")])
    expect(toasts()[0]!.message).toBe("Marked 1 as read.")
  })

  it("New mail (D21a) reads its new-email cards", async () => {
    const mail = item({
      id: "mail:new_email:m1",
      app: "mail",
      entity: "new_email",
      entityId: "m1",
      kind: "new_email" as AttentionItem["kind"],
      urgency: 40,
      action: { type: "open_entity", tabType: "mail:conversation", entityId: "c1" },
    })
    serverItems = fresh([...feed, mail])
    attentionStore._setForTest({ items: fresh([...feed, mail]), errors: [], loading: false })
    render(() => <Home entityId="home" />)
    setHomeFilter("queue:mail")
    await clickReadAll()
    expect((bulkCalls()[0]![1] as { items: unknown[] }).items).toEqual([
      ref("m1", "new_email", "mail"),
    ])
  })

  it("is not offered where every row is a decision or cannot be read", () => {
    render(() => <Home entityId="home" />)
    for (const f of [
      "needs:approvals",
      "needs:approvals:kernel:access_requests",
      "needs:time",
      "queue:tickets",
    ]) {
      setHomeFilter(f)
      expect(screen.queryByTestId("home-read-all"), f).toBeNull()
    }
    setHomeFilter("needs")
    expect(screen.getByTestId("home-read-all")).toBeTruthy()
  })

  it("on a mixed Needs-you slice, approvals alone are named as approvals", async () => {
    const mixed = [approval("a1"), approval("a2"), item({ id: "sys1" })]
    serverItems = fresh(mixed)
    attentionStore._setForTest({ items: fresh(mixed), errors: [], loading: false })
    render(() => <Home entityId="home" />)
    setHomeFilter("needs")
    await clickReadAll()
    expect(toasts()[0]!.message).toBe("Marked 1 as read. 2 approvals still need you.")
  })

  it("the toast's Undo puts back exactly what was read", async () => {
    render(() => <Home entityId="home" />)
    setHomeFilter("needs:alerts")
    await clickReadAll()
    const undo = toasts()[0]!.action
    expect(undo?.label).toBe("Undo")
    undo!.onClick()
    await waitFor(() =>
      expect(apiStub.post).toHaveBeenCalledWith("/attention-items/mark-unread", {
        eventIds: ["e-0", "e-1"],
      }),
    )
  })

  it("is reachable on a phone, in the header above the chips", () => {
    setShellTier("phone")
    render(() => <Home entityId="home" />)
    const header = screen.getByTestId("home-header")
    const button = screen.getByTestId("home-read-all")
    expect(header.contains(button)).toBe(true)
    // Icon only on a phone (walk 2026-10-12: a "Read all" label pushed the
    // greeting onto a second line at 390 px); the name is its aria-label.
    expect(button.textContent?.trim()).toBe("")
    expect(button.getAttribute("aria-label")).toBe("Mark all as read")
  })
})

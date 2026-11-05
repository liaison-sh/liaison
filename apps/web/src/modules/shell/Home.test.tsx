// SPDX-License-Identifier: FSL-1.1-ALv2
import type { AttentionItem } from "@liaison/shared"
import { fireEvent, render, screen } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("~/modules/auth/auth-store", () => ({
  onAuthCleared: () => () => {},
  hasScope: () => true,
  userFromToken: () => ({ userId: "u-1", name: "Tester" }),
}))

const apiGet = vi.fn()
const apiGetEnvelope = vi.fn()
const apiPost = vi.fn(async () => ({}))
const apiPatch = vi.fn(async () => ({}))
const apiPut = vi.fn(async () => ({}))
vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => ({
    get: apiGet,
    getEnvelope: apiGetEnvelope,
    post: apiPost,
    patch: apiPatch,
    put: apiPut,
  }),
  useOptionalApi: () => ({
    get: apiGet,
    getEnvelope: apiGetEnvelope,
    post: apiPost,
    patch: apiPatch,
    put: apiPut,
  }),
}))

import { createSignal } from "solid-js"
import { registerEntityOpener, resetRegistry } from "~/framework/app-registry"
import { attentionStore } from "~/modules/shell/attention-store"
import { resetHomeCardLayout } from "~/modules/shell/home-card-layout"
import { TabVisibilityProvider } from "~/modules/shell/TabVisibilityContext"
import { tabStore } from "~/modules/shell/tab-store"
import { addThread, handleMessageEvent, resetThreadStore } from "~/modules/threads/thread-store"
import Home from "./Home"

const makeOpenEntityItem = (over: Partial<AttentionItem>): AttentionItem => ({
  id: over.id ?? "att-1",
  app: over.app ?? "projects",
  entity: over.entity ?? "task",
  entityId: over.entityId ?? "T1",
  kind: over.kind ?? "task_overdue",
  summary: over.summary ?? "Task is overdue",
  urgency: over.urgency ?? 60,
  occurredAt: over.occurredAt ?? "2026-05-06T12:00:00.000Z",
  action: over.action ?? {
    type: "open_entity",
    tabType: `${over.app ?? "projects"}:${over.entity ?? "task"}`,
    entityId: over.entityId ?? "T1",
  },
  metadata: over.metadata,
})

beforeEach(() => {
  attentionStore._setForTest({ items: [], errors: [], loading: false })
  resetRegistry()
  resetHomeCardLayout()
  resetThreadStore()
  apiGet.mockReset().mockResolvedValue([])
  apiGetEnvelope.mockReset().mockResolvedValue({ data: { items: [], errors: [] } })
  apiPost.mockReset().mockResolvedValue({})
  apiPatch.mockReset().mockResolvedValue({})
  apiPut.mockReset().mockResolvedValue({})
})

const makeMentionItem = (over: Partial<AttentionItem>): AttentionItem => ({
  id: over.id ?? "att-mention-1",
  app: "kernel",
  entity: "thread",
  entityId: over.entityId ?? "thread-1",
  kind: "mention",
  summary: over.summary ?? "Alice mentioned you",
  urgency: 60,
  occurredAt: over.occurredAt ?? "2026-05-06T12:00:00.000Z",
  action: over.action ?? {
    type: "open_entity",
    tabType: "kernel:thread",
    entityId: over.entityId ?? "thread-1",
  },
  persisted: true,
})

const makeApprovalItem = (over: Partial<AttentionItem>): AttentionItem => ({
  id: over.id ?? `att-approval-${Math.random().toString(36).slice(2)}`,
  app: "invoicing",
  entity: "document",
  entityId: over.entityId ?? "doc-1",
  kind: "approval_pending",
  summary: over.summary ?? "Mark invoice paid",
  urgency: 40,
  occurredAt: "2026-05-06T12:00:00.000Z",
  action: { type: "decide_approval", approvalId: over.entityId ?? "doc-1" },
  metadata: over.metadata,
})

function makeThread(over: Partial<Parameters<typeof addThread>[0]> = {}) {
  return {
    id: over.id ?? "thread-1",
    handle: over.handle ?? "thread-1",
    title: over.title ?? "Team sync",
    type: "thread",
    isPinned: false,
    isPinnedByUser: false,
    isMuted: false,
    participants: [{ id: "u-1", name: "Tester", avatarUrl: null }],
    lastMessage: over.lastMessage ?? {
      content: "hey",
      authorId: "u-2",
      authorName: "Alice",
      createdAt: "2026-05-06T12:00:00.000Z",
    },
    unreadCount: over.unreadCount ?? 2,
    updatedAt: over.updatedAt ?? "2026-05-06T12:00:00.000Z",
    ...over,
  }
}

describe("home.unified-feed-no-approvals-store", () => {
  it("home.unified-feed-no-approvals-store", () => {
    attentionStore._setForTest({
      items: [makeOpenEntityItem({ app: "projects", entity: "task" })],
      errors: [],
    })
    render(() => <Home entityId="home" />)
    expect(screen.getByTestId("home-feed")).toBeTruthy()
    // ApprovalCard should not appear because Home no longer reads approvals-store.
    expect(screen.queryByTestId("approval-card-stub")).toBeNull()
  })

  it("home.attention-row-open-entity-opens-through-opener", async () => {
    const item = makeOpenEntityItem({
      app: "projects",
      entity: "task",
      entityId: "T1",
    })
    attentionStore._setForTest({ items: [item], errors: [] })
    registerEntityOpener("projects", "task", (_api, id) => ({
      tabType: "projects:task",
      entityId: id,
      label: `Task ${id}`,
    }))
    render(() => <Home entityId="home" />)
    fireEvent.click(screen.getByTestId("attention-row-projects-task-T1"))
    // openEntity is async — wait a microtask.
    await Promise.resolve()
    await Promise.resolve()
    expect(tabStore.activeTabId).toContain("projects:task")
  })

  it("renders empty state when there are no items", () => {
    render(() => <Home entityId="home" />)
    expect(screen.getByTestId("home-empty-state")).toBeTruthy()
  })

  it("last-updated label advances from just now to 1m ago as the clock ticks", async () => {
    vi.useFakeTimers()
    const base = new Date("2026-05-06T10:00:00.000Z").getTime()
    vi.setSystemTime(base)
    attentionStore._setForTest({
      items: [makeOpenEntityItem({})],
      errors: [],
      lastFetchedAt: base,
    })
    render(() => <Home entityId="home" />)
    expect(screen.getByTestId("home-status").textContent).toContain("just now")

    // Advance past 60s and fire the 30s ticking signal.
    vi.setSystemTime(base + 65_000)
    vi.advanceTimersByTime(30_000)
    await Promise.resolve()
    expect(screen.getByTestId("home-status").textContent).toContain("1m ago")
    vi.useRealTimers()
  })

  it("activation with a stale attention store triggers a reload; a fresh one does not", async () => {
    const reloadSpy = vi.spyOn(attentionStore, "markStaleAndReload").mockImplementation(() => {})
    try {
      // Stale: lastFetchedAt well older than the 60s threshold.
      attentionStore._setForTest({
        items: [makeOpenEntityItem({})],
        errors: [],
        lastFetchedAt: Date.now() - 120_000,
      })
      const [active, setActive] = createSignal(false)
      render(() => (
        <TabVisibilityProvider value={active}>
          <Home entityId="home" />
        </TabVisibilityProvider>
      ))
      expect(reloadSpy).not.toHaveBeenCalled()
      setActive(true)
      await Promise.resolve()
      expect(reloadSpy).toHaveBeenCalledTimes(1)
    } finally {
      reloadSpy.mockRestore()
    }
  })

  it("activation with a fresh attention store does not reload", async () => {
    const reloadSpy = vi.spyOn(attentionStore, "markStaleAndReload").mockImplementation(() => {})
    try {
      attentionStore._setForTest({
        items: [makeOpenEntityItem({})],
        errors: [],
        lastFetchedAt: Date.now(), // fresh
      })
      const [active, setActive] = createSignal(false)
      render(() => (
        <TabVisibilityProvider value={active}>
          <Home entityId="home" />
        </TabVisibilityProvider>
      ))
      setActive(true)
      await Promise.resolve()
      expect(reloadSpy).not.toHaveBeenCalled()
    } finally {
      reloadSpy.mockRestore()
    }
  })

  it("greeting flips from morning to afternoon across a clock tick", async () => {
    vi.useFakeTimers()
    const morning = new Date("2026-05-06T09:00:00.000Z").getTime()
    vi.setSystemTime(morning)
    render(() => <Home entityId="home" />)
    const heading = () => document.querySelector("h1")?.textContent ?? ""
    const local9 = new Date(morning).getHours()
    // Only assert the flip when the fixture's local hour actually starts in the
    // morning band; otherwise the UTC hour maps to a different local band.
    if (local9 < 12) {
      expect(heading()).toContain("Good morning")
      vi.setSystemTime(new Date("2026-05-06T14:00:00.000Z").getTime())
      vi.advanceTimersByTime(30_000)
      await Promise.resolve()
      const localAfternoon = new Date("2026-05-06T14:00:00.000Z").getHours()
      if (localAfternoon >= 12 && localAfternoon < 18) {
        expect(heading()).toContain("Good afternoon")
      }
    }
    vi.useRealTimers()
  })
})

describe("home.cards", () => {
  it("empty approvals card is absent when there are no pending approvals", () => {
    attentionStore._setForTest({
      items: [makeOpenEntityItem({ app: "projects", entity: "task" })],
      errors: [],
    })
    render(() => <Home entityId="home" />)
    expect(screen.queryByTestId("home-card-approvals")).toBeNull()
  })

  it("approvals card renders with its count and folds rows past the cap behind Show more", () => {
    // A 280px inner scroll box used to cap the card: three rows visible, a
    // second scrollbar inside the page's own. The fold keeps the page as the
    // only scroll surface and says how much is hidden.
    const items = Array.from({ length: 10 }, (_, i) =>
      makeApprovalItem({ id: `att-approval-${i}`, entityId: `doc-${i}` }),
    )
    attentionStore._setForTest({ items, errors: [] })
    render(() => <Home entityId="home" />)
    expect(screen.getByTestId("home-card-count-approvals").textContent).toBe("10")
    const body = screen.getByTestId("home-card-body-approvals")
    expect(body.className).not.toContain("overflow-y-auto")
    expect(body.querySelectorAll("li[data-testid^='attention-row-']")).toHaveLength(8)
    const fold = screen.getByTestId("home-approvals-fold")
    expect(fold.textContent).toContain("2")
    fireEvent.click(fold)
    expect(body.querySelectorAll("li[data-testid^='attention-row-']")).toHaveLength(10)
    expect(screen.getByTestId("home-approvals-fold").textContent).toContain("Show fewer")
  })

  // D21: conversations left Home for Messages. An unread thread and a pinned
  // mention used to fill a "Messages" card here; neither renders now.
  it("lists no conversation on Home: no unread thread, no mention", () => {
    addThread(makeThread({ id: "thread-a", title: "Team sync", unreadCount: 2 }))
    addThread(makeThread({ id: "thread-c", title: "Roadmap", unreadCount: 1 }))
    attentionStore._setForTest({
      items: [makeMentionItem({ entityId: "thread-c" })],
      errors: [],
    })
    render(() => <Home entityId="home" />)
    expect(screen.queryByTestId("home-message-row-thread-a")).toBeNull()
    expect(screen.queryByTestId("attention-row-kernel-thread-thread-c")).toBeNull()
    expect(screen.queryByTestId("home-card-messages")).toBeNull()
  })

  // QA THR-09: a hidden reply (not also sent to the channel), and the seat
  // line an agent mention posts in the reply thread, belong to the reply
  // thread. Live, they raised a Home row "Bob: Bob added Personal agent" for
  // the channel, gone on reload.
  it("a hidden reply or a reply-thread system line arriving live adds no Home row for the channel", () => {
    addThread(makeThread({ id: "thread-hidden", title: "QA threads", unreadCount: 0 }))
    attentionStore._setForTest({ items: [], errors: [] })
    render(() => <Home entityId="home" />)
    for (const [id, authorType, content] of [
      ["m-reply", "user", "thread only"],
      ["m-seat", "system", "Bob added Personal agent"],
    ]) {
      handleMessageEvent("create", {
        id,
        threadId: "thread-hidden",
        content,
        authorId: "u-bob",
        authorName: "Bob",
        authorType,
        replyRootId: "root-1",
        alsoInChannel: false,
        createdAt: new Date().toISOString(),
      })
    }
    expect(screen.queryByTestId("home-message-row-thread-hidden")).toBeNull()
  })

  it("mail-app attention items stay in Mail: Home shows no Mail card (D21)", () => {
    attentionStore._setForTest({
      items: [
        makeOpenEntityItem({
          app: "mail",
          entity: "conversation",
          entityId: "conv-1",
          kind: "unassigned",
        }),
      ],
      errors: [],
    })
    render(() => <Home entityId="home" />)
    expect(screen.queryByTestId("home-card-mail")).toBeNull()
    expect(screen.queryByTestId("home-card-feed")).toBeNull()
  })

  it("shows the empty state, not a blank home-feed, when the only attention item is carded-but-unrenderable (thread outside the client's thread cap)", () => {
    // A thread_reply item is excluded from the grouped Activity ledger
    // (carded by the Messages card instead) -- but if its thread is absent
    // from the client's thread-store (outside the 50-thread cap, or before
    // hydration), the Messages card renders nothing for it either. `total()`
    // still counts this item, so a total()-based hasAnyContent gate rendered
    // a blank home-feed container under "NOTHING URGENT" instead of the
    // empty state.
    attentionStore._setForTest({
      items: [
        makeOpenEntityItem({
          app: "kernel",
          entity: "thread",
          entityId: "thread-outside-cap",
          kind: "thread_reply",
          urgency: 30,
        }),
      ],
      errors: [],
    })
    // Deliberately NOT added to the thread-store.
    render(() => <Home entityId="home" />)
    expect(screen.getByTestId("home-empty-state")).toBeTruthy()
    expect(screen.queryByTestId("home-feed")).toBeNull()
  })

  it("an access request is a row of the Approvals card, never an alert", () => {
    attentionStore._setForTest({
      items: [
        makeOpenEntityItem({
          app: "kernel",
          entity: "scope_request",
          kind: "scope_request",
          metadata: { requestedScopes: ["shopify:orders:read"], agentName: "Sales agent" },
        }),
      ],
      errors: [],
    })
    render(() => <Home entityId="home" />)
    const card = screen.getByTestId("home-card-approvals")
    expect(card.querySelector('[data-testid="attention-row-kernel-scope_request-T1"]')).toBeTruthy()
    // Decided with Grant / Deny right on the row.
    expect(screen.getByTestId("attention-row-kernel-scope_request-T1-grant").textContent).toBe(
      "Grant",
    )
    expect(screen.queryByTestId("home-alerts-list")).toBeNull()
    expect(screen.queryByTestId("alert-cluster-kernel::scope_request")).toBeNull()
  })

  // --- Merged Alerts & messages card (2026-09-11) ---
  //
  // A support inbox breaching SLA emits one `sla_risk` item per ticket. Those
  // rendered as an uncapped strip ABOVE the cards, so 24 of them buried the
  // Approvals card and the operator never saw the decisions waiting on them.

  const slaAlerts = (n: number): AttentionItem[] =>
    Array.from({ length: n }, (_, i) =>
      makeOpenEntityItem({
        id: `att-sla-${i}`,
        app: "tickets",
        entity: "ticket",
        entityId: `t-${i}`,
        kind: "sla_risk",
        summary: `SLA approaching for ticket-${i}`,
        urgency: 80,
      }),
    )

  it("collapses identical alerts into one counted, expandable row", () => {
    attentionStore._setForTest({ items: slaAlerts(24), errors: [] })
    render(() => <Home entityId="home" />)

    // 24 items, ONE row.
    const cluster = screen.getByTestId("alert-cluster-tickets::sla_risk")
    expect(cluster).toBeTruthy()
    expect(cluster.textContent).toContain("24 tickets approaching SLA")
    // The individual rows are not rendered until asked for.
    expect(screen.queryByTestId("attention-row-tickets-ticket-t-0")).toBeNull()
    expect(screen.queryByTestId("alert-cluster-items-tickets::sla_risk")).toBeNull()

    // Nothing is hidden: expanding reveals every underlying alert.
    fireEvent.click(cluster.querySelector("button")!)
    expect(screen.getByTestId("alert-cluster-items-tickets::sla_risk")).toBeTruthy()
    expect(screen.getByTestId("attention-row-tickets-ticket-t-0")).toBeTruthy()
    expect(screen.getByTestId("attention-row-tickets-ticket-t-23")).toBeTruthy()
  })

  it("alerts render inside the Messages card, so Approvals is never pushed below them", () => {
    attentionStore._setForTest({
      items: [
        ...slaAlerts(24),
        makeApprovalItem({
          id: "att-appr",
          entityId: "a-1",
          summary: "Create Shopify draft order",
        }),
      ],
      errors: [],
    })
    render(() => <Home entityId="home" />)

    // The separate strip above the cards is gone — alerts live in the card.
    expect(screen.queryByTestId("home-urgent-strip")).toBeNull()
    const list = screen.getByTestId("home-alerts-list")
    expect(list.querySelector('[data-testid="alert-cluster-tickets::sla_risk"]')).toBeTruthy()
    // And 24 alerts cost ONE row, so the approval row still renders.
    expect(screen.getByTestId("attention-row-invoicing-document-a-1")).toBeTruthy()
  })

  it("caps the merged list with an internal scroll once it passes five rows", () => {
    // Six DISTINCT kinds: nothing clusters, so six real rows survive.
    const kinds = [
      "sla_risk",
      "system_alert",
      "task_overdue",
      "admin_action",
      "dm_window_closing",
      "approval_decision",
    ]
    attentionStore._setForTest({
      items: kinds.map((kind, i) =>
        makeOpenEntityItem({
          id: `att-${kind}`,
          app: `app-${i}`,
          entity: "thing",
          entityId: `e-${i}`,
          kind: kind as AttentionItem["kind"],
          urgency: 80,
        }),
      ),
      errors: [],
    })
    render(() => <Home entityId="home" />)
    const list = screen.getByTestId("home-alerts-list")
    expect(list.getAttribute("data-scrollable")).toBe("true")
    expect(list.style.overflowY).toBe("auto")
    expect(list.style.maxHeight).toBe("285px")
  })

  it("a loud alert stream never buries the approval queue", () => {
    // The whole point of the merged card (2026-09-11): everything that matters
    // stays on one normally sized screen. 24 alerts + approvals must both
    // render, the loud one bounded on its own.
    attentionStore._setForTest({
      items: [
        ...slaAlerts(24),
        makeApprovalItem({
          id: "att-appr",
          entityId: "a-1",
          summary: "Create Shopify draft order",
        }),
      ],
      errors: [],
    })
    render(() => <Home entityId="home" />)
    const alerts = screen.getByTestId("home-alerts-list")
    expect(screen.getByTestId("attention-row-invoicing-document-a-1")).toBeTruthy()
    // 24 alerts cost ONE row, so they never need the scroll cap at all here.
    expect(alerts.querySelector('[data-testid="alert-cluster-tickets::sla_risk"]')).toBeTruthy()
    expect(alerts.getAttribute("data-scrollable")).toBeNull()
    // The card counts ITEMS, so 24 clustered alerts still read as 24.
    expect(screen.getByTestId("home-card-count-messages").textContent).toContain("24")
  })

  it("caps a section even when it renders few rows — expanding a cluster must not escape it", () => {
    // The hole a gestalt walk of this fix found: three rows is under any
    // threshold, but one was a cluster of 24, and expanding it grew the section
    // to 27 rows and pushed unread messages back off the page. The cap is
    // therefore unconditional: content that grows after render cannot escape it.
    attentionStore._setForTest({ items: slaAlerts(24), errors: [] })
    render(() => <Home entityId="home" />)
    const list = screen.getByTestId("home-alerts-list")
    // One cluster row only, so the first-render overflow flag is correctly absent...
    expect(list.getAttribute("data-scrollable")).toBeNull()
    // ...but the bound is on regardless.
    expect(list.style.maxHeight).toBe("285px")
    expect(list.style.overflowY).toBe("auto")

    // Expand the 24 alerts: the section holds 25 rows now and is still bounded.
    fireEvent.click(screen.getByTestId("alert-cluster-tickets::sla_risk").querySelector("button")!)
    expect(screen.getByTestId("attention-row-tickets-ticket-t-23")).toBeTruthy()
    expect(list.style.maxHeight).toBe("285px")
    expect(list.style.overflowY).toBe("auto")
  })
})

describe("home.lands-on-the-attention-feed", () => {
  beforeEach(() => {
    // Conversations are not Home content any more (D21): the feed needs an item.
    attentionStore._setForTest({
      items: [makeApprovalItem({ id: "att-landing", entityId: "a-landing" })],
      errors: [],
    })
    addThread(makeThread({ id: "c-1", title: "General", discoverable: true }))
    addThread(
      makeThread({
        id: "d-1",
        title: null,
        discoverable: false,
        participants: [{ id: "u-quinn", name: "Quinn Dupont", avatarUrl: null }],
      }),
    )
  })

  it("Home mounts the attention feed as its landing view", () => {
    render(() => <Home entityId="home" />)
    expect(screen.getByTestId("home")).toBeTruthy()
    expect(screen.getByTestId("home-greeting")).toBeTruthy()
    expect(screen.getByTestId("home-feed")).toBeTruthy()
  })

  it("the landing is not a conversation list, and holds no second copy of the feed", () => {
    render(() => <Home entityId="home" />)
    // The Channels / Direct messages grouping belongs to the Home SIDEBAR.
    expect(screen.queryByTestId("home-threads-landing")).toBeNull()
    expect(screen.queryByTestId("home-landing-row-c-1")).toBeNull()
    // No side pane placement survives: exactly one feed on the surface.
    expect(screen.queryByTestId("attention-side-pane")).toBeNull()
    expect(screen.queryByTestId("attention-pane-toggle")).toBeNull()
    expect(screen.getAllByTestId("home-feed")).toHaveLength(1)
  })

  it("a deep link to the feed lands on the same single feed", () => {
    render(() => <Home entityId="feed" />)
    expect(screen.getAllByTestId("home-feed")).toHaveLength(1)
    expect(screen.queryByTestId("attention-side-pane")).toBeNull()
  })
})

describe("home and a computer chat's permission request", () => {
  // The decision is chat business: Allow / Deny is drawn in its conversation
  // (ThreadNodePermissions). Home only says the agent needs you.
  it("shows the request as a notification that the agent needs you, without Allow / Deny", () => {
    const inTenMinutes = new Date(Date.now() + 10 * 60_000 - 5_000).toISOString()
    attentionStore._setForTest({
      items: [
        makeOpenEntityItem({
          id: "att-routine-failed",
          app: "kernel",
          entity: "agent_notification",
          entityId: "n-1",
          kind: "agent_notification",
          summary: "Routine Bug Fixer run failed",
          urgency: 80,
        }),
        makeOpenEntityItem({
          id: "att-node-prompt",
          app: "kernel",
          entity: "agent_notification",
          entityId: "n-2",
          kind: "agent_notification",
          summary: "Data on Minimac asks to use Bash",
          urgency: 80,
          metadata: {
            nodePermissionPromptId: "prompt-1",
            nodePermission: {
              promptId: "prompt-1",
              jobId: "job-1",
              nodeName: "Minimac",
              agentName: "Data",
              toolName: "Bash",
              summary: "ls",
              expiresAt: inTenMinutes,
            },
          },
        }),
      ],
      errors: [],
    })
    render(() => <Home entityId="home" />)
    expect(screen.queryByTestId("node-permission-card")).toBeNull()
    expect(screen.queryByTestId("node-permission-allow")).toBeNull()
    expect(screen.getByText("Data needs your OK in the chat")).toBeInTheDocument()
  })
})

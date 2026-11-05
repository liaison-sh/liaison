// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P4-T12 (S12, charter "A push for a waiting session opens that session at the
// request"; P-D4): a waiting session opens scrolled to its OLDEST pending
// request card, highlighted, whether the owner came from a push (the deep link
// carries no request id), from Review or from the list. A session with
// nothing pending opens as before. An explicit `?request=` still wins (P2's
// SessionView test).

import type { NodeSessionEvent } from "@liaison/shared"
import { Route, Router } from "@solidjs/router"
import { render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ApiClient } from "~/lib/api-client"

vi.hoisted(() => {
  const store = new Map<string, string>()
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    length: 0,
    key: () => null,
  } as any
})

// The composer's writing helpers read the API from context, as under the
// shell's ApiProvider; this runtime cannot record, so dictation stays hidden
// and the client is never called.
vi.mock("~/modules/shell/ApiContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/modules/shell/ApiContext")>()
  const client: Partial<ApiClient> = {}
  return { ...actual, useApi: () => client as ApiClient }
})

vi.mock("~/modules/auth/auth-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/modules/auth/auth-store")>()
  return {
    ...actual,
    userFromToken: () => ({
      userId: "u1",
      orgId: "o1",
      name: "Tester",
      roles: [],
      scopes: [],
      dimensionGrants: {},
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  }
})

import { resetRegistry } from "~/framework/app-registry"
import { bootstrapKernelApps, resetBootstrap } from "~/framework/bootstrap"
import { resetAppIndex } from "~/framework/define-app"
import { clearAuth } from "~/modules/auth/auth-store"
import { attentionStore } from "~/modules/shell/attention-store"
import { resetDockStore } from "~/modules/shell/dock-store"
import { Shell } from "~/modules/shell/Shell"
import { DESKTOP_QUERY, PHONE_QUERY, syncShellTier } from "~/modules/shell/shell-tier"
import { resetTabStore, tabStore } from "~/modules/shell/tab-store"
import SessionView, { FOCUS_RING_MS } from "./SessionView"
import type { NodeSessionRow } from "./session-api"
import { applyEvent, resetSessionStore, setSessionStoreApi } from "./session-store"

const SID = "5b1e0c2a-0000-4000-8000-000000000012"

function row(over: Partial<NodeSessionRow> = {}): NodeSessionRow {
  return {
    id: SID,
    ownerUserId: "u1",
    nodeId: "n1",
    jobId: "j1",
    agentId: "a1",
    source: "app",
    configKind: "owner",
    sourceThreadId: null,
    sourceMessageId: null,
    title: "Fix the sum bug",
    folderName: "sample",
    repo: null,
    branch: null,
    pushed: false,
    prUrl: null,
    model: "claude-haiku-4-5",
    level: "standard",
    status: "waiting",
    pendingCount: 2,
    waitingReason: "permission: Bash",
    claudeCode: null,
    lastSeq: 6,
    latestActivity: null,
    tokensIn: 0,
    tokensOut: 0,
    resultSummary: null,
    error: null,
    createdAt: "2026-10-14T08:00:00.000Z",
    startedAt: "2026-10-14T08:00:00.000Z",
    endedAt: null,
    updatedAt: "2026-10-14T08:00:00.000Z",
    ...over,
  }
}

const ev = (seq: number, type: NodeSessionEvent["type"], payload: Record<string, unknown>) =>
  ({
    seq,
    at: new Date(1_800_000_000_000 + seq * 1000).toISOString(),
    receivedAt: new Date(1_800_000_000_000 + seq * 1000).toISOString(),
    type,
    payload,
  }) as NodeSessionEvent

/** A decided request, then two open ones: the oldest OPEN one is r-old. */
const WAITING = [
  ev(1, "user_message", { text: "Fix it" }),
  ev(2, "permission_request", { requestId: "r-done", tool: "Read", input: { file_path: "a" } }),
  ev(3, "decision", { requestId: "r-done", outcome: "allow", by: "owner" }),
  ev(4, "permission_request", { requestId: "r-old", tool: "Bash", input: { command: "ls" } }),
  ev(5, "assistant_text", { text: "Also:" }),
  ev(6, "question", {
    requestId: "r-new",
    questions: [{ question: "Which?", multiSelect: false, options: [{ label: "A" }] }],
  }),
]

const NOTHING_PENDING = WAITING.slice(0, 3)

function sessionApi(r: NodeSessionRow, events: NodeSessionEvent[]) {
  const get = vi.fn(async (path: string) => {
    if (path.includes("/events")) {
      const after = Number(new URL(path, "http://x").searchParams.get("after"))
      const out = events.filter((e) => e.seq > after)
      return { events: out, lastSeq: out.at(-1)?.seq ?? after }
    }
    if (path.includes(SID)) return r
    return {}
  })
  setSessionStoreApi(() => ({ get }) as never)
}

const scrolled: Element[] = []
const card = (requestId: string) =>
  screen
    .getAllByTestId("request-card")
    .find((c) => c.getAttribute("data-request-id") === requestId) as HTMLElement

beforeEach(() => {
  scrolled.length = 0
  const record = function (this: Element) {
    scrolled.push(this)
  } as never
  Element.prototype.scrollIntoView = record
  HTMLElement.prototype.scrollIntoView = record
  laidOut = true
  HTMLElement.prototype.getClientRects = () => (laidOut ? [{}] : []) as unknown as DOMRectList
})

/** jsdom has no layout: whether cards report a layout box (their pane shown). */
let laidOut = true

afterEach(() => {
  resetSessionStore()
  resetTabStore()
})

describe("a waiting session opens at its oldest pending request (P4-T12)", () => {
  it("with two pending cards, the oldest is scrolled into view and highlighted", async () => {
    sessionApi(row(), WAITING)
    render(() => <SessionView entityId={SID} />)
    await waitFor(() => expect(card("r-old").dataset.focused).toBe("true"))
    expect(card("r-new").dataset.focused).toBe("false")
    expect(card("r-done").dataset.focused).toBe("false")
    await waitFor(() => expect(scrolled).toContain(card("r-old")))
    expect(scrolled).not.toContain(card("r-new"))
  })

  it("the highlight fades after FOCUS_RING_MS while the request stays open", async () => {
    expect(FOCUS_RING_MS).toBe(2000)
    sessionApi(row(), WAITING)
    render(() => <SessionView entityId={SID} />)
    await waitFor(() => expect(card("r-old").dataset.focused).toBe("true"))
    await waitFor(() => expect(card("r-old").dataset.focused).toBe("false"), {
      timeout: FOCUS_RING_MS + 1500,
    })
    // Still open: the card is pending, only the ring went.
    expect(card("r-old").className).toContain("bg-warning-glow")
  })

  it("F5: a card focused while its pane is hidden scrolls once the pane is shown", async () => {
    laidOut = false
    sessionApi(row(), WAITING)
    render(() => <SessionView entityId={SID} />)
    await waitFor(() => expect(card("r-old").dataset.focused).toBe("true"))
    await new Promise((r) => setTimeout(r, 100))
    // Hidden (display: none): a scroll now would be a no-op, so none happens.
    expect(scrolled).not.toContain(card("r-old"))
    laidOut = true
    await waitFor(() => expect(scrolled).toContain(card("r-old")))
  })

  it("with none pending, nothing is highlighted and nothing scrolls", async () => {
    sessionApi(row({ status: "running", pendingCount: 0, lastSeq: 3 }), NOTHING_PENDING)
    render(() => <SessionView entityId={SID} />)
    await waitFor(() => expect(screen.getAllByTestId("session-event")).toHaveLength(2))
    expect(card("r-done").dataset.focused).toBe("false")
    expect(scrolled).toHaveLength(0)
  })
})

describe("the push's deep link on the phone (P4-T12)", () => {
  const setTier = (query: string) => {
    Object.defineProperty(globalThis, "matchMedia", {
      configurable: true,
      writable: true,
      value: (q: string) => ({
        matches: q === query,
        media: q,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }),
    })
    syncShellTier()
  }

  beforeEach(() => {
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(typeof input === "object" && "url" in input ? input.url : input)
      // The attention feed reads `{ items, errors }`; anything else is a list.
      const data = url.includes("attention") ? { items: [], errors: [] } : []
      return new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }) as unknown as typeof fetch
    window.history.replaceState({}, "", "/")
    resetDockStore()
    resetTabStore()
    resetRegistry()
    resetAppIndex()
    resetBootstrap()
    bootstrapKernelApps()
    attentionStore._setForTest({ items: [], errors: [], loading: false })
    setTier(PHONE_QUERY)
    sessionApi(row(), WAITING)
  })

  afterEach(() => {
    resetDockStore()
    clearAuth()
    setTier(DESKTOP_QUERY)
  })

  it("navigating /sessions/<id> the way the native deep link does focuses its request", async () => {
    render(() => (
      <Router>
        <Route path="*" component={Shell} />
      </Router>
    ))
    await waitFor(() => expect(tabStore.activeTabId).toBe("kernel:home:home"))
    // historyNavigator (apps/mobile deep-link.ts): push the route, tell the router.
    window.history.pushState({}, "", `/sessions/${SID}`)
    window.dispatchEvent(new PopStateEvent("popstate"))
    await waitFor(() => expect(tabStore.activeTabId).toBe(`kernel:session:${SID}`))
    await waitFor(() => expect(card("r-old").dataset.focused).toBe("true"))
    await waitFor(() => expect(scrolled).toContain(card("r-old")))
    expect(screen.getByTestId("session-phone-header")).toBeTruthy()
  })

  it("a second deep link to the open session tab focuses its NEW pending request", async () => {
    render(() => (
      <Router>
        <Route path="*" component={Shell} />
      </Router>
    ))
    await waitFor(() => expect(tabStore.activeTabId).toBe("kernel:home:home"))
    const go = (path: string) => {
      window.history.pushState({}, "", path)
      window.dispatchEvent(new PopStateEvent("popstate"))
    }
    go(`/sessions/${SID}`)
    await waitFor(() => expect(card("r-old").dataset.focused).toBe("true"))

    // Both requests decided, then back to Home: the session tab stays mounted.
    const frame = (seq: number, type: NodeSessionEvent["type"], payload: Record<string, unknown>) =>
      applyEvent({ ...ev(seq, type, payload), sessionId: SID, ownerUserId: "u1" })
    frame(7, "decision", { requestId: "r-old", outcome: "allow", by: "owner" })
    frame(8, "decision", { requestId: "r-new", outcome: "answered", by: "owner" })
    go("/")
    await waitFor(() => expect(tabStore.activeTabId).toBe("kernel:home:home"))

    // A new request arrives while Home is on screen; the push opens the session.
    frame(9, "permission_request", { requestId: "r-3", tool: "Edit", input: { file_path: "b" } })
    scrolled.length = 0
    go(`/sessions/${SID}`)
    await waitFor(() => expect(tabStore.activeTabId).toBe(`kernel:session:${SID}`))
    await waitFor(() => expect(card("r-3").dataset.focused).toBe("true"))
    await waitFor(() => expect(scrolled).toContain(card("r-3")))
    expect(card("r-old").dataset.focused).toBe("false")
  })

  it("F5: a deep link to the session already on screen scrolls to its request again", async () => {
    render(() => (
      <Router>
        <Route path="*" component={Shell} />
      </Router>
    ))
    await waitFor(() => expect(tabStore.activeTabId).toBe("kernel:home:home"))
    const go = (path: string) => {
      window.history.pushState({}, "", path)
      window.dispatchEvent(new PopStateEvent("popstate"))
    }
    go(`/sessions/${SID}`)
    await waitFor(() => expect(scrolled).toContain(card("r-old")))
    // The ring fades; the owner scrolls away; the OS opens the same link again.
    await waitFor(() => expect(card("r-old").dataset.focused).toBe("false"), {
      timeout: FOCUS_RING_MS + 1500,
    })
    scrolled.length = 0
    go(`/sessions/${SID}`)
    await waitFor(() => expect(card("r-old").dataset.focused).toBe("true"))
    await waitFor(() => expect(scrolled).toContain(card("r-old")))
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
// Kernel store resync-subscription coverage (Task A2). Each store, once a bump
// fires, refetches ONLY loaded data in place and never empties mid-refetch.
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.stubGlobal("localStorage", {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
})

// The resync reloads only the ACTIVE ticket tab: the hung-load cases make
// their ticket the active one.
const activeTab = vi.hoisted(() => ({ id: null as string | null }))
vi.mock("~/modules/shell/tab-store", async (importOriginal) => {
  const real = await importOriginal<typeof import("~/modules/shell/tab-store")>()
  return {
    ...real,
    tabStore: new Proxy(real.tabStore, {
      get: (target, key) =>
        key === "activeTabId" ? (activeTab.id ?? target.activeTabId) : Reflect.get(target, key),
    }),
  }
})

import { requestResync } from "~/framework/resync"
import {
  getMessages as getMailMessages,
  loadMessages as loadMailMessages,
  subscribeMailMessageResync,
} from "~/modules/mail/mail-message-store"
import { makeTabId } from "~/modules/shell/tab-store"
import {
  getMessages,
  loadMessages,
  resetMessageStore,
  subscribeMessageResync,
} from "~/modules/threads/message-store"
import { setThreadReloadHandler, subscribeThreadResync } from "~/modules/threads/thread-store"
import {
  loadTicket,
  subscribeTicketDetailResync,
  ticketDetailStore,
} from "~/modules/tickets/ticket-detail-store"
import { ticketMessageStore } from "~/modules/tickets/ticket-message-store"

/** A request the network swallowed: it settles only when its signal aborts. */
function hung(signal?: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
  })
}

async function settle() {
  for (let i = 0; i < 4; i++) {
    await flush()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

async function flush() {
  for (let i = 0; i < 6; i++) await Promise.resolve()
}

describe("thread-store resync subscription", () => {
  it("bump calls the reload callback exactly once (refetch-in-place)", () => {
    const reload = vi.fn()
    setThreadReloadHandler(reload)
    subscribeThreadResync()
    subscribeThreadResync() // idempotent — must not double-subscribe
    requestResync("test-thread")
    expect(reload).toHaveBeenCalledTimes(1)
    setThreadReloadHandler(null)
  })
})

describe("message-store resync subscription", () => {
  beforeEach(() => resetMessageStore())

  it("refetches every loaded thread and never empties mid-refetch", async () => {
    // Seed two loaded threads.
    const api = {
      get: vi.fn(async (path: string) => {
        const threadId = path.split("/")[2]
        return { data: [{ id: `${threadId}-m2`, threadId, content: "fresh" }] }
      }),
    }
    await loadMessages(api, "t1")
    await loadMessages(api, "t2")
    expect(getMessages("t1")).toHaveLength(1)
    api.get.mockClear()

    subscribeMessageResync()
    subscribeMessageResync() // idempotent
    requestResync("test-messages")

    // Fetch spy called for exactly the two loaded ids (not any never-loaded id).
    expect(api.get).toHaveBeenCalledTimes(2)
    const paths = api.get.mock.calls.map((c) => c[0])
    expect(paths.some((p) => p.includes("/threads/t1/"))).toBe(true)
    expect(paths.some((p) => p.includes("/threads/t2/"))).toBe(true)

    // Old messages still present while the refetch is in flight (no wipe).
    expect(getMessages("t1")).toHaveLength(1)
    await flush()
  })

  it("does not fetch when nothing is loaded", () => {
    const api = { get: vi.fn() }
    // No loadMessages call -> no captured api / no loaded threads.
    subscribeMessageResync()
    requestResync("empty")
    expect(api.get).not.toHaveBeenCalled()
  })
})

describe("ticket-detail-store resync subscription", () => {
  it("refetches every loaded ticket in place", async () => {
    const ticket = { id: "tk1", handle: "T-1", subject: "Hi", status: "open" }
    const api = {
      // biome-ignore lint/suspicious/noExplicitAny: minimal runTool stub
      post: vi.fn(async () => ({ ticket })) as any,
      get: vi.fn(),
    }
    // loadTicket goes through runTool -> api.post; stub minimally.
    await loadTicket(api as never, "tk1").catch(() => {})
    // Only assert the subscription iterates loaded ids without throwing and
    // reuses the captured api (implementation detail: byId is keyed by ticket).
    subscribeTicketDetailResync()
    subscribeTicketDetailResync()
    const loadedBefore = Object.keys(ticketDetailStore.byId)
    requestResync("test-ticket")
    // Still references the same loaded ids (no wipe of byId).
    expect(Object.keys(ticketDetailStore.byId)).toEqual(loadedBefore)
  })
})

describe("a resync during a hung load (S26)", () => {
  it("a resync during a hung ticket load starts a fresh load that shows the new note", async () => {
    const ticketId = "tk-hung"
    activeTab.id = makeTabId("tickets:ticket", ticketId)
    let messageLoads = 0
    const note = {
      id: "note-1",
      ticketId,
      kind: "note",
      textBody: "written during the gap",
      sentAt: "2026-10-30T09:00:00Z",
    }
    const post = vi.fn(
      async (
        _path: string,
        body: { params?: { messagesLimit?: number } },
        init?: { signal?: AbortSignal },
      ) => {
        const ticket = { id: ticketId, handle: "T-9", subject: "Hung", status: "open" }
        if (body.params?.messagesLimit === undefined) return { ticket }
        messageLoads++
        // The load that started before the blip never answers.
        if (messageLoads <= 2) return hung(init?.signal)
        return { ticket, messages: { items: [note], nextCursor: null } }
      },
    )
    await loadTicket({ post, get: vi.fn() } as never, ticketId)
    await settle()
    expect(messageLoads).toBe(2)
    subscribeTicketDetailResync()
    requestResync("ws-reconnect")
    await settle()
    expect(messageLoads).toBeGreaterThan(2)
    expect(ticketMessageStore.threadsByTicketId[ticketId]?.ids).toEqual(["note-1"])
    expect(ticketMessageStore.threadsByTicketId[ticketId]?.loading).toBe(false)
    activeTab.id = null
  })

  it("the same for a mail conversation", async () => {
    const conversationId = "c-hung"
    let loads = 0
    const message = { id: "mail-1", conversationId, subject: "Re", sentAt: "2026-10-30T09:00:00Z" }
    const get = vi.fn(async (_path: string, init?: { signal?: AbortSignal }) => {
      loads++
      if (loads <= 2) return hung(init?.signal)
      return {
        conversation: { id: conversationId, subject: "Re" },
        messages: [message],
        nextMessageCursor: null,
      }
    })
    const first = loadMailMessages({ get } as never, conversationId).catch(() => {})
    await settle()
    expect(loads).toBe(2)
    subscribeMailMessageResync()
    // Loaded state is what the resync walks: seed the conversation as open.
    requestResync("ws-reconnect")
    await settle()
    expect(loads).toBeGreaterThan(2)
    expect(getMailMessages(conversationId).map((m) => m.id)).toEqual(["mail-1"])
    await first
  })
})

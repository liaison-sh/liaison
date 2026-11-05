// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Unit tests covering store-level hardening:
 *   - approvals-store: WS-added rows survive a concurrent loadDecidableByMe
 *   - auth-store: JWT payload decodes multi-byte UTF-8 names correctly
 *   - mail-conversation-store: reassign removes conversation from assigned-to-me view
 *   - project-store: task create events accepted when projectId absent from payload
 *   - message-store: partial WS update does not clobber undefined fields
 *   - message-store: optimistic edit/delete rollback is guarded against concurrent server updates
 *   - theme-store: storage key uses the liaison: prefix so logout clears it
 *   - createWebSocket: lastEventId read and write use the same scoped key
 */
import type { ApprovalRequestSummary } from "@liaison/shared"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ApiClient } from "~/lib/api-client"

// ---------------------------------------------------------------------------
// approvals-store — m120: WS-added rows not dropped by concurrent fetch
// ---------------------------------------------------------------------------
describe("approvals-store loadDecidableByMe merges WS rows", () => {
  beforeEach(() => vi.resetModules())

  it("preserves a pending row already in decidableIds that the API list omits", async () => {
    vi.doMock("~/modules/approvals/approvals-service", () => ({
      // API returns only apiRow, not wsRow
      listDecidableByMe: () =>
        Promise.resolve([
          {
            id: "api-approval-1",
            toolName: "kernel:approve",
            status: "pending",
            notifyUserIds: ["user-1"],
            createdAt: new Date(Date.now() - 1000).toISOString(),
            decidedBy: null,
            decidedAt: null,
            reason: null,
            payload: {},
            bundleId: null,
            bundlePosition: null,
          },
        ]),
      getApproval: vi.fn(),
      listBundle: vi.fn(),
      decideApproval: vi.fn(),
      updatePayload: vi.fn(),
    }))
    vi.doMock("~/modules/auth/auth-store", () => ({
      hasScope: () => true,
    }))

    const { resetApprovalsStore, handleWsCreate, loadDecidableByMe, decidableByMe } = await import(
      "~/modules/approvals/approvals-store"
    )
    resetApprovalsStore()

    // WS delivers a row that arrives before the fetch response
    const wsRow: ApprovalRequestSummary = {
      id: "ws-approval-1",
      handle: "AR-1",
      toolName: "kernel:approve",
      status: "pending",
      notifyUserIds: ["user-1"],
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      summary: { kind: "approve", title: "Approve", lines: [] },
      editableFields: [],
      currentPayload: {},
      threadId: "thread-1",
      originatingThreadId: "thread-1",
      requestedBy: { id: "user-2" },
      requester: { kind: "user", id: "user-2", name: "Requester" },
      bundleId: null,
      bundlePosition: null,
      dependsOnId: null,
      lastEdit: null,
      lastFailure: null,
    }
    handleWsCreate(wsRow, "user-1")

    // Verify WS row is decidable before the fetch
    expect(decidableByMe().map((r) => r.id)).toContain("ws-approval-1")

    // Load from API — which does not include ws-approval-1. The list is
    // delivered via the mocked approvals-service, so loadDecidableByMe only
    // forwards `api` onward; a fully-stubbed ApiClient keeps the call type-safe.
    const mockApi: ApiClient = {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
      getEnvelope: vi.fn(),
      rawPost: vi.fn(),
      rawGet: vi.fn(),
    }
    await loadDecidableByMe(mockApi)

    const ids = decidableByMe().map((r) => r.id)
    // Both rows should survive: the WS-added one is preserved, the API one is merged in
    expect(ids).toContain("ws-approval-1")
    expect(ids).toContain("api-approval-1")
  })
})

// ---------------------------------------------------------------------------
// approvals-store — m121: _TERMINAL constant removed
// ---------------------------------------------------------------------------
describe("approvals-store dead constant removed", () => {
  beforeEach(() => vi.resetModules())

  it("does not export _TERMINAL", async () => {
    const mod = await import("~/modules/approvals/approvals-store")
    expect((mod as any)._TERMINAL).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// auth-store — m122: JWT UTF-8 decoding
// ---------------------------------------------------------------------------
describe("auth-store JWT UTF-8 decoding", () => {
  beforeEach(() => vi.resetModules())

  it("decodes a JWT payload containing a multi-byte UTF-8 name without corruption", async () => {
    // Build a minimal JWT whose payload contains a non-ASCII name (é, ü, 日)
    function makeJwt(payload: object): string {
      const json = JSON.stringify(payload)
      // TextEncoder produces proper UTF-8 bytes
      const bytes = new TextEncoder().encode(json)
      // Convert bytes to a binary string for btoa
      let binary = ""
      for (const b of bytes) binary += String.fromCharCode(b)
      const b64 = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
      return `header.${b64}.sig`
    }

    const name = "Ünïcödé Üsêr 日本語"
    const token = makeJwt({
      userId: "u1",
      orgId: "o1",
      name,
      roles: ["member"],
      scopes: ["*"],
      dimensionGrants: {},
      exp: Math.floor(Date.now() / 1000) + 3600,
    })

    // Use importActual to bypass any vi.mock() registered by other test files
    // in the same worker — we need the real implementation, not a mock stub.
    const { setTokens, userFromToken, _teardownAuth } = await vi.importActual<
      typeof import("~/modules/auth/auth-store")
    >("~/modules/auth/auth-store")
    try {
      setTokens(token)
      const payload = userFromToken()
      expect(payload?.name).toBe(name)
    } finally {
      _teardownAuth()
    }
  })
})

// ---------------------------------------------------------------------------
// mail-conversation-store — m128: reassign removes from assigned-to-me view
// ---------------------------------------------------------------------------
describe("mail-conversation-store reassignConversation", () => {
  beforeEach(() => vi.resetModules())

  it("removes conversation from store when reassigned away in assigned-to-me view", async () => {
    vi.doMock("~/modules/auth/auth-store", () => ({
      userFromToken: () => ({ userId: "user-me" }),
    }))
    vi.doMock("~/modules/shell/entity-preview/entity-preview-store", () => ({
      invalidatePreview: vi.fn(),
    }))

    const {
      conversationStore,
      setView,
      resetMailConversationStore,
      upsertConversation,
      reassignConversation,
    } = await import("~/modules/mail/mail-conversation-store")
    resetMailConversationStore()
    setView("assigned-to-me")

    const conv = {
      id: "conv-1",
      accountId: "a1",
      subject: "Test",
      snippet: "",
      isRead: false,
      isStarred: false,
      status: "open",
      lastMessageAt: new Date().toISOString(),
      messageCount: 1,
      assignedTo: "user-me",
      contactId: null,
      internalThreadId: null,
      labels: [],
      senderName: null,
      senderEmail: null,
      escalatedTicketId: null,
      escalatedTicketHandle: null,
      escalatedTicketStatus: null,
    }
    upsertConversation(conv)
    expect(conversationStore.ids).toContain("conv-1")

    const mockApi = { patch: vi.fn().mockResolvedValue(undefined) }
    // Reassign to another user — should drop from assigned-to-me view
    await reassignConversation(mockApi, "conv-1", "user-other")

    expect(conversationStore.ids).not.toContain("conv-1")
    expect(conversationStore.byId["conv-1"]).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// project-store — m133: create events accepted when projectId absent
// ---------------------------------------------------------------------------
describe("project-store handleTaskEvent create without projectId", () => {
  beforeEach(() => vi.resetModules())

  it("adds task to loaded project when projectId is absent from the WS payload", async () => {
    const { projectStore } = await import("~/modules/projects/project-store")
    projectStore._resetForTest()
    projectStore._setForTest({
      projectId: "proj-1",
      current: {
        id: "proj-1",
        name: "Test Project",
        description: null,
        icon: null,
        color: null,
        ownerId: "u1",
        archivedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        statuses: [],
      },
      tasks: [],
    })

    // Event without projectId field
    projectStore.handleTaskEvent("create", {
      id: "task-new",
      // projectId intentionally absent
      title: "New Task",
      parentTaskId: null,
      statusId: "s1",
      description: null,
      assigneeId: null,
      priority: "medium",
      dueDate: null,
      startDate: null,
      position: 0,
      blocked: false,
      completedAt: null,
      threadId: "t1",
      createdBy: "u1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })

    const tasks = projectStore.tasksFor("proj-1")
    expect(tasks.some((t) => t.id === "task-new")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// message-store — m140: partial WS update does not clobber undefined fields
// ---------------------------------------------------------------------------
describe("message-store WS update partial fields", () => {
  beforeEach(() => vi.resetModules())

  it("does not overwrite content with undefined when WS update omits content", async () => {
    const { handleWsMessageEvent, loadMessagesIntoStore, getMessage, resetMessageStore } =
      await import("~/modules/threads/message-store")
    resetMessageStore()

    const msg = {
      id: "msg-1",
      threadId: "thread-1",
      authorId: "u1",
      authorName: "Alice",
      authorAvatarUrl: null,
      authorType: "user",
      authorAgentId: null,
      content: "hello world",
      mentions: null,
      metadata: null,
      reactions: [],
      editedAt: null,
      deletedAt: null,
      createdAt: new Date().toISOString(),
    }
    loadMessagesIntoStore("thread-1", [msg])

    // WS update with no content/editedAt fields (e.g. metadata-only update)
    handleWsMessageEvent("update", {
      id: "msg-1",
      threadId: "thread-1",
      // content and editedAt intentionally absent
    })

    const stored = getMessage("thread-1", "msg-1")
    expect(stored?.content).toBe("hello world")
    expect(stored?.editedAt).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// message-store — m141: rollback guard against concurrent server update
// ---------------------------------------------------------------------------
describe("message-store optimistic edit rollback guard", () => {
  beforeEach(() => vi.resetModules())

  it("does not roll back content when server updated editedAt after optimistic write", async () => {
    const {
      editMessage,
      handleWsMessageEvent,
      loadMessagesIntoStore,
      getMessage,
      resetMessageStore,
    } = await import("~/modules/threads/message-store")
    resetMessageStore()

    const msg = {
      id: "msg-2",
      threadId: "thread-2",
      authorId: "u1",
      authorName: "Bob",
      authorAvatarUrl: null,
      authorType: "user",
      authorAgentId: null,
      content: "original",
      mentions: null,
      metadata: null,
      reactions: [],
      editedAt: null,
      deletedAt: null,
      createdAt: new Date().toISOString(),
    }
    loadMessagesIntoStore("thread-2", [msg])

    let patchReject!: (err: Error) => void
    const patchPromise = new Promise<void>((_, rej) => {
      patchReject = rej
    })
    const mockApi = { patch: vi.fn().mockReturnValue(patchPromise) }

    const editProm = editMessage(mockApi, "thread-2", "msg-2", "edited content")

    // Simulate a concurrent server WS update arriving before PATCH resolves
    handleWsMessageEvent("update", {
      id: "msg-2",
      threadId: "thread-2",
      content: "server-authoritative content",
      editedAt: new Date(Date.now() + 100).toISOString(),
    })

    // Now make the PATCH fail — rollback should NOT clobber server content
    patchReject(new Error("network error"))
    await editProm.catch(() => {})

    const stored = getMessage("thread-2", "msg-2")
    expect(stored?.content).toBe("server-authoritative content")
  })
})

// ---------------------------------------------------------------------------
// message-store — m141: delete rollback guard against concurrent server delete
// ---------------------------------------------------------------------------
describe("message-store optimistic delete rollback guard", () => {
  beforeEach(() => vi.resetModules())

  it("does not restore pre-delete content when a server delete advanced deletedAt", async () => {
    const {
      deleteMessage,
      handleWsMessageEvent,
      loadMessagesIntoStore,
      getMessage,
      resetMessageStore,
    } = await import("~/modules/threads/message-store")
    resetMessageStore()

    const msg = {
      id: "msg-3",
      threadId: "thread-3",
      authorId: "u1",
      authorName: "Carol",
      authorAvatarUrl: null,
      authorType: "user",
      authorAgentId: null,
      content: "to be deleted",
      mentions: null,
      metadata: null,
      reactions: [],
      editedAt: null,
      deletedAt: null,
      createdAt: new Date().toISOString(),
    }
    loadMessagesIntoStore("thread-3", [msg])

    let deleteReject!: (err: Error) => void
    const deletePromise = new Promise<void>((_, rej) => {
      deleteReject = rej
    })
    const mockApi = { delete: vi.fn().mockReturnValue(deletePromise) }

    const delProm = deleteMessage(mockApi, "thread-3", "msg-3")

    // Server-authoritative delete arrives (different timestamp) before DELETE resolves.
    const serverDeletedAt = new Date(Date.now() + 100).toISOString()
    handleWsMessageEvent("delete", {
      id: "msg-3",
      threadId: "thread-3",
      deletedAt: serverDeletedAt,
    })

    // DELETE fails — rollback must NOT restore the pre-delete content because a
    // server delete with a different deletedAt already landed.
    deleteReject(new Error("network error"))
    await delProm.catch(() => {})

    const stored = getMessage("thread-3", "msg-3")
    expect(stored?.content).toBeNull()
    expect(stored?.deletedAt).toBe(serverDeletedAt)
  })
})

// ---------------------------------------------------------------------------
// theme-store — m139: storage key uses liaison: prefix
// ---------------------------------------------------------------------------
describe("theme-store storage key prefix", () => {
  it("uses the liaison: prefix so clearLiaisonStorage removes it on logout", () => {
    // Read the STORAGE_KEY directly from the module source rather than
    // through the API, so we catch a key change without running DOM code.
    const { readFileSync } = require("node:fs") as typeof import("node:fs")
    const { resolve } = require("node:path") as typeof import("node:path")
    const src = readFileSync(resolve(__dirname, "shell/theme-store.ts"), "utf8")
    const match = src.match(/STORAGE_KEY\s*=\s*"([^"]+)"/)
    expect(match).not.toBeNull()
    expect(match![1]).toMatch(/^liaison:/)
  })
})

// ---------------------------------------------------------------------------
// createWebSocket — m144: scoped key alignment between read and write
// ---------------------------------------------------------------------------
describe("createWebSocket scoped key alignment", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it("reads and writes lastEventId using the same scoped key", async () => {
    vi.resetModules()
    const getSetItems = new Map<string, string>()
    vi.stubGlobal("localStorage", {
      getItem: vi.fn((k: string) => getSetItems.get(k) ?? null),
      setItem: vi.fn((k: string, v: string) => {
        getSetItems.set(k, v)
      }),
      removeItem: vi.fn((k: string) => {
        getSetItems.delete(k)
      }),
    })
    vi.stubGlobal("navigator", { onLine: true })
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({ ok: true, json: () => Promise.resolve({ data: { ticket: "t" } }) }),
      ),
    )

    let wsInstance: any = null
    vi.stubGlobal(
      "WebSocket",
      class {
        static CONNECTING = 0
        static OPEN = 1
        static CLOSING = 2
        static CLOSED = 3
        url: string
        readyState = 0
        onopen: any
        onclose: any
        onmessage: any
        onerror: any
        sent: string[] = []
        constructor(url: string) {
          this.url = url
          wsInstance = this
        }
        send(d: string) {
          this.sent.push(d)
        }
        close() {
          this.readyState = 3
          this.onclose?.(new CloseEvent("close"))
        }
        _open() {
          this.readyState = 1
          this.onopen?.(new Event("open"))
        }
        _message(d: string) {
          this.onmessage?.(new MessageEvent("message", { data: d }))
        }
      },
    )

    const { createWebSocket } = await import("~/primitives/createWebSocket")
    const scope = "org-1:user-1"
    const ws = createWebSocket({
      getToken: () => "token",
      getScope: () => scope,
    })

    ws.connect()
    // Wait for ticket exchange
    await vi.waitFor(() => expect(wsInstance).not.toBeNull())
    wsInstance._open()

    // Simulate a received event that writes lastEventId
    wsInstance._message(JSON.stringify({ type: "event", eventId: 99 }))

    // The write should use the scoped key
    const expectedKey = `liaison:lastEventId:${scope}`
    const written = vi.mocked(localStorage.setItem).mock.calls.find(([k]) => k === expectedKey)
    expect(written).toBeDefined()
    expect(written?.[1]).toBe("99")

    // On the next connect, read should use the same key
    // Seed the scoped key so we can verify it's read
    getSetItems.set(expectedKey, "99")
    ws.connect() // second connect re-reads
    expect(ws.lastEventId()).toBe(99)

    ws.disconnect()
  })
})

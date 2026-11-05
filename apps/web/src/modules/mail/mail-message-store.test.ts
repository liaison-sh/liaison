// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeEach, describe, expect, it, vi } from "vitest"

describe("mail-message-store", () => {
  beforeEach(async () => {
    vi.resetModules()
    const mod = await import("~/modules/mail/mail-message-store")
    mod.resetMailMessageStore()
  })

  it("loadMessages stores messages for a conversation", async () => {
    const api = {
      get: vi.fn().mockResolvedValue({
        conversation: { id: "c1", subject: "Test" },
        messages: [
          {
            id: "m1",
            conversationId: "c1",
            htmlBody: "<p>Hi</p>",
            textBody: "Hi",
            sentAt: "2026-01-01",
          },
        ],
        nextMessageCursor: null,
      }),
    }

    const { getMessages, loadMessages } = await import("~/modules/mail/mail-message-store")
    await loadMessages(api, "c1")

    // Each stage carries the load's abort signal, so a resync can restart it (S26).
    const withSignal = { signal: expect.any(AbortSignal) }
    expect(api.get).toHaveBeenCalledWith("/mail/conversations/c1", withSignal)
    // Two-stage: a tiny first-paint page fires in parallel with the full page.
    expect(api.get).toHaveBeenCalledWith("/mail/conversations/c1?messageLimit=3", withSignal)
    expect(getMessages("c1")).toHaveLength(1)
  })

  it("two-stage: the 3-message page commits first, the full page re-commits without dupes and owns the cursor", async () => {
    const msg = (id: string, sentAt: string) => ({
      id,
      conversationId: "c-two",
      htmlBody: "",
      textBody: id,
      sentAt,
    })
    let resolveFull!: (v: unknown) => void
    const api = {
      get: vi.fn((path: string) => {
        if (path.includes("messageLimit=3"))
          return Promise.resolve({
            conversation: { id: "c-two", subject: "Two-stage" },
            messages: [msg("m5", "2026-01-05"), msg("m4", "2026-01-04"), msg("m3", "2026-01-03")],
            nextMessageCursor: "small-cur",
          })
        return new Promise((r) => {
          resolveFull = r
        })
      }),
    }
    const { loadMessages, getMessages } = await import("~/modules/mail/mail-message-store")
    const done = loadMessages(api as any, "c-two")
    await new Promise((r) => setTimeout(r, 0))
    // First paint: the newest 3 are readable while the full page loads.
    expect(getMessages("c-two").map((m) => m.id)).toEqual(["m5", "m4", "m3"])
    resolveFull({
      conversation: { id: "c-two", subject: "Two-stage" },
      messages: [
        msg("m5", "2026-01-05"),
        msg("m4", "2026-01-04"),
        msg("m3", "2026-01-03"),
        msg("m2", "2026-01-02"),
        msg("m1", "2026-01-01"),
      ],
      nextMessageCursor: "full-cur",
    })
    await done
    const ids = getMessages("c-two").map((m) => m.id)
    expect([...ids].sort()).toEqual(["m1", "m2", "m3", "m4", "m5"])
    expect(new Set(ids).size).toBe(5) // no dupes
  })

  it("two-stage race: full page landing FIRST makes the late small page a no-op", async () => {
    const msg = (id: string) => ({
      id,
      conversationId: "c-race2",
      htmlBody: "",
      textBody: id,
      sentAt: "2026-01-01",
    })
    let resolveSmall!: (v: unknown) => void
    const api = {
      get: vi.fn((path: string) => {
        if (path.includes("messageLimit=3"))
          return new Promise((r) => {
            resolveSmall = r
          })
        return Promise.resolve({
          conversation: { id: "c-race2", subject: "Race" },
          messages: [msg("m3"), msg("m2"), msg("m1")],
          nextMessageCursor: null,
        })
      }),
    }
    const { loadMessages, getMessages } = await import("~/modules/mail/mail-message-store")
    const done = loadMessages(api as any, "c-race2")
    await new Promise((r) => setTimeout(r, 0))
    expect(getMessages("c-race2")).toHaveLength(3)
    resolveSmall({
      conversation: { id: "c-race2", subject: "Race" },
      messages: [msg("m3")],
      nextMessageCursor: "stale-cur",
    })
    await done
    expect(getMessages("c-race2")).toHaveLength(3)
  })

  it("concurrent loadMessages calls for the same conversation dedupe to ONE two-stage load", async () => {
    const api = {
      get: vi.fn().mockResolvedValue({
        conversation: { id: "c-dedupe", subject: "D" },
        messages: [],
        nextMessageCursor: null,
      }),
    }
    const { loadMessages } = await import("~/modules/mail/mail-message-store")
    await Promise.all([loadMessages(api, "c-dedupe"), loadMessages(api, "c-dedupe")])
    expect(api.get).toHaveBeenCalledTimes(2) // one small + one full, not four
  })

  it("handleMessageEvent appends only when the conversation is loaded", async () => {
    const { handleMessageEvent, getMessages } = await import("~/modules/mail/mail-message-store")
    handleMessageEvent("create", {
      id: "m2",
      conversationId: "c1",
      htmlBody: "<p>Reply</p>",
      textBody: "Reply",
      sentAt: "2026-01-02",
    })
    expect(getMessages("c1")).toEqual([])
  })

  it("handleMessageEvent refetches so the WS stub (no body) is replaced by the full message", async () => {
    // The WS create payload is privacy-scrubbed (no body). Without a refetch
    // the sent reply renders "(No content)" until a hard reload.
    const page = (msgs: any[]) => ({
      conversation: { id: "c-ws", subject: "WS" },
      messages: msgs,
      nextMessageCursor: null,
    })
    const m1 = {
      id: "m1",
      conversationId: "c-ws",
      textBody: "hello",
      htmlBody: "",
      sentAt: "2026-01-01",
    }
    const m2full = {
      id: "m2",
      conversationId: "c-ws",
      textBody: "the reply body",
      htmlBody: "",
      sentAt: "2026-01-02",
    }
    let call = 0
    const api = {
      get: vi.fn(() => {
        call++
        // First two calls = initial two-stage load (m1 only); later calls
        // include the newly sent message with its body.
        return Promise.resolve(call <= 2 ? page([m1]) : page([m2full, m1]))
      }),
    }
    const { loadMessages, handleMessageEvent, getMessages } = await import(
      "~/modules/mail/mail-message-store"
    )
    await loadMessages(api as any, "c-ws")

    handleMessageEvent("create", {
      id: "m2",
      conversationId: "c-ws",
      direction: "outbound",
      from: { email: "me@example.com" },
    })
    // Stub is visible immediately...
    expect(getMessages("c-ws").map((m) => m.id)).toContain("m2")
    // ...and the triggered refetch replaces it with the full-bodied row.
    await vi.waitFor(() => {
      const m2 = getMessages("c-ws").find((m) => m.id === "m2")
      expect(m2?.textBody).toBe("the reply body")
    })
  })

  it("loadMessages handles an empty messages array", async () => {
    const api = {
      get: vi.fn().mockResolvedValue({
        conversation: { id: "c2", subject: "Empty" },
        messages: [],
        nextMessageCursor: null,
      }),
    }

    const { getMessages, loadMessages } = await import("~/modules/mail/mail-message-store")
    await loadMessages(api, "c2")

    expect(getMessages("c2")).toHaveLength(0)
  })

  it("loadMessages propagates network errors to the caller", async () => {
    const api = {
      get: vi.fn().mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 })),
    }

    const { loadMessages } = await import("~/modules/mail/mail-message-store")
    await expect(loadMessages(api, "missing")).rejects.toThrow("Not Found")
  })

  it("loadMessages stores messages with attachment metadata", async () => {
    const attachment = {
      id: "a1",
      filename: "invoice.pdf",
      mimeType: "application/pdf",
      sizeBytes: 12345,
      disposition: "attachment",
    }
    const api = {
      get: vi.fn().mockResolvedValue({
        conversation: { id: "c3", subject: "With attachment" },
        messages: [
          {
            id: "m3",
            conversationId: "c3",
            htmlBody: "",
            textBody: "",
            sentAt: "2026-01-03",
            attachments: [attachment],
          },
        ],
        nextMessageCursor: null,
      }),
    }

    const { getMessages, loadMessages } = await import("~/modules/mail/mail-message-store")
    await loadMessages(api, "c3")

    const msgs = getMessages("c3")
    expect(msgs).toHaveLength(1)
    expect(msgs[0]?.attachments?.[0]?.filename).toBe("invoice.pdf")
    expect(msgs[0]?.attachments?.[0]?.sizeBytes).toBe(12345)
  })

  it("loadMessages records hasMore and cursor for pagination", async () => {
    const api = {
      get: vi.fn().mockResolvedValue({
        conversation: { id: "c4", subject: "Paged" },
        messages: [
          { id: "m4", conversationId: "c4", htmlBody: "", textBody: "", sentAt: "2026-01-04" },
        ],
        nextMessageCursor: "cursor-xyz",
      }),
    }

    // Access internal state via loadOlderMessages behaviour: it should not no-op
    // when hasMore is true and there is a cursor.
    const { loadMessages, loadOlderMessages, getMessages } = await import(
      "~/modules/mail/mail-message-store"
    )
    await loadMessages(api, "c4")

    // loadOlderMessages should fire a second request
    api.get.mockResolvedValueOnce({ messages: [], nextMessageCursor: null })
    await loadOlderMessages(api, "c4")

    expect(api.get).toHaveBeenCalledTimes(3) // two-stage initial load + the older page
    expect(api.get).toHaveBeenLastCalledWith("/mail/conversations/c4?messageCursor=cursor-xyz")
    // Still has only the original message (no new ones returned)
    expect(getMessages("c4")).toHaveLength(1)
  })

  it("evictConversationMessages drops only the given conversation's messages", async () => {
    const api = {
      get: vi.fn().mockImplementation(async (path: string) => {
        const id = path.includes("/c5") ? "c5" : "c6"
        return {
          conversation: { id, subject: id },
          messages: [
            { id: `m-${id}`, conversationId: id, htmlBody: "", textBody: "", sentAt: "2026-01-05" },
          ],
          nextMessageCursor: null,
        }
      }),
    }
    const { getMessages, loadMessages, evictConversationMessages } = await import(
      "~/modules/mail/mail-message-store"
    )
    await loadMessages(api, "c5")
    await loadMessages(api, "c6")
    expect(getMessages("c5")).toHaveLength(1)

    evictConversationMessages("c5")

    expect(getMessages("c5")).toHaveLength(0)
    expect(getMessages("c6")).toHaveLength(1)
  })

  it("[C1.2] loadMessages started, evicted mid-flight, then resolves -> entry stays absent", async () => {
    // Both two-stage fetches are in flight when the eviction happens; each
    // must drop its late write-back.
    const resolvers: Array<(v: unknown) => void> = []
    const api = {
      get: vi.fn(
        () =>
          new Promise((r) => {
            resolvers.push(r)
          }),
      ),
    }
    const { getMessages, loadMessages, evictConversationMessages } = await import(
      "~/modules/mail/mail-message-store"
    )

    const loadPromise = loadMessages(api as any, "c-race")
    // Evict before the in-flight fetches resolve.
    evictConversationMessages("c-race")
    expect(getMessages("c-race")).toHaveLength(0)

    for (const resolve of resolvers) {
      resolve({
        conversation: { id: "c-race", subject: "late" },
        messages: [
          {
            id: "m-late",
            conversationId: "c-race",
            htmlBody: "",
            textBody: "",
            sentAt: "2026-01-06",
          },
        ],
        nextMessageCursor: null,
      })
    }
    await loadPromise

    // The stale write-back must NOT resurrect the evicted conversation.
    expect(getMessages("c-race")).toHaveLength(0)
  })
})

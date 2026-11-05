// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeEach, describe, expect, it, vi } from "vitest"

describe("ticket-message-store", () => {
  beforeEach(() => {
    if (typeof localStorage !== "undefined") localStorage.clear()
    vi.resetModules()
  })

  it("loadMessages calls tickets:get and stores items oldest-first", async () => {
    // The server returns pages newest-first (`ORDER BY sent_at DESC, id DESC`)
    // — the fixture below mirrors that wire order; the store must reverse it
    // for oldest-first display (m1 sent before m2, so m1 renders first).
    const post = vi.fn().mockResolvedValue({
      ticket: { id: "t1" },
      messages: {
        items: [
          { id: "m2", ticketId: "t1", kind: "outbound", textBody: "hi back" },
          { id: "m1", ticketId: "t1", kind: "inbound", textBody: "hi" },
        ],
        nextCursor: "n1",
      },
    })
    const api = { post } as any
    const { loadMessages, getThread, resetTicketMessageStore } = await import(
      "~/modules/tickets/ticket-message-store"
    )
    resetTicketMessageStore()
    await loadMessages(api, "t1")
    const t = getThread("t1")
    expect(t?.ids).toEqual(["m1", "m2"])
    expect(t?.nextCursor).toBe("n1")
  })

  it("loadMessages fires BOTH bounded stages in parallel: messagesLimit 3 (first paint) and 15", async () => {
    const post = vi
      .fn()
      .mockResolvedValue({ ticket: { id: "t1" }, messages: { items: [], nextCursor: null } })
    const api = { post } as any
    const { loadMessages, resetTicketMessageStore } = await import(
      "~/modules/tickets/ticket-message-store"
    )
    resetTicketMessageStore()
    await loadMessages(api, "t1")
    expect(post).toHaveBeenCalledTimes(2)
    // Each stage carries the load's abort signal, so a resync can restart it (S26).
    const withSignal = { signal: expect.any(AbortSignal) }
    expect(post).toHaveBeenCalledWith(
      "/apps/run-tool",
      {
        toolName: "tickets:get",
        params: { ticketId: "t1", messagesLimit: 3, includeHtml: true, stripQuoted: true },
      },
      withSignal,
    )
    expect(post).toHaveBeenCalledWith(
      "/apps/run-tool",
      {
        toolName: "tickets:get",
        params: { ticketId: "t1", messagesLimit: 15, includeHtml: true, stripQuoted: true },
      },
      withSignal,
    )
  })

  it("two-stage: the 3-message page commits first, the 15-message page merges without dupes and owns the cursor", async () => {
    const msg = (id: string) => ({ id, ticketId: "t1", kind: "inbound", textBody: id })
    // Newest-first wire order: m5 newest ... m1 oldest.
    const smallPage = { items: [msg("m5"), msg("m4"), msg("m3")], nextCursor: "small-cur" }
    const fullPage = {
      items: [msg("m5"), msg("m4"), msg("m3"), msg("m2"), msg("m1")],
      nextCursor: "full-cur",
    }
    let resolveFull!: (v: unknown) => void
    const post = vi.fn((_path: string, body: any) => {
      if (body.params.messagesLimit === 3)
        return Promise.resolve({ ticket: { id: "t1" }, messages: smallPage })
      return new Promise((r) => {
        resolveFull = r
      })
    })
    const api = { post } as any
    const { loadMessages, getThread, resetTicketMessageStore } = await import(
      "~/modules/tickets/ticket-message-store"
    )
    resetTicketMessageStore()
    const done = loadMessages(api, "t1")
    // Let the small page land while the full page is still in flight.
    await new Promise((r) => setTimeout(r, 0))
    expect(getThread("t1")?.ids).toEqual(["m3", "m4", "m5"])
    expect(getThread("t1")?.loaded).toBe(true)
    expect(getThread("t1")?.nextCursor).toBe("small-cur")
    resolveFull({ ticket: { id: "t1" }, messages: fullPage })
    await done
    const t = getThread("t1")
    expect(t?.ids).toEqual(["m1", "m2", "m3", "m4", "m5"])
    expect(t?.nextCursor).toBe("full-cur")
    expect(t?.loading).toBe(false)
    expect(t?.error).toBe(false)
  })

  it("two-stage race: the full page landing FIRST makes the late small page a no-op", async () => {
    const msg = (id: string) => ({ id, ticketId: "t1", kind: "inbound", textBody: id })
    let resolveSmall!: (v: unknown) => void
    const post = vi.fn((_path: string, body: any) => {
      if (body.params.messagesLimit === 3)
        return new Promise((r) => {
          resolveSmall = r
        })
      return Promise.resolve({
        ticket: { id: "t1" },
        messages: { items: [msg("m3"), msg("m2"), msg("m1")], nextCursor: "full-cur" },
      })
    })
    const api = { post } as any
    const { loadMessages, getThread, resetTicketMessageStore } = await import(
      "~/modules/tickets/ticket-message-store"
    )
    resetTicketMessageStore()
    const done = loadMessages(api, "t1")
    await new Promise((r) => setTimeout(r, 0))
    expect(getThread("t1")?.ids).toEqual(["m1", "m2", "m3"])
    // Small page arrives late with a stale 3-row view — it must not shrink
    // the thread or clobber the cursor.
    resolveSmall({
      ticket: { id: "t1" },
      messages: { items: [msg("m3")], nextCursor: "small-cur" },
    })
    await done
    expect(getThread("t1")?.ids).toEqual(["m1", "m2", "m3"])
    expect(getThread("t1")?.nextCursor).toBe("full-cur")
  })

  it("concurrent loadMessages calls for the same ticket dedupe to ONE two-stage load", async () => {
    const post = vi
      .fn()
      .mockResolvedValue({ ticket: { id: "t1" }, messages: { items: [], nextCursor: null } })
    const api = { post } as any
    const { loadMessages, resetTicketMessageStore } = await import(
      "~/modules/tickets/ticket-message-store"
    )
    resetTicketMessageStore()
    // Mirrors the prod shape: TicketDetail's mount kickoff + loadTicket's
    // chained refresh both call loadMessages while the first is in flight.
    await Promise.all([loadMessages(api, "t1"), loadMessages(api, "t1")])
    expect(post).toHaveBeenCalledTimes(2) // one small + one full, not four
  })

  it("a fresh load after a write runs AFTER the in-flight one, which may predate the write", async () => {
    let rows: Array<{ id: string; ticketId: string; kind: string }> = []
    const post = vi.fn(() => {
      // Each request reads the rows as they are when it starts.
      const snapshot = [...rows]
      return Promise.resolve({
        ticket: { id: "t1" },
        messages: { items: snapshot, nextCursor: null },
      })
    })
    const api = { post } as any
    const { loadMessages, getThread, resetTicketMessageStore } = await import(
      "~/modules/tickets/ticket-message-store"
    )
    resetTicketMessageStore()
    const mountLoad = loadMessages(api, "t1") // started before the note exists
    rows = [{ id: "note-1", ticketId: "t1", kind: "note" }] // the note is written
    // Two fresh callers while the mount load is in flight share ONE follow-up.
    await Promise.all([
      mountLoad,
      loadMessages(api, "t1", { fresh: true }),
      loadMessages(api, "t1", { fresh: true }),
    ])
    expect(post).toHaveBeenCalledTimes(4) // the mount's two stages + one follow-up's two
    expect(getThread("t1")?.ids).toEqual(["note-1"])
  })

  it("switching tickets mid-flight: each thread commits only under its own ticketId", async () => {
    const post = vi.fn((_path: string, body: any) =>
      Promise.resolve({
        ticket: { id: body.params.ticketId },
        messages: {
          items: [
            { id: `${body.params.ticketId}-m1`, ticketId: body.params.ticketId, kind: "inbound" },
          ],
          nextCursor: null,
        },
      }),
    )
    const api = { post } as any
    const { loadMessages, getThread, resetTicketMessageStore } = await import(
      "~/modules/tickets/ticket-message-store"
    )
    resetTicketMessageStore()
    await Promise.all([loadMessages(api, "t1"), loadMessages(api, "t2")])
    expect(getThread("t1")?.ids).toEqual(["t1-m1"])
    expect(getThread("t2")?.ids).toEqual(["t2-m1"])
  })

  it("loadMoreMessages passes the cursor with the same bounded params", async () => {
    const post = vi.fn().mockResolvedValue({
      ticket: { id: "t1" },
      messages: {
        items: [{ id: "m9", ticketId: "t1", kind: "inbound", textBody: "x" }],
        nextCursor: "cur-1",
      },
    })
    const api = { post } as any
    const { loadMessages, loadMoreMessages, resetTicketMessageStore } = await import(
      "~/modules/tickets/ticket-message-store"
    )
    resetTicketMessageStore()
    await loadMessages(api, "t1")
    await loadMoreMessages(api, "t1")
    expect(post).toHaveBeenLastCalledWith("/apps/run-tool", {
      toolName: "tickets:get",
      params: {
        ticketId: "t1",
        messagesLimit: 15,
        includeHtml: true,
        stripQuoted: true,
        messagesCursor: "cur-1",
      },
    })
  })

  it("a failed load (BOTH stages) sets error (no silent empty thread); a successful retry clears it", async () => {
    const post = vi
      .fn()
      .mockRejectedValueOnce(new Error("payload too large"))
      .mockRejectedValueOnce(new Error("payload too large"))
    const api = { post } as any
    const { loadMessages, getThread, resetTicketMessageStore } = await import(
      "~/modules/tickets/ticket-message-store"
    )
    resetTicketMessageStore()
    await loadMessages(api, "t1")
    expect(getThread("t1")?.error).toBe(true)
    expect(getThread("t1")?.loading).toBe(false)

    post.mockResolvedValue({
      ticket: { id: "t1" },
      messages: {
        items: [{ id: "m1", ticketId: "t1", kind: "inbound", textBody: "hi" }],
        nextCursor: null,
      },
    })
    await loadMessages(api, "t1")
    expect(getThread("t1")?.error).toBe(false)
    expect(getThread("t1")?.ids).toEqual(["m1"])
  })

  it("no error state when ONE stage fails but the other produced content", async () => {
    const msg = (id: string) => ({ id, ticketId: "t1", kind: "inbound", textBody: id })
    const post = vi.fn((_path: string, body: any) => {
      if (body.params.messagesLimit === 3)
        return Promise.resolve({
          ticket: { id: "t1" },
          messages: { items: [msg("m2"), msg("m1")], nextCursor: null },
        })
      return Promise.reject(new Error("payload too large"))
    })
    const api = { post } as any
    const { loadMessages, getThread, resetTicketMessageStore } = await import(
      "~/modules/tickets/ticket-message-store"
    )
    resetTicketMessageStore()
    await loadMessages(api, "t1")
    expect(getThread("t1")?.error).toBe(false)
    expect(getThread("t1")?.ids).toEqual(["m1", "m2"])
    expect(getThread("t1")?.loading).toBe(false)
  })

  it("fetchFullTicketMessage re-fetches ONE message untrimmed and patches it in place (sanitized)", async () => {
    // Base payload serves BOTH two-stage pages; the once-mock below overrides
    // for the single-message full fetch.
    const post = vi.fn().mockResolvedValue({
      ticket: { id: "t1" },
      messages: {
        items: [
          {
            id: "m1",
            ticketId: "t1",
            kind: "inbound",
            htmlBody:
              '<div>head</div><div data-quote-trimmed="9">[quoted history trimmed: 9 chars]</div>',
          },
        ],
        nextCursor: null,
      },
    })
    const api = { post } as any
    const { loadMessages, fetchFullTicketMessage, getThread, resetTicketMessageStore } =
      await import("~/modules/tickets/ticket-message-store")
    resetTicketMessageStore()
    await loadMessages(api, "t1")

    post.mockResolvedValueOnce({
      ticket: { id: "t1" },
      messages: {
        items: [
          {
            id: "m1",
            ticketId: "t1",
            kind: "inbound",
            htmlBody:
              "<div>head</div><blockquote>full quoted tail</blockquote><script>alert(1)</script>",
          },
        ],
        nextCursor: null,
      },
    })
    await fetchFullTicketMessage(api, "t1", "m1")
    expect(post).toHaveBeenLastCalledWith("/apps/run-tool", {
      toolName: "tickets:get",
      params: { ticketId: "t1", messageId: "m1", includeHtml: true, stripQuoted: false },
    })
    const t = getThread("t1")!
    // Patched in place — same id, same (single) position.
    expect(t.ids).toEqual(["m1"])
    expect(t.byId.m1.htmlBody).toContain("full quoted tail")
    expect(t.byId.m1.htmlBody).not.toContain("quoted history trimmed")
    // Fresh htmlBody goes through the sanitize path like every other ingest.
    expect(t.byId.m1.htmlBody).not.toContain("script")
  })

  it("fetchFullTicketMessage rejects when the message is missing from the response", async () => {
    const post = vi.fn().mockResolvedValue({
      ticket: { id: "t1" },
      messages: { items: [], nextCursor: null },
    })
    const api = { post } as any
    const { fetchFullTicketMessage, resetTicketMessageStore } = await import(
      "~/modules/tickets/ticket-message-store"
    )
    resetTicketMessageStore()
    await expect(fetchFullTicketMessage(api, "t1", "m1")).rejects.toThrow()
  })

  it("insertPlaceholder adds an optimistic message", async () => {
    const post = vi
      .fn()
      .mockResolvedValue({ ticket: { id: "t1" }, messages: { items: [], nextCursor: null } })
    const api = { post } as any
    const { loadMessages, insertPlaceholder, getThread, resetTicketMessageStore } = await import(
      "~/modules/tickets/ticket-message-store"
    )
    resetTicketMessageStore()
    await loadMessages(api, "t1")
    insertPlaceholder("t1", {
      id: "ph",
      ticketId: "t1",
      kind: "outbound-pending",
      fromEmail: null,
      fromName: null,
      toEmails: [],
      ccEmails: [],
      subject: null,
      htmlBody: null,
      textBody: "draft",
      snippet: "draft",
      externalMessageId: null,
      inReplyTo: null,
      headerReferences: null,
      sentAt: new Date().toISOString(),
      createdBy: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    expect(getThread("t1")!.ids).toContain("ph")
  })

  it("handleTicketMessageEvent appends incoming WS messages", async () => {
    const post = vi
      .fn()
      .mockResolvedValue({ ticket: { id: "t1" }, messages: { items: [], nextCursor: null } })
    const api = { post } as any
    const { loadMessages, handleTicketMessageEvent, getThread, resetTicketMessageStore } =
      await import("~/modules/tickets/ticket-message-store")
    resetTicketMessageStore()
    await loadMessages(api, "t1")
    handleTicketMessageEvent("create", { id: "x", ticketId: "t1", kind: "inbound" })
    expect(getThread("t1")!.ids).toContain("x")
  })

  it("handleTicketNoteEvent appends a note announced as tickets/note:create", async () => {
    const post = vi
      .fn()
      .mockResolvedValue({ ticket: { id: "t1" }, messages: { items: [], nextCursor: null } })
    const api = { post } as any
    const { loadMessages, handleTicketNoteEvent, getThread, resetTicketMessageStore } =
      await import("~/modules/tickets/ticket-message-store")
    resetTicketMessageStore()
    await loadMessages(api, "t1")
    handleTicketNoteEvent("create", { id: "n1", ticketId: "t1", kind: "note", textBody: "fyi" })
    expect(getThread("t1")!.ids).toContain("n1")
  })

  it("a sent reply's files show live: kept from the placeholder, then set by the update event", async () => {
    const post = vi
      .fn()
      .mockResolvedValue({ ticket: { id: "t1" }, messages: { items: [], nextCursor: null } })
    const api = { post } as any
    const {
      loadMessages,
      insertPlaceholder,
      handleTicketMessageEvent,
      getThread,
      resetTicketMessageStore,
    } = await import("~/modules/tickets/ticket-message-store")
    resetTicketMessageStore()
    await loadMessages(api, "t1")
    const pdf = { id: "f1", filename: "proforma.pdf", mimeType: "application/pdf", sizeBytes: 10 }
    insertPlaceholder("t1", {
      id: "ph",
      ticketId: "t1",
      kind: "outbound-pending",
      fromEmail: null,
      fromName: null,
      toEmails: [],
      ccEmails: ["boss@cust.test"],
      subject: null,
      htmlBody: "",
      textBody: "",
      snippet: "",
      externalMessageId: null,
      inReplyTo: null,
      headerReferences: null,
      sentAt: new Date().toISOString(),
      createdBy: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      clientPlaceholderId: "ph",
      payloadHash: "fnv1a:dummy",
      attachments: [pdf],
    } as any)
    // The create event carries no attachments (the files land just after).
    handleTicketMessageEvent("create", {
      id: "m1",
      ticketId: "t1",
      kind: "outbound",
      textBody: "",
      htmlBody: "",
      ccEmails: ["boss@cust.test"],
      approvalRequestId: undefined,
    })
    const t = getThread("t1")!
    expect(t.ids).toContain("m1")
    handleTicketMessageEvent("update", {
      id: "m1",
      ticketId: "t1",
      attachments: [{ ...pdf, id: "f1" }],
    })
    // FALSIFIABLE: the update event was ignored unless it carried textBody, so
    // the PDF only appeared after a reload.
    expect(getThread("t1")!.byId.m1!.attachments?.map((a) => a.filename)).toEqual(["proforma.pdf"])
  })

  it("the real message keeps the placeholder's files until the server announces them", async () => {
    const post = vi
      .fn()
      .mockResolvedValue({ ticket: { id: "t1" }, messages: { items: [], nextCursor: null } })
    const api = { post } as any
    const {
      loadMessages,
      insertPlaceholder,
      handleTicketMessageEvent,
      getThread,
      resetTicketMessageStore,
      ticketReplyPayloadHash,
    } = await import("~/modules/tickets/ticket-message-store")
    resetTicketMessageStore()
    await loadMessages(api, "t1")
    const pdf = { id: "f1", filename: "label.pdf", mimeType: "application/pdf", sizeBytes: 10 }
    insertPlaceholder("t1", {
      id: "ph",
      ticketId: "t1",
      kind: "outbound-pending",
      htmlBody: "<p>hi</p>",
      textBody: "hi",
      payloadHash: ticketReplyPayloadHash({
        ticketId: "t1",
        textBody: "hi",
        htmlBody: "<p>hi</p>",
      }),
      attachments: [pdf],
    } as any)
    handleTicketMessageEvent("create", {
      id: "m1",
      ticketId: "t1",
      kind: "outbound",
      textBody: "hi",
      htmlBody: "<p>hi</p>",
    })
    const t = getThread("t1")!
    expect(t.ids).toEqual(["m1"])
    expect(t.byId.m1!.attachments?.map((a) => a.filename)).toEqual(["label.pdf"])
  })

  it("sanitizes htmlBody from incoming WS messages before storing", async () => {
    const post = vi
      .fn()
      .mockResolvedValue({ ticket: { id: "t1" }, messages: { items: [], nextCursor: null } })
    const api = { post } as any
    const { loadMessages, handleTicketMessageEvent, getThread, resetTicketMessageStore } =
      await import("~/modules/tickets/ticket-message-store")
    resetTicketMessageStore()
    await loadMessages(api, "t1")
    handleTicketMessageEvent("create", {
      id: "x",
      ticketId: "t1",
      kind: "inbound",
      htmlBody: '<img src="x" onerror="alert(1)"><script>alert(2)</script><p>safe</p>',
    })
    const html = getThread("t1")!.byId.x.htmlBody ?? ""
    expect(html).toContain("safe")
    expect(html).not.toContain("onerror")
    expect(html).not.toContain("script")
  })

  it("handleTicketMessageEvent replaces matching pending placeholder by payload hash", async () => {
    const post = vi
      .fn()
      .mockResolvedValue({ ticket: { id: "t1" }, messages: { items: [], nextCursor: null } })
    const api = { post } as any
    const {
      loadMessages,
      insertPlaceholder,
      handleTicketMessageEvent,
      getThread,
      resetTicketMessageStore,
      ticketReplyPayloadHash,
    } = await import("~/modules/tickets/ticket-message-store")
    resetTicketMessageStore()
    await loadMessages(api, "t1")
    const payloadHash = ticketReplyPayloadHash({
      ticketId: "t1",
      textBody: "reply",
      htmlBody: "<p>reply</p>",
    })
    insertPlaceholder("t1", {
      id: "ph",
      ticketId: "t1",
      kind: "outbound-pending",
      fromEmail: null,
      fromName: null,
      toEmails: [],
      ccEmails: [],
      subject: null,
      htmlBody: "<p>reply</p>",
      textBody: "reply",
      snippet: "reply",
      externalMessageId: null,
      inReplyTo: null,
      headerReferences: null,
      sentAt: new Date().toISOString(),
      createdBy: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      payloadHash,
    })

    handleTicketMessageEvent("create", {
      id: "real",
      ticketId: "t1",
      kind: "outbound",
      htmlBody: "<p>reply</p>",
      textBody: "reply",
    })

    expect(getThread("t1")!.ids).not.toContain("ph")
    expect(getThread("t1")!.ids).toContain("real")
  })

  it("handleTicketApprovalUpdate removes terminal placeholder without restoring the rejected payload into the composer draft", async () => {
    const {
      insertPlaceholder,
      handleTicketApprovalUpdate,
      getThread,
      resetTicketMessageStore,
      ticketReplyPayloadHash,
    } = await import("~/modules/tickets/ticket-message-store")
    resetTicketMessageStore()
    const payloadHash = ticketReplyPayloadHash({
      ticketId: "t1",
      textBody: "denied",
      htmlBody: "<p>denied</p>",
    })
    insertPlaceholder("t1", {
      id: "ph",
      ticketId: "t1",
      kind: "outbound-pending",
      fromEmail: null,
      fromName: null,
      toEmails: [],
      ccEmails: [],
      subject: null,
      htmlBody: "<p>denied</p>",
      textBody: "denied",
      snippet: "denied",
      externalMessageId: null,
      inReplyTo: null,
      headerReferences: null,
      sentAt: new Date().toISOString(),
      createdBy: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      approvalRequestId: "ar1",
      payloadHash,
    })

    handleTicketApprovalUpdate(
      {
        id: "ar1",
        status: "denied",
        toolName: "tickets:reply",
        currentPayload: { ticketId: "t1", textBody: "denied", htmlBody: "<p>denied</p>" },
      },
      "u1",
    )

    expect(getThread("t1")!.ids).not.toContain("ph")
    // A denied draft is dead; editing happens on the ApprovalCard, never by
    // resurrecting the body in the composer input.
    expect(localStorage.getItem("tickets.draft.u1.t1.reply")).toBeNull()
  })

  it("handleTicketApprovalUpdate removes expired placeholders without a composer-draft restore", async () => {
    const {
      insertPlaceholder,
      handleTicketApprovalUpdate,
      getThread,
      resetTicketMessageStore,
      ticketReplyPayloadHash,
    } = await import("~/modules/tickets/ticket-message-store")
    resetTicketMessageStore()
    const payload = {
      ticketId: "t1",
      textBody: "expired",
      htmlBody: "<p>expired</p>",
      followup: { at: "2026-05-06T10:00", reason: "Check" },
    }
    const payloadHash = ticketReplyPayloadHash(payload)
    insertPlaceholder("t1", {
      id: "ph-expired",
      ticketId: "t1",
      kind: "outbound-pending",
      fromEmail: null,
      fromName: null,
      toEmails: [],
      ccEmails: [],
      subject: null,
      htmlBody: payload.htmlBody,
      textBody: payload.textBody,
      snippet: payload.textBody,
      externalMessageId: null,
      inReplyTo: null,
      headerReferences: null,
      sentAt: new Date().toISOString(),
      createdBy: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      approvalRequestId: "ar-expired",
      payloadHash,
    })

    handleTicketApprovalUpdate(
      { id: "ar-expired", status: "expired", toolName: "tickets:reply", currentPayload: payload },
      "u1",
    )

    expect(getThread("t1")!.ids).not.toContain("ph-expired")
    expect(localStorage.getItem("tickets.draft.u1.t1.reply")).toBeNull()
  })

  it("handleTicketApprovalCreate attaches approvalRequestId by payload hash", async () => {
    const {
      insertPlaceholder,
      handleTicketApprovalCreate,
      getThread,
      resetTicketMessageStore,
      ticketReplyPayloadHash,
    } = await import("~/modules/tickets/ticket-message-store")
    resetTicketMessageStore()
    const payloadHash = ticketReplyPayloadHash({
      ticketId: "t1",
      textBody: "pending",
      htmlBody: "<p>pending</p>",
    })
    insertPlaceholder("t1", {
      id: "ph",
      ticketId: "t1",
      kind: "outbound-pending",
      fromEmail: null,
      fromName: null,
      toEmails: [],
      ccEmails: [],
      subject: null,
      htmlBody: "<p>pending</p>",
      textBody: "pending",
      snippet: "pending",
      externalMessageId: null,
      inReplyTo: null,
      headerReferences: null,
      sentAt: new Date().toISOString(),
      createdBy: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      payloadHash,
    })

    handleTicketApprovalCreate({
      id: "ar1",
      status: "pending",
      toolName: "tickets:reply",
      currentPayload: { ticketId: "t1", textBody: "pending", htmlBody: "<p>pending</p>" },
    })

    expect(getThread("t1")!.byId.ph.approvalRequestId).toBe("ar1")
  })

  it("handleTicketApprovalCreate dispatches tickets:approvals-invalidated for the ticket", async () => {
    const { handleTicketApprovalCreate, resetTicketMessageStore } = await import(
      "~/modules/tickets/ticket-message-store"
    )
    resetTicketMessageStore()
    const listener = vi.fn()
    window.addEventListener("tickets:approvals-invalidated", listener)
    try {
      handleTicketApprovalCreate({
        id: "ar1",
        status: "pending",
        toolName: "tickets:reply",
        currentPayload: { ticketId: "t1", textBody: "pending", htmlBody: "<p>pending</p>" },
      })
      expect(listener).toHaveBeenCalledTimes(1)
      const event = listener.mock.calls[0][0] as CustomEvent<{ ticketId: string }>
      expect(event.detail).toEqual({ ticketId: "t1" })
    } finally {
      window.removeEventListener("tickets:approvals-invalidated", listener)
    }
  })

  it("handleTicketApprovalUpdate dispatches tickets:approvals-invalidated for the ticket", async () => {
    const { handleTicketApprovalUpdate, resetTicketMessageStore } = await import(
      "~/modules/tickets/ticket-message-store"
    )
    resetTicketMessageStore()
    const listener = vi.fn()
    window.addEventListener("tickets:approvals-invalidated", listener)
    try {
      handleTicketApprovalUpdate(
        {
          id: "ar1",
          status: "approved",
          toolName: "tickets:reply",
          currentPayload: { ticketId: "t1", textBody: "pending", htmlBody: "<p>pending</p>" },
        },
        "u1",
      )
      expect(listener).toHaveBeenCalledTimes(1)
      const event = listener.mock.calls[0][0] as CustomEvent<{ ticketId: string }>
      expect(event.detail).toEqual({ ticketId: "t1" })
    } finally {
      window.removeEventListener("tickets:approvals-invalidated", listener)
    }
  })

  it("loadMessages reverses the server's newest-first page to oldest-first display order", async () => {
    // Server returns `ORDER BY sent_at DESC, id DESC` — newest first.
    const post = vi.fn().mockResolvedValue({
      ticket: { id: "t1" },
      messages: {
        items: [
          { id: "m3", ticketId: "t1", kind: "outbound", textBody: "third", sentAt: "2026-01-03" },
          { id: "m2", ticketId: "t1", kind: "inbound", textBody: "second", sentAt: "2026-01-02" },
          { id: "m1", ticketId: "t1", kind: "inbound", textBody: "first", sentAt: "2026-01-01" },
        ],
        nextCursor: null,
      },
    })
    const api = { post } as any
    const { loadMessages, getThread, resetTicketMessageStore } = await import(
      "~/modules/tickets/ticket-message-store"
    )
    resetTicketMessageStore()
    await loadMessages(api, "t1")
    expect(getThread("t1")!.ids).toEqual(["m1", "m2", "m3"])
  })

  it("loadMoreMessages (load-more) inserts the older page at the TOP, oldest-first within the page", async () => {
    const firstPage = vi.fn().mockResolvedValue({
      ticket: { id: "t1" },
      messages: {
        items: [
          { id: "m4", ticketId: "t1", kind: "outbound", textBody: "d", sentAt: "2026-01-04" },
          { id: "m3", ticketId: "t1", kind: "inbound", textBody: "c", sentAt: "2026-01-03" },
        ],
        nextCursor: "cursor-1",
      },
    })
    const api = { post: firstPage } as any
    const { loadMessages, loadMoreMessages, getThread, resetTicketMessageStore } = await import(
      "~/modules/tickets/ticket-message-store"
    )
    resetTicketMessageStore()
    await loadMessages(api, "t1")
    expect(getThread("t1")!.ids).toEqual(["m3", "m4"])

    firstPage.mockResolvedValue({
      ticket: { id: "t1" },
      messages: {
        items: [
          { id: "m2", ticketId: "t1", kind: "inbound", textBody: "b", sentAt: "2026-01-02" },
          { id: "m1", ticketId: "t1", kind: "inbound", textBody: "a", sentAt: "2026-01-01" },
        ],
        nextCursor: null,
      },
    })
    await loadMoreMessages(api, "t1")
    expect(getThread("t1")!.ids).toEqual(["m1", "m2", "m3", "m4"])
    expect(getThread("t1")!.nextCursor).toBeNull()
  })

  it("insertPlaceholder appends the optimistic reply at the END (newest, bottom of the thread)", async () => {
    const post = vi.fn().mockResolvedValue({
      ticket: { id: "t1" },
      messages: {
        items: [
          { id: "m1", ticketId: "t1", kind: "inbound", textBody: "hi", sentAt: "2026-01-01" },
        ],
        nextCursor: null,
      },
    })
    const api = { post } as any
    const { loadMessages, insertPlaceholder, getThread, resetTicketMessageStore } = await import(
      "~/modules/tickets/ticket-message-store"
    )
    resetTicketMessageStore()
    await loadMessages(api, "t1")
    insertPlaceholder("t1", {
      id: "ph",
      ticketId: "t1",
      kind: "outbound-pending",
      fromEmail: null,
      fromName: null,
      toEmails: [],
      ccEmails: [],
      subject: null,
      htmlBody: null,
      textBody: "draft",
      snippet: "draft",
      externalMessageId: null,
      inReplyTo: null,
      headerReferences: null,
      sentAt: new Date().toISOString(),
      createdBy: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    expect(getThread("t1")!.ids).toEqual(["m1", "ph"])
  })

  it("handleTicketMessageEvent reconciles the placeholder IN PLACE (no reorder/jump)", async () => {
    const post = vi.fn().mockResolvedValue({
      ticket: { id: "t1" },
      messages: {
        items: [
          { id: "m1", ticketId: "t1", kind: "inbound", textBody: "hi", sentAt: "2026-01-01" },
        ],
        nextCursor: null,
      },
    })
    const api = { post } as any
    const {
      loadMessages,
      insertPlaceholder,
      handleTicketMessageEvent,
      getThread,
      resetTicketMessageStore,
      ticketReplyPayloadHash,
    } = await import("~/modules/tickets/ticket-message-store")
    resetTicketMessageStore()
    await loadMessages(api, "t1")
    const payloadHash = ticketReplyPayloadHash({
      ticketId: "t1",
      textBody: "reply",
      htmlBody: "<p>reply</p>",
    })
    insertPlaceholder("t1", {
      id: "ph",
      ticketId: "t1",
      kind: "outbound-pending",
      fromEmail: null,
      fromName: null,
      toEmails: [],
      ccEmails: [],
      subject: null,
      htmlBody: "<p>reply</p>",
      textBody: "reply",
      snippet: "reply",
      externalMessageId: null,
      inReplyTo: null,
      headerReferences: null,
      sentAt: new Date().toISOString(),
      createdBy: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      payloadHash,
    })
    expect(getThread("t1")!.ids).toEqual(["m1", "ph"])

    handleTicketMessageEvent("create", {
      id: "real",
      ticketId: "t1",
      kind: "outbound",
      htmlBody: "<p>reply</p>",
      textBody: "reply",
    })

    // Same position the placeholder held — still at the end, still after m1.
    expect(getThread("t1")!.ids).toEqual(["m1", "real"])
  })

  it("handleTicketMessageEvent appends a message with no matching placeholder at the END", async () => {
    const post = vi.fn().mockResolvedValue({
      ticket: { id: "t1" },
      messages: {
        items: [
          { id: "m1", ticketId: "t1", kind: "inbound", textBody: "hi", sentAt: "2026-01-01" },
        ],
        nextCursor: null,
      },
    })
    const api = { post } as any
    const { loadMessages, handleTicketMessageEvent, getThread, resetTicketMessageStore } =
      await import("~/modules/tickets/ticket-message-store")
    resetTicketMessageStore()
    await loadMessages(api, "t1")
    // No placeholder — e.g. a message from a different agent or the customer.
    handleTicketMessageEvent("create", {
      id: "m2",
      ticketId: "t1",
      kind: "outbound",
      textBody: "from another agent",
    })
    expect(getThread("t1")!.ids).toEqual(["m1", "m2"])
  })

  it("handleTicketMessageEvent live-patches the ticket list row (preview/unread/position)", async () => {
    const post = vi.fn().mockResolvedValue({
      ticket: { id: "t1" },
      messages: { items: [], nextCursor: null },
    })
    const api = { post } as any
    const { loadMessages, handleTicketMessageEvent, resetTicketMessageStore } = await import(
      "~/modules/tickets/ticket-message-store"
    )
    const { loadTickets, ticketListStore, resetTicketListStore } = await import(
      "~/modules/tickets/ticket-list-store"
    )
    resetTicketMessageStore()
    resetTicketListStore()
    const listPost = vi.fn().mockResolvedValue({
      items: [{ id: "t1", handle: "ticket-1", subject: "A", status: "open", priority: "normal" }],
      nextCursor: null,
    })
    await loadTickets({ post: listPost } as any)
    await loadMessages(api, "t1")

    handleTicketMessageEvent("create", {
      id: "m1",
      ticketId: "t1",
      kind: "inbound",
      textBody: "customer follow-up",
    })
    // The list patch runs via a lazy dynamic import — flush microtasks.
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(ticketListStore.byId.t1.snippet).toBe("customer follow-up")
    expect(ticketListStore.byId.t1.unread).toBe(true)
  })
})

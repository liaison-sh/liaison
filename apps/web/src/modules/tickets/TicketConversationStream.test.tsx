// SPDX-License-Identifier: FSL-1.1-ALv2
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { Suspense } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { beforeEach, describe, expect, it, vi } from "vitest"

// A real Solid store (not a plain object getter) so mutating `threads` inside
// a test is actually reactive — required for the autoscroll tests, which
// assert on effects that re-run when the message list changes after mount.
const [threadsStore, setThreadsStore] = createStore<{ threadsByTicketId: Record<string, any> }>({
  threadsByTicketId: {},
})

const state = vi.hoisted(() => ({
  api: { post: vi.fn(), getEnvelope: vi.fn() } as any,
  loadMoreMessages: vi.fn(),
  loadMessages: vi.fn(),
  fetchFullTicketMessage: vi.fn(),
}))

function setThreads(next: Record<string, any>): void {
  setThreadsStore(
    produce((s) => {
      s.threadsByTicketId = next
    }),
  )
}

vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => state.api,
  useOptionalApi: () => state.api,
}))
vi.mock("~/modules/tickets/ticket-message-store", () => ({
  loadMoreMessages: state.loadMoreMessages,
  loadMessages: state.loadMessages,
  fetchFullTicketMessage: state.fetchFullTicketMessage,
  patchTicketMessageText: vi.fn(),
  removeTicketMessage: vi.fn(),
  get ticketMessageStore() {
    return threadsStore
  },
}))
vi.mock("~/modules/approvals/ApprovalCard", () => ({
  default: (props: { requestId: string }) => (
    <div data-testid={`approval-card-mock-${props.requestId}`}>{props.requestId}</div>
  ),
}))

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { splitQuotedHistory, splitQuotedHtml } from "~/lib/email-quote"
import { setMarkdown } from "~/modules/editor/test-helpers"
import { TicketConversationStream } from "./TicketConversationStream"

/**
 * jsdom leaves scrollTop/scrollHeight/clientHeight at 0 by default — stub them
 * as a mutable "fake layout" so the autoscroll effects (which write
 * `containerRef.scrollTop = containerRef.scrollHeight`) are observable.
 */
function stubScrollMetrics(
  el: HTMLElement,
  initial: { scrollHeight: number },
): {
  setScrollHeight: (v: number) => void
} {
  let scrollHeight = initial.scrollHeight
  let scrollTop = 0
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    get: () => scrollHeight,
  })
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 200 })
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (v: number) => {
      scrollTop = v
    },
  })
  return {
    setScrollHeight: (v: number) => {
      scrollHeight = v
    },
  }
}

async function flushRaf(): Promise<void> {
  // The component schedules autoscroll via requestAnimationFrame.
  await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe("TicketConversationStream", () => {
  beforeEach(() => {
    state.loadMoreMessages.mockReset()
    state.loadMessages.mockReset()
    state.fetchFullTicketMessage.mockReset()
    state.api.getEnvelope = vi.fn().mockResolvedValue({ data: [] })
    setThreads({})
  })

  // A live ticket opening before its id is known asked `?ticketId=undefined` (400).
  it("asks for the ticket's approvals only once it has an id", async () => {
    render(() => <TicketConversationStream ticketId={undefined as unknown as string} />)
    await new Promise((r) => setTimeout(r, 20))
    expect(state.api.getEnvelope).not.toHaveBeenCalled()
    cleanup()
    render(() => <TicketConversationStream ticketId="t1" />)
    await waitFor(() =>
      expect(state.api.getEnvelope).toHaveBeenCalledWith("/approvals?ticketId=t1"),
    )
  })

  it("marks an inbound message whose sender the provider did not authenticate", () => {
    const msg = (id: string, senderAuth: string | null) => ({
      id,
      ticketId: "t1",
      kind: "inbound",
      textBody: "Hi",
      htmlBody: null,
      sentAt: "2026-01-01T00:00:00Z",
      senderAuth,
    })
    setThreads({
      t1: {
        ids: ["ok", "none", "fail", "old"],
        byId: {
          ok: msg("ok", "pass"),
          none: msg("none", "none"),
          fail: msg("fail", "fail"),
          old: msg("old", null),
        },
        nextCursor: null,
      },
    })
    render(() => <TicketConversationStream ticketId="t1" />)
    expect(screen.queryByTestId("tickets-message-sender-auth-ok")).toBeNull()
    expect(screen.queryByTestId("tickets-message-sender-auth-old")).toBeNull()
    expect(screen.getByTestId("tickets-message-sender-auth-none")).toBeTruthy()
    expect(screen.getByTestId("tickets-message-sender-auth-fail").textContent).toMatch(/forged/i)
  })

  it("renders one article per message with kind data attribute", () => {
    setThreads({
      t1: {
        ids: ["m1", "m2"],
        byId: {
          m1: {
            id: "m1",
            ticketId: "t1",
            kind: "inbound",
            textBody: "Hi",
            htmlBody: null,
            sentAt: "2026-01-01T00:00:00Z",
          },
          m2: {
            id: "m2",
            ticketId: "t1",
            kind: "outbound",
            textBody: "Hi back",
            htmlBody: null,
            sentAt: "2026-01-01T00:01:00Z",
          },
        },
        nextCursor: null,
      },
    })
    render(() => <TicketConversationStream ticketId="t1" />)
    const m1 = screen.getByTestId("tickets-message-m1")
    const m2 = screen.getByTestId("tickets-message-m2")
    expect(m1.getAttribute("data-kind")).toBe("inbound")
    expect(m2.getAttribute("data-kind")).toBe("outbound")
  })

  it("names To and Cc on an outbound card, and the copied people on an inbound one", () => {
    setThreads({
      t1: {
        ids: ["m1", "m2", "m3"],
        byId: {
          m1: {
            id: "m1",
            ticketId: "t1",
            kind: "inbound",
            textBody: "Hi",
            fromEmail: "cust@x.test",
            toEmails: ["support@us.test"],
            ccEmails: ["boss@x.test"],
          },
          m2: {
            id: "m2",
            ticketId: "t1",
            kind: "outbound",
            textBody: "Hi back",
            toEmails: ["cust@x.test"],
            ccEmails: ["boss@x.test", "jordan@us.test"],
          },
          m3: {
            id: "m3",
            ticketId: "t1",
            kind: "outbound",
            textBody: "Older reply, no recipients recorded",
            toEmails: [],
            ccEmails: [],
          },
        },
        nextCursor: null,
      },
    })
    render(() => <TicketConversationStream ticketId="t1" />)
    // FALSIFIABLE: the Cc was stored on the row but no card ever showed it.
    const out = screen.getByTestId("tickets-message-recipients-m2").textContent ?? ""
    expect(out).toContain("cust@x.test")
    expect(screen.getByTestId("tickets-message-cc-m2").textContent).toContain(
      "boss@x.test, jordan@us.test",
    )
    expect(screen.getByTestId("tickets-message-cc-m1").textContent).toContain("boss@x.test")
    // An inbound card does not repeat our own address as its To.
    expect(screen.getByTestId("tickets-message-recipients-m1").textContent).not.toContain(
      "support@us.test",
    )
    expect(screen.queryByTestId("tickets-message-recipients-m3")).toBeNull()
  })

  it("renders messages oldest-first (first in DOM = oldest, matching store `ids` order)", () => {
    setThreads({
      t1: {
        ids: ["oldest", "newest"],
        byId: {
          oldest: { id: "oldest", ticketId: "t1", kind: "inbound", textBody: "first" },
          newest: { id: "newest", ticketId: "t1", kind: "outbound", textBody: "last" },
        },
        nextCursor: null,
      },
    })
    render(() => <TicketConversationStream ticketId="t1" />)
    const articles = Array.from(document.querySelectorAll("article"))
    expect(articles[0]?.getAttribute("data-testid")).toBe("tickets-message-oldest")
    expect(articles[1]?.getAttribute("data-testid")).toBe("tickets-message-newest")
  })

  it("autoscrolls to the bottom on initial load", async () => {
    setThreads({
      t1: {
        ids: ["m1"],
        byId: { m1: { id: "m1", ticketId: "t1", kind: "inbound", textBody: "hi" } },
        nextCursor: null,
      },
    })
    render(() => <TicketConversationStream ticketId="t1" />)
    const container = screen.getByTestId("tickets-conversation")
    stubScrollMetrics(container, { scrollHeight: 500 })
    // createEffect(on(() => items().length, ...)) fires once at mount with
    // prevLen undefined, which always autoscrolls (initial-load case).
    await flushRaf()
    expect(container.scrollTop).toBe(500)
  })

  it("autoscrolls when a new trailing message arrives while following the bottom", async () => {
    setThreads({
      t1: {
        ids: ["m1"],
        byId: { m1: { id: "m1", ticketId: "t1", kind: "inbound", textBody: "hi" } },
        nextCursor: null,
      },
    })
    render(() => <TicketConversationStream ticketId="t1" />)
    const container = screen.getByTestId("tickets-conversation")
    const layout = stubScrollMetrics(container, { scrollHeight: 300 })
    await flushRaf()
    expect(container.scrollTop).toBe(300)

    // A new trailing message grows the thread — simulate content growth then append.
    layout.setScrollHeight(450)
    setThreads({
      t1: {
        ...threadsStore.threadsByTicketId.t1,
        ids: ["m1", "m2"],
        byId: {
          ...threadsStore.threadsByTicketId.t1.byId,
          m2: { id: "m2", ticketId: "t1", kind: "outbound", textBody: "reply" },
        },
      },
    })
    await flushRaf()
    expect(container.scrollTop).toBe(450)
  })

  it("does not autoscroll for a new message once the user has scrolled up", async () => {
    setThreads({
      t1: {
        ids: ["m1"],
        byId: { m1: { id: "m1", ticketId: "t1", kind: "inbound", textBody: "hi" } },
        nextCursor: null,
      },
    })
    render(() => <TicketConversationStream ticketId="t1" />)
    const container = screen.getByTestId("tickets-conversation")
    const layout = stubScrollMetrics(container, { scrollHeight: 300 })
    await flushRaf()
    expect(container.scrollTop).toBe(300)
    // A real browser fires a native `scroll` event after a programmatic
    // scrollTop write (async "scroll steps"); the jsdom stub doesn't, so fire
    // it explicitly to let the component observe its own autoscroll and
    // update `lastScrollTop` — otherwise the next assertion's "scrolled up"
    // detection has no baseline to compare against.
    fireEvent.scroll(container)

    // User scrolls up, away from the bottom — this must clear "following".
    container.scrollTop = 0
    fireEvent.scroll(container)

    layout.setScrollHeight(450)
    setThreads({
      t1: {
        ...threadsStore.threadsByTicketId.t1,
        ids: ["m1", "m2"],
        byId: {
          ...threadsStore.threadsByTicketId.t1.byId,
          m2: { id: "m2", ticketId: "t1", kind: "outbound", textBody: "reply" },
        },
      },
    })
    await flushRaf()
    // Reading position preserved — did NOT snap back to the bottom.
    expect(container.scrollTop).toBe(0)
  })

  it("[SC7] renders sanitized HTML when present (text content only via testid)", () => {
    setThreads({
      t1: {
        ids: ["m1"],
        byId: {
          m1: {
            id: "m1",
            ticketId: "t1",
            kind: "inbound",
            htmlBody: "<p>Hello there</p>",
            textBody: null,
            sentAt: "2026-01-01T00:00:00Z",
          },
        },
        nextCursor: null,
      },
    })
    render(() => <TicketConversationStream ticketId="t1" />)
    const html = screen.getByTestId("tickets-message-html-m1")
    expect(html.innerHTML).toContain("Hello there")
  })

  it("renders body-referenced images inline and lists only true attachments in the strip", async () => {
    state.api.rawGet = vi.fn(async () => new Response(new Blob(["x"])))
    setThreads({
      t1: {
        ids: ["m1"],
        byId: {
          m1: {
            id: "m1",
            ticketId: "t1",
            kind: "inbound",
            htmlBody: `<p>Photos below:</p><img src="/api/files/inline-1/inline" alt="pic.jpg" />`,
            textBody: null,
            sentAt: "2026-01-01T00:00:00Z",
            attachments: [
              // Referenced inline in the body -> must render inline, NOT in the strip.
              {
                id: "inline-1",
                filename: "pic.jpg",
                mimeType: "image/jpeg",
                sizeBytes: 4096,
                disposition: "inline",
                contentId: "pic@cid",
              },
              // A genuine attachment the body never references -> stays in the strip.
              {
                id: "attached-2",
                filename: "invoice.pdf",
                mimeType: "application/pdf",
                sizeBytes: 2048,
                disposition: "attachment",
              },
            ],
          },
        },
        nextCursor: null,
      },
    })
    render(() => <TicketConversationStream ticketId="t1" />)

    // The inline image is rendered in the body (tagged for the authed fetch).
    const body = screen.getByTestId("tickets-message-html-m1")
    expect(body.querySelector('img[data-file-id="inline-1"]')).not.toBeNull()

    // ...and is NOT duplicated in the attachment strip (neither preview nor card).
    expect(screen.queryByTestId("attachment-image-inline-1")).toBeNull()
    expect(screen.queryByTestId("attachment-card-inline-1")).toBeNull()

    // The true attachment still shows at the bottom.
    expect(screen.getByTestId("attachment-strip")).toBeVisible()
    await waitFor(() => expect(screen.getByTestId("attachment-card-attached-2")).toBeVisible())
  })

  // Under the desktop shell the page origin is a server address, and the
  // ticket body still carries the server's bare path: the strip must not list
  // the inline image a second time there.
  it("keeps a body-referenced image out of the strip under a shell server address", async () => {
    state.api.rawGet = vi.fn(async () => new Response(new Blob(["x"])))
    ;(globalThis as Record<string, unknown>).__LIAISON_SERVER_ADDRESS__ = "https://box.example.com"
    try {
      setThreads({
        t1: {
          ids: ["m1"],
          byId: {
            m1: {
              id: "m1",
              ticketId: "t1",
              kind: "inbound",
              htmlBody: `<p>Photo:</p><img src="/api/files/inline-1/inline" alt="pic.jpg" />`,
              textBody: null,
              createdAt: "2026-01-01T00:00:00Z",
              attachments: [
                {
                  id: "inline-1",
                  filename: "pic.jpg",
                  mimeType: "image/jpeg",
                  sizeBytes: 10,
                  disposition: "inline",
                },
              ],
            },
          },
          nextCursor: null,
        },
      })
      render(() => <TicketConversationStream ticketId="t1" />)
      expect(
        screen.getByTestId("tickets-message-html-m1").querySelector('img[data-file-id="inline-1"]'),
      ).not.toBeNull()
      expect(screen.queryByTestId("attachment-image-inline-1")).toBeNull()
      expect(screen.queryByTestId("attachment-card-inline-1")).toBeNull()
    } finally {
      delete (globalThis as Record<string, unknown>).__LIAISON_SERVER_ADDRESS__
    }
  })

  it("load-more button calls loadMoreMessages when nextCursor is set", () => {
    setThreads({
      t1: {
        ids: ["m1"],
        byId: { m1: { id: "m1", ticketId: "t1", kind: "inbound" } },
        nextCursor: "abc",
      },
    })
    render(() => <TicketConversationStream ticketId="t1" />)
    fireEvent.click(screen.getByTestId("tickets-load-more-messages"))
    expect(state.loadMoreMessages).toHaveBeenCalledWith(state.api, "t1")
  })

  describe("load-error state", () => {
    it("renders an error state with a Retry button when the thread failed with no messages", () => {
      setThreads({
        t1: { ids: [], byId: {}, nextCursor: null, loading: false, loaded: false, error: true },
      })
      render(() => <TicketConversationStream ticketId="t1" />)
      expect(screen.getByTestId("tickets-messages-error")).toBeTruthy()
      fireEvent.click(screen.getByTestId("tickets-messages-retry"))
      expect(state.loadMessages).toHaveBeenCalledWith(state.api, "t1")
    })

    it("does not render the error state when messages are present despite a failed refresh", () => {
      setThreads({
        t1: {
          ids: ["m1"],
          byId: { m1: { id: "m1", ticketId: "t1", kind: "inbound", textBody: "hi" } },
          nextCursor: null,
          error: true,
        },
      })
      render(() => <TicketConversationStream ticketId="t1" />)
      expect(screen.queryByTestId("tickets-messages-error")).toBeNull()
      expect(screen.getByTestId("tickets-message-m1")).toBeTruthy()
    })

    it("does not render the error state on a healthy thread", () => {
      setThreads({
        t1: { ids: [], byId: {}, nextCursor: null, loading: true, loaded: false, error: false },
      })
      render(() => <TicketConversationStream ticketId="t1" />)
      expect(screen.queryByTestId("tickets-messages-error")).toBeNull()
    })
  })

  describe("near-top auto load-more", () => {
    it("auto-loads the older page when scrolled near the top with a cursor", () => {
      state.loadMoreMessages.mockResolvedValue(undefined)
      setThreads({
        t1: {
          ids: ["m1"],
          byId: { m1: { id: "m1", ticketId: "t1", kind: "inbound", textBody: "hi" } },
          nextCursor: "older",
          loading: false,
        },
      })
      render(() => <TicketConversationStream ticketId="t1" />)
      const container = screen.getByTestId("tickets-conversation")
      stubScrollMetrics(container, { scrollHeight: 2000 })
      container.scrollTop = 100 // near the top, below the 200px threshold
      fireEvent.scroll(container)
      expect(state.loadMoreMessages).toHaveBeenCalledWith(state.api, "t1")
    })

    it("does not auto-load when there is no older cursor", () => {
      setThreads({
        t1: {
          ids: ["m1"],
          byId: { m1: { id: "m1", ticketId: "t1", kind: "inbound", textBody: "hi" } },
          nextCursor: null,
          loading: false,
        },
      })
      render(() => <TicketConversationStream ticketId="t1" />)
      const container = screen.getByTestId("tickets-conversation")
      stubScrollMetrics(container, { scrollHeight: 2000 })
      container.scrollTop = 50
      fireEvent.scroll(container)
      expect(state.loadMoreMessages).not.toHaveBeenCalled()
    })

    it("does not auto-load while a load is already in flight", () => {
      setThreads({
        t1: {
          ids: ["m1"],
          byId: { m1: { id: "m1", ticketId: "t1", kind: "inbound", textBody: "hi" } },
          nextCursor: "older",
          loading: true,
        },
      })
      render(() => <TicketConversationStream ticketId="t1" />)
      const container = screen.getByTestId("tickets-conversation")
      stubScrollMetrics(container, { scrollHeight: 2000 })
      container.scrollTop = 50
      fireEvent.scroll(container)
      expect(state.loadMoreMessages).not.toHaveBeenCalled()
    })

    it("does not auto-load when scrolled far from the top", () => {
      setThreads({
        t1: {
          ids: ["m1"],
          byId: { m1: { id: "m1", ticketId: "t1", kind: "inbound", textBody: "hi" } },
          nextCursor: "older",
          loading: false,
        },
      })
      render(() => <TicketConversationStream ticketId="t1" />)
      const container = screen.getByTestId("tickets-conversation")
      stubScrollMetrics(container, { scrollHeight: 2000 })
      container.scrollTop = 900
      fireEvent.scroll(container)
      expect(state.loadMoreMessages).not.toHaveBeenCalled()
    })
  })

  describe("server-trimmed quoted history (lazy full-message fetch)", () => {
    const trimmedHtml = `<div>Latest reply body here.</div><div data-quote-trimmed="1234">[quoted history trimmed: 1234 chars]</div>`
    const fullHtml = `<div>Latest reply body here.</div><blockquote><div>The original question, now loaded in full from the server side.</div></blockquote>`

    it("shows the quote toggle for a trimmed message and hides the marker note", () => {
      setThreads({
        t1: {
          ids: ["m1"],
          byId: { m1: { id: "m1", ticketId: "t1", kind: "inbound", htmlBody: trimmedHtml } },
          nextCursor: null,
        },
      })
      render(() => <TicketConversationStream ticketId="t1" />)
      const body = screen.getByTestId("tickets-message-html-m1")
      expect(body.textContent).toContain("Latest reply body here.")
      expect(body.textContent).not.toContain("quoted history trimmed")
      expect(screen.getByTestId("tickets-message-quote-toggle-m1")).toBeTruthy()
    })

    it("expanding a trimmed message fetches the full message then shows the quoted tail", async () => {
      setThreads({
        t1: {
          ids: ["m1"],
          byId: { m1: { id: "m1", ticketId: "t1", kind: "inbound", htmlBody: trimmedHtml } },
          nextCursor: null,
        },
      })
      state.fetchFullTicketMessage.mockImplementation(async () => {
        // Simulate the store patching the message in place with the full body.
        setThreadsStore(
          produce((s) => {
            s.threadsByTicketId.t1.byId.m1.htmlBody = fullHtml
          }),
        )
      })
      render(() => <TicketConversationStream ticketId="t1" />)
      fireEvent.click(screen.getByTestId("tickets-message-quote-toggle-m1"))
      expect(state.fetchFullTicketMessage).toHaveBeenCalledWith(state.api, "t1", "m1")
      await waitFor(() => {
        expect(screen.getByTestId("tickets-message-quote-body-m1").textContent).toContain(
          "The original question",
        )
      })
    })

    it("shows a loading state on the toggle while the full message is fetching", async () => {
      setThreads({
        t1: {
          ids: ["m1"],
          byId: { m1: { id: "m1", ticketId: "t1", kind: "inbound", htmlBody: trimmedHtml } },
          nextCursor: null,
        },
      })
      let resolveFetch: () => void = () => {}
      state.fetchFullTicketMessage.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolveFetch = resolve
          }),
      )
      render(() => <TicketConversationStream ticketId="t1" />)
      const toggle = screen.getByTestId("tickets-message-quote-toggle-m1")
      fireEvent.click(toggle)
      await waitFor(() => expect(toggle.textContent).toContain("Loading"))
      expect((toggle as HTMLButtonElement).disabled).toBe(true)
      resolveFetch()
      // Fetch settled -> the quote expands (collapse affordance replaces the toggle).
      await waitFor(() =>
        expect(screen.getByTestId("tickets-message-quote-collapse-m1")).toBeTruthy(),
      )
    })

    it("does not fetch when expanding an untrimmed message (pure client split)", () => {
      const html = `<div>Reply text goes here for the visible part.</div><blockquote><div>Quoted original message, long enough to collapse behind the toggle.</div></blockquote>`
      setThreads({
        t1: {
          ids: ["m1"],
          byId: { m1: { id: "m1", ticketId: "t1", kind: "inbound", htmlBody: html } },
          nextCursor: null,
        },
      })
      render(() => <TicketConversationStream ticketId="t1" />)
      fireEvent.click(screen.getByTestId("tickets-message-quote-toggle-m1"))
      expect(state.fetchFullTicketMessage).not.toHaveBeenCalled()
      expect(screen.getByTestId("tickets-message-quote-body-m1")).toBeTruthy()
    })
  })

  describe("inline pending approvals", () => {
    const seedThread = (extra: Record<string, any> = {}): void => {
      setThreads({
        t1: {
          ids: ["m1", ...Object.keys(extra)],
          byId: {
            m1: { id: "m1", ticketId: "t1", kind: "inbound", textBody: "Hi" },
            ...extra,
          },
          nextCursor: null,
        },
      })
    }
    const approvalFetchCount = (): number =>
      (state.api.getEnvelope as ReturnType<typeof vi.fn>).mock.calls.filter((call) =>
        String(call[0]).startsWith("/approvals"),
      ).length

    it("renders an approval card inline for each pending approval, after the messages", async () => {
      seedThread()
      state.api.getEnvelope = vi.fn().mockResolvedValue({
        data: [
          { id: "ar-1", status: "pending" },
          { id: "ar-2", status: "approved" },
        ],
      })
      render(() => <TicketConversationStream ticketId="t1" approvalThreadId="thread-1" />)
      await waitFor(() =>
        expect(state.api.getEnvelope).toHaveBeenCalledWith("/approvals?ticketId=t1"),
      )
      await waitFor(() =>
        expect(state.api.getEnvelope).toHaveBeenCalledWith("/approvals?threadId=thread-1"),
      )
      await waitFor(() => expect(screen.getByTestId("approval-card-mock-ar-1")).toBeTruthy())
      expect(screen.queryByTestId("approval-card-mock-ar-2")).toBeNull()
      // Inline: the card lives INSIDE the conversation scroll container, after
      // the message articles.
      const container = screen.getByTestId("tickets-conversation")
      const card = screen.getByTestId("tickets-detail-approval-card")
      expect(container.contains(card)).toBe(true)
      const message = screen.getByTestId("tickets-message-m1")
      expect(message.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })

    it("opening a ticket with a pending agent draft scrolls to that draft's card", async () => {
      seedThread()
      const scrolled: Element[] = []
      const real = HTMLElement.prototype.scrollIntoView
      HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
        scrolled.push(this)
      }
      try {
        state.api.getEnvelope = vi.fn().mockResolvedValue({
          data: [{ id: "ar-draft", status: "pending", toolName: "tickets:reply" }],
        })
        render(() => <TicketConversationStream ticketId="t1" />)
        await waitFor(() => expect(screen.getByTestId("approval-card-mock-ar-draft")).toBeTruthy())
        await flushRaf()
        await waitFor(() =>
          expect(scrolled.some((el) => el.getAttribute("data-approval-id") === "ar-draft")).toBe(
            true,
          ),
        )
      } finally {
        HTMLElement.prototype.scrollIntoView = real
      }
    })

    it("approval-invalidation refetch does not re-suspend the tab; the decision patches in place", async () => {
      seedThread()
      let call = 0
      let resolveRefetch: ((v: any) => void) | undefined
      state.api.getEnvelope = vi.fn().mockImplementation(() => {
        call += 1
        if (call === 1) return Promise.resolve({ data: [{ id: "ar-1", status: "pending" }] })
        return new Promise((r) => {
          resolveRefetch = r
        })
      })
      render(() => (
        <Suspense fallback={<div data-testid="tab-suspense-fallback" />}>
          <TicketConversationStream ticketId="t1" />
        </Suspense>
      ))
      await waitFor(() => expect(screen.getByTestId("approval-card-mock-ar-1")).toBeTruthy())
      window.dispatchEvent(
        new CustomEvent("tickets:approvals-invalidated", { detail: { ticketId: "t1" } }),
      )
      await waitFor(() => expect(call).toBe(2))
      // While the refetch is in flight the previous UI must stay mounted:
      // no Suspense fallback (pre-fix, reading `approvals()` re-suspended the
      // whole tab tree under MainPanel's shared <Suspense>, blanking the
      // ticket on every approve/deny) and the stale card still visible.
      expect(screen.queryByTestId("tab-suspense-fallback")).toBeNull()
      expect(screen.getByTestId("approval-card-mock-ar-1")).toBeTruthy()
      // When the refetch lands with the approval decided, the card disappears
      // in place — still no fallback.
      resolveRefetch?.({ data: [{ id: "ar-1", status: "approved" }] })
      await waitFor(() => expect(screen.queryByTestId("approval-card-mock-ar-1")).toBeNull())
      expect(screen.queryByTestId("tab-suspense-fallback")).toBeNull()
      expect(screen.getByTestId("tickets-conversation")).toBeTruthy()
    })

    it("renders no card when the ticket has no pending approvals", async () => {
      seedThread()
      state.api.getEnvelope = vi.fn().mockResolvedValue({
        data: [{ id: "ar-2", status: "approved" }],
      })
      render(() => <TicketConversationStream ticketId="t1" approvalThreadId="thread-1" />)
      await waitFor(() =>
        expect(state.api.getEnvelope).toHaveBeenCalledWith("/approvals?threadId=thread-1"),
      )
      expect(screen.queryByTestId("tickets-detail-approval-card")).toBeNull()
    })

    it("fetches approvals by ticketId only when there is no internal thread", async () => {
      seedThread()
      render(() => <TicketConversationStream ticketId="t1" />)
      await waitFor(() =>
        expect(state.api.getEnvelope).toHaveBeenCalledWith("/approvals?ticketId=t1"),
      )
      expect(
        (state.api.getEnvelope as ReturnType<typeof vi.fn>).mock.calls.some((call) =>
          String(call[0]).startsWith("/approvals?threadId="),
        ),
      ).toBe(false)
    })

    it("renders a pending approval raised by a routine (tool_params.ticketId, no internal thread)", async () => {
      seedThread()
      state.api.getEnvelope = vi.fn().mockResolvedValue({
        data: [{ id: "ar-routine-1", status: "pending" }],
      })
      render(() => <TicketConversationStream ticketId="t1" />)
      await waitFor(() =>
        expect(screen.getByTestId("approval-card-mock-ar-routine-1")).toBeTruthy(),
      )
    })

    it("hides an outbound-pending placeholder whose approval renders as an inline card", async () => {
      seedThread({
        ph: {
          id: "ph",
          ticketId: "t1",
          kind: "outbound-pending",
          textBody: "draft body",
          approvalRequestId: "ar-1",
        },
      })
      state.api.getEnvelope = vi.fn().mockResolvedValue({
        data: [{ id: "ar-1", status: "pending" }],
      })
      render(() => <TicketConversationStream ticketId="t1" />)
      await waitFor(() => expect(screen.getByTestId("approval-card-mock-ar-1")).toBeTruthy())
      // The card supersedes the placeholder article (same draft, plus the
      // actual approve/deny/edit controls) — rendering both duplicates it.
      expect(screen.queryByTestId("tickets-message-ph")).toBeNull()
    })

    it("keeps an outbound-pending placeholder whose approval is not (yet) in the pending list", async () => {
      seedThread({
        ph: {
          id: "ph",
          ticketId: "t1",
          kind: "outbound-pending",
          textBody: "draft body",
        },
      })
      render(() => <TicketConversationStream ticketId="t1" />)
      await waitFor(() => expect(approvalFetchCount()).toBeGreaterThan(0))
      expect(screen.getByTestId("tickets-message-ph")).toBeTruthy()
    })

    it("re-fetches approvals when a tickets:approvals-invalidated event fires for this ticket", async () => {
      seedThread()
      state.api.getEnvelope = vi
        .fn()
        .mockResolvedValue({ data: [{ id: "ar-1", status: "pending" }] })
      render(() => <TicketConversationStream ticketId="t1" approvalThreadId="thread-1" />)
      await waitFor(() => expect(approvalFetchCount()).toBe(2))
      window.dispatchEvent(
        new CustomEvent("tickets:approvals-invalidated", { detail: { ticketId: "t1" } }),
      )
      await waitFor(() => expect(approvalFetchCount()).toBe(4))
    })

    it("ignores a tickets:approvals-invalidated event for a different ticket", async () => {
      seedThread()
      state.api.getEnvelope = vi
        .fn()
        .mockResolvedValue({ data: [{ id: "ar-1", status: "pending" }] })
      render(() => <TicketConversationStream ticketId="t1" approvalThreadId="thread-1" />)
      await waitFor(() => expect(approvalFetchCount()).toBe(2))
      window.dispatchEvent(
        new CustomEvent("tickets:approvals-invalidated", { detail: { ticketId: "other-ticket" } }),
      )
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(approvalFetchCount()).toBe(2)
    })
  })

  describe("acknowledgement email filtering", () => {
    it("hides messages with isAcknowledgement=true from the rendered thread", () => {
      setThreads({
        t1: {
          ids: ["m1", "ack1", "m2"],
          byId: {
            m1: { id: "m1", ticketId: "t1", kind: "inbound", textBody: "Hi" },
            ack1: {
              id: "ack1",
              ticketId: "t1",
              kind: "outbound",
              textBody: "We have received your request",
              isAcknowledgement: true,
            },
            m2: { id: "m2", ticketId: "t1", kind: "outbound", textBody: "Real reply" },
          },
          nextCursor: null,
        },
      })
      render(() => <TicketConversationStream ticketId="t1" />)
      expect(screen.queryByTestId("tickets-message-ack1")).toBeNull()
      expect(screen.getByTestId("tickets-message-m1")).toBeTruthy()
      expect(screen.getByTestId("tickets-message-m2")).toBeTruthy()
      const articles = Array.from(document.querySelectorAll("article"))
      expect(articles).toHaveLength(2)
    })

    it("still renders normally when isAcknowledgement is absent or false", () => {
      setThreads({
        t1: {
          ids: ["m1", "m2"],
          byId: {
            m1: { id: "m1", ticketId: "t1", kind: "inbound", textBody: "Hi" },
            m2: {
              id: "m2",
              ticketId: "t1",
              kind: "outbound",
              textBody: "Reply",
              isAcknowledgement: false,
            },
          },
          nextCursor: null,
        },
      })
      render(() => <TicketConversationStream ticketId="t1" />)
      expect(screen.getByTestId("tickets-message-m1")).toBeTruthy()
      expect(screen.getByTestId("tickets-message-m2")).toBeTruthy()
    })
  })

  describe("visual separation between messages", () => {
    it("gives each message card a visible border and background distinct from the container", () => {
      setThreads({
        t1: {
          ids: ["m1", "m2"],
          byId: {
            m1: { id: "m1", ticketId: "t1", kind: "inbound", textBody: "Hi" },
            m2: { id: "m2", ticketId: "t1", kind: "outbound", textBody: "Hi back" },
          },
          nextCursor: null,
        },
      })
      render(() => <TicketConversationStream ticketId="t1" />)
      const m1 = screen.getByTestId("tickets-message-m1")
      // Inbound card: a real border color token (not the near-invisible
      // "subtle" one) plus a background that stands out from the scroll
      // container, plus a shadow for depth-based separation.
      expect(m1.className).toContain("border-border")
      expect(m1.className).not.toContain("border-border-subtle")
      expect(m1.className).toContain("bg-surface-sunken")
      expect(m1.className).toContain("shadow-sm")
    })

    it("the conversation container spaces message cards apart", () => {
      setThreads({
        t1: {
          ids: ["m1"],
          byId: { m1: { id: "m1", ticketId: "t1", kind: "inbound", textBody: "Hi" } },
          nextCursor: null,
        },
      })
      render(() => <TicketConversationStream ticketId="t1" />)
      const container = screen.getByTestId("tickets-conversation")
      expect(container.className).toMatch(/gap-3/)
    })
  })

  describe("quoted-history collapsing", () => {
    it("collapses a trailing quote that repeats the previous message's text, behind a toggle", () => {
      setThreads({
        t1: {
          ids: ["m1", "m2"],
          byId: {
            m1: {
              id: "m1",
              ticketId: "t1",
              kind: "outbound",
              textBody: "Please send your order number.",
            },
            m2: {
              id: "m2",
              ticketId: "t1",
              kind: "inbound",
              textBody:
                "It's #12345, thanks!\n\nOn Mon, Jan 1, 2026, Support wrote:\n> Please send your order number.",
            },
          },
          nextCursor: null,
        },
      })
      render(() => <TicketConversationStream ticketId="t1" />)
      expect(screen.getByTestId("tickets-message-m2").textContent).toContain("It's #12345, thanks!")
      expect(screen.queryByTestId("tickets-message-quote-body-m2")).toBeNull()
      const toggle = screen.getByTestId("tickets-message-quote-toggle-m2")
      expect(toggle).toBeTruthy()

      fireEvent.click(toggle)
      const quoteBody = screen.getByTestId("tickets-message-quote-body-m2")
      expect(quoteBody.textContent).toContain("Please send your order number.")

      fireEvent.click(screen.getByTestId("tickets-message-quote-collapse-m2"))
      expect(screen.queryByTestId("tickets-message-quote-body-m2")).toBeNull()
    })

    it("does not show a toggle when there is no quoted history", () => {
      setThreads({
        t1: {
          ids: ["m1", "m2"],
          byId: {
            m1: { id: "m1", ticketId: "t1", kind: "outbound", textBody: "Hello there" },
            m2: { id: "m2", ticketId: "t1", kind: "inbound", textBody: "Thanks, all good now." },
          },
          nextCursor: null,
        },
      })
      render(() => <TicketConversationStream ticketId="t1" />)
      expect(screen.queryByTestId("tickets-message-quote-toggle-m2")).toBeNull()
    })

    // A quote the agent put in their own reply is content: the whole reply
    // shows, nothing folds behind the toggle.
    it("shows a reply written in Liaison whole, quote included", () => {
      const html =
        "<p>Bonjour,</p><blockquote><p>Le montant semblait plus élevé que d'habitude, pouvez-vous vérifier ?</p></blockquote><p>Voici la facture corrigée, avec toutes nos excuses.</p>"
      setThreads({
        t1: {
          ids: ["m1"],
          byId: {
            m1: { id: "m1", ticketId: "t1", kind: "outbound", createdBy: "u1", htmlBody: html },
          },
          nextCursor: null,
        },
      })
      render(() => <TicketConversationStream ticketId="t1" />)
      expect(screen.queryByTestId("tickets-message-quote-toggle-m1")).toBeNull()
      expect(screen.getByTestId("tickets-message-html-m1").textContent).toContain(
        "Voici la facture corrigée",
      )
    })

    it("does not attempt quote collapsing for messages rendered as HTML", () => {
      setThreads({
        t1: {
          ids: ["m1", "m2"],
          byId: {
            m1: {
              id: "m1",
              ticketId: "t1",
              kind: "outbound",
              textBody: "Please confirm your address.",
            },
            m2: {
              id: "m2",
              ticketId: "t1",
              kind: "inbound",
              htmlBody: "<p>Confirmed.</p><blockquote>Please confirm your address.</blockquote>",
              textBody: "Confirmed.\n\n> Please confirm your address.",
            },
          },
          nextCursor: null,
        },
      })
      render(() => <TicketConversationStream ticketId="t1" />)
      expect(screen.queryByTestId("tickets-message-quote-toggle-m2")).toBeNull()
      expect(screen.getByTestId("tickets-message-html-m2")).toBeTruthy()
    })
  })

  describe("author display", () => {
    it("outbound rows show the authoring Liaison user, inbound rows show the customer", () => {
      setThreads({
        t1: {
          ids: ["m1", "m2"],
          byId: {
            // Inbound: the email-wire identity is the author.
            m1: {
              id: "m1",
              ticketId: "t1",
              kind: "inbound",
              textBody: "Hi",
              fromName: "Alice Customer",
              fromEmail: "alice@cust.test",
            },
            // Outbound: authorName (the Liaison agent) wins over the inbox
            // envelope identity in fromName/fromEmail.
            m2: {
              id: "m2",
              ticketId: "t1",
              kind: "outbound",
              textBody: "Hi back",
              authorName: "Taylor",
              fromName: null,
              fromEmail: "support@fabrikam.test",
            },
          },
          nextCursor: null,
        },
      })
      render(() => <TicketConversationStream ticketId="t1" />)
      expect(screen.getByTestId("tickets-message-m1").textContent).toContain("Alice Customer")
      // A named sender still shows their address: a ticket linked to no contact
      // has no contact chip, so the row is the only place staff can read it.
      expect(screen.getByTestId("tickets-message-from-email-m1").textContent).toBe(
        "<alice@cust.test>",
      )
      expect(screen.queryByTestId("tickets-message-from-email-m2")).toBeNull()
      const m2 = screen.getByTestId("tickets-message-m2")
      expect(m2.textContent).toContain("Taylor")
      expect(m2.textContent).not.toContain("support@fabrikam.test")
    })

    it("outbound rows with no resolved author fall back to a support label, never a dash", () => {
      setThreads({
        t1: {
          ids: ["m1"],
          byId: {
            m1: {
              id: "m1",
              ticketId: "t1",
              kind: "outbound",
              textBody: "Legacy row",
              authorName: null,
              fromName: null,
              fromEmail: null,
            },
          },
          nextCursor: null,
        },
      })
      render(() => <TicketConversationStream ticketId="t1" />)
      const m1 = screen.getByTestId("tickets-message-m1")
      expect(m1.textContent).toContain("Support")
      expect(m1.textContent).not.toContain("Unknown sender")
    })

    // Merge-survivor fixture — mirrors the real staging repro (ticket
    // c251d5c3, a 3-way merge target): two agent-authored merge notes plus
    // four merged-in inbound rows whose from* fields are all null (the merge
    // COPY carries html_body/text_body/from_email/from_name verbatim from the
    // source ticket's rows) and whose text bodies are, for two of them, raw
    // JSON strings rather than plain text. None of this should throw or
    // filter messages out — all 6 must render.
    it("renders every message for a merge-survivor ticket (null from* fields, raw-JSON inbound bodies)", () => {
      setThreads({
        t1: {
          ids: ["note1", "note2", "in1", "in2", "in3", "in4"],
          byId: {
            note1: {
              id: "note1",
              ticketId: "t1",
              kind: "note",
              textBody: "[AI] Merged duplicate tickets (ticket-9916, ticket-9915, ticket-9914).",
              authorName: "Pat Rivera",
              fromName: null,
              fromEmail: null,
              htmlBody: null,
            },
            note2: {
              id: "note2",
              ticketId: "t1",
              kind: "note",
              textBody: "Merging duplicate tickets into the latest ticket.",
              authorName: "Pat Rivera",
              fromName: null,
              fromEmail: null,
              htmlBody: null,
            },
            in1: {
              id: "in1",
              ticketId: "t1",
              kind: "inbound",
              textBody:
                '{"kind":"inbound","textBody":"Hi,\\nstill waiting for my activation link\\nregards\\ndieter"}',
              fromName: null,
              fromEmail: null,
              htmlBody: null,
            },
            in2: {
              id: "in2",
              ticketId: "t1",
              kind: "inbound",
              textBody:
                '{"kind": "inbound", "textBody": "Hi,\\nstill waiting for my activation link\\nregards\\ndieter\\n\\nOn 07/07/2026 11:51, fabrikam wrote:\\n> Please find attached a copy of invoice 3263."}',
              fromName: null,
              fromEmail: null,
              htmlBody: null,
            },
            in3: {
              id: "in3",
              ticketId: "t1",
              kind: "inbound",
              textBody:
                '{"kind": "inbound", "textBody": "Hi,\\nstill waiting for my activation link\\nregards\\ndieter\\n\\nOn 07/07/2026 11:51, fabrikam wrote:\\n> Please find attached a copy of invoice 3262."}',
              fromName: null,
              fromEmail: null,
              htmlBody: null,
            },
            in4: {
              id: "in4",
              ticketId: "t1",
              kind: "inbound",
              textBody:
                '{"kind": "inbound", "textBody": "Hi,\\nstill waiting for my activation link\\nregards\\ndieter\\n\\nOn 07/07/2026 11:51, fabrikam wrote:\\n> Please find attached a copy of invoice 3261."}',
              fromName: null,
              fromEmail: null,
              htmlBody: null,
            },
          },
          nextCursor: null,
        },
      })
      render(() => <TicketConversationStream ticketId="t1" />)
      for (const id of ["note1", "note2", "in1", "in2", "in3", "in4"]) {
        expect(screen.getByTestId(`tickets-message-${id}`)).toBeTruthy()
      }
      // Null fromName/fromEmail on an inbound merge-survivor row falls back to
      // the "Unknown sender" placeholder, not a crash.
      expect(screen.getByTestId("tickets-message-in1").textContent).toContain("Unknown sender")
      // Raw-JSON textBody renders as literal text (no JSON.parse in the render
      // path), not an empty/blank row.
      expect(screen.getByTestId("tickets-message-in1").textContent).toContain(
        "still waiting for my activation link",
      )
    })
  })
})

describe("splitQuotedHistory", () => {
  it("returns the full text unchanged when there is no previous message", () => {
    const result = splitQuotedHistory("Hello world", undefined)
    expect(result).toEqual({ visible: "Hello world", quoted: "" })
  })

  it("returns the full text unchanged when there is no overlap with the previous message", () => {
    const result = splitQuotedHistory("Totally unrelated reply.", "Some other prior content here.")
    expect(result.quoted).toBe("")
    expect(result.visible).toBe("Totally unrelated reply.")
  })

  it("collapses a Gmail-style '>' quoted block that repeats the previous message", () => {
    const prev = "Please send your order number so we can look into this."
    const current = `Sure, it's #98765.\n\nOn Tue, Jan 2, 2026 at 10:00, Support <support@example.com> wrote:\n> ${prev}`
    const result = splitQuotedHistory(current, prev)
    expect(result.visible).toBe("Sure, it's #98765.")
    expect(result.quoted).toContain(prev)
    expect(result.quoted).toContain("wrote:")
  })

  it("is tolerant of rewrapped whitespace and multiple '>' quote markers", () => {
    const prev = "Line one of the prior message.\nLine two of the prior message."
    const current = [
      "Got it, thanks.",
      "",
      ">> Line one of   the prior message.",
      ">>Line two of the prior   message.",
    ].join("\n")
    const result = splitQuotedHistory(current, prev)
    expect(result.visible).toBe("Got it, thanks.")
    expect(result.quoted.length).toBeGreaterThan(0)
  })

  it("does not collapse a short/coincidental trailing overlap", () => {
    const prev = "Thanks."
    const current = "My reply also happens to end with the word Thanks."
    const result = splitQuotedHistory(current, prev)
    expect(result.quoted).toBe("")
    expect(result.visible).toBe(current)
  })

  it("handles an empty or missing current body", () => {
    expect(splitQuotedHistory(undefined, "prev")).toEqual({ visible: "", quoted: "" })
    expect(splitQuotedHistory(null, "prev")).toEqual({ visible: "", quoted: "" })
    expect(splitQuotedHistory("", "prev")).toEqual({ visible: "", quoted: "" })
  })

  it("handles a missing previous body (no quote can be detected)", () => {
    const current = "Just a normal reply with no quoting."
    expect(splitQuotedHistory(current, undefined)).toEqual({ visible: current, quoted: "" })
    expect(splitQuotedHistory(current, null)).toEqual({ visible: current, quoted: "" })
    expect(splitQuotedHistory(current, "")).toEqual({ visible: current, quoted: "" })
  })
})

describe("splitQuotedHtml", () => {
  it("splits a Freshdesk-wrapped quote (the real staging shape) at the quote container", () => {
    // Mirrors the real ticket cb77edc6 markup: reply divs, then a
    // <div class="freshdesk_quote"> wrapping a freshdesk_attr attribution and a
    // nested <blockquote>.
    const html = `<div><div><div>Bonjour Jonathan,</div><div>Vous avez parfaitement raison.</div><div>L'équipe Fabrikam</div></div><div class="freshdesk_quote"><div class="freshdesk_attr">Le Ven, 3 Juill., Jonathan Aceituno &lt;joinoin@icloud.com&gt; a écrit :</div><blockquote class="freshdesk_quote"><div>Bonjour, j'ai un souci avec le produit et voici tous les details du probleme.</div></blockquote></div></div>`
    const { visibleHtml, quotedHtml } = splitQuotedHtml(html)
    expect(visibleHtml).toContain("Vous avez parfaitement raison")
    expect(visibleHtml).not.toContain("a écrit")
    expect(visibleHtml).not.toContain("j'ai un souci")
    expect(quotedHtml).toContain("a écrit")
    expect(quotedHtml).toContain("j'ai un souci")
  })

  it("splits a Gmail-wrapped quote (gmail_quote container with attribution + blockquote)", () => {
    const html = `<div dir="ltr">Thanks, that fixed it!</div><div class="gmail_quote"><div dir="ltr" class="gmail_attr">On Mon, Jan 5, 2026 at 9:00 AM Support &lt;support@acme.com&gt; wrote:</div><blockquote class="gmail_quote"><div>Please try reinstalling and let us know if the problem persists.</div></blockquote></div>`
    const { visibleHtml, quotedHtml } = splitQuotedHtml(html)
    expect(visibleHtml).toContain("that fixed it")
    expect(visibleHtml).not.toContain("wrote:")
    expect(quotedHtml).toContain("reinstalling")
    expect(quotedHtml).toContain("wrote:")
  })

  it("splits on a bare blockquote and pulls in a preceding loose 'On ... wrote:' attribution", () => {
    const html = `<div>Got it, thank you.</div><div>On Tue, Feb 2, 2026, Alice &lt;alice@cust.test&gt; wrote:</div><blockquote><div>Here is my original question about the device.</div></blockquote>`
    const { visibleHtml, quotedHtml } = splitQuotedHtml(html)
    expect(visibleHtml).toContain("Got it, thank you")
    expect(visibleHtml).not.toContain("wrote:")
    expect(quotedHtml).toContain("wrote:")
    expect(quotedHtml).toContain("original question")
  })

  it("does not collapse a message with no quoted history", () => {
    const html = `<div>Just a short reply with no quote at all.</div>`
    expect(splitQuotedHtml(html)).toEqual({ visibleHtml: html, quotedHtml: "" })
  })

  it("does not collapse when the whole message would be hidden (nothing visible left)", () => {
    const html = `<blockquote><div>This entire message is just a quoted block of some length here.</div></blockquote>`
    const { quotedHtml } = splitQuotedHtml(html)
    expect(quotedHtml).toBe("")
  })

  it("does not collapse a trivially short quote", () => {
    const html = `<div>My reply.</div><blockquote>ok</blockquote>`
    expect(splitQuotedHtml(html).quotedHtml).toBe("")
  })

  it("handles empty / missing input", () => {
    expect(splitQuotedHtml("")).toEqual({ visibleHtml: "", quotedHtml: "" })
    expect(splitQuotedHtml(null)).toEqual({ visibleHtml: "", quotedHtml: "" })
    expect(splitQuotedHtml(undefined)).toEqual({ visibleHtml: "", quotedHtml: "" })
  })
})

describe("TicketConversationStream — quoted history list", () => {
  // A Foxmail reply wrapped in leading cite blockquotes, with a chain of seven
  // earlier emails under a From/Date header block (synthetic, real structure).
  const foxmail = readFileSync(
    join(import.meta.dirname, "../../lib/__fixtures__/foxmail-nested-thread.html"),
    "utf8",
  )
  const seed = (): void => {
    setThreads({
      t1: {
        ids: ["m0", "m1"],
        byId: {
          m0: {
            id: "m0",
            ticketId: "t1",
            kind: "inbound",
            textBody:
              "Hi Mei,\n\nThe pro forma matches what we agreed. The deposit will follow before Friday.\n\nHugo",
          },
          m1: { id: "m1", ticketId: "t1", kind: "inbound", htmlBody: foxmail },
        },
        nextCursor: null,
      },
    })
  }

  it("folds the chain under the reply and counts its earlier emails", () => {
    seed()
    render(() => <TicketConversationStream ticketId="t1" />)
    const visible = screen.getByTestId("tickets-message-html-m1")
    expect(visible.textContent).toContain("production of the stands starts on Monday")
    expect(visible.textContent).not.toContain("The deposit went out this morning")
    expect(screen.getByTestId("tickets-message-quote-toggle-m1").textContent).toContain(
      "7 earlier emails · 1 already in this thread",
    )
  })

  it("lists one row per earlier email and links the one already in the thread", () => {
    seed()
    const scrollIntoView = vi.spyOn(HTMLElement.prototype, "scrollIntoView")
    render(() => <TicketConversationStream ticketId="t1" />)
    fireEvent.click(screen.getByTestId("tickets-message-quote-toggle-m1"))
    const rows = screen.getAllByTestId(/^tickets-message-quote-row-m1-/)
    expect(rows).toHaveLength(7)
    expect(rows[0].textContent).toContain("Hugo Lambert")
    expect(rows[0].textContent).toContain(
      "The deposit went out this morning, the bank reference is in the attachment.",
    )
    // Row 2 is m0's text: it links up instead of repeating the body.
    expect(rows[2].textContent).toContain("In this thread")
    fireEvent.click(screen.getByTestId("tickets-message-quote-jump-m1-2"))
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect(scrollIntoView.mock.contexts[0]).toBe(screen.getByTestId("tickets-message-m0"))
    scrollIntoView.mockRestore()
  })

  it("shows the raw tail, nested quotes flattened, behind Show original", () => {
    seed()
    render(() => <TicketConversationStream ticketId="t1" />)
    fireEvent.click(screen.getByTestId("tickets-message-quote-toggle-m1"))
    expect(screen.queryByTestId("tickets-message-quote-original-body-m1")).toBeNull()
    fireEvent.click(screen.getByTestId("tickets-message-quote-original-m1"))
    const original = screen.getByTestId("tickets-message-quote-original-body-m1")
    expect(original.textContent).toContain("Subject:")
    expect(original.innerHTML).toContain("[&amp;_blockquote_blockquote]:border-l-0")
    fireEvent.click(screen.getByTestId("tickets-message-quote-collapse-m1"))
    expect(screen.queryByTestId("tickets-message-quote-body-m1")).toBeNull()
  })

  it("keeps Show original open when the message's row remounts", () => {
    seed()
    render(() => <TicketConversationStream ticketId="t1" />)
    fireEvent.click(screen.getByTestId("tickets-message-quote-toggle-m1"))
    fireEvent.click(screen.getByTestId("tickets-message-quote-original-m1"))
    const before = screen.getByTestId("tickets-message-quote-original-body-m1")
    // A re-fetched message replaces its row (a new object, so a new row).
    setThreadsStore(
      produce((s) => {
        s.threadsByTicketId.t1.byId.m1 = {
          id: "m1",
          ticketId: "t1",
          kind: "inbound",
          htmlBody: foxmail,
        }
      }),
    )
    const after = screen.getByTestId("tickets-message-quote-original-body-m1")
    expect(after).not.toBe(before)
    expect(after.textContent).toContain("Subject:")
  })
})

describe("TicketConversationStream — HTML quote collapsing (render)", () => {
  it("collapses an htmlBody message's quoted history behind a toggle, expandable", () => {
    const html = `<div><div>Bonjour Jonathan, voici la reponse a votre question.</div></div><div class="freshdesk_quote"><div class="freshdesk_attr">Le Ven 3 Juill, Jonathan &lt;j@icloud.com&gt; a écrit :</div><blockquote class="freshdesk_quote"><div>Bonjour, j'ai un gros souci avec mon appareil et voici les details.</div></blockquote></div>`
    setThreads({
      t1: {
        ids: ["m1"],
        byId: { m1: { id: "m1", ticketId: "t1", kind: "outbound", htmlBody: html } },
        nextCursor: null,
      },
    })
    render(() => <TicketConversationStream ticketId="t1" />)
    // Visible body shows the reply, hides the quoted tail until expanded.
    const visible = screen.getByTestId("tickets-message-html-m1")
    expect(visible.textContent).toContain("voici la reponse")
    expect(visible.textContent).not.toContain("j'ai un gros souci")
    // The "…" toggle is present; the quoted body is not yet rendered.
    expect(screen.getByTestId("tickets-message-quote-toggle-m1")).toBeTruthy()
    expect(screen.queryByTestId("tickets-message-quote-body-m1")).toBeNull()
    // Expand -> quoted history appears.
    fireEvent.click(screen.getByTestId("tickets-message-quote-toggle-m1"))
    const quoted = screen.getByTestId("tickets-message-quote-body-m1")
    expect(quoted.textContent).toContain("j'ai un gros souci")
  })
})

// F6 polish. The header put a standalone "\u00b7" between the author and the
// timestamp, so a message with no send time ended in a bare separator, and at
// phone width the separator wrapped to a line of its own.
describe("TicketConversationStream: the separator belongs to the timestamp", () => {
  it("renders it with the timestamp when there is one", () => {
    setThreads({
      t1: {
        ids: ["m1"],
        byId: {
          m1: {
            id: "m1",
            ticketId: "t1",
            kind: "inbound",
            textBody: "Hi",
            htmlBody: null,
            sentAt: "2026-01-01T00:00:00Z",
          },
        },
        nextCursor: null,
      },
    })
    render(() => <TicketConversationStream ticketId="t1" />)
    const sent = screen.getByTestId("tickets-message-sent-m1")
    expect(sent.textContent?.startsWith("\u00b7")).toBe(true)
    const header = sent.parentElement as HTMLElement
    const standalone = Array.from(header.children).filter(
      (el) => (el.textContent ?? "").trim() === "\u00b7",
    )
    expect(standalone).toHaveLength(0)
  })

  it("renders no separator at all when the message has no send time", () => {
    setThreads({
      t1: {
        ids: ["m1"],
        byId: {
          m1: {
            id: "m1",
            ticketId: "t1",
            kind: "inbound",
            textBody: "Hi",
            htmlBody: null,
            sentAt: null,
          },
        },
        nextCursor: null,
      },
    })
    render(() => <TicketConversationStream ticketId="t1" />)
    expect(screen.queryByTestId("tickets-message-sent-m1")).toBeNull()
    const header = screen.getByTestId("tickets-message-m1").querySelector("header") as HTMLElement
    expect(header.textContent).not.toContain("\u00b7")
  })
})

describe("TicketConversationStream: internal notes are markdown", () => {
  beforeEach(() => {
    state.api.getEnvelope = vi.fn().mockResolvedValue({ data: [] })
    setThreads({
      t1: {
        ids: ["in1", "note1"],
        byId: {
          in1: {
            id: "in1",
            ticketId: "t1",
            kind: "inbound",
            textBody: "Bonjour, **pas** de markdown ici",
            htmlBody: null,
          },
          note1: {
            id: "note1",
            ticketId: "t1",
            kind: "note",
            textBody: "Client **prioritaire** :\n\n- relancer le hub\n- [ ] vérifier le CA",
            authorName: "Agent Support",
            htmlBody: null,
          },
        },
        nextCursor: null,
      },
    })
  })

  it("renders a note's formatting, and leaves a plain email as written", () => {
    render(() => <TicketConversationStream ticketId="t1" />)
    const note = screen.getByTestId("tickets-note-body-note1")
    expect(note.querySelector("strong")?.textContent).toBe("prioritaire")
    expect(note.querySelectorAll("li")).toHaveLength(2)
    expect(note.textContent).not.toContain("**")
    const email = screen.getByTestId("tickets-message-in1")
    expect(email.querySelector("pre")?.textContent).toBe("Bonjour, **pas** de markdown ici")
  })

  it("never folds a note away as quoted history, even one repeating the message before", () => {
    setThreads({
      t1: {
        ids: ["n1", "n2"],
        byId: {
          n1: {
            id: "n1",
            ticketId: "t1",
            kind: "note",
            textBody: "Rappel **urgent** : appeler ++la direction++ avant midi",
            htmlBody: null,
          },
          n2: {
            id: "n2",
            ticketId: "t1",
            kind: "note",
            textBody: "Rappel **urgent** : appeler ++la direction++ avant midi",
            htmlBody: null,
          },
        },
        nextCursor: null,
      },
    })
    render(() => <TicketConversationStream ticketId="t1" />)
    expect(screen.getByTestId("tickets-note-body-n2").querySelector("strong")?.textContent).toBe(
      "urgent",
    )
    expect(screen.queryByTestId("tickets-message-quote-toggle-n2")).toBeNull()
  })

  it("edits a note in the rich editor and saves its markdown", async () => {
    state.api.post = vi.fn().mockResolvedValue({})
    render(() => <TicketConversationStream ticketId="t1" />)
    fireEvent.click(screen.getByTestId("tickets-note-edit-note1"))
    const field = await screen.findByTestId("tickets-note-edit-input-note1")
    expect(field.querySelector("strong")?.textContent).toBe("prioritaire")
    setMarkdown(field, "Client **très** prioritaire")
    fireEvent.click(screen.getByTestId("tickets-note-edit-save-note1"))
    await waitFor(() => expect(state.api.post).toHaveBeenCalled())
    expect(state.api.post.mock.calls[0][1]).toMatchObject({
      toolName: "tickets:editNote",
      params: { messageId: "note1", text: "Client **très** prioritaire" },
    })
  })
})

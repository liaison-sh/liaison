// SPDX-License-Identifier: FSL-1.1-ALv2
// A customer reply appended to an existing ticket announces itself as
// `tickets:message create { ticketId }` with no message body (the inbound
// path only signals the append). The WS patch needs a full row, so it dropped
// that event and the open conversation never showed the reply until a reload.
import { createRoot } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EntityChangesTestAccess, notifyEntityChange } from "~/framework/entity-changes"
import {
  getThread,
  handleTicketMessageEvent,
  loadMessages,
  resetTicketMessageStore,
} from "./ticket-message-store"

const msg = (id: string, kind = "inbound") => ({ id, ticketId: "t1", kind, textBody: id })

describe("ticket-message-store live", () => {
  let page: ReturnType<typeof msg>[]
  const post = vi.fn(async () => ({
    ticket: { id: "t1" },
    // Newest-first, like the server.
    messages: { items: [...page].reverse(), nextCursor: null },
  }))
  // biome-ignore lint/suspicious/noExplicitAny: minimal ApiClient stub
  const api = { post } as any

  beforeEach(() => {
    EntityChangesTestAccess.reset()
    resetTicketMessageStore()
    post.mockClear()
    page = [msg("m1")]
  })
  afterEach(() => EntityChangesTestAccess.reset())

  it("a body-less inbound append reloads the open thread and the reply shows", async () => {
    await loadMessages(api, "t1")
    expect(getThread("t1")?.ids).toEqual(["m1"])
    page = [msg("m1"), msg("m2")]
    const event = { ticketId: "t1" }
    handleTicketMessageEvent("create", event)
    notifyEntityChange({
      key: "tickets:message",
      app: "tickets",
      entity: "message",
      action: "create",
      data: event,
    })
    await vi.waitFor(() => expect(getThread("t1")?.ids).toEqual(["m1", "m2"]))
  })

  it("the live reload outlives the component that first opened a thread", async () => {
    // TicketDetail's onMount is the first loadMessages caller: the live
    // subscription must not be owned (and disposed) by that component.
    await new Promise<void>((resolve) => {
      createRoot((dispose) => {
        void loadMessages(api, "t1").then(() => {
          dispose()
          resolve()
        })
      })
    })
    page = [msg("m1"), msg("m2")]
    notifyEntityChange({
      key: "tickets:message",
      app: "tickets",
      entity: "message",
      action: "create",
      data: { ticketId: "t1" },
    })
    await vi.waitFor(() => expect(getThread("t1")?.ids).toEqual(["m1", "m2"]))
  })

  it("a full message event is patched in place, without a refetch", async () => {
    await loadMessages(api, "t1")
    const calls = post.mock.calls.length
    const full = msg("m3", "outbound")
    handleTicketMessageEvent("create", full)
    notifyEntityChange({
      key: "tickets:message",
      app: "tickets",
      entity: "message",
      action: "create",
      data: full,
    })
    await new Promise((r) => setTimeout(r, 250))
    expect(getThread("t1")?.ids).toEqual(["m1", "m3"])
    expect(post.mock.calls.length).toBe(calls)
  })

  it("an append on a ticket whose thread is not open fetches nothing", async () => {
    await loadMessages(api, "t1")
    const calls = post.mock.calls.length
    notifyEntityChange({
      key: "tickets:message",
      app: "tickets",
      entity: "message",
      action: "create",
      data: { ticketId: "other" },
    })
    await new Promise((r) => setTimeout(r, 250))
    expect(post.mock.calls.length).toBe(calls)
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Ticket read state is shared by the team: one agent's read clears the bold
// row for everybody. `tickets:markRead` wrote the read and told nobody, so
// every other open client (the reader's own phone included) kept the ticket
// unread until its next reload. The handler now emits the flip as a ticket
// update, which the web stores already patch rows from.
import { beforeAll, describe, expect, it } from "bun:test"

type Handler = (params: any, ctx: any) => Promise<any>
let ticketsMarkRead: Handler

beforeAll(async () => {
  const handlersUrl = new URL("./handlers.ts", import.meta.url)
  await import(handlersUrl.pathname)
  ticketsMarkRead = (globalThis as any).ticketsMarkRead
})

const TICKET = "11111111-2222-4333-8444-555555555555"

function ctxReturning(outcome: unknown) {
  const emitted: any[] = []
  const ctx = {
    tickets_markRead: async () => JSON.stringify(outcome),
    emit: async (json: string) => {
      emitted.push(JSON.parse(json))
    },
  }
  return { ctx, emitted }
}

describe("tickets:markRead tells every open client when a ticket becomes read", () => {
  it("emits a ticket update with unread:false when the read flips the ticket", async () => {
    const { ctx, emitted } = ctxReturning({
      readAt: "2026-09-30T10:00:00.000Z",
      lastReadMessageId: null,
      becameRead: true,
    })
    const out = await ticketsMarkRead({ ticketId: TICKET }, ctx)
    expect(out.becameRead).toBe(true)
    expect(emitted).toEqual([
      {
        entity: "ticket",
        action: "update",
        entityId: TICKET,
        data: { ticketId: TICKET, changes: { unread: false } },
      },
    ])
  })

  it("emits nothing for a re-read of an already read ticket, or a refused read", async () => {
    const reread = ctxReturning({ readAt: "x", lastReadMessageId: null, becameRead: false })
    await ticketsMarkRead({ ticketId: TICKET }, reread.ctx)
    expect(reread.emitted).toEqual([])

    const refused = ctxReturning({ error: { code: "ticket_not_found", message: "no" } })
    await ticketsMarkRead({ ticketId: TICKET }, refused.ctx)
    expect(refused.emitted).toEqual([])
  })
})

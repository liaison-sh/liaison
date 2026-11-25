// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A sent quote's outcome is set once, by a person's call or by the client's
// answer on its link (invoicing's own subscriber on the kernel's decided event),
// and no outcome creates an invoice. An agent's call parks: the tool is gated.

import { describe, expect, it } from "bun:test"
import manifest from "../app.manifest.json"
import { onQuoteClientActionDecided, setQuoteOutcome } from "./quote-outcome"
import { createMockDb } from "./test-db"

const QUOTE = "00000000-0000-4000-8000-00000000a001"
const INVOICE = "00000000-0000-4000-8000-00000000a002"
const ACTION = "00000000-0000-4000-8000-00000000b001"

function world(record: Record<string, unknown> = {}) {
  const db = createMockDb({
    seed: {
      documents: [
        { id: QUOTE, type: "quote", status: "sent", number: "Q-0007", lifecycle_log: [] },
        { id: INVOICE, type: "invoice", status: "issued", number: "INV-0001", lifecycle_log: [] },
      ],
    },
  })
  const emitted: Array<Record<string, unknown>> = []
  const ctx = {
    db,
    emit: async (e: Record<string, unknown>) => {
      emitted.push(e)
    },
    getUserId: async () => "00000000-0000-4000-8000-0000000000aa",
    client_actions_record: async (_p: { id: string }) =>
      JSON.stringify({
        status: "ok",
        record: {
          id: ACTION,
          kind: "accept",
          decision: "accepted",
          target_id: QUOTE,
          replaced: false,
          ...record,
        },
      }),
  }
  return { db, ctx, emitted }
}

const decided = (target: { app: string; type: string; id: string }) => ({
  data: { id: ACTION, target },
})

async function invoiceCount(db: ReturnType<typeof createMockDb>) {
  return (await db.findMany("documents", { where: { type: "invoice" } })).length
}

describe("a quote's outcome", () => {
  it("a client's accept on the quote's link sets accepted once and creates no invoice", async () => {
    const { db, ctx, emitted } = world()
    const out = await onQuoteClientActionDecided(
      ctx as never,
      decided({ app: "invoicing", type: "document", id: QUOTE }),
    )
    expect(out.status).toBe("accepted")
    const q = (await db.findOne("documents", QUOTE)) as {
      status: string
      lifecycle_log: Array<{ via: string; client_action_id: string }>
    }
    expect(q.status).toBe("accepted")
    expect(q.lifecycle_log.at(-1)).toMatchObject({ via: "client_action", client_action_id: ACTION })
    expect(await invoiceCount(db)).toBe(1)
    expect(emitted.map((e) => `${e.entity}:${e.action}`)).toEqual(["document:updated"])
    // The same event again (a replay) changes nothing.
    const again = await onQuoteClientActionDecided(
      ctx as never,
      decided({ app: "invoicing", type: "document", id: QUOTE }),
    )
    expect(again.status).toBe("unchanged")
    expect(emitted).toHaveLength(1)
  })

  it("a declined link sets rejected", async () => {
    const { db, ctx } = world({ decision: "declined" })
    await onQuoteClientActionDecided(
      ctx as never,
      decided({ app: "invoicing", type: "document", id: QUOTE }),
    )
    expect(((await db.findOne("documents", QUOTE)) as { status: string }).status).toBe("rejected")
  })

  it("an agreement decision changes no invoicing row", async () => {
    const { db, ctx, emitted } = world()
    const out = await onQuoteClientActionDecided(
      ctx as never,
      decided({ app: "agreements", type: "agreement_version", id: QUOTE }),
    )
    expect(out.status).toBe("ignored")
    expect(((await db.findOne("documents", QUOTE)) as { status: string }).status).toBe("sent")
    expect(emitted).toHaveLength(0)
  })

  it("a record for another target than the event's is ignored", async () => {
    const { db, ctx } = world({ target_id: INVOICE })
    const out = await onQuoteClientActionDecided(
      ctx as never,
      decided({ app: "invoicing", type: "document", id: QUOTE }),
    )
    expect(out.status).toBe("ignored")
    expect(((await db.findOne("documents", QUOTE)) as { status: string }).status).toBe("sent")
  })

  it("a person's second outcome on the same quote is refused and changes nothing", async () => {
    const { db, ctx } = world()
    const first = await setQuoteOutcome(ctx as never, {
      document_id: QUOTE,
      outcome: "expired",
      via: "person",
    })
    expect(first.status).toBe("completed")
    const second = await setQuoteOutcome(ctx as never, {
      document_id: QUOTE,
      outcome: "accepted",
      via: "person",
    })
    expect(second).toMatchObject({ status: "error", error: { code: "OUTCOME_ALREADY_SET" } })
    expect(((await db.findOne("documents", QUOTE)) as { status: string }).status).toBe("expired")
  })

  it("an invoice takes no quote outcome", async () => {
    const { ctx } = world()
    const out = await setQuoteOutcome(ctx as never, {
      document_id: INVOICE,
      outcome: "accepted",
      via: "person",
    })
    expect(out).toMatchObject({ status: "error", error: { code: "NOT_A_QUOTE" } })
  })

  it("an agent's call parks for a person: the tool is gated, its subscriber is the app's own", () => {
    const m = manifest as unknown as {
      tools: Record<string, { gated?: boolean; requiredScopes: string[] }>
      events: { subscribes: Record<string, string> }
    }
    expect(m.tools.quote_set_outcome?.gated).toBe(true)
    expect(m.tools.quote_set_outcome?.requiredScopes).toEqual(["invoicing:documents:write"])
    expect(m.events.subscribes["kernel/client_action:decided"]).toBe(
      "onQuoteClientActionDecidedHandler",
    )
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The merge tool's own gate: a merge into a ticket the client's portal shows asks for a
// person's decision (an agent's call parks; a person's own call is granted inline by the
// kernel), a refusal is answered before any card, and a re-entry after approval merges.
import { describe, expect, it } from "bun:test"
import { merge } from "./handlers"

interface Calls {
  merges: Array<Record<string, unknown>>
  approvals: Array<Record<string, unknown>>
}

function ctxFor(opts: {
  check: Record<string, unknown>
  approval?: unknown
  grant?: { approval_id: string | null; auto_approved?: true }
}) {
  const calls: Calls = { merges: [], approvals: [] }
  const ctx = {
    approval: opts.approval ?? null,
    tickets_merge: async (json: string) => {
      const p = JSON.parse(json) as Record<string, unknown>
      calls.merges.push(p)
      if (p.checkOnly) return JSON.stringify(opts.check)
      return JSON.stringify({ targetTicketId: "t", mergedSourceCount: 1, copiedMessageCount: 2 })
    },
    requestApproval: async (json: string) => {
      calls.approvals.push(JSON.parse(json) as Record<string, unknown>)
      return JSON.stringify(opts.grant ?? { approval_id: "appr-1" })
    },
  }
  return { ctx: ctx as never, calls }
}

const PARAMS = { targetTicketId: "ticket-1", sourceTicketIds: ["ticket-2"] }

describe("the ticket merge gate", () => {
  it("an agent's merge into a ticket the portal shows parks for a person and merges nothing", async () => {
    const { ctx, calls } = ctxFor({
      check: { check: { targetHandle: "ticket-1", portalVisible: true } },
    })
    const out = (await merge(PARAMS, ctx)) as { status?: string; approval_id?: string }
    expect(out.status).toBe("pending_approval")
    expect(out.approval_id).toBe("appr-1")
    expect(calls.approvals.length).toBe(1)
    expect(calls.approvals[0]?.tool_name).toBe("tickets:merge")
    expect(calls.merges.filter((m) => !m.checkOnly)).toEqual([])
  })

  it("a person's own merge into a portal-shown ticket, granted inline, merges at once", async () => {
    const { ctx, calls } = ctxFor({
      check: { check: { targetHandle: "ticket-1", portalVisible: true } },
      grant: { approval_id: null, auto_approved: true },
    })
    const out = (await merge(PARAMS, ctx)) as { copiedMessageCount?: number }
    expect(out.copiedMessageCount).toBe(2)
    expect(calls.merges.filter((m) => !m.checkOnly).length).toBe(1)
  })

  it("a merge between internal tickets asks nobody", async () => {
    const { ctx, calls } = ctxFor({
      check: { check: { targetHandle: "ticket-1", portalVisible: false } },
    })
    const out = (await merge(PARAMS, ctx)) as { copiedMessageCount?: number }
    expect(out.copiedMessageCount).toBe(2)
    expect(calls.approvals).toEqual([])
  })

  it("a refused merge stages no card and writes nothing", async () => {
    const { ctx, calls } = ctxFor({
      check: { error: { code: "merge_other_company", message: "no", retryable: false } },
    })
    const out = (await merge(PARAMS, ctx)) as { error?: { code: string } }
    expect(out.error?.code).toBe("merge_other_company")
    expect(calls.approvals).toEqual([])
    expect(calls.merges.filter((m) => !m.checkOnly)).toEqual([])
  })

  it("a caller cannot skip the check by asking for check-only itself, and the approved re-entry merges", async () => {
    const { ctx, calls } = ctxFor({
      check: { check: { targetHandle: "ticket-1", portalVisible: true } },
    })
    const parked = (await merge({ ...PARAMS, checkOnly: true }, ctx)) as { status?: string }
    expect(parked.status).toBe("pending_approval")
    const again = ctxFor({
      check: { check: { targetHandle: "ticket-1", portalVisible: true } },
      approval: { id: "appr-1" },
    })
    const out = (await merge(PARAMS, again.ctx)) as { copiedMessageCount?: number }
    expect(out.copiedMessageCount).toBe(2)
    expect(again.calls.approvals).toEqual([])
    expect(calls.merges.filter((m) => !m.checkOnly)).toEqual([])
  })
})

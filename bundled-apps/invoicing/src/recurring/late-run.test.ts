// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A month-end run past its last issue day: one card marked Late asks what to do with each row, and
// each row can be issued or dropped. Nothing issues by itself, nothing is asked twice, and a run
// that was already late gets its card too.
import { describe, expect, test } from "bun:test"
import { harness, schedule } from "../__fixtures__/recurring-draft"
import { draftsCreateTool, draftsDiscard, draftsUpdateTool } from "../mutations"
import { summarizeRecurringRunIssue } from "../summarizers"
import { recurringDraftJob } from "./draft-job"
import { recurringIssueJob } from "./issue-job"
import { recurringLegalDateJob } from "./legal-date-job"
import {
  recurringRunIssue,
  recurringRunIssuePreflight,
  recurringRunUnapprove,
  runItemDraftRefusal,
} from "./run-card"
import { recurringRunGet } from "./run-get"

type Row = Record<string, unknown>
const A = "33333333-3333-4333-8333-333333333331"
const B = "33333333-3333-4333-8333-333333333332"

/** A run of two rows drafted in November, read again on `today`, with the state of its cards. */
async function run(opts: { autoLate?: boolean; noAddress?: boolean } = {}) {
  const h = harness("2026-11-27", {
    schedules: [schedule(A), schedule(B, { due_rule: "days_n", due_days: 10 })],
    ...(opts.noAddress
      ? { kernel: { "kernel:contacts_addresses_list": () => ({ addresses: [] }) } }
      : {}),
  })
  const status = new Map<string, string>()
  const withdrawn: string[] = []
  const emitted: Row[] = []
  let today = "2026-11-27"
  h.ctx = {
    ...h.ctx,
    time: {
      async civil({ at }: { at?: string }) {
        const date = at ? String(at).slice(0, 10) : today
        const [year, month, day] = date.split("-").map(Number) as [number, number, number]
        return { date, year, month, day, hour: 9, minute: 0, weekday: 1, zone: "Europe/Paris" }
      },
    },
    emit: async (e: Row) => void emitted.push(e),
    approvals: {
      restagePayload: async (id: string, fields: Row) => {
        if ((status.get(id) ?? "pending") !== "pending") return { ok: false, code: "not_pending" }
        h.restaged.push({ id, ...fields })
        return { ok: true, approval_id: id, payload_hash: "h", changed: true }
      },
      statusOf: async (id: string) => ({ status: status.get(id) ?? "pending", expired: false }),
      withdraw: async (id: string) => {
        withdrawn.push(id)
        status.set(id, "cancelled")
        return { ok: true }
      },
    },
  } as never
  await recurringDraftJob(h.ctx)
  const at = async (day: string, fn: () => Promise<unknown>) => {
    today = day
    return fn()
  }
  const runRow = () => h.db.__all("recurring_runs")[0] as Row
  const items = () => h.db.__all("recurring_run_items")
  const doc = (id: unknown) => h.db.__all("documents").find((d) => d.id === id) as Row
  const runId = String(runRow().id)
  return { h, runId, runRow, items, doc, status, withdrawn, emitted, at }
}

const day = (v: unknown) => String(v).slice(0, 10)

describe("a run past its last issue day", () => {
  test("gets one new card marked Late with its current rows, whatever card it had", async () => {
    const r = await run()
    expect(r.h.approvals).toHaveLength(1)
    await r.at("2026-12-01", () => recurringLegalDateJob(r.h.ctx))
    expect(r.runRow().status).toBe("late")
    expect(r.withdrawn).toEqual(["approval-1"])
    expect(r.h.approvals).toHaveLength(2)
    const card = r.h.approvals[1] as Row & { summary_detail: { subtitle: string } }
    expect(card.summary).toBe("Late: the invoices of November 2026, not issued by 2026-11-30")
    expect(card.summary_detail.subtitle).toContain("take a row out to drop it")
    expect(card.expiry_hours).toBe(720)
    expect((card.current_payload as Row).late).toBe(true)
    expect(((card.current_payload as Row).items as Row[]).length).toBe(2)
    expect((await summarizeRecurringRunIssue(card.current_payload as Row)).title).toBe(
      "Late: issue 2 invoices for November 2026",
    )
    expect(r.emitted.some((e) => e.action === "late" && (e.data as Row).resolved === false)).toBe(
      true,
    )
    // The next days and the five-minute job follow the same card: never a second one.
    for (const d of ["2026-12-02", "2026-12-03"]) {
      await r.at(d, () => recurringLegalDateJob(r.h.ctx))
      await r.at(d, () => recurringIssueJob(r.h.ctx))
    }
    expect(r.h.approvals).toHaveLength(2)
    const got = await recurringRunGet(r.h.ctx, { run_id: r.runId })
    expect(got.status === "completed" && got.message).toContain("waits for a person")
  })

  test("that was already late before gets its card from the same job", async () => {
    const r = await run()
    await r.h.db.update("recurring_runs", r.runId, { status: "late" })
    r.status.set("approval-1", "expired")
    await r.at("2027-01-05", () => recurringLegalDateJob(r.h.ctx))
    expect(r.h.approvals).toHaveLength(2)
    expect(String(r.h.approvals[1]?.summary)).toStartWith("Late:")
  })

  test("whose rows were approved in time and not issued asks for them again, none issues by itself", async () => {
    const r = await run()
    await recurringRunIssue(r.h.ctx, { run_id: r.runId })
    await r.at("2026-12-01", () => recurringLegalDateJob(r.h.ctx))
    expect(r.runRow().status).toBe("late")
    expect(r.items().map((i) => [i.state, i.approved_hash])).toEqual([
      ["waiting_reapproval", null],
      ["waiting_reapproval", null],
    ])
    const issued = (await r.at("2026-12-01", () => recurringIssueJob(r.h.ctx))) as {
      issued: number
      failed: number
    }
    expect([issued.issued, issued.failed]).toEqual([0, 0])
  })

  test("issues nothing in the hours before it is marked late either", async () => {
    const r = await run()
    await recurringRunIssue(r.h.ctx, { run_id: r.runId })
    const calls: string[] = []
    r.h.ctx = {
      ...r.h.ctx,
      executeTool: async (t: string) => {
        calls.push(t)
        return { status: "error", error: { code: "unavailable", message: "no tool" } }
      },
    } as never
    await r.at("2026-12-01", () => recurringIssueJob(r.h.ctx))
    expect(calls).toEqual([])
    expect(r.items().map((i) => i.state)).toEqual(["approved", "approved"])
  })

  test("whose card was rejected asks again from its job when a person changed a row", async () => {
    const r = await run()
    await r.at("2026-12-01", () => recurringLegalDateJob(r.h.ctx))
    r.status.set("approval-2", "denied")
    const ask = r.h.ctx.requestApproval
    // A person's own click cannot ask for a decision: the card is owed to the job.
    r.h.ctx = { ...r.h.ctx, requestApproval: async () => ({ approval_id: null }) } as never
    const draft = String(r.items()[0]?.document_id)
    await r.h.db.update("documents", draft, { updated_at: "2026-12-02T09:00:00Z" })
    await r.at("2026-12-02", () =>
      draftsUpdateTool(r.h.ctx as never, {
        draft_id: draft,
        patch: { notes: "Late, sorry" },
        if_unchanged_since: "2026-12-02T09:00:00Z",
      }),
    )
    expect(r.h.approvals).toHaveLength(2)
    r.h.ctx = { ...r.h.ctx, requestApproval: ask } as never
    await r.at("2026-12-02", () => recurringIssueJob(r.h.ctx))
    expect(r.h.approvals).toHaveLength(3)
  })

  test("is approved on its late card: its rows may issue then, and it is not late again at once", async () => {
    const r = await run()
    await r.at("2026-12-01", () => recurringLegalDateJob(r.h.ctx))
    const items = ((r.h.approvals[1] as Row).current_payload as Row).items as never
    expect(await recurringRunIssuePreflight(r.h.ctx, { run_id: r.runId })).toEqual({ ok: true })
    const out = await recurringRunIssue(r.h.ctx, { run_id: r.runId, items })
    expect(out).toMatchObject({ status: "completed", approved: 2 })
    expect(JSON.stringify(out)).toContain("they issue now")
    expect(r.runRow().late_approved_on).toBe("2026-12-01")
    expect(r.emitted.some((e) => e.action === "late" && (e.data as Row).resolved === true)).toBe(
      true,
    )
    const calls: string[] = []
    r.h.ctx = {
      ...r.h.ctx,
      executeTool: async (t: string) => {
        calls.push(t)
        return { status: "error", error: { code: "unavailable", message: "no tool" } }
      },
    } as never
    await r.at("2026-12-01", () => recurringIssueJob(r.h.ctx))
    // Both rows were started: past the last day, on a person's approval given after it.
    expect(calls.filter((c) => c === "invoicing:recurring_item_issue")).toHaveLength(2)
    expect(r.runRow().status).not.toBe("late")
  })

  test("rejected, is not asked again by itself; a change of a row asks again; expired, it is asked again", async () => {
    const r = await run()
    await r.at("2026-12-01", () => recurringLegalDateJob(r.h.ctx))
    r.status.set("approval-2", "denied")
    await r.at("2026-12-02", () => recurringLegalDateJob(r.h.ctx))
    await r.at("2026-12-02", () => recurringIssueJob(r.h.ctx))
    expect(r.h.approvals).toHaveLength(2)
    const draft = String(r.items()[0]?.document_id)
    await r.h.db.update("documents", draft, { updated_at: "2026-12-02T09:00:00Z" })
    await r.at("2026-12-02", () =>
      draftsUpdateTool(r.h.ctx as never, {
        draft_id: draft,
        patch: { notes: "Late, sorry" },
        if_unchanged_since: "2026-12-02T09:00:00Z",
      }),
    )
    expect(r.h.approvals).toHaveLength(3)
    r.status.set("approval-3", "expired")
    await r.at("2026-12-03", () => recurringLegalDateJob(r.h.ctx))
    expect(r.h.approvals).toHaveLength(4)
  })

  test("approved and not issued in the days after, it is late again and asks again", async () => {
    const r = await run()
    await r.at("2026-12-01", () => recurringLegalDateJob(r.h.ctx))
    await recurringRunIssue(r.h.ctx, { run_id: r.runId })
    for (const d of ["2026-12-02", "2026-12-03"])
      await r.at(d, () => recurringLegalDateJob(r.h.ctx))
    expect(r.runRow().status).toBe("approved")
    expect(r.h.approvals).toHaveLength(2)
    await r.at("2026-12-04", () => recurringLegalDateJob(r.h.ctx))
    expect(r.runRow().status).toBe("late")
    expect(r.items().map((i) => i.state)).toEqual(["waiting_reapproval", "waiting_reapproval"])
    expect(r.h.approvals).toHaveLength(3)
  })

  test("failed rows ask again on its late card, with nothing kept of their approval", async () => {
    const r = await run()
    await recurringRunIssue(r.h.ctx, { run_id: r.runId })
    const [a, b] = r.items().map((i) => String(i.id)) as [string, string]
    await r.h.db.update("recurring_run_items", a, { state: "issued" })
    await r.h.db.update("recurring_run_items", b, { state: "failed", send_grant: "g" })
    await r.h.db.update("recurring_runs", r.runId, { status: "partial" })
    await r.at("2026-12-01", () => recurringLegalDateJob(r.h.ctx))
    expect(r.runRow().status).toBe("late")
    expect(r.items()).toMatchObject([
      { state: "issued" },
      {
        state: "waiting_reapproval",
        approved_hash: null,
        approved_total_minor: null,
        send_grant: null,
      },
    ])
    expect(((r.h.approvals.at(-1) as Row).current_payload as { items: Row[] }).items).toHaveLength(
      1,
    )
  })

  test("a card still waiting is not priced again by the five-minute job", async () => {
    const r = await run()
    await r.at("2026-12-01", () => recurringLegalDateJob(r.h.ctx))
    const before = r.h.restaged.length
    await r.at("2026-12-01", () => recurringIssueJob(r.h.ctx))
    expect(r.h.restaged).toHaveLength(before)
    // Expired, the same job asks again.
    r.status.set("approval-2", "expired")
    await r.at("2026-12-02", () => recurringIssueJob(r.h.ctx))
    expect(r.h.approvals).toHaveLength(3)
  })

  test("whose late card was rejected says so on its page, and nothing else changes it but a row", async () => {
    const r = await run()
    await r.at("2026-12-01", () => recurringLegalDateJob(r.h.ctx))
    const read = async () => {
      const got = await recurringRunGet(r.h.ctx, { run_id: r.runId })
      if (got.status !== "completed") throw new Error("not read")
      return got
    }
    expect((await read()).run.card_rejected).toBeUndefined()
    r.status.set("approval-2", "denied")
    const got = await read()
    expect(got.run.card_rejected).toBe(true)
    expect(got.message).toContain("rejected")
    expect(got.message).not.toContain("waits for a person")
  })

  test("a row put back into a late run that had closed is late again, never open in time", async () => {
    const r = await run()
    await r.h.db.update("recurring_runs", r.runId, { status: "issued" })
    const [a] = r.items().map((i) => String(i.document_id)) as [string]
    for (const i of r.items())
      await r.h.db.update("recurring_run_items", String(i.id), {
        state: i.document_id === a ? "left_out" : "issued",
      })
    await r.h.db.update("documents", a, { updated_at: "2026-11-28T09:00:00Z" })
    const putBack = () =>
      draftsUpdateTool(r.h.ctx as never, {
        draft_id: a,
        put_back: true,
        if_unchanged_since: "2026-11-28T09:00:00Z",
      })
    await r.at("2026-11-28", putBack)
    expect(r.runRow().status).toBe("partial")
    expect(r.items()[0]?.state).toBe("waiting_reapproval")
    await r.h.db.update("recurring_runs", r.runId, { status: "issued" })
    await r.h.db.update("recurring_run_items", String(r.items()[0]?.id), { state: "left_out" })
    await r.at("2026-12-05", putBack)
    expect(r.runRow().status).toBe("late")
  })

  test("a row whose draft lost its link to the run is still the run's", async () => {
    const r = await run()
    const draft = String(r.items()[0]?.document_id)
    await r.h.db.update("documents", draft, { external_refs: {} })
    expect(
      await runItemDraftRefusal(r.h.ctx, r.doc(draft) as never, "invoice_issue"),
    ).toMatchObject({ error: { code: "run_item_draft" } })
    expect(
      await runItemDraftRefusal(r.h.ctx, { id: "other", external_refs: {} }, "invoice_issue"),
    ).toBeNull()
  })

  test("a row dropped leaves the card; the last one dropped closes the run with nothing issued", async () => {
    const r = await run()
    await r.at("2026-12-01", () => recurringLegalDateJob(r.h.ctx))
    const [a, b] = r.items().map((i) => String(i.document_id))
    await r.at("2026-12-01", () =>
      draftsDiscard(r.h.ctx as never, { draft_id: a as string, applies: "this_month" }),
    )
    expect(r.items().map((i) => i.state)).toEqual(["left_out", "ready"])
    expect(((r.h.restaged.at(-1) as Row).items as Row[]).map((i) => i.document_id)).toEqual([b])
    await r.at("2026-12-01", () =>
      draftsDiscard(r.h.ctx as never, { draft_id: b as string, applies: "this_month" }),
    )
    expect(r.runRow().status).toBe("nothing_to_issue")
    expect(r.withdrawn).toContain("approval-2")
    expect(r.emitted.filter((e) => e.action === "late").at(-1)).toMatchObject({
      data: { resolved: true },
    })
    await r.at("2026-12-02", () => recurringLegalDateJob(r.h.ctx))
    expect(r.h.approvals).toHaveLength(2)
    // Put back, the run is late again and asks.
    await r.h.db.update("documents", a as string, { updated_at: "2026-12-02T09:00:00Z" })
    await r.at("2026-12-02", () =>
      draftsUpdateTool(r.h.ctx as never, {
        draft_id: a as string,
        put_back: true,
        if_unchanged_since: "2026-12-02T09:00:00Z",
      }),
    )
    expect(r.runRow().status).toBe("late")
    expect(r.h.approvals).toHaveLength(3)
  })

  test("with every row needing a fix has no card until one is fixed, then has it", async () => {
    const r = await run({ noAddress: true })
    expect(r.items().every((i) => i.state === "needs_fix")).toBe(true)
    await r.at("2026-12-01", () => recurringLegalDateJob(r.h.ctx))
    expect(r.runRow().status).toBe("late")
    expect(r.h.approvals).toHaveLength(0)
    const draft = String(r.items()[0]?.document_id)
    await r.h.db.update("documents", draft, { updated_at: "2026-12-02T09:00:00Z" })
    await r.at("2026-12-02", () =>
      draftsUpdateTool(r.h.ctx as never, {
        draft_id: draft,
        applies: "this_month",
        patch: { counterparty_address: "3 rue des Lilas, 69001 Lyon", counterparty_country: "FR" },
        if_unchanged_since: "2026-12-02T09:00:00Z",
      }),
    )
    expect(r.items()[0]?.state).toBe("ready")
    expect(r.h.approvals).toHaveLength(1)
    expect(String(r.h.approvals[0]?.summary)).toStartWith("Late:")
  })

  test("an invoice can still be added to it, and the same one twice is refused", async () => {
    const r = await run()
    await r.at("2026-12-01", () => recurringLegalDateJob(r.h.ctx))
    const add = () =>
      draftsCreateTool(
        r.h.ctx as never,
        {
          type: "invoice",
          run_id: r.runId,
          counterparty_contact_id: "22222222-2222-4222-8222-222222222222",
          items: [{ description: "Extra hour", quantity: "1", unit_price_minor: "10000" }],
        } as never,
      )
    const added = (await r.at("2026-12-04", add)) as { draft_id: string }
    expect(day(r.doc(added.draft_id).due_at)).toBe("2027-01-03")
    expect(((r.h.restaged.at(-1) as Row).items as Row[]).length).toBe(3)
    await expect(r.at("2026-12-04", add)).rejects.toThrow(/^already_in_run/)
  })

  test("counts the due dates its terms gave from the day it is asked, and keeps a date a person set", async () => {
    const r = await run()
    const [a, b] = r.items().map((i) => String(i.document_id)) as [string, string]
    expect([day(r.doc(a).due_at), day(r.doc(b).due_at)]).toEqual(["2026-12-30", "2026-12-10"])
    await r.h.db.update("documents", a, { due_at: "2027-02-15" })
    await r.at("2026-12-05", () => recurringLegalDateJob(r.h.ctx))
    expect([day(r.doc(a).due_at), day(r.doc(b).due_at)]).toEqual(["2027-02-15", "2026-12-15"])
    await r.at("2026-12-07", () => recurringLegalDateJob(r.h.ctx))
    expect([day(r.doc(a).due_at), day(r.doc(b).due_at)]).toEqual(["2027-02-15", "2026-12-17"])
  })

  test("its approval undone before a number is taken, it is late again", async () => {
    const r = await run()
    await r.at("2026-12-01", () => recurringLegalDateJob(r.h.ctx))
    await recurringRunIssue(r.h.ctx, { run_id: r.runId })
    await r.at("2026-12-01", () => recurringRunUnapprove(r.h.ctx, { run_id: r.runId }))
    expect(r.runRow().status).toBe("late")
    expect(r.items().every((i) => i.state === "ready")).toBe(true)
  })

  test("a row put back into a run closed in time opens it again, undecided", async () => {
    const r = await run()
    await recurringRunIssue(r.h.ctx, { run_id: r.runId })
    await r.h.db.update("recurring_runs", r.runId, { status: "nothing_to_issue" })
    const [a] = r.items().map((i) => String(i.document_id)) as [string]
    for (const i of r.items())
      await r.h.db.update("recurring_run_items", String(i.id), { state: "left_out" })
    await r.h.db.update("documents", a, { updated_at: "2026-11-28T09:00:00Z" })
    await r.at("2026-11-28", () =>
      draftsUpdateTool(r.h.ctx as never, {
        draft_id: a,
        put_back: true,
        if_unchanged_since: "2026-11-28T09:00:00Z",
      }),
    )
    expect(r.runRow().status).toBe("drafted")
    expect(r.items()[0]?.state).toBe("ready")
  })
})

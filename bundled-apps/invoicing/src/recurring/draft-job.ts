// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The hourly draft job of recurring invoicing. On each schedule's draft day (the issuer's civil
// date), it makes one unnumbered draft for the period from the schedule alone: its lines, prices,
// rates and terms, with `{period}` filled. No model is asked anything. Each draft joins the run of
// its issuer and issue day, as one item, and the run gets one card.
//
// Every step is keyed so a second run of the job, or one running at the same time, adds nothing:
// the draft by `external_ref = recurring:<schedule>:<period_key>` (unique), the run by issuer and
// issue day (unique), the item by schedule and period (unique), the card by a claim on the run.
import { civilDateOf } from "../issue-date"
import { lineSubtotal } from "../money"
import { type CurrentDraft, linesSignature, periodLabel, type PreviousInvoice, runItemFlags } from "./flags"
import {
  dayOf,
  draftLines,
  endHold,
  draftTotals,
  findOneWhere,
  itemContentHash,
  jsonOf,
  type Row,
  type RunCtx,
  runItems,
  stageRunCard,
} from "./run-card"
import { addDays, datesFrom, daysInMonth, latestIssueOn, periodKey, periodStart, type Repeats } from "./schedule"
import { draftCandidates, type ScheduleLineInput, type ScheduleRow } from "./tools"

export interface DraftJobResult {
  status: "ok"
  drafted: number
  runs: string[]
  message: string
}

function periodEnd(repeats: Repeats, start: string): string {
  const [y, m] = start.split("-").map(Number) as [number, number]
  const endMonth = repeats === "year" ? 12 : repeats === "quarter" ? m + 2 : m
  return `${String(y).padStart(4, "0")}-${String(endMonth).padStart(2, "0")}-${String(daysInMonth(y, endMonth)).padStart(2, "0")}`
}

function dueOn(s: ScheduleRow, issueOn: string): string {
  if (s.due_rule === "on_issue") return issueOn
  if (s.due_rule === "days_n" && typeof s.due_days === "number") return addDays(issueOn, s.due_days)
  return addDays(issueOn, 30)
}

function isUniqueViolation(err: unknown): boolean {
  const text = `${(err as { code?: unknown })?.code ?? ""} ${(err as { message?: unknown })?.message ?? String(err)}`
  return /23505|unique|duplicate key/i.test(text)
}

/** Insert, or find what a concurrent run inserted first under the same unique key. */
async function insertOnce(ctx: RunCtx, entity: string, where: Row, data: Row): Promise<{ row: Row; created: boolean }> {
  const found = await findOneWhere(ctx, entity, where)
  if (found) return { row: found, created: false }
  try {
    const inserted = (await ctx.db.insert(entity, data)) as Row
    return { row: { ...data, ...inserted }, created: true }
  } catch (err) {
    if (!isUniqueViolation(err)) throw err
    const again = await findOneWhere(ctx, entity, where)
    if (!again) throw err
    return { row: again, created: false }
  }
}

/** Who the customer is on the draft: the snapshot of the schedule's last invoice to that contact. */
async function counterpartySnapshot(ctx: RunCtx, s: ScheduleRow): Promise<Row> {
  const last = s.last_document_id ? ((await ctx.db.findOne("documents", s.last_document_id)) as Row | null) : null
  const source =
    last ??
    ((await ctx.db.findMany("documents", { where: { counterparty_contact_id: s.contact_id, type: "invoice" }, orderBy: { createdAt: "desc" }, limit: 1 })) as Row[])[0] ??
    null
  if (source) {
    return {
      counterparty_name: source.counterparty_name ?? null,
      counterparty_address: source.counterparty_address ?? null,
      counterparty_country: source.counterparty_country ?? null,
      counterparty_vat_id: source.counterparty_vat_id ?? null,
      counterparty_email: source.counterparty_email ?? null,
      customer_kind: source.customer_kind ?? null,
    }
  }
  const snapshot: Row = { counterparty_name: null, counterparty_address: null, counterparty_country: null, counterparty_vat_id: null, counterparty_email: null }
  if (ctx.executeTool) {
    try {
      const env = await ctx.executeTool("kernel:contacts_read", { contactId: s.contact_id })
      if (env.status === "completed") {
        const c = ((env.result as { contact?: Row } | null)?.contact ?? {}) as Row
        snapshot.counterparty_name = c.name ?? c.displayName ?? null
        snapshot.counterparty_email = c.email ?? null
      }
    } catch {
      // An unreadable contact leaves the row to fix; the draft is still made.
    }
  }
  return snapshot
}

/** The previous invoice of the schedule, for the row's flags. */
async function previousInvoice(ctx: RunCtx, s: ScheduleRow): Promise<PreviousInvoice | null> {
  if (!s.last_document_id) return null
  const doc = (await ctx.db.findOne("documents", s.last_document_id)) as Row | null
  if (!doc) return null
  const lines = await draftLines(ctx, String(doc.id))
  const prevItem = await findOneWhere(ctx, "recurring_run_items", { document_id: String(doc.id) })
  return {
    period_key: prevItem ? String(prevItem.period_key) : null,
    net_minor: draftTotals(lines).net,
    lines_signature: linesSignature(lines),
    payment_status: (doc.payment_status as string | null) ?? null,
  }
}

function draftLineRows(lines: ScheduleLineInput[], label: string): Row[] {
  return lines.map((l, i) => {
    const price = BigInt(Number(l.unit_price_minor))
    const quantity = String(l.qty)
    const subtotal = lineSubtotal({ quantity, unit_price_minor: price })
    return {
      position: i + 1,
      description: String(l.description).split("{period}").join(label),
      quantity,
      unit_price_minor: price.toString(),
      discount_minor: "0",
      line_kind: l.line_kind ?? "service",
      tax_rate_bp: l.vat_bp,
      subtotal_minor: subtotal.toString(),
      tax_minor: "0",
      total_minor: subtotal.toString(),
      product_source: null,
      external_id: null,
    }
  })
}

/** Draft one schedule's period. Returns the run it joined, or null when it was already drafted. */
async function draftSchedule(ctx: RunCtx, s: ScheduleRow): Promise<{ runId: string; drafted: boolean } | null> {
  const issueOn = s.next_issue_on as string
  const key = periodKey(s.repeats, issueOn)
  const start = periodStart(s.repeats, issueOn)
  const end = periodEnd(s.repeats, start)
  const label = periodLabel(key)
  const externalRef = `recurring:${s.id}:${key}`
  const issuer = (await ctx.db.findOne("issuer_profiles", s.issuer_profile_id)) as Row | null
  if (!issuer) return null

  const run = await insertOnce(
    ctx,
    "recurring_runs",
    { issuer_profile_id: s.issuer_profile_id, issue_on: issueOn },
    { issuer_profile_id: s.issuer_profile_id, issue_on: issueOn, latest_issue_on: latestIssueOn(issueOn), status: "drafted", period_label: label, approval_request_id: null },
  )
  const runId = String(run.row.id)

  const counterparty = await counterpartySnapshot(ctx, s)
  const docRow: Row = {
    type: "invoice",
    status: "draft",
    counterparty_contact_id: s.contact_id,
    ...counterparty,
    issuer_profile_id: s.issuer_profile_id,
    currency: String(issuer.default_currency ?? "EUR"),
    incoterm: "DAP",
    due_at: dueOn(s, issueOn),
    external_ref: externalRef,
    external_refs: { recurring_schedule_id: s.id, period_key: key, period_start: start, period_end: end },
    notes: s.notes ?? null,
    lifecycle_log: [{ event: "drafted", actor: "recurring", ts: new Date().toISOString(), schedule_id: s.id, schedule_version: s.version, period_key: key }],
    subtotal_minor: "0",
    tax_total_minor: "0",
    grand_total_minor: "0",
    payment_status: "unpaid",
    number: null,
    number_int: null,
    year_of_issue: null,
    issued_at: null,
    operation_category: "services",
  }
  const draft = await insertOnce(ctx, "documents", { external_ref: externalRef }, docRow)
  const draftId = String(draft.row.id)
  if (draft.created) {
    for (const line of draftLineRows(s.lines, label)) await ctx.db.insert("document_lines", { ...line, document_id: draftId })
  }

  const lines = await draftLines(ctx, draftId)
  const totals = draftTotals(lines)
  const current: CurrentDraft = { net_minor: totals.net, lines_signature: linesSignature(lines) }
  const flags = runItemFlags(await previousInvoice(ctx, s), current)
  const missing = !counterparty.counterparty_name || !counterparty.counterparty_address
  const position = (await runItems(ctx, runId)).length + 1
  const item = await insertOnce(
    ctx,
    "recurring_run_items",
    { schedule_id: s.id, period_key: key },
    {
      run_id: runId,
      source: "schedule",
      schedule_id: s.id,
      schedule_version: s.version,
      period_key: key,
      period_start: start,
      period_end: end,
      document_id: draftId,
      position,
      state: missing ? "needs_fix" : "ready",
      note: [...flags, ...(missing ? ["No billing address"] : [])].join(" · "),
    },
  )
  const refs = jsonOf<Row>(draft.row.external_refs, {})
  if (refs.recurring_run_item_id !== item.row.id) {
    await ctx.db.update("documents", draftId, { external_refs: { ...refs, recurring_run_item_id: String(item.row.id), recurring_run_id: runId } })
  }
  // The schedule moves to its next period only from the period just drafted, so a second run of
  // the job finds it already moved and moves nothing.
  const next = datesFrom(s, addDays(issueOn, 1))
  const fresh = (await ctx.db.findOne("recurring_schedules", s.id)) as Row | null
  if (fresh && dayOf(fresh.next_issue_on) === issueOn) await ctx.db.update("recurring_schedules", s.id, { ...next })
  return { runId, drafted: item.created }
}

/** Auto-issue a run when every row comes from a schedule set to issue by itself and none is over the threshold. */
async function approveByItself(ctx: RunCtx, runId: string): Promise<boolean> {
  const run = (await ctx.db.findOne("recurring_runs", runId)) as Row | null
  if (!run || run.status !== "drafted" || run.approval_request_id) return false
  const issuer = (await ctx.db.findOne("issuer_profiles", String(run.issuer_profile_id))) as Row | null
  const threshold = issuer?.invoice_approval_threshold_minor
  const limit = threshold === null || threshold === undefined ? null : BigInt(String(threshold))
  const items = (await runItems(ctx, runId)).filter((i) => i.state !== "left_out" && i.state !== "issued")
  if (items.length === 0) return false
  let enabledBy: string | null = null
  const hashes: Array<[string, string]> = []
  for (const item of items) {
    if (item.state !== "ready") return false
    const s = (await ctx.db.findOne("recurring_schedules", String(item.schedule_id))) as Row | null
    if (!s || s.issue_mode !== "auto") return false
    enabledBy = (s.auto_enabled_by as string | null) ?? enabledBy
    const draft = (await ctx.db.findOne("documents", String(item.document_id))) as Row | null
    if (!draft) return false
    const lines = await draftLines(ctx, String(draft.id))
    if (limit !== null && draftTotals(lines).total > limit) return false
    hashes.push([String(item.id), itemContentHash(item, draft, lines)])
  }
  const claim = await ctx.db.updateMany("recurring_runs", {
    where: { issuer_profile_id: run.issuer_profile_id, issue_on: dayOf(run.issue_on), status: "drafted", approval_request_id: null },
    data: { status: "approved", auto: true, approved_by: enabledBy, approved_at: new Date().toISOString() },
  })
  if (claim.count !== 1) return false
  for (const [id, hash] of hashes) await ctx.db.update("recurring_run_items", id, { state: "approved", approved_hash: hash })
  return true
}

export async function recurringDraftJob(ctx: RunCtx): Promise<DraftJobResult> {
  const issuers = (await ctx.db.findMany("issuer_profiles", { limit: 200 })) as Row[]
  const runs = new Set<string>()
  let drafted = 0
  for (const issuer of issuers) {
    const today = await civilDateOf(ctx, issuer as { timezone?: string | null })
    if (!today.ok) continue
    const due = (await draftCandidates(ctx, today.date)).filter((s) => s.issuer_profile_id === issuer.id)
    for (const s of due) {
      const res = await draftSchedule(ctx, s)
      if (!res) continue
      runs.add(res.runId)
      if (res.drafted) drafted += 1
    }
  }
  if (drafted > 0) await endHold(ctx, "recurring-draft")
  for (const runId of runs) {
    if (await approveByItself(ctx, runId)) continue
    const run = (await ctx.db.findOne("recurring_runs", runId)) as Row | null
    if (!run || run.status !== "drafted") continue
    await stageRunCard(ctx, runId)
    if (ctx.emit) {
      await ctx.emit({ entity: "recurring_run", action: "drafted", entityId: runId, data: { run_id: runId, issue_on: dayOf(run.issue_on), period: run.period_label } })
    }
  }
  return {
    status: "ok",
    drafted,
    runs: [...runs],
    message: drafted === 0 ? "No schedule was due for a draft." : `Drafted ${drafted} invoice${drafted === 1 ? "" : "s"} in ${runs.size} run${runs.size === 1 ? "" : "s"}.`,
  }
}

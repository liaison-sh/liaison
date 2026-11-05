// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Received tab's tools (and the agent's): list and read the mirrored supplier e-invoices,
// refresh them from the platform now, and refuse / dispute / withdraw a dispute.
//
// Refusing or disputing a received invoice is a legal action sent to the supplier's platform, so
// it is never done on a click or an agent's word alone:
//   `received_einvoice_action_request` (agents and the UI) checks the action and the reason are
//   offered for this invoice now, then creates ONE approval request for the gated
//   `received_einvoice_set_status` (no auto-approval, no editable field, 24 h) and records it on
//   the invoice; nothing reaches the platform.
//   `received_einvoice_set_status` runs only when a person approved it: it re-reads the invoice
//   from the platform, refuses if the action is no longer offered (paid meanwhile, already
//   refused), sends it once, and records the outcome in the invoice's history.
import type { ReceivedActionOffer, ReceivedInvoice, ReceivedReason } from "@liaison/app-sdk/contracts"
import { RECEIVED_ACTION_STATUS } from "@liaison/app-sdk/contracts"
import { callProvider, fail, fileRows, ingestReceived, type ReceivedCtx, receivedCatchUp, rowFromProvider } from "./ingest"

type Row = Record<string, unknown>
type Action = "refuse" | "dispute" | "undispute"

export interface ReceivedToolCtx extends ReceivedCtx {
  getUserId?(): Promise<string> | string
  approval?: { approvalRequestId: string; approvalDeciderId: string; toolName: string } | null
  /** Whether this call's actor holds one of invoicing's own scopes. */
  callerHasScope?(scope: string): unknown
  /** The kernel's live state of an approval request this app created: JSON `{status, expired}`. */
  approvals?: { statusOf(approvalRequestId: string): Promise<unknown> }
  requestApproval?(input: {
    tool_name: string
    summary: string
    summary_detail?: { subtitle?: string; lines?: string[] }
    current_payload: unknown
    editable_fields?: string[]
    /** `auto_approved: true`: granted inline (a person's own call holding the deciding scope; no
     *  approval row) or approved by an org policy, so the action runs now. */
  }): Promise<{ approval_id: string; auto_approved?: undefined } | { approval_id: string | null; auto_approved: true }>
}

const ACTIONS: readonly Action[] = ["refuse", "dispute", "undispute"]
const PENDING_TTL_MS = 24 * 3600 * 1000
const STATUSES = ["received", "approved", "in_dispute", "refused", "rejected", "partially_collected", "collected"]

function str(v: unknown): string | null {
  if (typeof v !== "string") return null
  const t = v.trim()
  return t === "" ? null : t
}

async function getRow(ctx: ReceivedCtx, id: string | null): Promise<Row | null> {
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return null
  const rows = (await ctx.db.findMany("received_einvoices", { where: { id }, limit: 1 })) as Row[]
  return rows[0] ?? null
}

function offers(row: Row): ReceivedActionOffer[] {
  return Array.isArray(row.actions) ? (row.actions as ReceivedActionOffer[]) : []
}

function pendingOf(row: Row): Row | null {
  const p = row.pending_action as Row | null | undefined
  if (!p || typeof p !== "object") return null
  const at = str(p.requested_at)
  return at && Date.now() - Date.parse(at) < PENDING_TTL_MS ? p : null
}

/**
 * May the caller refresh and ask for a refusal / dispute (`invoicing:received:write`)? Read tools
 * answer it so the tab offers only what the person can do. When the kernel cannot say, the
 * actions are shown and the tool itself still refuses on click.
 */
async function canAct(ctx: ReceivedToolCtx): Promise<boolean> {
  if (!ctx.callerHasScope) return true
  try {
    const v = await ctx.callerHasScope("invoicing:received:write")
    return v === true || v === "true"
  } catch {
    return true
  }
}

/** An approval that will never run: the recorded request no longer blocks anything. */
const CLOSED_APPROVAL = new Set(["denied", "expired", "cancelled", "withdrawn"])

/**
 * The pending request recorded on the row, if its approval can still run. A denied, expired,
 * cancelled or withdrawn approval clears it (the kernel is asked; when it cannot answer, the
 * recorded request stands until its 24 h deadline).
 */
async function livePending(ctx: ReceivedToolCtx, row: Row): Promise<Row | null> {
  const p = pendingOf(row)
  if (!p) return null
  const id = str(p.approval_id)
  if (!id || !ctx.approvals?.statusOf) return p
  try {
    const raw = await ctx.approvals.statusOf(id)
    const s = (typeof raw === "string" ? JSON.parse(raw) : raw) as { status?: unknown; expired?: unknown } | null
    // `status: null`: no such approval of this app (never created, or gone); `expired`: past its
    // deadline before the sweep reached it.
    if (!s || s.status === null || s.expired === true) return null
    return typeof s.status === "string" && CLOSED_APPROVAL.has(s.status) ? null : p
  } catch (e) {
    ctx.logger?.warn?.("approval state unreadable", { approval_id: id, err: e instanceof Error ? e.message : String(e) })
    return p
  }
}

/** The action and reason, checked against what the platform offered at the last read. */
function validate(row: Row, action: unknown, reason: unknown): { action: Action; reason: ReceivedReason | null } | ReturnType<typeof fail> {
  if (!ACTIONS.includes(action as Action)) return fail("invalid_input", 'action is "refuse", "dispute" or "undispute"')
  const a = action as Action
  const offer = offers(row).find((o) => o.action === a)
  if (!offer) {
    return fail(
      "received_action_not_allowed",
      `This invoice cannot be ${a === "refuse" ? "refused" : a === "dispute" ? "disputed" : "taken out of dispute"} now (status ${String(row.status)}${row.payment_linked ? ", a payment is linked" : ""}).`,
      { offered: offers(row).map((o) => o.action) },
    )
  }
  if (a === "undispute") return { action: a, reason: null }
  const r = offer.reasons.find((x) => x.reason === reason)
  if (!r) {
    return fail("received_reason_invalid", `Pick one of the platform's reasons to ${a}.`, {
      reasons: offer.reasons.map((x) => ({ reason: x.reason, label: x.label_en, code: x.afnor_code })),
    })
  }
  return { action: a, reason: r }
}

function money(v: unknown, currency: unknown): string {
  return v === null || v === undefined ? "-" : `${String(v)} ${String(currency ?? "")}`.trim()
}

const VERB: Record<Action, string> = { refuse: "Refuse", dispute: "Dispute", undispute: "Withdraw the dispute on" }

// ---------------------------------------------------------------------------------------------
// Reads.

export async function receivedList(ctx: ReceivedToolCtx, p: { status?: string; limit?: number; offset?: number } = {}) {
  const status = str(p?.status)
  if (status && !STATUSES.includes(status)) return fail("invalid_input", `status is one of ${STATUSES.join(", ")}`)
  const limit = Math.min(Math.max(Number(p?.limit) || 50, 1), 200)
  const offset = Math.max(Number(p?.offset) || 0, 0)
  const rows = (await ctx.db.findMany("received_einvoices", {
    ...(status ? { where: { status } } : {}),
    orderBy: { received_at: "desc" },
    limit: limit + 1,
    offset,
  })) as Row[]
  const state = ((await ctx.db.findMany("received_sync_state", { limit: 1 })) as Row[])[0]
  const page = rows.slice(0, limit)
  const awaiting = await Promise.all(page.map(async (r) => ((await livePending(ctx, r))?.action as string | undefined) ?? null))
  return {
    status: "ok",
    items: page.map((r, i) => ({
      id: r.id,
      supplier_name: r.supplier_name ?? null,
      invoice_number: r.invoice_number ?? null,
      issue_date: r.issue_date ?? null,
      due_date: r.due_date ?? null,
      total: r.total ?? null,
      currency: r.currency ?? null,
      status: r.status,
      status_code: r.status_code ?? null,
      received_at: r.received_at ?? null,
      totals_mismatch: Array.isArray(r.totals_mismatch) && (r.totals_mismatch as unknown[]).length > 0,
      awaiting_approval: awaiting[i] ?? null,
    })),
    has_more: rows.length > limit,
    last_refreshed_at: state?.last_catch_up_at ?? null,
    can_act: await canAct(ctx),
  }
}

export async function receivedGet(ctx: ReceivedToolCtx, p: { received_id?: string }) {
  const row = await getRow(ctx, str(p?.received_id))
  if (!row) return fail("not_found", "No received invoice with this id.")
  const files = (await fileRows(ctx.db, String(row.id))).map((f) => ({
    kind: f.kind,
    file_id: f.file_id ?? null,
    filename: f.filename ?? null,
    mime_type: f.mime_type ?? null,
    byte_size: f.byte_size ?? null,
    sha256: f.sha256 ?? null,
    url: f.file_id ? `/api/files/${String(f.file_id)}/inline` : null,
  }))
  const parsed = (row.parsed ?? null) as Row | null
  return {
    status: "ok",
    invoice: {
      id: row.id,
      provider_app: row.provider_app,
      supplier: { name: row.supplier_name ?? null, siren: row.supplier_siren ?? null, vat_id: row.supplier_vat_id ?? null },
      invoice_number: row.invoice_number ?? null,
      issue_date: row.issue_date ?? null,
      due_date: row.due_date ?? null,
      currency: row.currency ?? null,
      totals: { before_tax: row.total_before_tax ?? null, tax: row.total_tax ?? null, total: row.total ?? null },
      file_facts: row.parse_status === "parsed" && parsed ? { totals: parsed.totals ?? null, invoice_number: parsed.invoice_number ?? null, seller: parsed.seller ?? null } : null,
      totals_mismatch: Array.isArray(row.totals_mismatch) ? row.totals_mismatch : [],
      parse_status: row.parse_status ?? null,
      status: row.status,
      status_code: row.status_code ?? null,
      status_reason: row.status_reason ?? null,
      payment_linked: row.payment_linked === true,
      received_at: row.received_at ?? null,
      last_synced_at: row.last_synced_at ?? null,
      files_pending: row.files_pending === true,
    },
    files,
    history: (Array.isArray(row.lifecycle_log) ? (row.lifecycle_log as Row[]) : []).filter((e) => !e.ignored),
    actions: offers(row),
    pending_action: await livePending(ctx, row),
    can_act: await canAct(ctx),
  }
}

/** Refresh now: one invoice (re-read), or everything (the catch-up). */
export async function receivedRefresh(ctx: ReceivedCtx, p: { received_id?: string } = {}) {
  const id = str(p?.received_id)
  if (id) {
    const row = await getRow(ctx, id)
    if (!row) return fail("not_found", "No received invoice with this id.")
    const r = await ingestReceived(ctx, String(row.provider_ref), "refresh")
    if ("status" in r) return r
    return { status: "ok", refreshed: 1, files_pending: r.files_pending }
  }
  const out = await receivedCatchUp(ctx, { reread: 50 })
  if (out.skipped) return fail(out.skipped, "No e-invoicing platform with reception is configured for this organisation.")
  return { status: "ok", ...out }
}

// ---------------------------------------------------------------------------------------------
// Actions.

export async function receivedActionRequest(ctx: ReceivedToolCtx, p: { received_id?: string; action?: string; reason?: string | null; comment?: string | null }) {
  const row = await getRow(ctx, str(p?.received_id))
  if (!row) return fail("not_found", "No received invoice with this id.")
  const v = validate(row, p?.action, p?.reason)
  if ("status" in v) return v
  const pending = await livePending(ctx, row)
  if (!pending && row.pending_action) {
    // The recorded request was denied, expired or cancelled: it no longer blocks a new one.
    await ctx.db.update("received_einvoices", String(row.id), { pending_action: null })
  }
  if (pending) {
    if (pending.action === v.action && (pending.reason ?? null) === (v.reason?.reason ?? null)) {
      return { status: "staged", approval_id: pending.approval_id, deduped: true }
    }
    return fail("received_action_pending", `A request to ${String(pending.action)} this invoice already awaits approval.`, { pending })
  }
  if (!ctx.requestApproval) return fail("approval_unavailable", "Approval requests cannot be created from this context.")
  const comment = str(p?.comment)?.slice(0, 500) ?? null
  const payload = { received_id: String(row.id), action: v.action, reason: v.reason?.reason ?? null, comment }
  const number = String(row.invoice_number ?? "without a number")
  const supplier = String(row.supplier_name ?? "the supplier")
  const lines = [
    `Supplier: ${supplier}${row.supplier_siren ? ` (SIREN ${String(row.supplier_siren)})` : ""}`,
    `Invoice ${number} of ${String(row.issue_date ?? "-")}, total ${money(row.total, row.currency)}`,
    ...(v.reason ? [`Reason: ${v.reason.label_en} (official code ${v.reason.afnor_code})`] : []),
    ...(comment ? [`Comment kept in Liaison: ${comment}`] : []),
    v.action === "refuse"
      ? "A refusal is final: the supplier's platform is told and the invoice is closed."
      : v.action === "dispute"
        ? "The supplier's platform is told the invoice is disputed; the dispute can be withdrawn later."
        : "The supplier's platform is told the dispute is over.",
  ]
  const approval = await ctx.requestApproval({
    tool_name: "invoicing:received_einvoice_set_status",
    summary: `${VERB[v.action]} supplier invoice ${number} from ${supplier}`,
    summary_detail: { subtitle: "Sent to the supplier's e-invoicing platform once approved.", lines },
    current_payload: payload,
    editable_fields: [],
  })
  // A person's own request, made by someone who may decide it: approvals are for agents, so
  // nothing was parked and the action runs now on their authority (it re-reads the platform first).
  if (approval.auto_approved) return receivedSetStatus(ctx, payload)
  const approval_id = approval.approval_id
  const by = ctx.getUserId ? await ctx.getUserId() : null
  await ctx.db.update("received_einvoices", String(row.id), {
    pending_action: { ...payload, approval_id, requested_at: new Date().toISOString(), requested_by: by },
  })
  return { status: "staged", approval_id, deduped: false }
}

/** Stage-time check of the gated tool (the platform is re-read at execution). */
export async function receivedSetStatusPreflight(ctx: ReceivedCtx, p: { received_id?: string; action?: string; reason?: string | null }) {
  const row = await getRow(ctx, str(p?.received_id))
  if (!row) return fail("not_found", "No received invoice with this id.")
  const v = validate(row, p?.action, p?.reason)
  return "status" in v ? v : { ok: true }
}

/** The gated action: runs once a person approved it. */
export async function receivedSetStatus(ctx: ReceivedToolCtx, p: { received_id?: string; action?: string; reason?: string | null; comment?: string | null }) {
  const row = await getRow(ctx, str(p?.received_id))
  if (!row) return fail("not_found", "No received invoice with this id.")
  // Re-read the platform first: a payment linked or a refusal since the request ends it here.
  const fresh = await callProvider(ctx, "get_received", { provider_ref: String(row.provider_ref) })
  if (!fresh.ok) return fail(fresh.error.code, fresh.error.message, fresh.error.detail)
  const before = rowFromProvider(fresh.result as unknown as ReceivedInvoice, row, "refresh")
  await ctx.db.update("received_einvoices", String(row.id), before)
  const current = { ...row, ...before }
  const v = validate(current, p?.action, p?.reason)
  if ("status" in v) {
    await ctx.db.update("received_einvoices", String(row.id), { pending_action: null })
    return v
  }
  const res = await callProvider(ctx, "set_received_status", {
    provider_ref: String(row.provider_ref),
    status: RECEIVED_ACTION_STATUS[v.action],
    reason: v.reason?.reason ?? null,
    comment: str(p?.comment),
  })
  const by = ctx.approval?.approvalDeciderId ?? (ctx.getUserId ? await ctx.getUserId() : null)
  const entry = {
    source: "action",
    action: v.action,
    reason: v.reason?.reason ?? null,
    reason_label: v.reason?.label_en ?? null,
    reason_label_fr: v.reason?.label_fr ?? null,
    code: v.reason?.afnor_code ?? null,
    comment: str(p?.comment),
    by,
    approval_request_id: ctx.approval?.approvalRequestId ?? null,
    observed_at: new Date().toISOString(),
    outcome: res.ok ? "sent" : "refused_by_platform",
    ...(res.ok ? {} : { error: { code: res.error.code, message: String(res.error.message).slice(0, 300) } }),
  }
  if (!res.ok) {
    const log = Array.isArray(current.lifecycle_log) ? [...(current.lifecycle_log as Row[]), entry] : [entry]
    await ctx.db.update("received_einvoices", String(row.id), { pending_action: null, lifecycle_log: log })
    return fail(res.error.code, res.error.message, res.error.detail)
  }
  const withEntry = { ...current, lifecycle_log: [...(Array.isArray(current.lifecycle_log) ? (current.lifecycle_log as Row[]) : []), entry] }
  const after = rowFromProvider(res.result as unknown as ReceivedInvoice, withEntry, "action")
  await ctx.db.update("received_einvoices", String(row.id), { ...after, pending_action: null })
  return { status: "ok", received_id: String(row.id), state: after.status, code: after.status_code }
}

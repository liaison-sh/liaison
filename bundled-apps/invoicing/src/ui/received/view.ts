// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Received tab's view model (pure): plain-word statuses with their official code, the list's
// filters, the detail's facts, history and the actions that make sense now. Charter: no raw JSON,
// no provider id as a label, never a status code without its words, never an action on a status
// that forbids it, the supplier's XML never rendered (it is only downloadable).
import { tr, uiLocale } from "../i18n"

export type ReceivedStatus =
  | "received"
  | "approved"
  | "in_dispute"
  | "refused"
  | "rejected"
  | "partially_collected"
  | "collected"

export const STATUS_LABEL: Record<ReceivedStatus, string> = {
  received: "Received",
  approved: "Approved",
  in_dispute: "In dispute",
  refused: "Refused",
  rejected: "Rejected by the platform",
  partially_collected: "Partly paid",
  collected: "Paid",
}

export const FILTERS: Array<{ value: ReceivedStatus | "all"; label: string }> = [
  { value: "all", label: "All" },
  { value: "received", label: "Received" },
  { value: "in_dispute", label: "In dispute" },
  { value: "approved", label: "Approved" },
  { value: "refused", label: "Refused" },
  { value: "rejected", label: "Rejected" },
  { value: "partially_collected", label: "Partly paid" },
  { value: "collected", label: "Paid" },
]

export const EMPTY_TEXT =
  "No supplier e-invoice yet. Invoices your suppliers send to the organisation through the e-invoicing platform appear here by themselves, within minutes of their arrival (every 3 hours at the latest). Refresh checks now."

export interface ReceivedListItem {
  id: string
  supplier_name: string | null
  invoice_number: string | null
  issue_date: string | null
  due_date: string | null
  total: string | null
  currency: string | null
  status: ReceivedStatus
  status_code: number | null
  received_at: string | null
  totals_mismatch?: boolean
  awaiting_approval?: string | null
}

/** "Refused (210)" — the words always, the official code when there is one. */
export function statusText(status: string, code: number | null | undefined): string {
  const words = tr(STATUS_LABEL[status as ReceivedStatus] ?? "Received")
  return code ? `${words} (${code})` : words
}

/** A decimal amount for display: grouped, two decimals (the currency beside it). */
export function formatAmount(v: string | null | undefined): string {
  if (v === null || v === undefined || v === "") return "-"
  const n = Number(v)
  if (!Number.isFinite(n)) return "-"
  const sign = n < 0 ? "-" : ""
  const [int, dec] = Math.abs(n).toFixed(2).split(".")
  return `${sign}${(int ?? "0").replace(/\B(?=(\d{3})+(?!\d))/g, " ")}.${dec}`
}

export function shortDate(v: string | null | undefined): string {
  return v ? String(v).slice(0, 10) : "-"
}

/** A moment in the reader's local time and language ("15/10/2026 14:05"), never a UTC slice. */
export function localDateTime(v: string | null | undefined, timeZone?: string): string {
  if (!v) return "-"
  const d = new Date(String(v))
  if (Number.isNaN(d.getTime())) return String(v).slice(0, 16).replace("T", " ")
  try {
    return d.toLocaleString(uiLocale().startsWith("fr") ? "fr-FR" : "en-GB", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      ...(timeZone ? { timeZone } : {}),
    })
  } catch {
    return String(v).slice(0, 16).replace("T", " ")
  }
}

export interface ListRow {
  id: string
  supplier: string
  number: string
  issued: string
  due: string
  total: string
  currency: string
  status: string
  received: string
  note: string | null
}

export function listRows(items: ReceivedListItem[]): ListRow[] {
  return items.map((i) => ({
    id: i.id,
    supplier: i.supplier_name ?? tr("Unknown supplier"),
    number: i.invoice_number ?? tr("No number"),
    issued: shortDate(i.issue_date),
    due: shortDate(i.due_date),
    total: formatAmount(i.total),
    currency: i.currency ?? "",
    status: statusText(i.status, i.status_code),
    received: shortDate(i.received_at),
    note: i.awaiting_approval
      ? tr(ACTION_PENDING[i.awaiting_approval] ?? "A decision awaits approval")
      : i.totals_mismatch
        ? tr("The file's totals differ")
        : null,
  }))
}

// ---------------------------------------------------------------------------------------------
// Detail.

export interface ReceivedReason {
  reason: string
  afnor_code: string
  label_en: string
  label_fr: string
}

export interface ReceivedOffer {
  action: "refuse" | "dispute" | "undispute"
  reasons: ReceivedReason[]
}

export interface HistoryEntry {
  raw?: string | null
  mapped?: string | null
  code?: number | string | null
  provider_ts?: string | null
  observed_at: string
  source: string
  reason_text?: string | null
  action?: string
  reason?: string | null
  reason_label?: string | null
  reason_label_fr?: string | null
  comment?: string | null
  outcome?: string
}

export interface ReceivedFile {
  kind: "original" | "rendering"
  file_id: string | null
  filename: string | null
  mime_type: string | null
  byte_size: number | string | null
  sha256: string | null
  url: string | null
}

export interface ReceivedDetailData {
  status: string
  invoice: {
    id: string
    supplier: { name: string | null; siren: string | null; vat_id: string | null }
    invoice_number: string | null
    issue_date: string | null
    due_date: string | null
    currency: string | null
    totals: { before_tax: string | null; tax: string | null; total: string | null }
    file_facts: {
      totals: { before_tax: string | null; tax: string | null; total: string | null } | null
    } | null
    totals_mismatch: string[]
    parse_status: string | null
    status: ReceivedStatus
    status_code: number | null
    status_reason: string | null
    payment_linked: boolean
    received_at: string | null
    last_synced_at: string | null
    files_pending: boolean
  }
  files: ReceivedFile[]
  history: HistoryEntry[]
  actions: ReceivedOffer[]
  pending_action: { action: string; reason: string | null; requested_at: string } | null
  /** May the reader refresh and ask for a refusal / dispute (absent: assumed yes). */
  can_act?: boolean
}

const ACTION_LABEL: Record<string, string> = {
  refuse: "Refuse",
  dispute: "Dispute",
  undispute: "Withdraw the dispute",
}

const ACTION_PENDING: Record<string, string> = {
  refuse: "Refusal awaiting approval",
  dispute: "Dispute awaiting approval",
  undispute: "Dispute withdrawal awaiting approval",
}

const ACTION_DONE: Record<string, string> = {
  refuse: "Refusal sent",
  dispute: "Dispute sent",
  undispute: "Dispute withdrawn",
}

export function reasonLabel(r: ReceivedReason): string {
  return uiLocale().startsWith("fr") ? r.label_fr : r.label_en
}

export interface DetailView {
  title: string
  status: string
  statusNote: string | null
  facts: Array<{ label: string; value: string; testid: string }>
  totals: Array<{ label: string; value: string; file: string | null; testid: string }>
  mismatch: boolean
  files: Array<{
    kind: string
    label: string
    previewable: boolean
    file_id: string
    filename: string
    testid: string
  }>
  filesNote: string | null
  timeline: Array<{ at: string; text: string }>
  actions: Array<{
    action: string
    label: string
    reasons: Array<{ value: string; label: string; code: string }>
    needsReason: boolean
  }>
  pending: string | null
  noActionWhy: string | null
  canAct: boolean
}

/**
 * A reason in the reader's language: the words recorded with the entry, else the words of the
 * platform's offered reason with that slug, else (a status entry) the platform's own text.
 */
function historyReason(e: HistoryEntry, offers: ReceivedOffer[]): string | null {
  const fr = uiLocale().startsWith("fr")
  const recorded = fr ? e.reason_label_fr : e.reason_label
  if (recorded) return recorded
  const slug = e.reason ?? e.reason_text ?? null
  const offered = slug ? offers.flatMap((o) => o.reasons).find((r) => r.reason === slug) : undefined
  if (offered) return fr ? offered.label_fr : offered.label_en
  return e.reason_label ?? e.reason_label_fr ?? (e.action ? null : (e.reason_text ?? null))
}

/** The current status's reason, in words when the history or the offers know its slug. */
function statusReason(reason: string, d: ReceivedDetailData): string {
  const entry = [...d.history].reverse().find((e) => !e.action && e.reason_text === reason)
  return (
    (entry
      ? historyReason(entry, d.actions)
      : historyReason({ observed_at: "", source: "", reason_text: reason }, d.actions)) ?? reason
  )
}

export function detailView(d: ReceivedDetailData, opts: { timeZone?: string } = {}): DetailView {
  const inv = d.invoice
  const canAct = d.can_act !== false
  const cur = inv.currency ?? ""
  const money = (v: string | null) => (v === null ? "-" : `${formatAmount(v)} ${cur}`.trim())
  const fileTotals = inv.file_facts?.totals ?? null
  const differs = new Set(inv.totals_mismatch ?? [])
  const totals = (
    [
      ["before_tax", "Total excluding tax"],
      ["tax", "VAT"],
      ["total", "Total including tax"],
    ] as const
  ).map(([k, label]) => ({
    label: tr(label),
    value: money(inv.totals[k]),
    file: differs.has(k) && fileTotals ? money(fileTotals[k]) : null,
    testid: `received-total-${k}`,
  }))
  const files = d.files
    .filter((f) => f.file_id)
    .map((f) => {
      const isPdf = /pdf/i.test(f.mime_type ?? "") || /\.pdf$/i.test(f.filename ?? "")
      return {
        kind: f.kind,
        label: f.kind === "original" ? tr("Original as received") : tr("Platform's PDF"),
        // Only a PDF is previewed; an XML original is downloaded, never rendered.
        previewable: isPdf,
        file_id: f.file_id as string,
        filename: f.filename ?? `${inv.invoice_number ?? "invoice"}${isPdf ? ".pdf" : ".xml"}`,
        testid: `received-file-${f.kind}`,
      }
    })
  const timeline = d.history.map((e) => {
    const at = localDateTime(e.provider_ts ?? e.observed_at ?? null, opts.timeZone)
    if (e.action) {
      const what = tr(
        e.outcome === "sent"
          ? (ACTION_DONE[e.action ?? ""] ?? "Decision sent")
          : "The platform did not accept the decision",
      )
      const why = historyReason(e, d.actions)
      return { at, text: why ? tr("{{what}}: {{why}}", { what, why }) : what }
    }
    const words = statusText(e.mapped ?? "received", typeof e.code === "number" ? e.code : null)
    const why = historyReason(e, d.actions)
    return { at, text: why ? tr("{{what}}: {{why}}", { what: words, why }) : words }
  })
  const pending = d.pending_action
    ? tr(ACTION_PENDING[d.pending_action.action] ?? "A decision awaits approval")
    : null
  const offered = d.actions.length > 0
  const actions =
    pending || !canAct
      ? []
      : d.actions.map((a) => ({
          action: a.action,
          label: tr(ACTION_LABEL[a.action] ?? a.action),
          reasons: a.reasons.map((r) => ({
            value: r.reason,
            label: reasonLabel(r),
            code: r.afnor_code,
          })),
          needsReason: a.action !== "undispute",
        }))
  let noActionWhy: string | null = null
  if (!pending && actions.length === 0) {
    if (offered && !canAct)
      noActionWhy = tr(
        "Refusing or disputing this invoice needs the permission to act on received invoices.",
      )
    else if (inv.status === "refused")
      noActionWhy = tr("This invoice was refused: nothing more can be done with it here.")
    else if (inv.status === "rejected")
      noActionWhy = tr("The platform rejected this invoice: nothing more can be done with it here.")
    else if (inv.payment_linked)
      noActionWhy = tr(
        "A payment is linked to this invoice, so it can no longer be refused or disputed.",
      )
    else noActionWhy = tr("The platform offers no action on this invoice now.")
  }
  return {
    title: `${inv.supplier.name ?? tr("Unknown supplier")} · ${inv.invoice_number ?? tr("No number")}`,
    status: statusText(inv.status, inv.status_code),
    statusNote: inv.status_reason
      ? tr("Reason given: {{reason}}", { reason: statusReason(inv.status_reason, d) })
      : null,
    facts: [
      { label: tr("Supplier"), value: inv.supplier.name ?? "-", testid: "received-fact-supplier" },
      { label: tr("SIREN"), value: inv.supplier.siren ?? "-", testid: "received-fact-siren" },
      { label: tr("VAT number"), value: inv.supplier.vat_id ?? "-", testid: "received-fact-vat" },
      {
        label: tr("Invoice number"),
        value: inv.invoice_number ?? "-",
        testid: "received-fact-number",
      },
      { label: tr("Issue date"), value: shortDate(inv.issue_date), testid: "received-fact-issued" },
      { label: tr("Due date"), value: shortDate(inv.due_date), testid: "received-fact-due" },
      {
        label: tr("Received"),
        value: shortDate(inv.received_at),
        testid: "received-fact-received",
      },
    ],
    totals,
    mismatch: differs.size > 0,
    files,
    filesNote: inv.files_pending
      ? tr("A file could not be fetched from the platform yet; it is retried on the next refresh.")
      : null,
    timeline,
    actions,
    pending,
    noActionWhy,
    canAct,
  }
}

/** The confirmation text for an action, in plain words. */
export function confirmText(action: string, reasonLabelText: string | null): string {
  const lines = [
    action === "refuse"
      ? tr(
          "A refusal is final: once sent, the supplier's platform is told and the invoice is closed.",
        )
      : action === "dispute"
        ? tr(
            "Once sent, the supplier's platform is told the invoice is disputed. The dispute can be withdrawn later.",
          )
        : tr("Once sent, the supplier's platform is told the dispute is over."),
  ]
  if (reasonLabelText) lines.push(tr("Reason: {{reason}}", { reason: reasonLabelText }))
  // Approvals are for agents: a person's own request runs on the permission to
  // act on received invoices (the one that shows this button), so it is sent at
  // once, never parked for someone else.
  lines.push(tr("This is sent to the supplier's platform now."))
  return lines.join("\n")
}

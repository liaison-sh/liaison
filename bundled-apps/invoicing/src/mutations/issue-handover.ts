// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The hand-over of a draft to the document that replaces it at issue. Issuing never turns a draft
// row into the invoice: it inserts a new, numbered row and deletes the draft in the same commit.
// Everything the draft says about its source must cross over in that commit, or the invoice
// loses its project (margin), its dedupe key (one live document per source) and the rows that
// hang off it (activity report, annexes, billing step, advance deduction).
//
// One helper does it for every path that issues a draft (invoice_issue, a month-end run's draft,
// a quote, proforma or purchase order draft, and several documents issued together), so no path
// carries the key without clearing it first (a unique violation), and none deletes the draft
// before the rows that point at it moved (the foreign keys are `restrict`, so the whole issue
// fails and no number is used).

import type { CrossAppExecuteTool } from "../cross-app"
import { sha256Hex } from "../einvoicing/backfill-sha256"
import type { IssueBatchOp, IssueInput, SourceColumns } from "../issue"
import { utf8Bytes } from "../legal-originals/bytes"
import type { ErrorEnvelope } from "./shared"

/** The keys a billing source gives its draft (`documents.external_ref`). */
export const BILLING_KEY_PREFIXES = ["reconcile:", "milestone:", "advance:", "retainer:"] as const

/**
 * The rows that point at a draft and follow it to the issued document, each a `restrict`
 * reference to `documents`. Re-pointed BEFORE the draft's delete in the issue commit.
 */
export const DRAFT_DEPENDENTS: ReadonlyArray<{ table: string; column: string }> = [
  { table: "activity_reports", column: "document_id" },
  { table: "document_attachments", column: "document_id" },
  { table: "billing_steps", column: "document_id" },
  { table: "advance_deductions", column: "final_document_id" },
]

const ONE_ROW = { minRows: 1, maxRows: 1 }

interface KeyedDraft {
  id: string
  external_ref?: string | null
  external_refs?: Record<string, unknown> | null
}

/** The draft's billing key, when it has one of the billing prefixes. */
export function billingKeyOf(draft: { external_ref?: string | null }): string | null {
  const ref = draft.external_ref
  if (typeof ref !== "string" || ref === "") return null
  return BILLING_KEY_PREFIXES.some((p) => ref.startsWith(p)) ? ref : null
}

/**
 * The reconciliation a draft bills, when a planned vs done card made it: a `reconcile:<id>:<rev>`
 * key, or a retainer month's draft carrying `external_refs.reconciliation_id`. A month-end run's
 * `recurring:` draft has none.
 */
export function reconciliationOf(draft: {
  external_ref?: string | null
  external_refs?: Record<string, unknown> | null
}): { id: string; revision: number | null } | null {
  const ref = draft.external_ref
  if (typeof ref === "string" && ref.startsWith("reconcile:")) {
    const [, id, rev] = ref.split(":")
    if (id) {
      const revision = rev !== undefined && /^\d+$/.test(rev) ? Number(rev) : null
      return { id, revision }
    }
  }
  let refs = draft.external_refs as unknown
  if (typeof refs === "string") {
    try {
      refs = JSON.parse(refs)
    } catch {
      refs = null
    }
  }
  const r = (refs ?? null) as Record<string, unknown> | null
  const linked = r?.reconciliation_id
  if (typeof linked === "string" && linked !== "") {
    const rev = r?.reconciliation_revision
    return { id: linked, revision: typeof rev === "number" ? rev : null }
  }
  return null
}

/**
 * The issue input for a draft, handed over: the draft's key (or the one the caller names, a
 * month-end run's period key) moves to the new document, cleared on the draft first; the rows
 * that point at the draft move to the new document; then the draft is deleted; then the caller's
 * own writes. All in the one commit that takes the number.
 */
export function handOverDraft(
  draft: KeyedDraft,
  input: IssueInput,
  opts: { externalRef?: string | null; commitWith?: IssueBatchOp[] } = {},
): IssueInput {
  const key = opts.externalRef ?? billingKeyOf(draft)
  const repoints: IssueBatchOp[] = DRAFT_DEPENDENTS.map(({ table, column }) => ({
    updateMany: table,
    where: { [column]: draft.id },
    data: { [column]: { $ref: "document" } },
  }))
  return {
    ...input,
    ...(key ? { external_ref: key } : {}),
    commit_before: [
      ...(input.commit_before ?? []),
      // Exactly one row each: a draft discarded (Undo, the invoicing list) or issued elsewhere
      // after the checks fails this commit, so no invoice exists for claims already released.
      ...(key
        ? [{ update: "documents", id: draft.id, data: { external_ref: null }, expect: ONE_ROW }]
        : []),
    ],
    commit_with: [
      ...(input.commit_with ?? []),
      ...repoints,
      { delete: "documents", id: draft.id, expect: ONE_ROW },
      ...(opts.commitWith ?? []),
    ],
  }
}

/**
 * What an invoice converted from a quote or proforma keeps of it: the project it bills and the
 * service period. The approval, the plan role and the key stay with the source document.
 */
export function convertedSource(source: SourceColumns | undefined): SourceColumns {
  return {
    billing_project_id: source?.billing_project_id ?? null,
    service_period_start: source?.service_period_start ?? null,
    service_period_end: source?.service_period_end ?? null,
  }
}

/**
 * The lines of a draft made from a planned vs done card are the card's: changed on the card, never
 * in the editor or by drafts_update. Its due date and the rest stay editable. A month-end run's
 * draft is not linked and stays editable by design.
 */
export function cardLinesLockedError(draft: {
  id: string
  external_ref?: string | null
  external_refs?: Record<string, unknown> | null
}): ErrorEnvelope | null {
  if (!reconciliationOf(draft)) return null
  return {
    status: "error",
    error: {
      code: "from_reconcile_change_on_card",
      message: `The lines of draft ${draft.id} come from its planned vs done card and were not changed. Change them on the card (Undo, edit the lines, create again); the due date and notes can be edited here.`,
    },
  }
}

const DEDUCTION_PREFIX = "advance_deduction:"

const lockedError = (draftId: string, what: string, next: string): ErrorEnvelope => ({
  status: "error",
  error: {
    code: "billing_draft_locked",
    message: `${what} of draft ${draftId} come from its billing source and were not changed. ${next}`,
  },
})

/**
 * The header a billing draft (a card, a billing step, an advance, a retainer month) keeps: its
 * currency and type (the lines are priced and claimed in them; a quote never issues, so its claims
 * would stay reserved), and its link to the reconciliation it bills. Restating a value is no change.
 */
export function billingDraftHeaderLockedError(
  draft: {
    id: string
    type?: unknown
    currency?: unknown
    external_ref?: string | null
    external_refs?: Record<string, unknown> | null
  },
  patch: Record<string, unknown>,
): ErrorEnvelope | null {
  if (!billingKeyOf(draft) && !reconciliationOf(draft)) return null
  const changed: string[] = []
  for (const k of ["currency", "type"] as const) {
    if (k in patch && patch[k] !== undefined && String(patch[k]) !== String(draft[k] ?? ""))
      changed.push(k)
  }
  if ("external_refs" in patch && patch.external_refs !== undefined) {
    const next = (patch.external_refs ?? {}) as Record<string, unknown>
    const was = draft.external_refs ?? {}
    for (const k of ["reconciliation_id", "reconciliation_revision"]) {
      if ((next[k] ?? null) !== (was[k] ?? null)) changed.push(`external_refs.${k}`)
    }
  }
  if (changed.length === 0) return null
  return lockedError(
    draft.id,
    `The ${changed.join(", ")}`,
    "Discard the draft and make it again from its source to change them; the due date and notes can be edited here.",
  )
}

/** The parts of a line the deduction lock reads, stored (`loadDraftLines`) or patched. */
interface LockLine {
  external_id?: string | null
  quantity?: unknown
  unit_price_minor?: unknown
  tax_rate_bp_override?: unknown
  tax_rate_bp?: unknown
}

const rateOf = (l: LockLine): string | null => {
  const r = l.tax_rate_bp_override ?? l.tax_rate_bp
  return r === null || r === undefined ? null : String(Number(r))
}

/** A line's identity for the deduction lock: what it takes off (its rate is its external id's). */
const deductionSig = (l: LockLine): string =>
  [
    String(l.external_id ?? ""),
    String(Number(l.quantity ?? 0)),
    String(l.unit_price_minor ?? ""),
  ].join("|")

/**
 * A final invoice's advance deduction lines are what `advance_deductions` records as taken: a
 * lines edit keeps every one of them as it is (dropping one bills the advance twice, enlarging
 * one takes off more than the advance). The final's own lines stay editable.
 */
export function deductionLinesLockedError(
  draftId: string,
  current: ReadonlyArray<LockLine>,
  next: ReadonlyArray<LockLine>,
): ErrorEnvelope | null {
  const isDeduction = (l: LockLine) => String(l.external_id ?? "").startsWith(DEDUCTION_PREFIX)
  const was = current.filter(isDeduction).map(deductionSig).sort()
  const now = next.filter(isDeduction).map(deductionSig).sort()
  if (was.length === 0 && now.length === 0) return null
  const rateKept = next.filter(isDeduction).every((l) => {
    const given = rateOf(l)
    const own = current.find((c) => c.external_id === l.external_id)
    return given === null || !own || rateOf(own) === null || given === rateOf(own)
  })
  if (rateKept && was.length === now.length && was.every((v, i) => v === now[i])) return null
  return lockedError(
    draftId,
    "The advance deduction lines",
    "Keep them as they are; to change an advance's deduction, discard this final's draft and draft it again.",
  )
}

interface MarkCtx {
  executeTool?: CrossAppExecuteTool
  logger?: { warn?: (msg: string, data?: Record<string, unknown>) => void }
}

/** This app's own approvals, as the kernel bridge offers them (absent on an older kernel). */
export interface OwnApprovals {
  pendingFor?: (payloadKey: string, toolNames?: string[]) => Promise<unknown>
  withdraw?: (approvalId: string, reason?: string) => Promise<unknown>
  restagePayload?: (
    approvalId: string,
    fields: Record<string, unknown>,
    note?: string,
  ) => Promise<unknown>
}

interface WithdrawCtx extends MarkCtx {
  approvals?: OwnApprovals
  approval?: { approvalRequestId: string } | null
}

/** A draft named for a person: whom it bills, never its id. */
export function draftInWords(draft: { counterparty_name?: string | null }): string {
  const name = typeof draft.counterparty_name === "string" ? draft.counterparty_name.trim() : ""
  return name ? `the invoice draft for ${name}` : "this invoice draft"
}

const upperFirst = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

const asJson = (v: unknown): unknown => {
  if (typeof v !== "string") return v
  try {
    return JSON.parse(v)
  } catch {
    return null
  }
}

/**
 * Withdraw the issue approvals still waiting on a draft made from a billing source once it is gone:
 * issued by another path (the Issue button, a month-end run) or discarded. The approval being decided right now is not
 * pending, so it is never touched. Best effort and never throws: a stale approval that stays only
 * ends in "draft not found" when someone approves it, never in a second issue.
 */
export async function withdrawIssueApprovals(
  ctx: WithdrawCtx,
  draft: { id: string; external_ref?: string | null },
  why: "issued" | "discarded",
): Promise<string[]> {
  // Only a draft made from a billing source has an issue approval raised for it at creation; any
  // other draft's issue is asked for by the issue itself, so there is nothing left to withdraw.
  if (!billingKeyOf(draft)) return []
  const draftId = draft.id
  const pendingFor = ctx.approvals?.pendingFor
  const withdraw = ctx.approvals?.withdraw
  if (!pendingFor || !withdraw) return []
  const done: string[] = []
  try {
    const raw = asJson(await pendingFor("draft_id", ["invoicing:invoice_issue"]))
    const rows = (Array.isArray(raw) ? raw : []) as Array<{ id?: unknown; target_id?: unknown }>
    const current = ctx.approval?.approvalRequestId ?? null
    for (const r of rows) {
      if (r.target_id !== draftId || typeof r.id !== "string" || r.id === current) continue
      const res = asJson(
        await withdraw(
          r.id,
          why === "issued"
            ? `Cancelled: draft ${draftId} was already issued`
            : `Cancelled: draft ${draftId} was discarded`,
        ),
      ) as { ok?: unknown } | null
      if (res?.ok === true) done.push(r.id)
    }
  } catch (err) {
    ctx.logger?.warn?.("withdrawing the draft's issue approval failed", {
      draftId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
  return done
}

/**
 * Tell projects what became of a reconciliation's draft: `billed` once it issued (with the new
 * document), `released` once it was discarded. Best effort: a lost call is healed by the projects
 * sweep, which matches the reconciliation to its document by the key. Never throws.
 */
export async function markReconciliation(
  ctx: MarkCtx,
  draft: { external_ref?: string | null; external_refs?: Record<string, unknown> | null },
  mark:
    | { to: "billed"; documentId: string; documentNumber: string }
    | { to: "released"; documentId?: undefined; documentNumber?: undefined },
): Promise<"marked" | "not_linked" | "failed"> {
  const rec = reconciliationOf(draft)
  if (!rec) return "not_linked"
  if (!ctx.executeTool) return "failed"
  try {
    const res = await ctx.executeTool("projects:reconcile_mark", {
      reconciliationId: rec.id,
      to: mark.to,
      ...(mark.documentId ? { documentId: mark.documentId } : {}),
      ...(mark.documentNumber ? { documentNumber: mark.documentNumber } : {}),
    })
    if (res?.status === "completed") {
      // Answered but moved nothing (projects did not see the issued invoice): say so, so a run
      // that leaves the card on its draft is never silent. The sweep still settles it.
      const out = (res as { result?: { changed?: unknown; state?: unknown } }).result
      if (mark.to === "billed" && out?.changed === false && out.state !== "invoiced") {
        ctx.logger?.warn?.("reconcile_mark moved nothing; the sweep will settle it", {
          reconciliationId: rec.id,
          state: out.state,
        })
        return "failed"
      }
      return "marked"
    }
    ctx.logger?.warn?.("reconcile_mark did not complete; the sweep will settle it", {
      reconciliationId: rec.id,
      to: mark.to,
      status: res?.status,
    })
    return "failed"
  } catch (err) {
    ctx.logger?.warn?.("reconcile_mark failed; the sweep will settle it", {
      reconciliationId: rec.id,
      to: mark.to,
      error: err instanceof Error ? err.message : String(err),
    })
    return "failed"
  }
}

/**
 * A draft made from a planned vs done card issues only while its reconciliation still reserves
 * the work it bills under this draft's key. Read through projects' billed-lines read; anything
 * else (changed, undone, released, or not readable) refuses with `reconcile_changed` and issues
 * nothing.
 */
export async function reconcileStillReserved(
  ctx: MarkCtx,
  draft: {
    id: string
    external_ref?: string | null
    external_refs?: unknown
    counterparty_name?: string | null
  },
): Promise<ErrorEnvelope | null> {
  const ref = draft.external_ref
  if (typeof ref !== "string" || !(ref.startsWith("reconcile:") || ref.startsWith("retainer:")))
    return null
  let refs = draft.external_refs
  if (typeof refs === "string") {
    try {
      refs = JSON.parse(refs)
    } catch {
      refs = null
    }
  }
  const rec = reconciliationOf({
    external_ref: ref,
    external_refs: (refs as Record<string, unknown> | null) ?? null,
  })
  const refused = (why: string): ErrorEnvelope => ({
    status: "error",
    error: {
      code: "reconcile_changed",
      message: `${upperFirst(draftInWords(draft))} was not issued: ${why}. Nothing was numbered. Open the project's planned vs done card, press Undo, then Create invoice again: the draft is replaced by one made from the card as it stands.`,
    },
  })
  if (!rec || !ctx.executeTool) return refused("its planned vs done card could not be read")
  let res: Awaited<ReturnType<CrossAppExecuteTool>>
  try {
    res = await ctx.executeTool("projects:reconcile_lines_read", { reconciliationId: rec.id })
  } catch {
    return refused("its planned vs done card could not be read")
  }
  if (res?.status !== "completed") return refused("its planned vs done card could not be read")
  const r = (res.result ?? {}) as {
    state?: unknown
    document_ref?: unknown
    documentRef?: unknown
    claimsReserved?: unknown
    revision?: unknown
  }
  const docRef = r.document_ref ?? r.documentRef
  if (docRef !== ref) return refused("its planned vs done card changed since the draft was made")
  // A draft keyed by its month, not by the card's revision, issues from the card it was made from.
  if (
    ref.startsWith("retainer:") &&
    rec.revision !== null &&
    typeof r.revision === "number" &&
    r.revision !== rec.revision
  )
    return refused("its planned vs done card changed since the draft was made")
  if (r.claimsReserved !== true) {
    return refused("the work it bills is no longer reserved for it")
  }
  return null
}

/**
 * The fingerprint of what an invoice draft bills: its type, issuer, customer, tax treatment and
 * e-invoicing facts, currency, terms, notes, PO reference, shipping and lines. An issue approval
 * carries it as `draft_hash` from the moment it is made (the preflight pins it on a call, and a
 * handler that parks the card states it). When the draft is edited through drafts_update while the
 * approval waits, the card is redrawn with the new fingerprint (a decision on the old card is
 * refused by its payload hash). Whatever path edited the draft, the issue refuses a draft whose
 * fingerprint is not the one on the approval.
 */
export interface HashableDraft {
  id: string
  type?: string | null
  issuer_profile_id?: string | null
  tax_treatment?: string | null
  customer_kind?: string | null
  operation_category?: string | null
  incoterm?: string | null
  counterparty_shipping_name?: string | null
  counterparty_shipping_address?: string | null
  counterparty_contact_id?: string | null
  counterparty_name?: string | null
  counterparty_address?: string | null
  counterparty_country?: string | null
  counterparty_vat_id?: string | null
  counterparty_email?: string | null
  currency?: string | null
  notes?: string | null
  po_number?: string | null
  due_at?: string | Date | null
  lines?: ReadonlyArray<{
    description?: unknown
    quantity?: unknown
    unit_price_minor?: unknown
    discount_minor?: unknown
    tax_rate_bp?: unknown
    line_kind?: unknown
  }>
}

export function draftContentHash(draft: HashableDraft): string {
  const text = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))
  const due = draft.due_at
  const canonical = JSON.stringify({
    draft: [
      draft.counterparty_contact_id,
      draft.counterparty_name,
      draft.counterparty_address,
      draft.counterparty_country,
      draft.counterparty_vat_id,
      draft.counterparty_email,
      draft.currency,
      draft.notes,
      draft.po_number,
      draft.type,
      draft.issuer_profile_id,
      draft.tax_treatment,
      draft.customer_kind,
      draft.operation_category,
      draft.incoterm,
      draft.counterparty_shipping_name,
      draft.counterparty_shipping_address,
    ].map(text),
    due:
      due === null || due === undefined || due === ""
        ? null
        : due instanceof Date
          ? due.toISOString().slice(0, 10)
          : String(due).slice(0, 10),
    lines: (draft.lines ?? []).map((l) => [
      String(l.description ?? ""),
      String(l.quantity ?? ""),
      String(l.unit_price_minor ?? ""),
      String(l.discount_minor ?? "0"),
      text(l.tax_rate_bp),
      text(l.line_kind),
    ]),
  })
  return sha256Hex(utf8Bytes(canonical))
}

/**
 * After a draft is edited, its issue approvals still waiting are redrawn: each gets the draft's new
 * fingerprint, so the kernel rebuilds its card from the edited draft and a decision taken on the
 * card as it was is refused. Best effort: the issue itself checks the fingerprint again.
 */
export async function restageIssueApprovals(
  ctx: WithdrawCtx,
  draft: HashableDraft,
): Promise<string[]> {
  const pendingFor = ctx.approvals?.pendingFor
  const restage = ctx.approvals?.restagePayload
  if (!pendingFor || !restage) return []
  const hash = draftContentHash(draft)
  const done: string[] = []
  try {
    const raw = asJson(await pendingFor("draft_id", ["invoicing:invoice_issue"]))
    const rows = (Array.isArray(raw) ? raw : []) as Array<{
      id?: unknown
      target_id?: unknown
      payload?: unknown
    }>
    for (const r of rows) {
      if (r.target_id !== draft.id || typeof r.id !== "string") continue
      const payload = asJson(r.payload) as { draft_hash?: unknown } | null
      if (payload?.draft_hash === hash) continue
      const res = asJson(
        await restage(r.id, { draft_hash: hash }, `${upperFirst(draftInWords(draft))} was edited.`),
      ) as { ok?: unknown } | null
      if (res?.ok === true) done.push(r.id)
    }
  } catch (err) {
    ctx.logger?.warn?.("redrawing the draft's issue approval failed", {
      draftId: draft.id,
      error: err instanceof Error ? err.message : String(err),
    })
  }
  return done
}

/**
 * The issue's own check, the one every edit path meets: a draft whose fingerprint is not the one
 * its approval carries is not issued from that card, whether it was edited through drafts_update,
 * documents_update, a Shopify sync or anything else. An approval with no fingerprint (one asked
 * for by chaining a draft that did not exist yet, or made before approvals carried one) is not
 * checked.
 */
export function draftChangedSinceCard(
  draft: HashableDraft,
  shownHash: string | null | undefined,
): ErrorEnvelope | null {
  if (typeof shownHash !== "string" || shownHash === "") return null
  if (draftContentHash(draft) === shownHash) return null
  return {
    status: "error",
    error: {
      code: "draft_changed",
      message: `${upperFirst(draftInWords(draft))} was not issued: it changed after this request was made. Nothing was numbered. Ask for its issue again so the card shows what will be issued.`,
    },
  }
}

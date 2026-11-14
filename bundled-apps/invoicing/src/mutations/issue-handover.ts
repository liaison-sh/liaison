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
import type { IssueBatchOp, IssueInput, SourceColumns } from "../issue"
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
  const linked = draft.external_refs?.reconciliation_id
  if (typeof linked === "string" && linked !== "") {
    const rev = draft.external_refs?.reconciliation_revision
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
      ...(key ? [{ update: "documents", id: draft.id, data: { external_ref: null } }] : []),
    ],
    commit_with: [
      ...(input.commit_with ?? []),
      ...repoints,
      { delete: "documents", id: draft.id },
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

interface MarkCtx {
  executeTool?: CrossAppExecuteTool
  logger?: { warn?: (msg: string, data?: Record<string, unknown>) => void }
}

/** This app's own approvals, as the kernel bridge offers them (absent on an older kernel). */
export interface OwnApprovals {
  pendingFor?: (payloadKey: string, toolNames?: string[]) => Promise<unknown>
  withdraw?: (approvalId: string, reason?: string) => Promise<unknown>
}

interface WithdrawCtx extends MarkCtx {
  approvals?: OwnApprovals
  approval?: { approvalRequestId: string } | null
}

const asJson = (v: unknown): unknown => {
  if (typeof v !== "string") return v
  try {
    return JSON.parse(v)
  } catch {
    return null
  }
}

/**
 * Withdraw the issue approvals still waiting on a draft that is gone: issued by another path (the
 * Issue button, a month-end run) or discarded. The approval being decided right now is not
 * pending, so it is never touched. Best effort and never throws: a stale approval that stays only
 * ends in "draft not found" when someone approves it, never in a second issue.
 */
export async function withdrawIssueApprovals(
  ctx: WithdrawCtx,
  draftId: string,
  why: "issued" | "discarded",
): Promise<string[]> {
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
    if (res?.status === "completed") return "marked"
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
  draft: { id: string; external_ref?: string | null },
): Promise<ErrorEnvelope | null> {
  const ref = draft.external_ref
  if (typeof ref !== "string" || !ref.startsWith("reconcile:")) return null
  const rec = reconciliationOf(draft)
  const refused = (why: string): ErrorEnvelope => ({
    status: "error",
    error: {
      code: "reconcile_changed",
      message: `Draft ${draft.id} was not issued: ${why}. Nothing was numbered. Open the project's planned vs done card again and create the invoice from it.`,
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
  }
  const docRef = r.document_ref ?? r.documentRef
  if (docRef !== ref) return refused("its planned vs done card changed since the draft was made")
  if (r.claimsReserved !== true) {
    return refused("the work it bills is no longer reserved for it")
  }
  return null
}

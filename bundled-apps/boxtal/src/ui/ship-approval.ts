// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Label purchase approvals, decided in the shipping grid itself.
//
// Buying a label is ONE decision. A Ship click by someone who may approve label purchases IS that
// decision: the kernel runs create_shipment at once, and everything the purchase sets off (the
// batch proforma, the order's fulfillment) runs under that same authority with no approval of its
// own. When the purchase is gated instead (the click came from someone who may not approve it, or
// an agent staged it), the pending approval belongs on the row it buys a label for: the grid reads
// the boxtal approvals feed, pairs each pending create_shipment with its row through the draft id
// (which IS the row's document_ref), and shows what is being bought with Approve and Decline right
// there. The global approvals queue stays a second door onto the same request, never the only one.
//
// Pure helpers only: the grid component wires them to the host fetch.

/** The kernel's answer to a gated call: the handler did not run, an approval was parked instead. */
export interface BlockedEnvelope {
  approvalRequestId: string
  /** Whether the person who made the call may decide it themselves. */
  requesterCanApprove: boolean
}

/** `{ blocked: { approvalRequestId, ... } }` is what invokeTool resolves for a gated call. It is NOT
 *  a `status: "pending_approval"` field: reading that field instead treated every parked purchase as
 *  a bought label and dropped the row from the grid. */
export function blockedEnvelope(result: unknown): BlockedEnvelope | null {
  if (!result || typeof result !== "object") return null
  const blocked = (result as { blocked?: unknown }).blocked
  if (!blocked || typeof blocked !== "object") return null
  const b = blocked as { approvalRequestId?: unknown; requesterCanApprove?: unknown }
  return {
    approvalRequestId: typeof b.approvalRequestId === "string" ? b.approvalRequestId : "",
    requesterCanApprove: b.requesterCanApprove === true,
  }
}

export type ShipOutcome =
  | { kind: "shipped" }
  | { kind: "pending"; approvalRequestId: string; requesterCanApprove: boolean }
  | { kind: "error"; message: string }

/** What a Ship click produced. Only a result that is neither parked nor an error is a bought label. */
export function shipOutcome(result: unknown): ShipOutcome {
  const blocked = blockedEnvelope(result)
  if (blocked) {
    return {
      kind: "pending",
      approvalRequestId: blocked.approvalRequestId,
      requesterCanApprove: blocked.requesterCanApprove,
    }
  }
  const r = (result ?? {}) as { status?: unknown; approval_id?: unknown; error?: { message?: unknown } }
  if (r.status === "pending_approval") {
    return {
      kind: "pending",
      approvalRequestId: typeof r.approval_id === "string" ? r.approval_id : "",
      requesterCanApprove: false,
    }
  }
  if (r.error && typeof r.error.message === "string" && r.error.message !== "") {
    return { kind: "error", message: r.error.message }
  }
  return { kind: "shipped" }
}

/** The fields of a kernel approval row the grid reads. */
export interface ApprovalRow {
  id: string
  status: string
  toolName: string
  currentPayload?: Record<string, unknown> | null
  summary?: {
    title?: string
    subtitle?: string
    lines?: string[]
  } | null
  requester?: { name?: string | null } | null
  createdAt?: string
  /** Fingerprint of the payload as the grid showed it: an approve is bound to that version. */
  payloadHash?: string
}

export const CREATE_SHIPMENT_TOOL = "boxtal:create_shipment"

/** The approvals feed scoped to this app: only boxtal's gated tools, so nothing decided from the
 *  shipping grid can ever touch another app's request. */
export const SHIP_APPROVALS_PATH = "/api/approvals?status=pending&decidableByMe=true&app=boxtal"

export function decidePath(approvalId: string): string {
  return `/api/approvals/${encodeURIComponent(approvalId)}/decide`
}

/** The decision as the kernel takes it: an approve names the version of the purchase the row
 *  showed, so a purchase edited since is refused rather than bought unseen. */
export function decideBody(
  approval: Pick<ApprovalRow, "payloadHash">,
  decision: "approve" | "deny",
): { decision: "approve" | "deny"; payloadHash?: string } {
  return decision === "approve" && approval.payloadHash
    ? { decision, payloadHash: approval.payloadHash }
    : { decision }
}

/** Pending label purchases keyed by the draft they buy for (draft_id === the row's document_ref).
 *  When several are pending for one draft the newest wins; the kernel already restages a re-click
 *  onto the existing request, so more than one is an agent's stale leftover. */
export function pendingShipApprovalsByDraft(rows: readonly ApprovalRow[]): Map<string, ApprovalRow> {
  const out = new Map<string, ApprovalRow>()
  const pending = rows
    .filter((r) => r.toolName === CREATE_SHIPMENT_TOOL && r.status === "pending")
    .sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")))
  for (const r of pending) {
    const draftId = r.currentPayload?.draft_id
    if (typeof draftId === "string" && draftId.trim() !== "") out.set(draftId.trim(), r)
  }
  return out
}

/** The row's pending purchase, if any. */
export function shipApprovalForRow(
  row: { document_ref: string | null },
  byDraft: ReadonlyMap<string, ApprovalRow>,
): ApprovalRow | null {
  return row.document_ref ? (byDraft.get(row.document_ref) ?? null) : null
}

/** What the inline card says: the summary the approval was staged with (order, recipient, parcels,
 *  carrier, price), and who asked. */
export function approvalCardText(approval: ApprovalRow): { title: string; lines: string[]; requester: string | null } {
  const title = approval.summary?.title?.trim() || "Buy this label"
  const lines = Array.isArray(approval.summary?.lines)
    ? approval.summary!.lines!.filter((l): l is string => typeof l === "string" && l.trim() !== "")
    : []
  const requester = approval.requester?.name?.trim() || null
  return { title, lines, requester }
}

/** The message shown on the row after a decision call. */
export function decisionNote(decision: "approve" | "deny", result: unknown): string {
  const status = (result as { status?: unknown } | null)?.status
  if (decision === "deny") return "Declined. No label was bought."
  if (status === "approved") return "Approved. The label is bought."
  if (status === "pending") return "Approval recorded. Another approver must also approve."
  return "Approved."
}

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// "Awaiting approval", derived at read time. A gated reply or like staged by an
// agent is parked by the kernel before the social handler runs, so nothing is
// written on the finding. Instead every read asks the kernel which of this app's
// approvals are still pending (`ctx.approvals.pendingFor`, scoped to this app's
// own tools and the caller's org) and overlays them on the findings they target:
// the finding reads `awaiting_approval` with the draft and the approval id while
// the request is pending, and its stored status again once the request is denied,
// expires or is cancelled. Nothing is stored that could go stale.

import type { SocialToolCtx } from "./ctx"

/** The gated tools whose payload targets a finding by `finding_id`. */
export const FINDING_APPROVAL_TOOLS = ["social:reply_to_finding", "social:like_item"] as const

export type PendingFindingAction = "reply" | "like"

export interface PendingFindingApproval {
  approval_id: string
  action: PendingFindingAction
  /** The staged reply text (the approver may have edited it). Null for a like. */
  draft: string | null
  created_at: string | null
}

/** Pending approvals by finding id, or null when the live state is unknown. */
export type PendingFindingIndex = Map<string, PendingFindingApproval> | null

interface PendingRow {
  id?: unknown
  tool_name?: unknown
  target_id?: unknown
  payload?: unknown
  created_at?: unknown
}

/** A stored status a pending approval does not override: a handled finding gets
 *  no post (the handler no-ops), and a dismissal is a person's explicit call on
 *  the finding, which the approval stays open beside in the approvals inbox. */
const TERMINAL_STATUSES = new Set(["handled", "dismissed"])

/** What a finding falls back to when it was stored as `awaiting_approval` (by an
 *  earlier version of the handler) and no approval is pending any more. */
const FALLBACK_STATUS = "new"

/**
 * Pending approvals on this app's finding tools, keyed by finding id. One entry
 * per finding: a pending reply wins over a pending like (it carries the draft),
 * and within the same kind the newest request wins. Null when the host exposes
 * no `approvals.pendingFor` (an older kernel): the live state is then unknown and
 * reads show stored statuses unchanged.
 */
export async function pendingFindingApprovals(
  ctx: SocialToolCtx,
): Promise<PendingFindingIndex> {
  const pendingFor = ctx.approvals?.pendingFor
  if (!pendingFor) return null
  const out = new Map<string, PendingFindingApproval>()
  let raw: unknown = await pendingFor("finding_id", [...FINDING_APPROVAL_TOOLS])
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw)
    } catch {
      return out
    }
  }
  if (!Array.isArray(raw)) return out
  // The kernel returns newest first; keep the first reply, else the first like.
  for (const r of raw as PendingRow[]) {
    if (typeof r?.id !== "string" || typeof r.target_id !== "string") continue
    const action: PendingFindingAction | null =
      r.tool_name === "social:reply_to_finding" ? "reply" : r.tool_name === "social:like_item" ? "like" : null
    if (!action) continue
    const existing = out.get(r.target_id)
    if (existing && (existing.action === "reply" || action === "like")) continue
    const payload = (r.payload ?? {}) as { reply_text?: unknown }
    out.set(r.target_id, {
      approval_id: r.id,
      action,
      draft: action === "reply" && typeof payload.reply_text === "string" ? payload.reply_text : null,
      created_at: typeof r.created_at === "string" ? r.created_at : null,
    })
  }
  return out
}

interface FindingLike {
  id?: unknown
  status?: unknown
  suggested_reply?: unknown
  approval_request_id?: unknown
}

/**
 * Overlay the live approval state on one finding row (immutably). With a pending
 * approval: status `awaiting_approval`, the staged draft as `suggested_reply`
 * (a like keeps the stored suggestion), the approval id, and `pending_action`.
 * Without one: the stored status, except a stale stored `awaiting_approval`,
 * which falls back to `new` and drops its dead approval id.
 */
export function deriveFindingApprovalState<T>(row: T, pending: PendingFindingApproval | undefined): T {
  if (!row || typeof row !== "object") return row
  const f = row as T & FindingLike
  const stored = typeof f.status === "string" ? f.status : null
  if (pending && !(stored && TERMINAL_STATUSES.has(stored))) {
    return {
      ...f,
      status: "awaiting_approval",
      suggested_reply: pending.draft ?? f.suggested_reply ?? null,
      approval_request_id: pending.approval_id,
      pending_action: pending.action,
    }
  }
  if (stored === "awaiting_approval") {
    return { ...f, status: FALLBACK_STATUS, approval_request_id: null }
  }
  return row
}

/** Overlay the live approval state of `index` on a finding row; unchanged when
 *  the live state is unknown (`index` null). */
export function withLiveApprovalState<T>(row: T, index: PendingFindingIndex): T {
  if (!index || !row || typeof row !== "object") return row
  const id = (row as { id?: unknown }).id
  return deriveFindingApprovalState(row, typeof id === "string" ? index.get(id) : undefined)
}

/** The status a finding reads as, given the live approvals. */
export function derivedFindingStatus(row: { id?: unknown; status?: unknown }, index: PendingFindingIndex): string | null {
  const d = withLiveApprovalState(row, index)
  return typeof d.status === "string" ? d.status : null
}

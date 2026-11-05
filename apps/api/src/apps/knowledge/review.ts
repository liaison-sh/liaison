// SPDX-License-Identifier: FSL-1.1-ALv2
export type KnowledgeReviewStatus = "unverified" | "verified" | "needs_review" | "stale"

export type KnowledgeReviewReason =
  | "content_changed"
  | "expired"
  | "source_unavailable"
  | "owner_missing"
  | "agent_requested"
  | "untrusted_content"
  | null

export interface KnowledgeReviewRow {
  reviewStatus?: KnowledgeReviewStatus | string | null
  reviewReason?: KnowledgeReviewReason | string | null
  verifiedBy?: string | null
  verifiedAt?: string | Date | null
}

export type KnowledgeReviewTransition =
  | { kind: "edit"; patch?: Record<string, unknown> }
  | { kind: "verify"; actorId?: string; verifiedAt?: string | Date }
  | { kind: "review_due" }
  | { kind: "source_metadata_changed" }
  | { kind: "source_unavailable" }
  | { kind: "owner_missing" }

const VERIFICATION_RESET_FIELDS = new Set([
  "title",
  "body",
  "summary",
  "ownerUserId",
  "documentScope",
  "team",
  "sensitivity",
  "attachments",
])

export function shouldResetVerification(
  row: KnowledgeReviewRow,
  patch: Record<string, unknown>,
): boolean {
  if (row.reviewStatus !== "verified" || patch.verifyNow === true) return false
  return Object.keys(patch).some((key) => VERIFICATION_RESET_FIELDS.has(key))
}

export function applyReviewTransition<TRow extends KnowledgeReviewRow>(
  row: TRow,
  event: KnowledgeReviewTransition,
): TRow & {
  reviewStatus: KnowledgeReviewStatus
  reviewReason?: KnowledgeReviewReason | string | null
} {
  if (event.kind === "verify") {
    return {
      ...row,
      reviewStatus: "verified",
      reviewReason: null,
      verifiedBy: event.actorId ?? row.verifiedBy ?? null,
      verifiedAt: event.verifiedAt ?? new Date().toISOString(),
    }
  }

  if (event.kind === "edit") {
    if (!shouldResetVerification(row, event.patch ?? {})) {
      return { ...row, reviewStatus: (row.reviewStatus ?? "unverified") as KnowledgeReviewStatus }
    }
    return { ...row, reviewStatus: "needs_review", reviewReason: "content_changed" }
  }

  if (event.kind === "source_metadata_changed") {
    return { ...row, reviewStatus: "stale", reviewReason: "content_changed" }
  }

  if (event.kind === "source_unavailable") {
    return { ...row, reviewStatus: "stale", reviewReason: "source_unavailable" }
  }

  if (event.kind === "owner_missing") {
    return { ...row, reviewStatus: "needs_review", reviewReason: "owner_missing" }
  }

  return { ...row, reviewStatus: "needs_review", reviewReason: "expired" }
}

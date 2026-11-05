// SPDX-License-Identifier: FSL-1.1-ALv2
import type { AttentionItem } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import type { KnowledgeReviewStatus } from "~/apps/knowledge/review"
import { knowledgeRel } from "~/apps/knowledge/schema-refs"
import { extractRows, type PrivilegedDb, type RlsClient, type RlsTx } from "~/db"

export interface KnowledgeAttentionRow {
  id: string
  targetType?: "document" | "source_link" | string
  title?: string | null
  reviewStatus?: KnowledgeReviewStatus | string | null
  reviewReason?: string | null
  reviewDueAt?: string | Date | null
  ownerUserId?: string | null
  visibilityStatus?: string | null
  cacheStatus?: string | null
}

export interface KnowledgeAttentionItem {
  key: string
  kind: "knowledge_review"
  app: "knowledge"
  entityType: string
  entityId: string
  title: string
  reason: string
  /** Set on collapsed flood items — how many entities the row stands for. */
  aggregateCount?: number
}

export interface KnowledgeAttentionContext {
  rows(): Promise<KnowledgeAttentionRow[]>
  now?: Date
}

const SOURCE_PROBLEM_STATES = new Set(["unavailable", "unauthorized", "stale"])

function attentionReason(row: KnowledgeAttentionRow, now: Date): string | null {
  if (row.reviewStatus === "needs_review" || row.reviewStatus === "stale")
    return row.reviewReason ?? "review_needed"
  if (row.ownerUserId === null) return "owner_missing"
  if (row.reviewDueAt && new Date(row.reviewDueAt).getTime() <= now.getTime()) return "expired"
  if (row.visibilityStatus && SOURCE_PROBLEM_STATES.has(row.visibilityStatus))
    return "source_unavailable"
  if (row.cacheStatus && SOURCE_PROBLEM_STATES.has(row.cacheStatus)) return "source_unavailable"
  return null
}

/**
 * Pure in-memory computation — used by unit tests and any caller that already
 * has a row set in hand. Prefer {@link computeAttentionItems} when running
 * against the live DB (it runs the underlying SQL queries against RLS).
 */
export async function computeKnowledgeAttentionItems(
  ctx: KnowledgeAttentionContext,
): Promise<KnowledgeAttentionItem[]> {
  const now = ctx.now ?? new Date()
  const seen = new Set<string>()
  const items: KnowledgeAttentionItem[] = []

  for (const row of await ctx.rows()) {
    const targetType = row.targetType ?? "document"
    const reason = attentionReason(row, now)
    if (!reason) continue

    const key = `knowledge:${targetType}:${row.id}:${reason}`
    if (seen.has(key)) continue
    seen.add(key)
    items.push({
      key,
      kind: "knowledge_review",
      app: "knowledge",
      entityType: targetType,
      entityId: row.id,
      title: row.title ?? "Knowledge item",
      reason,
    })
  }

  return items
}

type SqlClient = RlsClient | RlsTx | PrivilegedDb

interface DocAttentionDbRow {
  id: string
  title: string | null
  review_status: string | null
  review_reason: string | null
  review_due_at: Date | string | null
  owner_user_id: string | null
}

interface LinkAttentionDbRow {
  id: string
  title: string | null
  review_status: string | null
  review_reason: string | null
  review_due_at: Date | string | null
  owner_user_id: string | null
  visibility_status: string | null
  cache_status: string | null
}

/**
 * Real-SQL attention provider for Knowledge. Selects rows from
 * `app_knowledge.documents` + `app_knowledge.source_links` — RLS scopes the
 * result to entries the caller can read — and routes each row through the pure
 * {@link computeKnowledgeAttentionItems} pipeline so dedupe/key semantics stay
 * consistent.
 *
 * Note: name omits the `Knowledge` infix to match the cross-app
 * `computeAttentionItems(tx, orgId, userId)` convention used by `projects`
 * and `tickets`. The manifest references this handler at
 * `views.attentionItems.handler`.
 */
export async function computeAttentionItems(
  tx: SqlClient,
  orgId: string,
  _callerUserId: string,
  now: Date = new Date(),
  opts: { aggregate?: boolean } = {},
): Promise<AttentionItem[]> {
  const docRowsResult = await tx.execute(drizzleSql`
    SELECT id, title, review_status, review_reason, review_due_at, owner_user_id
    FROM ${knowledgeRel("documents")}
    WHERE org_id = ${orgId}::uuid
      AND archived_at IS NULL
      AND (
        review_status IN ('needs_review', 'stale')
        OR owner_user_id IS NULL
        OR (review_due_at IS NOT NULL AND review_due_at <= now())
      )
    LIMIT 500
  `)
  const linkRowsResult = await tx.execute(drizzleSql`
    SELECT id, title, review_status, review_reason, review_due_at, owner_user_id,
           visibility_status, cache_status
    FROM ${knowledgeRel("source_links")}
    WHERE org_id = ${orgId}::uuid
      AND archived_at IS NULL
      AND (
        review_status IN ('needs_review', 'stale')
        OR owner_user_id IS NULL
        OR (review_due_at IS NOT NULL AND review_due_at <= now())
        OR visibility_status IN ('unavailable', 'unauthorized', 'stale')
        OR cache_status IN ('unavailable', 'unauthorized', 'stale')
      )
    LIMIT 500
  `)

  const rows: KnowledgeAttentionRow[] = [
    ...extractRows<DocAttentionDbRow>(docRowsResult).map((r) => ({
      id: r.id,
      targetType: "document" as const,
      title: r.title,
      reviewStatus: r.review_status ?? null,
      reviewReason: r.review_reason,
      reviewDueAt:
        r.review_due_at instanceof Date ? r.review_due_at.toISOString() : r.review_due_at,
      ownerUserId: r.owner_user_id,
    })),
    ...extractRows<LinkAttentionDbRow>(linkRowsResult).map((r) => ({
      id: r.id,
      targetType: "source_link" as const,
      title: r.title,
      reviewStatus: r.review_status ?? null,
      reviewReason: r.review_reason,
      reviewDueAt:
        r.review_due_at instanceof Date ? r.review_due_at.toISOString() : r.review_due_at,
      ownerUserId: r.owner_user_id,
      visibilityStatus: r.visibility_status,
      cacheStatus: r.cache_status,
    })),
  ]

  const domestic = await computeKnowledgeAttentionItems({ rows: async () => rows, now })
  const shaped = opts.aggregate === false ? domestic : aggregateFloods(domestic)
  return shaped.map(toSharedAttentionItem)
}

/**
 * A bulk import (folder-source sync) can put dozens of documents into the same
 * review state at once; one row per doc turns the Home feed into a wall. Keep
 * individual rows up to the threshold, above it collapse each
 * (targetType, reason) bucket into a single counted item that opens the
 * Knowledge workspace.
 */
export const FLOOD_AGGREGATE_THRESHOLD = 5

export function aggregateFloods(items: KnowledgeAttentionItem[]): KnowledgeAttentionItem[] {
  const buckets = new Map<string, KnowledgeAttentionItem[]>()
  for (const item of items) {
    const bucketKey = `${item.entityType}:${item.reason}`
    const bucket = buckets.get(bucketKey)
    if (bucket) bucket.push(item)
    else buckets.set(bucketKey, [item])
  }

  const out: KnowledgeAttentionItem[] = []
  for (const bucket of buckets.values()) {
    if (bucket.length <= FLOOD_AGGREGATE_THRESHOLD) {
      out.push(...bucket)
      continue
    }
    const first = bucket[0]!
    const noun = first.entityType === "source_link" ? "source links" : "documents"
    out.push({
      key: `knowledge:${first.entityType}:aggregate:${first.reason}`,
      kind: "knowledge_review",
      app: "knowledge",
      entityType: first.entityType,
      entityId: "",
      title: `${bucket.length} ${noun}`,
      reason: first.reason,
      aggregateCount: bucket.length,
    })
  }
  return out
}

const REASON_LABELS: Record<string, string> = {
  review_needed: "needs review",
  owner_missing: "no owner assigned",
  expired: "review overdue",
  source_unavailable: "source unavailable",
}

/**
 * Map the domestic review item to the shared AttentionItem contract the
 * aggregator/frontend consume. The domestic shape (key/entityType/title/
 * reason) was returned RAW for as long as the review queue happened to be
 * empty on every deployment; the first real batch of review items broke the
 * Home feed on a missing `action`. Low urgency: review work is queue work,
 * never a "needs you now" interrupt.
 */
function toSharedAttentionItem(item: KnowledgeAttentionItem): AttentionItem {
  const reasonLabel = REASON_LABELS[item.reason] ?? item.reason.replace(/_/g, " ")
  if (item.aggregateCount != null) {
    // Collapsed flood row: no single entity to open, so the click lands on the
    // Knowledge workspace tab (the `home` entity resolves to `knowledge:home`).
    return {
      id: item.key,
      app: "knowledge",
      entity: "home",
      entityId: "",
      kind: item.kind as AttentionItem["kind"],
      summary: `${item.title}: ${reasonLabel}`,
      urgency: 25,
      occurredAt: new Date().toISOString(),
      action: { type: "open_entity", tabType: "knowledge:home", entityId: "" },
      metadata: { reason: item.reason, aggregateCount: item.aggregateCount },
    }
  }
  return {
    id: item.key,
    app: "knowledge",
    entity: item.entityType,
    entityId: item.entityId,
    kind: item.kind as AttentionItem["kind"],
    summary: `${item.title}: ${reasonLabel}`,
    urgency: 25,
    occurredAt: new Date().toISOString(),
    action: {
      type: "open_entity",
      tabType: `knowledge:${item.entityType}`,
      entityId: item.entityId,
    },
    metadata: { reason: item.reason },
  }
}

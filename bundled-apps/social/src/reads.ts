// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Agent-visible read tools (§4.5). Ungated; RLS-scoped via ctx.db (no manual org
// filtering). findings_list/get, dm_list/get, watched_list, monitor_terms_list,
// counts (sidebar badges).

import type { SocialToolCtx } from "./ctx"
import { dmReplyWindow } from "./dm-window"
import { derivedFindingStatus, type PendingFindingIndex, pendingFindingApprovals, withLiveApprovalState } from "./pending"

/** Attach the agent-readable reply-window descriptor to a conversation row so the
 *  send-time window state (standard ≤24h · human-agent ≤7d · closed) surfaces at
 *  READ time — before a gated send_dm is proposed — rather than forcing the agent
 *  to do date arithmetic on a raw last_inbound_at. Read-only enrichment; the row's
 *  own fields are untouched. */
function withReplyWindow<T extends { last_inbound_at?: string | null }>(row: T): T {
  if (!row || typeof row !== "object") return row
  return { ...row, reply_window: dmReplyWindow(row.last_inbound_at ?? null) }
}

// Wrap externally-authored social text (a third party's post/comment or an
// inbound DM the agent did not write) so the model reads it as DATA, not
// instructions — the same untrusted-content fence web_search/web_fetch apply to
// fetched page text (apps/api/src/modules/agent/tools/web-tools.ts
// `wrapExternalContent`). Pairs with the findings_*/dm_* `taintSource: true`
// manifest flag: the flag marks the thread tainted; this fences the content.
function wrapExternalContent(content: string): string {
  // A closing (or opening) fence tag inside the content is escaped, so the text
  // cannot end its own fence. Same escape as apps/api/src/lib/external-content.ts.
  const safe = content.replace(/<(\s*\/?\s*external-content)/gi, "&lt;$1")
  return `<external-content source="untrusted">\n${safe}\n</external-content>`
}

/** Fence one named string field on a row (if present + non-empty), immutably. */
function fenceField<T>(row: T, field: string): T {
  if (!row || typeof row !== "object") return row
  const value = (row as Record<string, unknown>)[field]
  if (typeof value !== "string" || value.length === 0) return row
  return { ...(row as Record<string, unknown>), [field]: wrapExternalContent(value) } as T
}

export interface FindingsListParams {
  status?: string
  platform?: string
  contact_id?: string
  limit?: number
}

/** List findings, optionally filtered by status/platform/contact. A finding an
 *  approval is pending for reads `awaiting_approval` (pending.ts): the status
 *  filter and the count apply to that derived status, not the stored one. */
export async function findingsList(
  params: FindingsListParams,
  ctx: SocialToolCtx,
): Promise<{ findings: unknown[]; totalCount: number }> {
  const others: Record<string, unknown> = {}
  if (params.platform) others.platform = params.platform
  if (params.contact_id) others.contact_id = params.contact_id
  const where: Record<string, unknown> = { ...others }
  if (params.status) where.status = params.status
  const filter = Object.keys(where).length > 0 ? where : undefined
  const limit = params.limit ?? 100
  const pending = await pendingFindingApprovals(ctx)
  const overlay = (r: unknown) => withLiveApprovalState(r, pending)
  // content_text is the third party's post/comment — fence it as untrusted.
  const present = (rows: unknown[]) => rows.map((r) => fenceField(overlay(r), "content_text"))

  if (!params.status || !pending) {
    const rows = await ctx.db.findMany("finding", { where: filter, orderBy: { occurred_at: "desc" }, limit })
    // Sweep substrate: a server count over the SAME filter, not the (200-capped)
    // page — so a triage sweep ("handle every new finding") reads the true
    // remaining count and drives it to zero as each finding leaves the filter
    // (set_triage / dismiss_finding flips its status), even across ticks.
    const totalCount = await ctx.db.count("finding", { where: filter })
    return { findings: present(rows), totalCount }
  }

  const status = params.status
  const matchesOthers = (r: Record<string, unknown>) =>
    Object.entries(others).every(([k, v]) => r[k] === v)
  const derivedIs = (r: unknown, s: string) => (overlay(r) as { status?: unknown }).status === s
  // The findings a pending approval targets, as stored (bounded by the pending set).
  const targeted = (await loadTargeted(ctx, pending)).filter(matchesOthers)
  if (status === "awaiting_approval") {
    const rows = targeted.filter((r) => derivedIs(r, status)).sort(byOccurredDesc)
    return { findings: present(rows.slice(0, limit)), totalCount: rows.length }
  }
  const stored = await ctx.db.findMany("finding", { where: filter, orderBy: { occurred_at: "desc" }, limit })
  // A finding still stored as awaiting_approval with nothing pending reads as `new`.
  const stale =
    status === "new"
      ? (
          await ctx.db.findMany("finding", {
            where: { ...others, status: "awaiting_approval" },
            orderBy: { occurred_at: "desc" },
            limit,
          })
        ).filter((r) => derivedIs(r, status))
      : []
  const rows = [...stored, ...stale].filter((r) => derivedIs(r, status)).sort(byOccurredDesc)
  const movedOut = targeted.filter((r) => r.status === status && !derivedIs(r, status)).length
  const totalCount = (await ctx.db.count("finding", { where: filter })) + stale.length - movedOut
  return { findings: present(rows.slice(0, limit)), totalCount: Math.max(0, totalCount) }
}

/** The stored rows of the findings a pending approval targets (bounded by the pending set). */
async function loadTargeted(ctx: SocialToolCtx, pending: PendingFindingIndex): Promise<Array<Record<string, unknown>>> {
  if (!pending) return []
  const rows = await Promise.all([...pending.keys()].map((id) => ctx.db.findOne("finding", id)))
  return rows.filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
}

function byOccurredDesc(a: unknown, b: unknown): number {
  const t = (r: unknown) => Date.parse(String((r as { occurred_at?: unknown } | null)?.occurred_at ?? "")) || 0
  return t(b) - t(a)
}

/** Fetch one finding by id, with its live approval state. */
export async function findingsGet(
  params: { finding_id: string },
  ctx: SocialToolCtx,
): Promise<{ finding: unknown | null }> {
  const finding = await ctx.db.findOne("finding", params.finding_id)
  if (!finding) return { finding }
  const pending = await pendingFindingApprovals(ctx)
  // content_text is the third party's post/comment — fence it as untrusted.
  return { finding: fenceField(withLiveApprovalState(finding, pending), "content_text") }
}

/** List DM conversations, most-recently-active first; optionally by contact. */
export async function dmList(
  params: { status?: string; contact_id?: string; limit?: number },
  ctx: SocialToolCtx,
): Promise<{ conversations: unknown[] }> {
  const where: Record<string, unknown> = {}
  if (params.status) where.status = params.status
  if (params.contact_id) where.contact_id = params.contact_id
  // Fetch wide and order in JS: SQL `ORDER BY last_inbound_at DESC` puts NULLs
  // FIRST (postgres default), so rows with no inbound time filled the LIMIT
  // window and starved every real conversation out of the list (live: 92 null
  // rows → only 3 visible threads). Recency = latest of message/inbound time.
  const rows = (await ctx.db.findMany("dm_conversation", {
    where: Object.keys(where).length > 0 ? where : undefined,
    orderBy: { last_message_at: "desc" },
    limit: 1000,
  })) as Array<{
    status?: string
    last_message_snippet?: string | null
    last_message_at?: string | null
    last_inbound_at?: string | null
  }>
  // Default view hides noise: archived threads, and degenerate shells with
  // NOTHING to show (no snippet — Meta returns some conversations with zero
  // messages and no counterpart: deleted/blocked accounts). An explicit
  // status param still returns exactly what was asked for.
  const recency = (r: { last_message_at?: string | null; last_inbound_at?: string | null }) =>
    Math.max(Date.parse(r.last_message_at ?? "") || 0, Date.parse(r.last_inbound_at ?? "") || 0)
  const filtered = (
    params.status
      ? rows
      : rows.filter((r) => r.status !== "archived" && r.last_message_snippet != null)
  )
    .sort((a, b) => recency(b) - recency(a))
    .slice(0, params.limit ?? 100)
  // last_message_snippet previews the (often inbound, externally-authored)
  // latest DM text — fence it as untrusted. participant_handle/display_name are
  // routing metadata, not the participant's free-text message, so left as-is.
  // reply_window is attached so the send-time window state surfaces at read time.
  const conversations = filtered.map((r) =>
    withReplyWindow(fenceField(r, "last_message_snippet") as { last_inbound_at?: string | null }),
  )
  return { conversations }
}

/** Fetch one conversation with its messages (chronological). */
export async function dmGet(
  params: { conversation_id: string },
  ctx: SocialToolCtx,
): Promise<{ conversation: unknown | null; messages: unknown[] }> {
  const conversationRow = await ctx.db.findOne("dm_conversation", params.conversation_id)
  const conversation = conversationRow
    ? withReplyWindow(
        fenceField(conversationRow, "last_message_snippet") as {
          last_inbound_at?: string | null
        },
      )
    : conversationRow
  const rows = await ctx.db.findMany("dm_message", {
    where: { conversation_id: params.conversation_id },
    orderBy: { occurred_at: "asc" },
    limit: 500,
  })
  // Inbound messages are written by the external participant; their `body` is
  // untrusted and must be fenced. Outbound messages are our own text, left as-is.
  const messages = rows.map((r) =>
    r && typeof r === "object" && (r as Record<string, unknown>).direction === "inbound"
      ? fenceField(r, "body")
      : r,
  )
  return { conversation, messages }
}

/** List watched objects. */
export async function watchedList(
  params: { status?: string; limit?: number },
  ctx: SocialToolCtx,
): Promise<{ watched: unknown[] }> {
  const watched = await ctx.db.findMany("watched_object", {
    where: params.status ? { status: params.status } : undefined,
    limit: params.limit ?? 200,
  })
  return { watched }
}

/** List monitor terms. */
export async function monitorTermsList(
  _params: Record<string, never>,
  ctx: SocialToolCtx,
): Promise<{ terms: unknown[] }> {
  const terms = await ctx.db.findMany("monitor_term", { limit: 500 })
  return { terms }
}

/** Sidebar badge counts, on the derived finding status (pending.ts). */
type CountKey = "findings_new" | "awaiting_approval" | "open_dms"
type Counts = Record<CountKey, number> & {
  /** The three counts as rows (`key` = the count's name): the list a dashboard block charts. */
  rows: Array<{ key: CountKey; value: number }>
}

function withRows(c: Record<CountKey, number>): Counts {
  return {
    ...c,
    rows: [
      { key: "findings_new", value: c.findings_new },
      { key: "awaiting_approval", value: c.awaiting_approval },
      { key: "open_dms", value: c.open_dms },
    ],
  }
}

export async function countsRead(
  _params: Record<string, never>,
  ctx: SocialToolCtx,
): Promise<Counts> {
  const [storedNew, staleAwaiting, open_dms, pending] = await Promise.all([
    ctx.db.count("finding", { where: { status: "new" } }),
    ctx.db.findMany("finding", { where: { status: "awaiting_approval" }, limit: 500 }),
    ctx.db.count("dm_conversation", { where: { status: "open" } }),
    pendingFindingApprovals(ctx),
  ])
  if (!pending) {
    const awaiting_approval = await ctx.db.count("finding", { where: { status: "awaiting_approval" } })
    return withRows({ findings_new: storedNew, awaiting_approval, open_dms })
  }
  const targeted = await loadTargeted(ctx, pending)
  const awaiting_approval = targeted.filter((r) => derivedFindingStatus(r, pending) === "awaiting_approval").length
  const newFromStale = (staleAwaiting as Array<{ id?: unknown; status?: unknown }>).filter(
    (r) => derivedFindingStatus(r, pending) === "new",
  ).length
  const newNowAwaiting = targeted.filter(
    (r) => r.status === "new" && derivedFindingStatus(r, pending) !== "new",
  ).length
  return withRows({ findings_new: storedNew + newFromStale - newNowAwaiting, awaiting_approval, open_dms })
}

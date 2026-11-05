// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Attention provider (§4.5 / §5). The kernel attention aggregator invokes this
// per org and merges the result into the unified feed. We map social rows to
// AttentionItems of three kinds:
//   - `mention`            — a triaged finding that should get a reply
//   - `approval_pending`   — a finding awaiting a human approve decision
//   - `dm_window_closing`  — a DM whose platform reply window closes within 12h
// Capped at 200 (the kernel also caps, but we cap first to bound the work).
//
// AttentionItem mirrors @liaison/shared's shape structurally — bundled apps may
// only import @liaison/app-sdk, so the shape is declared locally and validated
// by the kernel at runtime.

import type { SocialToolCtx } from "./ctx"
import { pendingFindingApprovals, withLiveApprovalState } from "./pending"
import { dmWindowTag } from "./dm-window"

type AttentionAction =
  | { type: "open_entity"; tabType: string; entityId: string }
  | { type: "decide_approval"; approvalId: string }

export interface SocialAttentionItem {
  id: string
  app: string
  entity: string
  entityId: string
  kind: "mention" | "approval_pending" | "dm_window_closing"
  summary: string
  urgency: number
  occurredAt: string
  action: AttentionAction
  metadata?: Record<string, unknown>
}

const ITEM_CAP = 200
const CLOSING_THRESHOLD_MS = 12 * 3_600_000 // surface a DM within 12h of window close
const SEVEN_DAYS_MS = 7 * 24 * 3_600_000

interface FindingRow {
  id: string
  platform: string
  status: string
  should_reply?: boolean | null
  urgency?: number | null
  content_text?: string | null
  occurred_at?: string | null
  approval_request_id?: string | null
}

interface ConversationRow {
  id: string
  platform: string
  participant_handle?: string | null
  last_inbound_at?: string | null
  status: string
}

/**
 * Compute the social attention items for `(orgId, userId)`. The ctx.db is RLS-
 * scoped so no manual org filtering is needed. `now` is injectable for tests.
 */
export async function computeSocialAttention(
  ctx: SocialToolCtx,
  _orgId: string,
  _userId: string,
  now: Date = new Date(),
): Promise<SocialAttentionItem[]> {
  const items: SocialAttentionItem[] = []

  // M3: only the two statuses that surface as attention (triaged needs-reply +
  // awaiting_approval) are queried, ordered by urgency, and capped at the
  // provider limit IN THE QUERY — so a viral spike doesn't materialize every
  // finding before slicing.
  // The awaiting set is derived from the live approvals (pending.ts) when the
  // host exposes them: the findings a pending reply/like targets, so a denied
  // or expired request drops out, and a parked agent call shows up.
  const pending = await pendingFindingApprovals(ctx)
  const [needsReply, awaiting] = await Promise.all([
    ctx.db.findMany("finding", {
      where: { status: "triaged" },
      orderBy: { urgency: "desc" },
      limit: ITEM_CAP,
    }) as Promise<FindingRow[]>,
    pending
      ? Promise.all([...pending.keys()].slice(0, ITEM_CAP).map((id) => ctx.db.findOne("finding", id))).then((rows) =>
          (rows.filter((r) => !!r && typeof r === "object") as FindingRow[])
            .map((r) => withLiveApprovalState(r, pending))
            .filter((r) => r.status === "awaiting_approval")
            .sort((a, b) => (b.urgency ?? 0) - (a.urgency ?? 0)),
        )
      : (ctx.db.findMany("finding", {
          where: { status: "awaiting_approval" },
          orderBy: { urgency: "desc" },
          limit: ITEM_CAP,
        }) as Promise<FindingRow[]>),
  ])
  for (const f of needsReply) {
    if (f.should_reply !== true) continue
    if (pending?.has(f.id)) continue
    items.push({
      id: `social-mention-${f.id}`,
      app: "social",
      entity: "finding",
      entityId: f.id,
      kind: "mention",
      summary: f.content_text ? `Reply suggested: ${f.content_text.slice(0, 80)}` : "A finding needs a reply",
      urgency: f.urgency ?? 50,
      occurredAt: f.occurred_at ?? now.toISOString(),
      action: { type: "open_entity", tabType: "findings", entityId: f.id },
    })
  }
  for (const f of awaiting) {
    items.push({
      id: `social-approval-${f.id}`,
      app: "social",
      entity: "finding",
      entityId: f.id,
      kind: "approval_pending",
      summary: "A drafted reply is awaiting your approval",
      urgency: f.urgency ?? 70,
      occurredAt: f.occurred_at ?? now.toISOString(),
      // M2 / §5: when the finding carries an approval_request_id, the item
      // routes straight to the decision (decide_approval); otherwise it opens
      // the finding (the detail pane is the approval surface).
      action: f.approval_request_id
        ? { type: "decide_approval", approvalId: f.approval_request_id }
        : { type: "open_entity", tabType: "findings", entityId: f.id },
    })
  }

  const conversations = (await ctx.db.findMany("dm_conversation", { where: { status: "open" } })) as ConversationRow[]
  for (const c of conversations) {
    if (!c.last_inbound_at) continue
    const tag = dmWindowTag(c.last_inbound_at, now)
    if (tag === "closed") continue
    // Surface only when the 7d HUMAN_AGENT window is within the closing threshold.
    const inboundMs = Date.parse(c.last_inbound_at)
    if (Number.isNaN(inboundMs)) continue
    const msUntilClose = SEVEN_DAYS_MS - (now.getTime() - inboundMs)
    if (msUntilClose <= CLOSING_THRESHOLD_MS && msUntilClose > 0) {
      items.push({
        id: `social-dm-closing-${c.id}`,
        app: "social",
        entity: "dm_conversation",
        entityId: c.id,
        kind: "dm_window_closing",
        summary: `Reply window closing for ${c.participant_handle ?? "a conversation"}`,
        urgency: 85,
        occurredAt: c.last_inbound_at,
        action: { type: "open_entity", tabType: "messages", entityId: c.id },
      })
    }
  }

  return items.slice(0, ITEM_CAP)
}

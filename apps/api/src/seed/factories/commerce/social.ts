// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The social listening factory: the watched posts, the findings the feed
// collected and triaged, the direct message conversations, the monitor terms
// and the per-account sync state a social listening app shows.
//
// Privileged: the app's poller and triage jobs write these rows over time
// from live platform APIs; a seeded org has no connected account, so the rows
// go in over the system connection through the app-table writer.
import { withSystemDb } from "~/db/privileged"
import type { SeedContext } from "~/seed/context"
import { iso, jsonCell, shiftTime, upsertAppRow } from "../app-tables"

export type SocialPlatform = "facebook" | "instagram" | "youtube"

export interface WatchedSpec {
  key: string
  platform: SocialPlatform
  objectType: "youtube_video" | "instagram_media" | "facebook_post"
  title: string
  reason: "auto_hot" | "manual"
  status: "active" | "decayed" | "stopped"
  priority: number
  newFindings: number
  lastActivityHoursAgo: number
}

export interface FindingSpec {
  key: string
  platform: SocialPlatform
  relation: string
  authorHandle: string
  content: string
  hoursAgo: number
  status: string
  triageCategory: string | null
  sentiment: string | null
  urgency: number | null
  shouldReply: boolean | null
  needsHuman: boolean | null
  suggestedReply?: string
  /**
   * An agent drafted `suggestedReply` and staged it through the gated
   * `social:reply_to_finding`, which is still waiting on a decision. The kernel
   * parks a gated call before the handler runs, so the finding itself stays as
   * it was stored (`new`) and reads `awaiting_approval` only through the
   * pending approval that targets it (bundled-apps/social/src/pending.ts). The
   * seed writes that approval, never the status.
   */
  pendingReply?: boolean
  brandRelevant: boolean
  commentCount?: number
  watched?: string
}

export interface DmSpec {
  key: string
  platform: "facebook" | "instagram"
  participantHandle: string
  displayName: string
  status: "open" | "awaiting_approval" | "snoozed" | "archived" | "handled"
  unread: number
  messages: { direction: "inbound" | "outbound"; body: string; hoursAgo: number }[]
  suggestedReply?: string
}

export interface MonitorTermSpec {
  key: string
  kind: "keyword" | "handle" | "hashtag"
  value: string
  platform?: SocialPlatform
  notes?: string
}

export interface SyncStateSpec {
  key: string
  platform: SocialPlatform
  account: string
  sourceType: "discovery" | "watch" | "dm"
  units: number
  lastSyncedHoursAgo: number
}

export interface SocialFeedInput {
  watched: readonly WatchedSpec[]
  findings: readonly FindingSpec[]
  dms: readonly DmSpec[]
  monitorTerms: readonly MonitorTermSpec[]
  syncStates: readonly SyncStateSpec[]
}

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

/** A finding's row id, so an approval that targets it can name it. */
export function findingId(ctx: SeedContext, key: string): string {
  return ctx.id("finding", key)
}

export async function seedSocialFeed(ctx: SeedContext, input: SocialFeedInput): Promise<void> {
  const { orgId, now } = ctx
  await withSystemDb("seed-social-feed", async (tx) => {
    for (const w of input.watched) {
      const lastActivity = shiftTime(now, 0, -w.lastActivityHoursAgo)
      await upsertAppRow(tx, "social", "watched_object", {
        id: ctx.id("watched_object", w.key),
        org_id: orgId,
        platform: w.platform,
        object_type: w.objectType,
        external_id: `demo-${w.key}`,
        title: w.title,
        permalink: null,
        reason: w.reason,
        status: w.status,
        cadence_seconds: 3600,
        priority: w.priority,
        comment_cursor: null,
        last_polled_at: iso(shiftTime(now, 0, -1)),
        last_activity_at: iso(lastActivity),
        next_poll_at: iso(shiftTime(now, 0, 1)),
        watched_by: null,
        new_findings_count: w.newFindings,
        metadata: jsonCell({}),
        created_at: iso(shiftTime(now, -30)),
        updated_at: iso(lastActivity),
      })
    }

    for (const f of input.findings) {
      const occurredAt = shiftTime(now, 0, -f.hoursAgo)
      await upsertAppRow(tx, "social", "finding", {
        id: findingId(ctx, f.key),
        org_id: orgId,
        platform: f.platform,
        external_id: `demo-${f.key}`,
        relation: f.relation,
        parent_external_id: null,
        watched_object_id: f.watched ? ctx.id("watched_object", f.watched) : null,
        contact_id: null,
        author_handle: f.authorHandle,
        author_external_id: `demo-author-${slug(f.authorHandle)}`,
        content_text: f.content,
        media_url: null,
        permalink: null,
        occurred_at: iso(occurredAt),
        comment_count: f.commentCount ?? 0,
        brand_relevant: f.brandRelevant,
        edited_after_reply: false,
        triage_category: f.triageCategory,
        sentiment: f.sentiment,
        urgency: f.urgency,
        should_reply: f.shouldReply,
        needs_human: f.needsHuman,
        triage_reason:
          f.triageCategory === null
            ? null
            : `Classified as ${f.triageCategory} from the message text.`,
        suggested_reply: f.suggestedReply ?? null,
        approval_request_id: null,
        status: f.status,
        metadata: jsonCell({}),
        created_at: iso(occurredAt),
        updated_at: iso(occurredAt),
      })
    }

    for (const d of input.dms) {
      const conversationId = ctx.id("dm_conversation", d.key)
      const sorted = [...d.messages].sort((a, b) => b.hoursAgo - a.hoursAgo)
      const first = sorted[0]
      const last = sorted[sorted.length - 1]
      if (!first || !last) throw new Error(`social seed: dm ${d.key} has no message`)
      const lastInbound = [...sorted].reverse().find((m) => m.direction === "inbound")
      await upsertAppRow(tx, "social", "dm_conversation", {
        id: conversationId,
        org_id: orgId,
        platform: d.platform,
        external_id: `demo-${d.key}`,
        contact_id: null,
        participant_handle: d.participantHandle,
        participant_external_id: `demo-participant-${slug(d.participantHandle)}`,
        participant_display_name: d.displayName,
        last_inbound_at: lastInbound ? iso(shiftTime(now, 0, -lastInbound.hoursAgo)) : null,
        last_message_at: iso(shiftTime(now, 0, -last.hoursAgo)),
        last_message_snippet: last.body.slice(0, 160),
        unread_count: d.unread,
        status: d.status,
        suggested_reply: d.suggestedReply ?? null,
        approval_request_id: null,
        metadata: jsonCell({}),
        created_at: iso(shiftTime(now, 0, -first.hoursAgo)),
        updated_at: iso(shiftTime(now, 0, -last.hoursAgo)),
      })
      let index = 1
      for (const m of sorted) {
        const at = shiftTime(now, 0, -m.hoursAgo)
        await upsertAppRow(tx, "social", "dm_message", {
          id: ctx.id("dm_message", `${d.key}|${index}`),
          org_id: orgId,
          conversation_id: conversationId,
          external_id: `demo-${d.key}-${index}`,
          direction: m.direction,
          author_external_id:
            m.direction === "inbound"
              ? `demo-participant-${slug(d.participantHandle)}`
              : "demo-brand",
          body: m.body,
          attachments: jsonCell([]),
          sent_via_tag: m.direction === "outbound" ? "none" : null,
          delivery_status: m.direction === "outbound" ? "sent" : "received",
          approval_request_id: null,
          occurred_at: iso(at),
          metadata: jsonCell({}),
          created_at: iso(at),
          updated_at: iso(at),
        })
        index++
      }
    }

    for (const t of input.monitorTerms) {
      await upsertAppRow(tx, "social", "monitor_term", {
        id: ctx.id("monitor_term", t.key),
        org_id: orgId,
        kind: t.kind,
        value: t.value,
        platform: t.platform ?? null,
        enabled: true,
        notes: t.notes ?? null,
        metadata: jsonCell({}),
        created_at: iso(shiftTime(now, -90)),
        updated_at: iso(shiftTime(now, -90)),
      })
    }

    for (const s of input.syncStates) {
      const lastSynced = shiftTime(now, 0, -s.lastSyncedHoursAgo)
      await upsertAppRow(tx, "social", "sync_state", {
        id: ctx.id("sync_state", s.key),
        org_id: orgId,
        platform: s.platform,
        account_external_id: s.account,
        source_type: s.sourceType,
        cursor: null,
        active: true,
        units_consumed_today: s.units,
        units_window_date: iso(now).slice(0, 10),
        last_synced_at: iso(lastSynced),
        metadata: jsonCell({}),
        created_at: iso(shiftTime(now, -90)),
        updated_at: iso(lastSynced),
      })
    }
  })
}

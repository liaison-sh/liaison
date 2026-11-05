// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The attention factory: what reached a person's Home over the last days
// (`kernel.attention_events`), some of it read, and the deliveries the router
// logged for it (`kernel.notification_deliveries`).
//
// Every other seed is silent on purpose (`SEEDED_METADATA`), so the attention
// a person sees is written here. The row is built by the translator's own
// `buildAttentionRow`-shaped columns (kind, urgency, digest state and
// eligibility), and written by a privileged raw insert, by category: history
// (attention read state). The translator's insert dedupes unread rows only and
// stamps no id, so a re-run would add read rows again; here every row has a
// deterministic id and a re-run rewrites nothing.
import { withPrivilegedDb } from "~/db/privileged"
import { attentionEvents } from "~/db/schema/kernel/attention-events"
import {
  type DeliverySurface,
  notificationDeliveries,
} from "~/db/schema/kernel/notification-deliveries"
import type { SeedContext } from "~/seed/context"

export interface AttentionEventSeed {
  key: string
  userId: string
  app: string
  entityType: string
  entityId: string
  kind: string
  urgency: number
  summary: string
  actorId: string | null
  actorType: "user" | "agent" | "system"
  metadata?: Record<string, unknown> | null
  occurredAt: Date
  /** When the person read it; null leaves it on their Home. */
  readAt: Date | null
}

export async function seedAttentionEvents(
  ctx: SeedContext,
  events: readonly AttentionEventSeed[],
): Promise<string[]> {
  if (events.length === 0) return []
  const rows = events.map((e) => ({
    id: ctx.id("attention-event", e.key),
    orgId: ctx.orgId,
    userId: e.userId,
    app: e.app,
    entityType: e.entityType,
    entityId: e.entityId,
    kind: e.kind,
    urgency: e.urgency,
    summary: e.summary,
    actorId: e.actorId,
    actorType: e.actorType,
    metadata: e.metadata ?? null,
    occurredAt: e.occurredAt,
    readAt: e.readAt,
    isUrgent: false,
    // A read row went out in no digest; an unread one waits for the next.
    digestState: e.readAt ? "suppressed" : "pending",
    digestEligibleAt: e.occurredAt,
    createdAt: e.occurredAt,
  }))
  await withPrivilegedDb(ctx.orgId, "seed-attention-events", (tx) =>
    tx.insert(attentionEvents).values(rows).onConflictDoNothing({ target: attentionEvents.id }),
  )
  return rows.map((r) => r.id)
}

export interface DeliverySeed {
  key: string
  userId: string
  /** The attention row the notification was about. */
  notificationId: string
  channel: "push" | "desktop" | "in_app" | "email"
  surface: DeliverySurface | null
  result: "accepted" | "no_device" | "suppressed"
  reason?: string | null
  attemptedAt: Date
}

export async function seedNotificationDeliveries(
  ctx: SeedContext,
  deliveries: readonly DeliverySeed[],
): Promise<string[]> {
  if (deliveries.length === 0) return []
  const rows = deliveries.map((d) => ({
    id: ctx.id("notification-delivery", d.key),
    orgId: ctx.orgId,
    userId: d.userId,
    notificationId: d.notificationId,
    deviceId: d.surface ? `seed-${d.surface}` : null,
    surface: d.surface,
    channel: d.channel,
    attemptedAt: d.attemptedAt,
    result: d.result,
    reason: d.reason ?? null,
    providerStatus: d.result === "accepted" && d.channel === "push" ? 200 : null,
    payload: null,
  }))
  await withPrivilegedDb(ctx.orgId, "seed-notification-deliveries", (tx) =>
    tx
      .insert(notificationDeliveries)
      .values(rows)
      .onConflictDoNothing({ target: notificationDeliveries.id }),
  )
  return rows.map((r) => r.id)
}

// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * QA-only notification routes (A11, F8), for the push matrix runner on demo.
 * They answer 404 unless `LIAISON_QA_ROUTES=1`, and the env guard refuses to
 * boot a non-demo production instance with the flag on.
 *
 *   POST /api/qa/notifications/inject { userId, kind, summary?, urgent? }
 *   GET  /api/qa/notifications/log?since=<iso>
 *
 * Raises a REAL item for `userId` (the caller, or anyone in the org for a
 * `kernel:users:admin` caller): `new_email` goes through the mail producer
 * (with a stand-in Gmail account, since the demo may have no synced mailbox);
 * any other non-chat kind is routed, written as an attention row and
 * dispatched like a producer's row. Answers the item's notificationId.
 * `urgent` marks a non-mail item urgent (it then breaks through quiet time).
 *
 * The log (T11) is what the matrix runner reads its verdicts from: the
 * caller's OWN delivery rows and receipts since a time (an admin's RLS handle
 * sees the org's rows, so the user filter is explicit). Payloads stay out.
 */
import { groupForKind } from "@liaison/shared"
import { and, asc, eq, gte } from "drizzle-orm"
import { Hono } from "hono"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { notificationDeliveries, notificationReceipts, users } from "~/db/schema/kernel"
import { withRequestRls } from "~/lib/request-rls"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import { defaultInsertAttentionRow } from "~/modules/attention/translator"
import { hasScope } from "~/modules/permissions/permissions"
import { dispatchAttentionLive, emailEnqueue, isAttentionLiveGroup } from "./dispatch"
import { NEW_EMAIL_KIND, processNewEmailEvent } from "./mail-producer"
import { notificationIdFor, resolveChannels } from "./router"

const injectSchema = z.object({
  userId: z.string().uuid(),
  kind: z.string().min(1).max(64),
  summary: z.string().max(200).optional(),
  urgent: z.boolean().optional(),
})

const logSchema = z.object({ since: z.string().datetime({ offset: true }) })

/** At most this many rows of each table per read: a matrix case raises a handful. */
const LOG_LIMIT = 500

export const qaNotificationRoutes = new Hono<AppEnv>()

qaNotificationRoutes.post("/inject", zValidator("json", injectSchema), async (c) => {
  const orgId = c.get("orgId")
  const callerId = c.get("userId")
  const { userId, kind, summary, urgent = false } = c.req.valid("json")
  if (userId !== callerId && !hasScope("kernel:users:admin", (c.get("scopes") ?? []) as string[])) {
    return c.json(
      { error: { message: "Only an admin can inject for someone else", code: "FORBIDDEN" } },
      403,
    )
  }
  // Membership, read as the caller: kernel.users is readable org wide.
  const [member] = await withRequestRls(c, (tx) =>
    tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, userId), eq(users.orgId, orgId)))
      .limit(1),
  )
  if (!member) return c.json({ error: { message: "No such user", code: "NOT_FOUND" } }, 404)

  if (kind === NEW_EMAIL_KIND) {
    let notifyId: string | null = null
    const messageId = crypto.randomUUID()
    await processNewEmailEvent(
      {
        app: "mail",
        entity: "message",
        action: "create",
        entityId: messageId,
        orgId,
        actorId: null,
        actorType: "system",
        data: {
          id: messageId,
          accountId: crypto.randomUUID(),
          origin: "incremental",
          direction: "inbound",
          labels: ["INBOX"],
          isRead: false,
          internalDate: Date.now(),
          from: { email: "qa-sender@liaison.test", name: "QA sender" },
        },
      } as Parameters<typeof processNewEmailEvent>[0],
      {
        loadAccount: async () => ({
          provider: "gmail",
          owner_type: "user",
          owner_id: userId,
          email_address: "qa-recipient@liaison.test",
          encryption_state: null,
          disconnected_at: null,
        }),
        dispatchLive: async (decision, item) => {
          notifyId = item.notifyId
          await dispatchAttentionLive(decision, item)
        },
      },
    )
    if (!notifyId) {
      return c.json(
        { error: { message: "The mail producer raised nothing", code: "NOT_RAISED" } },
        409,
      )
    }
    return success(c, { kind, notifyId, notificationId: notificationIdFor(userId, notifyId) })
  }

  const group = groupForKind(kind)
  if (!isAttentionLiveGroup(group)) {
    return c.json(
      {
        error: {
          message: "Chat kinds come from messages, not this route",
          code: "VALIDATION_ERROR",
        },
      },
      400,
    )
  }
  const now = new Date()
  const entityId = crypto.randomUUID()
  const text = summary ?? `QA ${kind}`
  const decision = await resolveChannels(
    { userId, orgId },
    { kind, app: "kernel", entityType: "qa", entityId, isUrgent: urgent },
    { now },
  )
  const stored = await defaultInsertAttentionRow({
    orgId,
    userId,
    app: "kernel",
    entityType: "qa",
    entityId,
    kind,
    urgency: 50,
    summary: text,
    actorId: callerId,
    actorType: "user",
    metadata: { qa: true },
    occurredAt: now,
    isUrgent: urgent,
    ...emailEnqueue(decision, now),
  })
  const notifyId = `attention:${stored ? stored.id : entityId}`
  await dispatchAttentionLive(decision, {
    notifyId,
    summary: text,
    app: "kernel",
    entityType: "qa",
    entityId,
  })
  return success(c, { kind, notifyId, notificationId: notificationIdFor(userId, notifyId) })
})

qaNotificationRoutes.get("/log", zValidator("query", logSchema), async (c) => {
  const userId = c.get("userId")
  const since = new Date(c.req.valid("query").since)
  const { deliveries, receipts } = await withRequestRls(c, async (tx) => ({
    deliveries: await tx
      .select({
        id: notificationDeliveries.id,
        notificationId: notificationDeliveries.notificationId,
        deviceId: notificationDeliveries.deviceId,
        surface: notificationDeliveries.surface,
        channel: notificationDeliveries.channel,
        result: notificationDeliveries.result,
        reason: notificationDeliveries.reason,
        providerStatus: notificationDeliveries.providerStatus,
        attemptedAt: notificationDeliveries.attemptedAt,
      })
      .from(notificationDeliveries)
      .where(
        and(
          eq(notificationDeliveries.userId, userId),
          gte(notificationDeliveries.attemptedAt, since),
        ),
      )
      .orderBy(asc(notificationDeliveries.attemptedAt))
      .limit(LOG_LIMIT),
    receipts: await tx
      .select({
        id: notificationReceipts.id,
        notificationId: notificationReceipts.notificationId,
        deviceId: notificationReceipts.deviceId,
        surface: notificationReceipts.surface,
        appState: notificationReceipts.appState,
        outcome: notificationReceipts.outcome,
        reason: notificationReceipts.reason,
        receivedAt: notificationReceipts.receivedAt,
        updatedAt: notificationReceipts.updatedAt,
      })
      .from(notificationReceipts)
      .where(
        and(eq(notificationReceipts.userId, userId), gte(notificationReceipts.updatedAt, since)),
      )
      .orderBy(asc(notificationReceipts.receivedAt))
      .limit(LOG_LIMIT),
  }))
  return success(c, {
    deliveries: deliveries.map((d) => ({ ...d, attemptedAt: d.attemptedAt.toISOString() })),
    receipts: receipts.map((r) => ({
      ...r,
      receivedAt: r.receivedAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    })),
  })
})

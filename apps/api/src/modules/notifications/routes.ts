// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Settings -> Notifications API (S8, S9). Self only: the grid, work hours and
 * digest cadence and approval reminder frequency of the signed-in user. Per-app rules and thread mute keep
 * their own routes (/api/attention/subscriptions, thread state).
 *
 * Also (etiquette rule 10): GET /conversations lists the caller's muted
 * conversations and the channels they set to every post; GET/PUT /on-call
 * reads and (admins only) sets who is on call for incidents (on-call.ts).
 */
import { APPROVAL_REMINDER_FREQUENCIES } from "@liaison/shared"
import { sql } from "drizzle-orm"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { withRequestRls } from "~/lib/request-rls"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import { hasScope } from "~/modules/permissions/permissions"
import { readBadge, SETTLE_KEYS_MAX } from "~/modules/push/badge-count"
import { loadOnCall, ON_CALL_DEFAULT_SCOPE, ON_CALL_SETTINGS_KEY } from "./on-call"
import {
  DIGEST_CADENCES,
  getNotificationSettings,
  NotificationSettingsError,
  updateNotificationSettings,
} from "./settings"

// Shape only: group and channel names, in_app, days and timezones are checked
// by `validatePatch` so the error names the offending key.
const patchSchema = z
  .object({
    grid: z.record(z.string(), z.record(z.string(), z.boolean())).optional(),
    workHours: z
      .object({
        start: z.string().optional(),
        end: z.string().optional(),
        days: z.array(z.number().int()).max(7).optional(),
        timezone: z.string().optional(),
        explicit: z.boolean().optional(),
      })
      .strict()
      .optional(),
    digestCadence: z.enum(DIGEST_CADENCES).optional(),
    approvalReminder: z.enum(APPROVAL_REMINDER_FREQUENCIES).optional(),
    timezone: z.string().optional(),
    mutedGroups: z.record(z.string(), z.boolean()).optional(),
    detectedTimezone: z.string().optional(),
  })
  .strict()

const onCallSchema = z.object({ userIds: z.array(z.string().uuid()).max(200) }).strict()

const K = sql.raw(schemaRef("kernel"))

export const notificationSettingsRoutes = new Hono<AppEnv>()

/**
 * THE badge (rule 6): the number the phone, the desktop dock, the browser tab
 * and Home show, counted by the shared `countBadge`.
 */
notificationSettingsRoutes.get("/badge", async (c) => {
  const reading = await readBadge(c.get("userId"), c.get("orgId"))
  return success(c, { count: reading.count })
})

const settleSchema = z
  .object({ settle: z.array(z.string().max(300)).max(SETTLE_KEYS_MAX) })
  .strict()

/**
 * The badge plus, of the settle keys the phone's delivered notifications
 * carry, the ones read or resolved (rule 5): the phone withdraws exactly those
 * on its foreground and keeps every other notification.
 */
notificationSettingsRoutes.post("/badge", zValidator("json", settleSchema), async (c) => {
  const { settle } = c.req.valid("json")
  return success(c, await readBadge(c.get("userId"), c.get("orgId"), settle))
})

notificationSettingsRoutes.get("/settings", async (c) => {
  const userId = c.get("userId")
  const orgId = c.get("orgId")
  const result = await withRequestRls(c, (tx) => getNotificationSettings(userId, orgId, tx))
  return success(c, result)
})

notificationSettingsRoutes.patch("/settings", zValidator("json", patchSchema), async (c) => {
  const userId = c.get("userId")
  const orgId = c.get("orgId")
  const patch = c.req.valid("json")
  try {
    const result = await withRequestRls(c, (tx) =>
      updateNotificationSettings(userId, orgId, patch, tx),
    )
    return success(c, result)
  } catch (err) {
    if (err instanceof NotificationSettingsError) {
      return c.json({ error: { message: err.message, code: "VALIDATION_ERROR" } }, 400)
    }
    throw err
  }
})

interface ConversationRow {
  thread_id: string
  title: string | null
  type: string
  is_muted: boolean
  notify_all_posts: boolean
}

/**
 * The caller's muted conversations and the channels they set to every post,
 * read under their own RLS (a conversation they can no longer see drops out).
 */
notificationSettingsRoutes.get("/conversations", async (c) => {
  const userId = c.get("userId")
  const rows = await withRequestRls(c, async (tx) => {
    return (await tx.execute(
      sql`SELECT s.thread_id, t.title, t.type, s.is_muted, s.notify_all_posts
            FROM ${K}.user_thread_state s
            JOIN ${K}.threads t ON t.id = s.thread_id
           WHERE s.user_id = ${userId} AND (s.is_muted OR s.notify_all_posts)
           ORDER BY t.title NULLS LAST, s.thread_id
           LIMIT 500`,
    )) as unknown as ConversationRow[]
  })
  const view = (r: ConversationRow) => ({ threadId: r.thread_id, title: r.title, type: r.type })
  return success(c, {
    muted: rows.filter((r) => r.is_muted).map(view),
    allPosts: rows.filter((r) => r.notify_all_posts && !r.is_muted).map(view),
  })
})

async function onCallResponse(orgId: string, canEdit: boolean) {
  return withPrivilegedDb(orgId, "notifications:on-call-read", async (tx) => {
    const view = await loadOnCall(tx, orgId)
    const members = canEdit
      ? ((await tx.execute(
          sql`SELECT id, name, email FROM ${K}.users
               WHERE org_id = ${orgId} AND status = 'active'
               ORDER BY name NULLS LAST, email`,
        )) as unknown as Array<{ id: string; name: string | null; email: string }>)
      : []
    const names = (await tx.execute(
      view.userIds.length > 0
        ? sql`SELECT id, name, email FROM ${K}.users
               WHERE org_id = ${orgId} AND id::text IN (${sql.join(
                 view.userIds.map((id) => sql`${id}`),
                 sql`, `,
               )})`
        : sql`SELECT NULL::uuid AS id, NULL AS name, NULL AS email WHERE false`,
    )) as unknown as Array<{ id: string; name: string | null; email: string }>
    return {
      source: view.source,
      onCall: names.map((u) => ({ id: u.id, name: u.name ?? u.email })),
      canEdit,
      members: members.map((u) => ({ id: u.id, name: u.name ?? u.email })),
    }
  })
}

/** Who is on call for incidents; every member may read it, admins get the member list. */
notificationSettingsRoutes.get("/on-call", async (c) => {
  const canEdit = hasScope(ON_CALL_DEFAULT_SCOPE, c.get("scopes") ?? [])
  return success(c, await onCallResponse(c.get("orgId"), canEdit))
})

/** Set who is on call (admins only). An empty list puts the admins back on call. */
notificationSettingsRoutes.put("/on-call", zValidator("json", onCallSchema), async (c) => {
  if (!hasScope(ON_CALL_DEFAULT_SCOPE, c.get("scopes") ?? [])) {
    throw new HTTPException(403, { message: "Only an admin can change who is on call" })
  }
  const orgId = c.get("orgId")
  const ids = [...new Set(c.req.valid("json").userIds)]
  await withPrivilegedDb(orgId, "notifications:on-call-write", async (tx) => {
    if (ids.length > 0) {
      const found = (await tx.execute(
        sql`SELECT id FROM ${K}.users
             WHERE org_id = ${orgId} AND status = 'active' AND id::text IN (${sql.join(
               ids.map((id) => sql`${id}`),
               sql`, `,
             )})`,
      )) as unknown as Array<{ id: string }>
      if (found.length !== ids.length) {
        throw new HTTPException(400, { message: "Every on-call person must be an active member" })
      }
    }
    await tx.execute(
      sql`UPDATE ${K}.organizations
             SET settings = COALESCE(settings, '{}'::jsonb) || ${JSON.stringify({
               [ON_CALL_SETTINGS_KEY]: ids,
             })}::jsonb,
                 updated_at = now()
           WHERE id = ${orgId}`,
    )
  })
  return success(c, await onCallResponse(orgId, true))
})

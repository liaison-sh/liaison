// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 16 Task A8a — REST surface for `kernel.attention_subscriptions`.
//
// `GET /api/attention/subscriptions`
// `POST /api/attention/subscriptions`            { source, kinds, filters, enabled }
// `PUT /api/attention/subscriptions/:id`         (full replace; same body)
// `DELETE /api/attention/subscriptions/:id`
//
// All routes are user-scoped via RLS (the policy keys on `app.user_id`).

import { and, eq } from "drizzle-orm"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { attentionSubscriptions } from "~/db/schema/kernel"
import { withRequestRls } from "~/lib/request-rls"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import { deleteRule, listForUser, upsertRule } from "~/modules/attention/subscriptions"

export const attentionSubscriptionsRoutes = new Hono<AppEnv>()

// Source identifier (e.g. "shopify", "mail", "*"). Lowercase alphanumerics +
// dash/underscore; "*" is the special "all sources" sentinel used by
// default-on / global rules.
const sourceSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^(\*|[a-z][a-z0-9_-]*)$/, "source must be lowercase alphanumeric or '*'")

const ruleBodySchema = z.object({
  source: sourceSchema,
  kinds: z.array(z.string().min(1).max(128)).max(64),
  filters: z.record(z.string(), z.array(z.string()).max(64)).default({}),
  enabled: z.boolean(),
})

attentionSubscriptionsRoutes.get("/", async (c) => {
  const userId = c.get("userId")
  const rows = await withRequestRls(c, (tx) => listForUser(tx, userId))
  return success(c, rows)
})

attentionSubscriptionsRoutes.post("/", zValidator("json", ruleBodySchema), async (c) => {
  const userId = c.get("userId")
  const body = c.req.valid("json")
  try {
    const out = await withRequestRls(c, (tx) =>
      upsertRule(tx, userId, {
        source: body.source,
        kinds: body.kinds,
        filters: body.filters,
        enabled: body.enabled,
      }),
    )
    return success(c, out, undefined, 201)
  } catch (err) {
    // Postgres unique_violation surfaces through drizzle/postgres.js with code 23505.
    if ((err as { cause?: { code?: string } })?.cause?.code === "23505") {
      throw new HTTPException(409, {
        message: `Subscription rule for source "${body.source}" already exists — use PUT to update.`,
      })
    }
    throw err
  }
})

attentionSubscriptionsRoutes.put("/:id", zValidator("json", ruleBodySchema), async (c) => {
  const id = c.req.param("id")
  const userId = c.get("userId")
  const body = c.req.valid("json")
  try {
    const result = await withRequestRls(c, async (tx) => {
      // Drizzle update + returning, scoped to the calling user under RLS.
      const out = await tx
        .update(attentionSubscriptions)
        .set({
          source: body.source,
          kinds: body.kinds,
          filters: body.filters,
          enabled: body.enabled,
          updatedAt: new Date(),
        })
        .where(and(eq(attentionSubscriptions.id, id), eq(attentionSubscriptions.userId, userId)))
        .returning({ id: attentionSubscriptions.id })
      return out
    })
    if (result.length === 0) {
      throw new HTTPException(404, { message: "Subscription rule not found" })
    }
    return success(c, { id })
  } catch (err) {
    if (err instanceof HTTPException) throw err
    if ((err as { cause?: { code?: string } })?.cause?.code === "23505") {
      throw new HTTPException(409, {
        message: `A subscription rule for source "${body.source}" already exists on another rule — use that rule's id.`,
      })
    }
    throw err
  }
})

attentionSubscriptionsRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id")
  const userId = c.get("userId")
  const out = await withRequestRls(c, (tx) => deleteRule(tx, userId, id))
  if (!out.deleted) {
    throw new HTTPException(404, { message: "Subscription rule not found" })
  }
  return success(c, { deleted: true })
})

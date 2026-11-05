// SPDX-License-Identifier: FSL-1.1-ALv2
import { and, eq } from "drizzle-orm"
import { Hono } from "hono"
import { withSystemDb } from "~/db/privileged"
import { creditTransactions, organizations } from "~/db/schema/kernel"
import { zValidator } from "~/lib/validate"
import { requireControlPlaneAuth } from "~/middleware/control-plane-auth"
import {
  addCredits,
  IdempotencyConflictError,
  resetMonthlyCredits,
  tierAllowanceFor,
} from "~/modules/agent/credits/credit-service"
import { ResetSchema, TierSchema, TopUpSchema } from "./schemas"

export function createBillingAdminRoutes(apiKey: string | undefined) {
  const app = new Hono()
  app.use("*", requireControlPlaneAuth(apiKey))

  app.post("/credits", zValidator("json", TopUpSchema), async (c) => {
    const { orgId, amountCredits, externalPaymentRef } = c.req.valid("json")
    try {
      const r = await addCredits(orgId, {
        amount: amountCredits,
        type: "top_up",
        externalPaymentRef,
      })
      const [tx] = await withSystemDb("billing-admin-find-tx", (db) =>
        db
          .select({ id: creditTransactions.id })
          .from(creditTransactions)
          .where(
            and(
              eq(creditTransactions.orgId, orgId),
              eq(creditTransactions.externalPaymentRef, externalPaymentRef),
            ),
          )
          .limit(1),
      )
      return c.json({ data: { transactionId: tx?.id ?? null, balanceAfter: r.balanceAfter } })
    } catch (e) {
      if (e instanceof IdempotencyConflictError) {
        return c.json(
          {
            error: {
              code: "idempotency_conflict",
              message: e.message,
              diff: e.diff,
            },
          },
          409,
        )
      }
      throw e
    }
  })

  app.post("/credits/reset", zValidator("json", ResetSchema), async (c) => {
    const { orgId, cycleId } = c.req.valid("json")

    // Idempotent on (orgId, cycleId). If a reset row for this cycle already
    // exists, return the stored balance instead of recomputing the allowance
    // from the *current* tier — if the tier changed after the first reset,
    // recomputing would yield a different amount and cascade into a 409
    // idempotency_conflict for a replay whose request body is unchanged.
    const existing = await withSystemDb("billing-admin-reset-check", async (db) => {
      const row = await db
        .select({ balanceAfter: creditTransactions.balanceAfter })
        .from(creditTransactions)
        .where(and(eq(creditTransactions.orgId, orgId), eq(creditTransactions.cycleId, cycleId)))
        .limit(1)
      return row[0]
    })
    if (existing) {
      return c.json({ data: { balanceAfter: existing.balanceAfter } })
    }

    const [org] = await withSystemDb("billing-admin-org-lookup", (db) =>
      db
        .select({ tier: organizations.tier })
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .limit(1),
    )
    if (!org) {
      return c.json({ error: { message: "org not found", code: "not_found" } }, 404)
    }
    const allowance = tierAllowanceFor(org.tier)
    try {
      const r = await resetMonthlyCredits(orgId, cycleId, allowance)
      return c.json({ data: { balanceAfter: r.balanceAfter } })
    } catch (e) {
      // A concurrent reset for the same (orgId, cycleId) raced past the
      // pre-check. Fall back to the stored value so the contract stays
      // value-idempotent under concurrent control-plane replays.
      if (e instanceof IdempotencyConflictError) {
        const after = await withSystemDb("billing-admin-reset-recheck", async (db) => {
          const row = await db
            .select({ balanceAfter: creditTransactions.balanceAfter })
            .from(creditTransactions)
            .where(
              and(eq(creditTransactions.orgId, orgId), eq(creditTransactions.cycleId, cycleId)),
            )
            .limit(1)
          return row[0]
        })
        if (after) return c.json({ data: { balanceAfter: after.balanceAfter } })
      }
      throw e
    }
  })

  app.patch("/org/:orgId/tier", zValidator("json", TierSchema), async (c) => {
    const orgId = c.req.param("orgId")
    const { tier } = c.req.valid("json")
    const updated = await withSystemDb("billing-admin-set-tier", (db) =>
      db
        .update(organizations)
        .set({ tier, updatedAt: new Date() })
        .where(eq(organizations.id, orgId))
        .returning({ id: organizations.id }),
    )
    if (updated.length === 0) {
      return c.json({ error: { message: "org not found", code: "not_found" } }, 404)
    }
    return c.json({ data: { tier } })
  })

  return app
}

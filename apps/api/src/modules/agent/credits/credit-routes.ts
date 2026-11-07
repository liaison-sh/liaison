// SPDX-License-Identifier: FSL-1.1-ALv2
import { orgKernelSettingsSchema, TIER_ALLOWANCE } from "@liaison/shared"
import { and, desc, sql as drizzleSql, eq, gte, lt } from "drizzle-orm"
import { Hono } from "hono"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { creditTransactions, organizations, users } from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { isManagedEdition } from "~/lib/edition"
import { withRequestRls } from "~/lib/request-rls"
import { success } from "~/lib/response"
import { getOrgKernelSettings } from "~/lib/settings"
import { zValidator } from "~/lib/validate"
import { requireScope } from "~/middleware/require-scope"
import {
  listAvailableModels,
  resolveAutoModelKey,
  resolveAutoReasoningLevel,
} from "~/modules/agent/credits/credit-meter"
import { checkBalance } from "~/modules/agent/credits/credit-service"
import { managedBalance, SPEND_TYPES, withMultiplier } from "~/modules/agent/credits/managed-money"

// Cursor helpers — base64url encoding of "createdAt|id"
function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}|${id}`).toString("base64url")
}

function decodeCursor(cursor: string): { createdAt: string; id: string } | null {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString()
    const pipeIdx = decoded.indexOf("|")
    if (pipeIdx === -1) return null
    const createdAt = decoded.slice(0, pipeIdx)
    const id = decoded.slice(pipeIdx + 1)
    if (!createdAt || !id) return null
    return { createdAt, id }
  } catch {
    return null
  }
}

// The Usage settings section (web bootstrap `adminScope`) and the reads behind
// it share one gate. Balance and models stay open: the thread view reads them
// for every user.
const BILLING_READ_SCOPE = "kernel:billing:read"

function isAdmin(scopes: unknown[]): boolean {
  return scopes.some((s) => String(s) === "kernel:org:admin" || String(s) === "*")
}

export const creditRoutes = new Hono<AppEnv>()
  // Models the org can actually use (S6): native models of a keyed provider the
  // admin has not switched off, plus the org's enabled added models. Every
  // picker reads this list, so a model that would fail at send time is never
  // offered. `autoModelKey` is the admin's Auto setting (null = the automatic
  // rule), `autoResolvedKey` the model Auto runs right now and
  // `autoReasoningLevel` the level it runs it at (the model menu shows it).
  .get("/models", async (c) => {
    const orgId = c.get("orgId")
    const [models, autoResolvedKey, autoReasoningLevel, settings] = await Promise.all([
      listAvailableModels(orgId),
      resolveAutoModelKey(orgId),
      resolveAutoReasoningLevel(orgId),
      withPrivilegedDb(orgId, "credits-models-settings", (tx) =>
        getOrgKernelSettings(tx, orgId, orgKernelSettingsSchema),
      ),
    ])
    // Managed: a multiplier against Auto's model instead of prices (S18).
    const auto = models.find((m) => m.key === autoResolvedKey) ?? null
    return success(c, {
      autoModelKey: settings.ai?.models?.autoModelKey ?? null,
      autoResolvedKey,
      autoReasoningLevel,
      // The org's level for a turn that asks for none (null: built-in default).
      defaultReasoningLevel: settings.ai?.models?.defaultReasoningLevel ?? null,
      models: isManagedEdition() ? models.map((m) => withMultiplier(m, auto)) : models,
    })
  })
  .get("/balance", async (c) => {
    const orgId = c.get("orgId")
    // Managed: credits and the period's use, no currency (S18).
    if (isManagedEdition()) return success(c, await managedBalance(orgId))
    const result = await withRequestRls(c, async (tx) => {
      return checkBalance(tx, orgId)
    })

    const { tier, settings } = await withPrivilegedDb(orgId, "balance-org-lookup", async (tx) => {
      const [row] = await tx
        .select({ tier: organizations.tier })
        .from(organizations)
        .where(eq(organizations.id, orgId))
      const settings = await getOrgKernelSettings(tx, orgId, orgKernelSettingsSchema)
      return { tier: row?.tier, settings }
    })
    const resolvedTier = tier ?? "starter"

    const includedAllowance =
      resolvedTier === "enterprise"
        ? (settings.enterpriseAllowance ?? "0")
        : (TIER_ALLOWANCE[resolvedTier as keyof typeof TIER_ALLOWANCE] ?? TIER_ALLOWANCE.starter)

    const resetDate = settings.resetDate ?? null

    return success(c, {
      included: result.included,
      purchased: result.purchased,
      currency: result.currency,
      tier: resolvedTier,
      includedAllowance,
      resetDate,
    })
  })
  .get(
    "/transactions",
    requireScope(BILLING_READ_SCOPE),
    zValidator(
      "query",
      z.object({
        cursor: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(20),
        userId: z.string().uuid().optional(),
        model: z.string().optional(),
        type: z.string().optional(),
        dateFrom: z.string().optional(),
        dateTo: z.string().optional(),
      }),
    ),
    async (c) => {
      const orgId = c.get("orgId")
      const scopes = c.get("scopes")
      const currentUserId = c.get("userId")
      const { cursor, limit, userId, model, type, dateFrom, dateTo } = c.req.valid("query")

      const admin = isAdmin(scopes as unknown[])

      const result = await withPrivilegedDb(orgId, "list-transactions", async (tx) => {
        const conditions = [eq(creditTransactions.orgId, orgId)]

        if (!admin) {
          conditions.push(eq(creditTransactions.userId, currentUserId))
        } else if (userId) {
          conditions.push(eq(creditTransactions.userId, userId))
        }

        if (model) conditions.push(eq(creditTransactions.model, model))
        if (type) conditions.push(eq(creditTransactions.type, type))
        if (dateFrom) conditions.push(gte(creditTransactions.createdAt, new Date(dateFrom)))
        if (dateTo) {
          const endDate = new Date(dateTo)
          endDate.setDate(endDate.getDate() + 1)
          conditions.push(lt(creditTransactions.createdAt, endDate))
        }

        if (cursor) {
          const parsed = decodeCursor(cursor)
          if (parsed) {
            conditions.push(
              drizzleSql`(${creditTransactions.createdAt}, ${creditTransactions.id}) < (${parsed.createdAt}::timestamptz, ${parsed.id}::uuid)`,
            )
          }
        }

        const rows = await tx
          .select({
            id: creditTransactions.id,
            type: creditTransactions.type,
            amount: creditTransactions.amount,
            model: creditTransactions.model,
            inputTokens: creditTransactions.inputTokens,
            outputTokens: creditTransactions.outputTokens,
            userId: creditTransactions.userId,
            description: creditTransactions.description,
            createdAt: creditTransactions.createdAt,
          })
          .from(creditTransactions)
          .where(and(...conditions))
          .orderBy(desc(creditTransactions.createdAt), desc(creditTransactions.id))
          .limit(limit + 1)

        const hasMore = rows.length > limit
        const page = hasMore ? rows.slice(0, limit) : rows

        const userIds = [...new Set(page.map((r) => r.userId).filter(Boolean))] as string[]
        let userNameMap: Record<string, string> = {}
        if (userIds.length > 0) {
          const userRows = await tx
            .select({ id: users.id, name: users.name })
            .from(users)
            .where(
              drizzleSql`${users.id} IN (${drizzleSql.join(
                userIds.map((id) => drizzleSql`${id}::uuid`),
                drizzleSql`, `,
              )})`,
            )
          userNameMap = Object.fromEntries(userRows.map((u) => [u.id, u.name]))
        }

        const nextCursor =
          hasMore && page.length > 0
            ? encodeCursor(page[page.length - 1].createdAt.toISOString(), page[page.length - 1].id)
            : null

        const managed = isManagedEdition()
        return {
          // Managed: credits only, no per-row token counts (S18: the rate
          // could be derived from amount / tokens x list price).
          items: page.map((r) => ({
            id: r.id,
            type: r.type,
            amount: r.amount,
            model: r.model,
            ...(managed ? {} : { inputTokens: r.inputTokens, outputTokens: r.outputTokens }),
            userId: r.userId,
            userName: r.userId ? (userNameMap[r.userId] ?? null) : null,
            description: r.description,
            createdAt: r.createdAt.toISOString(),
          })),
          cursor: nextCursor,
          hasMore,
        }
      })

      return success(c, result)
    },
  )
  .get(
    "/usage",
    requireScope(BILLING_READ_SCOPE),
    zValidator(
      "query",
      z.object({
        period: z.enum(["daily", "weekly", "monthly"]),
        from: z.string(),
        to: z.string(),
        userId: z.string().uuid().optional(),
      }),
    ),
    async (c) => {
      const orgId = c.get("orgId")
      const currentUserId = c.get("userId")
      const scopes = c.get("scopes")
      const { period, from, to, userId } = c.req.valid("query")

      const admin = isAdmin(scopes as unknown[])
      const effectiveUserId = admin ? userId : currentUserId

      const result = await withPrivilegedDb(orgId, "usage-aggregation", async (tx) => {
        const k = drizzleSql.raw(schemaRef("kernel"))
        const truncPeriod = period === "daily" ? "day" : period === "weekly" ? "week" : "month"

        const fromDate = new Date(from)
        const toDate = new Date(to)
        toDate.setDate(toDate.getDate() + 1)

        const userFilter = effectiveUserId
          ? drizzleSql`AND user_id = ${effectiveUserId}::uuid`
          : drizzleSql``

        // Managed: only rows that spent credits (a BYOK monitoring row's amount is money).
        const managed = isManagedEdition()
        const types = drizzleSql.join(
          (managed ? [...SPEND_TYPES] : ["usage", "tool_usage", "byok_usage"]).map(
            (t) => drizzleSql`${t}`,
          ),
          drizzleSql`, `,
        )
        const rows = await tx.execute(drizzleSql`
          SELECT
            date_trunc(${truncPeriod}, created_at) AS bucket,
            model,
            SUM(ABS(amount::numeric)) AS cost
          FROM ${k}.credit_transactions
          WHERE org_id = ${orgId}::uuid
            AND type IN (${types})
            AND created_at >= ${fromDate.toISOString()}::timestamptz
            AND created_at < ${toDate.toISOString()}::timestamptz
            ${userFilter}
          GROUP BY bucket, model
          ORDER BY bucket ASC
        `)

        const rawRows = extractRows<{ bucket: Date | string; model: string | null; cost: string }>(
          rows,
        )

        const bucketMap = new Map<string, { total: number; models: Record<string, string> }>()
        let totalCost = 0

        for (const row of rawRows) {
          const bucketDate = row.bucket instanceof Date ? row.bucket : new Date(row.bucket)
          const dateKey = bucketDate.toISOString().split("T")[0]
          if (!bucketMap.has(dateKey)) {
            bucketMap.set(dateKey, { total: 0, models: {} })
          }
          const bucket = bucketMap.get(dateKey)!
          const cost = Number(row.cost)
          bucket.total += cost
          totalCost += cost
          const modelKey = row.model ?? "other"
          bucket.models[modelKey] = (Number(bucket.models[modelKey] ?? 0) + cost).toFixed(8)
        }

        const buckets = Array.from(bucketMap.entries()).map(([date, b]) => ({
          date,
          total: b.total.toFixed(8),
          models: b.models,
        }))
        if (managed)
          return { mode: "managed" as const, buckets, totalCredits: totalCost.toFixed(8) }
        return { buckets, totalCost: totalCost.toFixed(8) }
      })

      return success(c, result)
    },
  )

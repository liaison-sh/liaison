// SPDX-License-Identifier: FSL-1.1-ALv2

import { TIER_ALLOWANCE } from "@liaison/shared"
import { sql as drizzleSql, eq } from "drizzle-orm"
import { extractRows, type PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { creditBalances, creditTransactions } from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { rootLogger } from "~/lib/logger"

const log = rootLogger.child({ module: "credit-service" })

export async function initOrgCredits(
  orgId: string,
  currency: string,
  includedBalance: string,
  existingTx?: PrivilegedDb,
): Promise<void> {
  const row = {
    orgId,
    includedBalance,
    purchasedBalance: "0",
    currency,
  }

  if (existingTx) {
    await existingTx.insert(creditBalances).values(row)
    return
  }

  await withPrivilegedDb(orgId, "init-org-credits", (tx) => tx.insert(creditBalances).values(row))
}

export async function checkBalance(
  dbOrTx: { select: (...args: any[]) => any },
  orgId: string,
): Promise<{ allowed: boolean; included: string; purchased: string; currency: string }> {
  const [row] = await dbOrTx.select().from(creditBalances).where(eq(creditBalances.orgId, orgId))

  if (!row) {
    log.error({ orgId }, "No credit_balances row found for org")
    return { allowed: false, included: "0", purchased: "0", currency: "EUR" }
  }

  const total = Number(row.includedBalance) + Number(row.purchasedBalance)
  return {
    allowed: total > 0,
    included: row.includedBalance,
    purchased: row.purchasedBalance,
    currency: row.currency,
  }
}

interface DeductParams {
  model: string
  inputTokens: number
  outputTokens: number
  rawCost: string
  creditCost: string
  // Nullable: system-initiated usage (summarizer, scheduled jobs) has no real
  // user. `credit_transactions.user_id` is a nullable uuid, so a null records a
  // system actor rather than failing the uuid cast.
  userId: string | null
  /** What the row is for, when the model and tokens do not say (a transcription's seconds). */
  description?: string
}

async function atomicDeductBalance(
  tx: PrivilegedDb,
  orgId: string,
  amount: string,
): Promise<string> {
  const k = drizzleSql.raw(schemaRef("kernel"))
  // Both balances are floored at 0 (GREATEST). A single oversized deduction can
  // overshoot the available balance, but it must never drive a real negative
  // balance — the clamp caps the loss at the remaining balance, and the
  // purchased_balance >= 0 CHECK constraint backstops it.
  const result = await tx.execute(drizzleSql`
    UPDATE ${k}.credit_balances SET
      included_balance = CASE
        WHEN included_balance >= ${amount}::numeric(16,8)
        THEN included_balance - ${amount}::numeric(16,8)
        ELSE 0
      END,
      purchased_balance = CASE
        WHEN included_balance >= ${amount}::numeric(16,8)
        THEN purchased_balance
        ELSE GREATEST(purchased_balance - (${amount}::numeric(16,8) - included_balance), 0)
      END,
      updated_at = now()
    WHERE org_id = ${orgId}
    RETURNING included_balance + purchased_balance AS balance_after
  `)
  const rows = extractRows<{ balance_after: string }>(result)
  return rows[0]?.balance_after ?? "0"
}

export async function deductCredits(
  orgId: string,
  params: DeductParams,
): Promise<{ balanceAfter: string }> {
  const { creditCost, ...txnData } = params

  return withPrivilegedDb(orgId, "deduct-credits", async (tx) => {
    const balanceAfter = await atomicDeductBalance(tx, orgId, creditCost)

    await tx.insert(creditTransactions).values({
      orgId,
      userId: txnData.userId,
      type: "usage",
      amount: (Number.parseFloat(creditCost) * -1).toFixed(8),
      balanceAfter,
      model: txnData.model,
      inputTokens: txnData.inputTokens,
      outputTokens: txnData.outputTokens,
      rawCost: txnData.rawCost,
      ...(txnData.description ? { description: txnData.description } : {}),
    })

    return { balanceAfter }
  })
}

export async function deductToolUsageCost(
  orgId: string,
  params: { amount: string; description: string; userId?: string },
): Promise<{ balanceAfter: string }> {
  const { amount, description, userId } = params
  return withPrivilegedDb(orgId, "deduct-tool-usage", async (tx) => {
    const balanceAfter = await atomicDeductBalance(tx, orgId, amount)

    await tx.insert(creditTransactions).values({
      orgId,
      userId,
      type: "tool_usage",
      amount: (Number.parseFloat(amount) * -1).toFixed(8),
      balanceAfter,
      description,
    })

    return { balanceAfter }
  })
}

export interface AddCreditsParams {
  amount: string
  type: "top_up" | "monthly_reset" | "refund"
  description?: string
  externalPaymentRef?: string
  cycleId?: string
}

export class IdempotencyConflictError extends Error {
  readonly code = "idempotency_conflict"
  constructor(
    message: string,
    readonly diff: { field: "amount" | "type"; existing: string; requested: string },
  ) {
    super(message)
  }
}

export async function addCredits(
  orgId: string,
  params: AddCreditsParams,
): Promise<{ balanceAfter: string; alreadyProcessed?: boolean }> {
  const { amount, type, description, externalPaymentRef, cycleId } = params

  try {
    return await withPrivilegedDb(orgId, "add-credits", async (tx) => {
      // Build the appropriate UPDATE based on credit type
      const k = drizzleSql.raw(schemaRef("kernel"))
      const updateSql =
        type === "monthly_reset"
          ? drizzleSql`UPDATE ${k}.credit_balances
            SET included_balance = ${amount}::numeric(16,8), updated_at = now()
            WHERE org_id = ${orgId}
            RETURNING included_balance + purchased_balance AS balance_after`
          : drizzleSql`UPDATE ${k}.credit_balances
            SET purchased_balance = purchased_balance + ${amount}::numeric(16,8), updated_at = now()
            WHERE org_id = ${orgId}
            RETURNING included_balance + purchased_balance AS balance_after`

      const result = await tx.execute(updateSql)
      const rows = extractRows<{ balance_after: string }>(result)

      if (rows.length === 0) {
        throw new Error(`No credit_balances row for org ${orgId} — cannot add credits`)
      }

      const balanceAfter = rows[0].balance_after

      await tx.insert(creditTransactions).values({
        orgId,
        type,
        amount,
        balanceAfter,
        description,
        externalPaymentRef,
        cycleId,
      })

      return { balanceAfter }
    })
  } catch (err: unknown) {
    // Unique constraint violation (23505) on (org_id, external_payment_ref) or (org_id, cycle_id)
    // means this payment was already processed — transaction rolled back, balance unchanged.
    if (isUniqueViolation(err)) {
      // Conflict check: if the existing transaction differs from the request,
      // raise idempotency_conflict so the route can return 409.
      if (externalPaymentRef || cycleId) {
        const existing = await withPrivilegedDb(orgId, "add-credits-conflict-check", async (tx) => {
          const conds = []
          if (externalPaymentRef)
            conds.push(drizzleSql`external_payment_ref = ${externalPaymentRef}`)
          if (cycleId) conds.push(drizzleSql`cycle_id = ${cycleId}`)
          const where = conds.reduce(
            (acc, c, i) => (i === 0 ? c : drizzleSql`${acc} AND ${c}`),
            drizzleSql``,
          )
          const k = drizzleSql.raw(schemaRef("kernel"))
          const r = await tx.execute(drizzleSql`
            SELECT amount::text AS amount, type
            FROM ${k}.credit_transactions
            WHERE org_id = ${orgId} AND ${where}
            LIMIT 1
          `)
          const xs = extractRows<{ amount: string; type: string }>(r)
          return xs[0]
        })
        if (existing) {
          const normalizedAmount = Number.parseFloat(existing.amount).toFixed(8)
          const requestedAmount = Number.parseFloat(amount).toFixed(8)
          if (existing.type !== type) {
            throw new IdempotencyConflictError("idempotency conflict on type", {
              field: "type",
              existing: existing.type,
              requested: type,
            })
          }
          if (normalizedAmount !== requestedAmount) {
            throw new IdempotencyConflictError("idempotency conflict on amount", {
              field: "amount",
              existing: existing.amount,
              requested: amount,
            })
          }
        }
      }
      const balance = await withPrivilegedDb(orgId, "add-credits-dedup-check", (tx) =>
        checkBalance(tx, orgId),
      )
      const total = (Number(balance.included) + Number(balance.purchased)).toFixed(8)
      return { balanceAfter: total, alreadyProcessed: true }
    }
    throw err
  }
}

function isUniqueViolation(err: unknown): boolean {
  if (err && typeof err === "object") {
    if ("code" in err && (err as { code: string }).code === "23505") return true
    if ("cause" in err) return isUniqueViolation((err as { cause: unknown }).cause)
  }
  return false
}

/**
 * Kernel default monthly credit allowance per tier. Control plane (Phase 18)
 * may override per-org; this is the self-hosted fallback used during reset.
 */
export function tierAllowanceFor(tier: string): string {
  return TIER_ALLOWANCE[tier as keyof typeof TIER_ALLOWANCE] ?? "0"
}

export async function resetMonthlyCredits(
  orgId: string,
  cycleId: string,
  allowance: string,
): Promise<{ balanceAfter: string; alreadyProcessed?: boolean }> {
  return addCredits(orgId, {
    amount: allowance,
    type: "monthly_reset",
    cycleId,
    description: `monthly reset ${cycleId}`,
  })
}

export async function broadcastBalanceUpdate(orgId: string): Promise<void> {
  try {
    const balance = await withPrivilegedDb(orgId, "ws-balance-broadcast", (tx) =>
      checkBalance(tx, orgId),
    )
    // Through the event bus, so every process fans it out to its own sockets (a worker has none).
    // Ephemeral: a client that missed it refetches its credits on resync.
    const { broadcastEphemeral } = await import("~/infra/events/event-bus")
    await broadcastEphemeral({
      app: "kernel",
      entity: "credit",
      action: "balance_update",
      entityId: orgId,
      orgId,
      actorType: "system",
      data: {
        included: balance.included,
        purchased: balance.purchased,
        currency: balance.currency,
      },
    })
  } catch (err) {
    log.error({ err, orgId }, "Failed to broadcast balance update")
  }
}

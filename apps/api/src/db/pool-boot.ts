// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The boot's pool-budget checks (index.ts, the first step after env): log
 * the plan, refuse a topology whose one release overflows the budget, warn
 * when two releases side by side would, and apply the same rule to the limit
 * the database server reports. Operator page: docs/self-hosting/pools.md.
 */
import type { Sql } from "postgres"
import {
  describePlan,
  judgeAgainstLimit,
  MIGRATE_FOOTPRINT,
  type PlanVerdict,
  type PoolPlan,
  poolLabel,
} from "~/db/pool-plan"

interface BootLog {
  info(obj: object, msg: string): void
  warn(obj: object, msg: string): void
  fatal(obj: object, msg: string): void
}

function poolsField(plan: PoolPlan): Record<string, { size: number; source: string }> {
  return Object.fromEntries(
    plan.physical.map((p) => [poolLabel(p), { size: plan.pools[p], source: plan.source[p] }]),
  )
}

/**
 * Logs the plan (one `pool_plan` line), and the refusal or the overlap
 * warning. Returns the verdict; the caller exits 1 on "refuse".
 */
export function reportPoolPlan(
  plan: PoolPlan,
  log: BootLog,
  opts: { endpoint: "direct" | "pooler"; kernelSlots?: { planned: number; wanted: number } },
): PlanVerdict {
  const fields = {
    alert: undefined as string | undefined,
    pools: poolsField(plan),
    mode: plan.mode,
    role: plan.role,
    perProcess: plan.perProcess,
    topology: plan.topology,
    steady: plan.steady,
    overlap: plan.overlap,
    available: plan.available,
    unallocated: plan.unallocated,
    pinnedJobSlots: plan.pinnedJobSlots,
    ...(opts.kernelSlots ? { kernelSlots: opts.kernelSlots } : {}),
    // Behind a pooler, each login's pool_size must cover these (times the replicas).
    ...(opts.endpoint === "pooler" ? { perLogin: plan.logins } : {}),
  }
  log.info({ ...fields, alert: "pool_plan" }, `pool_plan: ${describePlan(plan)}`)
  if (plan.verdict === "refuse") {
    log.fatal(
      { ...fields, alert: "pool_budget_exceeded" },
      `Refusing to boot: one release of this topology needs ${plan.steady} connections, ` +
        `over the ${plan.available} the budget leaves (DB_CELL_MAX_CONNECTIONS minus ` +
        `DB_CELL_RESERVED minus ${MIGRATE_FOOTPRINT} for migrate). ${describePlan(plan)}. ` +
        "Raise DB_CELL_MAX_CONNECTIONS (and the database's limit), lower the replicas, or " +
        "lower the pool sizes set in env.",
    )
  } else if (plan.verdict === "warn") {
    log.warn(
      { ...fields, alert: "pool_budget_overlap_exceeded" },
      `Two releases side by side (a rolling deploy) may open ${plan.overlap} connections, over ` +
        `the ${plan.available} the budget leaves. ${describePlan(plan)}.`,
    )
  }
  return plan.verdict
}

/** The server's connection limit for ordinary logins: max_connections minus its reserved slots. */
export interface ServerLimit {
  maxConnections: number
  superuserReserved: number
  reserved: number
}

/**
 * Applies the plan's rule to the limit the server reports (DB_CELL_ENDPOINT
 * direct): steady above (limit − migrate footprint) refuses, overlap warns,
 * and a budget above the limit warns. Returns the verdict.
 */
export function checkServerLimit(
  plan: PoolPlan,
  limit: ServerLimit,
  log: Pick<BootLog, "warn" | "fatal">,
  opts: { cellMax?: number; strict?: boolean },
): PlanVerdict {
  const usable = limit.maxConnections - limit.superuserReserved - limit.reserved
  const { verdict, available } = judgeAgainstLimit(plan, usable, opts.strict)
  const fields = { server: limit, usable, available, steady: plan.steady, overlap: plan.overlap }
  if (opts.cellMax !== undefined && opts.cellMax > usable) {
    log.warn(
      { ...fields, alert: "pool_budget_above_server_limit", budget: opts.cellMax },
      `DB_CELL_MAX_CONNECTIONS (${opts.cellMax}) is above the ${usable} connections the database ` +
        "accepts for ordinary logins (max_connections minus its reserved slots).",
    )
  }
  if (verdict === "refuse") {
    log.fatal(
      { ...fields, alert: "pool_budget_exceeded" },
      `Refusing to boot: one release of this topology needs ${plan.steady} connections, over the ` +
        `${available} the database leaves (${usable} usable minus ${MIGRATE_FOOTPRINT} for migrate). ` +
        `${describePlan(plan)}. Set DB_CELL_MAX_CONNECTIONS to the database's limit so the pools ` +
        "are planned to fit, or raise max_connections.",
    )
  } else if (verdict === "warn") {
    log.warn(
      { ...fields, alert: "pool_budget_overlap_exceeded" },
      `Two releases side by side may open ${plan.overlap} connections, over the ${available} the ` +
        `database leaves. ${describePlan(plan)}.`,
    )
  }
  return verdict
}

/** Reads the server's connection limit (`SHOW` settings; a setting the server lacks reads 0). */
export async function readServerLimit(sql: Sql): Promise<ServerLimit> {
  const [row] = await sql`
    SELECT current_setting('max_connections')::int AS max_connections,
           coalesce(current_setting('superuser_reserved_connections', true), '0')::int AS superuser_reserved,
           coalesce(current_setting('reserved_connections', true), '0')::int AS reserved`
  return {
    maxConnections: Number(row?.max_connections ?? 0),
    superuserReserved: Number(row?.superuser_reserved ?? 0),
    reserved: Number(row?.reserved ?? 0),
  }
}

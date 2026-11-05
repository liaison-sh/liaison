// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * This process's pool plan (db/pool-plan.ts): every pool's size, from one
 * connection budget and the process's role. Planned at import, from env only,
 * so connection.ts can size its pools at import; the boot (index.ts) logs it
 * and refuses when the topology cannot fit, /diag shows it. Its own module so
 * readers of the plan never import the privileged handles of connection.ts.
 */
import { type PlanRole, planInputFromEnv, planPools } from "~/db/pool-plan"
import { kernelSlotsWanted, parseConcurrencyOverrides } from "~/infra/jobs/queue-classes"
import { env } from "~/lib/env"
import { currentRole } from "~/lib/process-role"

/** What this process plans its pools for: the CLI and the one-shots (migrate, catalog reconcile) first. */
function planRole(): PlanRole {
  if (process.env.LIAISON_CLI === "1") return "cli"
  if (process.env.LIAISON_ONESHOT === "1") return "oneshot"
  return currentRole()
}

export const poolPlan = planPools(
  planInputFromEnv(
    env,
    planRole(),
    // Split logins: connection.ts gives the request login its own pools (requestDatabaseUrl).
    Boolean(env.DATABASE_REQUEST_PASSWORD),
    kernelSlotsWanted(parseConcurrencyOverrides(env.JOB_QUEUE_CONCURRENCY)),
  ),
)

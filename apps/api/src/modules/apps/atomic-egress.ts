// SPDX-License-Identifier: FSL-1.1-ALv2
//
// No outside call inside a whole-run transaction.
//
// A sandboxed job declared `atomic: true` runs on ONE transaction from start
// to end (infra/jobs/job-context.ts, "ambient"): it holds a pooled connection,
// and every row it touched stays locked, for its whole wall clock. A provider
// call inside that run holds them across the provider's latency. So an atomic
// job's bridge refuses every egress method (ATOMIC_REFUSED_EGRESS_METHODS)
// with `atomic_run_egress_refused`: `atomic` survives only for work that stays
// in the database. A job that needs both splits into steps: read, call the
// provider, then write in one bridge call (or `ctx.steps.run`).
//
// The jobs that do egress inside an atomic run today are listed in
// contract/atomic-egress.allowlist.json. The list only shrinks
// (atomic-egress.guard.test.ts pins it under a frozen baseline): an app whose
// job is split removes its row.
//
// Core apps are not concerned: their jobs declare no `atomic`.
import allowlist from "./contract/atomic-egress.allowlist.json"

/** Bridge methods that reach outside the database (a provider, another run, a model). */
export const ATOMIC_REFUSED_EGRESS_METHODS: readonly string[] = [
  "fetch",
  "bulk_fetchToBlob",
  "files_importFromUrl",
  "connections_getToken",
  "imap_fetch",
  "imap_writeBack",
  "smtp_send",
  "executeTool",
  "contracts_call",
  "agent_run",
  "agent_spawn",
  "connector_list_operations",
  "connector_read",
  "connector_write",
  "connector_adapter_test",
]

export interface AtomicEgressAllowance {
  app: string
  job: string
  /** What the job calls outside, for whoever splits it. */
  egress: string
}

const ALLOWED = new Set((allowlist as AtomicEgressAllowance[]).map((r) => `${r.app}\u0000${r.job}`))

/** True when `app`'s atomic job `job` may still call outside (a listed offender). */
export function atomicEgressAllowed(app: string, job: string): boolean {
  return ALLOWED.has(`${app}\u0000${job}`)
}

function refused(method: string, app: string, job: string): Error {
  const err = new Error(
    `ctx.${method} is refused in the atomic job "${app}:${job}": an atomic run holds one ` +
      "database transaction for its whole run, so it may not call outside. Drop `atomic`, or " +
      "split the job into steps (read, call, then write in one bridge call).",
  ) as Error & { status: number; code: string }
  err.status = 409
  err.code = "atomic_run_egress_refused"
  return err
}

/**
 * Refuse the egress methods of an atomic job's bridge (mutated in place),
 * unless the job is a listed offender. Applied last, after app extensions.
 */
export function guardAtomicJobEgress(
  bridge: Record<string, unknown>,
  app: string,
  job: string,
): void {
  if (atomicEgressAllowed(app, job)) return
  for (const name of ATOMIC_REFUSED_EGRESS_METHODS) {
    if (typeof bridge[name] !== "function") continue
    bridge[name] = async () => {
      throw refused(name, app, job)
    }
  }
}

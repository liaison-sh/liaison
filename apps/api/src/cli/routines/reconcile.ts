// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `liaison routines reconcile` -- run the event routine reconciler once, over a
 * window of the operator's choosing (routine-event-reconciler.ts). The
 * scheduled job looks back 14 days; this is the one shot backfill after an
 * outage, e.g. every ticket message since 2026-09-29.
 *
 *   liaison routines reconcile [--since <iso date>] [--days <n>] [--org <slug>]
 *                              [--routine <uuid>] [--max-per-routine <n>] [--execute]
 *
 * A DRY RUN unless `--execute`: it lists what it would fire again and changes
 * nothing. With `--execute` it enqueues the retries for the server's
 * routine-tick worker (this process never hosts jobs) and raises or resolves
 * the routines' incidents. A routine's ticks run one at a time, so a pass
 * starts at most `--max-per-routine` (default 5) retries per routine; run it
 * again, or let the scheduled job take the rest within its own window.
 *
 * STDOUT carries the JSON report, STDERR the human summary.
 */
import { resolveOrgId } from "~/cli/lib/resolve-org-id"
import { reconcileEventRoutines } from "~/modules/agent/routines/routine-event-reconciler"

export const ROUTINES_RECONCILE_USAGE =
  "usage: liaison routines reconcile [--since <iso date>] [--days <n>] [--org <slug>] [--routine <uuid>] [--max-per-routine <n>] [--execute]"

function arg(flag: string, argv: string[]): string | undefined {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}

export async function runRoutinesReconcileCli(
  argv: string[],
): Promise<{ exitCode: number; report: unknown; message?: string }> {
  const sinceRaw = arg("--since", argv)
  const daysRaw = arg("--days", argv)
  const maxRaw = arg("--max-per-routine", argv)
  const routineId = arg("--routine", argv)
  const since = sinceRaw ? new Date(sinceRaw) : undefined
  if (since && Number.isNaN(since.getTime())) {
    return { exitCode: 2, report: { error: "bad --since" }, message: ROUTINES_RECONCILE_USAGE }
  }
  const days = daysRaw ? Number(daysRaw) : undefined
  if (days !== undefined && !(days > 0)) {
    return { exitCode: 2, report: { error: "bad --days" }, message: ROUTINES_RECONCILE_USAGE }
  }
  const maxPerRoutine = maxRaw ? Number(maxRaw) : undefined
  if (maxPerRoutine !== undefined && !(maxPerRoutine > 0)) {
    return {
      exitCode: 2,
      report: { error: "bad --max-per-routine" },
      message: ROUTINES_RECONCILE_USAGE,
    }
  }
  const slug = arg("--org", argv)
  let orgId: string | undefined
  if (slug) {
    const org = await resolveOrgId(slug, "")
    if (!org.ok) return { exitCode: 2, report: { error: org.message }, message: org.message }
    orgId = org.orgId
  }
  const execute = argv.includes("--execute")
  const report = await reconcileEventRoutines({
    ...(since ? { since } : {}),
    ...(days ? { lookbackMs: days * 24 * 60 * 60 * 1000 } : {}),
    ...(maxPerRoutine ? { maxPerRoutine } : {}),
    ...(orgId ? { orgId } : {}),
    ...(routineId ? { routineId } : {}),
    dryRun: !execute,
  })
  const summary = `${execute ? "EXECUTED" : "DRY RUN (add --execute to fire)"}: ${report.routines} routine(s), ${JSON.stringify(report.counts)}`
  return { exitCode: 0, report: { dryRun: !execute, ...report }, message: summary }
}

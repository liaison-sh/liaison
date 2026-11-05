// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * THE CURRENT STATE OF THE IMPORTS THIS CONVERSATION STARTED.
 *
 * An approved import_start's result is replayed to the agent as it was when
 * the approval ran: "queued" or "running". The import then finishes in the
 * background, and nothing in the conversation says so. Measured (walk of
 * agent-driven configuration, N16): under cards the person already saw as done,
 * the agent kept answering "still running" from that snapshot.
 *
 * So every turn reads the runs those results name and states their status now,
 * in a fixed line built from the run rows (never from the replayed text).
 */
import { getImportRun } from "~/modules/imports/runs"

/** The newest runs stated: older ones are history, read with import_status. */
const MAX_RUNS = 5

const IMPORT_START = new Set(["kernel:import_start", "kernel__import_start"])

const RUN_ID_IN_RESULT =
  /"runId"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/

/** The import runs approved import_start calls of these rows started, newest last. */
export function importRunIdsIn(
  rows: ReadonlyArray<{ authorType: string; metadata: unknown }>,
): string[] {
  const ids: string[] = []
  for (const row of rows) {
    if (row.authorType !== "system") continue
    const meta = row.metadata as { type?: unknown; toolName?: unknown; result?: unknown } | null
    if (meta?.type !== "approval-result" || !IMPORT_START.has(String(meta.toolName))) continue
    if (typeof meta.result !== "string") continue
    const m = RUN_ID_IN_RESULT.exec(meta.result)
    if (m?.[1] && !ids.includes(m[1])) ids.push(m[1])
  }
  return ids.slice(-MAX_RUNS)
}

function countsText(counts: unknown): string {
  if (typeof counts !== "object" || counts === null) return ""
  const parts: string[] = []
  for (const [kind, c] of Object.entries(counts as Record<string, unknown>)) {
    if (typeof c !== "object" || c === null) continue
    const { created, skipped, failed } = c as Record<string, unknown>
    parts.push(
      `${kind} ${Number(created ?? 0)} created, ${Number(skipped ?? 0)} skipped, ${Number(failed ?? 0)} failed`,
    )
  }
  return parts.join("; ")
}

/** The runtime line stating each run's status now, or null when there is none. */
export async function importRunStateLine(
  orgId: string,
  rows: ReadonlyArray<{ authorType: string; metadata: unknown }>,
): Promise<string | null> {
  const ids = importRunIdsIn(rows)
  if (ids.length === 0) return null
  const lines: string[] = []
  for (const id of ids) {
    const run = await getImportRun(orgId, id)
    if (!run) continue
    const counts = countsText(run.counts)
    lines.push(`- run ${id}: ${run.status}${counts ? ` (${counts})` : ""}`)
  }
  if (lines.length === 0) return null
  return `Imports started in this conversation, as they stand now (read when this turn began; newer than any earlier result about them):\n${lines.join("\n")}\nAnswer about them from this. A run that is not done yet finishes in the background and nobody is told: never promise to watch it or report back; check it again only when asked.`
}

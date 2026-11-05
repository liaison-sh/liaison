// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHERE ONE RUN SITS IN ITS ROUTINE'S OUTPUT THREAD.
//
// Every run of a routine writes into the same output thread, so "this run's
// transcript" is a slice of it: the messages written while the run was going.
// A routine never runs twice at once (the per-routine tick lock), so the slice
// between the run's start and its end holds that run's messages and no other's.
// The start is `started_at` (0157); an older row falls back to its end minus
// its duration. A run that never ran the agent (a skip) or ran it on a node
// (`dispatched`, whose answer lands later) has no slice here.

import { messagePlainText } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type RlsClient } from "~/db"
import { schemaRef } from "~/db/schema-ref"

/** Clock slack on both ends: the run row's timestamps and the messages' come
 *  from the same process, but not from the same instant. */
const WINDOW_SLACK_MS = 1000

/** How long a run's summary line is, at most. */
export const RUN_SUMMARY_MAX = 200

export interface RunWindowFacts {
  status: string
  ranAt: Date
  startedAt: Date | null
  durationMs: number | null
}

/** The run's slice of the output thread, or null when it has none. */
export function runWindow(run: RunWindowFacts): { from: Date; to: Date } | null {
  if (run.status === "dispatched" || run.status.startsWith("skipped_")) return null
  const end = run.ranAt.getTime()
  let start: number
  if (run.startedAt) start = run.startedAt.getTime()
  else if (typeof run.durationMs === "number") start = end - run.durationMs
  else return null
  return { from: new Date(start - WINDOW_SLACK_MS), to: new Date(end + WINDOW_SLACK_MS) }
}

/** The run's last agent words, as one plain line. */
export function runSummaryLine(content: string | null | undefined): string | null {
  if (!content) return null
  const flat = messagePlainText(content).replace(/\s+/g, " ").trim()
  if (!flat) return null
  return flat.length > RUN_SUMMARY_MAX ? `${flat.slice(0, RUN_SUMMARY_MAX - 1).trimEnd()}…` : flat
}

/**
 * Per run: its last agent message and how many messages it wrote, read under
 * the CALLER's RLS context, so a message the caller may not read neither
 * summarises a run nor counts in it.
 */
export async function readRunSlices(
  tx: RlsClient,
  params: {
    orgId: string
    threadId: string
    windows: Array<{ runId: string; from: Date; to: Date }>
  },
): Promise<Map<string, { summary: string | null; messageCount: number }>> {
  const out = new Map<string, { summary: string | null; messageCount: number }>()
  if (params.windows.length === 0) return out
  const k = drizzleSql.raw(schemaRef("kernel"))
  const values = drizzleSql.join(
    params.windows.map(
      (w) =>
        drizzleSql`(${w.runId}::uuid, ${w.from.toISOString()}::timestamptz, ${w.to.toISOString()}::timestamptz)`,
    ),
    drizzleSql`, `,
  )
  const rows = extractRows<{ run_id: string; summary: string | null; message_count: number }>(
    await tx.execute(drizzleSql`
      SELECT w.run_id,
        (
          SELECT m.content FROM ${k}.messages m
          WHERE m.org_id = ${params.orgId} AND m.thread_id = ${params.threadId}
            AND m.deleted_at IS NULL AND m.author_type = 'agent'
            AND m.created_at >= w.from_at AND m.created_at <= w.to_at
          ORDER BY m.created_at DESC, m.id DESC
          LIMIT 1
        ) AS summary,
        (
          SELECT COUNT(*)::int FROM ${k}.messages m
          WHERE m.org_id = ${params.orgId} AND m.thread_id = ${params.threadId}
            AND m.deleted_at IS NULL
            AND m.created_at >= w.from_at AND m.created_at <= w.to_at
        ) AS message_count
      FROM (VALUES ${values}) AS w(run_id, from_at, to_at)
    `),
  )
  for (const r of rows) {
    out.set(r.run_id, { summary: runSummaryLine(r.summary), messageCount: r.message_count })
  }
  return out
}

/** The first message written AFTER a run's slice, the `before` cursor that
 *  pages the slice out of the thread with the thread's own message reader. */
export async function firstMessageAfter(
  tx: RlsClient,
  params: { orgId: string; threadId: string; to: Date },
): Promise<string | null> {
  const k = drizzleSql.raw(schemaRef("kernel"))
  const rows = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      SELECT m.id FROM ${k}.messages m
      WHERE m.org_id = ${params.orgId} AND m.thread_id = ${params.threadId}
        AND m.created_at > ${params.to.toISOString()}::timestamptz
      ORDER BY m.created_at ASC, m.id ASC
      LIMIT 1
    `),
  )
  return rows[0]?.id ?? null
}

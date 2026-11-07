// SPDX-License-Identifier: FSL-1.1-ALv2
// Attention providers for the materializer's timeout tests: one that blocks
// in a statement, one that never answers in JS and then tries another query.
import type { AttentionItem } from "@liaison/shared"
import { sql } from "drizzle-orm"

type Tx = { execute: (q: ReturnType<typeof sql>) => Promise<unknown> }

export const lateQuery: { attempted: boolean; ran: boolean; error: string | null } = {
  attempted: false,
  ran: false,
  error: null,
}

/** Blocks the connection in a statement far longer than the pass may run. */
export async function sleepsInDatabase(tx: Tx): Promise<AttentionItem[]> {
  await tx.execute(sql`SELECT pg_sleep(30)`)
  return []
}

/** Holds its transaction open without a statement, then tries one more query. */
export async function hangsThenQueries(tx: Tx): Promise<AttentionItem[]> {
  await new Promise((r) => setTimeout(r, 3_000))
  lateQuery.attempted = true
  try {
    await tx.execute(sql`SELECT 1`)
    lateQuery.ran = true
  } catch (err) {
    // The driver's own error, under the query builder's "Failed query" wrapper.
    const e = err as Error & { cause?: Error }
    lateQuery.error = (e.cause ?? e).message
  }
  return []
}

/** Answers at once. */
export async function answers(): Promise<AttentionItem[]> {
  return [
    {
      id: "fast-1",
      app: "kernel",
      entity: "sla",
      entityId: "e-fast",
      kind: "sla_risk",
      urgency: 50,
      summary: "fast provider item",
      occurredAt: new Date().toISOString(),
      action: { type: "open_entity", tabType: "ticket", entityId: "e-fast" },
    } as AttentionItem,
  ]
}

// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { sql } from "drizzle-orm"
import { markSummaryFailed, type SummaryDb, writeTicketSummary } from "./summary-write"

// postgres.js shape: `Failed query: <sql>` with the PostgresError on `.cause`.
function pgError(code: string, message: string): Error {
  const e = new Error("Failed query: UPDATE app_tickets.tickets ...") as Error & { cause?: unknown }
  e.cause = Object.assign(new Error(message), { code })
  return e
}

/** A database whose first `failures` statements throw `err`, then succeed. */
function flakyDb(failures: number, err: () => Error, rows: unknown[]) {
  const seen: string[] = []
  const db: SummaryDb = {
    execute: async (query) => {
      seen.push(JSON.stringify(query))
      if (seen.length <= failures) throw err()
      return rows
    },
  }
  return { db, seen }
}

const tickets = sql.raw(`"app_tickets"."tickets"`)
const input = {
  ticketId: "00000000-0000-4000-8000-000000000001",
  orgId: "00000000-0000-4000-8000-000000000002",
  summaryText: "Customer's Kestrel 10 stopped charging after the update.",
  messageCount: 3,
  modelId: "test-model",
  usage: { inputTokens: 10, outputTokens: 5 },
}
const noDelay = { delayMs: () => 0 }

describe("writeTicketSummary", () => {
  it("retries a deadlock (40P01) on the summary UPDATE and the summary lands", async () => {
    const at = new Date("2026-10-25T17:00:00Z")
    const { db, seen } = flakyDb(1, () => pgError("40P01", "deadlock detected"), [
      { summary_at: at },
    ])
    const retries: number[] = []
    const result = await writeTicketSummary(db, tickets, input, {
      ...noDelay,
      onRetry: (info) => retries.push(info.attempt),
    })
    expect(result).toEqual({ summaryAt: at })
    expect(seen).toHaveLength(2)
    expect(seen[1]).toContain("summary_text")
    expect(retries).toEqual([1])
  })

  it("retries a serialization failure (40001)", async () => {
    const { db, seen } = flakyDb(2, () => pgError("40001", "could not serialize access"), [
      { summary_at: "2026-10-25T17:00:00Z" },
    ])
    await writeTicketSummary(db, tickets, input, noDelay)
    expect(seen).toHaveLength(3)
  })

  it("throws the deadlock once the retries are spent", async () => {
    const { db, seen } = flakyDb(99, () => pgError("40P01", "deadlock detected"), [])
    await expect(writeTicketSummary(db, tickets, input, noDelay)).rejects.toThrow()
    expect(seen.length).toBeGreaterThan(1)
  })

  it("does not retry a non-transient error", async () => {
    const { db, seen } = flakyDb(1, () => pgError("23514", "check violation"), [])
    await expect(writeTicketSummary(db, tickets, input, noDelay)).rejects.toThrow()
    expect(seen).toHaveLength(1)
  })

  it("returns null when the ticket is no longer there (0 rows), never a TypeError", async () => {
    const { db } = flakyDb(0, () => new Error("unused"), [])
    expect(await writeTicketSummary(db, tickets, input, noDelay)).toBeNull()
  })
})

describe("markSummaryFailed", () => {
  it("retries a deadlock on the error-state write", async () => {
    const { db, seen } = flakyDb(1, () => pgError("40P01", "deadlock detected"), [])
    await markSummaryFailed(db, tickets, { ...input, reason: "provider_error" }, noDelay)
    expect(seen).toHaveLength(2)
    expect(seen[1]).toContain("summary_error")
  })
})

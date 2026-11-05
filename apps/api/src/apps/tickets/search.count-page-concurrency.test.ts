// SPDX-License-Identifier: FSL-1.1-ALv2
// D1 concurrency regression pin: searchTickets runs the count query and the
// page query concurrently via `Promise.all([runCount(), runQuery(...)])` (see
// search.ts, near the `runCount`/`runQuery` definitions) rather than
// sequentially awaiting one after the other. A regression that accidentally
// serializes them (e.g. `await runCount(); await runQuery(...)`) still passes
// every functional assertion (total/items are unaffected) but silently
// doubles the wall-clock latency of every list page — exactly the kind of
// perf regression that is invisible to a correctness-only test. This test
// injects a `tx` double whose `execute()` returns a DEFERRED promise per
// call and inspects the query text (via drizzle's `queryChunks`) to tell the
// COUNT statement from the page SELECT, then asserts BOTH calls are made
// (both promises created) BEFORE either is allowed to resolve — i.e. their
// execution windows overlap — rather than one being issued only after the
// other has already resolved.
import { describe, expect, it } from "bun:test"
import { searchTickets } from "~/apps/tickets/search"

// Mirrors drizzle's SQL tag output shape closely enough to read the leading
// literal chunk without depending on postgres.js/drizzle internals beyond
// what's already visible on a real `sql\`...\`` value (see search.total.test.ts
// for the sibling pattern of passing a raw tx double into searchTickets).
function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks
  if (!Array.isArray(chunks)) return ""
  return chunks
    .map((c) => {
      const v = (c as { value?: unknown[] })?.value
      return Array.isArray(v) ? v.join("") : ""
    })
    .join(" ")
}

describe("searchTickets — count and page queries run CONCURRENTLY, not sequentially", () => {
  it("both the COUNT(*) query and the page SELECT are in flight simultaneously (their execution windows overlap)", async () => {
    const callOrder: string[] = []
    let countStarted = false
    let pageStarted = false
    let countResolve!: () => void
    let pageResolve!: () => void
    const countGate = new Promise<void>((resolve) => {
      countResolve = resolve
    })
    const pageGate = new Promise<void>((resolve) => {
      pageResolve = resolve
    })

    // Deferred-promise double: each execute() call does NOT resolve until its
    // own gate fires, so we can observe whether the SECOND call is issued
    // before the FIRST one's promise has settled (i.e. concurrent) versus
    // only after (i.e. sequential/serialized — the regression this pins
    // against).
    const tx = {
      execute: async (query: unknown) => {
        const text = sqlText(query)
        const isCount = text.includes("COUNT(*)")
        if (isCount) {
          countStarted = true
          callOrder.push("count-start")
          // At the moment the count call is issued, if the implementation
          // were sequential (await count; await page), the page call could
          // not possibly have started yet. We assert the INVERSE below by
          // checking pageStarted state from the other branch once both have
          // fired — this branch just records timing and returns an empty
          // count result once its gate opens.
          await countGate
          callOrder.push("count-resolve")
          return [{ total: 0 }]
        }
        pageStarted = true
        callOrder.push("page-start")
        await pageGate
        callOrder.push("page-resolve")
        return []
      },
    }

    const resultPromise = searchTickets(tx as never, "00000000-0000-0000-0000-000000000fff", {
      status: "open",
      limit: 10,
    } as never)

    // Give both `runCount()` and `runQuery()` a microtask/macrotask tick to
    // actually invoke `tx.execute` — Promise.all starts both callbacks before
    // awaiting either, so by the time we get here (before EITHER gate has
    // opened), both should already have called execute().
    await new Promise((r) => setTimeout(r, 20))

    expect(countStarted).toBe(true)
    expect(pageStarted).toBe(true)
    // Neither has resolved yet — proves they were both in flight
    // concurrently, not one awaited to completion before the other started.
    expect(callOrder).toEqual(["count-start", "page-start"])

    // Release both gates and let the call complete normally.
    countResolve()
    pageResolve()
    const result = await resultPromise
    expect(result.items).toEqual([])
    expect(result.totalCount).toBe(0)
  })
})

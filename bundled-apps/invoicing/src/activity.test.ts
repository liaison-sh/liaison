// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Invoicing's rows on a company's or a contact's timeline: issued, paid and
// credited, never a draft, read live, paged by (time, id) even when hundreds of
// documents share one issue day. The store below answers findMany as the bridge
// does for the filters this read uses (in, lte, equality, order, limit).

import { describe, expect, test } from "bun:test"
import { activityRead } from "./activity"
import { documentsSearch, type ReadsCtx } from "./reads"

type Doc = Record<string, unknown>

function store(docs: Doc[]) {
  const matches = (doc: Doc, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, cond]) => {
      const v = doc[k]
      if (cond && typeof cond === "object" && "in" in (cond as object))
        return ((cond as { in: unknown[] }).in ?? []).includes(v)
      if (cond && typeof cond === "object" && "lte" in (cond as object))
        return typeof v === "string" && v.slice(0, 10) <= String((cond as { lte: string }).lte)
      return v === cond
    })
  return {
    docs,
    findMany: async (
      _entity: string,
      o: { where?: Record<string, unknown>; orderBy?: Record<string, string>; limit?: number } = {},
    ) => {
      const rows = docs.filter((d) => matches(d, o.where ?? {}))
      rows.sort(
        (a, b) =>
          String(b.issued_at).localeCompare(String(a.issued_at)) ||
          Number(b.number_int) - Number(a.number_int),
      )
      return rows.slice(0, o.limit ?? 100)
    },
    findOne: async () => null,
    count: async () => 0,
  }
}

const ALICE = "11111111-1111-4111-8111-111111111111"
const BOB = "22222222-2222-4222-8222-222222222222"
let n = 0
function doc(extra: Doc): Doc {
  n += 1
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    type: "invoice",
    status: "issued",
    number: `F-2026-${String(n).padStart(4, "0")}`,
    number_int: n,
    counterparty_contact_id: ALICE,
    counterparty_name: "Atelier Nord",
    grand_total_minor: 174000,
    currency: "EUR",
    issued_at: "2026-03-02 00:00:00+00",
    paid_at: null,
    ...extra,
  }
}

const input = (before: { at: string; id: string } | null = null, limit = 30) => ({
  contactIds: [ALICE, BOB],
  companyId: null,
  dealIds: [],
  before,
  limit,
  prefix: "invoicing:",
})

describe("invoicing timeline source", () => {
  test("rows are issued, paid and credited, never a draft", async () => {
    const paid = doc({ paid_at: "2026-03-10T09:30:00.000Z" })
    const draft = doc({ status: "draft" })
    const credit = doc({ type: "credit_note", number: "CN-2026-0001", issued_at: "2026-03-05 00:00:00+00" })
    const db = store([paid, draft, credit])
    const out = await activityRead({ db }, input())
    expect(out.rows.map((r) => r.title)).toEqual([
      `Invoice ${paid.number} paid`,
      "Credit note CN-2026-0001 credited, 1740.00 EUR",
      `Invoice ${paid.number} issued, 1740.00 EUR`,
    ])
    expect(out.rows.some((r) => r.id.startsWith(String(draft.id)))).toBe(false)
  })

  test("a deleted invoice is gone on the next call", async () => {
    const kept = doc({})
    const gone = doc({})
    const db = store([kept, gone])
    expect((await activityRead({ db }, input())).rows).toHaveLength(2)
    db.docs.splice(db.docs.indexOf(gone), 1)
    expect((await activityRead({ db }, input())).rows.map((r) => r.id)).toEqual([`${kept.id}:issued`])
  })

  /** Every page, as the kernel pages: by the last row, or by the window's start when a page ends short. */
  async function pages(db: ReturnType<typeof store>, cap?: number) {
    const seen: string[] = []
    let before: { at: string; id: string } | null = null
    for (let page = 0; page < 60; page++) {
      const out = await activityRead({ db }, input(before, 100), cap)
      const floor = out.windowStart
      const rows = floor ? out.rows.filter((r) => Date.parse(r.at) > Date.parse(floor)) : out.rows
      seen.push(...rows.map((r) => `invoicing:${r.id}`))
      const last = rows.at(-1)
      if (rows.length === 100 && last) before = { at: last.at, id: `invoicing:${last.id}` }
      else if (floor) before = { at: floor, id: "\uffff" }
      else break
    }
    return seen
  }

  test("1 500 documents of one day page with no duplicate and no gap", async () => {
    const day = Array.from({ length: 1500 }, () => doc({ issued_at: "2026-04-01 00:00:00+00" }))
    const older = Array.from({ length: 20 }, (_, i) =>
      doc({ issued_at: `2026-03-${String(10 + i).padStart(2, "0")} 00:00:00+00` }),
    )
    const seen = await pages(store([...day, ...older]))
    expect(new Set(seen).size).toBe(seen.length)
    expect(seen.length).toBe(1520)
  })

  test("a read cut at its cap pages on from the day after its oldest document", async () => {
    const docs = Array.from({ length: 30 }, (_, d) =>
      Array.from({ length: 50 }, () =>
        doc({ issued_at: `2026-05-${String(d + 1).padStart(2, "0")} 00:00:00+00` }),
      ),
    ).flat()
    const seen = await pages(store(docs), 120)
    expect(new Set(seen).size).toBe(seen.length)
    expect(new Set(seen)).toEqual(new Set(docs.map((d) => `invoicing:${d.id}:issued`)))
  })

  test("documents search by company lists the documents made out to its people", async () => {
    const mine = doc({ counterparty_contact_id: BOB })
    const other = doc({ counterparty_contact_id: "33333333-3333-4333-8333-333333333333" })
    const db = store([mine, other])
    const calls: Array<[string, unknown]> = []
    const ctx = {
      db,
      kernel: {},
      executeTool: async (tool: string, params: unknown) => {
        calls.push([tool, params])
        return { status: "completed", result: { people: [{ id: BOB }] } }
      },
    } as unknown as ReadsCtx
    const rows = await documentsSearch(ctx, { company_id: "44444444-4444-4444-8444-444444444444" })
    expect(rows.map((r) => r.id)).toEqual([String(mine.id)])
    expect(calls).toEqual([["kernel:companies_read", { companyId: "44444444-4444-4444-8444-444444444444" }]])
  })
})

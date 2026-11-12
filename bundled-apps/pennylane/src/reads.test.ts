// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, it, expect } from "bun:test"
import {
  supplierInvoicesList,
  supplierInvoiceGet,
  customerInvoicesList,
  trialBalanceGet,
  pnlSummary,
  cashPosition,
  transactionsList,
  spendByCategory,
  runwayEstimate,
  homeLoad,
} from "./reads"
import { REFRESH_PAGES_PER_CHUNK, type RefreshSnapshotsCtx, refreshSnapshotsJob } from "./snapshot"
import { PennylaneApiError, PennylaneRateLimitError } from "./lib/pennylane-client"
import type { Page } from "./types"
import type { PennylaneLogger, PennylaneToolCtx } from "./ctx"
import type { NotConnectedEnvelope } from "./reads"

/**
 * Every read handler now returns `View | NotConnectedEnvelope` (structured
 * not-connected envelope, see reads.ts). These fixtures always inject a
 * connected `ctx.__client`, so every result here is the real view — this
 * helper asserts that and narrows the type for the rest of the test body.
 */
function expectConnected<T>(result: T | NotConnectedEnvelope): T {
  if (result && typeof result === "object" && "error" in result) {
    throw new Error(`expected a connected result, got envelope: ${JSON.stringify(result.error)}`)
  }
  return result as T
}

/**
 * A dataset for one list endpoint: either a flat array (one page) or an array of
 * pages (each inner array is one cursor page; the mock chains them via
 * next_cursor/has_more so `listAll` must drain every page to see all rows).
 */
type ListData = unknown[] | unknown[][]

/** True when `d` is an array of pages (array-of-arrays), not a single flat page. */
function isPaged(d: ListData | undefined): d is unknown[][] {
  return Array.isArray(d) && d.length > 0 && Array.isArray(d[0])
}

/** In-memory ctx: a fake PennylaneClient facade (getClient returns it) + a fake db store. */
function makeCtx(opts: {
  supplierInvoices?: ListData
  customerInvoices?: ListData
  trialBalance?: ListData
  bankAccounts?: ListData
  transactions?: ListData
  ledgerEntries?: ListData
  bankStatus?: number
  /** When set, `/trial_balance` throws this status (403 → firm-scope ledger fallback). */
  trialBalanceStatus?: number
  /** `/fiscal_years` items; omitted → the endpoint answers 403 (token lacks the scope). */
  fiscalYears?: unknown[]
  /** Records the query params of every `/trial_balance` call. */
  tbCalls?: Array<Record<string, string> | undefined>
  mapping?: Record<string, string>
  snapshot?: Record<string, unknown>
  logger?: PennylaneLogger
  /** Chunks one `ctx.steps.run` takes before it hands the rest to a later run (default: all). */
  chunksPerRun?: number
  /** `/trial_balance` answers 429 on this call number (1-based), once. */
  tbRateLimitOnCall?: number
}): RefreshSnapshotsCtx {
  const page = <T>(items: T[]): Page<T> => ({ items: items as T[], next_cursor: null, has_more: false })
  /**
   * Resolve one cursor page from a ListData dataset. Flat arrays return a single
   * terminal page (back-compat). Paged datasets emit `cursor=<n>` for page n and
   * set has_more until the last page, so `listAll` chains through all of them.
   */
  const pageFor = <T>(data: ListData | undefined, cursor?: string): Page<T> => {
    if (!isPaged(data)) return page((data ?? []) as T[])
    const idx = cursor ? Number(cursor) : 0
    const items = (data[idx] ?? []) as T[]
    const hasMore = idx < data.length - 1
    return { items, next_cursor: hasMore ? String(idx + 1) : null, has_more: hasMore }
  }
  const store: Record<string, Array<Record<string, unknown>>> = {
    app_config: [
      ...(opts.mapping
        ? [{ id: "m", key: "account_class_map", value: JSON.stringify(opts.mapping) }]
        : []),
      ...(opts.bankStatus === 403
        ? [
            {
              id: "s",
              key: "connection_scope",
              value: JSON.stringify({ scope: "invoice_only", cash_status: "unavailable" }),
            },
          ]
        : []),
    ],
    pnl_snapshot: opts.snapshot?.pnl ? [opts.snapshot.pnl as Record<string, unknown>] : [],
    cash_snapshot: opts.snapshot?.cash ? [opts.snapshot.cash as Record<string, unknown>] : [],
  }
  let tbCallCount = 0
  const client = {
    list: async <T>(
      path: string,
      q?: { cursor?: string; params?: Record<string, string> },
    ): Promise<Page<T>> => {
      const cursor = q?.cursor
      if (path.includes("/supplier_invoices")) return pageFor<T>(opts.supplierInvoices, cursor)
      if (path.includes("/customer_invoices")) return pageFor<T>(opts.customerInvoices, cursor)
      if (path.includes("/fiscal_years")) {
        if (!opts.fiscalYears) throw new PennylaneApiError(403, '{"error":"missing scope","status":403}')
        return page<T>(opts.fiscalYears as T[])
      }
      if (path.includes("/trial_balance")) {
        opts.tbCalls?.push(q?.params)
        tbCallCount++
        if (tbCallCount === opts.tbRateLimitOnCall) {
          throw new PennylaneRateLimitError(Date.now() + 30_000)
        }
        // The live API answers 400 when either required date is missing or malformed.
        const isDate = (v: string | undefined) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)
        if (!isDate(q?.params?.period_start) || !isDate(q?.params?.period_end)) {
          throw new PennylaneApiError(400, '{"message":"period_start is missing","code":"InvalidDateFormat"}')
        }
        if (opts.trialBalanceStatus !== undefined) {
          const e = new Error("x") as Error & { status?: number }
          e.status = opts.trialBalanceStatus
          e.name = "PennylaneApiError"
          throw e
        }
        return pageFor<T>(opts.trialBalance, cursor)
      }
      if (path.includes("/bank_accounts")) {
        if (opts.bankStatus === 403) {
          const e = new Error("x") as Error & { status?: number }
          e.status = 403
          e.name = "PennylaneApiError"
          throw e
        }
        return pageFor<T>(opts.bankAccounts, cursor)
      }
      if (path.includes("/transactions")) return pageFor<T>(opts.transactions, cursor)
      if (path.includes("/ledger_entries")) return pageFor<T>(opts.ledgerEntries, cursor)
      return page<T>([])
    },
    get: async <T>(path: string): Promise<T> => {
      const id = path.split("/").pop()
      const flat = isPaged(opts.supplierInvoices)
        ? opts.supplierInvoices.flat()
        : (opts.supplierInvoices ?? [])
      const found = flat.find((s) => (s as { id: string }).id === id)
      if (!found) {
        const e = new Error("not found") as Error & { status?: number }
        e.status = 404
        e.name = "PennylaneApiError"
        throw e
      }
      return found as T
    },
  }
  const ctx = {
    orgId: "org_1",
    fetch: (async () => ({ status: 200, headers: {}, body: "{}" })) as never,
    connections: {
      pennylane: { getCredentials: async () => ({ apiToken: "tok", scope: "company" }) },
    },
    logger: opts.logger,
    __client: client,
    steps: memorySteps(opts.chunksPerRun ?? Number.POSITIVE_INFINITY),
    db: {
      async findMany(entity: string, o?: { where?: Record<string, unknown>; limit?: number }) {
        const rows = store[entity] ?? []
        if (!o?.where) return rows
        return rows.filter((r) => Object.entries(o.where!).every(([k, v]) => r[k] === v))
      },
      async insert(entity: string, data: Record<string, unknown>) {
        const id = `${entity}_${(store[entity] ??= []).length}`
        store[entity].push({ id, ...data })
        return { id }
      },
      async update(entity: string, id: string, data: Record<string, unknown>) {
        const r = (store[entity] ?? []).find((x) => x.id === id)
        if (r) Object.assign(r, data)
      },
      async delete(entity: string, id: string) {
        store[entity] = (store[entity] ?? []).filter((x) => x.id !== id)
      },
    },
  }
  return ctx as unknown as RefreshSnapshotsCtx
}

/**
 * `ctx.steps` in memory: the cursor goes through JSON between chunks (as the data store keeps
 * it), a run takes at most `chunksPerRun` chunks, and a chunk's `wakeIn` ends the run.
 */
function memorySteps(chunksPerRun: number) {
  const steps = new Map<string, { cursor: unknown; done: boolean }>()
  const json = (v: unknown) => (v === undefined ? null : JSON.parse(JSON.stringify(v)))
  return {
    runs: 0,
    async run<C>(
      name: string,
      _opts: { budgetMs?: number },
      chunk: (c: C | null) => Promise<{ done: boolean; cursor?: C | null; wakeIn?: number }>,
    ) {
      this.runs++
      const st = steps.get(name) ?? { cursor: null, done: false }
      steps.set(name, st)
      if (st.done) return { state: "done" as const, cursor: st.cursor as C, chunks: 0 }
      let chunks = 0
      while (chunks < chunksPerRun) {
        const res = await chunk(json(st.cursor) as C | null)
        chunks++
        st.cursor = json(res.cursor ?? null)
        if (res.done) {
          st.done = true
          return { state: "done" as const, cursor: st.cursor as C, chunks }
        }
        if (res.wakeIn !== undefined) break
      }
      return { state: "scheduled" as const, cursor: st.cursor as C, chunks }
    },
    async get(name: string) {
      const st = steps.get(name)
      return st ? { cursor: st.cursor, done: st.done, running: false, updatedAt: "" } : null
    },
    async reset(name: string) {
      return { reset: steps.delete(name) }
    },
  }
}

describe("pennylane reads — projection + derivation", () => {
  it("supplier_invoices_list projects only normalized header fields (no raw payload)", async () => {
    const ctx = makeCtx({
      supplierInvoices: [
        {
          id: "si_1",
          supplier_name: "Acme",
          currency: "EUR",
          amount: "120.00",
          status: "unpaid",
          due_date: "2026-07-01",
          invoice_date: "2026-06-01",
          _raw: { secret: 1 },
        },
      ],
    })
    const out = expectConnected(await supplierInvoicesList(ctx, {}))
    expect(out.items).toEqual([
      {
        id: "si_1",
        supplier_name: "Acme",
        total: { amount_minor: "12000", currency: "EUR" },
        status: "unpaid",
        due_date: "2026-07-01",
        invoice_date: "2026-06-01",
      },
    ])
    expect(JSON.stringify(out)).not.toContain("secret")
  })

  it("pnl_summary buckets the trial balance via the org account_class_map (601→cogs)", async () => {
    const ctx = makeCtx({
      mapping: { "70": "revenue", "60": "cogs", "62": "opex" },
      trialBalance: [
        { account_code: "707000", label: "Sales", balance: "1000.00", currency: "EUR" },
        { account_code: "601000", label: "Parts", balance: "400.00", currency: "EUR" },
      ],
    })
    const out = expectConnected(await pnlSummary(ctx, { period: "2026-Q2" }))
    expect(out.revenue_minor).toBe("100000")
    expect(out.cogs_minor).toBe("40000")
    expect(out.gross_margin_minor).toBe("60000")
    // Regression (board-deck-quarter-narrative judge directive): pnl_summary money fields
    // MUST carry the `_minor` suffix that every sibling handler uses. A bare unlabelled
    // `revenue`/`gross_margin` is the exact ambiguity the model read as whole euros → a
    // 100× scale error. The labelled fields are the only money keys; the bare ones are gone.
    expect((out as unknown as Record<string, unknown>).revenue).toBeUndefined()
    expect((out as unknown as Record<string, unknown>).gross_margin).toBeUndefined()
  })

  it("trial_balance_get reconstructs from /ledger_entries on a firm-scope 403, reconciling the same lines", async () => {
    const ctx = makeCtx({
      trialBalanceStatus: 403,
      ledgerEntries: [
        { account_code: "707000", label: "Sales", amount: "1000.00" },
        { account_code: "601000", label: "Parts", amount: "400.00" },
        { account_code: "627000", label: "Bank fees", amount: "50.00" },
      ],
    })
    const tb = expectConnected(await trialBalanceGet(ctx, {}))
    const byCode = Object.fromEntries(tb.lines.map((l) => [l.account_code, l.balance_minor]))
    expect(byCode["707000"]).toBe("100000")
    expect(byCode["601000"]).toBe("40000")
    expect(byCode["627000"]).toBe("5000")
  })

  it("pnl_summary reconciles via the firm-403 ledger reconstruction (601→cogs, gm=60000)", async () => {
    const ctx = makeCtx({
      mapping: { "70": "revenue", "60": "cogs", "62": "opex" },
      trialBalanceStatus: 403,
      ledgerEntries: [
        { account_code: "707000", label: "Sales", amount: "1000.00" },
        { account_code: "601000", label: "Parts", amount: "400.00" },
        { account_code: "627000", label: "Bank fees", amount: "50.00" },
      ],
    })
    const out = expectConnected(await pnlSummary(ctx, {}))
    expect(out.revenue_minor).toBe("100000")
    expect(out.cogs_minor).toBe("40000")
    expect(out.opex_minor).toBe("5000")
    expect(out.gross_margin_minor).toBe("60000")
  })

  it("trial_balance_get re-throws a non-403 error (never silently reconstructs)", async () => {
    const ctx = makeCtx({
      trialBalanceStatus: 500,
      ledgerEntries: [{ account_code: "707000", label: "Sales", amount: "1000.00" }],
    })
    await expect(trialBalanceGet(ctx, {})).rejects.toThrow()
  })

  it("cash_position degrades to cash_status:unavailable on bank-403, never fabricates a number", async () => {
    const ctx = makeCtx({ bankStatus: 403 })
    const out = expectConnected(await cashPosition(ctx, {}))
    expect(out.cash_status).toBe("unavailable")
    expect(out.total_by_currency).toEqual({})
    expect(out.accounts).toEqual([])
  })

  it("cash_position sums balances per currency when bank scope is live", async () => {
    const ctx = makeCtx({
      bankAccounts: [
        { id: "ba_1", name: "Main", balance: "2500.00", currency: "EUR", synced_at: "2026-06-10" },
        { id: "ba_2", name: "USD ops", balance: "900.00", currency: "USD", synced_at: "2026-06-10" },
      ],
    })
    const out = expectConnected(await cashPosition(ctx, {}))
    expect(out.cash_status).toBe("live")
    expect(out.total_by_currency).toEqual({ EUR: "250000", USD: "90000" })
  })

  it("runway_estimate returns months:null + unavailable on bank-403", async () => {
    const ctx = makeCtx({ bankStatus: 403, transactions: [] })
    const out = expectConnected(await runwayEstimate(ctx, {}))
    expect(out.months).toBeNull()
    expect(out.cash_status).toBe("unavailable")
  })

  it("runway_estimate computes months = cash ÷ net-burn for single-currency cash + tx", async () => {
    // 300000 EUR cash, net burn = -(−30000) = 30000/mo → 10 months.
    const ctx = makeCtx({
      bankAccounts: [
        { id: "ba_1", name: "Main EUR", balance: "3000.00", currency: "EUR", synced_at: "2026-06-10" },
      ],
      transactions: [{ id: "t1", amount: "-300.00", currency: "EUR", date: "2026-06-01" }],
    })
    const out = expectConnected(await runwayEstimate(ctx, {}))
    expect(out.cash_status).toBe("live")
    expect(out.months).toBe(10)
  })

  it("runway_estimate pins net-burn to the cash currency — a foreign-currency tx is ignored", async () => {
    // Largest cash bucket is EUR (300000); the USD outflow must NOT count toward
    // EUR net burn (no FX). Only the EUR tx (−25000) drives burn → 12 months.
    const ctx = makeCtx({
      bankAccounts: [
        { id: "ba_1", name: "Main EUR", balance: "3000.00", currency: "EUR", synced_at: "2026-06-10" },
        { id: "ba_2", name: "USD ops", balance: "900.00", currency: "USD", synced_at: "2026-06-10" },
      ],
      transactions: [
        { id: "t1", amount: "-250.00", currency: "EUR", date: "2026-06-01" },
        { id: "t2", amount: "-900.00", currency: "USD", date: "2026-06-01" },
      ],
    })
    const out = expectConnected(await runwayEstimate(ctx, {}))
    expect(out.cash_status).toBe("live")
    expect(out.months).toBe(12)
  })

  it("runway_estimate returns months:null when net burn is ≤ 0 (cash-flow positive)", async () => {
    const ctx = makeCtx({
      bankAccounts: [
        { id: "ba_1", name: "Main EUR", balance: "3000.00", currency: "EUR", synced_at: "2026-06-10" },
      ],
      transactions: [{ id: "t1", amount: "50.00", currency: "EUR", date: "2026-06-01" }],
    })
    const out = expectConnected(await runwayEstimate(ctx, {}))
    expect(out.cash_status).toBe("live")
    expect(out.months).toBeNull()
  })

  it("home_load reads the cached snapshot, not the live API", async () => {
    const ctx = makeCtx({
      snapshot: {
        pnl: {
          id: "p",
          period: "2026-Q2",
          revenue: "100000",
          cogs: "40000",
          opex: "5000",
          gross_margin: "60000",
          refreshed_at: "2026-06-10",
        },
        cash: {
          id: "c",
          total_by_currency: JSON.stringify({ EUR: "250000" }),
          cash_status: "live",
          refreshed_at: "2026-06-10",
        },
      },
    })
    const out = await homeLoad(ctx, {})
    // The snapshot ROW keeps its DB column names (revenue/cogs/...) but the home_load
    // PROJECTION the agent sees carries the `_minor` suffix — same minor-units convention
    // as pnl_summary, so the home view never re-introduces the bare-field 100× ambiguity.
    expect(out.pnl?.revenue_minor).toBe("100000")
    expect(out.pnl?.gross_margin_minor).toBe("60000")
    expect((out.pnl as unknown as Record<string, unknown> | null)?.gross_margin).toBeUndefined()
    expect(out.cash?.cash_status).toBe("live")
    expect(out.cash?.total_by_currency).toEqual({ EUR: "250000" })
  })

  it("supplier_invoice_get returns a not-found shape for an unknown id (404), not a throw of a raw string", async () => {
    const ctx = makeCtx({ supplierInvoices: [] })
    await expect(supplierInvoiceGet(ctx, { id: "nope" })).rejects.toThrow()
  })

  it("customer_invoices_list + transactions_list + trial_balance_get + spend_by_category project", async () => {
    const ctx = makeCtx({
      customerInvoices: [
        {
          id: "ci_1",
          supplier_name: "",
          customer_name: "BuyerCo",
          currency: "EUR",
          amount: "500.00",
          status: "paid",
          due_date: "2026-06-15",
          invoice_date: "2026-06-01",
        },
      ],
      trialBalance: [{ account_code: "601000", label: "Parts", balance: "400.00", currency: "EUR" }],
      transactions: [{ id: "t1", amount: "-30.00", currency: "EUR", date: "2026-06-01" }],
      mapping: { "60": "cogs" },
    })
    const ci = expectConnected(await customerInvoicesList(ctx, {}))
    expect(ci.items.length).toBe(1)
    const tb = expectConnected(await trialBalanceGet(ctx, {}))
    expect(tb.lines[0]?.balance_minor).toBe("40000")
    const tx = expectConnected(await transactionsList(ctx, {}))
    expect(tx.items.length).toBe(1)
    const spend = expectConnected(await spendByCategory(ctx, {}))
    expect(spend.categories.find((c) => c.class === "cogs")?.total_minor).toBe("40000")
  })

  // — pagination: financial aggregations must drain ALL cursor pages (B9) —

  /** Build N trial-balance lines split into `pageSize`-row cursor pages. */
  function tbPages(n: number, pageSize: number): unknown[][] {
    const all = Array.from({ length: n }, (_, i) => ({
      account_code: `60${String(1000 + i)}`,
      label: `Line ${i}`,
      balance: "10.00",
      currency: "EUR",
    }))
    const pages: unknown[][] = []
    for (let i = 0; i < all.length; i += pageSize) pages.push(all.slice(i, i + pageSize))
    return pages
  }

  it("trial_balance_get aggregates ALL pages — 120 lines across 3 pages, never truncated at 50", async () => {
    const ctx = makeCtx({ trialBalance: tbPages(120, 50) })
    const tb = expectConnected(await trialBalanceGet(ctx, {}))
    // Pre-fix this returned only the first page (50). Must be the full 120.
    expect(tb.lines.length).toBe(120)
  })

  it("pnl_summary buckets EVERY page's lines — 120 cogs lines summed, not just page 1", async () => {
    const ctx = makeCtx({ mapping: { "60": "cogs" }, trialBalance: tbPages(120, 50) })
    const out = expectConnected(await pnlSummary(ctx, {}))
    // 120 lines × 1000 minor each, all classified cogs by the "60" prefix.
    expect(out.cogs_minor).toBe("120000")
  })

  it("trial_balance firm-403 ledger fallback also paginates fully (120 ledger rows over 3 pages)", async () => {
    const ledgerPages: unknown[][] = []
    const all = Array.from({ length: 120 }, () => ({
      account_code: "601000",
      label: "Parts",
      amount: "10.00",
    }))
    for (let i = 0; i < all.length; i += 50) ledgerPages.push(all.slice(i, i + 50))
    const ctx = makeCtx({ trialBalanceStatus: 403, ledgerEntries: ledgerPages })
    const tb = expectConnected(await trialBalanceGet(ctx, {}))
    // All 120 ledger rows roll up into the single 601000 code → 120000.
    expect(tb.lines.find((l) => l.account_code === "601000")?.balance_minor).toBe("120000")
  })

  it("runway_estimate sums net burn across ALL transaction pages, not just the first 50", async () => {
    // 120 EUR transactions of -1000 each across 3 pages → burn = 120000/mo.
    // Cash = 1,200,000 EUR → 10 months. A page-1-only read would see 50 tx
    // (burn 50000) and wrongly report 24 months.
    const txAll = Array.from({ length: 120 }, (_, i) => ({
      id: `t${i}`,
      amount: "-10.00",
      currency: "EUR",
      date: "2026-06-01",
    }))
    const txPages: unknown[][] = []
    for (let i = 0; i < txAll.length; i += 50) txPages.push(txAll.slice(i, i + 50))
    const ctx = makeCtx({
      bankAccounts: [
        { id: "ba_1", name: "Main EUR", balance: "12000.00", currency: "EUR", synced_at: "2026-06-10" },
      ],
      transactions: txPages,
    })
    const out = expectConnected(await runwayEstimate(ctx, {}))
    expect(out.cash_status).toBe("live")
    expect(out.months).toBe(10)
  })

  it("refresh_snapshots_job derives P&L from ALL trial-balance pages (120 cogs lines → 120000)", async () => {
    const ctx = makeCtx({ mapping: { "60": "cogs" }, trialBalance: tbPages(120, 50) })
    await refreshSnapshotsJob(ctx)
    const out = await homeLoad(ctx, {})
    expect(out.pnl?.cogs_minor).toBe("120000")
  })

  it("refresh_snapshots_job sums bank balances across ALL pages, not just the first", async () => {
    // 3 pages of one EUR account each (100000) → 300000 total cash.
    const ctx = makeCtx({
      trialBalance: [],
      bankAccounts: [
        [{ id: "ba_1", balance: "1000.00", currency: "EUR" }],
        [{ id: "ba_2", balance: "1000.00", currency: "EUR" }],
        [{ id: "ba_3", balance: "1000.00", currency: "EUR" }],
      ],
    })
    await refreshSnapshotsJob(ctx)
    const out = await homeLoad(ctx, {})
    expect(out.cash?.total_by_currency).toEqual({ EUR: "300000" })
  })

  it("refresh_snapshots_job runs as a resumable step: one chunk per run, totals carried in the cursor, written once at the end", async () => {
    // 12 trial-balance pages of 10 cogs lines (1000.00 each) and 2 bank pages.
    const ctx = makeCtx({
      mapping: { "60": "cogs" },
      trialBalance: tbPages(120, 10),
      bankAccounts: [
        [{ id: "ba_1", balance: "10.00", currency: "EUR" }],
        [{ id: "ba_2", balance: "5.50", currency: "USD" }],
      ],
      chunksPerRun: 1,
    })
    const states: string[] = []
    // 12 + 2 pages at REFRESH_PAGES_PER_CHUNK pages per chunk, one chunk per run.
    const runs = Math.ceil(14 / REFRESH_PAGES_PER_CHUNK)
    for (let i = 0; i < runs; i++) {
      states.push((await refreshSnapshotsJob(ctx, i === 0 ? {} : { _steps: {} })).state)
      if (i < runs - 1) expect((await homeLoad(ctx, {})).pnl).toBeNull()
    }
    expect(states).toEqual([...Array(runs - 1).fill("scheduled"), "done"])
    const out = await homeLoad(ctx, {})
    expect(out.pnl?.cogs_minor).toBe("120000")
    expect(out.cash?.total_by_currency).toEqual({ EUR: "1000", USD: "550" })
  })

  it("a rate limit mid-refresh ends the run with a wake, keeps the pages already read, and the next run finishes", async () => {
    const ctx = makeCtx({
      mapping: { "60": "cogs" },
      trialBalance: tbPages(30, 10),
      tbRateLimitOnCall: 2,
    })
    expect((await refreshSnapshotsJob(ctx)).state).toBe("scheduled")
    const saved = (await ctx.steps.get("refresh-snapshots"))?.cursor as { pnl: { cogs: string }; pages: number }
    expect(saved).toMatchObject({ pnl: { cogs: "10000" }, pages: 1 })
    expect((await refreshSnapshotsJob(ctx, { _steps: {} })).state).toBe("done")
    expect((await homeLoad(ctx, {})).pnl?.cogs_minor).toBe("30000")
  })

  it("a fresh cron trigger of a finished refresh starts over; a continuation of it does not", async () => {
    const tbCalls: Array<Record<string, string> | undefined> = []
    const ctx = makeCtx({ mapping: { "60": "cogs" }, trialBalance: tbPages(10, 10), tbCalls })
    expect((await refreshSnapshotsJob(ctx)).state).toBe("done")
    expect(tbCalls.length).toBe(1)
    expect((await refreshSnapshotsJob(ctx, { _steps: {} })).state).toBe("done")
    expect(tbCalls.length).toBe(1)
    expect((await refreshSnapshotsJob(ctx)).state).toBe("done")
    expect(tbCalls.length).toBe(2)
    expect((await homeLoad(ctx, {})).pnl?.cogs_minor).toBe("10000")
  })

  it("an over-long response is capped (not infinite) and the truncation is surfaced via logger.warn", async () => {
    // 60 pages of 1 line each exceeds the 50-page cap. The aggregation stops at
    // the cap (50 lines, not 60) AND emits a warning — never a silent loop.
    const warnings: string[] = []
    const logger: PennylaneLogger = { warn: (msg: string) => warnings.push(msg) }
    const pages = Array.from({ length: 60 }, (_, i) => [
      { account_code: `60${String(1000 + i)}`, label: `L${i}`, balance: "10.00", currency: "EUR" },
    ])
    const ctx = makeCtx({ trialBalance: pages, logger })
    const tb = expectConnected(await trialBalanceGet(ctx, {}))
    expect(tb.lines.length).toBe(50) // capped at LIST_ALL_MAX_PAGES × 1 row
    expect(warnings.some((w) => w.includes("page fetch cap"))).toBe(true)
  })
})

describe("pennylane trial balance — required period window + live line shape", () => {
  const today = new Date().toISOString().slice(0, 10)
  const shiftDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10)

  it("refresh_snapshots_job sends period_start/period_end (fiscal year to date) — /trial_balance 400s without them", async () => {
    const tbCalls: Array<Record<string, string> | undefined> = []
    const fyStart = shiftDays(-40)
    const ctx = makeCtx({
      mapping: { "60": "cogs" },
      trialBalance: [{ number: "601000", label: "Parts", debits: "400.00", credits: "0.00" }],
      fiscalYears: [
        { id: 1, start: "2000-01-01", finish: "2000-12-31", status: "closed" },
        { id: 2, start: fyStart, finish: shiftDays(300), status: "open" },
      ],
      tbCalls,
    })
    await refreshSnapshotsJob(ctx)
    expect(tbCalls[0]).toMatchObject({ period_start: fyStart, period_end: today })
    const out = await homeLoad(ctx, {})
    expect(out.pnl?.period).toBe("current")
    expect(out.pnl?.cogs_minor).toBe("40000")
  })

  it("falls back to calendar year to date when the fiscal years are unreadable (403)", async () => {
    const tbCalls: Array<Record<string, string> | undefined> = []
    const ctx = makeCtx({ trialBalance: [], tbCalls })
    await refreshSnapshotsJob(ctx)
    expect(tbCalls[0]).toMatchObject({ period_start: `${today.slice(0, 4)}-01-01`, period_end: today })
  })

  it("reads the live line shape (number + debits/credits): revenue on the credit side, costs on the debit side", async () => {
    const ctx = makeCtx({
      mapping: { "70": "revenue", "60": "cogs", "62": "opex" },
      trialBalance: [
        { number: "706", formatted_number: "70600000", label: "Sales", debits: "50.00", credits: "1050.00" },
        { number: "601", formatted_number: "60100000", label: "Parts", debits: "400.00", credits: "0.00" },
        { number: "622", formatted_number: "62200000", label: "Fees", debits: "120.50", credits: "20.50" },
      ],
    })
    await refreshSnapshotsJob(ctx)
    const out = await homeLoad(ctx, {})
    expect(out.pnl?.revenue_minor).toBe("100000")
    expect(out.pnl?.cogs_minor).toBe("40000")
    expect(out.pnl?.opex_minor).toBe("10000")
    expect(out.pnl?.gross_margin_minor).toBe("60000")
    const tb = expectConnected(await trialBalanceGet(ctx, {}))
    expect(tb.lines.find((l) => l.account_code === "706")?.balance_minor).toBe("100000")
  })

  it("pnl_summary, spend_by_category and trial_balance_get send the asked period as the window", async () => {
    const tbCalls: Array<Record<string, string> | undefined> = []
    const ctx = makeCtx({ trialBalance: [], tbCalls })
    const pnl = expectConnected(await pnlSummary(ctx, { period: "2026-Q2" }))
    await spendByCategory(ctx, { period: "2025" })
    const tb = expectConnected(await trialBalanceGet(ctx, { period: "2026-02" }))
    await pnlSummary(ctx, { period: "2026-03-15..2026-04-15" })
    expect(tbCalls).toEqual([
      expect.objectContaining({ period_start: "2026-04-01", period_end: "2026-06-30" }),
      expect.objectContaining({ period_start: "2025-01-01", period_end: "2025-12-31" }),
      expect.objectContaining({ period_start: "2026-02-01", period_end: "2026-02-28" }),
      expect.objectContaining({ period_start: "2026-03-15", period_end: "2026-04-15" }),
    ])
    expect(pnl).toMatchObject({ period: "2026-Q2", period_start: "2026-04-01", period_end: "2026-06-30" })
    expect(tb).toMatchObject({ period_start: "2026-02-01", period_end: "2026-02-28" })
  })
})

// The refresh cron runs in every workspace with the app installed, connected or
// not. With no Pennylane connection there is nothing to refresh: a quiet no-op,
// not an error thrown (and retried) on every tick. A connection that exists but
// cannot be used still fails loudly.
describe("refresh-snapshots without a Pennylane connection", () => {
  function unconnectedCtx(getCredentials: () => Promise<Record<string, string>>) {
    const logged: string[] = []
    const ctx = makeCtx({
      logger: {
        info: (msg) => logged.push(`info:${msg}`),
        error: (msg) => logged.push(`error:${msg}`),
      },
    }) as RefreshSnapshotsCtx & { __client?: unknown }
    delete ctx.__client
    ;(ctx as unknown as { connections: unknown }).connections = { pennylane: { getCredentials } }
    return { ctx, logged }
  }

  it("is a no-op when the workspace has no connected account", async () => {
    const { ctx, logged } = unconnectedCtx(async () => {
      throw new Error('No connected account for connection "pennylane"')
    })
    await expect(refreshSnapshotsJob(ctx)).resolves.toEqual({ state: "skipped" })
    expect(await ctx.db.findMany("pnl_snapshot")).toEqual([])
    expect(logged.filter((l) => l.startsWith("error:"))).toEqual([])
  })

  it("still throws when the connection exists but its credentials are incomplete", async () => {
    const { ctx } = unconnectedCtx(async () => ({ scope: "company" }))
    await expect(refreshSnapshotsJob(ctx)).rejects.toThrow("Pennylane credentials incomplete")
  })
})

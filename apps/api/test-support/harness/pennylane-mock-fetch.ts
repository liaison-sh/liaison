// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Deep-week-sim finance harness — server-side Pennylane external-API mock.
//
// THE Pennylane app is a REAL bundled app (bundled-apps/pennylane). This deep
// mock stands in ONLY for the external Pennylane HTTP API boundary
// (app.pennylane.com) — never for the connector capability itself. The ralph
// loop runs the finance scenarios against the real app; this mock makes the
// external book deterministic and lets the fault registry exercise all three
// connect-probe verdicts (full_scope / invoice_only / blocked_finance) without a
// live PENNYLANE_API_TOKEN.
//
// Modeled section-for-section on boxtal-mock-fetch.ts:
//   * matches on hostname — `app.pennylane.com` (external-v2 JSON) — and returns
//     canned `Response`s from a fixed, internally-consistent seeded book.
//   * delegates to the REAL `fetch` for every other host, so the Boxtal/Shopify/
//     social suites on the same spawned server are untouched.
//   * records every Pennylane request `{ url, method, headers, body, actor }` so
//     scenarios can assert read shapes / per-actor isolation.
//   * a mutable per-scenario MODE registry (full / invoice_only / blocked_finance)
//     is seeded by the `_test` control route (pennylane-install-routes.ts). The
//     mode is a per-server-process global, so Pennylane scenarios MUST run
//     serially within a worker (the default for `.scenario.test.ts`).

// — recorder —

export interface PennylaneMockRecord {
  url: string
  method: string
  /** Lowercased header map (Bun normalizes header names to lowercase). */
  headers: Record<string, string>
  /** Actor marker the bridge injects when LIAISON_TEST_INJECT_ACTOR=1. */
  actor: string | null
  body: string | null
  receivedAt: number
}

const records: PennylaneMockRecord[] = []

export function pennylaneMockAllRequests(): PennylaneMockRecord[] {
  return [...records]
}
export function pennylaneMockClearRequests(): void {
  records.length = 0
}

// — mutable per-scenario MODE registry —

/**
 * The three locked connect-probe verdicts (§5.5):
 *   - `full`            = supplier_invoices 200, bank_accounts 200 → full scope, cash live.
 *   - `invoice_only`    = bank_accounts 403 → invoice-only degrade, cash unavailable (NOT blocked).
 *   - `blocked_finance` = supplier_invoices 403 → BLOCKED finance class.
 */
export type PennylaneMockMode = "full" | "invoice_only" | "blocked_finance"

interface PennylaneMockState {
  mode: PennylaneMockMode
  /** When true, the FIRST call per process 429s then 200s (exercises the client retry). */
  rateLimitOnce: boolean
  /** When true, /trial_balance 403s so the connector reconstructs from /ledger_entries. */
  firm403: boolean
  /** Internal: whether the next call should be the (consumed) 429. */
  pendingRateLimit: boolean
}

const state: PennylaneMockState = {
  mode: "full",
  rateLimitOnce: false,
  firm403: false,
  pendingRateLimit: false,
}

export function setPennylaneMockMode(
  mode: PennylaneMockMode,
  opts?: { rateLimitOnce?: boolean; firm403?: boolean },
): void {
  state.mode = mode
  if (opts?.rateLimitOnce !== undefined) {
    state.rateLimitOnce = opts.rateLimitOnce
    state.pendingRateLimit = opts.rateLimitOnce
  }
  if (opts?.firm403 !== undefined) state.firm403 = opts.firm403
}

export function resetPennylaneMockMode(): void {
  state.mode = "full"
  state.rateLimitOnce = false
  state.firm403 = false
  state.pendingRateLimit = false
}

// — seeded book (internally consistent: trial balance reconciles to the asserted P&L) —

// UNITS, and the whole reason this block carries a warning: the Pennylane v2
// API returns money as MAJOR-unit decimal strings ("400.00"), and the connector
// parses them into minor units. A fixture written in minor units therefore
// arrives at the assertions 100x too large, which is exactly what happened when
// the book was scaled for board realism. Every money value below is a
// MAJOR-unit decimal string, the shape the real API sends.
interface SeededInvoice {
  id: string
  supplier_name?: string
  customer_name?: string
  currency: string
  /** Major-unit decimal string, as the API sends it. */
  amount: string
  status: string
  due_date: string
  invoice_date: string
}

const SUPPLIER_INVOICES: SeededInvoice[] = [
  {
    id: "si_1",
    supplier_name: "Acme Parts",
    currency: "EUR",
    amount: "400.00",
    status: "unpaid",
    due_date: "2026-07-01",
    invoice_date: "2026-06-01",
  },
  {
    id: "si_2",
    supplier_name: "Bricolage SARL",
    currency: "EUR",
    amount: "50.00",
    status: "paid",
    due_date: "2026-06-10",
    invoice_date: "2026-05-20",
  },
  {
    id: "si_3",
    supplier_name: "Cloud Hosting",
    currency: "EUR",
    amount: "12.00",
    status: "unpaid",
    due_date: "2026-07-05",
    invoice_date: "2026-06-05",
  },
]

const CUSTOMER_INVOICES: SeededInvoice[] = [
  {
    id: "ci_1",
    customer_name: "BuyerCo",
    currency: "EUR",
    amount: "100000.00",
    status: "paid",
    due_date: "2026-06-15",
    invoice_date: "2026-06-01",
  },
]

// BOARD-REALISTIC SCALE: net revenue is €100,000/quarter, of which the ~€18.7k Q2 DTC slice
// from the LIVE Shopify dev store this chaos world wires in is a coherent ~19% — the
// corroboration the rubric asks for. A smaller book made the ground-truth persona (correctly)
// flag the total as impossible for a quarter, which pushed the agent into fabricating a
// replacement figure. All RATIOS hold (gross_margin = revenue − COGS = 60%).
//
// In MAJOR units, as the API sends them. Parsed to minor, the book is: revenue 10000000
// (707000), cogs 4000000 (601000), opex 500000 (627000) → gross_margin 6000000 (€60,000, 60%).
const TRIAL_BALANCE = [
  { account_code: "707000", label: "Sales", balance: "100000.00", currency: "EUR" },
  { account_code: "601000", label: "Parts", balance: "40000.00", currency: "EUR" },
  { account_code: "627000", label: "Bank fees", balance: "5000.00", currency: "EUR" },
]

// Ledger entries reconstruct the same trial balance (firm-403 fallback).
const LEDGER_ENTRIES = [
  { account_code: "707000", label: "Sales", amount: "100000.00" },
  { account_code: "601000", label: "Parts", amount: "40000.00" },
  { account_code: "627000", label: "Bank fees", amount: "5000.00" },
]

const BANK_ACCOUNTS = [
  { id: "ba_1", name: "Main EUR", balance: "300000.00", currency: "EUR", synced_at: "2026-06-10" },
  { id: "ba_2", name: "USD ops", balance: "90000.00", currency: "USD", synced_at: "2026-06-10" },
]

// Transactions yield a deterministic trailing net burn (outflows are negative).
// €30,000/mo burn against €300,000 EUR cash → 10 months runway.
const TRANSACTIONS = [{ id: "t1", amount: "-30000.00", currency: "EUR", date: "2026-06-01" }]

// — response helpers —

function jsonResponse(body: unknown, httpStatus = 200): Response {
  return new Response(JSON.stringify(body), {
    status: httpStatus,
    headers: { "content-type": "application/json" },
  })
}

function pageResponse<T>(items: T[]): Response {
  return jsonResponse({ items, next_cursor: null, has_more: false })
}

function forbidden(resource: string): Response {
  return jsonResponse({ message: `${resource} forbidden` }, 403)
}

// — query helpers —

function decodeFilter(url: string): Array<{ field: string; operator: string; value: unknown }> {
  const u = new URL(url)
  const raw = u.searchParams.get("filter")
  if (!raw) return []
  try {
    return JSON.parse(raw) as Array<{ field: string; operator: string; value: unknown }>
  } catch {
    return []
  }
}

function applyLimit(url: string, items: SeededInvoice[]): SeededInvoice[] {
  const u = new URL(url)
  const limit = Number(u.searchParams.get("limit") ?? "50")
  return items.slice(0, Math.min(limit, 100))
}

function applyStatusFilter(
  items: SeededInvoice[],
  filter: Array<{ field: string; operator: string; value: unknown }>,
): SeededInvoice[] {
  const statusClause = filter.find((f) => f.field === "status" && f.operator === "eq")
  if (!statusClause) return items
  return items.filter((i) => i.status === statusClause.value)
}

// — host predicate + install gate —

const PENNYLANE_HOST = "app.pennylane.com"

/** Hosts the Pennylane mock serves canned bytes for (the bridge calls it directly). */
export function pennylaneMockHandlesHost(hostname: string): boolean {
  return hostname === PENNYLANE_HOST
}

/**
 * The e2e server installs the Pennylane external-API mock UNLESS live mode is
 * explicitly opted in. `PENNYLANE_E2E_LIVE === "1"` bypasses the mock so every
 * Pennylane-host outbound call reaches the real sandbox via the production
 * `fetchWithPinnedHost` path. Any other value (unset, "", "0", "false") keeps the
 * deterministic mock — the CI default, regardless of PENNYLANE_API_TOKEN.
 */
export function shouldInstallPennylaneMock(
  env: { PENNYLANE_E2E_LIVE?: string | undefined; [key: string]: string | undefined } = process.env,
): boolean {
  return env.PENNYLANE_E2E_LIVE !== "1"
}

type FetchInput = Parameters<typeof fetch>[0]
type FetchInit = Parameters<typeof fetch>[1]

export function makePennylaneMockFetch(realFetch: typeof fetch = fetch): typeof fetch {
  return (async (input: FetchInput, init?: FetchInit): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url
    let host: string
    try {
      host = new URL(url).hostname
    } catch {
      return realFetch(input, init)
    }

    if (host !== PENNYLANE_HOST) {
      // Not a Pennylane host — defer to the real fetch (keeps Boxtal/Shopify/
      // social scenarios on the same spawned server working unchanged).
      return realFetch(input, init)
    }

    const method = (init?.method ?? "GET").toUpperCase()
    const headers: Record<string, string> = {}
    if (init?.headers) {
      const h = new Headers(init.headers)
      h.forEach((v, k) => {
        headers[k.toLowerCase()] = v
      })
    }
    const body = typeof init?.body === "string" ? init.body : null
    records.push({
      url,
      method,
      headers,
      actor: headers["x-liaison-actor"] ?? null,
      body,
      receivedAt: Date.now(),
    })

    // Rate-limit once (exercises the client's single 429-retry) — consumed.
    if (state.pendingRateLimit) {
      state.pendingRateLimit = false
      return jsonResponse({ message: "rate limited" }, 429)
    }

    const path = new URL(url).pathname

    // — supplier invoices —
    const supplierGetMatch = path.match(/^\/api\/external\/v2\/supplier_invoices\/([^/]+)$/)
    if (supplierGetMatch && method === "GET") {
      const id = decodeURIComponent(supplierGetMatch[1]!)
      const found = SUPPLIER_INVOICES.find((i) => i.id === id)
      return found ? jsonResponse(found) : jsonResponse({ message: "not found" }, 404)
    }
    if (path === "/api/external/v2/supplier_invoices" && method === "GET") {
      if (state.mode === "blocked_finance") return forbidden("supplier_invoices")
      const filtered = applyStatusFilter(applyLimit(url, SUPPLIER_INVOICES), decodeFilter(url))
      return pageResponse(filtered)
    }

    // — customer invoices —
    if (path === "/api/external/v2/customer_invoices" && method === "GET") {
      const filtered = applyStatusFilter(applyLimit(url, CUSTOMER_INVOICES), decodeFilter(url))
      return pageResponse(filtered)
    }

    // — trial balance (firm-403 → ledger fallback) —
    if (path === "/api/external/v2/trial_balance" && method === "GET") {
      if (state.firm403) return forbidden("trial_balance")
      // Like the live API: both window bounds are required (YYYY-MM-DD), else 400.
      const q = new URL(url).searchParams
      for (const field of ["period_start", "period_end"]) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(q.get(field) ?? "")) {
          return jsonResponse(
            { message: `${field} is missing or invalid`, field, code: "InvalidDateFormat" },
            400,
          )
        }
      }
      return pageResponse(TRIAL_BALANCE)
    }
    if (path === "/api/external/v2/ledger_entries" && method === "GET") {
      return pageResponse(LEDGER_ENTRIES)
    }

    // — bank accounts (403 in invoice_only / blocked_finance) —
    if (path === "/api/external/v2/bank_accounts" && method === "GET") {
      if (state.mode === "invoice_only" || state.mode === "blocked_finance") {
        return forbidden("bank_accounts")
      }
      return pageResponse(BANK_ACCOUNTS)
    }

    // — transactions —
    if (path === "/api/external/v2/transactions" && method === "GET") {
      return pageResponse(TRANSACTIONS)
    }

    // Unhandled Pennylane path — 404 with an inspectable body.
    return jsonResponse({ mock: "pennylane", unhandled: path, method }, 404)
  }) as typeof fetch
}

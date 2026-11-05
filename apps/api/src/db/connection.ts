// SPDX-License-Identifier: FSL-1.1-ALv2
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { poolPlan } from "~/db/process-pool-plan"
import { env } from "~/lib/env"

/** The login that serves request transactions when the logins are split. */
export const REQUEST_LOGIN = "liaison_request"

/**
 * DATABASE_URL with the request login's credentials, or null when
 * DATABASE_REQUEST_PASSWORD is unset (every pool then shares DATABASE_URL).
 * Host, port, database and options stay DATABASE_URL's, so the two logins can
 * never point at different databases.
 */
export function requestDatabaseUrl(
  databaseUrl: string = env.DATABASE_URL,
  password: string | undefined = env.DATABASE_REQUEST_PASSWORD,
): string | null {
  if (!password) return null
  const url = new URL(databaseUrl)
  url.username = REQUEST_LOGIN
  url.password = encodeURIComponent(password)
  return url.toString()
}

/**
 * Builds one postgres.js pool with `max` connection slots, on DATABASE_URL
 * unless another URL is given. Returns the raw client (for `end()` and
 * tagged-template queries) and its drizzle handle.
 */
export function createPool(max: number, url: string = env.DATABASE_URL) {
  const client = postgres(url, {
    max,
    idle_timeout: 20,
    connect_timeout: env.DB_CONNECT_TIMEOUT,
    // Suppress postgres.js's pretty-printed NOTICE forwarding to stdout. NOTICEs
    // are still emitted by the server and logged there (`postgresql.conf` →
    // `log_min_messages = NOTICE`) — that's the authoritative source for
    // anything operationally interesting (cascading drops, RAISE NOTICE from
    // PL/pgSQL helpers). On the client side they're almost always repeats of
    // expected idempotent DDL, and flooding stdout breaks the strobe log
    // filter's signal-to-noise budget for test runs.
    onnotice: () => {},
  })
  return { client, db: drizzle(client) }
}

export type DbPool = ReturnType<typeof createPool>

const requestUrl = requestDatabaseUrl()

// Every pool below is sized by this process's pool plan (db/process-pool-plan.ts).

// The main pool connects as DATABASE_URL, the privileged login. It serves the
// outbox worker, the health probes and shutdown; it is also the request pool
// when the logins are not split. Split, request traffic has its own pool, so
// this one keeps a few slots only.
const mainPool = createPool(poolPlan.pools.main)

export const sql = mainPool.client

// Renamed from `db` — the name signals at the import site that this is the
// privileged, RLS-bypassing handle. Services MUST consume RlsClient via
// withRequestRls. The CI guard in scripts/lint-db-connection-import.ts
// enforces an explicit allowlist of importers.
export const __privileged_db__ = mainPool.db

// The REQUEST pool: every withRlsContext transaction on the interactive path.
// With DATABASE_REQUEST_PASSWORD set it logs in as liaison_request, which can
// step into liaison_rls and nothing else, so SQL run from a request
// transaction cannot reach BYPASSRLS, a table owner or a policy owner.
export const __request_pool_db__ = requestUrl
  ? createPool(poolPlan.pools.request, requestUrl).db
  : mainPool.db

// DEDICATED privileged-operations pool (BL-131 root fix). withPrivilegedDb /
// withSystemDb / withSchemaAdmin run their transactions on THIS pool — separate from
// the request pool that withRlsContext (the RLS/request path) uses. Why: a gated
// approved handler runs inside an RLS transaction (a connection from the request pool) and then
// NESTS a privileged read to resolve the org-owned app connection token (org-owned
// connected_accounts are RLS-invisible, so the kernel reads them privileged). If both
// drew from one pool, the held RLS connection + the nested privileged connection are 2
// slots per handler, and concurrent handlers EXHAUST the pool — the nested acquire then
// waits unbounded (postgres.js queues slot-acquire with no timeout), hitting the 300s
// sandbox ceiling ("App execution timed out"). With a separate pool the nested privileged
// read can never compete with the RLS connection it is nested inside, so the re-entrancy
// deadlock is structurally eliminated. Transaction semantics are unchanged (withPrivilegedDb
// was always a separate tx); only the pool differs. The acquire-timeout in privileged.ts
// remains a loud fast-fail safety net for any residual privileged-pool pressure.
export const __privileged_pool_db__ = createPool(poolPlan.pools.privileged).db

// DEDICATED background-jobs pool. BullMQ job handlers (and webhook retries /
// event-subscription handlers) hold their RLS transaction open across the
// ENTIRE handler run — for manifest apps that includes executeInSandbox doing
// network I/O (IMAP sync, Shopify, social discovery) for 30–300s with the
// connection sitting "idle in transaction". On a shared pool, a handful of
// slow syncs across app queues (concurrency 5 each) exhausts every slot and
// starves the interactive path: MCP tool calls, HTTP requests, and agent runs
// all die with DbAcquireTimeoutError even though they'd only need a slot for
// milliseconds. Observed live on staging as recurring MCP outages. Same
// isolation trick as the privileged pool above: background work and
// interactive work can no longer compete for the same slots. Background jobs
// may still saturate THIS pool under heavy sync load — then jobs queue/retry
// (their normal failure mode) while the product stays responsive.
//
// Two of them when the logins are split: the RLS transactions of background
// work log in as the request login like every other RLS transaction, and the
// privileged transactions it runs (withPrivilegedDb with pool "jobs") as
// DATABASE_URL. Unsplit, both are the one pool they always were.
const jobsPool = createPool(poolPlan.pools.jobs, requestUrl ?? undefined)
export const __jobs_pool_db__ = jobsPool.db
export const __privileged_jobs_pool_db__ = requestUrl
  ? createPool(poolPlan.pools.privilegedJobs).db
  : jobsPool.db

// ── Statement counting, for budget tests ────────────────────────────────────

type DebugHook = (connection: number, query: string) => void
type PoolOptions = { debug?: DebugHook | boolean }

/** Every distinct pool client of this process (unsplit logins share one). */
function poolClients(): PoolOptions[] {
  const dbs = [
    __privileged_db__,
    __request_pool_db__,
    __privileged_pool_db__,
    __jobs_pool_db__,
    __privileged_jobs_pool_db__,
  ]
  const clients = new Set(dbs.map((d) => d.$client as unknown as { options: PoolOptions }))
  return [...clients].map((c) => c.options)
}

/**
 * Count the statements (round trips) and transactions every pool of this
 * process sends until `stop()`. For budget tests: a count does not move with
 * how busy the machine is, a wall clock does. It sets postgres.js's `debug`
 * hook on each pool for the window only; while it is set, a query error
 * carries its query text and parameters as enumerable fields, so production
 * code never calls this.
 */
export function startStatementCount(): { stop(): { statements: number; transactions: number } } {
  let statements = 0
  let transactions = 0
  const hook: DebugHook = (_connection, query) => {
    statements++
    if (/^\s*begin\b/i.test(query)) transactions++
  }
  const options = poolClients()
  const previous = options.map((o) => o.debug)
  for (const o of options) o.debug = hook
  return {
    stop() {
      options.forEach((o, i) => {
        o.debug = previous[i]
      })
      return { statements, transactions }
    },
  }
}

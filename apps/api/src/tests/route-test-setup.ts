// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Shared setup/teardown for route integration tests.
 *
 * Route tests TRUNCATE shared tables and bootstrap from scratch.
 * Since bun test runs all files in a single process, we use a JS-level
 * mutex (promise queue) to serialise file-level setup/teardown so
 * concurrent beforeAll hooks don't wipe each other's data mid-run.
 */
import { ensureTestInfra } from "@liaison/test-helpers"
import postgres from "postgres"
import { sql } from "~/db"
import { withAcquireTimeout } from "~/db/acquire-timeout"
import { env } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import { REDIS_PREFIX, redis } from "~/lib/redis"
import { resetInstallTrustCache } from "~/modules/apps/install-trust"

const log = rootLogger.child({ module: "route-test-setup" })

// The cross-file advisory lock guards the tables this process resets: those of
// its database (DATABASE_URL) under its schema prefix. A Postgres advisory lock
// is scoped to the database it is taken in, so processes on different databases
// (the unit runner's shards, liaison_test_<ns>_s<N>) never contend on one key,
// and processes on the SAME database must share it. It used to be offset by
// WORKER_ID, which is not that resource: under test:e2e:parallel every lane slot
// has its own WORKER_ID while the in-process scenario files on those slots
// (agent-memory, durable-runtime, ...) all reset and seed the same unprefixed
// `kernel` tables of the namespace database, so one file's reset deleted the
// rows another file had just seeded (an FK violation on kernel.messages ->
// kernel.threads, mid-scenario). The key is now derived from the schema prefix
// alone: the bare suite and every file of one database share it.
const ROUTE_TEST_LOCK_ID = 9_381_274_651 + schemaPrefixLockOffset(process.env.SCHEMA_PREFIX ?? "")

/** A small stable offset per schema prefix (0 for none): FNV-1a, folded to 20 bits. */
function schemaPrefixLockOffset(prefix: string): number {
  if (!prefix) return 0
  let h = 0x811c9dc5
  for (let i = 0; i < prefix.length; i++) {
    h ^= prefix.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return (h & 0xfffff) + 1
}

// How long a file waits for that lock. Files of one database now queue on it
// for real (several in-process e2e files run at once), so the wait has to cover
// a whole other file's hold, not only detect a lock leaked by a crashed run;
// it stays under bun's per-hook cap (BUN_TEST_TIMEOUT_MS) so a stuck holder
// still fails loudly here rather than as an anonymous hook timeout.
const ROUTE_TEST_LOCK_WAIT_MS = (() => {
  const cap = Number(process.env.BUN_TEST_TIMEOUT_MS)
  return Number.isFinite(cap) && cap > 0 ? Math.floor(cap * 0.75) : 45_000
})()

// ── JS-level mutex (single-process, works because bun test is single-threaded) ──

let _lock: Promise<void> = Promise.resolve()
let _resolve: (() => void) | null = null
let _dbLockConnection: Awaited<ReturnType<typeof sql.reserve>> | null = null

async function acquireMutex(): Promise<void> {
  // Wait for the previous holder to finish
  await _lock
  // Create a new gate that the next caller will await
  _lock = new Promise((r) => {
    _resolve = r
  })
}

function releaseMutex(): void {
  _resolve?.()
  _resolve = null
  _holderFile = null
}

// The test file that holds the lock. bun runs files one after another, so when
// a DIFFERENT file asks for the lock while it is still held, the holder has
// already finished every hook it will ever run: its afterAll threw before it
// reached releaseTestLock (a cleanup DELETE that deadlocked, say), and nothing
// is left to release it. Waiting on it hung every later file's beforeAll for
// the rest of the run (dozens of 60s "(unnamed)" failures in src/modules/threads
// behind one cleanup error). The new file takes the lock over instead, loudly;
// its own acquire truncates whatever the leaker left behind.
let _holderFile: string | null = null

/** The first `*.test.ts(x)` path in a stack trace: the file asking for the lock. */
export function testFileFromStack(stack: string | undefined): string | null {
  for (const line of (stack ?? "").split("\n")) {
    const m = line.match(/((?:\/|[A-Za-z]:\\)[^():\s]*\.test\.tsx?)/)
    if (m?.[1]) return m[1]
  }
  return null
}

/**
 * Acquire a Postgres session-level advisory lock on `conn`, bounded by
 * `timeoutMs` instead of the unbounded wait `pg_advisory_lock` gives by
 * default. This is a bare query on a reserved connection, not a
 * `db.transaction()`, so it gets none of withPrivilegedDb's / withRlsContext's
 * existing DbAcquireTimeoutError protection -- if a previous run crashed (or
 * was killed) while holding this same lock key without unlocking, every
 * future acquire here hung FOREVER with no timeout and no log line, because
 * nothing ever rejected. That silent hang is exactly what starved the whole
 * route-test-setup mutex queue test-suite-wide: the JS-level mutex in
 * `acquireTestLock` only releases from its `catch` block, which a hang (as
 * opposed to a rejection) never reaches.
 *
 * Once this rejects, `conn` must never be queried or released again: the
 * advisory-lock query may still be in flight server-side (the race below is
 * client-side only, it cannot cancel an in-flight query), so sending another
 * query -- including `pg_advisory_unlock` -- or returning `conn` to the pool
 * would queue behind that still-pending query and hang identically. The
 * caller is expected to simply drop `conn` on rejection, deliberately
 * sacrificing one physical socket only in this already-pathological case, in
 * exchange for a bounded, loud, diagnosable failure instead of an unbounded
 * silent one.
 */
export async function acquireAdvisoryLock(
  conn: Awaited<ReturnType<typeof sql.reserve>>,
  lockId: number,
  timeoutMs: number,
): Promise<void> {
  try {
    await withAcquireTimeout(
      `route-test-lock:pg_advisory_lock:${lockId}`,
      timeoutMs,
      conn`SELECT pg_advisory_lock(${lockId})`,
    )
  } catch (error) {
    log.error(
      { lockId, timeoutMs },
      "route test lock: pg_advisory_lock did not return within the timeout -- a previous " +
        "run likely crashed while holding this lock without releasing it; restart the " +
        "postgres container to clear it",
    )
    throw error
  }
}

async function acquireDbLock(): Promise<void> {
  const conn = await sql.reserve()
  await acquireAdvisoryLock(
    conn,
    ROUTE_TEST_LOCK_ID,
    Math.max(env.DB_ACQUIRE_TIMEOUT_MS, ROUTE_TEST_LOCK_WAIT_MS),
  )
  _dbLockConnection = conn
}

async function releaseDbLock(): Promise<void> {
  if (!_dbLockConnection) return

  try {
    await _dbLockConnection`SELECT pg_advisory_unlock(${ROUTE_TEST_LOCK_ID})`
  } finally {
    _dbLockConnection.release()
    _dbLockConnection = null
  }
}

// ── Helpers ──

/**
 * Delete every key matching these logical patterns, honouring REDIS_PREFIX.
 *
 * ioredis applies `keyPrefix` only to the arguments the command table marks as
 * KEYS, and KEYS itself takes a *pattern*, not a key: `redis.keys("reset-rate:*")`
 * goes to the server verbatim and matches nothing once the test runner hands the
 * process a private namespace, while the names it does return already carry the
 * prefix and would be prefixed a second time by DEL. Both halves are corrected
 * here, so a caller keeps writing the logical pattern it means.
 *
 * Left uncorrected this is not a loud failure: the cleanup silently becomes a
 * no-op and the rate-limit and brute-force counters a test file meant to reset
 * per test turn into one budget spent across the whole file.
 */
export async function clearRedisPatterns(patterns: string[]): Promise<void> {
  if (patterns.length === 0) return
  // ONE pass over the keyspace instead of one per pattern. KEYS is O(every key
  // in the Redis database), and the test database is shared with every other
  // checkout's runs (hundreds of thousands of keys), so eight patterns cost
  // eight full scans: about 40 ms each, twice per test file. With a private
  // prefix every key this process can own starts with it, so one KEYS on the
  // prefix plus a client-side glob match deletes exactly what the per-pattern
  // calls did. Without one (a bare run) the patterns are scanned one by one.
  const matchers = patterns.map(globToRegExp)
  const candidates = REDIS_PREFIX
    ? await redis.keys(`${REDIS_PREFIX}*`)
    : (await Promise.all(patterns.map((p) => redis.keys(p)))).flat()
  const doomed = new Set<string>()
  for (const key of candidates) {
    const logical = key.slice(REDIS_PREFIX.length)
    if (matchers.some((m) => m.test(logical))) doomed.add(logical)
  }
  const keys = [...doomed]
  for (let i = 0; i < keys.length; i += 1000) await redis.del(...keys.slice(i, i + 1000))
}

/** A Redis glob (`*`, `?`, `[...]`, backslash escapes) as an anchored RegExp. */
export function globToRegExp(glob: string): RegExp {
  let out = ""
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string
    if (c === "\\" && i + 1 < glob.length) out += `\\${glob[++i]}`
    else if (c === "*") out += "[\\s\\S]*"
    else if (c === "?") out += "[\\s\\S]"
    else if (c === "[") {
      const end = glob.indexOf("]", i + 1)
      if (end === -1) out += "\\["
      else {
        let body = glob.slice(i + 1, end)
        if (body.startsWith("^")) body = `^${body.slice(1)}`
        out += `[${body.replace(/\\/g, "\\\\")}]`
        i = end
      }
    } else out += c.replace(/[.+^${}()|\]\\/]/g, "\\$&")
  }
  return new RegExp(`^${out}$`)
}

async function clearRedis() {
  // `bull:*` is safe to clear here because .env.test points at a DEDICATED
  // redis DB (…/3): stale BullMQ repeat schedulers from previous runs
  // otherwise accumulate forever (dev/test formerly shared DB 0, so this
  // cleanup was impossible) and replay as "app not installed for that org"
  // job errors that stall suite hooks.
  const patterns = [
    "bull:*",
    "ratelimit:*",
    "bruteforce:*",
    "challenge:*",
    "refresh-grace:*",
    "reset-rate:*",
    "ws-ticket:*",
    "bootstrap-rate:*",
  ]
  await clearRedisPatterns(patterns)
}

/**
 * The tables a reset empties: these roots and, as TRUNCATE ... CASCADE adds
 * them, every table that references one of them by foreign key, transitively
 * (in practice nearly every kernel and app table, about 110 of them).
 */
const RESET_ROOTS = [
  "kernel.users",
  "kernel.organizations",
  "kernel.sessions",
  "kernel.roles",
  "kernel.role_scope_grants",
  "kernel.role_dimension_grants",
  "kernel.user_roles",
  "kernel.invitations",
  "kernel.password_resets",
  "kernel.audit_log",
  "kernel.contacts",
  "kernel.pending_events",
  "kernel.apps",
  "kernel.oauth_providers",
  "kernel.oauth_accounts",
  "kernel.device_flow_requests",
  "kernel.timeline_entries",
  "kernel.credit_balances",
  "kernel.credit_transactions",
  "kernel.model_pricing",
  "kernel.agent_memory",
  "kernel.approval_requests",
  "kernel.system_config",
  // The install registry. `apps_installed` already empties through its foreign
  // key to the organizations; these two have none, so without them a reset left
  // an active version with no install record behind, which the sandbox reads as
  // "no outbound domain granted" and every later test of that app then failed
  // with "Domain not in allowlist".
  "kernel.apps_installed",
  "kernel.apps_active_version",
  "kernel.app_activation_events",
]

/** 40P01 = deadlock_detected, 55P03 = lock_not_available (lock_timeout fired). */
function isTransientLockError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code
  return code === "40P01" || code === "55P03"
}

async function withLockRetry(fn: () => Promise<unknown>): Promise<void> {
  const MAX_ATTEMPTS = 8
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await fn()
      return
    } catch (error) {
      if (isTransientLockError(error) && attempt < MAX_ATTEMPTS) {
        await Bun.sleep(50 * attempt + Math.floor(Math.random() * 80))
        continue
      }
      throw error
    }
  }
}

/**
 * TRUNCATE needs an AccessExclusiveLock on every listed table. Background work
 * still in flight on other pooled connections — the outbox worker polling
 * `pending_events`, BullMQ workers, un-awaited writes from a prior test — holds
 * conflicting row locks, and the two sides can acquire locks in opposite order,
 * producing an intermittent deadlock (Postgres error 40P01). Postgres kills one
 * side; retrying the TRUNCATE is the canonical, correct resolution for a
 * transient deadlock. `lock_timeout` bounds each attempt so a merely-blocked
 * (non-deadlock) truncate also retries with backoff instead of hanging.
 */
async function truncateTablesSlow(): Promise<void> {
  await withLockRetry(() =>
    sql.begin(async (tx) => {
      await tx`SET LOCAL lock_timeout = '5s'`
      await tx.unsafe(`TRUNCATE ${RESET_ROOTS.join(", ")} CASCADE`)
    }),
  )
}

/**
 * A superuser connection to THIS process's test database, or null when there
 * is none to be had. DATABASE_URL_SUPERUSER is used when it names the same
 * database as DATABASE_URL (the runners set both); otherwise DATABASE_URL is
 * reused with the superuser credentials of PG_SUPERUSER_URL (the docker-compose
 * default, postgres/postgres). A connection that fails is never retried: the
 * reset falls back to TRUNCATE for the rest of the process.
 */
let _superuser: ReturnType<typeof postgres> | null | undefined

export function superuserUrlForTestDb(): string | null {
  try {
    const app = new URL(env.DATABASE_URL)
    const explicit = process.env.DATABASE_URL_SUPERUSER
    if (explicit && new URL(explicit).pathname === app.pathname) return explicit
    const su = new URL(
      process.env.PG_SUPERUSER_URL ?? "postgres://postgres:postgres@localhost:5432/postgres",
    )
    app.username = su.username
    app.password = su.password
    return app.toString()
  } catch {
    return null
  }
}

function superuserClient(): ReturnType<typeof postgres> | null {
  if (_superuser === undefined) {
    const url = superuserUrlForTestDb()
    _superuser = url
      ? postgres(url, { max: 1, idle_timeout: 20, connect_timeout: 10, onnotice: () => {} })
      : null
  }
  return _superuser
}

/**
 * The same end state as `TRUNCATE <roots> CASCADE` without its cost. TRUNCATE
 * swaps in a new file for every table and index it touches, about 110 tables
 * here, and that took 0.5 to 0.9 s per call: twice per test file plus once per
 * `createTestOrg`, the largest fixed cost of the unit suite. After a test only a
 * handful of those tables hold rows, so this computes the same cascade set from
 * the catalog (it changes as apps register their schemas, so it is read every
 * time), finds the non-empty tables in one query and DELETEs from those, in a
 * transaction with `session_replication_role = replica` so that, like TRUNCATE,
 * no row trigger fires and no foreign key is checked mid-way. Sequences are left
 * alone, as TRUNCATE without RESTART IDENTITY leaves them. Row locks instead of
 * AccessExclusive locks also make the deadlock with background workers rarer.
 */
async function fastReset(su: ReturnType<typeof postgres>): Promise<void> {
  await withLockRetry(() =>
    su.begin(async (tx) => {
      await tx`SET LOCAL lock_timeout = '5s'`
      await tx`SET LOCAL session_replication_role = replica`
      const tables = await tx<{ name: string }[]>`
        WITH RECURSIVE closure(rel) AS (
          SELECT to_regclass(r) FROM unnest(${RESET_ROOTS}::text[]) AS r
          WHERE to_regclass(r) IS NOT NULL
          UNION
          SELECT c.conrelid::regclass
          FROM pg_constraint c JOIN closure ON c.confrelid = closure.rel
          WHERE c.contype = 'f'
        )
        SELECT rel::text AS name FROM closure`
      if (tables.length === 0) return
      const probe = tables
        .map((t, i) => `SELECT ${i} AS i WHERE EXISTS (SELECT 1 FROM ${t.name})`)
        .join(" UNION ALL ")
      const nonEmpty = await tx.unsafe<{ i: number }[]>(probe)
      for (const { i } of nonEmpty) await tx.unsafe(`DELETE FROM ${tables[i]?.name}`)
    }),
  )
}

async function truncateTables(): Promise<void> {
  await truncateTablesUncached()
  // The install registry was just emptied: forget the grants read before it.
  resetInstallTrustCache()
}

async function truncateTablesUncached(): Promise<void> {
  const su = superuserClient()
  if (su) {
    try {
      await fastReset(su)
      return
    } catch (error) {
      if (isTransientLockError(error)) throw error
      log.warn(
        { err: error },
        "route test reset: superuser fast path unavailable, falling back to TRUNCATE",
      )
      _superuser = null
      await su.end({ timeout: 1 }).catch(() => {})
    }
  }
  await truncateTablesSlow()
}

// ── Public API ──

/**
 * Truncate all org-scoped kernel tables. Exposed so per-test bootstrap helpers
 * (`createTestOrg`) can reset between `beforeEach` cases — the consuming test
 * file must already hold the test lock (`acquireTestLock` in `beforeAll`).
 */
export async function truncateOrgTables() {
  await truncateTables()
}

/** Call in `beforeAll`. Acquires exclusive mutex, clears Redis, truncates tables. */
export async function acquireTestLock() {
  // Read before the first await: past it the caller's frame is gone.
  await acquireTestLockAs(testFileFromStack(new Error().stack))
}

async function acquireTestLockAs(caller: string | null): Promise<void> {
  // Ensure Postgres/Redis/Meilisearch/SeaweedFS are up before any test setup runs.
  // Idempotent + cached per process, so this is effectively free after first call.
  await ensureTestInfra()
  if (_resolve && _holderFile && caller && _holderFile !== caller) {
    log.error(
      { holder: _holderFile, next: caller },
      "route test lock: a finished test file never released the lock (its afterAll threw " +
        "before releaseTestLock); the next file takes it over",
    )
    await releaseDbLock().catch(() => {})
    releaseMutex()
  }
  await acquireMutex()
  _holderFile = caller
  try {
    await acquireDbLock()
    await clearRedis()
    await truncateTables()
  } catch (error) {
    await releaseDbLock()
    releaseMutex()
    throw error
  }
}

/** Call in `afterAll`. Clears Redis, truncates tables, releases mutex.
 *
 * Important: this function MUST appear callable with zero arguments because
 * `bun:test` inspects `fn.length` to decide whether the hook uses the
 * `(done) => void` callback style. If the function reports `.length > 0`,
 * bun passes a synthetic `done` callback as the first arg and waits for it
 * to fire — for a function that ignores its parameter, that wait never ends
 * and the hook surfaces a phantom "(unnamed)" TimeoutError after the default
 * 5s budget. We accomplish a zero-arity signature with an inner async impl
 * + outer arrow wrapper that drops any positional args.
 */
async function releaseTestLockImpl(truncate: boolean): Promise<void> {
  try {
    await clearRedis()
    // Only the holder of the database lock may reset the tables. A file whose
    // acquire failed (a timeout behind another file's hold) still runs its
    // afterAll, and a reset from there deleted the rows the holder had just
    // seeded, mid-scenario.
    if (truncate && _dbLockConnection) await truncateTables()
    else if (truncate) {
      log.warn(
        "route test lock: release without holding the database lock, tables left as they are",
      )
    }
  } finally {
    await releaseDbLock()
    releaseMutex()
  }
  // Yield once so any pending postgres-pool callbacks settle before bun's
  // hook-completion sweep.
  await Bun.sleep(10)
}

export const releaseTestLock = (() => releaseTestLockImpl(true)) as () => Promise<void>

/** Variant for tests that want to keep table contents (e.g. shared fixtures). */
export const releaseTestLockKeepRows = (() => releaseTestLockImpl(false)) as () => Promise<void>

/** Test seam: acquire as if called from `file` (the stale-holder takeover). */
export const RouteTestLockTestAccess = {
  acquireAs: (file: string) => acquireTestLockAs(file),
  holder: () => _holderFile,
}

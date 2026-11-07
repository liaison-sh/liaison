// SPDX-License-Identifier: FSL-1.1-ALv2
import { createHmac } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import type { RlsClient } from "~/db"
import { runUntilAborted } from "~/db/abortable-tx"
import { withAcquireTimeout } from "~/db/acquire-timeout"
import {
  poolSlot,
  recordAcquireTimeout,
  recordPoolAcquireTimeout,
  recordRlsTxEnd,
  recordRlsTxStart,
  recordStatementTimeout,
} from "~/db/pool-diag"
import { attachQueueEvent, type QueuedEventsMark, wakeOutboxAfterCommit } from "~/db/queue-event"
import { PRIVILEGED_ROLE_REACH_SQL } from "~/db/role-reach"
import { env } from "~/lib/env"
import {
  type DbPool,
  __request_pool_db__ as db,
  __jobs_pool_db__ as jobsDb,
  sql as privilegedSql,
} from "./connection"

export type SystemPurpose = "audit" | "timeline" | "webhook" | "job"

const SYSTEM_PURPOSE_SCOPES: Record<SystemPurpose, string[]> = {
  audit: ["kernel:audit:write"],
  timeline: ["kernel:timeline:write"],
  webhook: [], // Overridden per-call with app-specific scopes
  job: [], // Overridden per-call with app-specific scopes
}

export type UserContext = {
  actorType: "user"
  userId: string
  orgId: string
  scopes: string[]
  dimensionGrants: Record<string, string[]>
  /**
   * Role IDs the user holds (from the JWT `roles` claim). Pushed into the
   * `app.current_roles` GUC so RLS predicates (e.g. `app_knowledge.has_role`)
   * can gate on role membership — the basis for sharing a document with a role.
   * System/non-user actors have no roles.
   */
  roles?: string[]
}

export type SystemContext = {
  actorType: "system"
  orgId: string
  purpose: SystemPurpose
  /** Override default scopes for this purpose (e.g., webhook/job with app-specific scopes) */
  scopes?: string[]
}

export type ActorContext = UserContext | SystemContext

function resolveScopes(ctx: ActorContext): string[] {
  if (ctx.actorType === "user") return ctx.scopes
  return ctx.scopes ?? SYSTEM_PURPOSE_SCOPES[ctx.purpose]
}

function resolveUserId(ctx: ActorContext): string | null {
  if (ctx.actorType === "user") return ctx.userId
  return null
}

function resolveRoles(ctx: ActorContext): string[] {
  // Only real users carry role membership; system/webhook/job actors don't.
  if (ctx.actorType === "user") return ctx.roles ?? []
  return []
}

function resolveDimensionGrants(ctx: ActorContext): Record<string, string[]> {
  // Kernel passes raw dimension grants. App-specific normalization (e.g., the
  // Knowledge sensitivity ladder) happens inside that app's RLS predicates and
  // service-layer authorization checks, not here. The kernel must remain
  // agnostic to any individual app's dimension semantics.
  if (ctx.actorType === "user") return ctx.dimensionGrants
  return { "*": ["*"] }
}

export type RlsPool = "request" | "jobs"

export type WithRlsOptions = {
  /**
   * Which connection pool this transaction draws from. "request" (default) is
   * the interactive pool — HTTP handlers, MCP tool calls, agent runs — where
   * transactions are short-lived. "jobs" is the dedicated background pool for
   * BullMQ handlers / webhook retries / event-subscription handlers, whose
   * transactions can legitimately stay open for the whole sandboxed handler
   * run (network-bound syncs, 30–300s). Keeping the two on separate pools
   * means slow background syncs can never starve interactive traffic into
   * DbAcquireTimeoutError (see connection.ts jobsSql doc).
   */
  pool?: RlsPool
  /**
   * A pool the caller built itself (connection.ts `createPool`) to run on
   * instead of the one `pool` names. Default: the named pool.
   */
  db?: DbPool["db"]
  /** Pool-slot acquire timeout for this transaction, in ms. Default: DB_ACQUIRE_TIMEOUT_MS. */
  acquireTimeoutMs?: number
  /**
   * Abort the transaction: on abort it rolls back and returns its connection
   * at once, and the handle `fn` holds refuses every later statement, even
   * while `fn` itself keeps running (db/abortable-tx.ts).
   */
  signal?: AbortSignal
  /** This transaction's `statement_timeout`, in ms. Default: DB_STATEMENT_TIMEOUT_MS. */
  statementTimeoutMs?: number
}

/**
 * A connection-less handle on an RLS actor context. `run(fn)` executes `fn`
 * inside ONE short-lived RLS transaction (pool acquire -> GUCs + SET LOCAL
 * ROLE -> fn -> commit -> release); between runs the session holds NO Postgres
 * connection. One `run` is the atomicity unit: statements inside a single
 * `run` (including `tx.queueEvent` outbox rows) commit or roll back together,
 * while separate `run`s are independent transactions.
 *
 * This is the seam that lets sandboxed tool execution stop pinning a pool
 * connection for its whole wall-clock run (sandbox IPC, external HTTP, Meili):
 * the bridge acquires per CALL via `session.run`, so pool demand tracks actual
 * SQL time. See createSessionRpcBridge (sandbox/rpc-bridge.ts).
 */
export interface RlsSession {
  readonly ctx: ActorContext
  readonly opts?: WithRlsOptions
  run<T>(fn: (tx: RlsClient) => Promise<T>): Promise<T>
}

export function createRlsSession(ctx: ActorContext, opts?: WithRlsOptions): RlsSession {
  return {
    ctx,
    opts,
    run: (fn) => withRlsContext(ctx, fn, opts),
  }
}

let contextTagKey: Promise<Buffer> | null = null

/** The database's context-tag key (rls_ctx.tag_key), read once over the privileged login. */
function tagKey(): Promise<Buffer> {
  if (!contextTagKey) {
    contextTagKey = (async () => {
      const [row] = await privilegedSql<
        { key: string }[]
      >`SELECT encode(key, 'hex') AS key FROM rls_ctx.tag_key`
      if (!row?.key) throw new Error("rls_ctx.tag_key holds no key: the migrations have not run")
      return Buffer.from(row.key, "hex")
    })().catch((err: unknown) => {
      contextTagKey = null
      throw err
    })
  }
  return contextTagKey
}

/** HMAC-SHA256 of `message` under the database's context-tag key, hex. */
async function contextTag(message: string): Promise<string> {
  return createHmac("sha256", await tagKey())
    .update(message, "utf8")
    .digest("hex")
}

/**
 * The tag `rls_ctx.org_id()` checks before a request-login transaction may use
 * its org (migration 0184): HMAC-SHA256 of the org id under the database's
 * key, which the privileged login reads once and the request login cannot
 * read at all. SQL run inside the transaction can still set
 * `app.current_org_id`, but not the tag of another org, so the policies see
 * no org instead.
 */
export async function orgContextTag(orgId: string): Promise<string> {
  if (!orgId) return ""
  return contextTag(orgId)
}

/**
 * The tag `rls_ctx.user_id()` checks before a request-login transaction may
 * use its user (migration 0185): HMAC-SHA256 of `user:<user id>` under the
 * same key (the prefix keeps it apart from an org tag). A transaction whose
 * user variable lacks it runs as nobody, not as the system.
 */
export async function userContextTag(userId: string): Promise<string> {
  if (!userId) return ""
  return contextTag(`user:${userId}`)
}

/**
 * The tags of the scopes, dimension grants and roles variables (migration
 * 0186): HMAC-SHA256 of `scopes:` / `dimensions:` / `roles:` and the value, as
 * set. A forged value reads as no scope, no grant, no role.
 */
export async function grantContextTag(
  kind: "scopes" | "dimensions" | "roles",
  value: string,
): Promise<string> {
  return contextTag(`${kind}:${value}`)
}

export async function withRlsContext<T>(
  ctx: ActorContext,
  fn: (tx: RlsClient) => Promise<T>,
  opts?: WithRlsOptions,
): Promise<T> {
  const scopes = resolveScopes(ctx)

  // Validate scope values don't contain the delimiter character.
  // The RLS policies parse scopes via string_to_array(..., ','), so commas in
  // scope values would split them into phantom grants.
  for (const scope of scopes) {
    if (scope.includes(",")) {
      throw new Error(`Scope value contains invalid character ',': ${scope}`)
    }
  }

  const userId = resolveUserId(ctx)
  const dimensionGrants = resolveDimensionGrants(ctx)
  const roles = resolveRoles(ctx)

  // Role IDs feed string_to_array(..., ',') in has_role; a comma in a value
  // would split it into phantom role ids. Role ids are UUIDs, but guard anyway.
  for (const roleId of roles) {
    if (roleId.includes(",")) {
      throw new Error(`Role id contains invalid character ',': ${roleId}`)
    }
  }

  // Every RLS policy reads `app.current_user_id` via a raw `::uuid` cast (80+
  // call sites, none NULLIF-guarded). That cast THROWS (22P02) for any
  // non-uuid value — so a system / cross-app actor (no user id, or a "system"
  // sentinel) must still resolve to a *valid* uuid here, or it aborts the whole
  // query before the policy can evaluate to "deny". The nil uuid matches no
  // real `owner_id` / `user_id`, so non-user actors correctly see nothing via
  // RLS and fall through to whatever kernel-privileged path is authoritative
  // for them (e.g. org-owned app connections in connections/service.ts).
  const NIL_UUID = "00000000-0000-0000-0000-000000000000"
  const safeUserId =
    userId &&
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(userId)
      ? userId
      : NIL_UUID

  const scopesValue = scopes.length > 0 ? scopes.join(",") : "__none__"
  const dimensionsValue = JSON.stringify(dimensionGrants)
  const rolesValue = roles.length > 0 ? roles.join(",") : "__none__"
  const [orgTag, userTag, scopesTag, dimensionsTag, rolesTag] = await Promise.all([
    orgContextTag(ctx.orgId),
    userContextTag(safeUserId),
    grantContextTag("scopes", scopesValue),
    grantContextTag("dimensions", dimensionsValue),
    grantContextTag("roles", rolesValue),
  ])

  // U4.16 — pool-pressure signal for /diag (see pool-diag.ts): count this
  // transaction as in-flight for its whole lifetime, including any time spent
  // waiting for a pool slot, so a saturated pool is visible BEFORE it wedges
  // every tool/job that needs a connection.
  recordRlsTxStart()
  const pool = opts?.pool ?? "request"
  const poolDb = opts?.db ?? (pool === "jobs" ? jobsDb : db)
  // Acquire signal: resolves the moment the transaction callback starts (a
  // pool slot was granted). The acquire-timeout below races THIS, not the
  // whole transaction promise — racing the full promise turned the 25s
  // "pool exhausted" guard into a spurious wall-clock ceiling on any handler
  // whose single transaction legitimately runs long (atomic tools doing
  // external HTTP, jobs-pool routine ticks): the caller got a false
  // DbAcquireTimeoutError while the work continued and committed unobserved.
  let signalAcquired!: () => void
  const acquiredSignal = new Promise<void>((resolve) => {
    signalAcquired = resolve
  })
  // The pool's gauge (pool-diag.ts); a caller's own `db` is not counted.
  const slot = opts?.db ? null : poolSlot(pool)
  const queued: QueuedEventsMark = { queued: false }
  const txPromise = poolDb.transaction(async (tx) => {
    signalAcquired()
    slot?.acquired()
    try {
      return await runRlsTransaction(tx)
    } finally {
      slot?.released()
    }
  })
  if (slot) void txPromise.then(slot.settled, slot.settled)
  wakeOutboxAfterCommit(txPromise, queued)
  async function runRlsTransaction(tx: Parameters<Parameters<typeof poolDb.transaction>[0]>[0]) {
    // U4.16 perf: collapse the five per-GUC `set_config` round-trips PLUS the
    // JIT + statement_timeout GUCs into a SINGLE parameterized `SELECT
    // set_config(...), set_config(...), ...` statement. All of these are
    // GUC-addressable and `set_config(name, value, is_local => true)` is the
    // session-local equivalent of `SET LOCAL`, so this is byte-identical to the
    // previous per-call sequence — it just shaves ~6 network round-trips off
    // every RLS transaction. The multi-function SELECT is one command on the
    // extended/prepared protocol (postgres.js only rejects multi-STATEMENT
    // strings, i.e. semicolon-separated commands; several functions in one
    // SELECT is fine). ORDER PRESERVED: the config SELECT runs BEFORE the role
    // switch below, exactly as before.
    //
    // JIT (finding 2 root fix): disable JIT for RLS-transaction queries. Measured
    // directly (see DB_RLS_JIT_ENABLED's doc comment in lib/env.ts): the RLS
    // policies on app_tickets.tickets/messages compound with tickets:search's
    // free-text predicates into a plan complex enough that Postgres's JIT
    // COMPILE time (not execution) dominates -- 1,478ms vs 10ms for the
    // identical plan/rows, a ~148x difference. JIT is tuned for large
    // analytical scans; every RLS-scoped query here is a short, bounded,
    // latency-sensitive OLTP read, so JIT is a pure loss, not a tradeoff.
    //
    // statement_timeout (finding 1 root fix, reclaim-on-timeout): bound every
    // statement run inside an RLS transaction so a slow/runaway query (e.g.
    // tickets:search's free-text ILIKE scan at corpus scale) is killed
    // SERVER-SIDE rather than left running after executeInSandbox's own
    // wall-clock timeout gives up on it. Without this, the sandbox promise
    // rejects but the underlying connection stays busy behind the still-executing
    // statement — postgres.js can only send ROLLBACK once that statement
    // finishes, so the connection is not returned to the pool (worst case:
    // never). Enough concurrent timeouts exhaust DB_POOL_MAX and wedge every
    // tool/job needing a DB connection. 0 disables (legacy behaviour).
    //
    // rls_ctx.enter() (migrations 0186, 0246), after the set_config calls it
    // reads: it verifies each variable against its tag once for the whole
    // transaction and keeps the verified values where SQL run inside the
    // transaction cannot overwrite them, so the policies' readers cost a
    // settings lookup per call instead of an HMAC.
    //
    // The role switch closes the list: `set_config('role', ..., true)` is
    // SET LOCAL ROLE (same membership check, same error when the role is
    // missing or not granted, reverted at commit or rollback), in the same
    // round trip. It comes after enter(), so enter() still runs before the
    // transaction becomes liaison_rls, as it did with a separate statement.
    if (opts?.signal?.aborted) throw opts.signal.reason ?? new Error("transaction aborted")
    const setJit = !env.DB_RLS_JIT_ENABLED
    const statementTimeoutMs = opts?.statementTimeoutMs ?? env.DB_STATEMENT_TIMEOUT_MS
    const setTimeout = statementTimeoutMs > 0
    await tx.execute(drizzleSql`SELECT
      set_config('app.current_user_id', ${safeUserId}, true),
      set_config('app.current_user_tag', ${userTag}, true),
      set_config('app.current_org_id', ${ctx.orgId}, true),
      set_config('app.current_org_tag', ${orgTag}, true),
      set_config('app.current_scopes', ${scopesValue}, true),
      set_config('app.current_scopes_tag', ${scopesTag}, true),
      set_config('app.current_dimensions', ${dimensionsValue}, true),
      set_config('app.current_dimensions_tag', ${dimensionsTag}, true),
      set_config('app.current_roles', ${rolesValue}, true),
      set_config('app.current_roles_tag', ${rolesTag}, true)
      ${setJit ? drizzleSql`, set_config('jit', 'off', true)` : drizzleSql``}
      ${setTimeout ? drizzleSql`, set_config('statement_timeout', ${String(statementTimeoutMs)}, true)` : drizzleSql``},
      rls_ctx.enter(),
      set_config('role', 'liaison_rls', true)`)

    // Brand the tx so TypeScript distinguishes it from bare db
    const branded = tx as unknown as RlsClient
    Object.defineProperty(branded, "__rlsBrand", { value: true, enumerable: false })
    attachQueueEvent(branded, ctx.orgId, queued)

    return opts?.signal ? runUntilAborted(branded, fn, opts.signal) : fn(branded)
  }

  try {
    // U4.16 finding 1 (surfacing): fail fast with a loud, typed, /diag-countable
    // error if the pool never frees a slot for this transaction — the same
    // acquire-timeout discipline withPrivilegedDb already had (BL-131), now
    // applied to the main RLS/request pool every ordinary tool call goes
    // through. env.DB_ACQUIRE_TIMEOUT_MS (default 25s) — 0 disables.
    //
    // The race is scoped to the ACQUIRE (acquiredSignal), never the handler's
    // own runtime. `txPromise.catch(() => {})` joins the race so a connection
    // error BEFORE acquire settles the race immediately (the real error then
    // surfaces from `await txPromise`) instead of stalling to the timeout.
    await withAcquireTimeout(
      pool === "jobs" ? "withRlsContext:jobs" : "withRlsContext",
      opts?.acquireTimeoutMs ?? env.DB_ACQUIRE_TIMEOUT_MS,
      Promise.race([
        acquiredSignal,
        txPromise.then(
          () => undefined,
          () => undefined,
        ),
      ]),
      () => {
        recordAcquireTimeout()
        recordPoolAcquireTimeout(pool)
      },
    )
    return await txPromise
  } catch (err: unknown) {
    // Postgres 57014 = query_canceled, the code statement_timeout produces —
    // distinguish it from an ordinary handler error so /diag can tell "the
    // pool was full" (acquireTimeouts) apart from "a query got killed"
    // (statementTimeouts); both are pool-pressure signals but with different
    // remediation (more capacity vs a slow query to fix).
    const pgCode =
      (err as { cause?: { code?: string }; code?: string } | null)?.cause?.code ??
      (err as { code?: string } | null)?.code
    if (pgCode === "57014") recordStatementTimeout()
    throw err
  } finally {
    recordRlsTxEnd()
  }
}

/**
 * Who the request pool logs in as, and which privileged roles (superuser,
 * BYPASSRLS, server files) that login can step into. Split logins
 * (DATABASE_REQUEST_PASSWORD) answer `liaison_request` and none; the boot
 * check (index.ts) refuses a production server whose request login can reach
 * one.
 */
export async function requestLoginReach(): Promise<{ login: string; reach: string[] }> {
  const [who] = (await db.execute(
    drizzleSql`SELECT session_user::text AS login`,
  )) as unknown as Array<{
    login: string
  }>
  const reach = (await db.execute(drizzleSql.raw(PRIVILEGED_ROLE_REACH_SQL))) as unknown as Array<{
    rolname: string
  }>
  return { login: who?.login ?? "", reach: reach.map((r) => r.rolname) }
}

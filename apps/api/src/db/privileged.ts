// SPDX-License-Identifier: FSL-1.1-ALv2
import { AsyncLocalStorage } from "node:async_hooks"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type PrivilegedDb, type RlsClient } from "~/db"
import { DbAcquireTimeoutError, withAcquireTimeout } from "~/db/acquire-timeout"
import {
  getPoolGauges,
  PoolDiagTestAccess,
  type PoolSlot,
  poolSlot,
  recordNestedPrivileged,
  recordPoolAcquireTimeout,
} from "~/db/pool-diag"
import { attachQueueEvent, type QueuedEventsMark, wakeOutboxAfterCommit } from "~/db/queue-event"
import { type ActorContext, withRlsContext } from "~/db/rls"
import { env } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import {
  type DbPool,
  __privileged_pool_db__ as db,
  __privileged_jobs_pool_db__ as jobsDb,
} from "./connection"

const log = rootLogger.child({ module: "privileged-db" })

/**
 * Thrown when a privileged DB transaction cannot acquire a pool connection
 * within `DB_ACQUIRE_TIMEOUT_MS`. postgres.js queues pool-slot acquisition with
 * NO timeout, so under pool saturation a nested privileged transaction (e.g. an
 * org-owned connection token lookup running INSIDE a gated handler's RLS
 * transaction) would otherwise wait until the caller's outer deadline -- for a
 * sandboxed app that is the 300s execution ceiling (a genuine ~300s hang). We
 * fail fast instead; the message is recognised by the chaos infra-flake matcher
 * so the run retries on a fresh (uncontended) world.
 *
 * U4.16: this now RE-EXPORTS the shared `DbAcquireTimeoutError` (moved to
 * db/acquire-timeout.ts so withRlsContext can use the same guard) under its
 * original name — no behavior or call-site change for existing consumers.
 */
export const PrivilegedDbAcquireTimeoutError = DbAcquireTimeoutError

/** Who a privileged transaction writes for (withPrivilegedDb `actor`). */
export interface PrivilegedActor {
  /** A person; omitted for an app or the system. */
  userId?: string
  scopes: readonly string[]
  dimensionGrants?: Record<string, string[]>
  roles?: readonly string[]
}

/**
 * Set a privileged transaction's request context, every variable, at its start.
 *
 * A privileged transaction runs on a pooled connection that an earlier
 * transaction may have used. `app.current_*` are custom settings: on a
 * connection that never set one it reads NULL, and on one where an RLS
 * transaction set it (then reverted at commit) it reads ''. A check written
 * for one case did the opposite in the other (allocate_task_number let NULL
 * through and refused ''), so which connection a write drew decided the
 * outcome. Here every variable is set for the transaction: the actor's values
 * when one is given, '' otherwise, and the checks refuse an empty context
 * (migration 0210). The org is set the same way (withSystemDb: '').
 */
export async function setPrivilegedContext(
  tx: Pick<RlsClient, "execute">,
  orgId: string | null,
  actor?: PrivilegedActor,
): Promise<void> {
  for (const v of [...(actor?.scopes ?? []), ...(actor?.roles ?? [])]) {
    // The checks split these values on ',' (withRlsContext refuses the same).
    if (v.includes(",")) throw new Error("Scope or role value contains invalid character ','")
  }
  const user = actor?.userId ?? ""
  const scopes = actor ? (actor.scopes.length > 0 ? actor.scopes.join(",") : "__none__") : ""
  const dimensions = actor ? JSON.stringify(actor.dimensionGrants ?? {}) : ""
  const roles = actor?.roles?.length ? actor.roles.join(",") : ""
  await tx.execute(drizzleSql`SELECT
    set_config('app.current_org_id', ${orgId ?? ""}, true),
    set_config('app.current_user_id', ${user}, true),
    set_config('app.current_scopes', ${scopes}, true),
    set_config('app.current_dimensions', ${dimensions}, true),
    set_config('app.current_roles', ${roles}, true)`)
}

/**
 * Execute a privileged database operation scoped to a specific org.
 * Switches to liaison_admin (BYPASSRLS) and sets app.current_org_id GUC.
 *
 * Use this for post-auth operations that need to bypass liaison_rls
 * restrictions (admin ops, cross-table updates, permission loading).
 */
export async function withPrivilegedDb<T>(
  orgId: string,
  reason: string,
  fn: (tx: PrivilegedDb) => Promise<T>,
  opts?: {
    /**
     * "jobs" routes this transaction to the dedicated background pool. Use for
     * privileged transactions held open across a whole sandboxed handler run
     * (cross-app/system event handlers) — the privileged pool must stay free
     * for its real purpose: short nested reads performed INSIDE interactive
     * RLS transactions (the BL-131 deadlock fix). A long-held privileged slot
     * starves those nested reads exactly like the original bug.
     */
    pool?: "jobs"
    /**
     * A pool the caller built itself (connection.ts `createPool`) to run on
     * instead of the privileged or jobs pool. Default: the pool `pool` names.
     */
    db?: DbPool["db"]
    /** Pool-slot acquire timeout for this transaction, in ms. Default: DB_ACQUIRE_TIMEOUT_MS. */
    acquireTimeoutMs?: number
    /**
     * The person (or app) this transaction writes for: their user id, scopes,
     * dimension grants and roles become the transaction's context, so a
     * SECURITY DEFINER function that checks a scope (`app_<app>.app_has_scope`,
     * e.g. `app_projects.allocate_task_number`) checks theirs. Without it the
     * context is empty and every such check refuses (see setPrivilegedContext).
     */
    actor?: PrivilegedActor
  },
): Promise<T> {
  log.debug({ orgId, reason }, "privileged db access")
  const onPrivilegedPool = !opts?.db && opts?.pool !== "jobs"
  const poolDb = opts?.db ?? (opts?.pool === "jobs" ? jobsDb : (testPool?.db ?? db))
  // Race the acquire-timeout against the ACQUIRE only (the moment the
  // transaction callback starts), never the handler's own runtime — racing
  // the whole transaction promise turned the pool-exhaustion guard into a
  // spurious wall-clock ceiling on legitimately long transactions (see the
  // matching fix + rationale in rls.ts withRlsContext).
  let signalAcquired!: () => void
  const acquiredSignal = new Promise<void>((resolve) => {
    signalAcquired = resolve
  })
  // The privileged-jobs pool's gauge (a caller's own `db` is not counted).
  const jobsSlot: PoolSlot | null =
    !opts?.db && opts?.pool === "jobs" ? poolSlot("privilegedJobs") : null
  const queued: QueuedEventsMark = { queued: false }
  const txPromise = onPrivilegedPool
    ? runOnPrivilegedPool(poolDb, reason, orgId, opts?.actor, fn, signalAcquired)
    : poolDb.transaction(async (tx) => {
        signalAcquired()
        jobsSlot?.acquired()
        try {
          await tx.execute(drizzleSql.raw("SET LOCAL ROLE liaison_admin"))
          await setPrivilegedContext(tx, orgId, opts?.actor)
          const branded = tx as unknown as PrivilegedDb
          attachQueueEvent(branded, orgId, queued)
          return await fn(branded)
        } finally {
          jobsSlot?.released()
        }
      })
  if (jobsSlot) void txPromise.then(jobsSlot.settled, jobsSlot.settled)
  if (!onPrivilegedPool) wakeOutboxAfterCommit(txPromise, queued)
  await withAcquireTimeout(
    opts?.pool === "jobs" ? `${reason}:jobs` : reason,
    opts?.acquireTimeoutMs ??
      (onPrivilegedPool ? testPool?.acquireTimeoutMs : undefined) ??
      env.DB_ACQUIRE_TIMEOUT_MS,
    Promise.race([
      acquiredSignal,
      txPromise.then(
        () => undefined,
        () => undefined,
      ),
    ]),
    onPrivilegedPool
      ? () => recordPoolAcquireTimeout("privileged")
      : jobsSlot
        ? () => recordPoolAcquireTimeout("privilegedJobs")
        : undefined,
  )
  return txPromise
}

/**
 * Marks the async context of a transaction holding a privileged-pool slot,
 * so an acquisition made while one is held (a nested acquisition: one caller
 * holding two slots, the shape that deadlocks a full pool) is seen.
 */
const heldSlot = new AsyncLocalStorage<{ held: boolean; reason: string; tx: PrivilegedDb }>()

/**
 * One transaction on the privileged pool (withPrivilegedDb's default pool,
 * withSystemDb, withSchemaAdmin): counts the slot, its wait and hold times,
 * and a nested acquisition (counted on /diag; thrown when
 * NESTED_PRIVILEGED_STRICT=1, which the unit suite sets in scripts/test-run.ts).
 */
function runOnPrivilegedPool<T>(
  poolDb: DbPool["db"],
  reason: string,
  orgId: string | null,
  actor: PrivilegedActor | undefined,
  fn: (tx: PrivilegedDb) => Promise<T>,
  onAcquired: () => void = () => {},
  queueOrgId: string = orgId ?? NIL_ORG,
): Promise<T> {
  const outer = heldSlot.getStore()
  if (outer?.held) {
    recordNestedPrivileged()
    log.warn({ reason, heldBy: outer.reason }, "nested privileged acquisition")
    if (process.env.NESTED_PRIVILEGED_STRICT === "1") {
      return Promise.reject(
        new Error(
          `nested privileged acquisition: ${reason} while ${outer.reason} holds a privileged slot`,
        ),
      )
    }
  }
  const askedAt = performance.now()
  const slot = poolSlot("privileged")
  const queued: QueuedEventsMark = { queued: false }
  const txPromise = poolDb.transaction(async (tx) => {
    onAcquired()
    const acquiredAt = performance.now()
    slot.acquired()
    const branded = tx as unknown as PrivilegedDb
    const marker = { held: true, reason, tx: branded }
    try {
      return await heldSlot.run(marker, async () => {
        await tx.execute(drizzleSql.raw("SET LOCAL ROLE liaison_admin"))
        await setPrivilegedContext(tx, orgId, actor)
        attachQueueEvent(branded, queueOrgId, queued)
        return await fn(branded)
      })
    } finally {
      marker.held = false
      slot.released()
      recording?.push({
        reason,
        waitMs: acquiredAt - askedAt,
        holdMs: performance.now() - acquiredAt,
        nested: outer?.held === true,
      })
    }
  })
  void txPromise.then(slot.settled, slot.settled)
  wakeOutboxAfterCommit(txPromise, queued)
  return txPromise
}

const NIL_ORG = "00000000-0000-0000-0000-000000000000"

/** One privileged-pool acquisition, as recorded under PrivilegedDbTestAccess.record(). */
export interface PrivilegedAcquisition {
  reason: string
  waitMs: number
  holdMs: number
  nested: boolean
}

let recording: PrivilegedAcquisition[] | null = null

/** A pool tests run the privileged transactions on instead of the shared one. */
let testPool: { db: DbPool["db"]; acquireTimeoutMs: number } | null = null

/**
 * Test access to this module's private state, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const PrivilegedDbTestAccess = {
  /**
   * Run withPrivilegedDb's default-pool transactions on `pool` (a small one, to
   * prove a path never needs more slots than it has), failing an acquire after
   * `acquireTimeoutMs`. `null` restores the shared privileged pool.
   */
  usePool(pool: { db: DbPool["db"]; acquireTimeoutMs: number } | null): void {
    if (process.env.NODE_ENV === "production") {
      throw new Error("PrivilegedDbTestAccess.usePool must never be called in production")
    }
    testPool = pool
  },
  /** Start counting the peak of held privileged slots from the current level. */
  resetPeak(): void {
    PoolDiagTestAccess.resetPeak("privileged")
  },
  /** The most privileged slots held at once since the last resetPeak. */
  peak(): number {
    return getPoolGauges().privileged.peak
  },
  /** Start recording every privileged-pool acquisition (wait, hold, nesting). */
  record(): void {
    recording = []
  },
  /** The acquisitions recorded since record(), and stop recording. */
  recorded(): PrivilegedAcquisition[] {
    const out = recording ?? []
    recording = null
    return out
  },
}

/**
 * Execute a system-level database operation with no org context.
 * Switches to liaison_admin (BYPASSRLS) for pre-auth and cross-org operations.
 *
 * For truly org-less operations: session cleanup, org bootstrap, pre-auth lookups.
 * queueEvent uses the orgId from the event payload; the defaultOrgId is a nil UUID
 * fallback (events should always carry their own orgId).
 */
export async function withSystemDb<T>(
  reason: string,
  fn: (db: PrivilegedDb) => Promise<T>,
): Promise<T> {
  log.debug({ reason }, "system db access")
  return runOnPrivilegedPool(testPool?.db ?? db, reason, null, undefined, fn)
}

/**
 * A system READ that may be reached from inside a privileged transaction (an
 * app's bridge call made under a job's or a sync's withPrivilegedDb): it runs on
 * the transaction this async context already holds, when that one still runs
 * as liaison_admin, instead of taking a second privileged slot (the nested
 * shape that deadlocks a full pool). Elsewhere it is withSystemDb. Only for
 * reads of rows no org owns or that BYPASSRLS reads alike from any org
 * context; it sees the holder's uncommitted rows. Never for writes: they would
 * commit or roll back with the holder's.
 */
export async function withSystemReadReusingHeld<T>(
  reason: string,
  fn: (db: PrivilegedDb) => Promise<T>,
): Promise<T> {
  const outer = heldSlot.getStore()
  if (outer?.held) {
    const { role } = await transactionRole(outer.tx)
    if (role === "liaison_admin") return fn(outer.tx)
  }
  return withSystemDb(reason, fn)
}

/**
 * Execute app-schema DDL (CREATE SCHEMA / GRANT / CREATE TABLE / CREATE
 * POLICY / ALTER TABLE … OWNER TO) inside an audited transaction.
 *
 * I-DB-5 — honest abstraction. The original design called for a dedicated
 * `liaison_schema_admin` role (NOLOGIN, no BYPASSRLS) to scope schema DDL
 * away from "runtime mutations" privileges. That role boundary turned out
 * to be unworkable without a follow-on ownership-transfer pass: table
 * ownership lives with whichever role CREATEd a table, so a distinct
 * schema-admin role can not DROP POLICY / CREATE INDEX / ALTER on tables
 * it did not create. The previous incarnation of this helper papered over
 * that by running the transaction at the bare connection role while CLAIMING
 * (via the queue-event role tag below) to be liaison_admin — a silent no-op
 * that defeated the intended privilege floor.
 *
 * Rather than ship a dishonest abstraction, we collapse it: schema DDL runs
 * as `liaison_admin` (the BYPASSRLS privileged role) — the same role the
 * queue-event tag already advertised. `liaison_admin` is granted CREATE ON
 * DATABASE in 0000_initial.sql so CREATE SCHEMA works, and because it CREATEs
 * the app tables it also OWNs them, so re-registration DROP POLICY / ALTER
 * succeed. The named code path + logged reason (the audit signal) are kept;
 * the role switch is now real, so the function does what it says.
 */
export async function withSchemaAdmin<T>(
  orgId: string,
  reason: string,
  fn: (tx: PrivilegedDb) => Promise<T>,
): Promise<T> {
  log.debug({ orgId, reason }, "schema admin db access")
  return runOnPrivilegedPool(testPool?.db ?? db, reason, null, undefined, fn, undefined, orgId)
}

type ExecuteTx = Pick<RlsClient, "execute">

/**
 * The role a transaction runs as now, and whether its LOGIN can step into
 * liaison_admin. A request transaction on the split request login
 * (DATABASE_REQUEST_PASSWORD) answers false: nothing it runs can elevate.
 */
export async function transactionRole(
  tx: ExecuteTx,
): Promise<{ role: string; canElevate: boolean }> {
  const [row] = extractRows<{ role: string; can_elevate: boolean }>(
    await tx.execute(drizzleSql`
      SELECT current_user::text AS role,
             pg_has_role(session_user, 'liaison_admin', 'MEMBER') AS can_elevate`),
  )
  return { role: row?.role ?? "", canElevate: row?.can_elevate === true }
}

/**
 * Run `fn` privileged on behalf of a caller holding `tx`, for work that does
 * not have to commit with the caller: a read the caller's RLS hides (a count
 * across tables, the grants of a row), or an idempotent "ensure it exists".
 *
 *  - `tx` already runs as liaison_admin: `fn(tx)`.
 *  - `tx`'s login can elevate (the privileged login, or an unsplit
 *    deployment): `fn(tx)` as liaison_admin on the same transaction, the role
 *    restored after.
 *  - otherwise (a request transaction on the request login): `fn` in its own
 *    withPrivilegedDb transaction on the privileged pool, which commits on its
 *    own. It sees only committed rows, never the caller's uncommitted ones.
 *
 * Work that must commit or roll back with the caller's writes does not belong
 * here: it is a SECURITY DEFINER function (migration 0178) or runs in
 * withElevatableRlsFrom.
 */
export async function privilegedFrom<T>(
  tx: ExecuteTx,
  orgId: string,
  reason: string,
  fn: (ptx: PrivilegedDb) => Promise<T>,
): Promise<T> {
  const { role, canElevate } = await transactionRole(tx)
  if (role === "liaison_admin") return fn(tx as unknown as PrivilegedDb)
  if (canElevate) {
    assertRestorableRole(role)
    await tx.execute(drizzleSql.raw("SET LOCAL ROLE liaison_admin"))
    try {
      return await fn(tx as unknown as PrivilegedDb)
    } finally {
      await tx.execute(drizzleSql.raw(`SET LOCAL ROLE ${role}`))
    }
  }
  return withPrivilegedDb(orgId, reason, fn)
}

/**
 * Run `fn` privileged, on `tx` when it already is a privileged transaction (runs
 * as liaison_admin) of the same org, and in its own withPrivilegedDb
 * transaction otherwise. For code that can be reached both from a request
 * transaction and from inside a privileged one (a sync, a job, a cascade): from
 * a privileged caller it takes no second privileged slot, the nested shape that
 * deadlocks a full pool. Unlike privilegedFrom it never elevates a non-admin
 * transaction in place, so from a request transaction `fn` still commits on its
 * own, as before.
 */
export async function withPrivilegedReusing<T>(
  tx: ExecuteTx | null | undefined,
  orgId: string,
  reason: string,
  fn: (ptx: PrivilegedDb) => Promise<T>,
): Promise<T> {
  if (tx && (await isPrivilegedTxOf(tx, orgId))) return fn(tx as unknown as PrivilegedDb)
  return withPrivilegedDb(orgId, reason, fn)
}

/** Whether `tx` runs as liaison_admin with `orgId` as its org context. */
async function isPrivilegedTxOf(tx: ExecuteTx, orgId: string): Promise<boolean> {
  const [row] = extractRows<{ role: string; org: string | null }>(
    await tx.execute(drizzleSql`
      SELECT current_user::text AS role,
             current_setting('app.current_org_id', true) AS org`),
  )
  return row?.role === "liaison_admin" && row.org === orgId
}

/** The restore target of an elevation is an identifier: only the product's own roles. */
function assertRestorableRole(role: string): void {
  if (!/^liaison_[a-z_]+$/.test(role)) {
    throw new Error(`cannot restore the transaction role ${JSON.stringify(role)} after elevating`)
  }
}

/** The actor a transaction's RLS GUCs describe (what withRlsContext set on it). */
export async function actorContextOf(tx: ExecuteTx): Promise<ActorContext> {
  const [row] = extractRows<{
    user_id: string | null
    org_id: string | null
    scopes: string | null
    dimensions: string | null
    roles: string | null
  }>(
    await tx.execute(drizzleSql`
      SELECT rls_ctx.user_id() AS user_id,
             rls_ctx.org_id() AS org_id,
             rls_ctx.scopes() AS scopes,
             rls_ctx.dimensions() AS dimensions,
             rls_ctx.roles() AS roles`),
  )
  const orgId = row?.org_id ?? ""
  if (!orgId) throw new Error("actorContextOf: the transaction carries no org context")
  const list = (v: string | null | undefined) =>
    !v || v === "__none__" ? [] : v.split(",").filter((s) => s.length > 0)
  const scopes = list(row?.scopes)
  const userId = row?.user_id ?? ""
  if (!userId || userId === "00000000-0000-0000-0000-000000000000") {
    return { actorType: "system", orgId, purpose: "job", scopes }
  }
  let dimensionGrants: Record<string, string[]> = {}
  try {
    dimensionGrants = row?.dimensions ? JSON.parse(row.dimensions) : {}
  } catch {
    dimensionGrants = {}
  }
  return { actorType: "user", userId, orgId, scopes, dimensionGrants, roles: list(row?.roles) }
}

/**
 * Run `fn` in an RLS transaction for the same actor as `tx`, on a login that
 * CAN step into liaison_admin, for an operation that mixes the caller's RLS
 * with a few elevated statements (`asAdmin`) and must be atomic as a whole: the
 * contact merge locks rows under the caller's policies, then re-points them
 * elevated. When `tx`'s own login can elevate, `fn(tx)` (one transaction, as
 * before the logins were split). Otherwise `fn` gets a NEW transaction on the
 * privileged pool, which commits on its own: the caller must not hold row
 * locks `fn` needs, and `fn` sees only committed rows. These operations are
 * the reviewed list in db/role-elevation-sites.test.ts.
 */
export async function withElevatableRlsFrom<T>(
  tx: ExecuteTx,
  reason: string,
  fn: (etx: RlsClient) => Promise<T>,
): Promise<T> {
  const { role, canElevate } = await transactionRole(tx)
  if (canElevate || role === "liaison_admin") return fn(tx as RlsClient)
  const ctx = await actorContextOf(tx)
  log.debug({ orgId: ctx.orgId, reason }, "elevatable rls transaction")
  return withRlsContext(ctx, fn, { db })
}

// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * App-schema serialization helper for tests.
 *
 * The shared-schema concurrency bug class
 * --------------------------------------
 * `bun test` runs the files of one invocation STRICTLY SEQUENTIALLY inside a
 * single process (measured: no two files overlap, and they share module state).
 * The race is therefore not two files running at once, it is everything else
 * that touches the same app schema (`app_mail`, `app_tickets`, …) while a file
 * holds it: another `bun test` process, a runtime registration on its own
 * connection, and the file's OWN concurrent sections (a `Promise.all` over two
 * helpers, a spawned child). One side does `DROP SCHEMA … CASCADE`, another
 * does `CREATE TABLE IF NOT EXISTS`, and the schema is left half-dropped,
 * half-recreated. The visible symptoms are:
 *  - tables don't exist when they should
 *  - permission denied because RLS policies aren't on the freshly recreated
 *    table
 *  - "schema_hash mismatch" or "relation does not exist" mid-test
 *
 * The fix
 * -------
 * Tests that acquire app schemas (either by running `registerApps` or by
 * hand-rolling DDL on a known schema) must wrap their setup/teardown in
 * `acquireAppSchemaLock(name)` / `releaseAppSchemaLock(name)`. The helper
 * uses two layers of synchronization:
 *
 *   1. JS-level FIFO queue per schema name — serializes test files within
 *      the same `bun test` process. Every waiter waits on the HEAD of the
 *      queue, so a waiter that gives up wakes nobody.
 *   2. Postgres session-level `pg_advisory_lock` keyed by the same hash
 *      that `runtime.ts:fnv1a32` uses for its DDL transaction lock. This
 *      serializes against concurrent runtime registrations and against
 *      any other process holding the lock.
 *
 * Fixture OWNERSHIP of a schema (`takeOverAppSchema`) is a third lock, on a
 * key of its own: `acquireAppSchemaFixtureLock` below. It is what tells a
 * later run whether the process that parked a schema aside is still alive.
 *
 * Acquire in `beforeAll`, release in `afterAll` — the lock spans every
 * test in the file, so the file gets exclusive access to its schemas
 * for its whole lifetime. It also hands back a HANDLE: sequential files share
 * these maps, so "the mutex is held" says nothing about WHO holds it, and the
 * handle is the only thing a caller can show to prove the holder is itself. For files that only need lock-protected access
 * during setup, you can release immediately after `registerApps` /
 * destructive DDL completes.
 */

import postgres from "postgres"
import { sql } from "~/db"
import { env } from "~/lib/env"

/**
 * A session of its own for an advisory lock, closed with the hold, never a
 * connection reserved from the main pool: postgres.js drops a `reserve()` asked
 * for while the pool's idle connections are closing on their idle timeout (the
 * promise never settles), and a session lock must not be lost to the pool's
 * idle timeout or connection lifetime either.
 */
function openLockSession(): LockSession {
  return postgres(env.DATABASE_URL, {
    max: 1,
    idle_timeout: 0,
    max_lifetime: null,
    connect_timeout: 10,
    onnotice: () => {},
  })
}

async function closeLockSession(session: LockSession): Promise<void> {
  await session.end({ timeout: 1 }).catch(() => {})
}

/**
 * FNV-1a 32-bit hash — must match `runtime.ts:fnv1a32` so the test holds the
 * same Postgres advisory lock id that `registerSingleApp` would acquire for
 * its DDL transaction.
 */
function fnv1a32(str: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 1
}

type LockSession = ReturnType<typeof postgres>

interface Holder {
  promise: Promise<void>
  resolve: () => void
  /** What took this holder, said in the words a waiter's timeout message uses. */
  label: string
}

/** The per-test cap the runner uses when it injects none of its own. */
export const DEFAULT_BUN_TEST_TIMEOUT_MS = 60_000

/**
 * How long a bounded acquirer waits before it says who is holding the mutex.
 *
 * It MUST be strictly below bun's per-test timeout. A bound equal to that
 * timeout can never produce the named error: bun kills the test first and the
 * run reports a timed-out case naming no schema and no holder, which is the
 * hang the bound exists to replace. `scripts/test-run.ts` publishes the cap it
 * injects into every suite as `BUN_TEST_TIMEOUT_MS`; half of it leaves room for
 * the message and the teardown around it.
 */
export function leaseWaitTimeoutMs(): number {
  const raw = Number(process.env.BUN_TEST_TIMEOUT_MS)
  const cap = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_BUN_TEST_TIMEOUT_MS
  return Math.max(1_000, Math.floor(cap / 2))
}

/**
 * Per-schema queue of pending holders. The head holder owns the lock; new
 * acquirers append a holder and `await` the HEAD's promise, re-checking who the
 * head is each time it settles. Releasing the lock means dropping the head and
 * resolving its promise, which is the only thing that lets a waiter in.
 */
const _queueBySchema = new Map<string, Holder[]>()
const _dbLockBySchema = new Map<string, LockSession>()

/**
 * Proof that a caller holds the in-process mutex for a schema. Opaque: its only
 * use is being handed back to `leaseAppSchemaJsMutex` (through
 * `takeOverAppSchema`) by the caller that took it.
 */
export type AppSchemaLockHandle = Holder

/** The holder that owns the mutex right now: the head of the schema's queue. */
function currentOwner(schemaName: string): Holder | undefined {
  return _queueBySchema.get(schemaName)?.[0]
}

function newHolder(label: string): Holder {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve, label }
}

/**
 * Append a holder to the schema's queue and wait until it reaches the head.
 *
 * Every waiter awaits the HEAD's promise, never its own predecessor's. Awaiting
 * the predecessor made a waiter's fate depend on a peer that owns nothing: a
 * waiter that timed out resolved its own promise on the way out, and the waiter
 * behind it read that resolution as "the schema is free" and walked into a
 * fixture the head was still holding. Waking on the head and re-checking who
 * the head is means only the holder's release can let anybody in.
 *
 * `timeoutMs` bounds the wait. A caller that owns its own lifetime (the fixture
 * take-over) cannot tell "the holder in front of me is a file that will release
 * in a moment" from "the holder in front of me is never coming back", and an
 * unbounded wait on the second case is a hang with no output at all: the run
 * dies on the harness timeout naming no schema and no holder. So the bounded
 * form gives up and says which holder it waited for. The unbounded form stays
 * the default for acquire/release pairs, whose lifetime is the file's.
 */
async function acquireJsMutex(
  schemaName: string,
  label: string,
  timeoutMs?: number,
): Promise<Holder> {
  let queue = _queueBySchema.get(schemaName)
  if (!queue) {
    queue = []
    _queueBySchema.set(schemaName, queue)
  }
  const self = newHolder(label)
  queue.push(self)
  const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs
  for (;;) {
    const head = queue[0]
    if (head === undefined || head === self) return self
    if (deadline === undefined) {
      await head.promise
      continue
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = await Promise.race([
      head.promise.then(() => false),
      new Promise<boolean>((r) => {
        timer = setTimeout(() => r(true), Math.max(0, deadline - Date.now()))
      }),
    ])
    if (timer) clearTimeout(timer)
    if (!timedOut) continue
    // Leave the queue as if this waiter had never joined it, and resolve
    // NOTHING: a holder that never owned the schema must not wake anybody.
    dropFromJsQueue(schemaName, self)
    throw new Error(
      `Timed out after ${timeoutMs}ms waiting for the in-process "${schemaName}" schema mutex, ` +
        `held by ${head.label}. Whatever holds it never released it: a file that takes the ` +
        `schema over must release it (releaseAppSchema / releaseAppSchemaLock) before anything ` +
        `else in this process takes it again.`,
    )
  }
}

/** Remove a holder from the queue without waking anything. */
function dropFromJsQueue(schemaName: string, holder: Holder): void {
  const queue = _queueBySchema.get(schemaName)
  if (!queue) return
  const index = queue.indexOf(holder)
  if (index !== -1) queue.splice(index, 1)
  if (queue.length === 0) _queueBySchema.delete(schemaName)
}

function releaseJsMutex(schemaName: string, holder: Holder): void {
  dropFromJsQueue(schemaName, holder)
  holder.resolve()
}

async function acquirePgLock(schemaName: string): Promise<void> {
  const lockId = fnv1a32(`app-ddl:${schemaName}`)
  const reserved = openLockSession()
  try {
    await reserved`SELECT pg_advisory_lock(${lockId})`
    _dbLockBySchema.set(schemaName, reserved)
  } catch (err) {
    await closeLockSession(reserved)
    throw err
  }
}

async function releasePgLock(schemaName: string): Promise<void> {
  const reserved = _dbLockBySchema.get(schemaName)
  if (!reserved) return
  const lockId = fnv1a32(`app-ddl:${schemaName}`)
  try {
    await reserved`SELECT pg_advisory_unlock(${lockId})`
  } finally {
    await closeLockSession(reserved)
    _dbLockBySchema.delete(schemaName)
  }
}

/**
 * Advisory-lock id for fixture OWNERSHIP of a schema.
 *
 * Deliberately a DIFFERENT key from the `app-ddl:` one above. A take-over holds
 * its ownership lock for the whole life of the fixture, and several take-over
 * callers register apps inside that window: on the DDL key the registration's
 * own transaction lock would queue behind the fixture that is waiting for the
 * registration, and the file would sit there until the harness killed it.
 */
export function fixtureLockId(schemaName: string): number {
  return fnv1a32(`app-fixture:${schemaName}`)
}

/**
 * Every backend pid holding the fixture-ownership key for `schemaName`, this process's own
 * included. `appSchemaFixtureLockHeldElsewhere` answers "somebody ELSE holds it"; this answers
 * "is it held at all", which is what a guard over the inheritance claim has to ask.
 */
export async function appSchemaFixtureLockHolderPids(schemaName: string): Promise<number[]> {
  const lockId = fixtureLockId(schemaName)
  const rows = (await sql`
    SELECT l.pid AS pid
    FROM pg_locks l
    WHERE l.locktype = 'advisory'
      AND l.granted
      AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
      AND l.classid::bigint = 0
      AND l.objid::bigint = ${lockId}
      AND l.objsubid = 1
  `) as unknown as Array<{ pid: number }>
  return rows.map((row) => Number(row.pid))
}

/** Backend pids of the fixture-ownership locks THIS process is holding. */
const _ownFixtureLockPids = new Set<number>()

export interface AppSchemaFixtureLock {
  /** The Postgres backend pid holding it, for diagnostics. */
  backendPid: number
  release: () => Promise<void>
}

/**
 * Take the fixture-ownership lock for a schema, on a connection of its own that
 * stays open until `release`.
 *
 * This is the whole liveness story. Postgres drops a session advisory lock when
 * the connection dies, however it dies, so a run killed mid-fixture releases it
 * without cooperating and a run that is still going always holds it. Nothing
 * here asks the operating system about a pid, and nothing believes a note a
 * dead process wrote about itself.
 *
 * The wait is bounded and polled rather than blocking inside Postgres, so the
 * refusal names the schema instead of arriving as a dead connection.
 */
export async function acquireAppSchemaFixtureLock(
  schemaName: string,
  timeoutMs: number,
): Promise<AppSchemaFixtureLock> {
  const lockId = fixtureLockId(schemaName)
  const reserved = openLockSession()
  let backendPid = 0
  try {
    const [self] = (await reserved`SELECT pg_backend_pid() AS pid`) as unknown as Array<{
      pid: number
    }>
    backendPid = Number(self?.pid ?? 0)
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const [got] =
        (await reserved`SELECT pg_try_advisory_lock(${lockId}) AS ok`) as unknown as Array<{
          ok: boolean
        }>
      if (got?.ok) break
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out after ${timeoutMs}ms waiting for the "${schemaName}" fixture ownership lock. ` +
            `Another process has taken that schema over and has not released it yet: its fixture ` +
            `is standing in for the real schema, so nothing here may reclaim or rename it.`,
        )
      }
      await Bun.sleep(50)
    }
  } catch (err) {
    await closeLockSession(reserved)
    throw err
  }
  if (backendPid) _ownFixtureLockPids.add(backendPid)
  let released = false
  return {
    backendPid,
    release: async () => {
      if (released) return
      released = true
      if (backendPid) _ownFixtureLockPids.delete(backendPid)
      try {
        await reserved`SELECT pg_advisory_unlock(${lockId})`
      } finally {
        await closeLockSession(reserved)
      }
    },
  }
}

/**
 * Whether some session OTHER than this process's own holds the fixture
 * ownership lock for a schema. That, and only that, is what makes a stash
 * somebody's live original rather than an abandoned one.
 */
export async function appSchemaFixtureLockHeldElsewhere(schemaName: string): Promise<boolean> {
  const lockId = fixtureLockId(schemaName)
  const rows = (await sql`
    SELECT l.pid AS pid
    FROM pg_locks l
    WHERE l.locktype = 'advisory'
      AND l.granted
      AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
      AND l.classid::bigint = 0
      AND l.objid::bigint = ${lockId}
      AND l.objsubid = 1
  `) as unknown as Array<{ pid: number }>
  return rows.some((row) => !_ownFixtureLockPids.has(Number(row.pid)))
}

// One holder per (schemaName) — file-level convention. If a file needs
// nested locks, it must use `withAppSchemaLock` (which doesn't go through
// this map) instead of the global acquire/release pair.
const _holderBySchema = new Map<string, Holder>()
const _jsOnlyHolderBySchema = new Map<string, Holder>()

/**
 * Acquire exclusive access (JS mutex + Postgres advisory lock) on the named
 * app schema. Call from `beforeAll`; the matching `releaseAppSchemaLock`
 * MUST run in `afterAll` even on test failure, so wrap test bodies in
 * try/finally if needed.
 *
 * Schema name is the Postgres schema (e.g. `"app_mail"`, `"app_tickets"`),
 * NOT the manifest app name.
 */
export async function acquireAppSchemaLock(schemaName: string): Promise<AppSchemaLockHandle> {
  const holder = await acquireJsMutex(schemaName, "acquireAppSchemaLock")
  _holderBySchema.set(schemaName, holder)
  try {
    await acquirePgLock(schemaName)
  } catch (err) {
    releaseJsMutex(schemaName, holder)
    _holderBySchema.delete(schemaName)
    throw err
  }
  return holder
}

/**
 * Acquire only the in-process schema mutex. Use this around test setup that
 * calls registerApps(), because runtime registration acquires the Postgres
 * advisory DDL lock itself on its transaction connection.
 */
export async function acquireAppSchemaJsLock(schemaName: string): Promise<AppSchemaLockHandle> {
  const holder = await acquireJsMutex(schemaName, "acquireAppSchemaJsLock")
  _jsOnlyHolderBySchema.set(schemaName, holder)
  return holder
}

/** Release the JS-only lock acquired by `acquireAppSchemaJsLock`. */
export async function releaseAppSchemaJsLock(schemaName: string): Promise<void> {
  const holder = _jsOnlyHolderBySchema.get(schemaName)
  if (!holder) return
  releaseJsMutex(schemaName, holder)
  _jsOnlyHolderBySchema.delete(schemaName)
}

/** Release the lock acquired by `acquireAppSchemaLock`. Idempotent. */
export async function releaseAppSchemaLock(schemaName: string): Promise<void> {
  const holder = _holderBySchema.get(schemaName)
  try {
    await releasePgLock(schemaName)
  } finally {
    if (holder) {
      releaseJsMutex(schemaName, holder)
      _holderBySchema.delete(schemaName)
    }
  }
}

/**
 * Lease the in-process schema mutex for a caller that owns its own lifetime
 * (the fixture take-over). Returns a release function, or `null` when
 * `heldLock` IS the holder that owns the mutex right now: the queue is FIFO, so
 * a second holder taken from inside the first would wait on the first's own
 * promise and never return.
 *
 * Re-entry needs that handle. Skipping the lease whenever the maps merely had
 * SOME holder for the schema read as "this file already holds it", which the
 * maps cannot say: they are keyed by schema and carry no file identity, and the
 * files of one run share them in sequence. A file that forgot to release left a
 * holder behind, and every later take-over of that schema then leased nothing
 * and ran with no serialization at all, silently. With the handle the claim is
 * checked; without one the lease is taken like any other, and a holder that is
 * never coming back is reported rather than skipped past.
 *
 * The wait is BOUNDED. A lease taken while another lease on the same schema is
 * still out (a second take-over that nobody released) used to queue behind it
 * with no diagnostic at all and no way out: the run sat there until the harness
 * killed it. It now gives up after `timeoutMs` and names the holder.
 *
 * Only the JS half is leased, because it is the only half that is about THIS
 * process. Serialization against other processes is the fixture ownership lock
 * (`acquireAppSchemaFixtureLock`), which the take-over holds for its lifetime.
 */
export async function leaseAppSchemaJsMutex(
  schemaName: string,
  options: { owner?: string; timeoutMs?: number; heldLock?: AppSchemaLockHandle } = {},
): Promise<(() => void) | null> {
  if (options.heldLock && options.heldLock === currentOwner(schemaName)) return null
  const holder = await acquireJsMutex(
    schemaName,
    options.owner ?? "a fixture take-over",
    options.timeoutMs ?? leaseWaitTimeoutMs(),
  )
  let released = false
  return () => {
    if (released) return
    released = true
    releaseJsMutex(schemaName, holder)
  }
}

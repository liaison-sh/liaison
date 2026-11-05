// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Fixture OWNERSHIP of an app schema, without destroying a registered one.
 *
 * The hazard this replaces
 * -----------------------
 * A test file that fakes an app schema with `CREATE SCHEMA IF NOT EXISTS
 * app_x` + `CREATE TABLE IF NOT EXISTS app_x.t (...)` does NOT own anything:
 * when the real app has been registered into the database the statement is a
 * silent no-op and the file then runs its assertions against a table shape it
 * never wrote. Whether it passes depends on which other file registered the
 * app first, which is not a property a test may have.
 *
 * The other half of the same hazard is the cure most files reach for: drop the
 * schema first, or drop it in `afterAll`. That makes the file deterministic and
 * breaks every later file in the process that needed the REGISTERED schema,
 * because the drop takes the real tables, functions and triggers with it.
 *
 * What this does instead
 * ----------------------
 * `takeOverAppSchema` renames whatever is there out of the way (an atomic
 * `ALTER SCHEMA ... RENAME TO`, which carries the tables, grants, policies and
 * triggers along untouched), then creates an empty schema the caller fills with
 * its own DDL. `releaseAppSchema` drops ONLY that fixture schema and renames the
 * original back. Nothing foreign is ever dropped, and the caller's assertions
 * run against the shape the caller wrote.
 *
 * Callers still take `acquireAppSchemaLock(name)` for the lifetime of the file:
 * the original is invisible under its real name while the fixture holds it, so
 * peers touching the same schema must be serialized exactly as they already are
 * around a registration or a drop.
 *
 * The stash name carries this pid plus a token minted per TAKE-OVER, so a
 * nested `bun test` (a file that drives another file in a child process to
 * prove this ownership) can take over the same schema without the child's
 * restore clobbering the parent's stash, and so can two files in one process.
 * A token minted once per PROCESS could not tell those two files apart: the
 * second one read the first one's stash as its own, dropped the live fixture
 * and renamed the original back underneath it, mid-test.
 *
 * Serialization is not the caller's to remember either. `takeOverAppSchema`
 * leases the in-process schema mutex itself, for the lifetime of the take-over,
 * so two files that both take the same schema over run one after the other even
 * when neither of them asked for a lock. A caller already holding that mutex
 * (the usual `acquireAppSchemaLock` in `beforeAll`) passes back the handle that
 * acquire returned, as `options.lock`, and leases nothing. The handle is the
 * point: without one, "somebody holds this schema" cannot be told from "I hold
 * this schema", and a holder a previous file forgot to release made every later
 * take-over skip its lease and run unserialized.
 *
 * Orphans
 * -------
 * A process that dies between take-over and release leaves the REAL schema
 * parked under its stash name and its own fixture sitting under the real name.
 * Keying the self-heal on the dying process's own name made that permanent: the
 * next process looked only for a stash it had minted itself, found none, and
 * adopted the dead run's fixture as "the original", so the real tables were
 * dropped at the next release. The sweep below therefore reclaims a stash left
 * by ANY run whose process is gone. More than one reclaimable stash means two
 * dead runs disagree about what the original was: that is not recoverable by
 * guessing, so it refuses loudly instead.
 *
 * "Whose process is gone" is asked of POSTGRES, never of the operating system.
 * The take-over holds a session-level advisory lock on a key derived from the
 * schema name, on a connection it keeps open until the release. Postgres drops
 * that lock when the connection dies, however it dies, so a dead owner never
 * holds it and a live owner always does. A stash is reclaimable exactly when no
 * other session holds that lock.
 *
 * Everything the previous shape asked the kernel is gone with it: a pid, a
 * start time hashed into a comment, a `ps` for each of them. Every one of those
 * answers is a report a process writes about itself, and a report is worth
 * nothing once the process that wrote it is dead or once the kernel hands its
 * pid to somebody else. A stash with no note is simply a stash: what decides it
 * is whether the lock is held.
 *
 * The same lock is the cross-process serialization. Two `bun test` processes
 * taking the same schema over now queue: the second waits for the first to
 * release instead of stashing the first's fixture as if it were the original.
 * A take-over that drives a CHILD process over the same schema hands its lock
 * down explicitly, with `inheritedFixtureLockEnv`, so the child skips the
 * acquire it would otherwise deadlock on and still sees the lock held, which
 * keeps the parent's stash untouchable. That hand-down is verified, never
 * believed: the child skips the acquire only while the key really is held by
 * another live session, so a schema the parent never took over is locked
 * normally instead of being left unowned.
 */

import { sql } from "~/db"
import {
  type AppSchemaFixtureLock,
  type AppSchemaLockHandle,
  acquireAppSchemaFixtureLock,
  appSchemaFixtureLockHeldElsewhere,
  leaseAppSchemaJsMutex,
  leaseWaitTimeoutMs,
} from "~/tests/helpers/app-schema-lock"

const SAFE_SCHEMA = /^[a-z][a-z0-9_]*$/

/** A fresh identity for ONE take-over, carried by the stash name it mints. */
function mintRunToken(): string {
  return `p${process.pid}_${Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, "0")}`
}

/** Matches the pid inside a stash name this helper minted. */
const STASH_OWNER = /__fixture_stash_p(\d+)_[0-9a-f]+$/

/**
 * What every note this helper writes starts with. It is not an identity and
 * nothing decides anything from it: it is only how the helper recognises a
 * comment as its OWN, so the release clears that comment and leaves any other
 * comment on the schema alone.
 */
const STASH_NOTE_PREFIX = "fixture-stash"

function stashNote(runToken: string): string {
  return `${STASH_NOTE_PREFIX} run=${runToken}`
}

/**
 * The env var a take-over uses to hand its ownership lock down to a child
 * process it drives over the same schema.
 */
const INHERITED_LOCK_ENV = "LIAISON_FIXTURE_LOCK_INHERITED"

/**
 * Env additions for a child `bun test` that will take one of the schemas this
 * process already owns over.
 *
 * Without it the child queues on the ownership lock its own parent is holding
 * and the pair sits there until the harness kills both. With it the child takes
 * no lock of its own and reads the parent's as held by another session, which
 * is exactly true and is what keeps the child from reclaiming the parent's
 * stash. Spell the schemas out: inheriting everything by default would hand a
 * child the right to stash a schema nobody is watching, and a schema the parent
 * does not actually hold is acquired by the child anyway.
 */
export function inheritedFixtureLockEnv(schemaNames: string[]): Record<string, string> {
  const already = (process.env[INHERITED_LOCK_ENV] ?? "").split(",").filter(Boolean)
  return { [INHERITED_LOCK_ENV]: [...new Set([...already, ...schemaNames])].join(",") }
}

/**
 * Whether this process may skip the acquire because its PARENT is holding the lock for it.
 *
 * The env var alone is a CLAIM, and a claim about a lock is worth exactly what the pid notes
 * this helper deleted were worth: a child that skips the acquire on a false claim holds
 * nothing, so another run reads the schema as unowned and may reclaim and drop the live
 * fixture underneath it. So the claim is verified against pg_locks: the key must really be
 * held by some OTHER live session. If it is not, the claim is stale (a parent that declared a
 * schema it never took over, or one that already released it) and the acquire runs normally.
 */
async function lockIsInherited(schemaName: string): Promise<boolean> {
  if (!(process.env[INHERITED_LOCK_ENV] ?? "").split(",").includes(schemaName)) return false
  return await appSchemaFixtureLockHeldElsewhere(schemaName)
}

/**
 * Park `schemaName` under `stash` and stamp its note, as ONE unit.
 *
 * Two autocommitted statements left a window in which the rename had landed and
 * the note had not, so a stash could exist with no mark saying this helper made
 * it. In one transaction the pair is all-or-nothing: either the schema is parked
 * WITH its note, or it never moved.
 *
 * The note is written as a literal because `COMMENT` takes no bind parameters;
 * every note this file mints is digits and hex, and the quote doubling keeps
 * that true for any note a caller hands in.
 */
export async function stashSchemaWithNote(
  schemaName: string,
  stash: string,
  note: string,
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx.unsafe(`ALTER SCHEMA "${schemaName}" RENAME TO "${stash}"`)
    // Stamped inside the same transaction as the rename and carried by any later
    // rename: this is how the release knows the comment it is about to clear is
    // one this helper wrote.
    await tx.unsafe(`COMMENT ON SCHEMA "${stash}" IS '${note.replaceAll("'", "''")}'`)
  })
}

/** The comment on a schema, or `null` when it carries none. */
async function schemaComment(schemaName: string): Promise<string | null> {
  const [row] = (await sql`
    SELECT obj_description(n.oid, 'pg_namespace') AS note
    FROM pg_namespace n WHERE n.nspname = ${schemaName}
  `) as unknown as Array<{ note: string | null }>
  return row?.note ?? null
}

/**
 * Put the schema's comment back the way the take-over found it, and only when
 * the comment sitting there now is the note this helper wrote.
 *
 * Both halves matter. The clear used to be unconditional, which is a fixture
 * deleting a comment it never wrote; and the stash note overwrote whatever
 * comment the schema already carried, so clearing was a loss even when the
 * comment WAS ours. What the take-over found is recorded and put back.
 */
async function restoreSchemaComment(schemaName: string, original: string | null): Promise<void> {
  const current = await schemaComment(schemaName)
  if (!current?.startsWith(STASH_NOTE_PREFIX)) return
  if (original === null) {
    await sql.unsafe(`COMMENT ON SCHEMA "${schemaName}" IS NULL`)
    return
  }
  await sql.unsafe(`COMMENT ON SCHEMA "${schemaName}" IS '${original.replaceAll("'", "''")}'`)
}

interface TakeOver {
  /** The stash this take-over minted, whether or not it holds anything. */
  stash: string
  /** Whether an original was actually renamed into it. */
  hadOriginal: boolean
  /** The in-process schema mutex this take-over leased, when it leased one. */
  releaseMutex: (() => void) | null
  /** The Postgres ownership lock, unless an ancestor process is holding it. */
  lock: AppSchemaFixtureLock | null
  /** The comment the schema carried before the stash note replaced it. */
  originalNote: string | null
}

/** Take-overs this process is holding right now, one per schema. */
const takenOver = new Map<string, TakeOver>()

function stashNameFor(schemaName: string, runToken: string): string {
  return `${schemaName}__fixture_stash_${runToken}`
}

/** Every stash name a live take-over in this process is holding. */
function activeOwnStashes(): Set<string> {
  return new Set([...takenOver.values()].map((t) => t.stash))
}

function stashPrefixFor(schemaName: string): string {
  return `${schemaName}__fixture_stash_`
}

/**
 * `_` and `%` are wildcards inside a LIKE pattern, and the stash prefix is
 * mostly underscores: unescaped, `app_x__fixture_stash_%` also matches any
 * schema that merely has SOME character in each of those places, which parses
 * as no stash at all and therefore reads as abandoned. Escaping the literal
 * prefix is what keeps an unrelated schema from being renamed in over the real
 * one.
 */
function likeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&")
}

function assertSafe(schemaName: string): void {
  if (!SAFE_SCHEMA.test(schemaName)) {
    throw new Error(`Unsafe schema name for a fixture take-over: "${schemaName}"`)
  }
}

async function schemaExists(name: string): Promise<boolean> {
  const rows = (await sql`
    SELECT 1 FROM information_schema.schemata WHERE schema_name = ${name}
  `) as unknown as unknown[]
  return rows.length > 0
}

export interface Stash {
  name: string
}

/** Whether `stash` was minted by THIS process: the name's pid is ours. */
function stashIsOurs(stash: Stash): boolean {
  const owner = STASH_OWNER.exec(stash.name)
  return owner != null && Number(owner[1]) === process.pid
}

/** Every stash sitting on this app schema, whoever minted it. */
async function listStashes(schemaName: string): Promise<Stash[]> {
  const rows = (await sql`
    SELECT n.nspname AS name
    FROM pg_namespace n
    WHERE n.nspname LIKE ${`${likeLiteral(stashPrefixFor(schemaName))}%`} ESCAPE '\\'
    ORDER BY n.nspname
  `) as unknown as Array<{ name: string }>
  return rows.map((r) => ({ name: r.name }))
}

/**
 * The one stash this take-over may reclaim.
 *
 * `lockHeldElsewhere` is the whole liveness test: another session holding the
 * schema's ownership lock is a run that is still using its fixture, so the
 * stash beside it is that run's original and nothing here may touch it. No
 * other session holding it means no run is alive to own anything, whatever a
 * stash name or a comment claims.
 *
 * A stash a take-over in THIS process is holding right now is live for the same
 * reason and is excluded by name, and a stash carrying our own pid that no live
 * take-over claims is an earlier file in this process that died between
 * take-over and release, which only this process can clean up.
 */
export function chooseReclaimableStash(
  schemaName: string,
  stashes: Stash[],
  active: ReadonlySet<string>,
  lockHeldElsewhere: boolean,
): string | null {
  const candidates = stashes
    .filter((stash) => {
      if (active.has(stash.name)) return false
      if (stashIsOurs(stash)) return true
      return !lockHeldElsewhere
    })
    .map((stash) => stash.name)
  if (candidates.length === 0) return null
  if (candidates.length > 1) {
    throw new Error(
      `Refusing to take over "${schemaName}": ${candidates.length} abandoned fixture stashes ` +
        `hold it (${candidates.join(", ")}) and only one of them can be the real schema. ` +
        `Inspect them and drop the fixtures by hand, or reset the database.`,
    )
  }
  return candidates[0]
}

async function reclaimableStash(schemaName: string): Promise<string | null> {
  return chooseReclaimableStash(
    schemaName,
    await listStashes(schemaName),
    activeOwnStashes(),
    await appSchemaFixtureLockHeldElsewhere(schemaName),
  )
}

/**
 * `DROP SCHEMA ... CASCADE` of a fixture also drops every policy outside it that
 * named one of its tables: `kernel.files`' SELECT policy joins each registered
 * file parent (app_mail, app_tickets, ...), so once a registration inside the
 * take-over rebuilt it over the fixture's tables, the drop left `kernel.files`
 * with no SELECT policy for every later file on the database. Rebuild it from
 * the catalog (a no-op when it is current).
 */
async function rebuildPoliciesDroppedWithFixture(): Promise<void> {
  const { rebuildFilesSelectPolicy } = await import("~/infra/boot-phase10")
  await rebuildFilesSelectPolicy()
}

/**
 * Take exclusive ownership of `schemaName` for this file: stash whatever is
 * there under a pid-scoped name and leave an EMPTY schema behind for the
 * caller's fixture DDL. Pair with `releaseAppSchema` in `afterAll`.
 */
export async function takeOverAppSchema(
  schemaName: string,
  options: { mutexTimeoutMs?: number; lockWaitMs?: number; lock?: AppSchemaLockHandle } = {},
): Promise<void> {
  assertSafe(schemaName)
  const runToken = mintRunToken()
  // Held for the lifetime of the take-over, so a second file in this process
  // waits here instead of walking into the middle of the first one's fixture.
  // The wait is bounded and the lease names this take-over, so a take-over of a
  // schema some OTHER take-over never released says so instead of hanging.
  // `null` only when the caller hands back the handle for the lock it is
  // holding itself, which is the one claim of that shape that can be checked.
  const releaseMutex = await leaseAppSchemaJsMutex(schemaName, {
    owner: `a fixture take-over of "${schemaName}" (${runToken})`,
    timeoutMs: options.mutexTimeoutMs,
    heldLock: options.lock,
  })
  let lock: AppSchemaFixtureLock | null = null
  try {
    // Held until the release, on a connection of its own. This is what another
    // process reads as "somebody is using this schema", and what Postgres drops
    // for us if this process is killed.
    if (!(await lockIsInherited(schemaName))) {
      lock = await acquireAppSchemaFixtureLock(
        schemaName,
        options.lockWaitMs ?? leaseWaitTimeoutMs(),
      )
    }
    const stash = stashNameFor(schemaName, runToken)

    // A run that died between take-over and release (this process's own earlier
    // file, or another process entirely) left the original parked under its stash
    // and its fixture under the real name. Put the original back before taking
    // over again, dropping the fixture that is standing in for it.
    const abandoned = await reclaimableStash(schemaName)
    if (abandoned) {
      await sql.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
      await sql.unsafe(`ALTER SCHEMA "${abandoned}" RENAME TO "${schemaName}"`)
      await restoreSchemaComment(schemaName, null)
      await rebuildPoliciesDroppedWithFixture()
    }

    const hadOriginal = await schemaExists(schemaName)
    const originalNote = hadOriginal ? await schemaComment(schemaName) : null
    if (hadOriginal) {
      await stashSchemaWithNote(schemaName, stash, stashNote(runToken))
    }
    takenOver.set(schemaName, { stash, hadOriginal, releaseMutex, lock, originalNote })
    await sql.unsafe(`CREATE SCHEMA "${schemaName}"`)
  } catch (err) {
    if (!takenOver.has(schemaName)) {
      await lock?.release()
      releaseMutex?.()
    }
    throw err
  }
}

/**
 * Drop the fixture schema created by `takeOverAppSchema` and rename the
 * original back. A no-op when this process never took the schema over, so a
 * failed `beforeAll` can never make `afterAll` drop a registered schema.
 */
export async function releaseAppSchema(schemaName: string): Promise<void> {
  assertSafe(schemaName)
  const held = takenOver.get(schemaName)
  if (!held) return
  takenOver.delete(schemaName)
  try {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
    if (held.hadOriginal) {
      await sql.unsafe(`ALTER SCHEMA "${held.stash}" RENAME TO "${schemaName}"`)
      // The note belonged to the stash, not to the schema.
      await restoreSchemaComment(schemaName, held.originalNote)
    }
    await rebuildPoliciesDroppedWithFixture()
  } finally {
    await held.lock?.release()
    held.releaseMutex?.()
  }
}

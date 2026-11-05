// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `takeOverAppSchema` parks the registered schema under a stash name and puts an
// empty one in its place. A process killed between take-over and release leaves
// that stash behind and its own fixture standing in for the real schema.
//
// Who owns a stash is asked of POSTGRES. The take-over holds a session advisory
// lock on the schema for the life of the fixture, so a live owner always holds
// it and a killed one never does, whatever a pid, a start time or a comment
// would have claimed. That same lock serializes two processes over one schema.
//
// Fails-without-fix: after a killed child takes the schema over, the real table
// never comes back; and while a LIVE process holds it, the next take-over
// reclaims the stash and destroys the real schema.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { sql } from "~/db"
import {
  chooseReclaimableStash,
  releaseAppSchema,
  stashSchemaWithNote,
  takeOverAppSchema,
} from "~/tests/helpers/app-schema-fixture"
import {
  acquireAppSchemaLock,
  DEFAULT_BUN_TEST_TIMEOUT_MS,
  leaseWaitTimeoutMs,
  releaseAppSchemaLock,
} from "~/tests/helpers/app-schema-lock"

// Not a real app: no registration, no peer file, so no app schema lock is
// needed and nothing else in the process can be disturbed by this file.
const SCHEMA = "app_fx15stash"
const STASH_PREFIX = `${SCHEMA}__fixture_stash_`

// A pid no live process carries, for the pure cases below.
const DEAD_PID = 999_999

// Takes the schema over through the real helper and then dies the way a killed
// test process dies: no release, no teardown, the fixture committed. Postgres
// drops its ownership lock along with the connection.
const CHILD_DIES = `// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql } from "../src/db"
import { takeOverAppSchema } from "../src/tests/helpers/app-schema-fixture"

await takeOverAppSchema("${SCHEMA}")
await sql.unsafe('CREATE TABLE ${SCHEMA}.fixture_marker (id int)')
process.kill(process.pid, "SIGKILL")
`

// Takes the schema over and STAYS alive holding it, so its ownership lock is
// held for as long as the parent lets it live.
const CHILD_HOLDS = `// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql } from "../src/db"
import { takeOverAppSchema } from "../src/tests/helpers/app-schema-fixture"

await takeOverAppSchema("${SCHEMA}")
await sql.unsafe('CREATE TABLE ${SCHEMA}.child_holding (id int)')
await Bun.sleep(120000)
`

// Holds the schema briefly and then releases it cleanly, so a take-over queued
// behind it gets in afterwards rather than trampling it.
const CHILD_RELEASES = `// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql } from "../src/db"
import { releaseAppSchema, takeOverAppSchema } from "../src/tests/helpers/app-schema-fixture"

await takeOverAppSchema("${SCHEMA}")
await sql.unsafe('CREATE TABLE ${SCHEMA}.child_holding (id int)')
await Bun.sleep(1500)
await releaseAppSchema("${SCHEMA}")
process.exit(0)
`

let childDir: string | undefined

function writeChild(name: string, source: string): string {
  if (!childDir) childDir = mkdtempSync(path.join(process.cwd(), "tmp-fx15-stash-"))
  const file = path.join(childDir, name)
  writeFileSync(file, source)
  return path.relative(process.cwd(), file)
}

async function tableExists(qualified: string): Promise<boolean> {
  const [row] = (await sql`SELECT to_regclass(${qualified}) AS t`) as unknown as Array<{
    t: string | null
  }>
  return row?.t != null
}

/** Wait until the table a child creates inside its fixture shows up. */
async function waitForTable(qualified: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await tableExists(qualified)) return
    await Bun.sleep(50)
  }
  throw new Error(`the child never created ${qualified} within ${timeoutMs}ms`)
}

async function stashes(): Promise<string[]> {
  const rows = (await sql`
    SELECT schema_name FROM information_schema.schemata
    WHERE schema_name LIKE ${`${STASH_PREFIX}%`} ORDER BY schema_name
  `) as unknown as Array<{ schema_name: string }>
  return rows.map((r) => r.schema_name)
}

async function schemaComment(name: string): Promise<string | null> {
  const [row] = (await sql`
    SELECT obj_description(n.oid, 'pg_namespace') AS note
    FROM pg_namespace n WHERE n.nspname = ${name}
  `) as unknown as Array<{ note: string | null }>
  return row?.note ?? null
}

/** The world as it is before a fixture ever runs: the "registered" schema only. */
async function seedRealSchema(): Promise<void> {
  for (const stash of await stashes()) {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${stash}" CASCADE`)
  }
  await sql.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
  await sql.unsafe(`CREATE SCHEMA "${SCHEMA}"`)
  await sql.unsafe(`CREATE TABLE ${SCHEMA}.real_marker (id int)`)
}

beforeAll(async () => {
  await seedRealSchema()
})

afterAll(async () => {
  if (childDir) rmSync(childDir, { recursive: true, force: true })
  for (const stash of await stashes()) {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${stash}" CASCADE`)
  }
  await sql.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
})

describe("a fixture stash orphaned by a dead run is recovered by the next take-over", () => {
  it("restores the REAL schema, not the dead run's fixture", async () => {
    // The child runs from a directory inside `apps/api`, so its relative import
    // reaches the helper under `src/` and the `~/` alias inside the helper
    // resolves exactly as it does for a test.
    const childFile = writeChild("orphan-child.ts", CHILD_DIES)

    const child = Bun.spawn(["bun", "run", childFile], {
      cwd: process.cwd(),
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [err] = await Promise.all([new Response(child.stderr).text(), child.exited])

    // The child really did take the schema over before it died: its fixture is
    // under the real name and the original is parked in a stash it left behind.
    const orphans = await stashes()
    if (orphans.length !== 1) {
      throw new Error(`child left ${orphans.length} stashes (${orphans.join(", ")})\n${err}`)
    }
    expect(await tableExists(`${SCHEMA}.fixture_marker`)).toBe(true)
    expect(await tableExists(`${SCHEMA}.real_marker`)).toBe(false)

    // A later process takes the same schema over and releases it.
    await takeOverAppSchema(SCHEMA)
    await sql.unsafe(`CREATE TABLE ${SCHEMA}.later_fixture (id int)`)
    await releaseAppSchema(SCHEMA)

    // What comes back is the schema that was there before any fixture ran.
    expect(await tableExists(`${SCHEMA}.real_marker`)).toBe(true)
    expect(await tableExists(`${SCHEMA}.fixture_marker`)).toBe(false)
    expect(await tableExists(`${SCHEMA}.later_fixture`)).toBe(false)
    expect(await stashes()).toEqual([])
  }, 120_000)

  it("never reclaims a stash while another PROCESS is holding the schema", async () => {
    await seedRealSchema()
    // The case that made the previous shape destructive: a live owner whose
    // stash carries no readable identity. Reading identity out of the stash
    // (a pid, a start time, a comment, or the absence of one) answered
    // "abandoned", and the reclaim renamed the real schema back out from under
    // a fixture somebody was still asserting against. The lock cannot be wrong
    // about it: the child is alive, so the child holds it.
    const childFile = writeChild("holding-child.ts", CHILD_HOLDS)
    const child = Bun.spawn(["bun", "run", childFile], {
      cwd: process.cwd(),
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    })
    try {
      await waitForTable(`${SCHEMA}.child_holding`, 60_000)
      const held = await stashes()
      expect(held.length).toBe(1)

      let message = ""
      try {
        await takeOverAppSchema(SCHEMA, { lockWaitMs: 800 })
      } catch (e) {
        message = (e as Error).message
      }
      expect(message).toContain("fixture ownership lock")

      // Nothing was reclaimed, renamed or dropped: the child's world is intact.
      expect(await stashes()).toEqual(held)
      expect(await tableExists(`${SCHEMA}.child_holding`)).toBe(true)
      expect(await tableExists(`${SCHEMA}.real_marker`)).toBe(false)
    } finally {
      child.kill("SIGKILL")
      await child.exited
    }
  }, 120_000)

  it("serializes two processes: the second take-over waits, then succeeds", async () => {
    await seedRealSchema()
    // Two `bun test` processes over one schema. With no cross-process lock they
    // both stashed it, and the first release dropped the second's fixture and
    // renamed a stash back over the real schema. Now the second one queues.
    const childFile = writeChild("releasing-child.ts", CHILD_RELEASES)
    const child = Bun.spawn(["bun", "run", childFile], {
      cwd: process.cwd(),
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    })
    await waitForTable(`${SCHEMA}.child_holding`, 60_000)

    const startedAt = Date.now()
    await takeOverAppSchema(SCHEMA, { lockWaitMs: 60_000 })
    const waited = Date.now() - startedAt
    // It did not walk straight in: the child was still holding.
    expect(waited).toBeGreaterThan(200)
    // And what it took over is the REAL schema, not the child's fixture.
    expect(await tableExists(`${SCHEMA}.child_holding`)).toBe(false)
    await sql.unsafe(`CREATE TABLE ${SCHEMA}.parent_fixture (id int)`)
    await releaseAppSchema(SCHEMA)
    await child.exited

    expect(await tableExists(`${SCHEMA}.real_marker`)).toBe(true)
    expect(await tableExists(`${SCHEMA}.parent_fixture`)).toBe(false)
    expect(await stashes()).toEqual([])
  }, 120_000)

  it("reclaims a NOTE-LESS stash when no process holds the schema", async () => {
    await seedRealSchema()
    // A stash with no note, whose name carries a pid the kernel has since
    // handed to a live process. No session holds the schema's ownership lock,
    // so there is no run left to own it and the original comes back.
    const foreign = `${STASH_PREFIX}p${process.ppid}_00000000`
    await sql.unsafe(`ALTER SCHEMA "${SCHEMA}" RENAME TO "${foreign}"`)
    await sql.unsafe(`CREATE SCHEMA "${SCHEMA}"`)
    await sql.unsafe(`CREATE TABLE ${SCHEMA}.fixture_marker (id int)`)

    await takeOverAppSchema(SCHEMA)
    await releaseAppSchema(SCHEMA)

    expect(await tableExists(`${SCHEMA}.real_marker`)).toBe(true)
    expect(await tableExists(`${SCHEMA}.fixture_marker`)).toBe(false)
    expect(await stashes()).toEqual([])
  })

  it("does not read an unrelated schema as a stash: LIKE reads _ as a wildcard", async () => {
    await seedRealSchema()
    // Every underscore in the stash prefix is a single-character wildcard
    // unless it is escaped, so this name (the prefix with each underscore
    // replaced by a letter) matches the unescaped pattern exactly. It parses as
    // no stash at all, so it reads as abandoned, and the take-over then drops
    // the REAL schema and renames this one in over it.
    const decoy = `${STASH_PREFIX.replaceAll("_", "x")}decoy`
    await sql.unsafe(`CREATE SCHEMA "${decoy}"`)
    try {
      await takeOverAppSchema(SCHEMA)
      await releaseAppSchema(SCHEMA)
      expect(await tableExists(`${SCHEMA}.real_marker`)).toBe(true)
      // And the decoy is still exactly where it was: nothing renamed it in.
      const [still] = (await sql`
        SELECT 1 AS x FROM pg_namespace WHERE nspname = ${decoy}`) as unknown as Array<{
        x: number
      }>
      expect(still?.x).toBe(1)
    } finally {
      await sql.unsafe(`DROP SCHEMA IF EXISTS "${decoy}" CASCADE`)
    }
  })

  it("does not count this run's own live stash among the abandoned ones", () => {
    // The state a second file in this process reaches: our own take-over is
    // still holding the original aside (its stash is LIVE, not abandoned) and
    // one stale orphan from a dead run is sitting beside it. There is exactly
    // one abandoned stash here, so there is nothing ambiguous to refuse.
    const own = `${STASH_PREFIX}p${process.pid}_11112222`
    const orphan = `${STASH_PREFIX}p${DEAD_PID}_eeeeeeee`
    const chosen = chooseReclaimableStash(
      SCHEMA,
      [{ name: own }, { name: orphan }],
      new Set([own]),
      false,
    )
    expect(chosen).toBe(orphan)
  })

  it("reclaims nothing foreign while the ownership lock is held elsewhere", () => {
    // The same orphan, with a session holding the schema. It is not an orphan:
    // it is somebody's original, and the reclaim must not see it at all.
    const orphan = `${STASH_PREFIX}p${DEAD_PID}_eeeeeeee`
    expect(chooseReclaimableStash(SCHEMA, [{ name: orphan }], new Set<string>(), true)).toBe(null)
  })

  it("still refuses when the two stashes are BOTH abandoned", () => {
    // The guard the case above must not weaken: two dead runs disagree about
    // what the original was, and guessing is not allowed.
    expect(() =>
      chooseReclaimableStash(
        SCHEMA,
        [
          { name: `${STASH_PREFIX}p${DEAD_PID}_aaaaaaaa` },
          { name: `${STASH_PREFIX}p${DEAD_PID}_bbbbbbbb` },
        ],
        new Set<string>(),
        false,
      ),
    ).toThrow("2 abandoned fixture stashes")
  })

  it("reclaims a stash this process minted and never released", async () => {
    await seedRealSchema()
    // An earlier file in THIS process died between take-over and release. No
    // lock is held for it any more, and the stash name says it was ours, which
    // only this process can know.
    const mine = `${STASH_PREFIX}p${process.pid}_99998888`
    await sql.unsafe(`ALTER SCHEMA "${SCHEMA}" RENAME TO "${mine}"`)
    await sql.unsafe(`COMMENT ON SCHEMA "${mine}" IS 'fixture-stash run=p${process.pid}_99998888'`)
    await sql.unsafe(`CREATE SCHEMA "${SCHEMA}"`)
    await sql.unsafe(`CREATE TABLE ${SCHEMA}.fixture_marker (id int)`)

    await takeOverAppSchema(SCHEMA)
    await releaseAppSchema(SCHEMA)

    expect(await tableExists(`${SCHEMA}.real_marker`)).toBe(true)
    expect(await tableExists(`${SCHEMA}.fixture_marker`)).toBe(false)
    expect(await stashes()).toEqual([])
  })

  it("serializes two take-overs of one schema inside one process", async () => {
    await seedRealSchema()
    // Two files in one `bun test` process, each taking the same schema over
    // with no lock of its own. Sharing one per-process token, the second read
    // the first's stash as its own, dropped the live fixture and renamed the
    // original back underneath it while the first file was still asserting.
    const order: string[] = []
    async function driveOneFile(tag: string): Promise<void> {
      await takeOverAppSchema(SCHEMA)
      order.push(`${tag} in`)
      await sql.unsafe(`CREATE TABLE ${SCHEMA}.${tag}_fixture (id int)`)
      // While this file holds it, the schema is ITS fixture and nothing else:
      // not the original, not the other file's table.
      expect(await tableExists(`${SCHEMA}.real_marker`)).toBe(false)
      await Bun.sleep(60)
      expect(await tableExists(`${SCHEMA}.${tag}_fixture`)).toBe(true)
      expect(await tableExists(`${SCHEMA}.${tag === "a" ? "b" : "a"}_fixture`)).toBe(false)
      order.push(`${tag} out`)
      await releaseAppSchema(SCHEMA)
    }
    await Promise.all([driveOneFile("a"), driveOneFile("b")])

    expect(order).toEqual(["a in", "a out", "b in", "b out"])
    expect(await tableExists(`${SCHEMA}.real_marker`)).toBe(true)
    expect(await tableExists(`${SCHEMA}.a_fixture`)).toBe(false)
    expect(await tableExists(`${SCHEMA}.b_fixture`)).toBe(false)
    expect(await stashes()).toEqual([])
  }, 60_000)

  it("does not park the schema when its note fails to write", async () => {
    await seedRealSchema()
    // The rename and the note are one transaction, so a note Postgres refuses
    // (this one carries a byte it will not store) takes the rename with it
    // rather than leaving a half-parked schema.
    const stash = `${STASH_PREFIX}p${process.pid}_77776666`
    let failed = false
    try {
      await stashSchemaWithNote(SCHEMA, stash, "fixture-stash run=\u0000")
    } catch {
      failed = true
    }
    expect(failed).toBe(true)
    // The rename did not happen: the schema is where it was, under its own name.
    expect(await stashes()).toEqual([])
    expect(await tableExists(`${SCHEMA}.real_marker`)).toBe(true)
  })

  it("leaves a comment it did not write on the schema it borrowed", async () => {
    await seedRealSchema()
    // A registered app schema can carry a description somebody else owns. The
    // release used to clear the comment unconditionally, which is a fixture
    // deleting what it never wrote, and the stash note had overwritten it on
    // the way in.
    const theirs = "a description this fixture did not write"
    await sql.unsafe(`COMMENT ON SCHEMA "${SCHEMA}" IS '${theirs}'`)

    await takeOverAppSchema(SCHEMA)
    await releaseAppSchema(SCHEMA)

    expect(await schemaComment(SCHEMA)).toBe(theirs)
    expect(await tableExists(`${SCHEMA}.real_marker`)).toBe(true)
  })

  it("names the holder when a second take-over finds the schema never released", async () => {
    await seedRealSchema()
    // Two take-overs of one schema in one process, the first never released.
    // The lease the first take-over holds was known to nobody, so the second
    // one queued behind a holder that was never coming back and waited there
    // with no diagnostic until the harness killed the whole run. A bounded wait
    // that names the holder is the difference between a hang and a message.
    await takeOverAppSchema(SCHEMA)
    let message = ""
    try {
      await takeOverAppSchema(SCHEMA, { mutexTimeoutMs: 500 })
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toContain(`waiting for the in-process "${SCHEMA}" schema mutex`)
    expect(message).toContain("a fixture take-over")

    // The first take-over is untouched by the refusal and still releases cleanly.
    await releaseAppSchema(SCHEMA)
    expect(await tableExists(`${SCHEMA}.real_marker`)).toBe(true)
    expect(await stashes()).toEqual([])
  }, 15_000)

  it("does not let a waiter that gave up wake the waiter behind it", async () => {
    await seedRealSchema()
    // A holds. B waits and times out. C was waiting on B's promise rather than
    // on the holder's, so B resolving itself on the way out read to C as "the
    // schema is free" and C walked into A's fixture. Waiters wait on the HEAD:
    // only A releasing lets anybody in.
    await takeOverAppSchema(SCHEMA)
    const [b, c] = await Promise.allSettled([
      takeOverAppSchema(SCHEMA, { mutexTimeoutMs: 300 }),
      takeOverAppSchema(SCHEMA, { mutexTimeoutMs: 2_000 }),
    ])
    expect(b.status).toBe("rejected")
    expect(c.status).toBe("rejected")
    if (c.status === "rejected") {
      expect((c.reason as Error).message).toContain("a fixture take-over")
    }

    await releaseAppSchema(SCHEMA)
    expect(await tableExists(`${SCHEMA}.real_marker`)).toBe(true)
    expect(await stashes()).toEqual([])
  }, 30_000)

  it("bounds the lease below the per-test timeout the runner injects", () => {
    // A bound equal to bun's own timeout can never produce the named error: bun
    // kills the test first and the run reports a timed-out case naming no
    // schema and no holder.
    const saved = process.env.BUN_TEST_TIMEOUT_MS
    try {
      process.env.BUN_TEST_TIMEOUT_MS = "60000"
      expect(leaseWaitTimeoutMs()).toBe(30_000)
      process.env.BUN_TEST_TIMEOUT_MS = "10000"
      expect(leaseWaitTimeoutMs()).toBe(5_000)
      delete process.env.BUN_TEST_TIMEOUT_MS
      expect(leaseWaitTimeoutMs()).toBeLessThan(DEFAULT_BUN_TEST_TIMEOUT_MS)
    } finally {
      if (saved === undefined) delete process.env.BUN_TEST_TIMEOUT_MS
      else process.env.BUN_TEST_TIMEOUT_MS = saved
    }
  })

  it("fires the named error under the timeout the runner injected", async () => {
    await seedRealSchema()
    // The default bound, driven by the runner's cap rather than by a constant
    // that happened to equal it. Half of 1200 ms is 600 ms, so the message
    // arrives well inside the cap.
    const saved = process.env.BUN_TEST_TIMEOUT_MS
    process.env.BUN_TEST_TIMEOUT_MS = "1200"
    try {
      await takeOverAppSchema(SCHEMA)
      const startedAt = Date.now()
      let message = ""
      try {
        await takeOverAppSchema(SCHEMA)
      } catch (e) {
        message = (e as Error).message
      }
      expect(message).toContain(`waiting for the in-process "${SCHEMA}" schema mutex`)
      expect(Date.now() - startedAt).toBeLessThan(1_200)
    } finally {
      if (saved === undefined) delete process.env.BUN_TEST_TIMEOUT_MS
      else process.env.BUN_TEST_TIMEOUT_MS = saved
      await releaseAppSchema(SCHEMA)
    }
    expect(await tableExists(`${SCHEMA}.real_marker`)).toBe(true)
  }, 30_000)

  it("does not skip its lease because SOMEBODY holds the schema lock", async () => {
    await seedRealSchema()
    // A holder taken by a file that never handed its handle on: exactly what a
    // file that forgot to release leaves behind, and indistinguishable from
    // "this file holds it" to a map keyed by schema. Skipping the lease on that
    // reading let the take-over run with no serialization at all and say
    // nothing. Refusing says which holder is in the way.
    await acquireAppSchemaLock(SCHEMA)
    let message = ""
    try {
      await takeOverAppSchema(SCHEMA, { mutexTimeoutMs: 500 })
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toContain("acquireAppSchemaLock")
    await releaseAppSchemaLock(SCHEMA)

    // The same file, holding the same lock, HANDING BACK the handle: re-entry,
    // which is the case the skip was there for and the only one it may cover.
    const lock = await acquireAppSchemaLock(SCHEMA)
    await takeOverAppSchema(SCHEMA, { lock, mutexTimeoutMs: 500 })
    await releaseAppSchema(SCHEMA)
    await releaseAppSchemaLock(SCHEMA)

    expect(await tableExists(`${SCHEMA}.real_marker`)).toBe(true)
    expect(await stashes()).toEqual([])
  }, 15_000)

  it("refuses loudly when two dead runs each left a stash", async () => {
    await seedRealSchema()
    await sql.unsafe(`CREATE SCHEMA "${STASH_PREFIX}p${DEAD_PID}_aaaaaaaa"`)
    await sql.unsafe(`CREATE SCHEMA "${STASH_PREFIX}p${DEAD_PID}_bbbbbbbb"`)

    let message = ""
    try {
      await takeOverAppSchema(SCHEMA)
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toContain("2 abandoned fixture stashes")
    // Nothing was guessed at: both stashes and the schema are untouched.
    expect((await stashes()).length).toBe(2)
    expect(await tableExists(`${SCHEMA}.real_marker`)).toBe(true)
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The kernel.files SELECT policy rebuild runs at boot and after every app
// (re)install. Its DDL takes an ACCESS EXCLUSIVE lock on kernel.files, so:
//   - a rebuild whose policy would come out the same must run no DDL at all;
//   - when it must change, it may never sit in the lock queue behind a long
//     read (every later reader of kernel.files would queue behind it): it uses
//     a short lock_timeout and retries;
//   - N rebuild requests inside one batch (a reconcile repairing N apps) are
//     ONE rebuild;
//   - the resulting policy is exactly the one the plain DROP + CREATE built.
//
// Fails-without-fix: the old rebuild ran DROP + CREATE on every call (new
// policy oid each time), waited for the lock indefinitely, and had no batch.
import { afterAll, afterEach, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import {
  batchFilesSelectPolicyRebuild,
  currentFilesSelectPolicyStatement,
  type FilesSelectPolicyRebuildOptions,
  filesSelectPolicyRebuildStats,
  rebuildFilesSelectPolicy,
  registerFilesSelectPolicyCheck,
} from "~/infra/boot-phase10"
import { LeadershipTestAccess, startLeadership } from "~/infra/leadership"
import { manifestFileParentRegistry } from "~/modules/apps/app-registries"
import { CatalogDerivationsTestAccess } from "~/modules/apps/catalog-derivations"
import { applyFilesSelectPolicyStatements } from "~/tests/helpers/files-select-policy"
import { pgLockWaiters } from "~/tests/helpers/pg-lock-waiters"
import { waitFor } from "~/tests/helpers/wait-for"

const ORG = randomUUID()
const APP = "fx119lock"
const ENTITY = "member"

interface LivePolicy {
  oid: number
  cmd: string
  permissive: string
  roles: string[]
  qual: string | null
  withCheck: string | null
}

async function livePolicy(): Promise<LivePolicy | undefined> {
  const rows = (await sql`
    SELECT oid::int AS oid, cmd, permissive, roles::text[] AS roles, qual, with_check AS "withCheck"
    FROM pg_policies JOIN pg_policy ON pg_policy.polname = pg_policies.policyname
      AND pg_policy.polrelid = 'kernel.files'::regclass
    WHERE schemaname = 'kernel' AND tablename = 'files' AND policyname = 'files_select'
  `) as unknown as LivePolicy[]
  return rows[0]
}

/** Register one more file parent so the registry's policy differs from the live one. */
function addFileParent(): void {
  manifestFileParentRegistry.set([ORG, APP, ENTITY], {
    tableName: "users",
    schemaRef: "kernel",
    joinOn: "id",
    readScope: `${APP}:members:read`,
    writeScope: `${APP}:members:write`,
  })
}

/**
 * The rebuild with the parents the registry holds (the fixture parent
 * included): production builds from the catalog, which has no fixture app.
 */
function rebuildFromRegistry(opts: FilesSelectPolicyRebuildOptions = {}) {
  return rebuildFilesSelectPolicy({
    parents: CatalogDerivationsTestAccess.registryFileParents(),
    ...opts,
  })
}

afterEach(() => {
  manifestFileParentRegistry.delete([ORG, APP, ENTITY])
})

afterAll(async () => {
  manifestFileParentRegistry.delete([ORG, APP, ENTITY])
  await rebuildFilesSelectPolicy()
})

describe("kernel.files SELECT policy rebuild", () => {
  it("builds exactly the policy the plain DROP + CREATE builds, then runs no DDL while unchanged", async () => {
    addFileParent()
    // Today's path, verbatim: the builder's statement in one transaction.
    await applyFilesSelectPolicyStatements([
      "SET LOCAL ROLE liaison_app",
      currentFilesSelectPolicyStatement(CatalogDerivationsTestAccess.registryFileParents()),
    ])
    const plain = await livePolicy()
    expect(plain?.qual).toContain(APP)

    // First rebuild: same policy text, so the live policy is not touched by
    // anything but its stamp (the plain DDL left none).
    expect(await rebuildFromRegistry()).toBe("applied")
    const rebuilt = await livePolicy()
    expect({ ...rebuilt, oid: 0 }).toEqual({ ...plain, oid: 0 } as LivePolicy)

    // Unchanged registry: no DDL, the very same policy object stays.
    const appliedBefore = filesSelectPolicyRebuildStats.applied
    expect(await rebuildFromRegistry()).toBe("unchanged")
    expect(await rebuildFromRegistry()).toBe("unchanged")
    expect(filesSelectPolicyRebuildStats.applied).toBe(appliedBefore)
    expect((await livePolicy())?.oid).toBe(rebuilt?.oid as number)

    // A registry change is picked up.
    manifestFileParentRegistry.delete([ORG, APP, ENTITY])
    expect(await rebuildFromRegistry()).toBe("applied")
    expect((await livePolicy())?.qual ?? "").not.toContain(APP)
  })

  it("re-applies after a hand edit of the policy even though its stamp survived", async () => {
    await rebuildFromRegistry()
    expect(await rebuildFromRegistry()).toBe("unchanged")
    await applyFilesSelectPolicyStatements([
      "SET LOCAL ROLE liaison_app",
      "ALTER POLICY files_select ON kernel.files USING (false)",
    ])
    expect(await rebuildFromRegistry()).toBe("applied")
    expect((await livePolicy())?.qual).not.toBe("false")
  })

  it("never queues readers behind it: a busy kernel.files makes it time out its lock and retry", async () => {
    await rebuildFromRegistry()
    addFileParent()

    // A long read holds ACCESS SHARE on kernel.files for 1.5 s.
    const holder = await sql.reserve()
    let reader: Awaited<ReturnType<typeof sql.reserve>> | undefined
    try {
      await holder`BEGIN`
      await holder`SELECT 1 FROM kernel.files LIMIT 1`
      const timeoutsBefore = filesSelectPolicyRebuildStats.lockTimeouts
      const rebuild = rebuildFromRegistry({
        lockTimeoutMs: 200,
        maxAttempts: 20,
        backoffMs: 50,
      })

      // A reader arriving while the rebuild wants its lock gets through: the
      // rebuild waits at most lock_timeout, then steps out of the queue.
      await waitFor(async () => (await pgLockWaiters("kernel.files")) > 0, {
        label: "the rebuild to queue behind the holder",
      })
      reader = await sql.reserve()
      const t0 = performance.now()
      await reader`SELECT count(*) FROM kernel.files`
      const readerMs = performance.now() - t0
      expect(readerMs).toBeLessThan(1000)

      // At least one rebuild attempt has hit its lock timeout and backed off.
      await waitFor(() => filesSelectPolicyRebuildStats.lockTimeouts > timeoutsBefore, {
        label: "a rebuild lock timeout",
      })
      await holder`COMMIT`
      expect(await rebuild).toBe("applied")
      expect(filesSelectPolicyRebuildStats.lockTimeouts).toBeGreaterThan(timeoutsBefore)
      expect((await livePolicy())?.qual).toContain(APP)
    } finally {
      await holder`ROLLBACK`.catch(() => {})
      holder.release()
      reader?.release()
    }
  })

  it("gives up after its attempts and leaves the existing policy in place", async () => {
    await rebuildFromRegistry()
    const before = await livePolicy()
    addFileParent()
    const holder = await sql.reserve()
    try {
      await holder`BEGIN`
      await holder`SELECT 1 FROM kernel.files LIMIT 1`
      const outcome = await rebuildFromRegistry({
        lockTimeoutMs: 100,
        maxAttempts: 2,
        backoffMs: 10,
      })
      expect(outcome).toBe("skipped")
    } finally {
      await holder`ROLLBACK`
      holder.release()
    }
    expect(await livePolicy()).toEqual(before as LivePolicy)
  })

  it("collapses every rebuild requested inside a batch into one, after the batch", async () => {
    await rebuildFromRegistry()
    const evaluatedBefore = filesSelectPolicyRebuildStats.evaluated
    const inner = await batchFilesSelectPolicyRebuild(async () => {
      const outcomes = []
      for (let i = 0; i < 5; i++) {
        if (i === 2) addFileParent()
        outcomes.push(await rebuildFromRegistry())
      }
      // Nested batches join the outer one.
      await batchFilesSelectPolicyRebuild(() => rebuildFromRegistry())
      expect(filesSelectPolicyRebuildStats.evaluated).toBe(evaluatedBefore)
      return outcomes
    })
    expect(inner).toEqual(["deferred", "deferred", "deferred", "deferred", "deferred"])
    expect(filesSelectPolicyRebuildStats.evaluated).toBe(evaluatedBefore + 1)
    // The one rebuild saw the parent registered mid-batch.
    expect((await livePolicy())?.qual).toContain(APP)
  })

  it("two rebuilds racing a new app table never drop its parent", async () => {
    // Process A rebuilds before B's app table exists; B creates the table and
    // rebuilds. Whatever the order their DDL commits in, B's parent stays.
    // Its own schema: the test role may not create tables in the kernel's.
    const schema = schemaRef("fx_p5b_race")
    const table = "race_parent"
    const raceParent = {
      app: "fxp5brace",
      entityType: "thing",
      schemaRef: "fx_p5b_race",
      tableName: table,
      joinOn: "id",
    }
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await sql.unsafe(`CREATE SCHEMA "${schema}"`)
    await sql.unsafe(`GRANT USAGE ON SCHEMA "${schema}" TO liaison_rls, liaison_app, liaison_admin`)
    await rebuildFromRegistry()
    // A new parent on an existing table too, so A has DDL to run.
    addFileParent()
    const parents = [...CatalogDerivationsTestAccess.registryFileParents(), raceParent]
    const holder = await sql.reserve()
    try {
      await holder`BEGIN`
      await holder`SELECT 1 FROM kernel.files LIMIT 1`
      // A: the table is missing when it looks; its DDL times out on the busy
      // kernel.files and backs off for a second.
      const timeoutsBefore = filesSelectPolicyRebuildStats.lockTimeouts
      const a = rebuildFilesSelectPolicy({
        parents,
        lockTimeoutMs: 150,
        maxAttempts: 10,
        backoffMs: 1000,
      })
      await waitFor(() => filesSelectPolicyRebuildStats.lockTimeouts > timeoutsBefore, {
        label: "A to back off",
      })
      // B: its process creates the table, then rebuilds, and gets the lock first.
      await sql.unsafe(
        `CREATE TABLE "${schema}"."${table}" (id uuid PRIMARY KEY, org_id uuid NOT NULL)`,
      )
      const b = rebuildFilesSelectPolicy({ parents, lockTimeoutMs: 10_000, maxAttempts: 1 })
      await waitFor(async () => (await pgLockWaiters("kernel.files")) > 0, {
        label: "B to queue on kernel.files",
      })
      await holder`COMMIT`
      expect(await b).toBe("applied")
      // A, after its backoff, re-reads the tables under the lock: nothing to undo.
      expect(await a).toBe("unchanged")
      expect((await livePolicy())?.qual).toContain(table)
    } finally {
      await holder`ROLLBACK`.catch(() => {})
      holder.release()
      manifestFileParentRegistry.delete([ORG, APP, ENTITY])
      await rebuildFromRegistry()
      // The policy no longer names the table: dropping it drops nothing else.
      await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    }
  }, 30_000)

  it("a process with an older catalog leaves a policy built from a newer one alone", async () => {
    addFileParent()
    const parents = CatalogDerivationsTestAccess.registryFileParents()
    expect(
      await rebuildFilesSelectPolicy({
        parents,
        catalogVersions: { [APP]: "2.0.0", other: "1.0.0" },
      }),
    ).toBe("applied")
    const newer = await livePolicy()
    manifestFileParentRegistry.delete([ORG, APP, ENTITY])
    const older = CatalogDerivationsTestAccess.registryFileParents()

    // The old release (APP at 1.9.0) would drop the parent: refused.
    expect(
      await rebuildFilesSelectPolicy({ parents: older, catalogVersions: { [APP]: "1.9.0" } }),
    ).toBe("superseded")
    expect(await livePolicy()).toEqual(newer as LivePolicy)

    // The same or a newer catalog applies; an app only one side has is not compared.
    expect(
      await rebuildFilesSelectPolicy({
        parents: older,
        catalogVersions: { [APP]: "2.0.0", added: "0.1.0" },
      }),
    ).toBe("applied")
    expect((await livePolicy())?.qual ?? "").not.toContain(APP)
  })

  it("the leader re-applies the catalog's policy when it takes the lease", async () => {
    await rebuildFilesSelectPolicy()
    await applyFilesSelectPolicyStatements([
      "SET LOCAL ROLE liaison_app",
      "ALTER POLICY files_select ON kernel.files USING (false)",
    ])
    const appliedBefore = filesSelectPolicyRebuildStats.applied
    try {
      registerFilesSelectPolicyCheck()
      await startLeadership({
        role: "all",
        lease: {
          key: `files-select-test:${randomUUID()}`,
          ttlMs: 3000,
          renewMs: 1000,
          pollMs: 250,
        },
      })
      await waitFor(() => filesSelectPolicyRebuildStats.applied > appliedBefore, {
        label: "the leader's policy rebuild",
      })
      expect((await livePolicy())?.qual).not.toBe("false")
    } finally {
      await LeadershipTestAccess.reset()
    }
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// App registration DDL (DROP + CREATE POLICY on every app table, ACCESS
// EXCLUSIVE) runs on tables every org shares. The server serves after its first
// org registers and registers the others in the background while job workers
// run, so re-running that DDL for each org deadlocked the jobs of the orgs
// already serving (a reader holding one app table and waiting for another).
// `liaison config apply` (a fresh CLI process next to the serving server) had
// the same problem.
//
// Pinned here:
//   - a registration (server or CLI) of an app whose schema is already current
//     at its DDL stamp runs ZERO DDL transactions and leaves every app policy
//     exactly as it was (same objects), and still registers it in memory;
//   - a changed app (version, trust flags) still runs its DDL, with the same
//     generated policies;
//   - that DDL times out its locks and retries instead of queueing readers, a
//     server's last attempt waits for its locks so the upgrade still lands, and
//     a deadlock with a reader rolls the DDL back and retries it;
//   - the CLI's sandbox pool starts empty.
//
// Fails-without-fix: the server re-ran every app's DDL for every org (new
// policy oids), waited for its locks with no timeout, and a deadlock failed the
// registration.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql } from "~/db"
import {
  appBridgeManifestRegistry,
  appSettingsRegistry,
  manifestRegistry,
  resetAppRegistries,
  toolRegistry,
} from "~/modules/apps/app-registries"
import { getDefaultApps, sandboxPoolOptionsForProcess } from "~/modules/apps/init"
import {
  type AppDescriptor,
  AppSchemaDdlTestAccess,
  appDdlDeferral,
  appDdlLockPolicy,
  appRegistrationStats,
  ManifestVerdictTestAccess,
  registerApps,
} from "~/modules/apps/runtime"
import { pgLockWaiters } from "~/tests/helpers/pg-lock-waiters"
import { waitFor } from "~/tests/helpers/wait-for"

const ORG = randomUUID()
let apps: AppDescriptor[]
const savedCli = process.env.LIAISON_CLI
const savedLockPolicy = { ...appDdlLockPolicy }

interface PolicyRow {
  oid: number
  schemaname: string
  tablename: string
  policyname: string
  cmd: string
  roles: string[]
  qual: string | null
  with_check: string | null
}

async function appPolicies(): Promise<PolicyRow[]> {
  return (await sql`
    SELECT p.oid::int AS oid, pp.schemaname::text, pp.tablename::text, pp.policyname::text,
      pp.cmd, pp.roles::text[] AS roles, pp.qual, pp.with_check
    FROM pg_policies pp
    JOIN pg_namespace n ON n.nspname = pp.schemaname
    JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = pp.tablename
    JOIN pg_policy p ON p.polrelid = c.oid AND p.polname = pp.policyname
    WHERE pp.schemaname LIKE 'app\\_%'
    ORDER BY 2, 3, 4
  `) as unknown as PolicyRow[]
}

const withoutOid = (rows: PolicyRow[]) => rows.map(({ oid: _oid, ...r }) => r)

function setCli(on: boolean): void {
  if (on) process.env.LIAISON_CLI = "1"
  else delete process.env.LIAISON_CLI
}

/** A fresh process: no in-memory registration survives. */
async function registerFresh(descs: AppDescriptor[], cli: boolean): Promise<void> {
  resetAppRegistries()
  setCli(cli)
  await registerApps(descs, ORG)
}

/** An app with tables (not mail: its boot assertions are their own subject). */
function appWithTables(): AppDescriptor {
  const found = apps.find(
    (a) =>
      a.name !== "mail" &&
      a.schema &&
      Object.values(a.schema as Record<string, { fields?: unknown }>).some((e) => e?.fields),
  )
  if (!found) throw new Error("no in-tree app with tables")
  return found
}

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug)
    VALUES (${ORG}, 'Registration reuse org', ${`reg-reuse-${ORG.slice(0, 8)}`})`
  apps = await getDefaultApps()
})

afterEach(() => {
  Object.assign(appDdlLockPolicy, savedLockPolicy)
  setCli(savedCli === "1")
})

afterAll(async () => {
  // Leave the shared app schemas as the server's boot would.
  await registerFresh(apps, false)
  setCli(savedCli === "1")
  resetAppRegistries()
  await sql`DELETE FROM kernel.apps WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
})

/** The schema and first table of an app, quoted for SQL. */
function firstTable(desc: AppDescriptor): { schema: string; rel: string } {
  const schema = `app_${desc.name.replace(/-/g, "_")}`
  const table = Object.entries(desc.schema as Record<string, { fields?: unknown }>).find(
    ([, e]) => e?.fields,
  )?.[0] as string
  return { schema, rel: `"${schema}"."${table}"` }
}

async function appRow(name: string): Promise<{ version: string; status: string } | undefined> {
  const [row] = await sql<{ version: string; status: string }[]>`
    SELECT version, status FROM kernel.apps WHERE org_id = ${ORG} AND name = ${name}`
  return row
}

describe("app registration of an already-current schema", () => {
  for (const cli of [false, true]) {
    it(`${cli ? "a CLI process" : "the server"} runs zero registration DDL and keeps every app policy as is`, async () => {
      await registerFresh(apps, false)
      const policies = await appPolicies()
      expect(policies.length).toBeGreaterThan(0)
      const ddl = appRegistrationStats.ddlTransactions
      const reused = appRegistrationStats.ddlReused

      await registerFresh(apps, cli)

      expect(appRegistrationStats.ddlTransactions).toBe(ddl)
      expect(appRegistrationStats.ddlReused - reused).toBeGreaterThanOrEqual(apps.length - 1)
      // The very same policy objects (DROP + CREATE would mint new oids).
      expect(await appPolicies()).toEqual(policies)
      // Still registered in memory: tools, jobs and provisioners need the registries.
      expect(manifestRegistry.get([ORG, appWithTables().name])).toBeDefined()
    })
  }

  it("still runs the DDL of a changed app, with the same generated policies", async () => {
    await registerFresh(apps, false)
    const before = await appPolicies()
    const target = appWithTables()
    const bumped = { ...target, version: `${target.version}-c119a` } as AppDescriptor
    const ddl = appRegistrationStats.ddlTransactions

    await registerFresh(
      apps.map((a) => (a.name === target.name ? bumped : a)),
      false,
    )

    expect(appRegistrationStats.ddlTransactions - ddl).toBe(1)
    const after = await appPolicies()
    expect(withoutOid(after)).toEqual(withoutOid(before))
    const { schema } = firstTable(target)
    const changedOids = after.filter((p) => p.schemaname === schema).map((p) => p.oid)
    const oldOids = before.filter((p) => p.schemaname === schema).map((p) => p.oid)
    expect(changedOids.length).toBeGreaterThan(0)
    expect(changedOids).not.toEqual(oldOids)
    expect((await appRow(target.name))?.version).toBe(bumped.version)
  })

  it("runs the DDL again when the install's trust flags change", async () => {
    await registerFresh(apps, false)
    const target = appWithTables()
    const vouched = { ...target, _firstParty: !target._firstParty } as AppDescriptor
    const ddl = appRegistrationStats.ddlTransactions

    await registerFresh(
      apps.map((a) => (a.name === target.name ? vouched : a)),
      false,
    )

    expect(appRegistrationStats.ddlTransactions - ddl).toBe(1)
  })
})

describe("in-memory registration of a set-up org (setup stamp matched)", () => {
  it("checks each app schema once per process, not once per org", async () => {
    AppSchemaDdlTestAccess.forgetCurrentSchemas()
    // The org's first setup: its rows written, every app schema found current.
    await registerFresh(apps, false)
    const reused = appRegistrationStats.ddlReused
    const ddl = appRegistrationStats.ddlTransactions
    const skipped = appRegistrationStats.ddlCheckSkipped

    // Two more orgs' first touches with a matching stamp: no schema transaction at all.
    for (let i = 0; i < 2; i++) {
      resetAppRegistries()
      await registerApps(apps, ORG, { skipOrgRows: true })
    }

    expect(appRegistrationStats.ddlReused).toBe(reused)
    expect(appRegistrationStats.ddlTransactions).toBe(ddl)
    expect(appRegistrationStats.ddlCheckSkipped - skipped).toBeGreaterThanOrEqual(
      2 * (apps.length - 1),
    )
    // Still registered in memory: tools, jobs and provisioners need the registries.
    expect(manifestRegistry.get([ORG, appWithTables().name])).toBeDefined()
  })

  it("judges each manifest against the app contract once, not once per org", async () => {
    await registerFresh(apps, false)
    const judged = ManifestVerdictTestAccess.judged()
    for (let i = 0; i < 2; i++) {
      resetAppRegistries()
      // Fresh copies, as every org's first touch gets them (getDefaultApps).
      await registerApps(await getDefaultApps(), ORG, { skipOrgRows: true })
    }
    expect(ManifestVerdictTestAccess.judged()).toBe(judged)
    expect(manifestRegistry.get([ORG, appWithTables().name])).toBeDefined()
  })

  it("shares what it builds from a manifest across orgs instead of copying it per org", async () => {
    const other = randomUUID()
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${other}, 'Registration reuse org 2', ${`reg-reuse-${other.slice(0, 8)}`})`
    resetAppRegistries()
    // Fresh copies, as every org's first touch gets them (getDefaultApps).
    await registerApps(await getDefaultApps(), ORG, { skipOrgRows: true })
    await registerApps(await getDefaultApps(), other, { skipOrgRows: true })
    const withTools = apps.filter((a) => Object.keys(a.tools ?? {}).length > 0)
    expect(withTools.length).toBeGreaterThan(0)
    for (const app of withTools) {
      for (const tool of Object.keys(app.tools ?? {})) {
        const mine = toolRegistry.get([ORG, app.name, tool])
        expect(mine).toBeDefined()
        expect(toolRegistry.get([other, app.name, tool])).toBe(mine)
        // Shared, so a reader that writes into it fails instead of reaching other orgs.
        expect(Object.isFrozen(mine)).toBe(true)
      }
      expect(appBridgeManifestRegistry.get([other, app.name])).toBe(
        appBridgeManifestRegistry.get([ORG, app.name]),
      )
      expect(appSettingsRegistry.get([other, app.name])).toBe(
        appSettingsRegistry.get([ORG, app.name]),
      )
    }

    // Other install facts are another variant: built again, not shared with the first.
    const target = withTools[0] as AppDescriptor
    const tool = Object.keys(target.tools ?? {})[0] as string
    const before = toolRegistry.get([ORG, target.name, tool])
    const signed = (target as { _publisherSigned?: boolean })._publisherSigned === true
    const vouched = { ...target, _publisherSigned: !signed } as AppDescriptor
    resetAppRegistries()
    await registerApps(
      (await getDefaultApps()).map((a) => (a.name === target.name ? vouched : a)),
      other,
      { skipOrgRows: true },
    )
    expect(toolRegistry.get([other, target.name, tool])).not.toBe(before)
    resetAppRegistries()
    await sql`DELETE FROM kernel.apps WHERE org_id = ${other}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${other}`
  })

  it("a changed app is checked again", async () => {
    await registerFresh(apps, false)
    const target = appWithTables()
    const bumped = { ...target, version: `${target.version}-p5c` } as AppDescriptor
    const reused = appRegistrationStats.ddlReused
    const ddl = appRegistrationStats.ddlTransactions
    resetAppRegistries()
    await registerApps(
      apps.map((a) => (a.name === target.name ? bumped : a)),
      ORG,
      { skipOrgRows: true },
    )
    expect(
      appRegistrationStats.ddlReused - reused + appRegistrationStats.ddlTransactions - ddl,
    ).toBe(1)
  })
})

// Registration of every app comes before the changed one reaches its DDL, so on
// a loaded machine the waits below take seconds, not milliseconds.
const CONTENDED_WAIT_MS = 30_000
const CONTENDED_TEST_MS = 120_000

describe("the DDL of a changed app next to readers", () => {
  it(
    "times out its locks and retries instead of queueing readers",
    async () => {
      await registerFresh(apps, false)
      const target = appWithTables()
      const { rel } = firstTable(target)
      const bumped = { ...target, version: `${target.version}-c119b` } as AppDescriptor
      Object.assign(appDdlLockPolicy, { lockTimeoutMs: 200, maxAttempts: 20, backoffMs: 50 })
      const timeouts = appRegistrationStats.lockTimeouts

      const holder = await sql.reserve()
      let reader: Awaited<ReturnType<typeof sql.reserve>> | undefined
      try {
        await holder`BEGIN`
        await holder.unsafe(`SELECT 1 FROM ${rel} LIMIT 1`)
        const registering = registerFresh(
          apps.map((a) => (a.name === target.name ? bumped : a)),
          false,
        )
        // The registration's DDL is queued behind the holder: a lock request on
        // the table that is not granted.
        await waitFor(async () => (await pgLockWaiters(rel)) > 0, {
          label: "the DDL to queue behind the holder",
          timeoutMs: CONTENDED_WAIT_MS,
        })
        reader = await sql.reserve()
        const t0 = performance.now()
        await reader.unsafe(`SELECT count(*) FROM ${rel}`)
        expect(performance.now() - t0).toBeLessThan(1000)
        // At least one DDL attempt has hit its lock timeout and backed off.
        await waitFor(() => appRegistrationStats.lockTimeouts > timeouts, {
          label: "a DDL lock timeout",
          timeoutMs: CONTENDED_WAIT_MS,
        })
        await holder`COMMIT`
        await registering
      } finally {
        await holder`ROLLBACK`.catch(() => {})
        holder.release()
        reader?.release()
      }
      expect(appRegistrationStats.lockTimeouts).toBeGreaterThan(timeouts)
      const row = await appRow(target.name)
      expect(row?.version).toBe(bumped.version)
      expect(row?.status).toBe("active")
    },
    CONTENDED_TEST_MS,
  )

  it(
    "a re-apply that loses its locks serves the org on the existing schema and is not re-run by the next orgs",
    async () => {
      await registerFresh(apps, false)
      const target = appWithTables()
      const { rel } = firstTable(target)
      const bumped = { ...target, version: `${target.version}-c119d` } as AppDescriptor
      const withBumped = apps.map((a) => (a.name === target.name ? bumped : a))
      // No last waiting attempt (CLI): the one timed attempt loses to the holder.
      Object.assign(appDdlLockPolicy, { lockTimeoutMs: 100, maxAttempts: 1, backoffMs: 10 })
      const savedCooldown = appDdlDeferral.cooldownMs
      const holder = await sql.reserve()
      try {
        await holder`BEGIN`
        await holder.unsafe(`SELECT 1 FROM ${rel} LIMIT 1`)
        const ddl = appRegistrationStats.ddlTransactions
        const deferred = appRegistrationStats.ddlDeferred
        await registerFresh(withBumped, true)
        // The org has the app, on the schema already in place.
        expect(manifestRegistry.get([ORG, target.name])).toBeDefined()
        expect((await appRow(target.name))?.version).toBe(bumped.version)
        expect(appRegistrationStats.ddlDeferred - deferred).toBe(1)

        // The next registration in the cool-down runs no DDL and waits on no lock.
        const timeouts = appRegistrationStats.lockTimeouts
        const t0 = performance.now()
        await registerFresh(withBumped, true)
        expect(performance.now() - t0).toBeLessThan(5_000)
        expect(appRegistrationStats.lockTimeouts).toBe(timeouts)
        expect(appRegistrationStats.ddlDeferred - deferred).toBe(2)
        expect(manifestRegistry.get([ORG, target.name])).toBeDefined()

        // After the cool-down, the re-apply runs again and lands once the locks are free.
        await holder`COMMIT`
        appDdlDeferral.cooldownMs = 0
        await registerFresh(withBumped, false)
        expect(appRegistrationStats.ddlTransactions - ddl).toBeGreaterThanOrEqual(1)
      } finally {
        appDdlDeferral.cooldownMs = savedCooldown
        await holder`ROLLBACK`.catch(() => {})
        holder.release()
      }
    },
    CONTENDED_TEST_MS,
  )

  it(
    "a server's last attempt waits for its locks, so the upgrade lands",
    async () => {
      await registerFresh(apps, false)
      const target = appWithTables()
      const { rel } = firstTable(target)
      const bumped = { ...target, version: `${target.version}-c119c` } as AppDescriptor
      Object.assign(appDdlLockPolicy, { lockTimeoutMs: 100, maxAttempts: 2, backoffMs: 10 })
      const timeouts = appRegistrationStats.lockTimeouts

      const holder = await sql.reserve()
      try {
        await holder`BEGIN`
        await holder.unsafe(`SELECT 1 FROM ${rel} LIMIT 1`)
        const registering = registerFresh(
          apps.map((a) => (a.name === target.name ? bumped : a)),
          false,
        )
        // Both timed attempts gave up; the last one is queued on the table.
        await waitFor(() => appRegistrationStats.lockTimeouts - timeouts >= 2, {
          label: "the timed attempts to give up",
          timeoutMs: CONTENDED_WAIT_MS,
        })
        await waitFor(async () => (await pgLockWaiters(rel)) > 0, {
          label: "the last attempt to wait for the table",
          timeoutMs: CONTENDED_WAIT_MS,
        })
        await holder`COMMIT`
        await registering
      } finally {
        await holder`ROLLBACK`.catch(() => {})
        holder.release()
      }
      expect(appRegistrationStats.lockTimeouts - timeouts).toBe(2)
      const row = await appRow(target.name)
      expect(row?.version).toBe(bumped.version)
      expect(row?.status).toBe("active")
    },
    CONTENDED_TEST_MS,
  )

  it(
    "a deadlock with a reader rolls the DDL back and retries it; the reader runs",
    async () => {
      await registerFresh(apps, false)
      const target = appWithTables()
      const { rel } = firstTable(target)
      const bumped = { ...target, version: `${target.version}-c119d` } as AppDescriptor
      // A lock timeout far above the deadlock check, so the cycle is what ends the wait.
      Object.assign(appDdlLockPolicy, { lockTimeoutMs: 10_000, maxAttempts: 5, backoffMs: 50 })
      const timeouts = appRegistrationStats.lockTimeouts

      const holder = await sql.reserve()
      try {
        // The reader holds the org's app row, which the DDL writes after it has
        // locked every table of the app schema...
        await holder`BEGIN`
        await holder`SELECT 1 FROM kernel.apps WHERE org_id = ${ORG} AND name = ${target.name} FOR UPDATE`
        const registering = registerFresh(
          apps.map((a) => (a.name === target.name ? bumped : a)),
          false,
        )
        await waitFor(async () => (await pgLockWaiters()) > 0, {
          label: "the DDL to wait for the app row",
          timeoutMs: CONTENDED_WAIT_MS,
        })
        // ...then reads one of those tables: a lock cycle. The DDL waited first,
        // so its deadlock check runs first and it is the one rolled back.
        await holder.unsafe(`SELECT 1 FROM ${rel} LIMIT 1`)
        await holder`COMMIT`
        await registering
      } finally {
        await holder`ROLLBACK`.catch(() => {})
        holder.release()
      }
      expect(appRegistrationStats.lockTimeouts).toBeGreaterThan(timeouts)
      const row = await appRow(target.name)
      expect(row?.version).toBe(bumped.version)
      expect(row?.status).toBe("active")
    },
    CONTENDED_TEST_MS,
  )
})

describe("the CLI process", () => {
  it("starts its sandbox pool empty; the server's pre-warms", () => {
    setCli(true)
    expect(sandboxPoolOptionsForProcess()).toEqual({ initialSize: 0 })
    setCli(false)
    expect(sandboxPoolOptionsForProcess()).toEqual({})
  })
})

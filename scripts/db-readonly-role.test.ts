// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Integration tests for db-readonly-role.ts against the real test PG.
// Covers (Task 7 §7.2): idempotence (create runs twice cleanly), the
// generated grants render matches the checked-in file (sync-check basis),
// allow-listed SELECT succeeds, non-allow-listed table/secret columns 42501,
// SELECT * on a mixed table omits/errors on secret columns, INSERT/UPDATE/
// DELETE/DDL all fail, SET transaction_read_only=off then INSERT still fails
// at the grant layer (independent of layer 5), pg_sleep EXECUTE-denied at
// the role layer (independent of sql-guard), a table not in the allow-list
// stays invisible until the catalog + regenerated grants add it (fail-closed).

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import postgres from "postgres"
import { checkGrantsInSync, runCheck } from "./db-readonly-role"

const DSN =
  process.env.DATABASE_URL ?? "postgres://liaison_app:liaison_app@localhost:5432/liaison_test"
const SUPERUSER_DSN = DSN.replace("liaison_app:liaison_app", "liaison:liaison")
const READONLY_PASSWORD = "test-readonly-role-password-123"
const SCRATCH_SCHEMA = "readonly_role_test_scratch"

let superuserSql: ReturnType<typeof postgres>

beforeAll(async () => {
  superuserSql = postgres(SUPERUSER_DSN, { max: 1, onnotice: () => {} })
  await superuserSql.unsafe(`DROP SCHEMA IF EXISTS ${SCRATCH_SCHEMA} CASCADE`)
  await superuserSql.unsafe(`CREATE SCHEMA ${SCRATCH_SCHEMA}`)
  await superuserSql.unsafe(
    `CREATE TABLE ${SCRATCH_SCHEMA}.not_in_allowlist (id serial PRIMARY KEY)`,
  )

  // Run the checked-in generated grants + set a test password, mirroring
  // what `--create` does (using the real generated file via the module's
  // internal helper by re-executing the same file the CLI would).
  const { readFileSync } = await import("node:fs")
  const grantsPath = new URL(
    "../apps/api/src/modules/apps/connections/sql/generated/readonly-grants.sql",
    import.meta.url,
  ).pathname
  const grants = readFileSync(grantsPath, "utf-8")
  await superuserSql.unsafe(grants)
  await superuserSql.unsafe(`ALTER ROLE liaison_readonly PASSWORD '${READONLY_PASSWORD}'`)
})

afterAll(async () => {
  await superuserSql.unsafe(`DROP SCHEMA IF EXISTS ${SCRATCH_SCHEMA} CASCADE`)
  await superuserSql.end()
})

describe("db-readonly-role — idempotence", () => {
  test("running the generated grants twice does not error", async () => {
    const { readFileSync } = await import("node:fs")
    const grantsPath = new URL(
      "../apps/api/src/modules/apps/connections/sql/generated/readonly-grants.sql",
      import.meta.url,
    ).pathname
    const grants = readFileSync(grantsPath, "utf-8")
    await expect(superuserSql.unsafe(grants)).resolves.toBeDefined()
  })
})

describe("db-readonly-role — catalog/grants sync check", () => {
  test("the checked-in generated file matches a fresh render from the current catalog", async () => {
    const { inSync } = await checkGrantsInSync()
    expect(inSync).toBe(true)
  })
})

describe("liaison_readonly — allow-list grant enforcement", () => {
  let readonlySql: ReturnType<typeof postgres>

  beforeAll(() => {
    const readonlyDsn = DSN.replace(/\/\/[^@]+@/, `//liaison_readonly:${READONLY_PASSWORD}@`)
    readonlySql = postgres(readonlyDsn, { max: 1, onnotice: () => {} })
  })
  afterAll(async () => {
    await readonlySql.end()
  })

  test("SELECT on an allow-listed table's allow-listed columns succeeds", async () => {
    const rows = await readonlySql`SELECT tier, slug FROM kernel.organizations LIMIT 1`
    expect(Array.isArray(rows)).toBe(true)
  })

  test("SELECT on a non-allow-listed table fails with 42501", async () => {
    let caught: { code?: string } | undefined
    try {
      await readonlySql.unsafe(`SELECT * FROM ${SCRATCH_SCHEMA}.not_in_allowlist`)
    } catch (err) {
      caught = err as { code?: string }
    }
    expect(caught?.code).toBe("42501")
  })

  test("SELECT settings FROM kernel.organizations fails with 42501", async () => {
    let caught: { code?: string } | undefined
    try {
      await readonlySql`SELECT settings FROM kernel.organizations`
    } catch (err) {
      caught = err as { code?: string }
    }
    expect(caught?.code).toBe("42501")
  })

  test("SELECT password_hash FROM kernel.users fails with 42501", async () => {
    let caught: { code?: string } | undefined
    try {
      await readonlySql`SELECT password_hash FROM kernel.users`
    } catch (err) {
      caught = err as { code?: string }
    }
    expect(caught?.code).toBe("42501")
  })

  // C1/S1 sweep completion — app_tickets.tickets.reply_token is the inbound-
  // email auth token (forging replies); it must be unreachable at the grant
  // layer exactly like the kernel.* secrets above, even though the catalog
  // DOES grant SELECT on other app_tickets.tickets columns.
  test("SELECT reply_token FROM app_tickets.tickets fails with 42501", async () => {
    let caught: { code?: string } | undefined
    try {
      await readonlySql`SELECT reply_token FROM app_tickets.tickets`
    } catch (err) {
      caught = err as { code?: string }
    }
    expect(caught?.code).toBe("42501")
  })

  // S1 fail-closed fix: every granted table now gets a column-scoped grant,
  // never a bare full-row grant — proven here on two tables that previously
  // rendered full-row (kernel.audit_log, kernel.contacts) because they had
  // zero SECRET_COLUMNS entries at the time. Safety no longer depends on
  // SECRET_COLUMNS being exhaustive: metadata/changes/phone/external_ids are
  // simply never granted, regardless of whether they're "secret".
  test("SELECT metadata FROM kernel.audit_log fails with 42501 (not in any read's grantColumns)", async () => {
    let caught: { code?: string } | undefined
    try {
      await readonlySql`SELECT metadata FROM kernel.audit_log`
    } catch (err) {
      caught = err as { code?: string }
    }
    expect(caught?.code).toBe("42501")
  })

  test("SELECT changes FROM kernel.audit_log fails with 42501 (not in any read's grantColumns)", async () => {
    let caught: { code?: string } | undefined
    try {
      await readonlySql`SELECT changes FROM kernel.audit_log`
    } catch (err) {
      caught = err as { code?: string }
    }
    expect(caught?.code).toBe("42501")
  })

  test("SELECT email FROM kernel.contacts succeeds — the tickets_by_requester_email join needs it, so it IS granted", async () => {
    const rows = await readonlySql`SELECT email FROM kernel.contacts LIMIT 1`
    expect(Array.isArray(rows)).toBe(true)
  })

  test("SELECT phone FROM kernel.contacts fails with 42501 (not in any read's grantColumns)", async () => {
    let caught: { code?: string } | undefined
    try {
      await readonlySql`SELECT phone FROM kernel.contacts`
    } catch (err) {
      caught = err as { code?: string }
    }
    expect(caught?.code).toBe("42501")
  })

  test("SELECT * on a mixed table (organizations) errors rather than silently omitting secret columns", async () => {
    let caught: { code?: string } | undefined
    try {
      await readonlySql`SELECT * FROM kernel.organizations`
    } catch (err) {
      caught = err as { code?: string }
    }
    expect(caught?.code).toBe("42501")
  })

  // The role logs in with default_transaction_read_only = on, and Postgres
  // checks a read-only transaction before table privileges, so a write's first
  // error is 25006. The grant layer underneath is proven on its own by the
  // `SET transaction_read_only = off` test below (42501).
  test("INSERT anywhere fails: the read-only transaction refuses it first (25006)", async () => {
    let caught: { code?: string } | undefined
    try {
      await readonlySql`INSERT INTO kernel.organizations (name, slug) VALUES ('x', 'hostile-insert-test')`
    } catch (err) {
      caught = err as { code?: string }
    }
    expect(caught?.code).toBe("25006")
  })

  test("UPDATE anywhere fails: the read-only transaction refuses it first (25006)", async () => {
    let caught: { code?: string } | undefined
    try {
      await readonlySql`UPDATE kernel.organizations SET tier = 'hostile' WHERE false`
    } catch (err) {
      caught = err as { code?: string }
    }
    expect(caught?.code).toBe("25006")
  })

  test("DELETE anywhere fails: the read-only transaction refuses it first (25006)", async () => {
    let caught: { code?: string } | undefined
    try {
      await readonlySql`DELETE FROM kernel.organizations WHERE false`
    } catch (err) {
      caught = err as { code?: string }
    }
    expect(caught?.code).toBe("25006")
  })

  test("DROP TABLE (DDL) fails", async () => {
    let caught: { code?: string } | undefined
    try {
      await readonlySql.unsafe(`DROP TABLE ${SCRATCH_SCHEMA}.not_in_allowlist`)
    } catch (err) {
      caught = err as { code?: string }
    }
    expect(caught).toBeDefined()
  })

  test("SET transaction_read_only = off then INSERT still fails at the grant layer (independent of the READ ONLY txn wall)", async () => {
    let caught: { code?: string } | undefined
    try {
      await readonlySql.begin(async (tx) => {
        await tx.unsafe("SET transaction_read_only = off")
        await tx`INSERT INTO kernel.organizations (name, slug) VALUES ('x', 'hostile-2')`
      })
    } catch (err) {
      caught = err as { code?: string }
    }
    expect(caught?.code).toBe("42501")
  })

  // The pg_sleep family is EXECUTE-denied to the role by migration 0247
  // (revoked from PUBLIC, re-granted to the application roles only).
  for (const call of [
    "SELECT pg_sleep(0.1)",
    "SELECT pg_sleep_for('100 milliseconds')",
    "SELECT pg_sleep_until(now() + interval '100 milliseconds')",
  ]) {
    test(`${call} is EXECUTE-denied at the role layer (independent of sql-guard)`, async () => {
      let caught: { code?: string } | undefined
      try {
        await readonlySql.unsafe(call)
      } catch (err) {
        caught = err as { code?: string }
      }
      expect(caught?.code).toBe("42501")
    })
  }

  test("a table not in the allow-list stays invisible even after being created post-provisioning (fail-closed)", async () => {
    await superuserSql.unsafe(
      `CREATE TABLE ${SCRATCH_SCHEMA}.newly_migrated (id serial PRIMARY KEY)`,
    )
    let caught: { code?: string } | undefined
    try {
      await readonlySql.unsafe(`SELECT * FROM ${SCRATCH_SCHEMA}.newly_migrated`)
    } catch (err) {
      caught = err as { code?: string }
    }
    expect(caught?.code).toBe("42501")
  })
})

describe("db-readonly-role --check", () => {
  test("reports clean for liaison_readonly (no non-SELECT grants, no dangerous EXECUTE grants)", async () => {
    const report = await runCheck(superuserSql)
    expect(report.roleExists).toBe(true)
    expect(report.writeGrants).toEqual([])
  })
})

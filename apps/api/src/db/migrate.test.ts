// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import postgres from "postgres"
import {
  APP_ROLE,
  connectionRole,
  migrationConnectionIsDirect,
  POLICY_ROLES,
  policyRolesSql,
  preflightMigrationUrl,
  requestLoginPasswordSql,
  scramSha256Verifier,
} from "~/db/migrate"

describe("migrate preflight", () => {
  it("connectionRole extracts the username from a connection string", () => {
    expect(connectionRole("postgres://liaison_app:pw@db:5432/liaison")).toBe(APP_ROLE)
    expect(connectionRole("postgres://liaison_migrate:pw@db:5432/liaison")).toBe("liaison_migrate")
  })

  it("connectionRole returns undefined for a roleless or unparseable URL", () => {
    expect(connectionRole("postgres://db:5432/liaison")).toBeUndefined()
    expect(connectionRole("not a url")).toBeUndefined()
  })

  it("fails when MIGRATION_DATABASE_URL is unset", () => {
    const r = preflightMigrationUrl(undefined, "production")
    expect(r.ok).toBe(false)
    expect(r.error).toContain("MIGRATION_DATABASE_URL is not set")
  })

  it("FATAL: refuses the app role in production (DATABASE_URL fallback footgun)", () => {
    const r = preflightMigrationUrl("postgres://liaison_app:pw@db:5432/liaison", "production")
    expect(r.ok).toBe(false)
    expect(r.error).toContain("unprivileged app role")
    expect(r.error).toContain(APP_ROLE)
    expect(r.error).toContain("must be the privileged")
  })

  it("allows the privileged migration role in production", () => {
    const r = preflightMigrationUrl("postgres://liaison_migrate:pw@db:5432/liaison", "production")
    expect(r.ok).toBe(true)
    expect(r.error).toBeUndefined()
  })

  it("does not block the app role outside production (dev/test reuse a single role)", () => {
    expect(
      preflightMigrationUrl("postgres://liaison_app:pw@db:5432/liaison", "development").ok,
    ).toBe(true)
    expect(preflightMigrationUrl("postgres://liaison_app:pw@db:5432/liaison", "test").ok).toBe(true)
  })
})

describe("request login password", () => {
  const password = "pa'ss\\word"
  const salt = Buffer.from(Array.from({ length: 16 }, (_, i) => i))

  it("computes the SCRAM-SHA-256 verifier client-side (vector from an independent implementation)", () => {
    expect(scramSha256Verifier(password, salt)).toBe(
      "SCRAM-SHA-256$4096:AAECAwQFBgcICQoLDA0ODw==$WMntUhU62WtqPiaQ2lBLVdaygVUKnAVWOJWjjICuqkg=:l2FQQIJ9wBDSFXPp02p2678papT0L+pfui38efLJgrs=",
    )
  })

  it("the statement carries the verifier, never the password", () => {
    const stmt = requestLoginPasswordSql(password)
    expect(stmt).not.toContain(password)
    expect(stmt).not.toContain("pa''ss")
    expect(stmt).toMatch(
      /^ALTER ROLE liaison_request WITH LOGIN PASSWORD 'SCRAM-SHA-256\$4096:[A-Za-z0-9+/]+=*\$[A-Za-z0-9+/]+=*:[A-Za-z0-9+/]+=*'$/,
    )
    // A fresh salt per statement.
    expect(requestLoginPasswordSql(password)).not.toBe(stmt)
  })

  it("refuses a password whose SCRAM normalisation is not the identity", () => {
    expect(() => requestLoginPasswordSql("")).toThrow()
    expect(() => requestLoginPasswordSql("caf\u00e9")).toThrow(/printable ASCII/)
    expect(() => requestLoginPasswordSql("a\0b")).toThrow()
  })

  it("matches the verifier Postgres itself derives for the same password and salt", async () => {
    const url = process.env.DATABASE_URL_SUPERUSER
    if (!url)
      throw new Error(
        "DATABASE_URL_SUPERUSER is required (run through test-run.ts or with-test-lock.ts)",
      )
    const sql = postgres(url, { max: 1, onnotice: () => {} })
    const role = `scram_probe_${process.pid}`
    try {
      await sql.unsafe(`DROP ROLE IF EXISTS ${role}`)
      await sql.unsafe("SET password_encryption = 'scram-sha-256'")
      await sql.unsafe(`CREATE ROLE ${role} PASSWORD '${password.replaceAll("'", "''")}'`)
      const [row] = await sql<
        { v: string }[]
      >`SELECT rolpassword AS v FROM pg_authid WHERE rolname = ${role}`
      const stored = row?.v ?? ""
      const pgSalt = Buffer.from(stored.split("$")[1]?.split(":")[1] ?? "", "base64")
      expect(pgSalt.length).toBeGreaterThan(0)
      expect(scramSha256Verifier(password, pgSalt)).toBe(stored)
    } finally {
      await sql.unsafe(`DROP ROLE IF EXISTS ${role}`)
      await sql.end()
    }
  })
})

describe("the migration fence", () => {
  // A session advisory lock is only safe on a connection that is ours for the
  // whole session: PgBouncer in transaction mode hands the server connection
  // to other clients between transactions.
  it("is taken when the server answers on the port the URL names", () => {
    expect(migrationConnectionIsDirect("postgres://m:pw@db:5432/liaison", 5432)).toBe(true)
    expect(migrationConnectionIsDirect("postgres://m:pw@db/liaison", 5432)).toBe(true)
  })
  it("is skipped through a pooler (the server's port differs from the URL's)", () => {
    expect(migrationConnectionIsDirect("postgres://m:pw@host:6432/liaison", 5432)).toBe(false)
  })
  it("is skipped when the server's port is unknown (unix socket) or the URL does not parse", () => {
    expect(migrationConnectionIsDirect("postgres://m:pw@db:5432/liaison", null)).toBe(false)
    expect(migrationConnectionIsDirect("not a url", 5432)).toBe(false)
  })
})

describe("policy roles before 0000", () => {
  it("creates every NOLOGIN role 0000's policies name, only when missing", () => {
    const sql = policyRolesSql()
    expect([...POLICY_ROLES]).toEqual(["liaison_rls", "liaison_admin", "liaison_app"])
    for (const role of POLICY_ROLES) {
      expect(sql).toContain(`WHERE rolname = '${role}') THEN`)
      expect(sql).toContain(`CREATE ROLE ${role} NOBYPASSRLS NOLOGIN;`)
    }
    expect(sql.startsWith("DO $$ BEGIN")).toBe(true)
    expect(sql.endsWith("END $$")).toBe(true)
  })

  it("matches what 0000 itself creates, so pre-creating changes nothing", async () => {
    const initial = await Bun.file(new URL("./migrations/0000_initial.sql", import.meta.url)).text()
    for (const role of POLICY_ROLES) {
      expect(initial).toContain(`CREATE ROLE ${role} NOBYPASSRLS NOLOGIN;`)
    }
  })
})

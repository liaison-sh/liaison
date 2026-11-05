// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The test database a run resets, drift-checks and preflights is the one its DB URL env vars
// name, never an assumed `liaison_test`, and a reset of any other database is refused before
// anything is dropped.

import { describe, expect, it } from "bun:test"
import { join } from "node:path"
import { driftTargets } from "./ensure-infra"
import {
  assertResetTarget,
  dbNameFromUrl,
  RESET_EXPECT_DB_VAR,
  resolveTestDb,
  serverBaseUrl,
  stripAutoLoadedDatabaseUrl,
  TestDbTargetError,
} from "./test-db-target"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")
const ENV_TEST = "DATABASE_URL=postgres://liaison_app:liaison_app@localhost:5432/liaison_test\n"
const ROOT_ENV =
  "DATABASE_URL=postgres://liaison_app:liaison_app@localhost:5432/liaison_dev\nNODE_ENV=development\n"
const app = (db: string) => `postgres://liaison_app:liaison_app@localhost:5432/${db}`
const su = (db: string) => `postgres://postgres:postgres@localhost:5432/${db}`

describe("resolveTestDb", () => {
  it("defaults to .env.test's database, then to liaison_test", () => {
    expect(resolveTestDb({ env: {}, envTestText: ENV_TEST }).name).toBe("liaison_test")
    expect(resolveTestDb({ env: {} }).name).toBe("liaison_test")
  })

  it("follows a private database named by every URL variable", () => {
    const env = {
      DATABASE_URL: app("liaison_private_test"),
      E2E_DATABASE_URL: su("liaison_private_test"),
      E2E_SERVER_DATABASE_URL: app("liaison_private_test"),
      DATABASE_URL_SUPERUSER: su("liaison_private_test"),
      MIGRATION_DATABASE_URL_TEST: su("liaison_private_test"),
      E2E_DB_NAME: "liaison_private_test",
    }
    const t = resolveTestDb({ env, envTestText: ENV_TEST, rootEnvText: ROOT_ENV })
    expect(t.name).toBe("liaison_private_test")
    expect(t.sources).toContain("MIGRATION_DATABASE_URL_TEST")
  })

  it("refuses variables that name different databases", () => {
    expect(() =>
      resolveTestDb({
        env: {
          DATABASE_URL: app("liaison_private_test"),
          MIGRATION_DATABASE_URL_TEST: su("liaison_test"),
        },
        envTestText: ENV_TEST,
      }),
    ).toThrow(/more than one database: liaison_private_test \(DATABASE_URL\); liaison_test/)
  })

  it("ignores the root .env DATABASE_URL that bun run auto-loads, and never targets the dev DB", () => {
    expect(
      resolveTestDb({
        env: { DATABASE_URL: app("liaison_dev") },
        envTestText: ENV_TEST,
        rootEnvText: ROOT_ENV,
      }).name,
    ).toBe("liaison_test")
    expect(() =>
      resolveTestDb({ env: { DATABASE_URL: app("liaison_dev") }, envTestText: ENV_TEST }),
    ).toThrow(TestDbTargetError)
  })

  it("refuses a URL that names no database", () => {
    expect(() =>
      resolveTestDb({ env: { E2E_DATABASE_URL: "postgres://postgres@localhost:5432" } }),
    ).toThrow(/E2E_DATABASE_URL does not name a database/)
  })
})

describe("reset guards", () => {
  it("assertResetTarget refuses a database the run is not configured for", () => {
    expect(() => assertResetTarget("liaison_test", "liaison_private_test")).toThrow(
      /refusing to reset liaison_test: the run is configured for liaison_private_test/,
    )
    expect(() => assertResetTarget("liaison_private_test", "liaison_private_test")).not.toThrow()
    expect(() => assertResetTarget("liaison_test", undefined)).not.toThrow()
  })

  it("keeps an explicit DATABASE_URL for test children and strips only the auto-loaded one", () => {
    expect(
      stripAutoLoadedDatabaseUrl({ DATABASE_URL: app("liaison_dev") }, ROOT_ENV).DATABASE_URL,
    ).toBeUndefined()
    expect(
      stripAutoLoadedDatabaseUrl({ DATABASE_URL: app("liaison_private_test") }, ROOT_ENV)
        .DATABASE_URL,
    ).toBe(app("liaison_private_test"))
  })

  it("helpers read names and server bases from URLs", () => {
    expect(dbNameFromUrl(su("liaison_x"))).toBe("liaison_x")
    expect(dbNameFromUrl("postgres://h:5432")).toBeNull()
    expect(serverBaseUrl(su("liaison_x"))).toBe("postgres://postgres:postgres@localhost:5432")
  })
})

describe("schema-drift targets (ensure-infra)", () => {
  it("probes the configured private database, and skips a dev probe pointed at it", () => {
    const t = driftTargets({
      DATABASE_URL: app("liaison_private_test"),
      MIGRATION_DATABASE_URL_TEST: su("liaison_private_test"),
      MIGRATION_DATABASE_URL: su("liaison_private_test"),
    })
    expect(t.test.name).toBe("liaison_private_test")
    expect(t.dev).toBeNull()
  })

  it("refuses a dev probe that names a third database", () => {
    expect(() =>
      driftTargets({
        DATABASE_URL: app("liaison_private_test"),
        MIGRATION_DATABASE_URL: su("liaison_other"),
      }),
    ).toThrow(/refusing to drift-check or reset it/)
  })

  it("keeps the default pair when nothing is overridden", () => {
    const t = driftTargets({ DATABASE_URL: app("liaison_test") })
    expect(t.test.name).toBe("liaison_test")
    expect(t.dev?.name).toBe("liaison_dev")
  })
})

describe("scripts/db-reset.ts test", () => {
  // Both refusals happen before any connection: the names below do not exist.
  function runReset(env: Record<string, string>) {
    const clean: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
    }
    return Bun.spawnSync({
      cmd: ["bun", join(REPO_ROOT, "scripts/db-reset.ts"), "test"],
      cwd: REPO_ROOT,
      env: { ...clean, ...env },
      stdout: "pipe",
      stderr: "pipe",
    })
  }

  it("refuses to reset a database other than the one the caller expects", () => {
    const r = runReset({
      DATABASE_URL: app("liaison_refuse_probe_a"),
      [RESET_EXPECT_DB_VAR]: "liaison_refuse_probe_b",
    })
    expect(r.exitCode).toBe(1)
    expect(r.stderr.toString()).toContain(
      "refusing to reset liaison_refuse_probe_a: the run is configured for liaison_refuse_probe_b",
    )
    expect(r.stdout.toString()).not.toContain("Resetting")
  })

  it("refuses when the DB variables disagree", () => {
    const r = runReset({
      DATABASE_URL: app("liaison_refuse_probe_a"),
      MIGRATION_DATABASE_URL_TEST: su("liaison_refuse_probe_b"),
    })
    expect(r.exitCode).toBe(1)
    expect(r.stderr.toString()).toContain("more than one database")
    expect(r.stdout.toString()).not.toContain("Resetting")
  })
})

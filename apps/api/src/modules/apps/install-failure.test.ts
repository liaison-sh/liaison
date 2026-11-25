// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The setup step's failure report passes on the real cause of an app install
// failure, and tells the operator to raise the app's version only when the
// cause is a version directory holding other files for that version.
import { describe, expect, test } from "bun:test"
import { DrizzleQueryError } from "drizzle-orm/errors"
import {
  describeInstallError,
  type InstallFailure,
  reconcileFailureReport,
} from "~/modules/apps/install-failure"
import { VersionDirConflictError } from "~/modules/apps/version-dir"

const VERSION_ADVICE = /raise that app's version/i

/** A failed CREATE SCHEMA as postgres.js and drizzle hand it to a catch block. */
function permissionDenied(): DrizzleQueryError {
  const pgError = Object.assign(new Error("permission denied for database liaison"), {
    name: "PostgresError",
    code: "42501",
    severity: "ERROR",
  })
  return new DrizzleQueryError('CREATE SCHEMA IF NOT EXISTS "app_fixture"', [], pgError)
}

describe("describeInstallError", () => {
  test("a database error carries its SQLSTATE and the database's message", () => {
    const d = describeInstallError(permissionDenied())
    expect(d.kind).toBe("database")
    expect(d.error).toContain("42501")
    expect(d.error).toContain("permission denied for database liaison")
    expect(d.error).toContain('CREATE SCHEMA IF NOT EXISTS "app_fixture"')
  })

  test("a version directory holding other files is a version conflict", () => {
    const d = describeInstallError(
      new VersionDirConflictError("Cannot install 'fixture' 1.0.0: already holds different files"),
    )
    expect(d.kind).toBe("version_conflict")
    expect(d.error).toContain("already holds different files")
  })

  test("any other error keeps its own message", () => {
    expect(describeInstallError(new Error("tarball missing"))).toEqual({
      kind: "other",
      error: "tarball missing",
    })
  })
})

describe("reconcileFailureReport", () => {
  test("a database failure names the cause and gives no version advice", () => {
    const failed: InstallFailure[] = [
      { name: "fixture", version: "2.1.2", ...describeInstallError(permissionDenied()) },
    ]
    const text = reconcileFailureReport({ failed, derivationsOk: true }).join("\n")
    expect(text).toContain("fixture 2.1.2")
    expect(text).toContain("42501")
    expect(text).toContain("permission denied for database liaison")
    expect(text).not.toMatch(VERSION_ADVICE)
  })

  test("a version conflict gets the version advice, naming the app", () => {
    const failed: InstallFailure[] = [
      {
        name: "fixture",
        version: "1.0.0",
        ...describeInstallError(new VersionDirConflictError("already holds different files")),
      },
    ]
    const lines = reconcileFailureReport({ failed, derivationsOk: true })
    const advice = lines.find((l) => VERSION_ADVICE.test(l))
    expect(advice).toContain("fixture")
  })

  test("a reconcile that threw on the database reports that cause, no version advice", () => {
    const text = reconcileFailureReport({
      failed: [],
      derivationsOk: false,
      threw: describeInstallError(permissionDenied()),
    }).join("\n")
    expect(text).toContain("permission denied for database liaison")
    expect(text).not.toMatch(VERSION_ADVICE)
  })

  test("derivations not applied alone are reported without version advice", () => {
    const text = reconcileFailureReport({ failed: [], derivationsOk: false }).join("\n")
    expect(text).toContain("files SELECT policy")
    expect(text).not.toMatch(VERSION_ADVICE)
  })
})

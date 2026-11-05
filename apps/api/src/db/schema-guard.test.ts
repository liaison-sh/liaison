// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import postgres from "postgres"
import { runMigrations } from "~/db/migrate"
import {
  appliedHighwater,
  assertImageNotOlderThanSchema,
  imageMigrationHead,
  OLDER_IMAGE_DOCS,
  olderImageMessage,
  olderImagePolicy,
} from "~/db/schema-guard"

/** A migrations folder whose journal stops at `when`: what an older image carries. */
function folderAt(root: string, name: string, when: number): string {
  const dir = join(root, name)
  mkdirSync(join(dir, "meta"), { recursive: true })
  writeFileSync(
    join(dir, "meta", "_journal.json"),
    JSON.stringify({
      entries: [{ idx: 0, version: "7", when, tag: "0000_old", breakpoints: true }],
    }),
  )
  return dir
}

describe("olderImagePolicy", () => {
  it("production refuses unless the operator allows it; elsewhere it warns", () => {
    expect(olderImagePolicy("production", undefined)).toBe("refuse")
    expect(olderImagePolicy("production", "false")).toBe("refuse")
    expect(olderImagePolicy("production", "true")).toBe("warn")
    expect(olderImagePolicy("development", undefined)).toBe("warn")
    expect(olderImagePolicy("test", undefined)).toBe("warn")
  })
})

describe("olderImageMessage", () => {
  it("says what happened, what to do and where the docs are", () => {
    const message = olderImageMessage(1900, { tag: "0100_x", when: 1800 })
    expect(message).toContain("older than the database schema")
    expect(message).toContain("0100_x")
    expect(message).toContain("LIAISON_IMAGE")
    expect(message).toContain("restore a backup")
    expect(message).toContain(OLDER_IMAGE_DOCS)
    expect(message).toContain("LIAISON_ALLOW_OLDER_IMAGE=true")
  })
})

describe("the real journal", () => {
  it("has a head the guard can read", () => {
    const head = imageMigrationHead(new URL("./migrations", import.meta.url).pathname)
    expect(head?.when).toBeGreaterThan(0)
    expect(head?.tag).toMatch(/^\d{4}_/)
  })
})

describe("against the migrated test database", () => {
  const root = mkdtempSync(join(tmpdir(), "schema-guard-"))
  const url = process.env.DATABASE_URL_SUPERUSER
  if (!url) throw new Error("DATABASE_URL_SUPERUSER is required (run through with-test-lock.ts)")
  const sql = postgres(url, { max: 1, onnotice: () => {} })
  let applied = 0

  beforeAll(async () => {
    applied = (await appliedHighwater(sql)) ?? 0
    expect(applied).toBeGreaterThan(0)
  })

  afterAll(async () => {
    await sql.end()
    rmSync(root, { recursive: true, force: true })
  })

  it("refuses an image whose newest migration is older than the ledger's", async () => {
    const older = folderAt(root, "older", applied - 1)
    await expect(assertImageNotOlderThanSchema(sql, older, "refuse")).rejects.toThrow(
      OLDER_IMAGE_DOCS,
    )
  })

  it("passes an image at or above the ledger", async () => {
    await assertImageNotOlderThanSchema(sql, folderAt(root, "same", applied), "refuse")
    await assertImageNotOlderThanSchema(sql, folderAt(root, "newer", applied + 1), "refuse")
  })

  it("warns instead when the policy is warn", async () => {
    const lines: string[] = []
    await assertImageNotOlderThanSchema(sql, folderAt(root, "warned", applied - 1), "warn", (l) =>
      lines.push(l),
    )
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("WARNING")
  })

  it("the migration step stops on it, and applies nothing", async () => {
    await expect(
      runMigrations(url, {
        migrationsFolder: folderAt(root, "step", applied - 1),
        olderImage: "refuse",
      }),
    ).rejects.toThrow("older than the database schema")
    expect(await appliedHighwater(sql)).toBe(applied)
  })

  it("a database with no ledger is new, not newer", async () => {
    const db = `schema_guard_empty_${process.pid}`
    await sql.unsafe(`CREATE DATABASE ${db}`)
    const emptyUrl = new URL(url)
    emptyUrl.pathname = `/${db}`
    const empty = postgres(emptyUrl.toString(), { max: 1, onnotice: () => {} })
    try {
      expect(await appliedHighwater(empty)).toBeNull()
      await assertImageNotOlderThanSchema(empty, folderAt(root, "fresh", 1), "refuse")
    } finally {
      await empty.end()
      await sql.unsafe(`DROP DATABASE ${db}`)
    }
  })
})

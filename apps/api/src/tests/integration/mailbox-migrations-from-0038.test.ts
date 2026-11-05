// SPDX-License-Identifier: FSL-1.1-ALv2
//
// L13 (e2e plan section 5): every mailbox migration actually APPLIES to a
// database that already carries `0038_home_card_layout`.
//
// The bug this pins: drizzle applies a migration only when its journal `when`
// is greater than the high-water mark already in `drizzle.__drizzle_migrations`.
// The mailbox migrations were numbered 0032..0041 and originally carried `when`
// values BELOW 0038's, so on a database that already had 0038 (every deployed
// one) they would have been silently SKIPPED: no `kernel.user_mailbox_identities`,
// no ciphertext columns, no Invariant P trigger, and no error either.
//
// Why this is not a lint. Reading `_journal.json` and asserting the numbers
// ascend proves the file looks right. This proves the migrations RUN: it brings
// a scratch database to the 0038 high-water with the REAL migrator over a
// journal truncated at 0038, then runs the REAL migrator over the full journal,
// then asserts the objects exist.
//
// It owns a scratch DATABASE (not a schema): the migration SQL names `kernel`
// and `app_mail` literally, so a schema prefix cannot isolate it.

import { afterAll, beforeAll, expect, test } from "bun:test"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { drizzle } from "drizzle-orm/postgres-js"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import postgres from "postgres"

const ADMIN_URL =
  process.env.E2E_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/liaison_test"
const MIGRATIONS = resolve(import.meta.dir, "../../db/migrations")
const HIGH_WATER_TAG = "0038_home_card_layout"

const dbName = `mailbox_mig_${Math.random().toString(36).slice(2, 10)}`
const scratchUrl = new URL(ADMIN_URL)
scratchUrl.pathname = `/${dbName}`

let admin: postgres.Sql
let scratch: postgres.Sql
let tmpRoot: string

interface JournalEntry {
  idx: number
  version: string
  when: number
  tag: string
  breakpoints: boolean
}

/** A copy of the migrations folder whose journal stops at `tag`. */
function truncatedMigrationsFolder(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), "mailbox-mig-"))
  cpSync(MIGRATIONS, dir, { recursive: true })
  const journalPath = join(dir, "meta", "_journal.json")
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: JournalEntry[]
    [key: string]: unknown
  }
  const cut = journal.entries.findIndex((entry) => entry.tag === tag)
  expect(cut, `${tag} is not in the journal`).toBeGreaterThanOrEqual(0)
  journal.entries = journal.entries.slice(0, cut + 1)
  writeFileSync(journalPath, JSON.stringify(journal, null, 2))
  return dir
}

beforeAll(async () => {
  admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} })
  await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}"`)
  await admin.unsafe(`CREATE DATABASE "${dbName}"`)
  scratch = postgres(scratchUrl.toString(), { max: 1, onnotice: () => {} })
  tmpRoot = truncatedMigrationsFolder(HIGH_WATER_TAG)
}, 120_000)

afterAll(async () => {
  await scratch?.end()
  await admin?.unsafe(`DROP DATABASE IF EXISTS "${dbName}"`)
  await admin?.end()
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true })
})

async function ledgerCount(): Promise<number> {
  const rows = await scratch.unsafe(`SELECT count(*)::int AS n FROM drizzle."__drizzle_migrations"`)
  return Number((rows[0] as unknown as { n: number }).n)
}

async function objectExists(sql: string, params: unknown[] = []): Promise<boolean> {
  const rows = await scratch.unsafe(sql, params as never[])
  return rows.length > 0
}

test("L13: every mailbox migration applies to a database that already has 0038", async () => {
  // 1. Bring the scratch database to the 0038 high-water with the REAL migrator.
  await migrate(drizzle(scratch), { migrationsFolder: tmpRoot })
  const atHighWater = await ledgerCount()
  expect(atHighWater, "the truncated run applied nothing").toBeGreaterThan(0)

  // Non-vacuity: the mailbox objects must NOT exist yet, or the assertions
  // below would pass without the migrations under test ever running.
  expect(
    await objectExists(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = 'kernel' AND table_name = 'user_mailbox_identities'`,
    ),
    "the 0038 baseline already carries the mailbox tables",
  ).toBe(false)

  // 2. The real migrator over the FULL journal.
  await migrate(drizzle(scratch), { migrationsFolder: MIGRATIONS })
  const afterAll = await ledgerCount()
  const fullJournal = JSON.parse(
    readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8"),
  ) as { entries: JournalEntry[] }
  expect(afterAll, "the ledger did not gain one row per remaining migration").toBe(
    fullJournal.entries.length,
  )
  expect(afterAll - atHighWater, "no migration ran after 0038").toBeGreaterThan(0)

  // 3. The objects the feature needs, one by one.
  for (const table of [
    "user_mailbox_identities",
    "user_key_wraps",
    "mailbox_migration_state",
    "mailbox_client_jobs",
  ]) {
    expect(
      await objectExists(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = 'kernel' AND table_name = $1`,
        [table],
      ),
      `kernel.${table} is missing`,
    ).toBe(true)
  }

  // NOT asserted here, on purpose: the `app_mail` ciphertext COLUMNS and the
  // Invariant P trigger are created by the mail app's manifest DDL when the app
  // registers, not by the journal. `0032` and `0034` are guarded with
  // `to_regclass('app_mail.messages') IS NULL THEN RETURN`, so on a database
  // with no mail app installed they are correct no-ops. Their real coverage is
  // L2 and L10, which run against an installed app: L2 asserts a sealed insert
  // and L10 seals, sweeps and purges 260 rows. What THIS test owns is the
  // kernel half, which is exactly the half the ledger high-water would have
  // skipped.

  // The wrapped private halves (0041) and the purge witness (0042).
  expect(
    await objectExists(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'kernel' AND table_name = 'user_mailbox_identities'
          AND column_name = 'wrapped_ecdh_private'`,
    ),
    "0041 wrapped private halves are missing",
  ).toBe(true)
  expect(
    await objectExists(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'kernel' AND table_name = 'mailbox_migration_state'
          AND column_name = 'plaintext_purge_ran_at'`,
    ),
    "0042 purge witness column is missing",
  ).toBe(true)

  // `kernel.files` encryption columns (0039).
  for (const column of ["enc_version", "content_key_wrapped", "content_key_epk"]) {
    expect(
      await objectExists(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'kernel' AND table_name = 'files' AND column_name = $1`,
        [column],
      ),
      `kernel.files.${column} is missing`,
    ).toBe(true)
  }

  // The migration-owned half of Invariant P: the helper functions 0034 installs.
  for (const fn of ["mailbox_invariant_armed", "mailbox_account_exists"]) {
    expect(
      await objectExists(
        `SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'app_mail' AND p.proname = $1`,
        [fn],
      ),
      `app_mail.${fn}() is missing`,
    ).toBe(true)
  }
}, 300_000)

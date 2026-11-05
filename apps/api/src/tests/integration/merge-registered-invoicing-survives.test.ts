// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `merge.test.ts` fakes `app_invoicing.documents` and used to clean up with an
// unconditional `DROP SCHEMA app_invoicing CASCADE` in `afterAll`. That drops
// the REGISTERED invoicing schema when the database has one, taking its
// `issuer_profiles`, its constraints and its data with it, and every later file
// in the same `bun test` process that needs the real schema then fails on a
// relation that existed before this file ran. A fixture may only remove what it
// created.
//
// This drives the real ordering. It puts a registered-shape `app_invoicing` in
// place (issuer_profiles plus a documents table whose NOT NULL
// `issuer_profile_id` references it, the shape the invoicing manifest declares),
// then runs ONE `bun test` process over `merge.test.ts` followed by a file that
// needs that schema.
//
// Fails-without-fix: the second file dies with `relation
// "app_invoicing.issuer_profiles" does not exist`. Passes-with-fix: merge.test.ts
// renames the registered schema aside for its own lifetime and renames it back,
// so the second file sees exactly what was there before.
//
// It lives HERE, and not beside `merge.test.ts` under `src/modules/contacts`,
// because it spawns a nested `bun test` over that file plus a probe: under the
// unit suite, which selects `src/modules` whole, the parent process runs
// `merge.test.ts` too and the two processes fight over the same fixture.
// `integration-extra` runs in its own process for exactly this reason.

import { afterAll, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { sql } from "~/db"
import {
  inheritedFixtureLockEnv,
  releaseAppSchema,
  takeOverAppSchema,
} from "~/tests/helpers/app-schema-fixture"

const MERGE_FILE = "src/modules/contacts/merge.test.ts"

// The probe lives outside `src/`, so it is in no suite and no routing guard
// sees it; the driver writes it, runs it in the child, and removes it. It talks
// to Postgres directly rather than through `~/db` because nothing outside
// `src/` resolves that alias.
const PROBE_SOURCE = `// SPDX-License-Identifier: FSL-1.1-ALv2
import { expect, test } from "bun:test"
import postgres from "postgres"

test("the registered invoicing schema is still there after merge.test.ts ran", async () => {
  const sql = postgres(process.env.DATABASE_URL as string)
  try {
    const profiles = await sql\`SELECT to_regclass('app_invoicing.issuer_profiles') AS t\`
    expect(profiles[0].t).not.toBeNull()
    const column = await sql\`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = 'app_invoicing' AND table_name = 'documents'
        AND column_name = 'issuer_profile_id'\`
    expect(column.length).toBe(1)
    expect(column[0].is_nullable).toBe("NO")
  } finally {
    await sql.end()
  }
})
`

let probeDir: string | undefined

// No `acquireAppSchemaLock` here: the child process takes that same Postgres
// advisory lock, so holding it across the spawn would deadlock on ourselves.
afterAll(async () => {
  if (probeDir) rmSync(probeDir, { recursive: true, force: true })
  await releaseAppSchema("app_invoicing")
})

describe("merge.test.ts leaves a registered app_invoicing schema alone", () => {
  it("lets a later file in the same bun process still use it", async () => {
    await takeOverAppSchema("app_invoicing")
    await sql.unsafe(
      `GRANT USAGE ON SCHEMA app_invoicing TO liaison_rls, liaison_app, liaison_admin`,
    )
    await sql.unsafe(`
      CREATE TABLE app_invoicing.issuer_profiles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id UUID NOT NULL,
        legal_name TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `)
    await sql.unsafe(`
      CREATE TABLE app_invoicing.documents (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id UUID NOT NULL,
        issuer_profile_id UUID NOT NULL REFERENCES app_invoicing.issuer_profiles (id) ON DELETE RESTRICT,
        counterparty_contact_id UUID,
        issued_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `)
    await sql.unsafe(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON app_invoicing.issuer_profiles, app_invoicing.documents TO liaison_rls, liaison_app, liaison_admin`,
    )

    probeDir = mkdtempSync(path.join(process.cwd(), "tmp-fx11-probe-"))
    mkdirSync(probeDir, { recursive: true })
    const probeFile = path.join(probeDir, "registered-invoicing.test.ts")
    writeFileSync(probeFile, PROBE_SOURCE)
    const probeRelative = path.relative(process.cwd(), probeFile)

    const child = Bun.spawn(
      ["bun", "test", "--timeout", "120000", MERGE_FILE, `./${probeRelative}`],
      {
        cwd: process.cwd(),
        // The child takes the same schemas over: it inherits the ownership
        // locks this file holds instead of queueing on them.
        // Only app_invoicing: it is the one schema this file takes over, so it is the
        // one lock it holds and the only one the child may inherit.
        env: { ...process.env, ...inheritedFixtureLockEnv(["app_invoicing"]) },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    const combined = `${err}\n${out}`
    // Both files really ran in the one process: an empty child run, or one where
    // the probe was never discovered, must never read as a pass.
    expect(combined).toContain("across 2 files")
    if (code !== 0) {
      throw new Error(
        `child "bun test ${MERGE_FILE} ${probeRelative}" exited ${code}\n${err.slice(-2500)}\n${out.slice(-1500)}`,
      )
    }
    expect(code).toBe(0)
  }, 180_000)
})

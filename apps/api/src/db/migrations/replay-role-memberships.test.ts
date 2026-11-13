// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A test that replays migrations on a scratch database runs their role
// statements on the whole cluster. The request login split takes back every
// membership of the request login but one, on every database of the server, so
// a replay used to strip what other checkouts' later migrations had granted.
// `keepClusterRoleMemberships` (test-support/role-memberships.ts) gives it back;
// every test that replays migrations takes it around its run.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import postgres from "postgres"
import { runMigrations } from "~/db/migrate"
import { withRoleCatalogLock } from "~/tests/helpers/role-catalog-lock"
import {
  keepClusterRoleMemberships,
  listRoleMemberships,
} from "../../../test-support/role-memberships"

const SPLIT_TAG = "0178_request_login_split"

function superuserUrl(): string {
  if (process.env.MIGRATION_DATABASE_URL) return process.env.MIGRATION_DATABASE_URL
  const base = process.env.DB_RESET_SUPERUSER_URL ?? "postgres://postgres:postgres@localhost:5432"
  const dbName = new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, "")
  return `${base.replace(/\/$/, "")}/${dbName}`
}

const suffix = randomBytes(5).toString("hex")
const dbName = `liaison_mig_roles_${suffix}`
const extraRole = `liaison_mig_roles_extra_${suffix}`
const adminUrl = new URL(superuserUrl())
const scratchUrl = new URL(adminUrl)
scratchUrl.pathname = `/${dbName}`

/** A copy of the migrations folder whose journal ends at `tag`. */
function folderUpTo(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), "mig-roles-"))
  cpSync(import.meta.dir, dir, { recursive: true })
  const path = join(dir, "meta", "_journal.json")
  const journal = JSON.parse(readFileSync(path, "utf8")) as { entries: { tag: string }[] }
  const at = journal.entries.findIndex((e) => e.tag === tag)
  if (at < 0) throw new Error(`${tag} is not in the journal`)
  journal.entries = journal.entries.slice(0, at + 1)
  writeFileSync(path, JSON.stringify(journal, null, 2))
  return dir
}

let admin: postgres.Sql
let folder = ""
let restore: (() => Promise<unknown>) | null = null

const holdsExtra = async (): Promise<boolean> =>
  (await listRoleMemberships(admin)).some(
    (m) => m.role === extraRole && m.member === "liaison_request",
  )

beforeAll(async () => {
  admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} })
  folder = folderUpTo(SPLIT_TAG)
}, 60_000)

afterAll(async () => {
  if (admin) {
    // Whatever an assertion did, the shared roles get their memberships back.
    await restore?.()
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`)
    const held = await listRoleMemberships(admin)
    for (const m of held.filter((h) => h.role === extraRole)) {
      await admin.unsafe(`REVOKE "${m.role}" FROM "${m.member}" GRANTED BY "${m.grantor}" CASCADE`)
    }
    await admin.unsafe(`DROP ROLE IF EXISTS "${extraRole}"`)
    await admin.end()
  }
  if (folder) rmSync(folder, { recursive: true, force: true })
})

describe("replaying migrations on a shared cluster", () => {
  test("the request login split takes back an extra membership cluster wide, and the restore gives it back", async () => {
    // The request login exists before the replay on any migrated cluster; the
    // extra role stands for one a later migration gives it.
    await admin.unsafe(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'liaison_request') THEN
        CREATE ROLE liaison_request NOLOGIN;
      END IF;
    END $$`)
    await admin.unsafe(`CREATE ROLE "${extraRole}" NOLOGIN`)
    await admin.unsafe(`GRANT "${extraRole}" TO liaison_request`)
    const keep = await keepClusterRoleMemberships(admin)
    restore = keep

    await admin.unsafe(`CREATE DATABASE "${dbName}"`)
    await withRoleCatalogLock(scratchUrl, () =>
      runMigrations(scratchUrl.toString(), { log: () => {}, migrationsFolder: folder }),
    )
    // The replay ran on a scratch database, and still reached the shared role.
    expect(await holdsExtra()).toBe(false)

    const restored = await keep()
    expect(restored.map((m) => [m.role, m.member])).toContainEqual([extraRole, "liaison_request"])
    expect(await holdsExtra()).toBe(true)
  }, 300_000)
})

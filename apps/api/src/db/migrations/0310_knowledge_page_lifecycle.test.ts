// SPDX-License-Identifier: FSL-1.1-ALv2
//
// 0310 runs for a migration login that is neither a superuser nor BYPASSRLS and owns
// the schemas, tables and functions, as a self-hosted install that ran its own
// migrations has it (see 0283). The file never switches role and never hands an
// object to a runtime role, so nothing in it needs a right that login lacks.
//
// A scratch database is migrated by the superuser up to the file before 0310, handed
// to the login, and 0310 is applied by the login; its statements are then replayed by
// the login once more (each is re-runnable).

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import postgres from "postgres"
import { runMigrations } from "~/db/migrate"
import { withRoleCatalogLock } from "~/tests/helpers/role-catalog-lock"
import { keepClusterRoleMemberships } from "../../../test-support/role-memberships"

const MIGRATIONS = import.meta.dir
const TAG = "0310_knowledge_page_lifecycle"

function superuserUrl(): string {
  if (process.env.MIGRATION_DATABASE_URL) return process.env.MIGRATION_DATABASE_URL
  const base = process.env.DB_RESET_SUPERUSER_URL ?? "postgres://postgres:postgres@localhost:5432"
  const dbName = new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, "")
  return `${base.replace(/\/$/, "")}/${dbName}`
}

const suffix = randomBytes(5).toString("hex")
const dbName = `liaison_mig_0310_${suffix}`
const login = `liaison_mig_0310_login_${suffix}`
const password = randomBytes(12).toString("hex")

const adminUrl = new URL(superuserUrl())
const asSuperuser = new URL(adminUrl)
asSuperuser.pathname = `/${dbName}`
const asLoginUrl = new URL(asSuperuser)
asLoginUrl.username = login
asLoginUrl.password = password

/** A copy of the migrations folder whose journal ends at `TAG` + `offset`. */
function folderUpTo(offset: number): string {
  const dir = mkdtempSync(join(tmpdir(), "mig-0310-"))
  cpSync(MIGRATIONS, dir, { recursive: true })
  const path = join(dir, "meta", "_journal.json")
  const journal = JSON.parse(readFileSync(path, "utf8")) as { entries: { tag: string }[] }
  const at = journal.entries.findIndex((e) => e.tag === TAG)
  if (at < 0) throw new Error(`${TAG} is not in the journal`)
  journal.entries = journal.entries.slice(0, at + offset + 1)
  writeFileSync(path, JSON.stringify(journal, null, 2))
  return dir
}

let admin: postgres.Sql
let fresh: postgres.Sql
let asLogin: postgres.Sql
const folders: string[] = []
let restoreRoleMemberships: (() => Promise<unknown>) | null = null

beforeAll(async () => {
  admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} })
  restoreRoleMemberships = await keepClusterRoleMemberships(admin)
  await admin.unsafe(`CREATE DATABASE "${dbName}"`)
  const before = folderUpTo(-1)
  folders.push(before)
  await withRoleCatalogLock(adminUrl, () =>
    runMigrations(asSuperuser.toString(), { migrationsFolder: before }),
  )
  fresh = postgres(asSuperuser.toString(), { max: 1, onnotice: () => {} })
  await admin.unsafe(
    `CREATE ROLE "${login}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB`,
  )
  await admin.unsafe(
    `GRANT liaison_admin, liaison_rls, liaison_schema_admin, liaison_definer TO "${login}"`,
  )
  await admin.unsafe(`ALTER DATABASE "${dbName}" OWNER TO "${login}"`)
  // As the login would stand had it run every migration itself: owner of the schemas,
  // tables and the functions it created (those given to a runtime role stay theirs).
  await fresh.unsafe(`DO $$
    DECLARE r record;
    BEGIN
      FOR r IN SELECT nspname FROM pg_namespace
                WHERE nspname = 'kernel' OR nspname = 'drizzle' OR nspname LIKE 'app\\_%' LOOP
        EXECUTE format('ALTER SCHEMA %I OWNER TO "${login}"', r.nspname);
      END LOOP;
      FOR r IN SELECT n.nspname, c.relname FROM pg_class c
                 JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE c.relkind IN ('r', 'p')
                  AND (n.nspname = 'kernel' OR n.nspname = 'drizzle' OR n.nspname LIKE 'app\\_%') LOOP
        EXECUTE format('ALTER TABLE %I.%I OWNER TO "${login}"', r.nspname, r.relname);
      END LOOP;
      FOR r IN SELECT p.oid::regprocedure AS fn FROM pg_proc p
                 JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE p.proowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
                  AND (n.nspname = 'kernel' OR n.nspname LIKE 'app\\_%') LOOP
        EXECUTE format('ALTER FUNCTION %s OWNER TO "${login}"', r.fn);
      END LOOP;
    END $$`)
  asLogin = postgres(asLoginUrl.toString(), { max: 1, onnotice: () => {} })
  const withFile = folderUpTo(0)
  folders.push(withFile)
  await withRoleCatalogLock(adminUrl, () =>
    runMigrations(asLoginUrl.toString(), { migrationsFolder: withFile }),
  )
}, 300_000)

afterAll(async () => {
  await asLogin?.end()
  await fresh?.end()
  if (admin) {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`)
    const held = await admin<{ role: string; member: string; grantor: string }[]>`
      SELECT r.rolname AS role, u.rolname AS member, g.rolname AS grantor
        FROM pg_auth_members a
        JOIN pg_roles r ON r.oid = a.roleid
        JOIN pg_roles u ON u.oid = a.member
        JOIN pg_roles g ON g.oid = a.grantor
       WHERE u.rolname = ${login} OR g.rolname = ${login}`
    for (const m of held) {
      await admin.unsafe(`REVOKE "${m.role}" FROM "${m.member}" GRANTED BY "${m.grantor}" CASCADE`)
    }
    await admin.unsafe(`DROP ROLE IF EXISTS "${login}"`)
    await restoreRoleMemberships?.()
    await admin.end()
  }
  for (const dir of folders) rmSync(dir, { recursive: true, force: true })
})

describe("0310 by a non-superuser login that owns the schemas", () => {
  test("the login is neither a superuser nor BYPASSRLS", async () => {
    const [who] = await asLogin<{ super: boolean; bypass: boolean }[]>`
      SELECT rolsuper AS super, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`
    expect(who).toEqual({ super: false, bypass: false })
  })

  test("the tables, columns, trigger, function and policies are there", async () => {
    const [shape] = await fresh<
      {
        versions: string | null
        links: string | null
        columns: number
        index_col: number
        trigger: number
        can_edit: string | null
        policies: number
        forced: number
      }[]
    >`
      SELECT to_regclass('app_knowledge.document_versions')::text AS versions,
             to_regclass('app_knowledge.document_links')::text AS links,
             (SELECT count(*)::int FROM information_schema.columns
               WHERE table_schema = 'app_knowledge' AND table_name = 'documents'
                 AND column_name IN ('trashed_at', 'trashed_by', 'update_event_at',
                                     'update_event_pending_at', 'links_indexed_at')) AS columns,
             (SELECT count(*)::int FROM information_schema.columns
               WHERE table_schema = 'app_knowledge' AND table_name = 'collections'
                 AND column_name = 'index_document_id') AS index_col,
             (SELECT count(*)::int FROM pg_trigger WHERE tgname = 'documents_trash_guard') AS trigger,
             to_regprocedure('app_knowledge.can_edit_document(uuid)')::text AS can_edit,
             (SELECT count(*)::int FROM pg_policies WHERE schemaname = 'app_knowledge'
               AND tablename IN ('document_versions', 'document_links')) AS policies,
             (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = 'app_knowledge' AND c.relname IN ('document_versions', 'document_links')
                 AND c.relrowsecurity AND c.relforcerowsecurity) AS forced`
    expect(shape).toEqual({
      versions: "app_knowledge.document_versions",
      links: "app_knowledge.document_links",
      columns: 5,
      index_col: 1,
      trigger: 1,
      can_edit: "app_knowledge.can_edit_document(uuid)",
      policies: 8,
      forced: 2,
    })
  })

  test("the runtime roles hold their rights on the new tables and the function", async () => {
    const rows = await fresh<{ role: string; versions: boolean; links: boolean; fn: boolean }[]>`
      SELECT r AS role,
             has_table_privilege(r, 'app_knowledge.document_versions', 'SELECT,INSERT,UPDATE,DELETE') AS versions,
             has_table_privilege(r, 'app_knowledge.document_links', 'SELECT,INSERT,UPDATE,DELETE') AS links,
             has_function_privilege(r, 'app_knowledge.can_edit_document(uuid)', 'EXECUTE') AS fn
        FROM unnest(ARRAY['liaison_rls', 'liaison_app', 'liaison_admin']) AS r ORDER BY r`
    for (const row of rows)
      expect(row).toEqual({ role: row.role, versions: true, links: true, fn: true })
    expect(rows.length).toBe(3)
  })

  test("every statement runs again for the login", async () => {
    const text = readFileSync(join(MIGRATIONS, `${TAG}.sql`), "utf8")
    await asLogin.begin(async (tx) => {
      for (const statement of text.split("--> statement-breakpoint")) await tx.unsafe(statement)
    })
  })
})

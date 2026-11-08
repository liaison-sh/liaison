// SPDX-License-Identifier: FSL-1.1-ALv2
//
// 0283: the seeds that read nothing when the migration login is not a
// superuser. The tables they read force row-level security and their policies
// name the runtime roles only, so a login without superuser or BYPASSRLS (a
// database owner) sees no row: 0254's INSERT ... SELECT granted no
// kernel:products scope, 0133/0134 no mcp_manager scope, 0119 deleted nothing,
// and each migration still succeeded.
//
// A scratch DATABASE is migrated by the superuser up to the file before 0254,
// given people, roles and grants, then handed to a login that owns its schemas
// and tables and is a member of the runtime roles, with neither superuser nor
// BYPASSRLS. That login runs 0254 and then 0283; the grants 0254 and the
// others meant to seed must be there afterwards. Without 0283 they are not.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import postgres from "postgres"
import { runMigrations } from "~/db/migrate"

const MIGRATIONS = import.meta.dir
const FIRST_LOGIN_TAG = "0254_product_attributes"
const FIX_TAG = "0283_reapply_seeds_as_admin"

function superuserUrl(): string {
  if (process.env.MIGRATION_DATABASE_URL) return process.env.MIGRATION_DATABASE_URL
  const base = process.env.DB_RESET_SUPERUSER_URL ?? "postgres://postgres:postgres@localhost:5432"
  const dbName = new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, "")
  return `${base.replace(/\/$/, "")}/${dbName}`
}

const suffix = randomBytes(5).toString("hex")
const dbName = `liaison_mig_seeds_${suffix}`
const login = `liaison_mig_seeds_login_${suffix}`
const password = randomBytes(12).toString("hex")

const adminUrl = new URL(superuserUrl())
const freshAsSuperuser = new URL(adminUrl)
freshAsSuperuser.pathname = `/${dbName}`
const freshAsLogin = new URL(freshAsSuperuser)
freshAsLogin.username = login
freshAsLogin.password = password

const ORG = crypto.randomUUID()
const USER = crypto.randomUUID()
const MEMBER_ROLE = crypto.randomUUID()
const REVOKED_ROLE = crypto.randomUUID()
const APP_ROLE = crypto.randomUUID()
const THREAD = crypto.randomUUID()
const AGENT_REPLY = crypto.randomUUID()
const AGENT = crypto.randomUUID()

/** A copy of the migrations folder whose journal ends at `index + offset`. */
function folderUpTo(tag: string, offset: number): string {
  const dir = mkdtempSync(join(tmpdir(), "mig-seeds-"))
  cpSync(MIGRATIONS, dir, { recursive: true })
  const path = join(dir, "meta", "_journal.json")
  const journal = JSON.parse(readFileSync(path, "utf8")) as { entries: { tag: string }[] }
  const at = journal.entries.findIndex((e) => e.tag === tag)
  if (at < 0) throw new Error(`${tag} is not in the journal`)
  journal.entries = journal.entries.slice(0, at + offset + 1)
  writeFileSync(path, JSON.stringify(journal, null, 2))
  return dir
}

let admin: postgres.Sql
let fresh: postgres.Sql
let asLogin: postgres.Sql
const folders: string[] = []
let versionBefore = 0

beforeAll(async () => {
  admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} })
  await admin.unsafe(`CREATE DATABASE "${dbName}"`)
  const before = folderUpTo(FIRST_LOGIN_TAG, -1)
  folders.push(before)
  await runMigrations(freshAsSuperuser.toString(), { migrationsFolder: before })

  fresh = postgres(freshAsSuperuser.toString(), { max: 1, onnotice: () => {} })
  await fresh.unsafe(`
    INSERT INTO kernel.organizations (id, name, slug) VALUES ('${ORG}', 'Existing', 'existing');
    INSERT INTO kernel.users (id, org_id, email, name) VALUES ('${USER}', '${ORG}', 'a@example.com', 'A');
    INSERT INTO kernel.apps (org_id, name, version) VALUES ('${ORG}', 'mcp-manager', '1.0.0');
    INSERT INTO kernel.roles (id, org_id, name) VALUES
      ('${MEMBER_ROLE}', '${ORG}', 'Member'),
      ('${REVOKED_ROLE}', '${ORG}', 'Reader'),
      ('${APP_ROLE}', '${ORG}', 'mcp-manager.user');
    INSERT INTO kernel.role_scope_grants (role_id, scope) VALUES
      ('${MEMBER_ROLE}', 'kernel:contacts:read'),
      ('${MEMBER_ROLE}', 'kernel:contacts:write'),
      ('${MEMBER_ROLE}', 'kernel:threads:write'),
      ('${REVOKED_ROLE}', 'kernel:contacts:read'),
      ('${APP_ROLE}', 'kernel:contacts:read');
    INSERT INTO kernel.user_roles (org_id, user_id, role_id) VALUES ('${ORG}', '${USER}', '${MEMBER_ROLE}');
    INSERT INTO kernel.role_dimension_grants (role_id, dimension_key, dimension_values)
      VALUES ('${MEMBER_ROLE}', 'mail:sensitivity', '["*"]');
    INSERT INTO kernel.audit_log (org_id, actor_type, entity_type, entity_id, action, changes)
      VALUES ('${ORG}', 'user', 'role_scope', '${REVOKED_ROLE}', 'role_scope.revoke',
              '{"roleId": "${REVOKED_ROLE}", "scope": "kernel:products:read"}');
    INSERT INTO kernel.threads (id, org_id, handle, created_by) VALUES ('${THREAD}', '${ORG}', 'seeds', '${USER}');
    INSERT INTO kernel.agents (id, org_id, kind, handle, display_name)
      VALUES ('${AGENT}', '${ORG}', 'role', 'support', 'Support');
    INSERT INTO kernel.messages
      (id, org_id, thread_id, author_id, author_type, author_agent_id, content, required_scopes)
      VALUES ('${AGENT_REPLY}', '${ORG}', '${THREAD}', '${USER}', 'agent', '${AGENT}', 'reply',
              ARRAY['*', 'kernel:threads:read']);
  `)
  const [v] = await fresh<{ v: number }[]>`
    SELECT permission_version AS v FROM kernel.users WHERE id = ${USER}`
  versionBefore = v?.v ?? -1

  // The login, as it would stand had it run the migrations before 0254 itself:
  // owner of the schemas and tables, member of the roles 0000 grants its runner.
  await admin.unsafe(
    `CREATE ROLE "${login}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB`,
  )
  await admin.unsafe(
    `GRANT liaison_admin, liaison_rls, liaison_schema_admin, liaison_definer TO "${login}"`,
  )
  await admin.unsafe(`ALTER DATABASE "${dbName}" OWNER TO "${login}"`)
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
    END $$`)
  asLogin = postgres(freshAsLogin.toString(), { max: 1, onnotice: () => {} })

  // 0254 by the login, as a database owner would have run it.
  const with0254 = folderUpTo(FIRST_LOGIN_TAG, 0)
  folders.push(with0254)
  await runMigrations(freshAsLogin.toString(), { migrationsFolder: with0254 })
  // What lies between is not under test, and 0277 cannot run as this login at
  // all (ALTER FUNCTION ... OWNER TO liaison_admin needs CREATE on the schema),
  // so the superuser applies it.
  const upToFix = folderUpTo(FIX_TAG, -1)
  folders.push(upToFix)
  await runMigrations(freshAsSuperuser.toString(), { migrationsFolder: upToFix })
  // 0283 and anything after it, by the login again.
  const all = folderUpTo(FIX_TAG, Number.MAX_SAFE_INTEGER)
  folders.push(all)
  await runMigrations(freshAsLogin.toString(), { migrationsFolder: all })
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
    await admin.end()
  }
  for (const dir of folders) rmSync(dir, { recursive: true, force: true })
})

async function scopesOf(roleId: string): Promise<string[]> {
  const rows = await fresh<{ scope: string }[]>`
    SELECT scope FROM kernel.role_scope_grants WHERE role_id = ${roleId} ORDER BY scope`
  return rows.map((r) => r.scope)
}

describe("0283: seeds re-applied as liaison_admin, by a non-superuser migration login", () => {
  test("the login is neither a superuser nor BYPASSRLS", async () => {
    const [who] = await asLogin<{ super: boolean; bypass: boolean }[]>`
      SELECT rolsuper AS super, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`
    expect(who).toEqual({ super: false, bypass: false })
  })

  test("a member role gains the products (0254) and mcp-manager (0133, 0134) scopes", async () => {
    expect(await scopesOf(MEMBER_ROLE)).toEqual([
      "kernel:contacts:read",
      "kernel:contacts:write",
      "kernel:products:read",
      "kernel:products:write",
      "kernel:threads:write",
      "mcp_manager:connection:read",
      "mcp_manager:personal_connection:write",
    ])
  })

  test("a scope an admin revoked is not given back, and an app role gets nothing", async () => {
    expect(await scopesOf(REVOKED_ROLE)).toEqual(["kernel:contacts:read"])
    expect(await scopesOf(APP_ROLE)).toEqual(["kernel:contacts:read"])
  })

  test("its users' sessions are told to refresh", async () => {
    const [v] = await fresh<{ v: number }[]>`
      SELECT permission_version AS v FROM kernel.users WHERE id = ${USER}`
    expect(v?.v).toBeGreaterThan(versionBefore)
  })

  test("the retired mail:sensitivity grant is gone (0119)", async () => {
    const rows = await fresh`
      SELECT 1 FROM kernel.role_dimension_grants WHERE dimension_key = 'mail:sensitivity'`
    expect(rows.length).toBe(0)
  })

  test("an agent reply loses its wildcard required scope (0252)", async () => {
    const [m] = await fresh<{ required_scopes: string[] }[]>`
      SELECT required_scopes FROM kernel.messages WHERE id = ${AGENT_REPLY}`
    expect(m?.required_scopes).toEqual(["kernel:threads:read"])
  })
})

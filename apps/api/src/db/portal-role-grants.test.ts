// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The whole of what the portal role can reach, read from the catalog. A client
// who signs in holds this role and nothing else, so this list is the boundary:
// a new grant, a new schema it can use or a new definer function it can call
// fails here until it is added, with its reason, on purpose.
//
// System catalogs are left out (pg_catalog and information_schema are readable
// by every role and hold no business rows).

import { afterAll, describe, expect, test } from "bun:test"
import postgres from "postgres"

const ROLE = "liaison_portal"

function privilegedUrl(): string {
  if (process.env.MIGRATION_DATABASE_URL) return process.env.MIGRATION_DATABASE_URL
  const base = process.env.DB_RESET_SUPERUSER_URL ?? "postgres://postgres:postgres@localhost:5432"
  const dbName = new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, "")
  return `${base.replace(/\/$/, "")}/${dbName}`
}

const db = postgres(privilegedUrl(), { max: 1, onnotice: () => {} })

afterAll(async () => {
  await db.end()
})

/**
 * Entries that exist once an app is registered: its portal views (modules/portal/views.ts).
 * Listed when the app's schema exists in the database under test.
 */
const ALLOWED_WITH_APP: Record<string, Record<string, string>> = {
  tickets: {
    "table portal.ticket_messages SELECT":
      "the mails in and out of the tickets the caller reads: no note, no HTML, no agent",
  },
  invoicing: {
    "table portal.invoices SELECT":
      "the caller's company's issued invoices and credit notes behind an open invoices share, never a draft or its notes",
    "table portal.billing_upcoming SELECT":
      "what is still to be invoiced on the caller's company's projects: label, amount, due date",
  },
  agreements: {
    "table portal.agreements SELECT":
      "the caller's company's agreements behind an open agreement or change request share, a restricted one only for the people it names",
    "table portal.agreement_versions SELECT":
      "the frozen or signed versions of an agreement the caller reads: source, hash, the file unless a scan found it infected",
  },
}

/** Every entry the role may reach, each with why. Anything else is a failure. */
const ALLOWED: Record<string, string> = {
  "schema portal USAGE": "the one schema of objects a client is meant to read",
  "schema public USAGE":
    "PUBLIC's default on the database, not a grant to this role: extensions live there, and no table in it is readable",
  "schema rls_ctx USAGE":
    "PUBLIC since the context readers were made (0184): a policy or view evaluated for any role calls them",
  "table portal.me SELECT": "the client's own row",
  "table portal.people_me SELECT": "the client's own notice and title, nothing of anyone else",
  "table portal.shares SELECT":
    "the open shares of the caller's own open company, without those named for someone else",
  "table portal.client_actions SELECT":
    "the caller's company's actions behind an open share on their target, never a token hash",
  "function portal.contact_id()":
    "the caller's own contact id, only while their company is open; for the caller's own requests",
  "function portal.company_id()":
    "the caller's own company; every later view filters on it, and it reads only the caller's row",
  "table portal.projects SELECT":
    "the caller's company's work projects behind an open progress or reports share: name and manager's name",
  "table portal.project_steps SELECT":
    "the milestones of those projects behind an open progress share, with a done share from task statuses only",
  "table portal.tickets SELECT":
    "the caller's own portal requests or a shared ticket, internal and stamped with the caller's company, behind an open requests share",
  "function portal.project_hours(p_project uuid)":
    "billed or so-far hours of one project as totals, only behind an open hours share on a project using time and budgets",
  "function portal.file_allowed(p_file uuid)":
    "whether one file is the caller's to download, re-reading its parent; answers a boolean only",
  "function portal.file_meta(p_file uuid)": "the name, type and size of a file file_allowed allows",
  "function rls_ctx.org_id()": "returns the transaction's own org, after checking its tag",
  "function rls_ctx.user_id()": "returns the transaction's own user, after checking its tag",
  "function rls_ctx.scopes()": "returns the transaction's own scopes: none in a portal transaction",
  "function rls_ctx.dimensions()": "returns the transaction's own dimension grants: none here",
  "function rls_ctx.roles()": "returns the transaction's own roles: none here",
  "function rls_ctx.enter()":
    "stores only variables that verify, so calling it again from inside a transaction gains nothing",
}

describe("what the portal role can reach", () => {
  test("lists every grant, usage and executable definer function reachable by liaison_portal", async () => {
    const schemas = await db<{ name: string; usage: boolean; create: boolean }[]>`
      SELECT n.nspname AS name,
             has_schema_privilege(${ROLE}, n.oid, 'USAGE') AS usage,
             has_schema_privilege(${ROLE}, n.oid, 'CREATE') AS create
        FROM pg_namespace n
       WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'`
    const tables = await db<{ name: string; privilege: string }[]>`
      SELECT format('%I.%I', n.nspname, c.relname) AS name, p.privilege
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) AS p(privilege)
       WHERE c.relkind IN ('r','p','v','m','f')
         AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
         AND has_table_privilege(${ROLE}, c.oid, p.privilege)`
    const columns = await db<{ name: string }[]>`
      SELECT format('%I.%I', n.nspname, c.relname) AS name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r','p','v','m','f')
         AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
         AND has_any_column_privilege(${ROLE}, c.oid, 'SELECT, INSERT, UPDATE, REFERENCES')
         AND NOT has_table_privilege(${ROLE}, c.oid, 'SELECT')`
    const sequences = await db<{ name: string }[]>`
      SELECT format('%I.%I', n.nspname, c.relname) AS name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
         AND CASE WHEN c.relkind = 'S'
                  THEN has_sequence_privilege(${ROLE}, c.oid, 'USAGE, SELECT, UPDATE')
                  ELSE false END`
    const definers = await db<{ name: string }[]>`
      SELECT format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)) AS name
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE p.prosecdef
         AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
         AND has_schema_privilege(${ROLE}, n.oid, 'USAGE')
         AND has_function_privilege(${ROLE}, p.oid, 'EXECUTE')`

    const found = [
      ...schemas.filter((s) => s.usage).map((s) => `schema ${s.name} USAGE`),
      ...schemas.filter((s) => s.create).map((s) => `schema ${s.name} CREATE`),
      ...tables.map((t) => `table ${t.name} ${t.privilege}`),
      ...columns.map((c) => `column on ${c.name}`),
      ...sequences.map((s) => `sequence ${s.name}`),
      ...definers.map((d) => `function ${d.name}`),
    ].sort()
    const installed = await db<{ app: string }[]>`
      SELECT substring(nspname from 5) AS app FROM pg_namespace
       WHERE nspname = ANY(${Object.keys(ALLOWED_WITH_APP).map((app) => `app_${app}`)})`
    const allowed = { ...ALLOWED }
    for (const { app } of installed) Object.assign(allowed, ALLOWED_WITH_APP[app])
    expect(found).toEqual(Object.keys(allowed).sort())
  })

  test("is a login (the portal pool's), with no bypass or role administration", async () => {
    const [role] = await db<
      {
        rolsuper: boolean
        rolbypassrls: boolean
        rolcanlogin: boolean
        rolcreaterole: boolean
        rolcreatedb: boolean
      }[]
    >`SELECT rolsuper, rolbypassrls, rolcanlogin, rolcreaterole, rolcreatedb
        FROM pg_roles WHERE rolname = ${ROLE}`
    expect(role).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      rolcanlogin: true,
      rolcreaterole: false,
      rolcreatedb: false,
    })
  })

  test("the portal login is a member of no other role", async () => {
    const memberOf = await db<{ rolname: string }[]>`
      SELECT g.rolname FROM pg_auth_members m
        JOIN pg_roles g ON g.oid = m.roleid
        JOIN pg_roles r ON r.oid = m.member
       WHERE r.rolname = ${ROLE}`
    expect(memberOf.map((r) => r.rolname)).toEqual([])
  })
})

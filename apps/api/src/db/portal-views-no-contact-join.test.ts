// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The portal reads a company stamped on each object, never a contact's current
// company: moving a contact, a wrong domain grouping or a client saying "I'm now
// at another company" must move nothing on anyone's portal. Every view and
// function of schema `portal`, made by a migration or by an app's registration,
// is read from the catalog here and may not depend on, or name, kernel.contacts.

import { afterAll, describe, expect, test } from "bun:test"
import postgres from "postgres"

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

describe("the portal's views and functions read stamps", () => {
  test("no view of schema portal depends on kernel.contacts", async () => {
    const views = await db<{ name: string }[]>`
      SELECT c.relname AS name FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'portal' AND c.relkind = 'v'`
    expect(views.map((v) => v.name)).toContain("tickets")
    const offenders = await db<{ name: string }[]>`
      SELECT DISTINCT v.relname AS name
        FROM pg_rewrite r
        JOIN pg_class v ON v.oid = r.ev_class
        JOIN pg_namespace vn ON vn.oid = v.relnamespace
        JOIN pg_depend d ON d.objid = r.oid AND d.classid = 'pg_rewrite'::regclass
       WHERE vn.nspname = 'portal'
         AND d.refobjid = 'kernel.contacts'::regclass`
    expect(offenders.map((o) => o.name)).toEqual([])
  })

  test("no view or function of schema portal names kernel.contacts in its definition", async () => {
    const defs = await db<{ name: string; def: string }[]>`
      SELECT 'view ' || c.relname AS name, pg_get_viewdef(c.oid) AS def
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'portal' AND c.relkind = 'v'
      UNION ALL
      SELECT 'function ' || p.proname, p.prosrc
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'portal'`
    expect(defs.length).toBeGreaterThan(0)
    expect(defs.filter((d) => /\bcontacts\b/.test(d.def)).map((d) => d.name)).toEqual([])
  })
})

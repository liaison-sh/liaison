// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, test } from "bun:test"
import type { ReadCatalog } from "./catalog"
import { validateCatalog } from "./catalog"
import { renderReadonlyGrants } from "./grants-renderer"

const fixtureCatalog: ReadCatalog = {
  adapter: "fixture",
  reads: {
    org_tier: {
      description: "org tier",
      domain: "licenses",
      sql: "SELECT tier, slug FROM kernel.organizations WHERE slug = :slug",
      params: { slug: { type: "string" } },
      columns: ["tier", "slug"],
      tables: ["kernel.organizations"],
    },
    connected_status: {
      description: "connected account status",
      domain: "health",
      sql: "SELECT status, app_name FROM kernel.connected_accounts WHERE org_id = :orgId",
      params: { orgId: { type: "string" } },
      columns: ["status", "app_name"],
      tables: ["kernel.connected_accounts"],
    },
  },
}

/** Render helper: routes a raw catalog fixture through the same
 *  `validateCatalog` pipeline production adapters use, so `grantColumns` is
 *  resolved (single-table default filled in) exactly as it would be for a
 *  real adapter registration. */
function render(catalog: ReadCatalog) {
  return renderReadonlyGrants(validateCatalog(catalog))
}

describe("renderReadonlyGrants", () => {
  test("grants USAGE on every schema the catalog touches", () => {
    const { sql } = render(fixtureCatalog)
    expect(sql).toContain("GRANT USAGE ON SCHEMA kernel TO liaison_readonly;")
  })

  test("a table with zero SECRET_COLUMNS entries still gets a column-scoped grant, never full-row", () => {
    const catalogNoSecretTable: ReadCatalog = {
      adapter: "fixture",
      reads: {
        pending: {
          description: "backlog",
          domain: "health",
          sql: "SELECT id, org_id FROM kernel.pending_events WHERE org_id = :orgId",
          params: { orgId: { type: "string" } },
          columns: ["id", "org_id"],
          tables: ["kernel.pending_events"],
        },
      },
    }
    const { sql } = render(catalogNoSecretTable)
    // kernel.pending_events has no entries in SECRET_COLUMNS at all, but the
    // fail-closed model (S1) still requires a column-scoped grant — never a
    // bare full-row grant — because grants are driven by grantColumns, not
    // by "does this table happen to have secrets today".
    expect(sql).toContain("GRANT SELECT (id, org_id) ON kernel.pending_events TO liaison_readonly;")
    expect(sql).not.toContain("GRANT SELECT ON kernel.pending_events TO liaison_readonly;")
  })

  test("kernel.organizations HAS a secret column (settings) so it always gets a column-scoped grant, never a blanket full-row grant", () => {
    const catalogWithSecretAttempt: ReadCatalog = {
      adapter: "fixture",
      reads: {
        bad: {
          description: "x",
          domain: "health",
          sql: "SELECT tier FROM kernel.organizations WHERE slug = :slug",
          params: { slug: { type: "string" } },
          columns: ["tier"],
          tables: ["kernel.organizations"],
        },
      },
    }
    const { sql } = render(catalogWithSecretAttempt)
    // organizations HAS a secret column (settings) in SECRET_COLUMNS, so even
    // though this read only wants `tier`, the renderer must use a
    // column-scoped grant, never a blanket full-row grant, because the table
    // is secret-bearing.
    expect(sql).toContain("GRANT SELECT (tier) ON kernel.organizations TO liaison_readonly;")
    expect(sql).not.toContain("GRANT SELECT ON kernel.organizations TO liaison_readonly;")
  })

  test("column-scoped grant excludes secret columns even if a table has them declared elsewhere", () => {
    const { sql } = render(fixtureCatalog)
    // connected_accounts has secret columns (access_token_encrypted, etc.) —
    // since this read only asks for status/app_name (non-secret), it should
    // get a column-scoped grant naming exactly those two.
    expect(sql).toContain(
      "GRANT SELECT (app_name, status) ON kernel.connected_accounts TO liaison_readonly;",
    )
  })

  test("REVOKE EXECUTE lockdown present for every granted schema", () => {
    const { sql } = render(fixtureCatalog)
    expect(sql).toContain("REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA kernel FROM PUBLIC;")
    expect(sql).toContain("REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA kernel FROM liaison_readonly;")
    expect(sql).toContain(
      "ALTER DEFAULT PRIVILEGES IN SCHEMA kernel REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;",
    )
  })

  test("deterministic: same catalog renders identical SQL (drift-check basis)", () => {
    const a = render(fixtureCatalog)
    const b = render(fixtureCatalog)
    expect(a.sql).toBe(b.sql)
  })

  test("mutating the catalog changes the rendered SQL", () => {
    const before = render(fixtureCatalog)
    const mutated: ReadCatalog = {
      ...fixtureCatalog,
      reads: {
        ...fixtureCatalog.reads,
        extra: {
          description: "x",
          domain: "health",
          sql: "SELECT id FROM kernel.pending_events WHERE org_id = :orgId",
          params: { orgId: { type: "string" } },
          columns: ["id"],
          tables: ["kernel.pending_events"],
        },
      },
    }
    const after = render(mutated)
    expect(after.sql).not.toBe(before.sql)
    expect(after.sql).toContain("kernel.pending_events")
  })

  test("no blanket ALTER DEFAULT PRIVILEGES ... GRANT SELECT (fail-closed on future tables)", () => {
    const { sql } = render(fixtureCatalog)
    expect(sql).not.toMatch(/ALTER DEFAULT PRIVILEGES[\s\S]*GRANT SELECT/i)
  })

  test("role is created BYPASSRLS with a connection limit, and BYPASSRLS is re-asserted via ALTER for existing roles", () => {
    const { sql } = render(fixtureCatalog)
    // BYPASSRLS is required: governed tables run FORCE ROW LEVEL SECURITY whose
    // policies key off per-request app.* GUCs this context-free role never sets, so
    // without bypass every read returns zero rows. Safe because column/table GRANTs,
    // read-only txn, and no write grants are all independent of RLS and still apply.
    expect(sql).toContain("BYPASSRLS CONNECTION LIMIT 4")
    expect(sql).not.toContain("NOBYPASSRLS")
    expect(sql).toContain("ALTER ROLE liaison_readonly BYPASSRLS;")
  })

  test("a full-row `GRANT SELECT ON <table> TO liaison_readonly;` (no column list) is NEVER emitted for ANY table across a realistic multi-domain catalog (S1 fail-closed invariant)", () => {
    const catalog: ReadCatalog = {
      adapter: "fixture",
      reads: {
        org_tier: fixtureCatalog.reads.org_tier,
        connected_status: fixtureCatalog.reads.connected_status,
        tickets: {
          description: "tickets",
          domain: "moderation",
          sql: "SELECT id, subject FROM app_tickets.tickets WHERE org_id = :orgId",
          params: { orgId: { type: "string" } },
          columns: ["id", "subject"],
          tables: ["app_tickets.tickets"],
        },
        users: {
          description: "users",
          domain: "health",
          sql: "SELECT id, email FROM kernel.users WHERE id = :id",
          params: { id: { type: "string" } },
          columns: ["id", "email"],
          tables: ["kernel.users"],
        },
      },
    }
    const { sql } = render(catalog)
    // Every table in this catalog has at least one SECRET_COLUMNS entry
    // (organizations.settings, connected_accounts.*_encrypted,
    // tickets.reply_token, users.password_hash) — the renderer must always
    // emit a column-scoped grant for each, never a bare full-row grant.
    const bareFullRowGrant = /GRANT SELECT ON \S+ TO liaison_readonly;/
    expect(sql).not.toMatch(bareFullRowGrant)
    expect(sql).toContain("GRANT SELECT (id, subject) ON app_tickets.tickets TO liaison_readonly;")
    expect(sql).toContain("GRANT SELECT (email, id) ON kernel.users TO liaison_readonly;")
  })

  test("a full-row grant is NEVER emitted even for a table with NO SECRET_COLUMNS entries in a multi-table joined fixture (the invariant does not depend on SECRET_COLUMNS coverage)", () => {
    // kernel.contacts and kernel.pending_events both currently have zero
    // SECRET_COLUMNS entries — the old (pre-S1) renderer would have emitted
    // bare full-row grants for both. Drive a joined read across them plus a
    // secret-bearing table to prove the invariant holds catalog-wide.
    const catalog: ReadCatalog = {
      adapter: "fixture",
      reads: {
        tickets_by_requester_email: {
          description: "joined read",
          domain: "moderation",
          sql: "SELECT t.id, t.subject FROM app_tickets.tickets t JOIN kernel.contacts c ON c.id = t.contact_id WHERE c.email = :email",
          params: { email: { type: "string" } },
          columns: ["id", "subject"],
          tables: ["app_tickets.tickets", "kernel.contacts"],
          grantColumns: {
            "app_tickets.tickets": ["id", "subject", "contact_id"],
            "kernel.contacts": ["id", "email"],
          },
        },
        pending: {
          description: "backlog",
          domain: "health",
          sql: "SELECT id, org_id FROM kernel.pending_events WHERE org_id = :orgId",
          params: { orgId: { type: "string" } },
          columns: ["id", "org_id"],
          tables: ["kernel.pending_events"],
        },
      },
    }
    const { sql } = render(catalog)
    const bareFullRowGrant = /GRANT SELECT ON \S+ TO liaison_readonly;/
    expect(sql).not.toMatch(bareFullRowGrant)
    expect(sql).toContain(
      "GRANT SELECT (contact_id, id, subject) ON app_tickets.tickets TO liaison_readonly;",
    )
    expect(sql).toContain("GRANT SELECT (email, id) ON kernel.contacts TO liaison_readonly;")
    expect(sql).toContain("GRANT SELECT (id, org_id) ON kernel.pending_events TO liaison_readonly;")
    // A column not listed in ANY read's grantColumns for kernel.contacts
    // (e.g. `metadata`, `phone`) must not appear in that table's grant line.
    const contactsLine = sql.split("\n").find((l) => l.includes("ON kernel.contacts "))
    expect(contactsLine).toBeDefined()
    expect(contactsLine).not.toContain("metadata")
    expect(contactsLine).not.toContain("phone")
    expect(contactsLine).not.toContain("external_ids")
  })

  test("a read touching app_tickets.tickets excludes reply_token from its grant even if (hypothetically) declared in columns — the grant renders only the declared, non-secret columns", () => {
    const catalog: ReadCatalog = {
      adapter: "fixture",
      reads: {
        tickets_by_status: {
          description: "tickets by status",
          domain: "moderation",
          sql: "SELECT id, subject, status FROM app_tickets.tickets WHERE org_id = :orgId AND status = :status",
          params: { orgId: { type: "string" }, status: { type: "string" } },
          columns: ["id", "subject", "status"],
          tables: ["app_tickets.tickets"],
        },
      },
    }
    const { sql } = render(catalog)
    expect(sql).toContain(
      "GRANT SELECT (id, status, subject) ON app_tickets.tickets TO liaison_readonly;",
    )
    expect(sql).not.toMatch(/GRANT SELECT\([^)]*reply_token/i)
    expect(sql).not.toContain("reply_token")
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"

// ───────────────────────────────────────────────────────────────────────────
// I-DB-3 — Dynamic schema-conventions guard.
//
// Previously this file asserted conventions over a frozen Phase 1-2 table list.
// It now derives the org-scoped table set DYNAMICALLY (every `kernel.*` /
// `app_*` table with an `org_id` column) and asserts the org→organizations FK
// convention over the kernel tables in that set, minus an explicit allowlist.
//
// FK convention scope: kernel org-scoped tables must carry an FK on `org_id`
// referencing `kernel.organizations` (so org deletion cascades and org_id has
// referential integrity). App-schema (`app_*`) tables follow a DIFFERENT
// convention — they FK to their parent entity, which transitively carries the
// org FK — so the blanket org-FK rule applies to the `kernel` schema only. The
// named per-entity FK checks below still cover the app side.
//
//   KNOWN_CONVENTION_GAPS — kernel org-scoped tables that violate the org-FK
//   convention today. Seeded with exactly today's offenders so this guard is
//   GREEN now while biting on any NEW kernel table that ships without the FK.
//   Each entry is annotated with its finding ID; Wave 2a (WS-3) drains it.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Kernel org-scoped tables that legitimately do NOT carry the
 * `org_id → kernel.organizations` FK convention.
 *
 * Wave 2a (WS-3) DRAINED the I-DB-4 / B14 offenders (connected_accounts,
 * oauth_accounts, attention_events, files, app_sequences) by adding the real
 * FK + ON DELETE CASCADE in 0000_initial.sql — they are no longer allowlisted
 * and the assertion below covers them for real. The single remaining entry is
 * structural, not a gap: `device_flow_requests.org_id` is a SENTINEL until the
 * approve handler binds the real org, so a FK would reject the placeholder
 * insert and 500 every device-flow initiate (see the NOTE in 0000_initial.sql).
 */
const KNOWN_CONVENTION_GAPS = new Set<string>([
  // device_flow_requests.org_id is a PLACEHOLDER_ORG_ID until approval rebinds
  // it; a FK to organizations(id) would reject the initiate-time insert. The
  // rows are short-lived (15-min TTL, single-consume) so the cascade is
  // non-essential. Documented at the device_flow_requests NOTE in the baseline.
  "kernel.device_flow_requests",
  // apps_active_version.org_id (0212) is reserved for per-org installs and is
  // always NULL today: the catalog pointer is instance-wide, so there is no org
  // to reference yet.
  "kernel.apps_active_version",
  // org_transfer_ledger (0270) records the moves an org took part in on this
  // instance. A copy of the org that was moved out may be purged here while its
  // ledger row must stay (the reverse-move rule reads it), so it carries no FK.
  "kernel.org_transfer_ledger",
])

describe("Schema conventions against live database (dynamic)", () => {
  let kernelOrgTables: string[] = []

  beforeAll(async () => {
    const rows = await sql`
      SELECT c.relname AS tbl
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a
        ON a.attrelid = c.oid
       AND a.attname = 'org_id'
       AND a.attnum > 0
       AND NOT a.attisdropped
      WHERE c.relkind = 'r' AND n.nspname = 'kernel'
      ORDER BY c.relname
    `
    kernelOrgTables = rows.map((r: any) => `kernel.${r.tbl}`)
  })

  // ── Dynamic org→organizations FK convention (kernel schema) ─────────────

  it("discovers a non-trivial set of kernel org-scoped tables", () => {
    expect(kernelOrgTables.length).toBeGreaterThan(20)
  })

  it("every KNOWN_CONVENTION_GAPS entry still exists and is still org-scoped", () => {
    const known = new Set(kernelOrgTables)
    const stale = [...KNOWN_CONVENTION_GAPS].filter((t) => !known.has(t))
    expect(stale).toEqual([])
  })

  it("every kernel org-scoped table FKs org_id → kernel.organizations", async () => {
    const rows = await sql`
      SELECT DISTINCT c.relname AS tbl
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a
        ON a.attrelid = con.conrelid
       AND a.attnum = ANY(con.conkey)
       AND a.attname = 'org_id'
       AND NOT a.attisdropped
      WHERE con.contype = 'f' AND n.nspname = 'kernel'
    `
    const withOrgFk = new Set((rows as any[]).map((r) => `kernel.${r.tbl}`))
    const missing = kernelOrgTables
      .filter((t) => !KNOWN_CONVENTION_GAPS.has(t))
      .filter((t) => !withOrgFk.has(t))
    expect(missing).toEqual([])
  })

  // ── org_id presence on FK-inheriting kernel tables ──────────────────────
  // Two kernel grant-detail tables inherit org scope via FK to their parent
  // role and intentionally lack their own org_id column.

  const noOrgIdTables = ["role_scope_grants", "role_dimension_grants"]

  describe("org_id presence", () => {
    for (const table of noOrgIdTables) {
      it(`${table} intentionally lacks org_id (inherits via FK)`, async () => {
        const rows = await sql`
          SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'kernel' AND table_name = ${table} AND column_name = 'org_id'
        `
        expect(rows).toHaveLength(0)
      })
    }
  })

  // ── Timestamp columns ────────────────────────────────────────────────
  // Mutable kernel tables carry both created_at and updated_at; append-only
  // tables must NOT carry updated_at (a stray updated_at signals the table is
  // being mutated against the append-only convention).

  const mutableTables = [
    "organizations",
    "users",
    "threads",
    "contacts",
    "roles",
    "apps",
    "oauth_providers",
  ]

  const appendOnlyTables = [
    "audit_log",
    "timeline_entries",
    "sessions",
    "messages",
    "thread_participants",
    "message_reactions",
    "thread_references",
    "invitations",
    "password_resets",
    "device_flow_requests",
    "oauth_accounts",
    "user_thread_state",
    "user_roles",
    "role_scope_grants",
    "role_dimension_grants",
    "user_scope_grants",
    "user_dimension_grants",
  ]

  describe("timestamp columns", () => {
    for (const table of mutableTables) {
      it(`${table} has both created_at and updated_at`, async () => {
        const rows = await sql`
          SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'kernel' AND table_name = ${table}
            AND column_name IN ('created_at', 'updated_at')
        `
        const cols = rows.map((r: any) => r.column_name).sort()
        expect(cols).toEqual(["created_at", "updated_at"])
      })
    }

    for (const table of appendOnlyTables) {
      it(`${table} does NOT have updated_at`, async () => {
        const rows = await sql`
          SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'kernel' AND table_name = ${table}
            AND column_name = 'updated_at'
        `
        expect(rows).toHaveLength(0)
      })
    }
  })

  // ── Named per-entity FK completeness (kernel + app entity links) ─────────

  const expectedFKs: [string, string, string][] = [
    // [table, column, referenced_table]
    ["thread_participants", "thread_id", "threads"],
    ["thread_participants", "user_id", "users"],
    ["messages", "thread_id", "threads"],
    ["message_reactions", "message_id", "messages"],
    ["message_reactions", "user_id", "users"],
    ["thread_references", "thread_id", "threads"],
    ["role_scope_grants", "role_id", "roles"],
    ["role_dimension_grants", "role_id", "roles"],
    ["user_roles", "user_id", "users"],
    ["user_roles", "role_id", "roles"],
    ["password_resets", "user_id", "users"],
    ["oauth_accounts", "provider_id", "oauth_providers"],
    ["invitations", "role_id", "roles"],
    ["user_thread_state", "thread_id", "threads"],
  ]

  describe("FK completeness", () => {
    for (const [table, column, _referencedTable] of expectedFKs) {
      it(`${table}.${column} has a foreign key constraint`, async () => {
        const rows = await sql`
          SELECT tc.constraint_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
          WHERE tc.table_schema = 'kernel' AND tc.table_name = ${table}
            AND tc.constraint_type = 'FOREIGN KEY' AND kcu.column_name = ${column}
        `
        expect(rows.length).toBeGreaterThanOrEqual(1)
      })
    }
  })

  // ── UNIQUE constraint verification ───────────────────────────────────

  const expectedUniqueIndexes: [string, string][] = [
    ["sessions", "sessions_refresh_token_hash_idx"],
    ["role_scope_grants", "role_scope_grants_role_scope_idx"],
    ["user_scope_grants", "user_scope_grants_user_org_scope_idx"],
  ]

  describe("UNIQUE indexes", () => {
    for (const [table, indexName] of expectedUniqueIndexes) {
      it(`${table} has unique index ${indexName}`, async () => {
        const rows = await sql`
          SELECT indexname FROM pg_indexes
          WHERE schemaname = 'kernel' AND tablename = ${table} AND indexname = ${indexName}
        `
        expect(rows).toHaveLength(1)
      })
    }
  })

  // Do NOT call sql.end() — the connection pool is shared across all test files
})

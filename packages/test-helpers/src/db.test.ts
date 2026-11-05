// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, describe, expect, it } from "bun:test"
import { createDbClient, rewriteFunctionSchema, rewritePolicySchemas } from "./db"

const DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/liaison_test"

describe("DB client", () => {
  const db = createDbClient(DATABASE_URL)

  afterAll(async () => {
    await db.close()
  })

  it("connects and runs a simple query", async () => {
    const [row] = await db.sql`SELECT 1 AS one`
    expect(row.one).toBe(1)
  })

  it("cloneSchemas creates worker-prefixed schemas", async () => {
    const workerId = 99
    try {
      await db.cloneSchemas(workerId)
      // Verify the worker schema exists
      const [row] = await db.sql`
        SELECT 1 FROM information_schema.schemata
        WHERE schema_name = ${"w99_kernel"}
      `
      expect(row).toBeDefined()

      // Verify tables were cloned
      const tables = await db.sql`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = ${"w99_kernel"}
        ORDER BY table_name
      `
      expect(tables.length).toBeGreaterThan(10) // kernel has 15+ tables
    } finally {
      await db.dropWorkerSchemas(99)
    }
  })

  it("cloneSchemas copies the registry rows, re-pointed at the clone", async () => {
    try {
      await db.cloneSchemas(95)
      const src = await db.sql`SELECT resource_type FROM kernel.shareable_resource_types ORDER BY 1`
      expect(src.length).toBeGreaterThan(0)
      const rows = await db.sql`
        SELECT r.resource_type, pn.nspname AS fn_schema, cn.nspname AS table_schema
        FROM w95_kernel.shareable_resource_types r
        JOIN pg_proc p ON p.oid = r.can_manage
        JOIN pg_namespace pn ON pn.oid = p.pronamespace
        JOIN pg_class c ON c.oid = r.resource_table
        JOIN pg_namespace cn ON cn.oid = c.relnamespace
        ORDER BY 1
      `
      // Every resource type the migrations registered, judged by the clone's
      // own function over the clone's own table.
      expect(rows.map((r) => r.resource_type)).toEqual(src.map((r) => r.resource_type))
      for (const r of rows) {
        expect(r.fn_schema).toStartWith("w95_")
        expect(r.table_schema).toStartWith("w95_")
      }
    } finally {
      await db.dropWorkerSchemas(95)
    }
  })

  it("dropWorkerSchemas removes all w{N}_ schemas", async () => {
    await db.cloneSchemas(98)
    await db.dropWorkerSchemas(98)
    const rows = await db.sql`
      SELECT schema_name FROM information_schema.schemata
      WHERE schema_name LIKE 'w98_%'
    `
    expect(rows).toHaveLength(0)
  })

  it("grantWorkerSchemas grants app and RLS access", async () => {
    try {
      await db.cloneSchemas(97)
      await db.grantWorkerSchemas(97)
      // Verify grants exist
      const [row] = await db.sql`
        SELECT
          has_schema_privilege('liaison_app', 'w97_kernel', 'USAGE') AS app_usage,
          has_schema_privilege('liaison_rls', 'w97_kernel', 'USAGE') AS rls_usage
      `
      expect(row.app_usage).toBe(true)
      expect(row.rls_usage).toBe(true)
    } finally {
      await db.dropWorkerSchemas(97)
    }
  })

  it("truncateAll with prefix only truncates prefixed schemas", async () => {
    try {
      await db.cloneSchemas(96)
      await db.grantWorkerSchemas(96)
      // Insert a row in the worker schema to verify truncation
      await db.sql.unsafe(
        `INSERT INTO w96_kernel.organizations (name, slug) VALUES ('test', 'test-slug')`,
      )
      await db.truncateAll("w96_")
      const rows = await db.sql.unsafe(`SELECT count(*) AS c FROM w96_kernel.organizations`)
      expect(Number(rows[0].c)).toBe(0)
      const [grants] = await db.sql`
        SELECT has_schema_privilege('liaison_rls', 'w96_kernel', 'USAGE') AS rls_usage
      `
      expect(grants.rls_usage).toBe(true)
    } finally {
      await db.dropWorkerSchemas(96)
    }
  })
})

describe("cloneSchemasByPrefix", () => {
  const databaseUrl =
    process.env.E2E_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/liaison_test"

  it("clones kernel + app_* into the supplied prefix and drops them on demand", async () => {
    const client = createDbClient(databaseUrl)
    const prefix = "chaos_test_unit_"
    try {
      await client.cloneSchemasByPrefix(prefix)
      const schemas = await client.sql`
        SELECT schema_name FROM information_schema.schemata
        WHERE schema_name LIKE ${`${prefix}%`}
        ORDER BY schema_name
      `
      const names = schemas.map((r) => r.schema_name as string)
      expect(names).toContain(`${prefix}kernel`)
      expect(names.some((n) => n.startsWith(`${prefix}app_`))).toBe(true)
    } finally {
      await client.dropSchemasByPrefix(prefix)
      await client.close()
    }

    const client2 = createDbClient(databaseUrl)
    const remaining = await client2.sql`
      SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE ${`${prefix}%`}
    `
    expect(remaining).toHaveLength(0)
    await client2.close()
  })

  // A LANGUAGE sql function is validated when it is created, so cloning a
  // caller before its callee (pg_proc heap order, which a CREATE OR REPLACE or a
  // template copy reorders) used to fail with "function <prefix>kernel.has_role(text)
  // does not exist". The clone must not depend on that order.
  it("clones a function whose body calls a sibling listed after it", async () => {
    const client = createDbClient(databaseUrl)
    const src = "app_zz_clone_order"
    const prefix = "chaos_test_fn_order_"
    try {
      await client.sql.unsafe(`DROP SCHEMA IF EXISTS ${src} CASCADE`)
      await client.sql.unsafe(`CREATE SCHEMA ${src}`)
      await client.sql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL check_function_bodies = off`)
        await tx.unsafe(
          `CREATE FUNCTION ${src}.caller(_x text) RETURNS boolean LANGUAGE sql STABLE AS $f$ SELECT ${src}.callee(_x) $f$`,
        )
      })
      await client.sql.unsafe(
        `CREATE FUNCTION ${src}.callee(_x text) RETURNS boolean LANGUAGE sql STABLE AS $f$ SELECT _x = 'a' $f$`,
      )
      await client.cloneSchemasByPrefix(prefix)
      const [row] = await client.sql.unsafe(`SELECT ${prefix}${src}.caller('a') AS ok`)
      expect(row.ok).toBe(true)
      const [def] = await client.sql.unsafe(
        `SELECT pg_get_functiondef('${prefix}${src}.caller(text)'::regprocedure) AS d`,
      )
      expect(String(def.d)).toContain(`${prefix}${src}.callee(`)
    } finally {
      await client.dropSchemasByPrefix(prefix)
      await client.sql.unsafe(`DROP SCHEMA IF EXISTS ${src} CASCADE`)
      await client.close()
    }
  }, 60_000)

  it("points a function's search_path at the cloned schema", () => {
    const def = [
      "CREATE OR REPLACE FUNCTION kernel.f(_t text)",
      " RETURNS text",
      " LANGUAGE sql",
      " SECURITY DEFINER",
      " SET search_path TO 'kernel', 'pg_temp'",
      "AS $fn$ SELECT kernel.g(_t) $fn$",
    ].join("\n")
    const out = rewriteFunctionSchema(def, "kernel", "w3_kernel")
    expect(out).toContain("FUNCTION w3_kernel.f(")
    expect(out).toContain("SELECT w3_kernel.g(_t)")
    expect(out).toContain(" SET search_path TO 'w3_kernel', 'pg_temp'")
  })

  // F3-prove-3: a resource type NAME ('kernel.contact') is a value that looks
  // like a schema-qualified identifier. Rewritten to 'w3_kernel.contact', the
  // clone's recompute_search_acl matched no CASE arm and raised "not a
  // shareable resource type: kernel.contact" on every contact write in a
  // worker schema, and a cloned policy asked for grants of a type that does
  // not exist. Values listed as kept stay as they are; identifiers still move.
  it("keeps value literals that only look like a cloned schema's names", () => {
    const def = [
      "CREATE OR REPLACE FUNCTION kernel.recompute_search_acl(p_type text)",
      " LANGUAGE plpgsql",
      "AS $fn$ BEGIN",
      "  v := CASE p_type WHEN 'kernel.contact' THEN 1 END;",
      "  SELECT resource_table FROM kernel.shareable_resource_types WHERE resource_type = p_type;",
      "  EXECUTE 'SELECT 1 FROM kernel.contacts';",
      "END $fn$",
    ].join("\n")
    const out = rewriteFunctionSchema(def, "kernel", "w3_kernel", ["kernel.contact"])
    expect(out).toContain("WHEN 'kernel.contact' THEN")
    expect(out).toContain("FROM w3_kernel.shareable_resource_types")
    expect(out).toContain("'SELECT 1 FROM w3_kernel.contacts'")
    expect(out).toContain("FUNCTION w3_kernel.recompute_search_acl(")

    const policy = "(kernel.resource_grant_role('kernel.contact'::text, id) IS NOT NULL)"
    expect(rewritePolicySchemas(policy, ["kernel"], "w3_", ["kernel.contact"])).toBe(
      "(w3_kernel.resource_grant_role('kernel.contact'::text, id) IS NOT NULL)",
    )
  })

  it("rejects prefixes that aren't safe identifiers", () => {
    const client = createDbClient(databaseUrl)
    try {
      expect(() => client.assertSafePrefix("foo bar")).toThrow(/safe identifier/)
      expect(() => client.assertSafePrefix("foo;DROP")).toThrow(/safe identifier/)
      expect(() => client.assertSafePrefix("chaos_2026_05_07_baseline_")).not.toThrow()
    } finally {
      client.close()
    }
  })

  // LIKE INCLUDING ALL names every copied index itself (`projects_org_id_key_idx`)
  // instead of keeping the source name. Services that recognise a unique
  // violation by its index name (create-project retries a colliding auto key on
  // `app_projects_org_key_uidx`) then saw an unknown name in a worker schema and
  // answered 500. The clone must keep every source index name.
  it("keeps every source index name through the clone", async () => {
    const client = createDbClient(databaseUrl)
    const prefix = "chaos_test_idx_names_"
    try {
      await client.cloneSchemasByPrefix(prefix)
      const indexes = async (schemaPrefix: string) => {
        const rows = await client.sql`
          SELECT schemaname, tablename, indexname FROM pg_indexes
          WHERE schemaname = ${`${schemaPrefix}kernel`}
             OR schemaname LIKE ${`${schemaPrefix.replaceAll("_", "\\_")}app\\_%`}
        `
        return rows
          .map(
            (r) =>
              `${(r.schemaname as string).slice(schemaPrefix.length)}.${r.tablename}.${r.indexname}`,
          )
          .sort()
      }
      const base = await indexes("")
      expect(base).toContain("app_projects.projects.app_projects_org_key_uidx")
      expect(await indexes(prefix)).toEqual(base)
    } finally {
      await client.dropSchemasByPrefix(prefix)
      await client.close()
    }
  })

  // BL-203 regression: the clone re-creates cross-table FKs in step 7. It used
  // to emit `ADD CONSTRAINT ... FOREIGN KEY ... REFERENCES ...` with NO
  // referential-action clause, so Postgres defaulted every cloned FK to
  // NO ACTION ('a') — silently dropping ON DELETE CASCADE / SET NULL / RESTRICT
  // and breaking parent-row deletes in chaos worlds. The clone must now carry
  // each FK's confdeltype / confupdtype through faithfully (not blanket-cascade).
  it("preserves each FK's ON DELETE referential action through the clone (cascade)", async () => {
    const client = createDbClient(databaseUrl)
    const prefix = "chaos_test_fk_cascade_"
    try {
      await client.cloneSchemasByPrefix(prefix)

      const actionFor = async (table: string, constraint: string): Promise<string> => {
        const rows = await client.sql`
          SELECT con.confdeltype
          FROM pg_constraint con
          JOIN pg_class cl ON cl.oid = con.conrelid
          JOIN pg_namespace n ON n.oid = cl.relnamespace
          WHERE n.nspname = ${`${prefix}app_projects`}
            AND cl.relname = ${table}
            AND con.contype = 'f'
            AND con.conname = ${`${prefix}${constraint}`}
        `
        expect(rows).toHaveLength(1)
        return rows[0].confdeltype as string
      }

      // CASCADE FK (0000_initial.sql: project_statuses.project_id ON DELETE CASCADE).
      // Before the fix this was 'a' (NO ACTION) — the BL-203 bug.
      expect(await actionFor("project_statuses", "project_statuses_project_id_fkey")).toBe("c")

      // RESTRICT FK (tasks.project_id ON DELETE RESTRICT) must stay 'r' — proves
      // the mapper is action-faithful, not blanket-cascade.
      expect(await actionFor("tasks", "tasks_project_id_fkey")).toBe("r")

      // SET NULL cross-schema FK (tasks.assignee_id -> kernel.users ON DELETE
      // SET NULL) must stay 'n' — exercises the SET NULL mapping + cross-schema path.
      expect(await actionFor("tasks", "tasks_assignee_id_fkey")).toBe("n")
    } finally {
      await client.dropSchemasByPrefix(prefix)
      await client.close()
    }
  })
})

describe("rewritePolicySchemas", () => {
  it("points every cloned schema's references at its clone, once", () => {
    const expr =
      "(org_access = 'viewer' OR kernel.resource_grant_role('knowledge.document', documents.id) IS NOT NULL) AND app_knowledge.app_has_scope('x') AND \"kernel\".has_role('r')"
    const out = rewritePolicySchemas(expr, ["kernel", "app_knowledge"], "w3_")
    expect(out).toBe(
      "(org_access = 'viewer' OR w3_kernel.resource_grant_role('knowledge.document', documents.id) IS NOT NULL) AND w3_app_knowledge.app_has_scope('x') AND \"w3_kernel\".has_role('r')",
    )
    // Already-prefixed names and look-alikes are left alone.
    expect(rewritePolicySchemas("w3_kernel.f() AND my_kernel.g()", ["kernel"], "w3_")).toBe(
      "w3_kernel.f() AND my_kernel.g()",
    )
  })
})

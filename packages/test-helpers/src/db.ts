// SPDX-License-Identifier: FSL-1.1-ALv2
import { createHash } from "node:crypto"
import postgres from "postgres"

export interface DbClient {
  sql: ReturnType<typeof postgres>
  cloneSchemas(workerId: number): Promise<void>
  cloneSchemasByPrefix(prefix: string): Promise<void>
  dropWorkerSchemas(workerId: number): Promise<void>
  dropSchemasByPrefix(prefix: string): Promise<void>
  grantWorkerSchemas(workerId: number): Promise<void>
  grantSchemasByPrefix(prefix: string): Promise<void>
  assertSafePrefix(prefix: string): void
  truncateAll(schemaPrefix?: string): Promise<void>
  close(): Promise<void>
}

const SAFE_PREFIX_RE = /^[a-z][a-z0-9_]*_$/
const SAFE_IDENT_RE = /^[a-z][a-z0-9_]*$/

export function assertSafePrefix(prefix: string): void {
  if (!SAFE_PREFIX_RE.test(prefix)) {
    throw new Error(
      `Schema prefix ${JSON.stringify(prefix)} is not a safe identifier (must match /^[a-z][a-z0-9_]*_$/)`,
    )
  }
}

function quoteIdent(value: string): string {
  if (!SAFE_IDENT_RE.test(value)) throw new Error(`unsafe identifier: ${value}`)
  return `"${value.replaceAll('"', '""')}"`
}

function quotePrefixedIdent(prefix: string, value: string): string {
  assertSafePrefix(prefix)
  if (!value.startsWith(prefix))
    throw new Error(`identifier ${value} does not match prefix ${prefix}`)
  return quoteIdent(value)
}

function prefixedLikePattern(prefix: string): string {
  assertSafePrefix(prefix)
  return `${prefix.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`
}

function clonedConstraintName(prefix: string, constraintName: string): string {
  const raw = `${prefix}${constraintName}`
  if (raw.length <= 63) return raw
  const hash = createHash("sha256").update(raw).digest("hex").slice(0, 8)
  return `${raw.slice(0, 63 - hash.length - 1).replace(/_+$/, "")}_${hash}`
}

// Map a pg_constraint referential-action code (confdeltype / confupdtype) to
// the SQL clause that reproduces it on the cloned FK. The single-letter codes
// are Postgres' canonical encoding: a=NO ACTION, r=RESTRICT, c=CASCADE,
// n=SET NULL, d=SET DEFAULT. NO ACTION is Postgres' default for an omitted
// clause, so we return an empty string for 'a' (and for any unknown code) to
// keep the emitted DDL minimal — the resulting constraint is identical to one
// declared with an explicit `NO ACTION`. Without this, every cloned FK
// silently degraded to NO ACTION regardless of the source action (BL-203):
// e.g. app_projects.project_statuses.project_id is ON DELETE CASCADE in the
// base schema, but the clone behaved as RESTRICT, so deleting a project in a
// chaos world raised an FK violation instead of cascading.
const REFERENTIAL_ACTION_BY_CODE: Record<string, string> = {
  c: "CASCADE",
  n: "SET NULL",
  d: "SET DEFAULT",
  r: "RESTRICT",
  a: "", // NO ACTION — Postgres default; omit to keep the DDL minimal
}

function referentialActionClause(keyword: "ON DELETE" | "ON UPDATE", code: unknown): string {
  const action = typeof code === "string" ? (REFERENTIAL_ACTION_BY_CODE[code] ?? "") : ""
  return action ? ` ${keyword} ${action}` : ""
}

/**
 * Point a function definition (pg_get_functiondef output) at the cloned
 * schema: qualified references (`kernel.x` → `w0_kernel.x`) and the schema in
 * a `SET search_path` clause, so unqualified names inside a SECURITY DEFINER
 * body resolve in the clone, not the base schema.
 */
export function rewriteFunctionSchema(
  def: string,
  srcSchema: string,
  dstSchema: string,
  keepLiterals: readonly string[] = [],
): string {
  return keepingLiterals(def, keepLiterals, (text) =>
    text
      .replaceAll(`${srcSchema}.`, `${dstSchema}.`)
      .replace(
        /^( SET search_path TO )(.*)$/m,
        (_m, head: string, list: string) =>
          head + list.replace(new RegExp(`(^|, )'?${srcSchema}'?(?=,|$)`, "g"), `$1'${dstSchema}'`),
      ),
  )
}

/**
 * Run `rewrite` over `text` with every single-quoted literal equal to one of
 * `literals` held out of it. A value such as the resource type name
 * 'kernel.contact' reads like a qualified identifier but is data: the clone's
 * registry rows keep it as is, so the functions and policies comparing
 * against it must keep it too. Identifiers, including those inside dynamic SQL
 * strings, are still rewritten.
 */
function keepingLiterals(
  text: string,
  literals: readonly string[],
  rewrite: (s: string) => string,
): string {
  if (literals.length === 0) return rewrite(text)
  const kept: string[] = []
  let masked = text
  for (const literal of literals) {
    const quoted = `'${literal.replaceAll("'", "''")}'`
    masked = masked.replaceAll(quoted, () => {
      kept.push(quoted)
      return `'@@kept-literal-${kept.length - 1}@@'`
    })
  }
  return rewrite(masked).replace(
    /'@@kept-literal-(\d+)@@'/g,
    (_m, i: string) => kept[Number(i)] ?? "",
  )
}

/**
 * Point every qualified reference to a cloned schema in a policy expression at
 * its clone (`kernel.x` → `w0_kernel.x`, `app_knowledge.y` → `w0_app_knowledge.y`).
 * A name only matches as a whole identifier, so `w0_kernel.x` is never
 * prefixed twice.
 */
export function rewritePolicySchemas(
  expr: string,
  schemas: readonly string[],
  prefix: string,
  keepLiterals: readonly string[] = [],
): string {
  if (schemas.length === 0) return expr
  const names = schemas.map((n) => n.replace(/[^a-z0-9_]/g, "")).join("|")
  return keepingLiterals(expr, keepLiterals, (text) =>
    text.replace(
      new RegExp(`(?<![A-Za-z0-9_$"])("?)(${names})\\1\\.`, "g"),
      (_m, quote: string, name: string) => `${quote}${prefix}${name}${quote}.`,
    ),
  )
}

export function createDbClient(databaseUrl: string): DbClient {
  // Silence Postgres NOTICEs here because the test-helpers DB client runs
  // very high-volume idempotent DDL (cloneSchemas → tens of GRANTs per call
  // → "role already a member of …" notices on every re-run). NOTICEs CAN be
  // diagnostic in principle (RAISE NOTICE in PL/pgSQL, unexpected cascades)
  // but the prod connection (apps/api/src/db/connection.ts) routes those to
  // pino at debug level. This helper is build-up/tear-down plumbing — when
  // its notices matter, you'll be debugging it directly and can rewire then.
  const sql = postgres(databaseUrl, {
    max: 2,
    idle_timeout: 10,
    // Default 10s; the chaos batch raises it via LIAISON_DB_CONNECT_TIMEOUT so a connect under
    // heavy CPU contention waits rather than failing `write CONNECT_TIMEOUT` during world setup.
    connect_timeout: Number(process.env.LIAISON_DB_CONNECT_TIMEOUT) || 10,
    onnotice: () => {},
  })

  async function indexesOf(schema: string): Promise<Array<{ key: string; name: string }>> {
    const rows = await sql`
      SELECT t.relname AS tbl, i.relname AS name, pg_get_indexdef(ix.indexrelid) AS def
      FROM pg_index ix
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_class t ON t.oid = ix.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = ${schema}
      ORDER BY t.relname, i.relname
    `
    // The definition minus the index's own name and its schema qualifier: two
    // indexes with the same shape on the same table are the same index.
    return rows.map((r) => ({
      name: r.name as string,
      key: `${r.tbl as string}\u0000${(r.def as string)
        .replace(/^CREATE (UNIQUE )?INDEX (?:"(?:[^"]|"")+"|\S+) ON /, "CREATE $1INDEX ON ")
        .replaceAll(`${schema}.`, "")}`,
    }))
  }

  async function restoreIndexNames(srcSchema: string, dstSchema: string): Promise<void> {
    const srcByKey = new Map<string, string[]>()
    for (const { key, name } of await indexesOf(srcSchema)) {
      srcByKey.set(key, [...(srcByKey.get(key) ?? []), name])
    }
    const renames: Array<{ from: string; to: string }> = []
    for (const { key, name } of await indexesOf(dstSchema)) {
      const to = srcByKey.get(key)?.shift()
      if (to && to !== name) renames.push({ from: name, to })
    }
    // A target may still be held by another clone-generated name that is
    // itself about to move: park those first so no rename collides.
    // Names come from the catalog, not from input: quote, do not validate.
    const q = (v: string) => `"${v.replaceAll('"', '""')}"`
    const targets = new Set(renames.map((r) => r.to))
    for (const [i, r] of renames.entries()) {
      if (!targets.has(r.from)) continue
      const parked = `clone_parked_idx_${i}`
      await sql.unsafe(`ALTER INDEX ${q(dstSchema)}.${q(r.from)} RENAME TO ${q(parked)}`)
      r.from = parked
    }
    for (const r of renames) {
      await sql.unsafe(`ALTER INDEX ${q(dstSchema)}.${q(r.from)} RENAME TO ${q(r.to)}`)
    }
  }

  // Every function of the source schema must exist in the clone with the same
  // signature: a policy or function body naming `<prefix>kernel.has_role`
  // otherwise fails at query time, far from the clone that dropped it.
  async function assertFunctionsCloned(srcSchema: string, dstSchema: string): Promise<void> {
    const missing = await sql`
      SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS sig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = ${srcSchema} AND p.prokind = 'f'
      EXCEPT
      SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = ${dstSchema} AND p.prokind = 'f'
    `
    if (missing.length > 0) {
      throw new Error(
        `schema clone ${srcSchema} -> ${dstSchema} is missing functions: ${missing.map((r) => r.sig).join(", ")}`,
      )
    }
  }

  async function cloneSchemas(workerId: number): Promise<void> {
    return cloneSchemasByPrefix(`w${workerId}_`)
  }

  async function cloneSchemasByPrefix(prefix: string): Promise<void> {
    assertSafePrefix(prefix)

    // Create a non-BYPASSRLS role for RLS-enforced app queries.
    // liaison_app keeps BYPASSRLS (needed for kernel admin queries outside RLS context),
    // but withRlsContext switches to liaison_rls which enforces RLS.
    // Worker schemas must clone RLS policies so liaison_rls enforcement works correctly.
    // Roles are CLUSTER-wide, so every database's workers write the same
    // pg_authid rows. Two writers at once fail with "tuple concurrently
    // updated". The advisory lock serializes writers in ONE database only (an
    // advisory lock is per database), and test runs now each have their own
    // database (test-namespace.ts), so the statements below only WRITE when
    // the role is not already in the wanted state: after the first run on a
    // cluster they are pure reads, which never conflict. A first-time race
    // between two databases is retried.
    await sql.unsafe(`SELECT pg_advisory_lock(42424242)`)
    try {
      for (let attempt = 1; ; attempt++) {
        try {
          await sql.unsafe(`
            DO $$ BEGIN
              IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'liaison_rls') THEN
                CREATE ROLE liaison_rls NOLOGIN NOBYPASSRLS;
              END IF;
              IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'liaison_admin') THEN
                CREATE ROLE liaison_admin NOLOGIN;
              END IF;
              IF NOT (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'liaison_app') THEN
                ALTER ROLE liaison_app BYPASSRLS;
              END IF;
              IF NOT (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'liaison_admin') THEN
                ALTER ROLE liaison_admin BYPASSRLS;
              END IF;
              IF NOT pg_has_role('liaison_app', 'liaison_rls', 'MEMBER') THEN
                GRANT liaison_rls TO liaison_app;
              END IF;
              IF NOT pg_has_role('liaison_app', 'liaison_admin', 'MEMBER') THEN
                GRANT liaison_admin TO liaison_app;
              END IF;
            EXCEPTION WHEN duplicate_object THEN NULL; END $$
          `)
          break
        } catch (err) {
          const concurrent = /tuple concurrently updated/.test(String(err))
          if (!concurrent || attempt >= 5) throw err
          await new Promise((r) => setTimeout(r, 50 * attempt))
        }
      }
    } finally {
      await sql.unsafe(`SELECT pg_advisory_unlock(42424242)`)
    }

    // Drop stale schemas from prior crashed runs
    await dropSchemasByPrefix(prefix)

    // Find all base schemas to clone (kernel + app_*).
    // Process kernel first so cross-schema FKs from app_* tables to kernel
    // can resolve their references when we recreate them in step 7.
    const schemas = await sql`
      SELECT schema_name FROM information_schema.schemata
      WHERE schema_name = 'kernel' OR schema_name LIKE 'app\\_%' ESCAPE '\\'
      ORDER BY (schema_name = 'kernel') DESC, schema_name
    `

    const clonedSchemas = schemas.map((r) => r.schema_name as string)
    // Values the functions and policies compare against that must not be
    // rewritten: the shareable resource type names ('kernel.contact'). The
    // registry rows are copied verbatim (step 8), so the clone's code must keep
    // naming them verbatim too.
    const keepLiterals = await registryValueLiterals()
    for (const { schema_name: srcSchema } of schemas) {
      const dstSchema = `${prefix}${srcSchema}`

      // 1. Create target schema
      await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS "${dstSchema}"`)

      // 2. Clone custom enum types into the prefixed schema. Required for
      // apps whose `pgSchema` uses `${SCHEMA_PREFIX}` (e.g. `app_mcp_manager`,
      // `kernel`) — Drizzle emits enum casts against the prefixed schema, so
      // the prefixed enum type must exist. The cloned table (step 4) then
      // gets its enum-typed columns ALTERed to point at the prefixed enum
      // in step 4b below.
      const enums = await sql`
        SELECT t.typname, array_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels
        FROM pg_type t
        JOIN pg_enum e ON e.enumtypid = t.oid
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = ${srcSchema}
        GROUP BY t.typname
      `
      const enumNames = new Set<string>()
      for (const { typname, labels } of enums) {
        const labelsSql = (labels as string[]).map((l) => `'${l.replace(/'/g, "''")}'`).join(", ")
        await sql.unsafe(
          `DO $$ BEGIN CREATE TYPE "${dstSchema}"."${typname}" AS ENUM (${labelsSql}); EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
        )
        enumNames.add(typname as string)
      }

      // 3. Clone standalone sequences (not tied to table columns)
      const seqs = await sql`
        SELECT sequence_name FROM information_schema.sequences
        WHERE sequence_schema = ${srcSchema}
      `
      for (const { sequence_name: seqName } of seqs) {
        await sql.unsafe(`CREATE SEQUENCE IF NOT EXISTS "${dstSchema}"."${seqName}"`)
      }

      // 4. Clone tables with LIKE INCLUDING ALL (copies columns, defaults, constraints, indexes, sequences).
      // Search-path is pinned to the SOURCE schema first so any unqualified enum
      // type references inside LIKE resolve against the original enum types
      // (which are NOT cloned — see step 2 commentary). Without this pin, LIKE
      // resolves column types via the default search_path and emits names like
      // `<dstSchema>.<enum>` — which then fail to load since the cloned schema
      // has no enum mirror. With the pin, the cloned column ends up correctly
      // typed `<srcSchema>.<enum>` so Drizzle's runtime queries (which emit
      // `<srcSchema>.<enum>` casts via top-level `pgEnum()`) match.
      const tables = await sql`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = ${srcSchema} AND table_type = 'BASE TABLE'
        ORDER BY table_name
      `
      for (const { table_name: tableName } of tables) {
        await sql.unsafe(
          `CREATE TABLE IF NOT EXISTS "${dstSchema}"."${tableName}" (LIKE "${srcSchema}"."${tableName}" INCLUDING ALL)`,
        )
        // 4a. Capture + drop inherited CHECK constraints BEFORE the ALTER
        // TYPE in 4b. LIKE INCLUDING ALL carries CHECK definitions whose
        // enum literals reference the SOURCE schema's enum
        // (e.g. `transport = 'http'::<srcSchema>.<enumName>`). Once we try
        // to change the column type to `<dstSchema>.<enumName>` in 4b,
        // Postgres validates the existing CHECK constraints against the
        // new type and fails with `operator does not exist: <dst>.<enum>
        // = <src>.<enum>`. So: snapshot the defs here, drop, then re-add
        // (rewritten) in 4c after the type change has completed.
        const inheritedChecks: Array<{ name: string; def: string }> = []
        // Partial indexes whose predicate references a cloned enum (e.g.
        // `... WHERE state = 'pending'::<src>.<enum>`). LIKE INCLUDING ALL copies
        // the predicate with the SOURCE-schema enum cast; after 4b repoints the
        // column to the <dst> enum, the predicate compares <dst>-column =
        // <src>-literal and every INSERT fails with
        // `operator does not exist: <dst>.<enum> = <src>.<enum>`. So, like the
        // CHECK constraints below: drop before 4b's ALTER TYPE, recreate
        // (rewritten to <dst>) in 4d.
        const inheritedPartialIndexes: Array<{ name: string; def: string }> = []
        if (enumNames.size > 0) {
          const rows = await sql`
            SELECT con.conname AS name,
                   pg_get_constraintdef(con.oid) AS def
            FROM pg_constraint con
            JOIN pg_class c ON c.oid = con.conrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = ${dstSchema}
              AND c.relname = ${tableName}
              AND con.contype = 'c'
          `
          for (const r of rows) {
            inheritedChecks.push({ name: r.name as string, def: r.def as string })
          }
          for (const { name } of inheritedChecks) {
            await sql.unsafe(`ALTER TABLE "${dstSchema}"."${tableName}" DROP CONSTRAINT "${name}"`)
          }
          // Capture + drop partial indexes whose predicate references a cloned
          // enum type (fully-qualified `<src>.<enum>` in pg_get_indexdef).
          const idxRows = await sql`
            SELECT i.relname AS name, pg_get_indexdef(ix.indexrelid) AS def
            FROM pg_index ix
            JOIN pg_class i ON i.oid = ix.indexrelid
            JOIN pg_class t ON t.oid = ix.indrelid
            JOIN pg_namespace n ON n.oid = t.relnamespace
            WHERE n.nspname = ${dstSchema}
              AND t.relname = ${tableName}
              AND ix.indpred IS NOT NULL
          `
          for (const r of idxRows) {
            const def = r.def as string
            const refsEnum = [...enumNames].some((e) => def.includes(`${srcSchema}.${e}`))
            if (!refsEnum) continue
            inheritedPartialIndexes.push({ name: r.name as string, def })
            await sql.unsafe(`DROP INDEX IF EXISTS "${dstSchema}"."${r.name as string}"`)
          }
        }
        // 4b. After LIKE, enum-typed columns still reference the source
        // schema's enum type (`<srcSchema>.<enum>`). Drizzle's runtime emits
        // casts against the destination schema's enum (`<dstSchema>.<enum>`,
        // via top-level `pgEnum()` declared in code that uses a prefixed
        // `pgSchema`). Repoint each enum-typed column at the prefixed enum
        // so Drizzle queries find a matching type. Without this, queries
        // fail with `operator does not exist: <src>.<enum> = <dst>.<enum>`.
        if (enumNames.size > 0) {
          const enumCols = await sql`
            SELECT a.attname AS col, t.typname AS enum_name
            FROM pg_attribute a
            JOIN pg_class c ON c.oid = a.attrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN pg_type t ON t.oid = a.atttypid
            JOIN pg_namespace tn ON tn.oid = t.typnamespace
            WHERE n.nspname = ${dstSchema}
              AND c.relname = ${tableName}
              AND a.attnum > 0
              AND NOT a.attisdropped
              AND tn.nspname = ${srcSchema}
              AND t.typtype = 'e'
          `
          for (const { col, enum_name } of enumCols) {
            if (!enumNames.has(enum_name as string)) continue
            // Capture the column's default expression (if any), drop it,
            // ALTER TYPE, then re-apply the default cast to the new type.
            // Without the drop/restore, ALTER TYPE fails with "default for
            // column X cannot be cast automatically to type Y" when the
            // default literal is typed against the old enum.
            const [defRow] = await sql`
              SELECT pg_get_expr(d.adbin, d.adrelid) AS def
              FROM pg_attrdef d
              JOIN pg_attribute a
                ON a.attrelid = d.adrelid AND a.attnum = d.adnum
              JOIN pg_class c ON c.oid = a.attrelid
              JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = ${dstSchema}
                AND c.relname = ${tableName}
                AND a.attname = ${col}
            `
            const defaultExpr = defRow?.def as string | undefined
            if (defaultExpr) {
              await sql.unsafe(
                `ALTER TABLE "${dstSchema}"."${tableName}" ALTER COLUMN "${col}" DROP DEFAULT`,
              )
            }
            await sql.unsafe(
              `ALTER TABLE "${dstSchema}"."${tableName}" ALTER COLUMN "${col}" TYPE "${dstSchema}"."${enum_name}" USING "${col}"::text::"${dstSchema}"."${enum_name}"`,
            )
            if (defaultExpr) {
              // Rewrite the default expression to point at the new enum type
              // (replaces `::<srcSchema>.<enumName>` casts in the literal).
              const rewritten = defaultExpr.replaceAll(
                `${srcSchema}.${enum_name}`,
                `${dstSchema}.${enum_name}`,
              )
              await sql.unsafe(
                `ALTER TABLE "${dstSchema}"."${tableName}" ALTER COLUMN "${col}" SET DEFAULT ${rewritten}`,
              )
            }
          }
        }
        // 4c. Re-add the CHECK constraints we dropped in 4a, rewriting any
        // enum literals so they reference the destination schema's enum
        // (matches the column type after 4b's ALTER TYPE).
        for (const { name, def } of inheritedChecks) {
          let rewritten = def
          for (const enumName of enumNames) {
            rewritten = rewritten.replaceAll(`${srcSchema}.${enumName}`, `${dstSchema}.${enumName}`)
          }
          await sql.unsafe(
            `ALTER TABLE "${dstSchema}"."${tableName}" ADD CONSTRAINT "${name}" ${rewritten}`,
          )
        }
        // 4d. Recreate partial indexes dropped in 4a, repointing the enum cast
        // in their predicate to the destination schema's enum (matches the
        // column type after 4b). pg_get_indexdef already targets <dstSchema>.<table>.
        for (const { def } of inheritedPartialIndexes) {
          let rewritten = def
          for (const enumName of enumNames) {
            rewritten = rewritten.replaceAll(`${srcSchema}.${enumName}`, `${dstSchema}.${enumName}`)
          }
          await sql.unsafe(rewritten)
        }
        // Ownership is (re)assigned authoritatively in `grantSchemasByPrefix`,
        // which preserves each base table's real owner. LIKE does not copy
        // ownership; the table is left owned by the clone connection role here.
      }

      // 4e. Give every cloned index its source name. LIKE INCLUDING ALL names
      // the copies itself (`projects_org_id_key_idx` for the source's
      // `app_projects_org_key_uidx`), and code that recognises a unique
      // violation by its index name (create-project's auto-key collision retry)
      // then fails in a worker schema only. Index names are per schema, so the
      // source names are free here.
      await restoreIndexNames(srcSchema, dstSchema)

      // 5. Clone SQL functions (e.g. RLS helper functions)
      // Runs AFTER table creation. Bodies are created with
      // check_function_bodies off (as pg_dump does): a LANGUAGE sql function
      // is otherwise validated at CREATE time, so one that calls a sibling
      // (kernel.resource_grant_role → kernel.has_role) fails whenever pg_proc
      // happens to return the callee after the caller. That order is the heap
      // order, which a CREATE OR REPLACE or a template copy can change.
      const funcs = await sql`
        SELECT p.proname, pg_get_functiondef(p.oid) AS def, pg_get_userbyid(p.proowner) AS owner
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = ${srcSchema} AND p.prokind = 'f'
      `
      for (const { proname, def, owner: srcFnOwner } of funcs) {
        const rewritten = rewriteFunctionSchema(def as string, srcSchema, dstSchema, keepLiterals)
        try {
          await sql.begin(async (tx) => {
            await tx.unsafe(`SET LOCAL check_function_bodies = off`)
            await tx.unsafe(rewritten)
          })
        } catch (err: any) {
          if (err.message?.includes("already exists")) continue
          throw err
        }
        // Grant execute to liaison_rls — query pg_proc for the exact argument types
        try {
          const [sig] = await sql`
            SELECT pg_catalog.pg_get_function_identity_arguments(p.oid) AS args
            FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = ${dstSchema} AND p.proname = ${proname}
            LIMIT 1
          `
          if (sig) {
            await sql.unsafe(
              `GRANT EXECUTE ON FUNCTION "${dstSchema}"."${proname}"(${sig.args}) TO liaison_rls`,
            )
            // Preserve the base function's owner (app functions are owned by
            // liaison_admin; per-org app re-registration does CREATE OR REPLACE
            // FUNCTION as liaison_admin, which requires function ownership).
            const fnOwner =
              srcFnOwner === "liaison_admin" ||
              srcFnOwner === "liaison_rls" ||
              srcFnOwner === "liaison_definer"
                ? srcFnOwner
                : "liaison_app"
            await sql.unsafe(
              `ALTER FUNCTION "${dstSchema}"."${proname}"(${sig.args}) OWNER TO ${fnOwner}`,
            )
          }
        } catch {
          // Non-fatal — function may have different ownership requirements
        }
      }

      await assertFunctionsCloned(srcSchema, dstSchema)

      // 6. Clone RLS policies and row-security settings from source tables
      const rlsTables = await sql`
        SELECT c.relname AS table_name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ${srcSchema} AND c.relkind = 'r' AND c.relrowsecurity = true
      `
      for (const { table_name: tableName } of rlsTables) {
        await sql.unsafe(`ALTER TABLE "${dstSchema}"."${tableName}" ENABLE ROW LEVEL SECURITY`)
        await sql.unsafe(`ALTER TABLE "${dstSchema}"."${tableName}" FORCE ROW LEVEL SECURITY`)

        // Clone each policy
        const policies = await sql`
          SELECT polname, polpermissive,
            CASE polcmd
              WHEN 'r' THEN 'SELECT'
              WHEN 'a' THEN 'INSERT'
              WHEN 'w' THEN 'UPDATE'
              WHEN 'd' THEN 'DELETE'
              ELSE 'ALL'
            END AS cmd,
            pg_get_expr(polqual, polrelid) AS using_expr,
            pg_get_expr(polwithcheck, polrelid) AS check_expr
          FROM pg_policy
          WHERE polrelid = (SELECT oid FROM pg_class WHERE relname = ${tableName}
            AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = ${srcSchema}))
        `
        for (const pol of policies) {
          const permissive = pol.polpermissive ? "PERMISSIVE" : "RESTRICTIVE"
          // Rewrite schema references in policy expressions: kernel.foo → w0_kernel.foo.
          // This schema and every one already cloned (kernel comes first), not
          // only this one: an app policy calling kernel.resource_grant_role
          // must judge the clone's grants. A schema cloned later does not
          // exist yet, so a reference to it keeps pointing at the source.
          const ready = clonedSchemas.slice(0, clonedSchemas.indexOf(srcSchema) + 1)
          const rewriteSchema = (expr: string | null) =>
            expr === null ? null : rewritePolicySchemas(expr, ready, prefix, keepLiterals)
          const usingExpr = rewriteSchema(pol.using_expr)
          const checkExpr = rewriteSchema(pol.check_expr)
          const usingClause = usingExpr ? `USING (${usingExpr})` : ""
          const checkClause = checkExpr ? `WITH CHECK (${checkExpr})` : ""
          try {
            await sql.unsafe(
              `CREATE POLICY "${pol.polname}" ON "${dstSchema}"."${tableName}" AS ${permissive} FOR ${pol.cmd} ${usingClause} ${checkClause}`,
            )
          } catch (err: any) {
            if (err.message?.includes("already exists")) continue
            throw err
          }
        }
      }

      // 7. Recreate cross-table foreign keys
      // NOTE: This query assumes single-column FKs. Multi-column composite FKs
      // would produce a cartesian product and create incorrect constraints.
      // Current kernel tables use only single-column FKs — if composite FKs are
      // added in the future, this query needs array_agg grouping by constraint_name.
      // pg_constraint carries the referential actions (confdeltype /
      // confupdtype) that information_schema does not expose conveniently. Join
      // it on constraint_name + the source schema's constrained relation so the
      // cloned FK reproduces the source's ON DELETE / ON UPDATE behavior instead
      // of silently degrading to NO ACTION (BL-203). The join is keyed by
      // (conname, conrelid in srcSchema), which is unique per single-column FK.
      const fks = await sql`
        SELECT
          tc.constraint_name,
          tc.table_name AS src_table,
          kcu.column_name AS src_column,
          ccu.table_schema AS ref_schema,
          ccu.table_name AS ref_table,
          ccu.column_name AS ref_column,
          con.confdeltype,
          con.confupdtype
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON kcu.constraint_name = tc.constraint_name AND kcu.constraint_schema = tc.constraint_schema
        JOIN information_schema.constraint_column_usage ccu
          ON ccu.constraint_name = tc.constraint_name AND ccu.constraint_schema = tc.constraint_schema
        JOIN pg_constraint con
          ON con.conname = tc.constraint_name
          AND con.contype = 'f'
          AND con.conrelid = (
            SELECT c.oid FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = tc.table_schema AND c.relname = tc.table_name
          )
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.constraint_schema = ${srcSchema}
          AND tc.table_name != ccu.table_name
      `
      for (const fk of fks) {
        const fkName = clonedConstraintName(prefix, fk.constraint_name)
        // Cross-schema FKs (e.g. app_tickets.ticket_reads → kernel.users) must
        // resolve to the worker-prefixed mirror of the referenced schema, not
        // assume the referenced table lives in the same schema as the source.
        const refSchema = `${prefix}${fk.ref_schema}`
        // Carry the source FK's referential actions through the clone. NO ACTION
        // (code 'a') maps to an empty clause and is Postgres' default, so an
        // omitted clause and an explicit NO ACTION are equivalent.
        const onDelete = referentialActionClause("ON DELETE", fk.confdeltype)
        const onUpdate = referentialActionClause("ON UPDATE", fk.confupdtype)
        try {
          await sql.unsafe(
            `ALTER TABLE ${quoteIdent(dstSchema)}.${quoteIdent(fk.src_table)} ADD CONSTRAINT ${quoteIdent(fkName)}
             FOREIGN KEY (${quoteIdent(fk.src_column)}) REFERENCES ${quoteIdent(refSchema)}.${quoteIdent(fk.ref_table)} (${quoteIdent(fk.ref_column)})${onDelete}${onUpdate}`,
          )
        } catch (err: any) {
          if (err.message?.includes("already exists")) continue
          throw err
        }
      }
    }

    // 8. Copy the registry rows. LIKE copies no rows, but a few kernel tables
    // are schema, not data: their rows are written by migrations and name
    // schema objects by OID (`kernel.shareable_resource_types` maps a resource
    // type to its can_manage function and its table). An empty registry in
    // the clone makes every sharing write fail its RLS check, and a copied row
    // still pointing at the SOURCE schema's function would judge the source
    // schema's rows. Each object reference is re-pointed at the clone's
    // namespace mirror.
    await copyRegistryRows(prefix, clonedSchemas)
  }

  /** The shareable resource type names, which look like `kernel.<name>` but are values. */
  async function registryValueLiterals(): Promise<string[]> {
    const [exists] =
      await sql`SELECT to_regclass('kernel.shareable_resource_types') IS NOT NULL AS ok`
    if (!exists?.ok) return []
    const rows = await sql`SELECT resource_type FROM kernel.shareable_resource_types`
    return rows.map((r) => r.resource_type as string)
  }

  /** Tables with a regclass / regproc / regprocedure column, copied with each reference mapped into the clone. */
  async function copyRegistryRows(prefix: string, srcSchemas: string[]): Promise<void> {
    const cols = await sql<
      { table_schema: string; table_name: string; column_name: string; udt_name: string }[]
    >`
      SELECT c.table_schema, c.table_name, c.column_name, c.udt_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE t.table_type = 'BASE TABLE' AND c.table_schema IN ${sql(srcSchemas)}
      ORDER BY c.table_schema, c.table_name, c.ordinal_position
    `
    const tables = new Map<string, Array<{ name: string; type: string }>>()
    for (const c of cols) {
      const key = `${c.table_schema}\0${c.table_name}`
      const list = tables.get(key) ?? []
      list.push({ name: c.column_name, type: c.udt_name })
      tables.set(key, list)
    }
    const literal = (v: string) => `'${v.replace(/'/g, "''")}'`
    const cloned = srcSchemas.map(literal).join(", ")
    // The namespace an object lives in, mapped onto the clone when it is a cloned schema.
    const ns = `CASE WHEN n.nspname IN (${cloned}) THEN ${literal(prefix)} || n.nspname ELSE n.nspname END`
    for (const [key, columns] of tables) {
      if (!columns.some((c) => ["regclass", "regproc", "regprocedure"].includes(c.type))) continue
      const [srcSchema, table] = key.split("\0") as [string, string]
      const exprs = columns.map(({ name, type }) => {
        const col = `src.${quoteIdent(name)}`
        if (type === "regclass") {
          return `(SELECT format('%I.%I', ${ns}, k.relname) FROM pg_class k JOIN pg_namespace n ON n.oid = k.relnamespace WHERE k.oid = ${col})::regclass`
        }
        if (type === "regprocedure") {
          return `(SELECT format('%I.%I(%s)', ${ns}, p.proname, oidvectortypes(p.proargtypes)) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE p.oid = ${col})::regprocedure`
        }
        if (type === "regproc") {
          return `(SELECT format('%I.%I', ${ns}, p.proname) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE p.oid = ${col})::regproc`
        }
        return col
      })
      await sql.unsafe(
        `INSERT INTO ${quotePrefixedIdent(prefix, `${prefix}${srcSchema}`)}.${quoteIdent(table)} (${columns.map((c) => quoteIdent(c.name)).join(", ")})
         SELECT ${exprs.join(", ")} FROM ${quoteIdent(srcSchema)}.${quoteIdent(table)} AS src
         ON CONFLICT DO NOTHING`,
      )
    }
  }

  async function dropWorkerSchemas(workerId: number): Promise<void> {
    return dropSchemasByPrefix(`w${workerId}_`)
  }

  async function dropSchemasByPrefix(prefix: string): Promise<void> {
    assertSafePrefix(prefix)
    const schemas = await sql`
      SELECT schema_name FROM information_schema.schemata
      WHERE schema_name LIKE ${prefixedLikePattern(prefix)} ESCAPE '\\'
    `
    // DROP SCHEMA takes an ACCESS EXCLUSIVE lock, so one surviving session on a
    // worker schema (a server that has not exited yet, a leaked pool connection)
    // blocks it FOREVER by default: the teardown HUNG rather than failing, which
    // is how a Playwright lane ran past its cap with nothing in the log. Each
    // drop runs in its own transaction with a LOCAL lock_timeout (transaction
    // scoped, so it cannot leak onto a pooled connection), and a blocked schema
    // is reported at the end instead of silently stopping the sweep: the next
    // run's prefix sweep reclaims whatever is left.
    const blocked: string[] = []
    for (const { schema_name } of schemas) {
      const ident = quotePrefixedIdent(prefix, schema_name)
      try {
        await sql.begin(async (tx) => {
          await tx.unsafe(`SET LOCAL lock_timeout = '15s'`)
          await tx.unsafe(`DROP SCHEMA IF EXISTS ${ident} CASCADE`)
        })
      } catch (err) {
        blocked.push(`${schema_name}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    if (blocked.length > 0) {
      throw new Error(
        `dropSchemasByPrefix(${prefix}): could not drop ${blocked.length} schema(s) within the lock timeout (a session is still holding them): ${blocked.join("; ")}`,
      )
    }
  }

  async function grantWorkerSchemas(workerId: number): Promise<void> {
    return grantSchemasByPrefix(`w${workerId}_`)
  }

  async function grantSchemasByPrefix(prefix: string): Promise<void> {
    assertSafePrefix(prefix)
    const schemas = await sql`
      SELECT schema_name FROM information_schema.schemata
      WHERE schema_name LIKE ${prefixedLikePattern(prefix)} ESCAPE '\\'
    `
    for (const { schema_name } of schemas) {
      await sql.unsafe(
        `GRANT ALL ON SCHEMA ${quotePrefixedIdent(prefix, schema_name)} TO liaison_app, liaison_admin, liaison_rls`,
      )
      await sql.unsafe(
        `GRANT ALL ON ALL TABLES IN SCHEMA ${quotePrefixedIdent(prefix, schema_name)} TO liaison_app, liaison_admin, liaison_rls`,
      )
      await sql.unsafe(
        `GRANT ALL ON ALL SEQUENCES IN SCHEMA ${quotePrefixedIdent(prefix, schema_name)} TO liaison_app, liaison_admin, liaison_rls`,
      )
      // Transfer table ownership to MATCH the base schema's real per-table
      // owner. This matters because per-org app re-registration and several
      // boot passes (e.g. `rebuildFilesSelectPolicy`) run ownership-gated DDL
      // (DROP/CREATE POLICY, CREATE INDEX, ALTER … FORCE RLS) as liaison_admin
      // via `withSchemaAdmin`; Postgres only allows that DDL to the table owner.
      // In base/production those tables are owned by liaison_admin (every app
      // table, plus the secrets/DDL-managed kernel tables: files, connected_
      // accounts, mcp_connections, agent_runs, sub_agent_definitions, …), so the
      // clone must reproduce that exactly or registration/boot DDL rolls back
      // with "must be owner". Tables the migration left owned by the bootstrap
      // superuser (most of kernel) fall back to liaison_app, the runtime login
      // role — they are never re-DDL'd at runtime and both liaison roles carry
      // BYPASSRLS + the schema-wide GRANTs above. LIKE/clone did not copy owner.
      const srcSchemaName = schema_name.slice(prefix.length)
      const OWNER_ALLOWLIST = new Set(["liaison_admin", "liaison_app", "liaison_rls"])
      // The schema itself too: app registration stamps its DDL with COMMENT ON SCHEMA as
      // liaison_admin, which only the schema owner may do. A clone created by the superuser
      // left every app schema that already existed in the base owned by postgres, so that
      // app's registration failed with "must be owner of schema" on every worker.
      const [baseSchema] = (await sql`
        SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = ${srcSchemaName}
      `) as unknown as Array<{ owner: string }>
      if (baseSchema && OWNER_ALLOWLIST.has(baseSchema.owner)) {
        await sql.unsafe(
          `ALTER SCHEMA ${quotePrefixedIdent(prefix, schema_name)} OWNER TO ${baseSchema.owner}`,
        )
      }
      const baseOwners = (await sql`
        SELECT tablename, tableowner FROM pg_tables WHERE schemaname = ${srcSchemaName}
      `) as unknown as Array<{ tablename: string; tableowner: string }>
      for (const { tablename, tableowner } of baseOwners) {
        const owner = OWNER_ALLOWLIST.has(tableowner) ? tableowner : "liaison_app"
        try {
          await sql.unsafe(
            `ALTER TABLE ${quotePrefixedIdent(prefix, schema_name)}.${quoteIdent(tablename)} OWNER TO ${owner}`,
          )
        } catch {
          /* best-effort — table may not have been cloned into this worker schema */
        }
      }
      await copyDefinerGrants(prefix, schema_name, srcSchemaName)
    }
  }

  /**
   * The SECURITY DEFINER functions of migration 0178 run as liaison_definer,
   * which holds a few table and column rights and nothing else. A clone gets
   * exactly those rights on its copies (the blanket GRANT ALL above names the
   * runtime roles only), so a function that needs a right the migration did
   * not give fails in a worker schema as it would in production.
   */
  async function copyDefinerGrants(
    prefix: string,
    cloneSchema: string,
    srcSchema: string,
  ): Promise<void> {
    const [definer] = await sql`SELECT 1 FROM pg_roles WHERE rolname = 'liaison_definer'`
    if (!definer) return
    await sql.unsafe(
      `GRANT USAGE ON SCHEMA ${quotePrefixedIdent(prefix, cloneSchema)} TO liaison_definer`,
    )
    const tableGrants = (await sql`
      SELECT table_name, privilege_type FROM information_schema.role_table_grants
       WHERE grantee = 'liaison_definer' AND table_schema = ${srcSchema}
    `) as unknown as Array<{ table_name: string; privilege_type: string }>
    for (const g of tableGrants) {
      await sql.unsafe(
        `GRANT ${g.privilege_type} ON ${quotePrefixedIdent(prefix, cloneSchema)}.${quoteIdent(g.table_name)} TO liaison_definer`,
      )
    }
    const columnGrants = (await sql`
      SELECT c.table_name, c.column_name, c.privilege_type
        FROM information_schema.column_privileges c
       WHERE c.grantee = 'liaison_definer' AND c.table_schema = ${srcSchema}
         AND NOT EXISTS (
           SELECT 1 FROM information_schema.role_table_grants t
            WHERE t.grantee = c.grantee AND t.table_schema = c.table_schema
              AND t.table_name = c.table_name AND t.privilege_type = c.privilege_type)
    `) as unknown as Array<{ table_name: string; column_name: string; privilege_type: string }>
    for (const g of columnGrants) {
      await sql.unsafe(
        `GRANT ${g.privilege_type} (${quoteIdent(g.column_name)}) ON ${quotePrefixedIdent(prefix, cloneSchema)}.${quoteIdent(g.table_name)} TO liaison_definer`,
      )
    }
    const sequenceGrants = (await sql`
      SELECT c.relname AS sequence_name
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind = 'S' AND n.nspname = ${srcSchema}
         AND EXISTS (SELECT 1 FROM aclexplode(c.relacl) a
                      WHERE a.grantee = 'liaison_definer'::regrole AND a.privilege_type = 'USAGE')
    `) as unknown as Array<{ sequence_name: string }>
    for (const g of sequenceGrants) {
      await sql.unsafe(
        `GRANT USAGE ON SEQUENCE ${quotePrefixedIdent(prefix, cloneSchema)}.${quoteIdent(g.sequence_name)} TO liaison_definer`,
      )
    }
  }

  async function truncateAll(schemaPrefix?: string): Promise<void> {
    const ks = `${schemaPrefix ?? ""}kernel`

    // Drop app schemas
    const appSchemas = await sql`
      SELECT schema_name FROM information_schema.schemata
      WHERE schema_name LIKE ${`${schemaPrefix ? prefixedLikePattern(schemaPrefix).slice(0, -1) : ""}app\\_%`} ESCAPE '\\'
    `
    for (const { schema_name } of appSchemas) {
      await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema_name}" CASCADE`)
    }

    // Truncate all kernel tables
    const tables = await sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = ${ks} AND table_type = 'BASE TABLE'
    `
    if (tables.length > 0) {
      const qualifiedNames = tables.map((t: any) => `"${ks}"."${t.table_name}"`).join(", ")
      await sql.unsafe(`TRUNCATE ${qualifiedNames} CASCADE`)
    }

    // Reset thread handle sequence
    await sql.unsafe(`ALTER SEQUENCE IF EXISTS "${ks}".thread_handle_seq RESTART WITH 1`)

    // Ensure app and RLS roles keep access after local resets.
    await sql.unsafe(`GRANT USAGE ON SCHEMA "${ks}" TO liaison_app`)
    await sql.unsafe(`GRANT ALL ON ALL TABLES IN SCHEMA "${ks}" TO liaison_app`)
    await sql.unsafe(`GRANT ALL ON ALL SEQUENCES IN SCHEMA "${ks}" TO liaison_app`)
    await sql.unsafe(`DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'liaison_rls') THEN
        EXECUTE format('GRANT USAGE ON SCHEMA %I TO liaison_rls', '${ks}');
        EXECUTE format('GRANT ALL ON ALL TABLES IN SCHEMA %I TO liaison_rls', '${ks}');
        EXECUTE format('GRANT ALL ON ALL SEQUENCES IN SCHEMA %I TO liaison_rls', '${ks}');
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'liaison_admin') THEN
        EXECUTE format('GRANT USAGE ON SCHEMA %I TO liaison_admin', '${ks}');
        EXECUTE format('GRANT ALL ON ALL TABLES IN SCHEMA %I TO liaison_admin', '${ks}');
        EXECUTE format('GRANT ALL ON ALL SEQUENCES IN SCHEMA %I TO liaison_admin', '${ks}');
      END IF;
    END $$`)
  }

  async function close(): Promise<void> {
    await sql.end()
  }

  return {
    sql,
    cloneSchemas,
    cloneSchemasByPrefix,
    dropWorkerSchemas,
    dropSchemasByPrefix,
    grantWorkerSchemas,
    grantSchemasByPrefix,
    assertSafePrefix,
    truncateAll,
    close,
  }
}

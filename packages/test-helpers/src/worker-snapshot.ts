// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Data snapshots of one e2e worker's `w<N>_*` schemas.
 *
 * A shared e2e lane (e2e-lane.ts) boots its API server once and hands it to
 * file after file. Between files the worker's data goes back to the state it
 * had right after boot (org + admin bootstrapped, default apps registered),
 * which is what a fresh `createWorkerEnv` + `TestWorld.create` produced, minus
 * the schema clone and the server boot.
 *
 * The snapshot copies every non-empty table into `snap_w<N>` (deliberately NOT
 * `w<N>_snap`: the `w<N>_` prefix is what the worker's own sweeps, grants and
 * search paths enumerate). Restoring empties every table that holds rows now
 * or held rows then, reinserts the snapshot rows, resets every sequence, and
 * drops the schemas created since (a runtime app install). Both run as ONE
 * plpgsql block each, so the cost is one round trip, not one per table.
 *
 * Restore runs with `session_replication_role = replica`: the foreign-key and
 * user triggers stay quiet while tables are emptied and refilled in an order
 * that ignores their dependencies, which also keeps append-only guards (audit
 * trails that refuse DELETE) from rejecting the reset.
 */
import type postgres from "postgres"

type Sql = ReturnType<typeof postgres>

export function snapshotSchemaFor(workerId: number): string {
  if (!Number.isInteger(workerId) || workerId < 0) throw new Error(`bad workerId ${workerId}`)
  return `snap_w${workerId}`
}

function likePattern(workerId: number): string {
  return `w${workerId}\\_%`
}

export async function snapshotWorkerData(sql: Sql, workerId: number): Promise<void> {
  const snap = snapshotSchemaFor(workerId)
  const like = likePattern(workerId)
  await sql.unsafe(`
    DO $snap$
    DECLARE
      r record;
      i int := 0;
      cols text;
      has_rows boolean;
      lv bigint;
      called boolean;
    BEGIN
      EXECUTE 'DROP SCHEMA IF EXISTS ${snap} CASCADE';
      EXECUTE 'CREATE SCHEMA ${snap}';
      CREATE TABLE ${snap}.__manifest (idx int, nsp text, rel text, cols text);
      CREATE TABLE ${snap}.__schemas (nsp text);
      CREATE TABLE ${snap}.__seqs (nsp text, rel text, last_value bigint, is_called boolean);

      INSERT INTO ${snap}.__schemas
        SELECT nspname FROM pg_namespace WHERE nspname LIKE '${like}';

      FOR r IN
        SELECT n.nspname, c.relname, c.oid
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname LIKE '${like}' AND c.relkind = 'r'
        ORDER BY n.nspname, c.relname
      LOOP
        i := i + 1;
        SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO cols
        FROM pg_attribute
        WHERE attrelid = r.oid AND attnum > 0 AND NOT attisdropped AND attgenerated = '';
        EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.%I)', r.nspname, r.relname) INTO has_rows;
        IF has_rows THEN
          EXECUTE format('CREATE TABLE ${snap}.t%s AS SELECT %s FROM %I.%I', i, cols, r.nspname, r.relname);
        END IF;
        INSERT INTO ${snap}.__manifest VALUES (i, r.nspname, r.relname, CASE WHEN has_rows THEN cols END);
      END LOOP;

      FOR r IN
        SELECT n.nspname, c.relname
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname LIKE '${like}' AND c.relkind = 'S'
      LOOP
        EXECUTE format('SELECT last_value, is_called FROM %I.%I', r.nspname, r.relname) INTO lv, called;
        INSERT INTO ${snap}.__seqs VALUES (r.nspname, r.relname, lv, called);
      END LOOP;
    END
    $snap$
  `)
}

/**
 * Restore a worker's data to its snapshot. A deadlock is retried: the backend
 * of a server just stopped can still be finishing a query against the tables
 * this empties, and Postgres aborts one side of that cycle. Its transaction
 * rolled back whole, so running it again is safe.
 */
export async function restoreWorkerData(sql: Sql, workerId: number): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await restoreWorkerDataOnce(sql, workerId)
      return
    } catch (err) {
      if ((err as { code?: string }).code !== "40P01" || attempt >= 3) throw err
      await new Promise((r) => setTimeout(r, 200 * attempt))
    }
  }
}

async function restoreWorkerDataOnce(sql: Sql, workerId: number): Promise<void> {
  const snap = snapshotSchemaFor(workerId)
  const like = likePattern(workerId)
  await sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL session_replication_role = replica`)
    // A server mid-transaction on a table holds a lock the DELETE waits on;
    // fail loudly instead of hanging the lane.
    await tx.unsafe(`SET LOCAL lock_timeout = '20s'`)
    await tx.unsafe(`
      DO $restore$
      DECLARE
        r record;
        has_rows boolean;
      BEGIN
        -- Schemas that did not exist at snapshot time (a runtime app install).
        FOR r IN
          SELECT nspname FROM pg_namespace
          WHERE nspname LIKE '${like}'
            AND nspname NOT IN (SELECT nsp FROM ${snap}.__schemas)
        LOOP
          EXECUTE format('DROP SCHEMA %I CASCADE', r.nspname);
        END LOOP;

        -- Empty every table that has rows now (partitions are emptied through
        -- their parent's leaf rows: relkind 'r' covers both).
        FOR r IN
          SELECT n.nspname, c.relname
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname LIKE '${like}' AND c.relkind = 'r'
        LOOP
          EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.%I)', r.nspname, r.relname) INTO has_rows;
          IF has_rows THEN
            EXECUTE format('DELETE FROM %I.%I', r.nspname, r.relname);
          END IF;
        END LOOP;

        FOR r IN SELECT * FROM ${snap}.__manifest WHERE cols IS NOT NULL ORDER BY idx LOOP
          IF to_regclass(format('%I.%I', r.nsp, r.rel)) IS NOT NULL THEN
            EXECUTE format(
              'INSERT INTO %I.%I (%s) OVERRIDING SYSTEM VALUE SELECT %s FROM ${snap}.t%s',
              r.nsp, r.rel, r.cols, r.cols, r.idx
            );
          END IF;
        END LOOP;

        FOR r IN SELECT * FROM ${snap}.__seqs LOOP
          IF to_regclass(format('%I.%I', r.nsp, r.rel)) IS NOT NULL THEN
            PERFORM setval(format('%I.%I', r.nsp, r.rel)::regclass, r.last_value, r.is_called);
          END IF;
        END LOOP;
      END
      $restore$
    `)
  })
}

export async function dropWorkerSnapshot(sql: Sql, workerId: number): Promise<void> {
  await sql.unsafe(`DROP SCHEMA IF EXISTS ${snapshotSchemaFor(workerId)} CASCADE`)
}

/**
 * The installed-app fingerprint of a worker: a runtime install leaves an
 * `apps_installed` row and an in-process registration behind, and the second
 * one survives a data restore. A lane compares this against its snapshot to
 * know when its server must be restarted, not merely have its data reset.
 */
export async function installedAppsFingerprint(sql: Sql, workerId: number): Promise<string> {
  const table = `"w${workerId}_kernel".apps_installed`
  const exists = await sql.unsafe(`SELECT to_regclass('${table}') IS NOT NULL AS ok`)
  if (!exists[0]?.ok) return ""
  const rows = await sql.unsafe(`SELECT name FROM ${table} ORDER BY name`)
  return rows.map((r) => String(r.name)).join(",")
}

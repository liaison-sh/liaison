// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Schema-only worker isolation primitive.
 *
 * Wraps `cloneSchemas` + `grantWorkerSchemas` from `db.ts` to give each
 * bun:test worker its own `w${id}_*` schemas without booting a full server.
 * Used by the parallel integration suite — leaner than `createWorkerEnv`
 * since integration tests hit the DB directly without HTTP routes.
 *
 * The returned `WorkerSchema` exposes:
 *   - `sql`     — postgres.js handle scoped to this worker via `search_path`
 *   - `enter()` — set search_path to `w${id}_public,public` on the singleton's pool
 *   - `exit()`  — clear the search_path override
 *
 * `enter()`/`exit()` operate on a side-channel env var
 * `PG_WORKER_SEARCH_PATH` that the production singleton (apps/api/src/db/client.ts)
 * applies at connect time. Existing connections continue using the previously
 * configured search_path; new ones pick up the override.
 */

import postgres from "postgres"
import { createDbClient, type DbClient } from "./db"
import { resolveTestCoordinates } from "./test-namespace"

export interface WorkerSchema {
  workerId: number
  schemaPrefix: string
  sql: ReturnType<typeof postgres>
  client: DbClient
  enter(): Promise<void>
  exit(): Promise<void>
  close(): Promise<void>
}

export async function createWorkerSchema(workerId: number): Promise<WorkerSchema> {
  // Superuser DB URL is required — schema clone needs CREATEROLE/ALTER ROLE
  // privileges that liaison_app deliberately lacks. Match the precedent set by
  // worker-env.test.ts / db.test.ts.
  const url =
    process.env.E2E_DATABASE_URL ??
    process.env.DATABASE_URL_SUPERUSER ??
    resolveTestCoordinates().superuserUrl()
  const client = createDbClient(url)
  await client.cloneSchemas(workerId)
  await client.grantWorkerSchemas(workerId)

  const schemaPrefix = `w${workerId}_`
  // Per-worker sql handle with search_path pinned to the worker's schemas.
  // Cover every schema cloneSchemas might produce (public, kernel, plus any
  // app_* tenant schemas) by widening to ALL `w${id}_*` plus a public fallback.
  const searchPath = `${schemaPrefix}public, ${schemaPrefix}kernel, ${schemaPrefix}app_projects, ${schemaPrefix}app_tickets, ${schemaPrefix}app_mail, ${schemaPrefix}app_contacts, ${schemaPrefix}app_threads, public`
  // search_path is a startup parameter, so every connection the handle opens
  // carries it. A one-off `SET` covered only the first: once the connection
  // closed on its idle timeout (while another worker's clone ran past it), the
  // reconnect fell back to the server default and the worker's tables vanished.
  const sql = postgres(url, {
    max: 1,
    idle_timeout: 10,
    connect_timeout: 10,
    connection: { search_path: searchPath },
    onnotice: () => {},
  })

  async function enter(): Promise<void> {
    process.env.PG_WORKER_SEARCH_PATH = searchPath
  }

  async function exit(): Promise<void> {
    if (process.env.PG_WORKER_SEARCH_PATH === searchPath) {
      delete process.env.PG_WORKER_SEARCH_PATH
    }
  }

  async function close(): Promise<void> {
    await sql.end()
    await client.close()
  }

  return { workerId, schemaPrefix, sql, client, enter, exit, close }
}

export async function dropWorkerSchema(workerId: number): Promise<void> {
  // Superuser DB URL is required — schema clone needs CREATEROLE/ALTER ROLE
  // privileges that liaison_app deliberately lacks. Match the precedent set by
  // worker-env.test.ts / db.test.ts.
  const url =
    process.env.E2E_DATABASE_URL ??
    process.env.DATABASE_URL_SUPERUSER ??
    resolveTestCoordinates().superuserUrl()
  const client = createDbClient(url)
  try {
    await client.dropWorkerSchemas(workerId)
  } finally {
    await client.close()
  }
}

/**
 * Drop orphan worker schemas left behind by crashed runs.
 * "Orphan" = any `w*_public` schema whose latest object mtime is older than
 * `olderThanMs`. Returns the list of dropped schema names (lowercase).
 */
export async function sweepOrphanSchemas(opts: { olderThanMs: number }): Promise<string[]> {
  // Superuser DB URL is required — schema clone needs CREATEROLE/ALTER ROLE
  // privileges that liaison_app deliberately lacks. Match the precedent set by
  // worker-env.test.ts / db.test.ts.
  const url =
    process.env.E2E_DATABASE_URL ??
    process.env.DATABASE_URL_SUPERUSER ??
    resolveTestCoordinates().superuserUrl()
  const sql = postgres(url, {
    max: 1,
    idle_timeout: 10,
    connect_timeout: 10,
    onnotice: () => {},
  })
  const dropped: string[] = []
  try {
    const cutoffMs = Date.now() - opts.olderThanMs
    // pg_namespace doesn't track schema mtimes, so we approximate via the
    // oldest pg_class entry inside the schema. Empty schemas (no relations)
    // fall back to NOW() and are not considered orphans.
    const rows = await sql<{ nspname: string; latest_change: Date | null }[]>`
      SELECT n.nspname,
             (
               SELECT to_timestamp(GREATEST(MAX(c.relfrozenxid::text::bigint), 0))
               FROM pg_class c
               WHERE c.relnamespace = n.oid
             ) AS latest_change
      FROM pg_namespace n
      WHERE n.nspname ~ '^w[0-9]+_'
    `
    for (const row of rows) {
      const m = row.nspname.match(/^w(\d+)_/)
      if (!m) continue
      const workerId = Number(m[1])
      const lastMs = row.latest_change ? row.latest_change.getTime() : Date.now()
      if (lastMs < cutoffMs) {
        const client = createDbClient(url)
        try {
          await client.dropWorkerSchemas(workerId)
          dropped.push(row.nspname.toLowerCase())
        } finally {
          await client.close()
        }
      }
    }
  } finally {
    await sql.end()
  }
  return dropped
}

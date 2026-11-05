// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Building the warehouse: the DDL, the rows and the warehouse's own login.
//
// This is the one step that needs more than the application's own privileges,
// because it creates a schema and a role, so it runs over the DEPLOYMENT'S
// migration DSN (`MIGRATION_DATABASE_URL`). The deploy-time seed (run with
// `docker compose exec`) carries it; the serving process does not, so the
// request path never gets DDL privilege. The login it converges is named by
// `LIAISON_DEMO_WAREHOUSE_DATABASE_URL` (user and password), a role in no
// Liaison role with SELECT on the warehouse schema only.
//
// It is idempotent by construction rather than by upsert: the DDL is
// CREATE ... IF NOT EXISTS, the load TRUNCATEs first, and the grants are
// re-applied every time. A re-deploy converges; a nightly reset converges; a
// half finished run is repaired by the next one.
//
// It is also SHARED. There is one warehouse on the box, not one per demo org:
// the data is a fictional company's books, every demo org reads the same books,
// and the per-org part is only the connection row that points at them. That is
// why a visitor signup does not pay for a warehouse build.

import postgres from "postgres"
import { rootLogger } from "~/lib/logger"
import { buildDemoWarehouseDataset, demoWarehouseContentHash, HISTORY_MONTHS } from "./dataset"
import {
  DEMO_WAREHOUSE_BUILD_TABLE,
  DEMO_WAREHOUSE_DDL,
  DEMO_WAREHOUSE_TABLES,
  demoWarehouseGrants,
} from "./schema"
import {
  DEMO_WAREHOUSE_DSN_ENV,
  DEMO_WAREHOUSE_LOGIN_PATTERN,
  DEMO_WAREHOUSE_SCHEMA,
} from "./sentinel"

const log = rootLogger.child({ module: "demo-warehouse" })

export class DemoWarehouseProvisionError extends Error {
  constructor(
    message: string,
    /** `no_admin_dsn`: this process holds no privileged DSN, so it cannot
     *  build; the warehouse a deploy-time seed built may still be served. */
    readonly code: "no_admin_dsn" | "invalid" = "invalid",
  ) {
    super(message)
    this.name = "DemoWarehouseProvisionError"
  }
}

/** Rows per INSERT. Large enough to be quick, small enough to stay under the
 *  bind-parameter ceiling for the widest table (orders, sixteen columns). */
const CHUNK = 500

/** The user name and password a Postgres DSN carries. */
function credentialsFromDsn(dsn: string, what: string): { user: string; password: string } {
  try {
    const url = new URL(dsn.replace(/^postgres(ql)?:\/\//, "http://"))
    return { user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) }
  } catch {
    throw new DemoWarehouseProvisionError(`could not read the role from ${what}`)
  }
}

/**
 * The warehouse's own login and password, from its DSN. The role name must
 * match the warehouse prefix: provisioning rewrites this role's password and
 * attributes, so a DSN naming the application's login (or any real role) is
 * refused rather than reconfigured.
 */
export function warehouseLoginFromDsn(
  dsn: string,
  appDsn?: string,
): { role: string; password: string } {
  const { user, password } = credentialsFromDsn(dsn, DEMO_WAREHOUSE_DSN_ENV)
  if (!DEMO_WAREHOUSE_LOGIN_PATTERN.test(user)) {
    throw new DemoWarehouseProvisionError(
      `${DEMO_WAREHOUSE_DSN_ENV} must name a dedicated login role whose name starts with liaison_demo_warehouse`,
    )
  }
  if (appDsn && user === credentialsFromDsn(appDsn, "DATABASE_URL").user) {
    throw new DemoWarehouseProvisionError(
      `${DEMO_WAREHOUSE_DSN_ENV} must not use the application's own login`,
    )
  }
  if (password.length < 16) {
    throw new DemoWarehouseProvisionError(
      `${DEMO_WAREHOUSE_DSN_ENV} needs a generated password of at least 16 characters`,
    )
  }
  return { role: user, password }
}

export interface ProvisionDemoWarehouseOptions {
  /** Superuser/owner DSN. Defaults to MIGRATION_DATABASE_URL. */
  adminDsn?: string
  /** The runtime DSN; only used to refuse a warehouse login equal to it. */
  appDsn?: string
  /** The warehouse's own DSN. Defaults to LIAISON_DEMO_WAREHOUSE_DATABASE_URL. */
  warehouseDsn?: string
  /** Anchor for the generated history. Defaults to now. */
  now?: Date
  /** Rebuild even when the build stamp says the warehouse is already current. */
  force?: boolean
  log?: (message: string) => void
}

export interface ProvisionDemoWarehouseResult {
  schema: string
  role: string
  counts: Record<string, number>
  /** False when the warehouse was already current and the load was skipped. */
  rebuilt: boolean
}

async function applyGrants(
  sql: ReturnType<typeof postgres>,
  login: { role: string; password: string },
): Promise<void> {
  const rows = await sql.unsafe("SELECT quote_literal($1::text) AS lit", [
    login.password,
  ] as never[])
  const literal = (rows as unknown as { lit: string }[])[0]?.lit
  if (!literal) throw new DemoWarehouseProvisionError("could not quote the warehouse password")
  await sql.unsafe(demoWarehouseGrants(login.role, literal))
}

/**
 * Create (or converge) the demo warehouse and its read-only role, and load the
 * generated dataset. Throws `DemoWarehouseProvisionError` when the deployment
 * has no privileged DSN: the caller decides whether that is fatal.
 */
export async function provisionDemoWarehouse(
  opts: ProvisionDemoWarehouseOptions = {},
): Promise<ProvisionDemoWarehouseResult> {
  const adminDsn = opts.adminDsn ?? process.env.MIGRATION_DATABASE_URL
  const appDsn = opts.appDsn ?? process.env.DATABASE_URL
  if (!adminDsn) {
    throw new DemoWarehouseProvisionError(
      "MIGRATION_DATABASE_URL is not set in this process, so the demo warehouse schema and its read-only login cannot be built here.",
      "no_admin_dsn",
    )
  }
  const warehouseDsn = opts.warehouseDsn ?? process.env[DEMO_WAREHOUSE_DSN_ENV]
  if (!warehouseDsn) {
    throw new DemoWarehouseProvisionError(
      `${DEMO_WAREHOUSE_DSN_ENV} is not set, so the demo warehouse has no dedicated read-only login. The oracle stays unconnected until the deploy supplies it.`,
    )
  }
  const login = warehouseLoginFromDsn(warehouseDsn, appDsn)
  const say = opts.log ?? ((m: string) => log.info({}, m))

  const now = opts.now ?? new Date()
  const dataset = buildDemoWarehouseDataset(now)
  const rowTotal = DEMO_WAREHOUSE_TABLES.reduce((n, t) => n + (dataset[t] as unknown[]).length, 0)
  const contentHash = demoWarehouseContentHash(dataset)
  const sql = postgres(adminDsn, { max: 2, idle_timeout: 20, onnotice: () => {} })
  try {
    await sql.unsafe(DEMO_WAREHOUSE_DDL)
    say(`warehouse: schema ${DEMO_WAREHOUSE_SCHEMA} is present`)

    // THE STAMP IS READ FIRST, AND NOTHING IS DESTROYED BEFORE IT IS.
    //
    // A visitor signup runs the whole demo seed, and rebuilding ten thousand
    // rows behind an HTTP response for a warehouse that is already correct is
    // how a demo box spends its afternoon. So a warehouse built today, at the
    // size today's generator produces, is reused. Ordering this check AFTER the
    // truncate (which is where it started) emptied the warehouse and then
    // reported "nothing to do": every read after the second seed of the day
    // came back with no rows, which is the same symptom as the bug this whole
    // layer exists to fix.
    const stamp = await sql.unsafe(
      `SELECT built_on::text AS built_on, row_total, content_hash FROM ${DEMO_WAREHOUSE_SCHEMA}.${DEMO_WAREHOUSE_BUILD_TABLE} WHERE id = 1`,
    )
    const current = (
      stamp as unknown as { built_on: string; row_total: number; content_hash: string | null }[]
    )[0]
    const today = now.toISOString().slice(0, 10)
    // The date and the row count are not enough, and believing they were is how
    // a deploy that renamed EVERY product shipped a warehouse still serving the
    // previous catalog: same day, same eleven products, same row total, so the
    // stamp matched and the load was skipped. The hash makes this "already built
    // FROM THIS DATASET" rather than "already built, at some size".
    if (
      opts.force !== true &&
      current?.built_on === today &&
      current.row_total === rowTotal &&
      current.content_hash === contentHash
    ) {
      await applyGrants(sql, login)
      say(`warehouse: already built today with ${rowTotal} rows, grants re-applied`)
      return {
        schema: DEMO_WAREHOUSE_SCHEMA,
        role: login.role,
        counts: Object.fromEntries(
          DEMO_WAREHOUSE_TABLES.map((t) => [t, (dataset[t] as unknown[]).length]),
        ),
        rebuilt: false,
      }
    }

    // ONE TRANSACTION for the clear, the load and the stamp. A demo org may be
    // reading the warehouse while a nightly reset rebuilds it, and a crash
    // halfway through a load must not leave an empty warehouse wearing a valid
    // build stamp (which the next run would then happily reuse).
    const counts: Record<string, number> = {}
    await sql.begin(async (tx) => {
      // Reverse dependency order is not needed with CASCADE, and one statement
      // means a reader of pg_stat_activity sees one truncate rather than eleven.
      await tx.unsafe(
        `TRUNCATE ${[...DEMO_WAREHOUSE_TABLES]
          .map((t) => `${DEMO_WAREHOUSE_SCHEMA}.${t}`)
          .join(", ")} RESTART IDENTITY CASCADE`,
      )
      for (const table of DEMO_WAREHOUSE_TABLES) {
        const rows = dataset[table] as unknown as Record<string, unknown>[]
        counts[table] = rows.length
        if (rows.length === 0) continue
        const columns = Object.keys(rows[0] as object)
        for (let i = 0; i < rows.length; i += CHUNK) {
          const slice = rows.slice(i, i + CHUNK)
          await tx`INSERT INTO ${tx(DEMO_WAREHOUSE_SCHEMA)}.${tx(table)} ${tx(slice, ...columns)}`
        }
      }
      await tx.unsafe(
        `INSERT INTO ${DEMO_WAREHOUSE_SCHEMA}.${DEMO_WAREHOUSE_BUILD_TABLE}
           (id, built_on, row_total, history_months, built_at, content_hash)
         VALUES (1, $1::date, $2, $3, now(), $4)
         ON CONFLICT (id) DO UPDATE SET
           built_on = EXCLUDED.built_on, row_total = EXCLUDED.row_total,
           history_months = EXCLUDED.history_months, built_at = EXCLUDED.built_at,
           content_hash = EXCLUDED.content_hash`,
        [today, rowTotal, HISTORY_MONTHS, contentHash] as never[],
      )
    })
    say(
      `warehouse: loaded ${Object.values(counts).reduce((n, v) => n + v, 0)} rows across ${DEMO_WAREHOUSE_TABLES.length} tables`,
    )

    await applyGrants(sql, login)
    say(
      `warehouse: login ${login.role} converged with read only access to ${DEMO_WAREHOUSE_SCHEMA}`,
    )

    return { schema: DEMO_WAREHOUSE_SCHEMA, role: login.role, counts, rebuilt: true }
  } finally {
    await sql.end({ timeout: 5 })
  }
}

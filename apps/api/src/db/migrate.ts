// SPDX-License-Identifier: FSL-1.1-ALv2
import { createHash, createHmac, pbkdf2Sync, randomBytes, randomUUID } from "node:crypto"
import { hostname } from "node:os"
import { drizzle } from "drizzle-orm/postgres-js"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import postgres from "postgres"
import { advisoryLockKey } from "~/db/advisory-lock"
import { assertImageNotOlderThanSchema, type OlderImagePolicy } from "~/db/schema-guard"
import { boundedBy } from "~/lib/bounded"

// The unprivileged app role. DATABASE_URL connects as this role; migrations must NOT.
export const APP_ROLE = "liaison_app"

/** Extract the connection role (username) from a postgres connection string. */
export function connectionRole(connStr: string): string | undefined {
  try {
    return new URL(connStr).username || undefined
  } catch {
    return undefined
  }
}

interface PreflightResult {
  ok: boolean
  /** Self-diagnosing FATAL message when ok is false. */
  error?: string
}

/**
 * Validate the resolved migration connection BEFORE attempting DDL.
 *
 * Migrations need DDL privileges (CREATE SCHEMA, CREATE TABLE, ALTER, etc.).
 * MIGRATION_DATABASE_URL must point at a superuser or migration-capable role.
 * The Dockerfile resolves `MIGRATION_DATABASE_URL:-$DATABASE_URL`, so a deploy
 * that forgets to set the privileged URL silently falls back to DATABASE_URL —
 * the unprivileged `liaison_app` role, which cannot run DDL. In production we
 * fail loudly and self-diagnose here rather than emitting an opaque permission
 * error mid-migration.
 */
export function preflightMigrationUrl(
  url: string | undefined,
  nodeEnv: string | undefined,
): PreflightResult {
  if (!url) {
    return {
      ok: false,
      error:
        "MIGRATION_DATABASE_URL is not set. " +
        "Supply a superuser or migration-role connection string. " +
        "Do not use DATABASE_URL (app role lacks DDL privileges).",
    }
  }
  if (nodeEnv === "production" && connectionRole(url) === APP_ROLE) {
    return {
      ok: false,
      error:
        `FATAL: MIGRATION_DATABASE_URL resolves to the unprivileged app role (${APP_ROLE}), ` +
        "which cannot run DDL. In production, MIGRATION_DATABASE_URL must be the privileged " +
        "migration role (superuser or a role with DDL grants), not the app role. " +
        "Set MIGRATION_DATABASE_URL explicitly — do not let it fall back to DATABASE_URL.",
    }
  }
  return { ok: true }
}

/** Iterations of the request login's SCRAM verifier (Postgres's own default). */
const SCRAM_ITERATIONS = 4096

/**
 * The SCRAM-SHA-256 verifier Postgres stores for `password` (RFC 5802/7677, the
 * `SCRAM-SHA-256$<iter>:<salt>$<StoredKey>:<ServerKey>` form of pg_authid).
 * Postgres SASLprep-normalises a password first; for printable ASCII that is the
 * identity, so only printable ASCII is accepted rather than reimplementing it.
 */
export function scramSha256Verifier(password: string, salt: Buffer = randomBytes(16)): string {
  if (!/^[\x20-\x7e]+$/.test(password)) {
    throw new Error("DATABASE_REQUEST_PASSWORD must be non-empty printable ASCII")
  }
  const salted = pbkdf2Sync(Buffer.from(password, "utf8"), salt, SCRAM_ITERATIONS, 32, "sha256")
  const clientKey = createHmac("sha256", salted).update("Client Key").digest()
  const storedKey = createHash("sha256").update(clientKey).digest()
  const serverKey = createHmac("sha256", salted).update("Server Key").digest()
  return `SCRAM-SHA-256$${SCRAM_ITERATIONS}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`
}

const SCRAM_VERIFIER = /^SCRAM-SHA-256\$\d+:[A-Za-z0-9+/]+=*\$[A-Za-z0-9+/]+=*:[A-Za-z0-9+/]+=*$/

/**
 * The statement that lets the request login (migration 0178, `liaison_request`)
 * sign in with DATABASE_REQUEST_PASSWORD. The migration step runs it because
 * it holds the role-admin credential the server never sees; the server then
 * connects its request pools as that login (db/connection.ts). A password is
 * not a bindable parameter in ALTER ROLE, so the statement carries the SCRAM
 * verifier computed here: the plain password never reaches the server, its
 * statement log or pg_stat_statements. The verifier is base64 and `$:` only.
 */
export function requestLoginPasswordSql(password: string): string {
  const verifier = scramSha256Verifier(password)
  if (!SCRAM_VERIFIER.test(verifier)) throw new Error("malformed SCRAM verifier")
  return `ALTER ROLE liaison_request WITH LOGIN PASSWORD '${verifier}'`
}

/**
 * The migration lease: one row in drizzle's own schema, which the migrator
 * creates itself with IF NOT EXISTS and which no numbered migration owns, so
 * the lease can be taken on an empty database before `0000` creates `kernel`.
 * Every lease statement is a short autocommit statement on the lease's own
 * connection (never inside the migration's transaction), so it works through
 * PgBouncer transaction pooling, and a renewal is not stuck behind a long DDL.
 */
export const MIGRATION_LEASE_TABLE = "drizzle.liaison_migration_lock"

export interface MigrationLeaseOptions {
  /** Who holds it, for the row and the logs. Default: host:pid:random. */
  holder?: string
  /** Lease length; a holder that stops renewing loses it after this. Default 60 s. */
  ttlMs?: number
  /** Renewal interval. Default 10 s. */
  renewMs?: number
  /** A waiter re-tries this often. Default 1 s. */
  pollMs?: number
  /**
   * Called when the lease cannot be kept (two renewals in a row failed or
   * found another holder). The migration must stop: another runner may take
   * over. Default: log and exit the process non-zero, which also aborts the
   * migration's open transaction.
   */
  onLost?: (reason: string) => void
  /** Test seam: replaces the renewal statement. Returns true when the lease is still ours. */
  renew?: (sql: postgres.Sql, holder: string, ttlMs: number) => Promise<boolean>
  /** Progress lines (waiting, taken over). Default: console.log. */
  log?: (line: string) => void
  /**
   * On SIGTERM / SIGINT, release the lease and exit (143 / 130) instead of
   * leaving it held until its TTL. For the migrate process itself (a
   * `docker stop` of the one-shot); off by default, since a library caller
   * owns its own signals.
   */
  releaseOnSignal?: boolean
}

/** The setup an empty database needs before the lease can be taken. Serialised by an advisory lock: two concurrent CREATE ... IF NOT EXISTS can still collide on the catalog. */
async function ensureLeaseTable(sql: postgres.Sql): Promise<void> {
  await sql.begin(async (tx) => {
    await tx.unsafe("SELECT pg_advisory_xact_lock($1)", [
      String(advisoryLockKey("migration-lease-setup")),
    ])
    await tx.unsafe("CREATE SCHEMA IF NOT EXISTS drizzle")
    await tx.unsafe(
      `CREATE TABLE IF NOT EXISTS ${MIGRATION_LEASE_TABLE} (
        id int PRIMARY KEY CHECK (id = 1),
        holder text NOT NULL,
        expires_at timestamptz NOT NULL
      )`,
    )
  })
}

/**
 * The NOLOGIN roles the frozen `0000` migration's RLS policies name. `0000` creates
 * them (IF NOT EXISTS) only after the first policies that reference them, so on a
 * cluster that has never seen Liaison the first migrate failed with `role
 * "liaison_rls" does not exist`. `0000` cannot change (live databases were built
 * from it), so the migrator creates them first. Roles are cluster-wide; the
 * advisory lock keeps two replicas starting together from colliding.
 */
export const POLICY_ROLES = ["liaison_rls", "liaison_admin", "liaison_app"] as const

export function policyRolesSql(): string {
  const blocks = POLICY_ROLES.map(
    (role) =>
      `  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN\n    CREATE ROLE ${role} NOBYPASSRLS NOLOGIN;\n  END IF;`,
  ).join("\n")
  return `DO $$ BEGIN\n${blocks}\nEND $$`
}

async function ensurePolicyRoles(sql: postgres.Sql): Promise<void> {
  const present = await sql<{ rolname: string }[]>`
    SELECT rolname FROM pg_roles WHERE rolname = ANY(${[...POLICY_ROLES]})`
  if (present.length === POLICY_ROLES.length) return
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SELECT pg_advisory_xact_lock($1)", [
        String(advisoryLockKey("migration-policy-roles")),
      ])
      await tx.unsafe(policyRolesSql())
    })
  } catch (err) {
    const missing = POLICY_ROLES.filter((r) => !present.some((p) => p.rolname === r))
    throw new Error(
      `the database roles ${missing.join(", ")} do not exist and the migration login could not create them: ${(err as Error).message}. ` +
        "Give the migration login CREATEROLE (or superuser), or create them once as NOBYPASSRLS NOLOGIN.",
    )
  }
}

/** Take the lease if it is free or expired. True when this holder now has it. */
async function tryTakeLease(sql: postgres.Sql, holder: string, ttlMs: number): Promise<boolean> {
  const rows = await sql.unsafe(
    `INSERT INTO ${MIGRATION_LEASE_TABLE} AS l (id, holder, expires_at)
     VALUES (1, $1, now() + make_interval(secs => $2::double precision / 1000))
     ON CONFLICT (id) DO UPDATE SET holder = EXCLUDED.holder, expires_at = EXCLUDED.expires_at
       WHERE l.expires_at < now()
     RETURNING holder`,
    [holder, ttlMs],
  )
  return rows.length === 1
}

async function renewLease(sql: postgres.Sql, holder: string, ttlMs: number): Promise<boolean> {
  const rows = await sql.unsafe(
    `UPDATE ${MIGRATION_LEASE_TABLE}
        SET expires_at = now() + make_interval(secs => $2::double precision / 1000)
      WHERE id = 1 AND holder = $1
      RETURNING 1`,
    [holder, ttlMs],
  )
  return rows.length === 1
}

/**
 * Run `fn` while holding the migration lease on `url`'s database. A second
 * runner waits (polling) until the lease is released or expires, then runs
 * its own `fn`, which for migrations finds every file already applied. The
 * lease is renewed while `fn` runs; two failed renewals in a row call
 * `onLost` (default: exit non-zero), because past that point another runner
 * may take over. A renewal that does not answer within `renewMs` counts as a
 * failure, and the release at the end is bounded the same way, so a hung
 * lease connection gives the lease up loudly and never hangs the runner.
 */
export async function withMigrationLease<T>(
  url: string,
  fn: () => Promise<T>,
  opts: MigrationLeaseOptions = {},
): Promise<T> {
  const holder = opts.holder ?? `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`
  const ttlMs = opts.ttlMs ?? 60_000
  const renewMs = opts.renewMs ?? 10_000
  const pollMs = opts.pollMs ?? 1_000
  const log = opts.log ?? ((line: string) => console.log(line))
  const renew = opts.renew ?? renewLease
  const onLost =
    opts.onLost ??
    ((reason: string) => {
      console.error(
        `FATAL: lost the migration lease (${reason}); stopping so another runner can take over.`,
      )
      process.exit(1)
    })
  const sql = postgres(url, { max: 1, onnotice: () => {} })
  try {
    await ensureLeaseTable(sql)
    let waited = false
    while (!(await tryTakeLease(sql, holder, ttlMs))) {
      if (!waited) log(`Migration lease held by another runner; waiting (${holder}).`)
      waited = true
      await Bun.sleep(pollMs)
    }
    if (waited) log(`Migration lease taken (${holder}).`)
    let failures = 0
    let lost = false
    let lastError = ""
    let renewing: Promise<void> = Promise.resolve()
    const timer = setInterval(() => {
      renewing = renewing.then(async () => {
        if (lost) return
        let ok = false
        try {
          ok = await boundedBy(
            renew(sql, holder, ttlMs),
            renewMs,
            () => new Error(`lease renewal timed out after ${renewMs} ms`),
          )
          if (!ok) lastError = "another runner holds the lease"
        } catch (err) {
          ok = false
          lastError = (err as Error).message
        }
        failures = ok ? 0 : failures + 1
        if (failures >= 2) {
          lost = true
          onLost(`${failures} renewals in a row failed, last: ${lastError}`)
        }
      })
    }, renewMs)
    // Release only our own lease; one that expired and was taken over is left alone.
    const release = () =>
      boundedBy(
        sql.unsafe(`DELETE FROM ${MIGRATION_LEASE_TABLE} WHERE id = 1 AND holder = $1`, [holder]),
        renewMs,
        () => new Error(`lease release timed out after ${renewMs} ms`),
      ).catch((err: Error) =>
        log(`Migration lease release failed (${err.message}); it expires on its own.`),
      )
    const onSignal = (signal: NodeJS.Signals) => {
      clearInterval(timer)
      lost = true
      log(`${signal}: releasing the migration lease (${holder}) and stopping.`)
      // Exiting closes the migration's connection, which rolls its transaction back.
      void release().finally(() => process.exit(signal === "SIGINT" ? 130 : 143))
    }
    if (opts.releaseOnSignal) {
      process.once("SIGTERM", onSignal)
      process.once("SIGINT", onSignal)
    }
    try {
      return await fn()
    } finally {
      clearInterval(timer)
      process.off("SIGTERM", onSignal)
      process.off("SIGINT", onSignal)
      await renewing
      await release()
    }
  } finally {
    // Bounded: a query stuck on the lease connection must not hold the runner open.
    await sql.end({ timeout: Math.max(1, Math.ceil(renewMs / 1000)) })
  }
}

/** The advisory-lock name of the migration fence (see runMigrations). */
export const MIGRATION_FENCE_LOCK = "migration-run"

/**
 * Whether the migration connection reaches Postgres directly: the server
 * answers on the port the URL names. Through PgBouncer (another port), or when
 * the server's port is unknown (a unix socket, `serverPort` null), it is
 * treated as pooled.
 */
export function migrationConnectionIsDirect(url: string, serverPort: number | null): boolean {
  if (serverPort === null) return false
  try {
    const port = Number(new URL(url).port || 5432)
    return port === serverPort
  } catch {
    return false
  }
}

/**
 * Apply every pending migration once, under the migration lease, then give
 * the request login its password when one is configured. Safe to run from
 * several replicas at once: one applies, the others wait and find nothing to
 * do.
 *
 * On a direct connection the migration connection also holds a session
 * advisory lock (the fence) for the whole run, so a runner that lost its
 * lease (a stalled process whose lease expired) but is still migrating blocks
 * the next holder until its session ends. Through PgBouncer in transaction
 * mode the fence is skipped: a session lock stays on the server connection,
 * which the pooler hands to other clients after each transaction, so it would
 * be held by, and released by, whoever got that connection next. There the
 * lease alone serialises runners.
 *
 * An image older than the database's schema stops here, before anything runs
 * (`db/schema-guard.ts`): to drizzle it would just be "nothing to do".
 */
export async function runMigrations(
  url: string,
  opts: MigrationLeaseOptions & {
    migrationsFolder?: string
    requestPassword?: string
    /** Default: `olderImagePolicy()`, refuse in production. */
    olderImage?: OlderImagePolicy
  } = {},
): Promise<void> {
  const migrationsFolder =
    opts.migrationsFolder ?? new URL("./migrations", import.meta.url).pathname
  await withMigrationLease(
    url,
    async () => {
      const sql = postgres(url, { max: 1, onnotice: () => {} })
      try {
        const [server] = await sql<{ port: number | null }[]>`SELECT inet_server_port() AS port`
        if (migrationConnectionIsDirect(url, server?.port ?? null)) {
          // Held until sql.end() closes the session.
          await sql.unsafe("SELECT pg_advisory_lock($1)", [
            String(advisoryLockKey(MIGRATION_FENCE_LOCK)),
          ])
        }
        await assertImageNotOlderThanSchema(sql, migrationsFolder, opts.olderImage)
        await ensurePolicyRoles(sql)
        await migrate(drizzle(sql), { migrationsFolder })
        if (opts.requestPassword) {
          try {
            await sql.unsafe(requestLoginPasswordSql(opts.requestPassword))
          } catch (err) {
            throw new Error(
              `could not give the request login (liaison_request) LOGIN and its password: ${(err as Error).message}. ` +
                "The migration login needs CREATEROLE (or superuser); otherwise run the ALTER ROLE yourself, or unset DATABASE_REQUEST_PASSWORD.",
            )
          }
        }
      } finally {
        await sql.end()
      }
    },
    opts,
  )
}

// Guard the executable body so importing this module for unit tests does not run
// the migration. Mirrors scripts/check-migration-baseline.ts's import.meta.main.
if (import.meta.main) {
  const url = process.env.MIGRATION_DATABASE_URL
  const preflight = preflightMigrationUrl(url, process.env.NODE_ENV)
  if (!preflight.ok || !url) {
    console.error(preflight.error)
    process.exit(1)
  }
  const requestPassword = process.env.DATABASE_REQUEST_PASSWORD
  try {
    await runMigrations(url, {
      migrationsFolder: "./src/db/migrations",
      requestPassword,
      releaseOnSignal: true,
    })
  } catch (err) {
    console.error(`FATAL: ${(err as Error).message}`)
    process.exit(1)
  }
  console.log("Migrations applied successfully.")
  if (requestPassword) console.log("Request login liaison_request can sign in.")
}

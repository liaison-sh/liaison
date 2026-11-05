#!/usr/bin/env bun
// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Test-substrate preflight — fail LOUD before tests, not mysteriously during.
 *
 * The recurring "touch infra → mystery regression" pain is almost always one of:
 * a service is down, the test database is on a stale schema, or required env is
 * missing. Each surfaces as a confusing wall of unrelated test failures. This
 * validates all three up front and aborts with an EXACT remediation instead.
 *
 * Hard failures (abort the run): required env missing, Postgres or Redis
 * unreachable, the configured test database not migrated to the on-disk migration set.
 * Soft (loud warning, does NOT abort — only some suites need them): Meilisearch,
 * object storage (SeaweedFS).
 *
 * Smart caching: a success is cached under a fingerprint of (migration files +
 * DATABASE_URL + REDIS_URL). Within PREFLIGHT_TTL_MS a matching fingerprint
 * short-circuits to a near-free no-op, so back-to-back suite runs don't re-probe.
 * A migration edit or a DB/Redis URL change busts the cache automatically.
 *
 * Escape hatch: `SKIP_PREFLIGHT=1` disables it entirely.
 *
 * Wired into scripts/test-run.ts (runs before every suite). Also usable directly:
 *   bun run scripts/preflight.ts
 */
import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { connect, type Socket } from "node:net"
import path from "node:path"
import postgres from "postgres"
import { resolveTestDb, TestDbTargetError } from "../packages/test-helpers/src/test-db-target"

const ROOT = path.resolve(import.meta.dir, "..")
const MIGRATIONS_DIR = path.join(ROOT, "apps/api/src/db/migrations")
// One cache per run namespace, so two checkouts testing at once do not keep
// overwriting each other's entry (the fingerprint already tells them apart).
export const CACHE_FILE = path.join(
  process.env.TMPDIR ?? "/tmp",
  `liaison-test-preflight${process.env.LIAISON_TEST_NS ? `-${process.env.LIAISON_TEST_NS}` : ""}.json`,
)
const TTL_MS = Number(process.env.PREFLIGHT_TTL_MS ?? 120_000)

export class PreflightError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PreflightError"
  }
}

const REQUIRED_ENV = ["DATABASE_URL", "REDIS_URL", "JWT_SECRET", "ENCRYPTION_KEY"] as const

/** sha256 over every migration file's name + content — busts the cache on edit. */
function migrationsSha(): string {
  const files = existsSync(MIGRATIONS_DIR)
    ? readdirSync(MIGRATIONS_DIR)
        .filter((f) => /^\d+_.+\.sql$/.test(f))
        .sort()
    : []
  const h = createHash("sha256")
  for (const f of files) {
    h.update(f)
    h.update("\0")
    h.update(readFileSync(path.join(MIGRATIONS_DIR, f)))
  }
  return h.digest("hex")
}

/** Raw-socket "is this TCP port answering", with an explicit timeout. */
function tcpProbe(host: string, port: number, timeoutMs = 2500): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false
    const finish = (ok: boolean, sock?: Socket) => {
      if (done) return
      done = true
      sock?.destroy()
      resolve(ok)
    }
    const sock = connect({ host, port })
    sock.setTimeout(timeoutMs)
    sock.once("connect", () => finish(true, sock))
    sock.once("timeout", () => finish(false, sock))
    sock.once("error", () => finish(false, sock))
  })
}

/** Redis PING over a raw socket — confirms it's actually Redis, not just an open port. */
function redisPing(host: string, port: number, timeoutMs = 2500): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false
    const finish = (ok: boolean, sock?: Socket) => {
      if (done) return
      done = true
      sock?.destroy()
      resolve(ok)
    }
    const sock = connect({ host, port })
    sock.setTimeout(timeoutMs)
    sock.once("connect", () => sock.write("PING\r\n"))
    sock.once("data", (buf) => finish(buf.toString().startsWith("+PONG"), sock))
    sock.once("timeout", () => finish(false, sock))
    sock.once("error", () => finish(false, sock))
  })
}

function hostPort(url: string, fallbackPort: number): { host: string; port: number } {
  try {
    const u = new URL(url)
    return { host: u.hostname || "localhost", port: Number(u.port) || fallbackPort }
  } catch {
    return { host: "localhost", port: fallbackPort }
  }
}

interface Check {
  ok: boolean
  fix?: string
}

async function checkRedis(): Promise<Check> {
  const { host, port } = hostPort(process.env.REDIS_URL ?? "redis://localhost:6379", 6379)
  const ok = await redisPing(host, port)
  return ok
    ? { ok }
    : {
        ok: false,
        fix: `Redis not responding at ${host}:${port}. Start it (e.g. \`redis-server\` / \`brew services start redis\` / \`docker compose up -d redis\`).`,
      }
}

/**
 * Postgres reachable AND the configured test database migrated. We check for a sentinel core
 * table (kernel.organizations) via to_regclass rather than counting
 * drizzle.__drizzle_migrations: the app role (DATABASE_URL = liaison_app) cannot
 * read the privileged `drizzle` schema, so a migration-count query always reads
 * 0 even on a fully-migrated DB. A core kernel table existing is a reliable,
 * permission-safe proxy for "the schema is applied".
 */
async function checkPostgresAndSchema(): Promise<Check> {
  const url = process.env.DATABASE_URL ?? ""
  // The database this run is configured for, by name, from every DB URL variable it sets: a
  // run whose variables disagree would read one database and reset another.
  let db: string
  try {
    const read = (f: string) =>
      existsSync(path.join(ROOT, f)) ? readFileSync(path.join(ROOT, f), "utf8") : ""
    db = resolveTestDb({
      env: process.env,
      envTestText: read(".env.test"),
      rootEnvText: read(".env"),
    }).name
  } catch (err) {
    if (!(err instanceof TestDbTargetError)) throw err
    return { ok: false, fix: `Test database: ${err.message}` }
  }
  const { host, port } = hostPort(url, 5432)
  if (!(await tcpProbe(host, port))) {
    return {
      ok: false,
      fix: `Postgres not reachable at ${host}:${port}. Start it (\`brew services start postgresql\` / \`docker compose up -d postgres\`).`,
    }
  }
  let sql: ReturnType<typeof postgres> | undefined
  try {
    sql = postgres(url, { max: 1, connect_timeout: 5, idle_timeout: 1, onnotice: () => {} })
    const rows = await sql<{ t: string | null }[]>`
      SELECT to_regclass('kernel.organizations')::text AS t`
    if (!rows[0]?.t) {
      return {
        ok: false,
        fix: `${db} schema not applied (kernel.organizations missing). Run the suite through \`scripts/test-run.ts\` (it clones the namespace database from the migrated template), or \`bun run db:reset:test\` with the same DB env.`,
      }
    }
    return { ok: true }
  } catch (err) {
    return {
      ok: false,
      fix: `Could not query ${db} (${(err as Error).message}). Check DATABASE_URL and run \`bun run db:reset:test\` with the same DB env.`,
    }
  } finally {
    await sql?.end({ timeout: 1 }).catch(() => {})
  }
}

async function checkMeili(): Promise<Check> {
  const host = process.env.MEILISEARCH_HOST ?? "http://localhost:7700"
  try {
    const r = await fetch(`${host}/health`, { signal: AbortSignal.timeout(2500) })
    return r.ok
      ? { ok: true }
      : { ok: false, fix: `Meilisearch unhealthy at ${host} (HTTP ${r.status}).` }
  } catch {
    return {
      ok: false,
      fix: `Meilisearch not reachable at ${host}. Start it (\`docker compose up -d meilisearch\`). Search/mention suites will fail without it.`,
    }
  }
}

async function checkStorage(): Promise<Check> {
  // SeaweedFS/S3 — only object-storage suites need it. Port from S3_ENDPOINT or 9000.
  const { host, port } = hostPort(process.env.S3_ENDPOINT ?? "http://localhost:9000", 9000)
  const ok = await tcpProbe(host, port)
  return ok
    ? { ok }
    : {
        ok: false,
        fix: `Object storage (SeaweedFS) not reachable at ${host}:${port}. Start it (\`docker compose up -d objectstore\`). File/storage suites will fail without it.`,
      }
}

function readCache(): { fingerprint: string; ts: number } | null {
  try {
    return JSON.parse(readFileSync(CACHE_FILE, "utf8"))
  } catch {
    return null
  }
}

/**
 * Validate the substrate. Throws PreflightError on a hard failure. Returns the
 * computed fingerprint on success (cached). `now` is injectable for tests.
 */
export async function runPreflight(opts: { now?: number; quiet?: boolean } = {}): Promise<string> {
  const now = opts.now ?? Date.now()
  const log = (m: string) => {
    if (!opts.quiet) console.error(m)
  }
  if (process.env.SKIP_PREFLIGHT === "1") return "skipped"

  // 1. Required env (sync, cheapest). Checked BEFORE the cache: the
  // fingerprint covers neither JWT_SECRET nor ENCRYPTION_KEY, so a cached
  // success must never excuse their absence.
  const missing = REQUIRED_ENV.filter((k) => !process.env[k])
  if (missing.length > 0) {
    throw new PreflightError(
      `Test preflight: missing required env [${missing.join(", ")}].\n` +
        `  Fix: \`set -a; source liaison/.env.test; set +a\` before launching, ` +
        `or pass them via the Strobe debug_test \`env\` arg.`,
    )
  }

  const fingerprint = createHash("sha256")
    .update(migrationsSha())
    .update(process.env.DATABASE_URL ?? "")
    .update(process.env.REDIS_URL ?? "")
    .digest("hex")

  // A cache entry stamped in the future (a test's injected `now`) is not
  // fresh: `now - ts` would stay negative, below the TTL, for good.
  const cached = readCache()
  const age = cached ? now - cached.ts : -1
  if (cached && cached.fingerprint === fingerprint && age >= 0 && age < TTL_MS) {
    return fingerprint // fresh + unchanged → near-free no-op
  }

  // 2. Services + schema.
  const [pg, redis, meili, storage] = await Promise.all([
    checkPostgresAndSchema(),
    checkRedis(),
    checkMeili(),
    checkStorage(),
  ])

  const hardFailures = [pg, redis].filter((c) => !c.ok)
  if (hardFailures.length > 0) {
    throw new PreflightError(
      `Test preflight failed — fix the substrate before running tests:\n` +
        hardFailures.map((c) => `  ✗ ${c.fix}`).join("\n"),
    )
  }
  for (const soft of [meili, storage]) {
    if (!soft.ok) log(`⚠ Test preflight: ${soft.fix}`)
  }

  try {
    writeFileSync(CACHE_FILE, JSON.stringify({ fingerprint, ts: now }))
  } catch {
    /* cache is best-effort */
  }
  return fingerprint
}

if (import.meta.main) {
  runPreflight()
    .then(() => {
      console.error("✓ Test preflight passed (services + schema + env).")
      process.exit(0)
    })
    .catch((err) => {
      console.error(`\n${err instanceof Error ? err.message : String(err)}\n`)
      process.exit(1)
    })
}

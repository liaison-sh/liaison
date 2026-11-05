// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE one place test coordinates come from.
//
// Several checkouts of this repo (git worktrees driven by separate sessions)
// share one docker compose stack: one Postgres, one Redis, one Meilisearch, one
// object store. Each of them used to test against the same hardcoded names
// (database `liaison_test`, Redis prefix `w<N>:`, Meili `w<N>_`, ports
// 14000+N*10), so two runs at once dropped each other's database, consumed each
// other's jobs and killed each other's servers. A machine-wide lock made that
// safe by making every run wait for every other run.
//
// A run NAMESPACE replaces the lock as the isolation unit. Everything a run
// creates is keyed by it:
//
//   database      liaison_test_<ns>          (worker schemas w<N>_* live inside it)
//   redis         <ns>:            per run, <ns>:w<N>: per worker
//   meilisearch   <ns>-            per run, <ns>-w<N>_ per worker
//   ports         a 1000-port block leased per namespace (scripts/lib/test-slots.ts)
//
// The object store stays one shared bucket: the product has no key-prefix knob
// and every key it writes is scoped by an org id, which each run mints fresh.
//
// The namespace is the checkout's directory name (a worktree's dir name), or
// LIAISON_TEST_NS when set. scripts/test-run.ts resolves it once and hands it
// to every child through the environment, so a process started by the runner
// reads its coordinates from here and never invents its own. A process started
// WITHOUT the runner (a bare `bun test`) has no LIAISON_TEST_NS and gets the
// legacy shared coordinates, exactly as before.
//
// Pure: reads only the env object it is given.

import { createHash } from "node:crypto"
import path from "node:path"

export const LEGACY_TEST_DB = "liaison_test"
export const LEGACY_PORT_BASE = 14000
/** Ports per namespace. A worker takes 10, so 100 worker ids fit a block. */
export const PORT_BLOCK_SIZE = 1000
export const WORKER_PORT_STRIDE = 10
/**
 * Where namespace port blocks start, and how many there are. 16000-31999 sits
 * above the legacy 14000+ range and below Linux's ephemeral range (32768+).
 */
export const PORT_BLOCKS_START = 16000
export const PORT_BLOCK_COUNT = 16

const NS_MAX_LEN = 24

/** A namespace slug: lowercase [a-z0-9_], starts with a letter, at most 24 chars. */
export function sanitizeNamespace(raw: string): string {
  let s = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
  if (!/^[a-z]/.test(s)) s = `n${s}`
  if (s.length > NS_MAX_LEN) {
    // Keep it unique when truncating: two long names sharing a prefix must not
    // collapse into one namespace.
    const h = createHash("sha256").update(raw).digest("hex").slice(0, 4)
    s = `${s.slice(0, NS_MAX_LEN - 5).replace(/_+$/, "")}_${h}`
  }
  return s
}

/** The namespace of a checkout: LIAISON_TEST_NS when set, else the checkout dir name. */
export function namespaceForCheckout(
  root: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const explicit = env.LIAISON_TEST_NS
  if (explicit) return sanitizeNamespace(explicit)
  return sanitizeNamespace(path.basename(path.resolve(root)))
}

/** The block a namespace prefers. test-slots.ts probes onward from here when it is leased. */
export function preferredPortBlock(ns: string): number {
  const h = createHash("sha256").update(ns).digest()
  return h.readUInt32BE(0) % PORT_BLOCK_COUNT
}

export function portBlockBase(block: number): number {
  return PORT_BLOCKS_START + block * PORT_BLOCK_SIZE
}

export interface TestCoordinates {
  /** The run namespace, or null for the legacy shared coordinates. */
  ns: string | null
  dbName: string
  pgHost: string
  pgPort: number
  superuserUrl(db?: string): string
  appUrl(db?: string): string
  redisUrl: string
  /** Prefix for a whole-run process (unit, integration): `<ns>:`, or "" legacy. */
  redisPrefix: string
  workerRedisPrefix(workerId: number): string
  meiliHost: string
  meiliKey: string
  /** Index prefix for a whole-run process: `<ns>-`, or "" legacy. */
  meiliPrefix: string
  workerMeiliPrefix(workerId: number): string
  /** First port of this run's block. */
  portBase: number
  workerPorts(workerId: number, count: number): number[]
}

function int(value: string | undefined, fallback: number): number {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : fallback
}

/**
 * The coordinates for the current process.
 *
 * Namespaced when LIAISON_TEST_NS is set (the runner sets it for every child),
 * legacy otherwise. LIAISON_TEST_PORT_BASE carries the leased block; without it
 * a namespaced process falls back to the namespace's preferred block, which is
 * what the lease hands out whenever nothing else holds it.
 */
export function resolveTestCoordinates(
  env: Record<string, string | undefined> = process.env,
): TestCoordinates {
  const ns = env.LIAISON_TEST_NS ? sanitizeNamespace(env.LIAISON_TEST_NS) : null
  const pgHost = env.LIAISON_TEST_PG_HOST || "localhost"
  const pgPort = int(env.LIAISON_TEST_PG_PORT, 5432)
  const dbName = ns ? `${LEGACY_TEST_DB}_${ns}` : LEGACY_TEST_DB
  const superuserUrl = (db = dbName) => `postgres://postgres:postgres@${pgHost}:${pgPort}/${db}`
  const appUrl = (db = dbName) => `postgres://liaison_app:liaison_app@${pgHost}:${pgPort}/${db}`
  const portBase = ns
    ? int(env.LIAISON_TEST_PORT_BASE, portBlockBase(preferredPortBlock(ns)))
    : LEGACY_PORT_BASE
  const slotsPerBlock = PORT_BLOCK_SIZE / WORKER_PORT_STRIDE
  return {
    ns,
    dbName,
    pgHost,
    pgPort,
    superuserUrl,
    appUrl,
    redisUrl: env.REDIS_URL || "redis://localhost:6379",
    redisPrefix: ns ? `${ns}:` : "",
    workerRedisPrefix: (id) => (ns ? `${ns}:w${id}:` : `w${id}:`),
    meiliHost: env.MEILISEARCH_HOST || "http://localhost:7700",
    meiliKey: env.MEILISEARCH_API_KEY || "dev-master-key",
    // The separators (":" and "-") never occur in a namespace, so no
    // namespace's prefix is a prefix of another's ("a-" never matches "a_b-").
    meiliPrefix: ns ? `${ns}-` : "",
    workerMeiliPrefix: (id) => (ns ? `${ns}-w${id}_` : `w${id}_`),
    portBase,
    workerPorts(workerId, count) {
      // Inside a namespace the worker id wraps within the block, so no worker id
      // can reach into a neighbour's block. Ids that far apart never run at once.
      const slot = ns ? workerId % slotsPerBlock : workerId
      const base = portBase + slot * WORKER_PORT_STRIDE
      return Array.from({ length: count }, (_, i) => base + i)
    },
  }
}

/** The one index the app creates under a prefix (apps/api/src/infra/search/client.ts). */
export const MEILI_CANONICAL_INDEX = "liaison_search"
/** Worker and shard ids a namespace's index sweep covers. */
export const MEILI_SWEEP_IDS = 200

/**
 * Every Meili index a namespaced run can create: the whole-run one, one per
 * worker (`w<N>`) and one per unit shard (`s<N>`). The pretest sweep looks
 * these up by name: listing indexes costs about 0.8 s a page on a shared
 * Meilisearch holding thousands of them, and a listing capped at 1000 silently
 * missed the rest.
 */
export function namespaceMeiliIndexes(c: TestCoordinates): string[] {
  if (!c.ns) return []
  const out = [`${c.meiliPrefix}${MEILI_CANONICAL_INDEX}`]
  for (let i = 0; i < MEILI_SWEEP_IDS; i++) {
    out.push(`${c.workerMeiliPrefix(i)}${MEILI_CANONICAL_INDEX}`)
    out.push(`${c.meiliPrefix}s${i}_${MEILI_CANONICAL_INDEX}`)
  }
  return out
}

/**
 * The test substrate's Meilisearch master key: the value docker-compose.yml (the
 * development and test substrate, never a deployment) starts Meilisearch with.
 */
export const TEST_SUBSTRATE_MEILI_KEY = "dev-master-key"

/**
 * The request login's password on test clusters. Every namespaced run hands it
 * to its children (DATABASE_REQUEST_PASSWORD), so request transactions run on
 * `liaison_request` exactly as on a deployment that splits the logins, and the
 * template build gives the role LOGIN with it (scripts/lib/test-template.ts).
 * LIAISON_TEST_UNSPLIT_LOGINS=1 hands children an empty password instead, so
 * every pool logs in as DATABASE_URL, as on a deployment that does not split
 * the logins (the `unsplit-logins` suite in scripts/test-run.ts).
 */
export const TEST_REQUEST_LOGIN_PASSWORD = "liaison_request"

/**
 * The environment a namespaced run hands its children. Every DB URL a test or a
 * helper reads points at the namespace database; the prefixes keep Redis and
 * Meili keys apart. Applied AFTER the runner strips the auto-loaded DATABASE_URL
 * and BEFORE `--env-file=.env.test`, which never overrides a value already set.
 */
export function namespaceEnv(
  c: TestCoordinates,
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  if (!c.ns) return {}
  return {
    LIAISON_TEST_NS: c.ns,
    LIAISON_TEST_PORT_BASE: String(c.portBase),
    DATABASE_URL: c.appUrl(),
    DATABASE_REQUEST_PASSWORD:
      env.LIAISON_TEST_UNSPLIT_LOGINS === "1" ? "" : TEST_REQUEST_LOGIN_PASSWORD,
    DATABASE_URL_SUPERUSER: c.superuserUrl(),
    E2E_DATABASE_URL: c.superuserUrl(),
    E2E_SERVER_DATABASE_URL: c.appUrl(),
    MIGRATION_DATABASE_URL_TEST: c.superuserUrl(),
    E2E_DB_NAME: c.dbName,
    REDIS_PREFIX: c.redisPrefix,
    MEILI_INDEX_PREFIX: c.meiliPrefix,
    // The substrate's key, like the database URLs above: a run talks to the test
    // substrate, never to whatever Meilisearch the checkout's own `.env` names.
    // That `.env` is auto-loaded into the runner and `--env-file=.env.test` never
    // overrides it, so a stale dev key there made every search a test ran fail
    // auth and come back empty. LIAISON_TEST_MEILI_API_KEY overrides it for a
    // substrate started with another key.
    MEILISEARCH_API_KEY: env.LIAISON_TEST_MEILI_API_KEY || TEST_SUBSTRATE_MEILI_KEY,
  }
}

// SPDX-License-Identifier: FSL-1.1-ALv2
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createDbClient, type DbClient } from "./db"
import { ensureTestInfra } from "./ensure-infra"
import { deterministicPorts } from "./port-allocator"
import { createRedisClient, type RedisClient } from "./redis"
import { resolveTestCoordinates } from "./test-namespace"

/**
 * AES-256-GCM key used for encrypting credentials in the E2E API process.
 * Exported so test seed helpers (`seedSmtpConnectedAccount`, etc.) can encrypt
 * with the same key the spawned server will use to decrypt — otherwise GCM
 * auth-tag verification fails with "Unsupported state or unable to
 * authenticate data" and gated tool calls surface a confusing 422.
 */
export const DEFAULT_E2E_ENCRYPTION_KEY =
  "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"

/**
 * M0.3 — forward Boxtal sandbox credentials, base URLs, and the live-mode gate
 * into the spawned e2e server env. Mirrors the SHOPIFY_* conditional-forward
 * block: only present vars cross the boundary, so a CI run without creds
 * forwards nothing and the live scenarios self-skip rather than fail. Var names
 * only — values stay in the gitignored .env.test.
 */
export function forwardBoxtalEnv(src: Record<string, string | undefined>): Record<string, string> {
  const KEYS = [
    "BOXTAL_E2E_LIVE",
    "BOXTAL_V1_KEY",
    "BOXTAL_V1_SECRET",
    "BOXTAL_V3_KEY",
    "BOXTAL_V3_SECRET",
    "BOXTAL_V1_BASE_URL",
    "BOXTAL_V3_BASE_URL",
  ] as const
  const out: Record<string, string> = {}
  for (const k of KEYS) {
    const v = src[k]
    if (v !== undefined) out[k] = v
  }
  return out
}

/**
 * The budget knobs `scripts/lib/mem-budget.ts` computes that the spawned e2e
 * server reads: sandbox worker pool size, warm floor and recycle cap, and the
 * QuickJS pool size (plus LIAISON_E2E_SERVER_SMOL, forwarded as before).
 * `spawnEnv` is an allowlist, so a knob missing here never reaches the server,
 * which then falls back to its production defaults (eight sandbox workers)
 * against a budget planned for far fewer. Only present vars cross the boundary.
 */
export function forwardServerBudgetEnv(
  src: Record<string, string | undefined>,
): Record<string, string> {
  const KEYS = [
    "APP_WORKER_POOL_MAX",
    "SANDBOX_POOL_WARM_SIZE",
    "APP_WORKER_MAX_RSS_MB",
    "SANDBOX_POOL_MAX_SIZE",
    "LIAISON_E2E_SERVER_SMOL",
  ] as const
  const out: Record<string, string> = {}
  for (const k of KEYS) {
    const v = src[k]
    if (v) out[k] = v
  }
  return out
}

/**
 * Bun flags for the spawned e2e API server.
 *
 * `--smol` is the ONLY lever Bun 1.3.11 honours here. Left unconstrained, JSC
 * defers collection until far past the server's live set: a single e2e server
 * driven through browser scenarios was measured climbing 506MB -> 7216MB RSS
 * over eleven scenarios on a 31GB box, then dropping to 779MB the instant a
 * full GC ran. It is deferred collection, not a leak, but four Playwright
 * workers each overshooting by 6GB blow the 2GiB per worker slice that
 * `scripts/lib/mem-budget.ts` budgets and trip the memory guard mid-lane.
 * `BUN_JSC_forceRAMSize` and `BUN_JSC_gcMaxHeapSize` were measured on the same
 * box and do not bound it (152MB -> 152MB and 127MB on an allocator loop where
 * `--smol` gives 59MB), so the flag is the fix, not an env var.
 *
 * Set `LIAISON_E2E_SERVER_SMOL=0` to spawn without it (more RAM, less GC work).
 */
export function serverBunFlags(env: NodeJS.ProcessEnv = process.env): string[] {
  return env.LIAISON_E2E_SERVER_SMOL === "0" ? [] : ["--smol"]
}

export interface WorkerEnv {
  workerId: number
  serverUrl: string
  schemaPrefix: string
  redisPrefix: string
  meiliIndexPrefix: string
  ports: number[]
  encryptionKey: string
  db: DbClient
  redis: RedisClient
  /**
   * True when the org and its admin already exist (a shared e2e lane, see
   * e2e-lane.ts): `TestWorld.create` then signs the admin in instead of
   * registering the instance's first account.
   */
  bootstrapped?: boolean
  getStdout(): string
  getStderr(): string
  waitForReady(timeoutMs?: number): Promise<void>
  restart(opts?: RestartOptions): Promise<void>
  teardown(): Promise<void>
}

export interface RestartOptions {
  timeoutMs?: number
  between?: () => Promise<void>
  /**
   * Additional env vars merged into the spawned server's environment on
   * restart. Values overwrite any existing keys; passing `undefined` for
   * a key removes it. Persists across subsequent restarts. Used by the
   * MCP env-bootstrap E2E (Task 39) to inject `LIAISON_MCP_*` vars after
   * the test world has been seeded (org id is unknown at first boot).
   */
  env?: Record<string, string | undefined>
  /** Start from the env the server was first created with before applying `env`. */
  resetEnv?: boolean
}

/** A worker env whose server the caller drives directly (the lane owner). */
export interface OwnedWorkerEnv extends WorkerEnv {
  isRunning(): boolean
  /** The env the server currently runs with (a copy). */
  currentEnv(): Record<string, string>
  stopServer(opts?: { sweepPort?: boolean }): Promise<void>
  startServer(opts?: Omit<RestartOptions, "between">): Promise<void>
  appsInstallDir: string
}

export interface WorkerEnvOptions {
  portCount?: number // 1 for API, 2 for Playwright (API + Vite)
  serverEnv?: Record<string, string | undefined>
  /**
   * Boot a server of this file's own even under a shared e2e lane: for a file
   * that needs a pristine process (boot-time behaviour, process-global state
   * it cannot reset). See e2e-lane.ts.
   */
  ownServer?: boolean
  /** Also append the server's stdout / stderr to these files as they arrive. */
  logFiles?: { stdout: string; stderr: string }
}

/** The api package: the cwd every spawned server runs in. */
export const API_DIR = path.resolve(import.meta.dir, "../../../apps/api")

// Every coordinate comes from the run namespace (test-namespace.ts): the legacy
// shared names for a bare run, the namespace's own for a run the orchestrator
// started. The explicit E2E_* overrides still win.
const COORDS = resolveTestCoordinates()
/** The superuser URL the harness provisions and inspects worker schemas with. */
export const DATABASE_URL = process.env.E2E_DATABASE_URL ?? COORDS.superuserUrl()
const SERVER_DATABASE_URL = process.env.E2E_SERVER_DATABASE_URL ?? COORDS.appUrl()
export const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379"

/** Logged by `createServer` (apps/api/src/lib/server.ts) once the socket listens. */
const LISTENING_MARKER = "E2E server listening"
/** Printed by test-support/index.e2e.ts once app registration is complete. */
const READY_MARKER = '"ready":true'
/**
 * How long a stopped server gets to finish its shutdown (SIGTERM) before it is
 * SIGKILLed. With the harness budgets (buildServerSpawnEnv) the sequence takes
 * a few seconds: 1 s of drains, then up to 4 s for a job that ignores its abort
 * (abort settle + queue close), then the pools. The cap is for a hung phase.
 */
const SERVER_STOP_GRACE_MS = 15_000

const E2E_JWT_SECRET = "e2e-test-secret-minimum-32-characters-long"

/**
 * Where a worker's data lives (its database and schema prefix, Redis and
 * search prefixes, object storage) and the keys that read it: the env the
 * worker's server boots with, and the one a one-off CLI process beside it gets.
 */
export function workerDataEnv(prefixes: {
  schemaPrefix: string
  redisPrefix: string
  meiliIndexPrefix: string
}): Record<string, string> {
  return {
    DATABASE_URL: SERVER_DATABASE_URL,
    // The request login (apps/api/src/db/connection.ts), as the run's own
    // processes use it (test-namespace.ts namespaceEnv).
    ...(process.env.DATABASE_REQUEST_PASSWORD && {
      DATABASE_REQUEST_PASSWORD: process.env.DATABASE_REQUEST_PASSWORD,
    }),
    REDIS_URL,
    JWT_SECRET: E2E_JWT_SECRET,
    NODE_ENV: "test",
    SCHEMA_PREFIX: prefixes.schemaPrefix,
    REDIS_PREFIX: prefixes.redisPrefix,
    MEILI_INDEX_PREFIX: prefixes.meiliIndexPrefix,
    MEILISEARCH_HOST: process.env.MEILISEARCH_HOST ?? "http://localhost:7700",
    MEILISEARCH_API_KEY: process.env.MEILISEARCH_API_KEY ?? "dev-master-key",
    OBJECT_STORAGE_ENDPOINT: process.env.OBJECT_STORAGE_ENDPOINT ?? "http://localhost:9000",
    OBJECT_STORAGE_BUCKET: process.env.OBJECT_STORAGE_BUCKET ?? "liaison-dev",
    OBJECT_STORAGE_ACCESS_KEY: process.env.OBJECT_STORAGE_ACCESS_KEY ?? "liaison",
    OBJECT_STORAGE_SECRET_KEY: process.env.OBJECT_STORAGE_SECRET_KEY ?? "liaison-dev-secret",
    OBJECT_STORAGE_FORCE_PATH_STYLE: "true",
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
  }
}

/**
 * The env for a `liaison` CLI process (`apps/api/src/cli/index.ts`) acting on
 * this worker's data, as an operator's CLI acts on a deployment's: the same
 * database, prefixes and keys as the worker's server. `baseUrl` is what the
 * CLI prints in links (the web origin a browser opens).
 */
export function cliProcessEnv(
  env: Pick<WorkerEnv, "schemaPrefix" | "redisPrefix" | "meiliIndexPrefix" | "encryptionKey">,
  baseUrl: string,
): Record<string, string> {
  return {
    ...workerDataEnv(env),
    ENCRYPTION_KEY: env.encryptionKey,
    BASE_URL: baseUrl,
    LOG_LEVEL: "warn",
  }
}

function withoutUndefined(env: Record<string, string | undefined> | undefined) {
  return Object.fromEntries(
    Object.entries(env ?? {}).filter(([, value]) => value !== undefined),
  ) as Record<string, string>
}

/**
 * The env a spawned test server boots with on `port` over one worker's data:
 * its database and prefixes, keys, forwarded provider credentials and the
 * per-worker apps install dir. `createOwnedWorkerEnv` and the role-process
 * cells (role-processes.ts) both spawn with it.
 */
export function buildServerSpawnEnv(opts: {
  port: number
  schemaPrefix: string
  redisPrefix: string
  meiliIndexPrefix: string
  appsInstallDir: string
}): Record<string, string> {
  const { port, schemaPrefix, redisPrefix, meiliIndexPrefix, appsInstallDir } = opts
  return {
    PORT: String(port),
    // Database, prefixes, Meilisearch + SeaweedFS (docker compose defaults match the dev seed).
    ...workerDataEnv({ schemaPrefix, redisPrefix, meiliIndexPrefix }),
    ENCRYPTION_KEY: DEFAULT_E2E_ENCRYPTION_KEY,
    BASE_URL: `http://localhost:${port}`,
    ALLOWED_ORIGINS: "*",
    LOG_LEVEL: "debug",
    RATE_LIMIT_DEFAULT: "999999",
    TRUSTED_PROXY_HOPS: "0",
    // Cap the spawned server's pg pool so the e2e-parallel suite stays well
    // under Postgres `max_connections=100` (4 workers × server pool + every
    // test-process `__privileged_db__` pool starts to crowd the wall around
    // 80 connections). With a tight cap, peak demand is ~4 × 8 server + 4 ×
    // 8 test ≈ 64, leaving headroom for maintenance + drift recovery.
    DB_POOL_MAX: "8",
    EXPOSE_REFRESH_TOKEN_IN_BODY: "true",
    EXPOSE_ERROR_DETAIL: "true",
    // Device-flow allowlist defaults to "*" under e2e — apps.scenario S32/S32b
    // initiate with arbitrary clientIds; production deployments override this
    // with an explicit comma-separated list.
    DEVICE_FLOW_CLIENTS: "*",
    // Forward AI provider API keys for agent runtime E2E tests
    ...(process.env.OPENAI_API_KEY && { OPENAI_API_KEY: process.env.OPENAI_API_KEY }),
    ...(process.env.LIAISON_ANTHROPIC_API_KEY && {
      LIAISON_ANTHROPIC_API_KEY: process.env.LIAISON_ANTHROPIC_API_KEY,
    }),
    ...(process.env.GOOGLE_API_KEY && { GOOGLE_API_KEY: process.env.GOOGLE_API_KEY }),
    ...(process.env.MISTRAL_API_KEY && { MISTRAL_API_KEY: process.env.MISTRAL_API_KEY }),
    ...(process.env.EXA_API_KEY && { EXA_API_KEY: process.env.EXA_API_KEY }),
    ...(process.env.OPENROUTER_API_KEY && { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY }),
    // OpenRouter's API root: the Playwright run points it at its stub
    // (apps/web/src/tests/e2e/openrouter-stub-server.ts). Unset, the server
    // uses openrouter.ai.
    ...(process.env.OPENROUTER_BASE_URL && {
      OPENROUTER_BASE_URL: process.env.OPENROUTER_BASE_URL,
    }),
    // A runner on placeholder keys stands the server's own side calls down
    // (apps/api/src/lib/env.ts offlineSideCalls); forwarded like the keys.
    ...(process.env.LIAISON_OFFLINE_SIDE_CALLS && {
      LIAISON_OFFLINE_SIDE_CALLS: process.env.LIAISON_OFFLINE_SIDE_CALLS,
    }),
    // Phase 16 — forward Shopify dev-store credentials so the API server's
    // bundled-app handlers can call the real store. Only set when present
    // (CI without creds → fixtures self-skip rather than fail mysteriously).
    ...(process.env.SHOPIFY_DEV_STORE_DOMAIN && {
      SHOPIFY_DEV_STORE_DOMAIN: process.env.SHOPIFY_DEV_STORE_DOMAIN,
    }),
    ...(process.env.SHOPIFY_DEV_STORE_OFFLINE_TOKEN && {
      SHOPIFY_DEV_STORE_OFFLINE_TOKEN: process.env.SHOPIFY_DEV_STORE_OFFLINE_TOKEN,
    }),
    ...(process.env.SHOPIFY_WEBHOOK_SECRET && {
      SHOPIFY_WEBHOOK_SECRET: process.env.SHOPIFY_WEBHOOK_SECRET,
    }),
    ...(process.env.SHOPIFY_API_VERSION && {
      SHOPIFY_API_VERSION: process.env.SHOPIFY_API_VERSION,
    }),
    ...(process.env.SHOPIFY_OAUTH_CLIENT_ID && {
      SHOPIFY_OAUTH_CLIENT_ID: process.env.SHOPIFY_OAUTH_CLIENT_ID,
    }),
    ...(process.env.SHOPIFY_OAUTH_CLIENT_SECRET && {
      SHOPIFY_OAUTH_CLIENT_SECRET: process.env.SHOPIFY_OAUTH_CLIENT_SECRET,
    }),
    // Phase 17 — forward the Shopify live-mode gate so real-dev-store scenarios
    // (shopify/invoicing `realOfflineToken` installs, gated on `requireShopifyCreds`)
    // actually bypass `shopify-mock-fetch.ts`'s canned `*.myshopify.com` responses
    // instead of silently hitting the deep-week-sim analytics mock (which only
    // special-cases the `Analytics`/`OrdersSearch` operations and returns an empty
    // default `{ shop }` payload for everything else, e.g. `products_search`).
    ...(process.env.SHOPIFY_E2E_LIVE && { SHOPIFY_E2E_LIVE: process.env.SHOPIFY_E2E_LIVE }),
    // Mission 0 (M0.3) — forward Boxtal sandbox creds + the live-mode gate so the
    // live Boxtal e2e (BOXTAL_E2E_LIVE=1) reaches the real sandbox. Only present
    // vars cross the boundary; CI without creds forwards nothing.
    ...forwardBoxtalEnv(process.env),
    // Memory forensics: forward the heap-dump directory (and the sandbox pool
    // knobs a lane sets) so a long Playwright lane can be sampled for growing
    // retainers. Only present vars cross the boundary, so a normal run forwards
    // nothing and the server's SIGUSR2 handler stays inert.
    ...(process.env.LIAISON_E2E_HEAPDUMP_DIR && {
      LIAISON_E2E_HEAPDUMP_DIR: process.env.LIAISON_E2E_HEAPDUMP_DIR,
    }),
    ...forwardServerBudgetEnv(process.env),
    // The server runs QuickJS WASM in process and must start with JSC's
    // optimizing WASM tier off, or one hot sandbox execution grows it by
    // gigabytes of JIT compile memory (QUICKJS_HOST_JSC_ENV in
    // apps/api/src/modules/apps/sandbox/pool.ts).
    BUN_JSC_useOMGJIT: "0",
    // BYOK encryption key for agent runtime E2E tests (S15 BYOK bypass)
    // Orphan guard: the spawned server watches the death pipe on fd 0 (see
    // spawnServer below) and polls its real parent pid, and exits the moment
    // this harness process disappears. `teardown()` below is the happy path
    // only; a bailed, crashed or SIGKILLed harness runs no teardown at all, and
    // the server it left behind keeps its BullMQ workers and sandbox pool
    // running forever. See apps/api/src/lib/orphan-exit.ts.
    LIAISON_EXIT_WHEN_ORPHANED: "1",
    BYOK_ENCRYPTION_KEY: DEFAULT_E2E_ENCRYPTION_KEY,
    // Phase 16.5 — per-worker tmp dir so runtime-installed `.liaisonapp`
    // packages land in a writable location (the default `/var/lib/liaison/apps`
    // requires root and isn't appropriate for ephemeral test workers).
    LIAISON_APPS_DIR: appsInstallDir,
    // P4c-T21b — arm the scripted model provider for this spawned server. It is
    // a LANE flag, not a behaviour change: `resolveModel` only takes a turn over
    // for a thread a test explicitly scripted through
    // `POST /api/_test/agent-script`, so every other turn keeps the normal
    // provider path (AGENT_STREAM_STUB, real keys, in-process seams) exactly as
    // before. A scenario that must see the flag off can override it in
    // `serverEnv` (the spread below wins).
    LIAISON_MODEL_PROVIDER: "scripted",
    // The mailbox encryption default (apps/api/src/modules/mailbox-crypto/
    // encryption-mode.ts). Unset it is `auto`, which a fresh test database
    // resolves to `managed`, so every personal mailbox a scenario connects
    // would be sealed by the server and reject the plaintext rows the mail
    // seeds write. The suite is written against private (zero-access)
    // mailboxes, like `.env.test.example`; a scenario of the transparent mode
    // passes `MAILBOX_ENCRYPTION_DEFAULT: "managed"` in its `serverEnv`.
    MAILBOX_ENCRYPTION_DEFAULT: "private",
    // Short leader-lease timings (apps/api/src/infra/leader-lease.ts): a
    // killed leader is replaced in about 3 s, so failover scenarios finish fast.
    LEADER_LEASE_TTL_MS: "3000",
    LEADER_LEASE_RENEW_MS: "1000",
    LEADER_LEASE_POLL_MS: "250",
    // Short instance-liveness timings (apps/api/src/infra/instance-registry.ts):
    // a killed process's entries are ignored after 3 s and swept within 4 s.
    LIVE_INSTANCE_TTL_MS: "3000",
    LIVE_INSTANCE_HEARTBEAT_MS: "1000",
    LIVE_SWEEP_INTERVAL_MS: "1000",
    // Short shutdown budgets (apps/api/src/lib/shutdown.ts): the server runs the
    // production shutdown on SIGTERM, and a restart should not wait out the
    // 20 s drains. A job still running after 1 s is aborted and handed back to
    // its queue, as on a deploy; SERVER_STOP_GRACE_MS bounds the whole sequence.
    SHUTDOWN_EDGE_GRACE_MS: "0",
    SHUTDOWN_HTTP_DRAIN_MS: "1000",
    SHUTDOWN_TURN_DRAIN_MS: "1000",
    SHUTDOWN_JOB_DRAIN_MS: "1000",
  }
}

export async function createWorkerEnv(
  workerId: number,
  options?: WorkerEnvOptions,
): Promise<WorkerEnv> {
  // Under a shared e2e lane (scripts/test-e2e-parallel.ts), attach to the
  // lane's running server instead of cloning schemas and booting one.
  const lane = readLaneInfo()
  if (lane && !options?.ownServer && (options?.portCount ?? 1) <= 1) {
    return attachToLane(lane, options)
  }
  return createOwnedWorkerEnv(workerId, options)
}

export async function createOwnedWorkerEnv(
  workerId: number,
  options?: WorkerEnvOptions,
): Promise<OwnedWorkerEnv> {
  // 0. Ensure docker compose services (Postgres, Redis, Meilisearch, SeaweedFS +
  // the liaison-dev bucket) are running. Idempotent and cached per process.
  await ensureTestInfra()

  const portCount = options?.portCount ?? 1
  // Schemas live inside the namespace's own database, so `w<N>_` cannot clash
  // across runs; Redis and Meili are shared services and carry the namespace.
  const schemaPrefix = `w${workerId}_`
  const redisPrefix = COORDS.workerRedisPrefix(workerId)
  const meiliIndexPrefix = COORDS.workerMeiliPrefix(workerId)

  // 1. Create superuser DB client and provision schemas
  const db = createDbClient(DATABASE_URL)
  await db.cloneSchemas(workerId)
  await db.grantWorkerSchemas(workerId)

  // 1b. Reset the worker's Meilisearch index. Indices are NOT volume-bound to
  // the test DB lifecycle — between runs, stale docs from earlier runs (1k+
  // tickets, threads, etc.) accumulate under `w${id}_liaison_search` and
  // crowd the top-N search results. Tests that poll for "do my N freshly
  // seeded docs show up?" then flake when limit=50 fills with leftovers.
  const meiliHost = process.env.MEILISEARCH_HOST ?? "http://localhost:7700"
  const meiliKey = process.env.MEILISEARCH_API_KEY ?? "dev-master-key"
  const meiliIndex = `${meiliIndexPrefix}liaison_search`
  try {
    await fetch(`${meiliHost}/indexes/${meiliIndex}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${meiliKey}` },
    })
  } catch {
    /* best-effort — index may not exist yet */
  }

  // 2. Create Redis client
  const redis = createRedisClient(REDIS_URL)

  // 3. Deterministic ports based on worker ID (no ephemeral allocation races)
  const ports = deterministicPorts(workerId, portCount)
  const apiPort = ports[0]

  // 3b. Kill any stale processes on our ports from previous runs. The ports are
  // inside this run's own block (a namespace leases its block exclusively), so
  // this never reaches a process another run owns. A SIGKILLed listener frees
  // its socket as it dies, and the server below takes far longer than that to
  // reach listen(), so there is nothing to sleep for.
  // Guard against self-kill: callers may bind to one of `ports` from inside
  // the current process before invoking createWorkerEnv (e.g. an in-fixture
  // mock server using Bun.serve on a reserved port). lsof would then return
  // our own PID; SIGKILLing ourselves manifests as Playwright "worker process
  // exited unexpectedly (code=null, signal=SIGKILL)" with empty stderr.
  await killPortHolders(ports)

  // 4. Spawn server process
  let stdout = ""
  let stderr = ""
  // Resolvers waiting for a marker in the server output; woken on every chunk.
  let outputWaiters: Array<() => void> = []

  // Phase 16.5 — per-worker install root for runtime-installed `.liaisonapp`
  // packages. Default `/var/lib/liaison/apps` is not writable in CI / dev
  // sandboxes, so every worker gets its own tmp dir. The `_test/apps`
  // install harness writes here; uninstall + restart inherit the same path.
  const appsInstallDir = mkdtempSync(path.join(tmpdir(), `liaison-w${workerId}-apps-`))

  const baseSpawnEnv = buildServerSpawnEnv({
    port: apiPort,
    schemaPrefix,
    redisPrefix,
    meiliIndexPrefix,
    appsInstallDir,
  })
  // What the server was first created with: `resetEnv` returns to THIS, the
  // caller's serverEnv included (a lane's restart must keep the env it was
  // created with, e.g. the web build a Playwright lane serves).
  const initialSpawnEnv: Record<string, string> = {
    ...baseSpawnEnv,
    ...withoutUndefined(options?.serverEnv),
  }
  let spawnEnv: Record<string, string> = { ...initialSpawnEnv }

  let encryptionKeyOverride: string | undefined
  const logFiles = options?.logFiles
  if (logFiles) {
    writeFileSync(logFiles.stdout, "")
    writeFileSync(logFiles.stderr, "")
  }

  // Read stdout/stderr in background
  const readStream = async (stream: ReadableStream<Uint8Array>, target: "out" | "err") => {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const text = decoder.decode(value, { stream: true })
        if (target === "out") {
          stdout += text
          if (logFiles) appendFileSync(logFiles.stdout, text)
        } else {
          stderr += text
          if (logFiles) appendFileSync(logFiles.stderr, text)
        }
        const waiters = outputWaiters
        outputWaiters = []
        for (const w of waiters) w()
      }
    } catch {
      // Stream closed
    }
  }

  let spawnOffset = { out: 0, err: 0 }
  let proc = spawnServer()
  let running = true

  function spawnServer(): ReturnType<typeof Bun.spawn> {
    const p = Bun.spawn({
      cmd: ["bun", ...serverBunFlags(process.env), "test-support/index.e2e.ts"],
      cwd: API_DIR,
      env: spawnEnv,
      // The death pipe. This process holds the only write end, so the kernel
      // hands the server EOF on fd 0 the instant this harness dies, by any
      // means (SIGKILL, the memory guard killing the run's tree, a crash). The
      // server watches it in `~/lib/orphan-exit` and exits immediately; the
      // ppid poll there is only the fallback. Nothing is ever written to it.
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    readStream(p.stdout, "out")
    readStream(p.stderr, "err")
    p.exited.then(() => {
      // Wake every waiter so it can see the exit instead of timing out.
      const waiters = outputWaiters
      outputWaiters = []
      for (const w of waiters) w()
    })
    return p
  }

  /**
   * Resolve once `marker` appears in the output of the latest spawn (stdout or
   * stderr: pino logs to stderr, the ready line goes to stdout), driven by the
   * streams themselves instead of a sleep-and-poll loop. Rejects when the
   * server exits first or the deadline passes.
   */
  const waitForOutput = async (marker: string, timeoutMs: number, what: string): Promise<void> => {
    const deadline = Date.now() + timeoutMs
    while (true) {
      if (
        stdout.indexOf(marker, spawnOffset.out) !== -1 ||
        stderr.indexOf(marker, spawnOffset.err) !== -1
      ) {
        return
      }
      if (proc.exitCode !== null) {
        throw new Error(
          `Worker ${workerId} server exited with code ${proc.exitCode} before ${what}. stderr: ${stderr.slice(-4000)}`,
        )
      }
      const left = deadline - Date.now()
      if (left <= 0) {
        throw new Error(
          `Worker ${workerId} server did not reach ${what} within ${timeoutMs}ms. stdout: ${stdout.slice(-500)} stderr: ${stderr.slice(-500)}`,
        )
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(left, 1_000))
        outputWaiters.push(() => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
  }

  const serverUrl = `http://localhost:${apiPort}`

  // 5. Wait for the listening line (the server cannot answer before it).
  // Each spawn appends to the same buffers; remember the offsets at which the
  // latest server started so a restart doesn't pick up the previous lines.
  try {
    await waitForOutput(LISTENING_MARKER, 15_000, "listening")
  } catch (err) {
    proc.kill("SIGTERM")
    await db.dropWorkerSchemas(workerId)
    await db.close()
    redis.close()
    throw new Error(
      `Worker ${workerId} server failed to start. ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // 6. Wait for app registration readiness (printed once an org exists).
  const waitForReady = async (timeoutMs = 10_000): Promise<void> => {
    await waitForOutput(READY_MARKER, timeoutMs, "app registration (ready)")
  }

  const stopServer = async (opts?: { sweepPort?: boolean }): Promise<void> => {
    if (!running) return
    running = false
    try {
      proc.kill("SIGTERM")
    } catch {
      /* already dead */
    }
    const killTimer = setTimeout(() => {
      try {
        proc.kill("SIGKILL")
      } catch {
        /* already dead */
      }
    }, SERVER_STOP_GRACE_MS)
    try {
      await proc.exited
    } finally {
      clearTimeout(killTimer)
    }
    // Kill stragglers on the port before the next spawn binds it (best effort
    // — covers detached children). Teardown skips it: nothing binds next.
    if (opts?.sweepPort !== false) await killPortHolders([apiPort])
  }

  const startServer = async (opts?: Omit<RestartOptions, "between">): Promise<void> => {
    if (running) throw new Error(`Worker ${workerId} server is already running`)
    if (opts?.resetEnv) spawnEnv = { ...initialSpawnEnv }
    // Merge env overrides into spawnEnv so subsequent spawnServer() calls
    // (including future restarts) carry the new values.
    if (opts?.env) {
      for (const [k, v] of Object.entries(opts.env)) {
        if (v === undefined) delete spawnEnv[k]
        else spawnEnv[k] = v
      }
    }
    // Anchor the next marker scans past the existing output
    spawnOffset = { out: stdout.length, err: stderr.length }
    proc = spawnServer()
    running = true
    await waitForOutput(LISTENING_MARKER, 15_000, "listening after restart")
    await waitForReady(opts?.timeoutMs ?? 30_000)
  }

  // 6b. Restart the spawned server in-place. Used by drift recovery E2E (BE-1):
  //     stop the server, mutate external state (e.g. delete Meili index), then
  //     restart so Phase 10 boot runs again inside the spawned process.
  const restart = async (opts?: RestartOptions): Promise<void> => {
    await stopServer()
    // Run any caller-supplied mutation between stop and spawn — used to
    // delete external state (Meili index, object-store objects, etc.) without the
    // previous server racing the change.
    if (opts?.between) {
      await opts.between()
    }
    await startServer(opts)
  }

  // 7. Teardown function
  const teardown = async () => {
    // Dump server logs for debugging
    const logDir = process.env.LOG_DIR ?? `${process.cwd()}/../../logs`
    if (!logFiles) {
      try {
        mkdirSync(logDir, { recursive: true })
        if (stderr) writeFileSync(`${logDir}/worker-${workerId}-stderr.log`, stderr)
        if (stdout) writeFileSync(`${logDir}/worker-${workerId}-stdout.log`, stdout)
      } catch {
        /* best effort */
      }
    }

    await stopServer({ sweepPort: false })

    // Drop schemas
    await db.dropWorkerSchemas(workerId)
    await db.close()

    // Flush Redis
    await redis.flushKeys(redisPrefix)
    redis.close()

    // Phase 16.5 — clean up per-worker apps install dir.
    try {
      rmSync(appsInstallDir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }

  return {
    workerId,
    serverUrl,
    schemaPrefix,
    redisPrefix,
    meiliIndexPrefix,
    ports,
    // Follows the server's env across restarts; a caller may still pin it
    // (the Playwright fixture records the key it handed the server).
    get encryptionKey() {
      return encryptionKeyOverride ?? spawnEnv.ENCRYPTION_KEY
    },
    set encryptionKey(value: string) {
      encryptionKeyOverride = value
    },
    db,
    redis,
    getStdout: () => stdout,
    getStderr: () => stderr,
    waitForReady,
    restart,
    teardown,
    isRunning: () => running && proc.exitCode === null,
    currentEnv: () => ({ ...spawnEnv }),
    stopServer,
    startServer,
    appsInstallDir,
  }
}

/** Runtimes a test server of ours runs on: a stale listener of a previous run is one of these. */
const OWN_SERVER_COMMANDS = new Set(["bun", "node"])

/**
 * SIGKILL a stale test server of ours that still listens on one of `ports`
 * (never this process). Only TCP listeners are looked at, never a process that
 * merely holds a connection to the port, and only a bun or node process is
 * killed: anything else on the port (Docker's port forwarder publishing a
 * container there, a database, another tool) is not ours to stop. It is left
 * alone with a warning, and the server that wanted the port then fails loudly
 * on the bind.
 */
export async function killPortHolders(ports: number[]): Promise<void> {
  const selfPid = process.pid
  for (const port of ports) {
    try {
      const pids = await commandOutput(["lsof", "-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"])
      if (!pids) continue
      for (const pid of pids.split("\n")) {
        const pidNum = Number(pid)
        if (!Number.isInteger(pidNum) || pidNum <= 0 || pidNum === selfPid) continue
        const command = path.basename(await commandOutput(["ps", "-o", "comm=", "-p", pid]))
        if (!OWN_SERVER_COMMANDS.has(command)) {
          console.warn(
            `[test-helpers] port ${port} is held by pid ${pidNum} (${command || "unknown"}), not a test server: left running`,
          )
          continue
        }
        try {
          process.kill(pidNum, 9)
        } catch {}
      }
    } catch {}
  }
}

async function commandOutput(cmd: string[]): Promise<string> {
  const proc = Bun.spawn({ cmd, stdout: "pipe", stderr: "pipe" })
  const out = (await new Response(proc.stdout).text()).trim()
  await proc.exited
  return out
}

// ── Shared e2e lanes: the file side ─────────────────────────────────────────

/** Env var through which scripts/test-e2e-parallel.ts hands a file its lane. */
export const E2E_LANE_ENV = "LIAISON_E2E_LANE"

export interface LaneInfo {
  workerId: number
  serverUrl: string
  ports: number[]
  schemaPrefix: string
  redisPrefix: string
  meiliIndexPrefix: string
  /** The lane owner's control endpoint (e2e-lane.ts). */
  controlUrl: string
  stdoutPath: string
  stderrPath: string
}

export function readLaneInfo(env: NodeJS.ProcessEnv = process.env): LaneInfo | null {
  const raw = env[E2E_LANE_ENV]
  if (!raw) return null
  return JSON.parse(raw) as LaneInfo
}

async function laneCall(lane: LaneInfo, op: string, body: unknown): Promise<any> {
  const res = await fetch(`${lane.controlUrl}/${op}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`e2e lane ${lane.workerId} ${op} failed: ${res.status} ${text}`)
  return text ? JSON.parse(text) : {}
}

function readTextOr(file: string): string {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return ""
  }
}

/**
 * Attach to the lane's running server: the lane owner resets the worker's data
 * to its post-boot snapshot (restarting the server first when this file wants
 * a different env, or the previous file left an app installed), and the file
 * gets a WorkerEnv over it. `teardown` only closes this process's clients: the
 * server and the schemas belong to the lane.
 */
async function attachToLane(lane: LaneInfo, options?: WorkerEnvOptions): Promise<WorkerEnv> {
  const attached = await resetLane(lane, options?.serverEnv)
  return laneWorkerEnv(lane, attached.encryptionKey)
}

/**
 * Ask the lane owner to put the lane back to its snapshot (restarting the
 * server when `serverEnv` differs from what it runs with, or a runtime app
 * install happened). Returns the server's encryption key and the lane's seed
 * result (e2e-lane.ts `seed`).
 */
export async function resetLane(
  lane: LaneInfo,
  serverEnv?: Record<string, string | undefined>,
): Promise<{ encryptionKey: string; seed: unknown }> {
  return (await laneCall(lane, "attach", { serverEnv: withoutUndefined(serverEnv) })) as {
    encryptionKey: string
    seed: unknown
  }
}

/**
 * A WorkerEnv over a lane's running server, without resetting it. `teardown`
 * only closes this process's clients: the server and the schemas belong to the
 * lane.
 */
export function laneWorkerEnv(lane: LaneInfo, initialEncryptionKey: string): WorkerEnv {
  let encryptionKey = initialEncryptionKey
  const db = createDbClient(DATABASE_URL)
  const redis = createRedisClient(REDIS_URL)
  return {
    workerId: lane.workerId,
    serverUrl: lane.serverUrl,
    schemaPrefix: lane.schemaPrefix,
    redisPrefix: lane.redisPrefix,
    meiliIndexPrefix: lane.meiliIndexPrefix,
    ports: lane.ports,
    get encryptionKey() {
      return encryptionKey
    },
    set encryptionKey(value: string) {
      encryptionKey = value
    },
    db,
    redis,
    bootstrapped: true,
    getStdout: () => readTextOr(lane.stdoutPath),
    getStderr: () => readTextOr(lane.stderrPath),
    waitForReady: async () => {},
    restart: async (opts?: RestartOptions) => {
      await laneCall(lane, "stop", {})
      if (opts?.between) await opts.between()
      const env = opts?.env
        ? Object.fromEntries(Object.entries(opts.env).map(([k, v]) => [k, v ?? null]))
        : undefined
      const started = (await laneCall(lane, "start", { env, timeoutMs: opts?.timeoutMs })) as {
        encryptionKey: string
      }
      encryptionKey = started.encryptionKey
    },
    teardown: async () => {
      await db.close()
      redis.close()
    },
  }
}

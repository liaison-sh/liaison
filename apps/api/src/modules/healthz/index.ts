// SPDX-License-Identifier: FSL-1.1-ALv2
import { createHash, timingSafeEqual } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { sql } from "drizzle-orm"
import { Hono } from "hono"
import { __privileged_db__ as db } from "~/db/connection"
import { getMeili } from "~/infra/search/client"
import { getStorageClient } from "~/infra/storage/object-storage"
import { env } from "~/lib/env"
import { monitorLogger } from "~/lib/logger"
import { redis } from "~/lib/redis"

export const BASELINE_TAG = "v0.1.0"
// Probe budget per dependency. The SAME 200ms that was raised to 2s for /diag in
// be905d53 ("raise /diag dep-probe timeout 200ms -> 2s to stop health-dep
// flapping") -- the sibling endpoint was missed, and this copy is the one the
// CONTAINER healthcheck runs. Object storage round-trips on prod exceed 200ms
// often enough that the check flaps between healthy and "unhealthy deps:
// objectStorage timeout" with the object store itself perfectly healthy, and a deploy that
// lands inside a flap window aborts at its post-recreate health gate
// (deploy-liaison.sh FATAL, 2026-08-27 -- the app was fine and serving 200s the
// whole time). 2s still bounds the probe far under the healthcheck interval
// while only reporting a dep down when it is actually down.
export const TIMEOUT_MS = 2000
const MIGRATIONS_DIR = new URL("../../db/migrations/", import.meta.url).pathname

let ledgerReadFailureLogged = false
let settledHead: { count: number; digest: string } | undefined

function pgErrorCode(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } }
  return e.code ?? e.cause?.code
}

// undefined_table / invalid_schema_name: no ledger yet, the expected zero.
function ledgerAbsent(err: unknown): boolean {
  const code = pgErrorCode(err)
  return code === "42P01" || code === "3F000"
}

// Phase 14 spec: migrationHead is the SHA-256 over (filename + NUL + content)
// for every migration that has been applied. Computed identically here and in
// scripts/build-release-manifest.ts; full 64-char hex (no truncation) so the
// release manifest's expected head can be compared byte-for-byte by an
// upgrade health gate.
//
// "Applied" means a row exists in `drizzle.__drizzle_migrations` for every
// file on disk. When the on-disk set is wider than the applied set the
// endpoint returns `pending:<applied>/<onDisk>` so the upgrade gate sees a
// mismatch rather than a false-positive match against the release manifest.
export async function computeMigrationHead(): Promise<string> {
  const onDisk = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort()
  let appliedCount = 0
  try {
    const r = await db.execute(sql`select count(*)::int as c from drizzle.__drizzle_migrations`)
    // postgres-js driver returns the rows array directly; pg driver wraps in
    // {rows: ...}. Support both shapes so this works under either backend.
    const rows = Array.isArray(r) ? r : (r as { rows?: unknown[] }).rows
    appliedCount = Number((rows as Array<{ c: number }> | undefined)?.[0]?.c ?? 0)
  } catch (err) {
    // Fresh DBs or test schemas without drizzle metadata read as zero applied.
    // Any other failure (a permission error above all) also reads as zero, but
    // is logged once per process: it hid pending:0/N on fully migrated
    // databases whose runtime role could not read the ledger.
    appliedCount = 0
    if (!ledgerAbsent(err) && !ledgerReadFailureLogged) {
      ledgerReadFailureLogged = true
      monitorLogger.warn(
        { err, code: pgErrorCode(err) },
        "healthz: cannot read drizzle.__drizzle_migrations; migrationHead reports pending:0",
      )
    }
  }
  if (appliedCount !== onDisk.length) {
    return `pending:${appliedCount}/${onDisk.length}`
  }
  // The files under MIGRATIONS_DIR are immutable for the life of the process, so
  // once the ledger matches them the digest never changes: hash them once.
  if (settledHead && settledHead.count === onDisk.length) return settledHead.digest
  const h = createHash("sha256")
  for (const f of onDisk) {
    h.update(f)
    h.update("\0")
    h.update(readFileSync(join(MIGRATIONS_DIR, f)))
  }
  const digest = h.digest("hex")
  settledHead = { count: onDisk.length, digest }
  return digest
}

export type DepStatus = "ok" | "error" | "timeout" | "slow"

// The API is single-process: an expensive synchronous stretch (GC pause, a busy
// tick, JSON-parsing a big payload) blocks EVERY pending timer at once, including
// the four dep-probe timeouts below, so a single event-loop stall makes all four
// probes trip together even though the dependencies themselves answered fine.
// Sampled every LAG_SAMPLE_MS: a sample whose actual delay overshoots its
// schedule is exactly that stall, accumulated across the probe window.
const LAG_SAMPLE_MS = 50
// Overrun below this is scheduling jitter, not a real stall -- a timer that
// fires within this slack of its budget is judged to have fired on time.
const OVERRUN_SLACK_MS = 200

export async function withTimeout(probe: () => Promise<DepStatus>, ms: number): Promise<DepStatus> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let lagTimer: ReturnType<typeof setTimeout> | undefined
  let graceTimer: ReturnType<typeof setTimeout> | undefined
  let lagMs = 0
  const start = Date.now()

  const scheduleLagSample = () => {
    const scheduledAt = Date.now()
    lagTimer = setTimeout(() => {
      const overshoot = Date.now() - scheduledAt - LAG_SAMPLE_MS
      if (overshoot > 0) lagMs += overshoot
      scheduleLagSample()
    }, LAG_SAMPLE_MS)
    lagTimer.unref?.()
  }
  scheduleLagSample()

  const probePromise: Promise<DepStatus> = probe().catch((): DepStatus => "error")

  const primaryTimeout = new Promise<DepStatus | "PENDING_STALL">((resolve) => {
    timer = setTimeout(() => {
      const elapsed = Date.now() - start
      const overrun = elapsed - ms
      // The timeout tripped, but did it trip because the DEPENDENCY is
      // unresponsive, or because OUR event loop was too busy to run this timer
      // on schedule? If the overrun is explained by accumulated loop lag, this
      // LOOKS like a busy process rather than a down dependency, but the timer
      // firing late tells us nothing about the probe itself -- it might equally
      // be a dependency that never answers at all. Do not guess: fall through to
      // a bounded grace window that asks the probe directly.
      const stalled = overrun > OVERRUN_SLACK_MS && lagMs >= overrun - OVERRUN_SLACK_MS
      resolve(stalled ? "PENDING_STALL" : "timeout")
    }, ms)
  })

  try {
    const raced = await Promise.race([probePromise, primaryTimeout])
    if (raced !== "PENDING_STALL") return raced

    // The overrun is explained by loop lag, not necessarily by the dependency.
    // Give the still-pending probe one more bounded window (capped at the
    // original budget) to actually answer before deciding it is really down.
    const grace = new Promise<"GRACE_TIMEOUT">((resolve) => {
      graceTimer = setTimeout(() => resolve("GRACE_TIMEOUT"), ms)
      graceTimer.unref?.()
    })
    const graceResult = await Promise.race([probePromise, grace])
    if (graceResult === "GRACE_TIMEOUT") {
      // The probe never answered even with the grace window: it is not our loop
      // that is the problem, the dependency itself is unresponsive.
      return "timeout"
    }
    // The probe settled during the grace window: only a probe that answered OK
    // late is reclassified as slow (our loop was the problem, not the
    // dependency). Any other verdict, thrown or returned by value, is the
    // dependency's real answer and must pass through unchanged.
    const settled = await probePromise
    return settled === "ok" ? "slow" : settled
  } finally {
    if (timer) clearTimeout(timer)
    if (lagTimer) clearTimeout(lagTimer)
    if (graceTimer) clearTimeout(graceTimer)
  }
}

export async function probeDb(): Promise<DepStatus> {
  await db.execute(sql`select 1`)
  return "ok"
}

export async function probeRedis(): Promise<DepStatus> {
  const r = await redis.ping()
  return r === "PONG" ? "ok" : "error"
}

export async function probeMeili(): Promise<DepStatus> {
  const meili = getMeili()
  await meili.health()
  return "ok"
}

export async function probeStorage(): Promise<DepStatus> {
  const s3 = getStorageClient()
  // Use a bucket-scoped probe (ListObjectsV2 against our own bucket, capped at 0
  // keys) rather than ListBuckets: the scoped app identity grants s3:ListBucket /
  // s3:GetBucketLocation but NOT s3:ListAllMyBuckets, so ListBucketsCommand 403s
  // under that policy and reports a healthy storage backend as down. Mirrors the
  // ListObjectsV2Command read path in infra/storage/object-storage.ts.
  const { ListObjectsV2Command } = await import("@aws-sdk/client-s3")
  await s3.send(new ListObjectsV2Command({ Bucket: env.OBJECT_STORAGE_BUCKET, MaxKeys: 1 }))
  return "ok"
}

export interface HealthzDetail {
  status: "ok"
  version: string
  migrationHead: string
  schemaBaseline: string
  dependencies: {
    db: DepStatus
    redis: DepStatus
    meilisearch: DepStatus
    objectStorage: DepStatus
  }
}

// The detailed payload costs four dependency probes plus a ledger count, so it is
// computed at most once per window however many callers ask (and concurrent
// callers share one computation). A few seconds is far below every consumer's
// poll interval (container healthcheck 15 s, deploy gates 2 s+ between tries
// that only need the NEW process to answer) and bounds the load an
// authenticated-or-local caller can impose to one probe round per window.
export const DETAIL_CACHE_MS = 5000
let detailCache: { at: number; value: HealthzDetail } | undefined
let detailInflight: Promise<HealthzDetail> | undefined
/** Tests only: drop the cached payload so a changed dependency is observed. */
export function resetHealthzCache(): void {
  detailCache = undefined
  detailInflight = undefined
}

async function computeDetail(): Promise<HealthzDetail> {
  const [dbR, redisR, meiliR, storageR, migrationHead] = await Promise.all([
    withTimeout(probeDb, TIMEOUT_MS),
    withTimeout(probeRedis, TIMEOUT_MS),
    withTimeout(probeMeili, TIMEOUT_MS),
    withTimeout(probeStorage, TIMEOUT_MS),
    Promise.race([
      computeMigrationHead(),
      new Promise<string>((resolve) => setTimeout(() => resolve("unknown"), TIMEOUT_MS)),
    ]),
  ])
  return {
    status: "ok",
    version: env.LIAISON_VERSION,
    migrationHead,
    schemaBaseline: BASELINE_TAG,
    dependencies: { db: dbR, redis: redisR, meilisearch: meiliR, objectStorage: storageR },
  }
}

/** Dependency status, version and migration head, cached for DETAIL_CACHE_MS. */
export function getHealthzDetail(): Promise<HealthzDetail> {
  const now = Date.now()
  if (detailCache && now - detailCache.at < DETAIL_CACHE_MS)
    return Promise.resolve(detailCache.value)
  if (detailInflight) return detailInflight
  const run = computeDetail()
    .then((value) => {
      detailCache = { at: Date.now(), value }
      return value
    })
    .finally(() => {
      detailInflight = undefined
    })
  detailInflight = run
  return run
}

// A request that came through any proxy carries one of these. A reverse proxy on
// the same host or network reaches the app from a private address, so the
// socket peer alone cannot tell the operator's own curl from the public internet
// arriving through Caddy / nginx / a tunnel: only a request with NO forwarding
// trace and a private peer is treated as local.
const FORWARDING_HEADERS = [
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "forwarded",
  "x-real-ip",
  "cf-connecting-ip",
  "true-client-ip",
  "via",
]

export function isPrivateAddress(raw: string): boolean {
  let ip = raw.trim().toLowerCase()
  if (ip.startsWith("::ffff:")) ip = ip.slice(7)
  if (ip === "::1" || ip === "localhost") return true
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
    const [a, b] = ip.split(".").map(Number) as [number, number]
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    )
  }
  // IPv6 unique-local fc00::/7 and link-local fe80::/10.
  return /^f[cd][0-9a-f]{2}:/.test(ip) || /^fe[89ab][0-9a-f]:/.test(ip)
}

function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * May this caller see the detailed body? Only a local operator (private socket
 * peer, no proxy trace) or a holder of the monitor bearer token. Everyone else
 * gets `{ status }`. A missing socket peer (not a real server socket) is public.
 */
export function wantsHealthzDetail(headers: { get(name: string): string | null }): boolean {
  const auth = headers.get("authorization") ?? ""
  const provided = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : ""
  if (env.MONITOR_TOKEN && provided && tokenMatches(provided, env.MONITOR_TOKEN)) return true
  const peer = headers.get("x-bun-socket-ip")
  if (!peer || !isPrivateAddress(peer)) return false
  return !FORWARDING_HEADERS.some((h) => headers.get(h) !== null)
}

export const healthzRoutes = new Hono().get("/", async (c) => {
  // version + migrationHead + dependency status stay reachable to the self-host
  // upgrade gates (validate-compose.ts, quickstart.sh, the container healthcheck)
  // and the monitor: they all call from the host or container loopback, and
  // while the maintenance flag is set /healthz is the only route that answers.
  // The public internet gets liveness only, with no fingerprint and no probes.
  c.header("Cache-Control", "no-store")
  if (!wantsHealthzDetail(c.req.raw.headers)) return c.json({ status: "ok" })
  return c.json(await getHealthzDetail())
})

/** Admin-session view of the same detail, for the settings page (a browser reaches /healthz via the proxy, so it is liveness-only there). */
export const systemHealthRoutes = new Hono().get("/", async (c) => c.json(await getHealthzDetail()))

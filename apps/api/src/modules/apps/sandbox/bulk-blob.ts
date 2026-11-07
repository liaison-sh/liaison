// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Bulk-blob host service for Phase 16 Task A7 (Gap 5).
//
// Apps that need to ingest large bulk-operation result URLs (Shopify's bulk
// operations, large CSV exports, etc.) declare the `bulk.fetch` capability
// and call `ctx.bulk.fetchToBlob(url) → ctx.bulk.iterateJsonl(blobId) →
// ctx.bulk.deleteBlob(blobId)`. The streaming happens *host-side*: the
// sandbox never sees the raw bytes; it only receives one batch per RPC.
//
// Quota: every org is capped by `BULK_BLOB_QUOTA_BYTES` (default 1 GiB).
// A request that would carry the org over the cap is rejected mid-fetch
// (no partial blob is left on disk).
//
// Broken-JSONL policy: when a line fails to parse the iterator yields a
// sentinel `{ __error: "JsonlParseError", line: <raw>, batchIndex: <n> }`
// inline and continues. Callers decide whether to abort.
import { randomUUID } from "node:crypto"
import { createReadStream, existsSync, promises as fsp, type ReadStream } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { createInterface } from "node:readline"
import { appsLogger as log } from "~/lib/logger"
import { sandboxTenantKey } from "~/modules/apps/custom-app-name"

const DEFAULT_QUOTA_BYTES = 1_073_741_824 // 1 GiB
const DEFAULT_BATCH_SIZE = 50

// An org's custom app (every edition) is a tenant's code on a shared disk:
// its blobs live in their own scope (`custom--<org>--<app>`), with a smaller
// quota of their own, a cap over every custom app's blobs on the server
// together, and an idle lifetime past which they are deleted even if the app
// never deletes them. Catalog and instance apps keep the per-org rule above.
export const CUSTOM_APP_BULK_QUOTA_BYTES = 256 * 1024 * 1024
export const CUSTOM_APP_BULK_CELL_QUOTA_BYTES = 4 * 1_073_741_824
export const CUSTOM_APP_BULK_IDLE_TTL_MS = 60 * 60_000
const CUSTOM_SCOPE_PREFIX = "custom--"

/**
 * The scope (directory) an app's blobs live in for `orgId`: the org itself for
 * catalog and instance apps, `custom--<org>--<app>` for an org's custom app.
 */
export function bulkBlobScope(orgId: string, appName: string): string {
  return sandboxTenantKey(appName) ? `${CUSTOM_SCOPE_PREFIX}${orgId}--${appName}` : orgId
}

const isCustomScope = (scope: string) => scope.startsWith(CUSTOM_SCOPE_PREFIX)

let customLimits = {
  quotaBytes: CUSTOM_APP_BULK_QUOTA_BYTES,
  cellQuotaBytes: CUSTOM_APP_BULK_CELL_QUOTA_BYTES,
  idleTtlMs: CUSTOM_APP_BULK_IDLE_TTL_MS,
}

/** Test seams on the custom-app bulk limits. */
export const BulkBlobTestAccess = {
  /** Smaller custom-app limits. `null` restores the defaults. */
  setCustomLimits(limits: Partial<typeof customLimits> | null): void {
    customLimits = {
      quotaBytes: limits?.quotaBytes ?? CUSTOM_APP_BULK_QUOTA_BYTES,
      cellQuotaBytes: limits?.cellQuotaBytes ?? CUSTOM_APP_BULK_CELL_QUOTA_BYTES,
      idleTtlMs: limits?.idleTtlMs ?? CUSTOM_APP_BULK_IDLE_TTL_MS,
    }
  },
}

/** Every custom-app scope directory on this server. */
async function customScopeDirs(): Promise<string[]> {
  try {
    const entries = await fsp.readdir(baseDir(), { withFileTypes: true })
    return entries
      .filter((e) => e.isDirectory() && e.name.startsWith(CUSTOM_SCOPE_PREFIX))
      .map((e) => join(baseDir(), e.name))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return []
    throw err
  }
}

/**
 * Delete every custom-app blob not written or read for the idle lifetime, and
 * the scope directories left empty. Returns the number of files deleted.
 */
export async function sweepIdleCustomBulkBlobs(now = Date.now()): Promise<number> {
  let removed = 0
  for (const dir of await customScopeDirs()) {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])
    let left = 0
    for (const e of entries) {
      if (!e.isFile()) continue
      const path = join(dir, e.name)
      const st = await fsp.stat(path).catch(() => null)
      if (!st) continue
      if (now - Math.max(st.mtimeMs, st.atimeMs) > customLimits.idleTtlMs) {
        await fsp.unlink(path).catch(() => {})
        removed++
      } else {
        left++
      }
    }
    if (left === 0) await fsp.rmdir(dir).catch(() => {})
  }
  if (removed > 0) log.info({ removed }, "idle custom-app bulk blobs deleted")
  return removed
}

let sweeper: ReturnType<typeof setInterval> | null = null

/** The idle sweep runs in every process that wrote a custom-app blob. */
function ensureCustomSweeper(): void {
  if (sweeper) return
  sweeper = setInterval(
    () => {
      void sweepIdleCustomBulkBlobs().catch((err: unknown) =>
        log.warn({ err }, "custom-app bulk blob sweep failed"),
      )
    },
    Math.max(60_000, Math.floor(customLimits.idleTtlMs / 4)),
  )
  if (typeof sweeper.unref === "function") sweeper.unref()
}

// Per-org serialisation: prevents two concurrent fetchToBlob calls for the
// same org from reading the same `dirSizeBytes` snapshot before either write
// lands, which would allow both to proceed and collectively exceed the cap.
// The map is process-local (single-process API service) — sufficient because
// the quota enforcement is a best-effort cap, not a billing primitive.
//
// Implementation: a promise-queue mutex keyed by sanitized orgKey.
// Each caller chains onto the previous tail promise; `fn` is only invoked
// once the previous holder has released the lock.
const orgLocks = new Map<string, Promise<void>>()

async function withOrgLock<T>(orgKey: string, fn: () => Promise<T>): Promise<T> {
  const prev = orgLocks.get(orgKey) ?? Promise.resolve()

  let releaseLock!: () => void
  // This promise represents "this holder currently holds the lock". It settles
  // only when the current holder calls releaseLock().
  const held = new Promise<void>((resolve) => {
    releaseLock = resolve
  })

  // Enqueue: the next waiter will only start when `held` resolves.
  // We always overwrite the map entry so only the latest tail is tracked; if
  // no other waiter arrives, we clean up after ourselves in the finally block.
  const tail = prev.then(() => held)
  orgLocks.set(orgKey, tail)

  try {
    // Wait for the previous holder to release, then run our work.
    await prev
    return await fn()
  } finally {
    releaseLock()
    // Clean up map entry if we are still the tail (no new waiter arrived).
    if (orgLocks.get(orgKey) === tail) orgLocks.delete(orgKey)
  }
}

function quotaBytes(): number {
  const raw = process.env.BULK_BLOB_QUOTA_BYTES
  if (!raw) return DEFAULT_QUOTA_BYTES
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_QUOTA_BYTES
}

function baseDir(): string {
  const raw = process.env.BULK_BLOB_DIR
  if (raw && raw.length > 0) return resolve(raw)
  return join(tmpdir(), "liaison-bulk-blobs")
}

export function blobPath(orgId: string, blobId: string): string {
  // orgId and blobId are sanitized to alphanumerics + dash to avoid path traversal.
  const safeOrg = orgId.replace(/[^a-zA-Z0-9-]/g, "_")
  const safeBlob = blobId.replace(/[^a-zA-Z0-9-]/g, "_")
  return join(baseDir(), safeOrg, `${safeBlob}.jsonl`)
}

async function ensureDir(p: string): Promise<void> {
  await fsp.mkdir(p, { recursive: true })
}

async function dirSizeBytes(dir: string): Promise<number> {
  let total = 0
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      if (e.isFile()) {
        const st = await fsp.stat(join(dir, e.name))
        total += st.size
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0
    throw err
  }
  return total
}

export interface BulkBlobFetchOpts {
  headers?: Record<string, string>
}

export interface BulkBlobFetchResult {
  blobId: string
  sizeBytes: number
}

export interface BulkBlobIterateOpts {
  batchSize?: number
}

/**
 * Stream `url` to a host file under `${BULK_BLOB_DIR}/${orgId}/${blobId}.jsonl`.
 * Enforces the per-org `BULK_BLOB_QUOTA_BYTES` cap mid-stream — if the running
 * total (current dir size + bytes already streamed for this blob) would exceed
 * the cap, the response is aborted and the partial file is deleted.
 *
 * `fetchImpl` is injected for tests; production passes `globalThis.fetch`.
 */
export async function fetchToBlob(
  orgId: string,
  url: string,
  opts: BulkBlobFetchOpts = {},
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<BulkBlobFetchResult> {
  const orgKey = orgId.replace(/[^a-zA-Z0-9-]/g, "_")
  return withOrgLock(orgKey, () => _fetchToBlobLocked(orgKey, url, opts, fetchImpl))
}

async function _fetchToBlobLocked(
  orgKey: string,
  url: string,
  opts: BulkBlobFetchOpts,
  fetchImpl: typeof fetch,
): Promise<BulkBlobFetchResult> {
  const orgDir = join(baseDir(), orgKey)
  const custom = isCustomScope(orgKey)
  let existingSize: number
  let cap: number
  if (custom) {
    ensureCustomSweeper()
    await sweepIdleCustomBulkBlobs()
    await ensureDir(orgDir)
    const own = await dirSizeBytes(orgDir)
    let all = 0
    for (const dir of await customScopeDirs()) all += await dirSizeBytes(dir)
    // The tighter of the app's own quota and what the server cap leaves.
    const room = Math.min(customLimits.quotaBytes - own, customLimits.cellQuotaBytes - all)
    existingSize = own
    cap = own + Math.max(0, room)
    if (room <= 0) {
      throw new Error(
        own >= customLimits.quotaBytes
          ? `Bulk blob quota exceeded: ${own}/${customLimits.quotaBytes} bytes already used`
          : "Bulk blob quota exceeded: this server's space for custom apps is full",
      )
    }
  } else {
    await ensureDir(orgDir)
    existingSize = await dirSizeBytes(orgDir)
    cap = quotaBytes()
    if (existingSize >= cap) {
      throw new Error(`Bulk blob quota exceeded: ${existingSize}/${cap} bytes already used`)
    }
  }

  const blobId = randomUUID()
  const path = blobPath(orgKey, blobId)
  await ensureDir(dirname(path))

  const res = await fetchImpl(url, { headers: opts.headers })
  if (!res.ok) {
    throw new Error(`fetchToBlob: HTTP ${res.status} for ${url}`)
  }
  if (!res.body) {
    throw new Error(`fetchToBlob: response has no body for ${url}`)
  }

  const file = Bun.file(path)
  const writer = file.writer()
  let written = 0
  try {
    const reader = res.body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      const chunk = value as Uint8Array
      if (existingSize + written + chunk.byteLength > cap) {
        await writer.end()
        await fsp.unlink(path).catch(() => {})
        throw new Error(
          `Bulk blob quota exceeded: would use ${existingSize + written + chunk.byteLength}/${cap} bytes`,
        )
      }
      writer.write(chunk)
      written += chunk.byteLength
    }
    await writer.end()
  } catch (err) {
    try {
      await writer.end()
    } catch {
      // ignore
    }
    if (existsSync(path)) await fsp.unlink(path).catch(() => {})
    throw err
  }

  return { blobId, sizeBytes: written }
}

/**
 * Iterate the JSONL blob in batches. Broken lines yield an in-band sentinel
 * `{ __error, line, batchIndex }` and iteration continues.
 *
 * The implementation reads the file with `readline` over a stream so the
 * sandbox memory envelope stays bounded.
 */
export async function* iterateJsonl(
  orgId: string,
  blobId: string,
  opts: BulkBlobIterateOpts = {},
): AsyncIterable<unknown[]> {
  const batchSize = Math.max(1, opts.batchSize ?? DEFAULT_BATCH_SIZE)
  const path = blobPath(orgId, blobId)
  if (!existsSync(path)) {
    throw new Error(`Bulk blob not found: ${blobId} (org ${orgId})`)
  }

  let stream: ReadStream | null = null
  try {
    stream = createReadStream(path, { encoding: "utf-8" })
    const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY })
    let batch: unknown[] = []
    let batchIndex = 0
    for await (const line of rl) {
      if (line.length === 0) continue
      try {
        batch.push(JSON.parse(line))
      } catch {
        batch.push({ __error: "JsonlParseError", line, batchIndex })
      }
      if (batch.length >= batchSize) {
        yield batch
        batch = []
        batchIndex++
      }
    }
    if (batch.length > 0) yield batch
  } finally {
    if (stream) stream.close()
  }
}

/**
 * Remove the blob's backing file. Safe to call on a missing blob (idempotent).
 */
export async function deleteBlob(orgId: string, blobId: string): Promise<void> {
  const path = blobPath(orgId, blobId)
  if (existsSync(path)) await fsp.unlink(path).catch(() => {})
}

/** Remove every custom-app blob of `orgId` (the org purge). */
export async function deleteOrgCustomBulkBlobs(orgId: string): Promise<void> {
  const prefix = `${CUSTOM_SCOPE_PREFIX}${orgId}--`.replace(/[^a-zA-Z0-9-]/g, "_")
  for (const dir of await customScopeDirs()) {
    if (dir.slice(baseDir().length + 1).startsWith(prefix)) {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  }
}

/** Test helper — wipe everything under a given org's bulk-blob dir. */
export async function _resetOrgBulkBlobs(orgId: string): Promise<void> {
  const orgDir = join(baseDir(), orgId.replace(/[^a-zA-Z0-9-]/g, "_"))
  if (existsSync(orgDir)) await fsp.rm(orgDir, { recursive: true, force: true })
}

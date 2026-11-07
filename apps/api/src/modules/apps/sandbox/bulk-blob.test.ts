// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { utimes } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { _setEdition } from "~/lib/edition"
import { startFixtureServer } from "~/modules/apps/sandbox/__test-helpers__/bulk-blob-fixtures"
import {
  _resetOrgBulkBlobs,
  BulkBlobTestAccess,
  blobPath,
  bulkBlobScope,
  deleteBlob,
  deleteOrgCustomBulkBlobs,
  fetchToBlob,
  iterateJsonl,
  sweepIdleCustomBulkBlobs,
} from "~/modules/apps/sandbox/bulk-blob"

// Per-suite isolation (HERMETIC — the suite asserts exact per-org quota math, so
// its storage must be untouchable by any other file in the flat bun run):
//   - BULK_BLOB_DIR is scoped to a fresh temp dir (pid + random uuid) so blobs
//     from other tests can never collide with ours.
//   - The org ids are RANDOM per run (`bulk-quota-<uuid>` / `bulk-ok-<uuid>`),
//     not the fixed "org-quota"/"org-ok" literals, so even if another file shared
//     our temp dir its blobs would land under a different org subdir and never
//     perturb our quota arithmetic.
//   - BULK_BLOB_DIR / BULK_BLOB_QUOTA_BYTES are PROCESS-GLOBAL env vars. They are
//     re-asserted in `beforeEach` (not just `beforeAll`) so a stray mutation by a
//     neighbouring file cannot leave this suite's quota cap or storage root wrong.
const suiteDir = join(tmpdir(), `bulk-blob-suite-${process.pid}-${randomUUID()}`)
const ORG_QUOTA = `bulk-quota-${randomUUID()}`
const ORG_OK = `bulk-ok-${randomUUID()}`
const QUOTA_BYTES = String(1024 * 1024) // 1 MiB

let fixture: Awaited<ReturnType<typeof startFixtureServer>>

beforeAll(async () => {
  process.env.BULK_BLOB_DIR = suiteDir
  process.env.BULK_BLOB_QUOTA_BYTES = QUOTA_BYTES
  fixture = await startFixtureServer()
})

afterAll(async () => {
  await fixture.stop()
  delete process.env.BULK_BLOB_DIR
  delete process.env.BULK_BLOB_QUOTA_BYTES
})

beforeEach(async () => {
  // Re-assert the storage root + quota cap every test: another file in the flat
  // run may have mutated these global env vars after our `beforeAll`.
  process.env.BULK_BLOB_DIR = suiteDir
  process.env.BULK_BLOB_QUOTA_BYTES = QUOTA_BYTES
  await _resetOrgBulkBlobs(ORG_QUOTA)
  await _resetOrgBulkBlobs(ORG_OK)
})

describe("fetchToBlob", () => {
  it("streams a multi-MiB JSONL fixture into a host file", async () => {
    // Use a fresh per-test org with a generous quota so the big fixture fits.
    process.env.BULK_BLOB_QUOTA_BYTES = String(128 * 1024 * 1024) // 128 MiB
    try {
      const { blobId, sizeBytes } = await fetchToBlob(ORG_OK, fixture.hugeUrl)
      // huge.jsonl is ~2.5 MiB → must be > 2 MiB.
      expect(sizeBytes).toBeGreaterThan(2 * 1024 * 1024)
      expect(existsSync(blobPath(ORG_OK, blobId))).toBe(true)
    } finally {
      process.env.BULK_BLOB_QUOTA_BYTES = QUOTA_BYTES
    }
  })

  it("respects per-org quota — exceeding limit rejects", async () => {
    // 1 MiB cap; hugeUrl emits > 2 MiB → must throw quota error.
    await expect(fetchToBlob(ORG_QUOTA, fixture.hugeUrl)).rejects.toThrow(/quota/i)
  })

  it("leaves no partial file behind when quota trips mid-stream", async () => {
    await expect(fetchToBlob(ORG_QUOTA, fixture.hugeUrl)).rejects.toThrow()
    // Directory may exist but must contain no jsonl files.
    const fs = await import("node:fs/promises")
    const dir = join(suiteDir, ORG_QUOTA)
    let entries: string[] = []
    try {
      entries = await fs.readdir(dir)
    } catch {
      entries = []
    }
    expect(entries.filter((e) => e.endsWith(".jsonl"))).toEqual([])
  })

  it("concurrent fetches for the same org serialize — exactly one fits under the quota", async () => {
    // This test pins the per-org `withOrgLock` mutex, not the trivial
    // single-blob-over-cap case. The fixture is sized so ONE blob fits under the
    // cap but TWO together exceed it:
    //   - cap = 1 MiB (set in beforeAll for ORG_QUOTA)
    //   - one blob ≈ 0.6 MiB  → fits alone (0.6 < 1.0)
    //   - two blobs ≈ 1.2 MiB → exceed together (1.2 > 1.0)
    //
    // Each fetchToBlob reads the org dir's existing size before streaming. If the
    // two calls raced (no lock), both would read existingSize=0, both would
    // stream their ~0.6 MiB blob, and both would commit → 1.2 MiB on disk,
    // silently over the cap. With serialisation, the second call only runs after
    // the first commits, reads the first blob's ~0.6 MiB as existingSize, and its
    // own ~0.6 MiB pushes the running total over 1 MiB → it rejects with a quota
    // error. So exactly one fulfilled + one quota-rejected distinguishes the
    // serialized behaviour from a race (which would yield two fulfilled).
    //
    // Each JSONL row below serialises to ~100 bytes; 6000 rows ≈ 0.6 MiB.
    const halfishRows = Array.from({ length: 6000 }, (_, i) => ({
      idx: i,
      pad: "x".repeat(80),
    }))
    const url = await fixture.jsonlUrl(halfishRows)

    const results = await Promise.allSettled([
      fetchToBlob(ORG_QUOTA, url),
      fetchToBlob(ORG_QUOTA, url),
    ])

    const fulfilled = results.filter((r) => r.status === "fulfilled")
    const rejected = results.filter((r) => r.status === "rejected")
    // Serialisation guarantees the second reader sees the first commit, so exactly
    // one fits and one is quota-rejected. A racing implementation would let both
    // commit (two fulfilled) and overshoot the cap.
    expect(fulfilled.length).toBe(1)
    expect(rejected.length).toBe(1)
    for (const r of rejected) {
      if (r.status === "rejected") expect(r.reason?.message ?? "").toMatch(/quota/i)
    }
    // Belt-and-braces: total committed bytes on disk must not exceed the cap.
    const fs = await import("node:fs/promises")
    const dir = join(suiteDir, ORG_QUOTA)
    const entries = await fs.readdir(dir)
    let totalBytes = 0
    for (const e of entries.filter((n) => n.endsWith(".jsonl"))) {
      totalBytes += (await fs.stat(join(dir, e))).size
    }
    expect(totalBytes).toBeLessThanOrEqual(1024 * 1024)
  })
})

describe("iterateJsonl", () => {
  it("yields batches of the requested size", async () => {
    const url = await fixture.jsonlUrl(["a", "b", "c", "d", "e"])
    const { blobId } = await fetchToBlob(ORG_OK, url)
    const batches: unknown[][] = []
    for await (const batch of iterateJsonl(ORG_OK, blobId, { batchSize: 2 })) {
      batches.push(batch)
    }
    expect(batches.map((b) => b.length)).toEqual([2, 2, 1])
  })

  it("broken JSONL line yields {__error} sentinel in-band and iteration continues", async () => {
    const { blobId } = await fetchToBlob(ORG_OK, fixture.brokenUrl)
    const batches: unknown[][] = []
    for await (const batch of iterateJsonl(ORG_OK, blobId, { batchSize: 10 })) {
      batches.push(batch)
    }
    const flat = batches.flat() as Array<Record<string, unknown>>
    expect(flat.filter((x) => x.__error === "JsonlParseError").length).toBe(1)
    expect(flat.filter((x) => x.__error === undefined).length).toBe(4) // 3 + 1 valid lines
  })

  it("uses default batchSize of 50 when none is supplied", async () => {
    const rows = Array.from({ length: 120 }, (_, i) => ({ idx: i }))
    const url = await fixture.jsonlUrl(rows)
    const { blobId } = await fetchToBlob(ORG_OK, url)
    const batches: unknown[][] = []
    for await (const batch of iterateJsonl(ORG_OK, blobId)) {
      batches.push(batch)
    }
    expect(batches.map((b) => b.length)).toEqual([50, 50, 20])
  })

  it("throws when blob does not exist", async () => {
    const gen = iterateJsonl(ORG_OK, "nonexistent-blob-id")
    await expect(
      (async () => {
        for await (const _ of gen) {
          // drain
        }
      })(),
    ).rejects.toThrow(/not found/i)
  })
})

describe("deleteBlob", () => {
  it("removes the host file", async () => {
    const url = await fixture.jsonlUrl([{ ok: true }])
    const { blobId } = await fetchToBlob(ORG_OK, url)
    expect(existsSync(blobPath(ORG_OK, blobId))).toBe(true)
    await deleteBlob(ORG_OK, blobId)
    expect(existsSync(blobPath(ORG_OK, blobId))).toBe(false)
  })

  it("is idempotent — deleting a missing blob is a no-op", async () => {
    await deleteBlob(ORG_OK, "this-blob-does-not-exist")
    // No throw expected.
  })
})

// An org's custom app (every edition): its own scope, its own quota, a cap
// over all custom apps on the server, and an idle lifetime.
describe("custom apps", () => {
  const ORG = randomUUID()
  const OTHER = randomUUID()
  const APP = "crm-o12345678"
  const bytes = (n: number) =>
    (async () => new Response(`${"x".repeat(n - 1)}\n`)) as unknown as typeof fetch

  beforeEach(() => {
    _setEdition("managed")
    BulkBlobTestAccess.setCustomLimits({
      quotaBytes: 1000,
      cellQuotaBytes: 1500,
      idleTtlMs: 60_000,
    })
  })
  afterAll(async () => {
    await deleteOrgCustomBulkBlobs(ORG)
    await deleteOrgCustomBulkBlobs(OTHER)
    BulkBlobTestAccess.setCustomLimits(null)
    _setEdition(null)
  })

  it("keeps a custom app's blobs in their own scope on every edition; catalog apps keep the org's", () => {
    for (const ed of ["managed", "self_hosted"] as const) {
      _setEdition(ed)
      expect(bulkBlobScope(ORG, APP)).toBe(`custom--${ORG}--${APP}`)
      expect(bulkBlobScope(ORG, "shopify")).toBe(ORG)
    }
  })

  it("refuses past the app's quota and past the server's custom-app cap", async () => {
    const scope = bulkBlobScope(ORG, APP)
    await fetchToBlob(scope, "https://x.example/a", {}, bytes(800))
    await expect(fetchToBlob(scope, "https://x.example/b", {}, bytes(400))).rejects.toThrow(
      "quota exceeded",
    )
    // Another org's custom app: its own quota, but the server cap (1500) is shared.
    const other = bulkBlobScope(OTHER, APP)
    await fetchToBlob(other, "https://x.example/c", {}, bytes(600))
    await expect(fetchToBlob(other, "https://x.example/d", {}, bytes(200))).rejects.toThrow(
      "quota exceeded",
    )
  })

  it("deletes blobs idle past their lifetime, and the purge removes the org's", async () => {
    const scope = bulkBlobScope(ORG, APP)
    await deleteOrgCustomBulkBlobs(ORG)
    await deleteOrgCustomBulkBlobs(OTHER)
    const { blobId } = await fetchToBlob(scope, "https://x.example/e", {}, bytes(100))
    const path = blobPath(scope, blobId)
    expect(existsSync(path)).toBe(true)
    expect(await sweepIdleCustomBulkBlobs()).toBe(0)
    const old = new Date(Date.now() - 120_000)
    await utimes(path, old, old)
    expect(await sweepIdleCustomBulkBlobs()).toBe(1)
    expect(existsSync(path)).toBe(false)
    const again = await fetchToBlob(scope, "https://x.example/f", {}, bytes(100))
    await deleteOrgCustomBulkBlobs(ORG)
    expect(existsSync(blobPath(scope, again.blobId))).toBe(false)
  })
})

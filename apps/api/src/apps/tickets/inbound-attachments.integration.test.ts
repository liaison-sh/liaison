// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, describe, expect, it, mock } from "bun:test"
// HERMETICITY (mock.module global-leak class): the unit suite runs as ONE flat
// `bun test` process, and `mock.module()` replaces a module GLOBALLY for every
// later file — Bun's `mock.restore()` does NOT undo it. A PARTIAL stub here
// would leave later importers of `~/infra/storage/object-storage` (e.g.
// `modules/apps/sandbox/bulk-blob.test.ts`) with a module missing real exports
// (`presignGet`, `fetchToBlob`'s deps, etc.) → spurious failures only in the
// full suite. We defend BOTH ends: (1) spread the REAL module so the stub is
// COMPLETE (only `putObject` is overridden — every other export stays real),
// and (2) re-install the real module in `afterAll` so even that override does
// not leak past this file. See `mock-module-hygiene.test.ts` for the guard.
import * as realObjectStorage from "~/infra/storage/object-storage"

// Eager snapshot: `realObjectStorage` is a LIVE namespace view, so mock.module
// patches it in place — spreading it inside the restore factory would re-install
// the mock. Snapshot the real exports BEFORE the mock so afterAll truly restores.
const realObjectStorageModule = { ...realObjectStorage }

// Mock the storage module BEFORE importing the SUT so persistInboundAttachments
// resolves to our test double. We capture every putObject call including content.
const putObjectCalls: Array<{ key: string; size: number; body: Buffer; contentType: string }> = []
mock.module("~/infra/storage/object-storage", () => ({
  ...realObjectStorageModule,
  putObject: async (args: { key: string; body: Buffer; contentType: string }) => {
    putObjectCalls.push({
      key: args.key,
      size: args.body.byteLength,
      body: args.body,
      contentType: args.contentType,
    })
  },
}))

afterAll(() => {
  // Re-install the real module so the override does not leak to later files.
  mock.module("~/infra/storage/object-storage", () => realObjectStorageModule)
})

const { persistInboundAttachments } = await import("./inbound")

const ORG_ID = "00000000-0000-0000-0000-000000000001"
const MSG_ID = "11111111-1111-1111-1111-111111111111"

describe("persistInboundAttachments", () => {
  it("inserts attachments with correct filename, mimeType, size, and no system-user FK", async () => {
    const insertedRows: Array<Record<string, unknown>> = []
    const execute = async (q: unknown) => {
      // Capture INSERT parameters by stringifying the Drizzle SQL object.
      insertedRows.push({ raw: JSON.stringify(q) })
      return [] as never
    }
    const ctx = {
      db: { execute, queueEvent: async () => {} } as never,
      orgId: ORG_ID,
    }
    putObjectCalls.length = 0

    const aBytes = Buffer.from("hello-image-bytes")
    const bBytes = Buffer.from("doc-content-bytes")
    await persistInboundAttachments(ctx, {
      messageId: MSG_ID,
      attachments: [
        {
          filename: "a.png",
          mimeType: "image/png",
          bytesBase64: aBytes.toString("base64"),
          disposition: "inline",
          contentId: "cid-1",
        },
        {
          filename: "b.pdf",
          mimeType: "application/pdf",
          bytesBase64: bBytes.toString("base64"),
          disposition: "attachment",
        },
      ] as never,
    })

    // Both attachments must reach object storage.
    expect(putObjectCalls).toHaveLength(2)

    // Verify exact content is uploaded — not swapped or zero-filled.
    expect(putObjectCalls[0].body).toEqual(aBytes)
    expect(putObjectCalls[0].contentType).toBe("image/png")
    expect(putObjectCalls[0].key).toContain("a.png")
    expect(putObjectCalls[0].key).toContain(MSG_ID)

    expect(putObjectCalls[1].body).toEqual(bBytes)
    expect(putObjectCalls[1].contentType).toBe("application/pdf")
    expect(putObjectCalls[1].key).toContain("b.pdf")
    expect(putObjectCalls[1].key).toContain(MSG_ID)

    // Sizes reported to storage must match the decoded byte lengths.
    expect(putObjectCalls[0].size).toBe(aBytes.byteLength)
    expect(putObjectCalls[1].size).toBe(bBytes.byteLength)

    // The INSERT must not reference the nil UUID for uploaded_by — that would
    // imply a FK constraint against a non-existent system user row.
    const blob = JSON.stringify(insertedRows)
    expect(blob).not.toContain("00000000-0000-0000-0000-000000000000")
  })

  it("drops attachments exceeding the 25 MB per-attachment cap silently", async () => {
    putObjectCalls.length = 0
    const execute = async () => [] as never
    const ctx = {
      db: { execute, queueEvent: async () => {} } as never,
      orgId: ORG_ID,
    }
    // 26 MB payload — should be dropped.
    const big = Buffer.alloc(26 * 1024 * 1024, 0xab)
    await persistInboundAttachments(ctx, {
      messageId: MSG_ID,
      attachments: [
        {
          filename: "huge.bin",
          mimeType: "application/octet-stream",
          bytesBase64: big.toString("base64"),
          disposition: "attachment",
        },
      ] as never,
    })
    // Nothing written to storage — the per-attachment cap stopped the import.
    expect(putObjectCalls).toHaveLength(0)
  })

  it("stops after the 35 MB cumulative cap is reached, dropping only the excess", async () => {
    putObjectCalls.length = 0
    const execute = async () => [] as never
    const ctx = {
      db: { execute, queueEvent: async () => {} } as never,
      orgId: ORG_ID,
    }
    // Three 20 MB attachments. First fits (20 MB), second would push to 40 MB > 35 MB cap.
    const chunk = Buffer.alloc(20 * 1024 * 1024, 0xcd)
    await persistInboundAttachments(ctx, {
      messageId: MSG_ID,
      attachments: [
        {
          filename: "a.bin",
          mimeType: "application/octet-stream",
          bytesBase64: chunk.toString("base64"),
          disposition: "attachment",
        },
        {
          filename: "b.bin",
          mimeType: "application/octet-stream",
          bytesBase64: chunk.toString("base64"),
          disposition: "attachment",
        },
        {
          filename: "c.bin",
          mimeType: "application/octet-stream",
          bytesBase64: chunk.toString("base64"),
          disposition: "attachment",
        },
      ] as never,
    })
    // Only the first attachment fits under the 35 MB cumulative cap.
    expect(putObjectCalls).toHaveLength(1)
    // And its content must be the original chunk, not a zero-filled buffer.
    expect(putObjectCalls[0].body).toEqual(chunk)
    expect(putObjectCalls[0].key).toContain("a.bin")
  })

  it("queues a kernel file:create event per persisted attachment (thumbnail pipeline trigger)", async () => {
    // Regression: raw-SQL files inserts on the mail-ingest path never emitted
    // the kernel `file:create` event, so the event-driven thumbnail pipeline
    // never fired and inbound images kept thumbnail_key NULL forever (the
    // `?variant=thumb` route then fell back to the multi-MB original).
    const events: Array<Record<string, unknown>> = []
    const ctx = {
      db: {
        execute: async () => [] as never,
        queueEvent: async (e: Record<string, unknown>) => {
          events.push(e)
        },
      } as never,
      orgId: ORG_ID,
    }
    putObjectCalls.length = 0

    const imgBytes = Buffer.from("png-bytes")
    await persistInboundAttachments(ctx, {
      messageId: MSG_ID,
      attachments: [
        {
          filename: "photo.png",
          mimeType: "image/png",
          bytesBase64: imgBytes.toString("base64"),
          disposition: "inline",
        },
        {
          filename: "doc.pdf",
          mimeType: "application/pdf",
          bytesBase64: Buffer.from("pdf").toString("base64"),
          disposition: "attachment",
        },
      ] as never,
    })

    // One event per persisted file (image AND non-image — the standard kernel
    // shape; the thumbnail consumer filters on image/ mimeType itself).
    expect(events).toHaveLength(2)
    for (const e of events) {
      expect(e).toMatchObject({
        app: "kernel",
        entity: "file",
        action: "create",
        orgId: ORG_ID,
        actorType: "system",
      })
    }
    const img = events.find((e) => (e.data as any).mimeType === "image/png") as any
    expect(img).toBeTruthy()
    // The data shape must match what enqueueThumbnailForEvent reads:
    // { id, mimeType, storageKey } all present and truthy.
    expect(img.data.id).toBe(img.entityId)
    expect(img.data.storageKey).toContain("photo.png")
    expect(img.data.sizeBytes).toBe(imgBytes.byteLength)
    expect(img.data.entityId).toBe(MSG_ID)
  })
})

// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, beforeAll, describe, expect, it, mock, spyOn } from "bun:test"
import sharp from "sharp"
import type { PrivilegedDb } from "~/db"
import {
  DurableConsumersTestAccess,
  registerDurableEventConsumer,
  runDurableConsumers,
} from "~/infra/events/durable-consumers"
import type { AppEvent } from "~/infra/events/event-bus"
import * as jobsModule from "~/infra/jobs/jobs"
import type { ThumbnailDeps } from "./thumbnail-job"

type ThumbModule = typeof import("./thumbnail-job")
let mod: ThumbModule

beforeAll(async () => {
  mod = await import("./thumbnail-job")
})

const ORG = "00000000-0000-0000-0000-000000000001"
const FILE_ID = "00000000-0000-0000-0000-000000000fff"

async function makeJpegBuffer(width = 800, height = 600): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 50, b: 50 } },
  })
    .jpeg()
    .toBuffer()
}

describe("processThumbnailJob", () => {
  it("decodes nothing whose bytes are not jpeg, png, webp or gif, whatever the declared type", async () => {
    // A TIFF declared as image/png: the sender's MIME claim must not pick the decoder.
    const tiff = await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .tiff()
      .toBuffer()
    const put = mock(async () => {})
    await mod.processThumbnailJob(
      { fileId: FILE_ID, orgId: ORG, storageKey: "orgs/x/fake.png", mimeType: "image/png" },
      {
        headObject: mock(async () => ({
          contentLength: tiff.byteLength,
          contentType: "image/png",
        })) as ThumbnailDeps["headObject"],
        getObjectBuffer: mock(async () => tiff) as ThumbnailDeps["getObjectBuffer"],
        putObject: put as unknown as ThumbnailDeps["putObject"],
        privileged: async (_reason, fn) =>
          fn({ execute: async () => [] } as unknown as PrivilegedDb),
      },
    )
    expect(put).not.toHaveBeenCalled()
  })

  it("generates 512px WebP thumbnail for image/jpeg and updates thumbnail_key", async () => {
    const jpeg = await makeJpegBuffer()
    const putCalls: { key: string; body: Buffer | Uint8Array; contentType: string }[] = []
    const updates: { id: string; key: string }[] = []
    await mod.processThumbnailJob(
      { fileId: FILE_ID, orgId: ORG, storageKey: "orgs/x/img.jpg", mimeType: "image/jpeg" },
      {
        headObject: mock(async () => ({
          contentLength: jpeg.byteLength,
          contentType: "image/jpeg",
        })) as ThumbnailDeps["headObject"],
        getObjectBuffer: mock(async () => jpeg) as ThumbnailDeps["getObjectBuffer"],
        putObject: mock(
          async (args: { key: string; body: Buffer | Uint8Array; contentType: string }) => {
            putCalls.push(args)
          },
        ) as ThumbnailDeps["putObject"],
        privileged: async (_reason, fn) =>
          fn({
            execute: async (q: { queryChunks?: unknown }) => {
              const text = String(q?.queryChunks ?? q ?? "")
              if (text.includes("UPDATE")) {
                updates.push({ id: FILE_ID, key: putCalls[0]?.key ?? "" })
              }
              return []
            },
          } as unknown as PrivilegedDb),
      },
    )
    expect(putCalls).toHaveLength(1)
    expect(putCalls[0].key).toBe("orgs/x/img.jpg.thumb.webp")
    expect(putCalls[0].contentType).toBe("image/webp")
    const meta = await sharp(Buffer.from(putCalls[0].body)).metadata()
    expect(meta.format).toBe("webp")
    expect(meta.width ?? 0).toBeLessThanOrEqual(512)
    expect(meta.height ?? 0).toBeLessThanOrEqual(512)
  })

  it("never enlarges a small image: a 120x80 source keeps 120x80", async () => {
    const jpeg = await makeJpegBuffer(120, 80)
    const putCalls: { key: string; body: Buffer | Uint8Array; contentType: string }[] = []
    await mod.processThumbnailJob(
      { fileId: FILE_ID, orgId: ORG, storageKey: "orgs/x/small.jpg", mimeType: "image/jpeg" },
      {
        headObject: mock(async () => ({
          contentLength: jpeg.byteLength,
          contentType: "image/jpeg",
        })) as ThumbnailDeps["headObject"],
        getObjectBuffer: mock(async () => jpeg) as ThumbnailDeps["getObjectBuffer"],
        putObject: mock(
          async (args: { key: string; body: Buffer | Uint8Array; contentType: string }) => {
            putCalls.push(args)
          },
        ) as ThumbnailDeps["putObject"],
        privileged: async (_reason, fn) =>
          fn({ execute: async () => [] } as unknown as PrivilegedDb),
      },
    )
    const meta = await sharp(Buffer.from(putCalls[0].body)).metadata()
    expect(meta.width).toBe(120)
    expect(meta.height).toBe(80)
  })

  it("skips non-image mime types", async () => {
    const putObject = mock(async () => {})
    await mod.processThumbnailJob(
      {
        fileId: FILE_ID,
        orgId: ORG,
        storageKey: "orgs/x/d.pdf",
        mimeType: "application/pdf",
      },
      {
        headObject: mock(async () => {
          throw new Error("should not call headObject for non-image")
        }) as ThumbnailDeps["headObject"],
        getObjectBuffer: mock(async () => {
          throw new Error("should not be called")
        }) as ThumbnailDeps["getObjectBuffer"],
        putObject: putObject as ThumbnailDeps["putObject"],
        privileged: async () => {
          throw new Error("should not run privileged tx")
        },
      },
    )
    expect(putObject).toHaveBeenCalledTimes(0)
  })

  it("rethrows on sharp processing failure so BullMQ retries", async () => {
    // JPEG magic (so the sniff lets it through to the decoder), then garbage.
    const corrupt = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]),
      Buffer.from("not really an image body"),
    ])
    await expect(
      mod.processThumbnailJob(
        { fileId: FILE_ID, orgId: ORG, storageKey: "orgs/x/bad.jpg", mimeType: "image/jpeg" },
        {
          headObject: mock(async () => ({
            contentLength: corrupt.byteLength,
            contentType: "image/jpeg",
          })) as ThumbnailDeps["headObject"],
          getObjectBuffer: mock(async () => corrupt) as ThumbnailDeps["getObjectBuffer"],
          putObject: mock(async () => {}) as ThumbnailDeps["putObject"],
          privileged: async () => {
            throw new Error("should not reach")
          },
        },
      ),
    ).rejects.toBeDefined()
  })

  it("skips thumbnail when headObject reports object over size cap", async () => {
    const putObject = mock(async () => {})
    await mod.processThumbnailJob(
      { fileId: FILE_ID, orgId: ORG, storageKey: "orgs/x/huge.jpg", mimeType: "image/jpeg" },
      {
        headObject: mock(async () => ({
          contentLength: 100 * 1024 * 1024,
          contentType: "image/jpeg",
        })) as ThumbnailDeps["headObject"],
        getObjectBuffer: mock(async () => {
          throw new Error("should not stream oversized object")
        }) as ThumbnailDeps["getObjectBuffer"],
        putObject: putObject as ThumbnailDeps["putObject"],
        privileged: async () => {
          throw new Error("should not run privileged tx")
        },
      },
    )
    expect(putObject).toHaveBeenCalledTimes(0)
  })
})

describe("thumbnail durable consumer error propagation (I-EVT-2)", () => {
  afterEach(() => {
    DurableConsumersTestAccess.reset()
  })

  const fileCreateEvent: AppEvent = {
    app: "kernel",
    entity: "file",
    action: "create",
    orgId: ORG,
    data: { id: FILE_ID, mimeType: "image/png", storageKey: "orgs/x/img.png" },
  }

  it("propagates an enqueue failure so the outbox retries (no swallow)", async () => {
    const spy = spyOn(jobsModule, "enqueueAppJob").mockRejectedValue(new Error("redis unavailable"))
    try {
      DurableConsumersTestAccess.reset()
      mod.registerThumbnailDurableConsumer()
      await expect(
        runDurableConsumers({ eventId: "evt-thumb-1", event: fileCreateEvent }),
      ).rejects.toThrow("redis unavailable")
    } finally {
      spy.mockRestore()
    }
  })

  it("ignores non-image / non-file events without enqueueing", async () => {
    const spy = spyOn(jobsModule, "enqueueAppJob").mockResolvedValue(undefined as never)
    try {
      DurableConsumersTestAccess.reset()
      mod.registerThumbnailDurableConsumer()
      registerDurableEventConsumer("noop-guard", async () => {})
      await runDurableConsumers({
        eventId: "evt-thumb-2",
        event: { ...fileCreateEvent, data: { id: FILE_ID, mimeType: "application/pdf" } },
      })
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })
})

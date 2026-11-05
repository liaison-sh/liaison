// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql } from "drizzle-orm"
import { fileTypeFromBuffer } from "file-type"
import sharp from "sharp"
import type { PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"

const K = sql.raw(schemaRef("kernel"))

import {
  type DurableEventContext,
  registerDurableEventConsumer,
} from "~/infra/events/durable-consumers"
import { onEvent } from "~/infra/events/event-bus"
import { enqueueAppJob, registerJobWorker } from "~/infra/jobs/jobs"
import {
  getObjectBuffer as defaultGetObjectBuffer,
  headObject as defaultHeadObject,
  putObject as defaultPutObject,
} from "~/infra/storage/object-storage"
import { filesLogger as log } from "~/lib/logger"
import {
  isEncryptedAttachment,
  logDerivativeSkip,
} from "~/modules/mailbox-crypto/attachment-derivatives"

export interface ThumbnailJobPayload {
  fileId: string
  orgId: string
  storageKey: string
  mimeType: string
}

export interface ThumbnailDeps {
  getObjectBuffer?: typeof defaultGetObjectBuffer
  headObject?: typeof defaultHeadObject
  putObject?: typeof defaultPutObject
  privileged?: <T>(reason: string, fn: (tx: PrivilegedDb) => Promise<T>) => Promise<T>
}

// 512 keeps Slack-style inline previews (rendered up to ~320 CSS px) sharp on
// 2x-density displays while staying cheap to store and stream.
const MAX_DIMENSION = 512
const THUMB_SUFFIX = ".thumb.webp"
const SIZE_LIMIT_BYTES = 50 * 1024 * 1024
// The attachment's declared MIME type is the sender's claim. The bytes decide
// which decoder runs, and only the four formats a customer actually mails as
// images are decoded here; anything else (HEIC, TIFF, SVG, a polyglot) gets no
// thumbnail rather than a trip through libvips' wider decoder set.
const THUMBNAIL_FORMATS = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"])
// A decompression bomb is a small file that decodes to billions of pixels.
const MAX_INPUT_PIXELS = 64_000_000

export function thumbnailKeyFor(storageKey: string): string {
  return `${storageKey}${THUMB_SUFFIX}`
}

export async function processThumbnailJob(
  payload: ThumbnailJobPayload,
  deps: ThumbnailDeps = {},
): Promise<void> {
  if (!payload.mimeType.startsWith("image/")) return

  // A thumbnail is a plaintext rendering, and a sealed mail attachment has no
  // plaintext the server can reach. Skip explicitly and say so once: a throw
  // here would be retried forever against bytes that will never decode.
  if (await isEncryptedAttachment(payload.orgId, payload.fileId)) {
    logDerivativeSkip("thumbnail", payload.fileId, payload.orgId)
    return
  }

  const getBuffer = deps.getObjectBuffer ?? defaultGetObjectBuffer
  const head = deps.headObject ?? defaultHeadObject
  const put = deps.putObject ?? defaultPutObject
  const privileged =
    deps.privileged ?? ((reason, fn) => withPrivilegedDb(payload.orgId, reason, fn))

  // Check object size before streaming to avoid loading an oversized image into
  // memory. A missing or zero Content-Length is treated as unknown; the byte
  // cap is then enforced during streaming via getObjectBuffer's maxBytes option.
  const meta = await head(payload.storageKey)
  if (meta.contentLength > 0 && meta.contentLength > SIZE_LIMIT_BYTES) {
    log.warn({ fileId: payload.fileId, size: meta.contentLength }, "skipping thumbnail: too large")
    return
  }

  const source = await getBuffer(payload.storageKey, undefined, { maxBytes: SIZE_LIMIT_BYTES })
  if (source.byteLength > SIZE_LIMIT_BYTES) {
    log.warn({ fileId: payload.fileId, size: source.byteLength }, "skipping thumbnail: too large")
    return
  }

  const sniffed = await fileTypeFromBuffer(source)
  if (!sniffed || !THUMBNAIL_FORMATS.has(sniffed.mime)) {
    log.warn(
      { fileId: payload.fileId, declared: payload.mimeType, sniffed: sniffed?.mime ?? null },
      "skipping thumbnail: content is not a jpeg, png, webp or gif",
    )
    return
  }

  const thumbBuf = await sharp(source, {
    failOn: "none",
    limitInputPixels: MAX_INPUT_PIXELS,
    sequentialRead: true,
  })
    // Never enlarge: a 120x80 image upscaled to 512 px is only a blurry copy
    // of itself. A small image's thumbnail is the image at its own size.
    .resize(MAX_DIMENSION, MAX_DIMENSION, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer()

  const thumbKey = thumbnailKeyFor(payload.storageKey)
  await put({ key: thumbKey, body: thumbBuf, contentType: "image/webp" })

  await privileged("files:thumbnail", async (tx) => {
    await tx.execute(
      sql`UPDATE ${K}.files SET thumbnail_key = ${thumbKey} WHERE id = ${payload.fileId}`,
    )
  })
}

export function registerThumbnailJobWorker(): void {
  registerJobWorker("kernel", "files-thumbnail", async (payload) => {
    await processThumbnailJob(payload as ThumbnailJobPayload)
  })
}

async function enqueueThumbnailForEvent(event: {
  app: string
  entity: string
  action: string
  orgId: string
  data?: unknown
}): Promise<void> {
  if (event.app !== "kernel" || event.entity !== "file" || event.action !== "create") return
  const data = (event.data ?? {}) as {
    id?: string
    mimeType?: string
    storageKey?: string
  }
  if (!data.id || !data.mimeType?.startsWith("image/") || !data.storageKey) return
  await enqueueAppJob(
    "kernel",
    "files-thumbnail",
    {
      fileId: data.id,
      orgId: event.orgId,
      storageKey: data.storageKey,
      mimeType: data.mimeType,
    },
    { jobId: `files-thumbnail:${data.id}` },
  )
}

/**
 * Live in-process bridge — low-latency enqueue when the API process saw the
 * event. Tolerates failures because the durable consumer below is authoritative.
 */
export function registerThumbnailEventBridge(): void {
  onEvent(
    async (event) => {
      try {
        await enqueueThumbnailForEvent(event)
      } catch (err) {
        log.warn({ err }, "thumbnail enqueue (live) failed — durable consumer will retry")
      }
    },
    // Once (A5): the publishing process enqueues; peers' copies are not re-enqueued.
    { delivery: "once", name: "files-thumbnail-bridge" },
  )
}

/**
 * Durable consumer — survives process restart and missed live events. BullMQ
 * deduplicates by `jobId = files-thumbnail:<fileId>` so a re-fire from the
 * outbox replay does not produce a duplicate thumbnail job.
 *
 * Errors propagate (I-EVT-2): if the enqueue fails the durable consumer throws,
 * the outbox keeps the event unprocessed and retries it (then dead-letters
 * after MAX_ATTEMPTS). The jobId dedup makes re-enqueue a no-op, so at-least-
 * once delivery cannot create duplicate thumbnail jobs. Swallowing here dropped
 * the thumbnail forever on a transient Redis/BullMQ blip.
 */
export function registerThumbnailDurableConsumer(): void {
  registerDurableEventConsumer("files-thumbnail", async (ctx: DurableEventContext) => {
    if (ctx.event.ephemeral) return
    await enqueueThumbnailForEvent(ctx.event)
  })
}

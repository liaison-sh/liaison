// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * S3 multipart uploads: the browser path (presigned part URLs, the store
 * keeps the parts, ListParts to resume) and the server path (a stream of
 * unknown length written in 8 MiB parts, for attachments a transform asks the
 * host to download). No `@aws-sdk/lib-storage`: the commands are few and the
 * part bookkeeping is ours.
 *
 * Signed with the browser client config (checksums only when required, see
 * `presignClientConfig`), and part URLs get the public-host rewrite like
 * `presignPut`.
 */
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetBucketCorsCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { env } from "~/lib/env"
import { type ObjectStorageDeps, presignClientConfig, rewritePublicHostFor } from "./object-storage"

/** S3's bounds: at most 10,000 parts, each at least 5 MiB except the last. */
export const MULTIPART_MAX_PARTS = 10_000
export const MULTIPART_MIN_PART_BYTES = 8 * 1024 * 1024
/** Parts aim for at most 9,000 so a file a little larger than declared still fits. */
const TARGET_PARTS = 9_000
const MIB = 1024 * 1024

let client: S3Client | null = null

/** One client for both paths: signing and server-side calls, checksums only when required. */
function s3(d?: ObjectStorageDeps): {
  s3: S3Client
  bucket: string
  publicUrl: string | undefined
} {
  if (!d?.s3 && !client) client = new S3Client(presignClientConfig())
  return {
    s3: d?.s3 ?? (client as S3Client),
    bucket: d?.bucket ?? env.OBJECT_STORAGE_BUCKET,
    publicUrl: d?.publicUrl ?? env.OBJECT_STORAGE_PUBLIC_URL,
  }
}

/** Part size for a file: max(8 MiB, size / 9,000), rounded up to a whole MiB. */
export function multipartPartSize(size: number): number {
  const wanted = Math.max(MULTIPART_MIN_PART_BYTES, Math.ceil(size / TARGET_PARTS))
  return Math.ceil(wanted / MIB) * MIB
}

export function multipartPartCount(size: number, partSize: number): number {
  return Math.max(1, Math.ceil(size / partSize))
}

export async function createMultipartUpload(
  args: { key: string; contentType: string },
  d?: ObjectStorageDeps,
): Promise<string> {
  const { s3: c, bucket } = s3(d)
  const r = await c.send(
    new CreateMultipartUploadCommand({
      Bucket: bucket,
      Key: args.key,
      ContentType: args.contentType,
    }),
  )
  if (!r.UploadId) throw new Error("The object store returned no multipart upload id")
  return r.UploadId
}

/**
 * A presigned part PUT. Content-Length is a signed header, so the store
 * refuses a part of any other size: a part URL cannot carry more bytes than
 * the upload declared (and reserved against the quota).
 */
export async function presignUploadPart(
  args: {
    key: string
    uploadId: string
    partNumber: number
    contentLength: number
    expiresInSec?: number
  },
  d?: ObjectStorageDeps,
): Promise<string> {
  const { s3: c, bucket, publicUrl } = s3(d)
  const url = await getSignedUrl(
    c,
    new UploadPartCommand({
      Bucket: bucket,
      Key: args.key,
      UploadId: args.uploadId,
      PartNumber: args.partNumber,
      ContentLength: args.contentLength,
    }),
    { expiresIn: args.expiresInSec ?? 3600, signableHeaders: new Set(["content-length"]) },
  )
  return rewritePublicHostFor(url, publicUrl)
}

export interface UploadedPart {
  partNumber: number
  etag: string
  size: number
}

/** Every part the store holds for an upload, read 1,000 at a time. */
export async function listUploadedParts(
  args: { key: string; uploadId: string },
  d?: ObjectStorageDeps,
): Promise<UploadedPart[]> {
  const { s3: c, bucket } = s3(d)
  const parts: UploadedPart[] = []
  let marker: string | undefined
  for (;;) {
    const r = await c.send(
      new ListPartsCommand({
        Bucket: bucket,
        Key: args.key,
        UploadId: args.uploadId,
        MaxParts: 1000,
        ...(marker ? { PartNumberMarker: marker } : {}),
      }),
    )
    for (const p of r.Parts ?? []) {
      if (p.PartNumber && p.ETag)
        parts.push({ partNumber: p.PartNumber, etag: p.ETag, size: Number(p.Size ?? 0) })
    }
    if (!r.IsTruncated || !r.NextPartNumberMarker) break
    marker = String(r.NextPartNumberMarker)
  }
  return parts.sort((a, b) => a.partNumber - b.partNumber)
}

export async function completeMultipartUpload(
  args: { key: string; uploadId: string; parts: Array<{ partNumber: number; etag: string }> },
  d?: ObjectStorageDeps,
): Promise<void> {
  const { s3: c, bucket } = s3(d)
  await c.send(
    new CompleteMultipartUploadCommand({
      Bucket: bucket,
      Key: args.key,
      UploadId: args.uploadId,
      MultipartUpload: {
        Parts: [...args.parts]
          .sort((a, b) => a.partNumber - b.partNumber)
          .map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
      },
    }),
  )
}

export async function abortMultipartUpload(
  args: { key: string; uploadId: string },
  d?: ObjectStorageDeps,
): Promise<void> {
  const { s3: c, bucket } = s3(d)
  try {
    await c.send(
      new AbortMultipartUploadCommand({ Bucket: bucket, Key: args.key, UploadId: args.uploadId }),
    )
  } catch (err) {
    // Already gone (completed, aborted, or expired by a bucket lifecycle rule).
    if ((err as { name?: string })?.name === "NoSuchUpload") return
    throw err
  }
}

export class StreamTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`The download is larger than ${maxBytes} bytes; refused.`)
    this.name = "StreamTooLargeError"
  }
}

/**
 * Write a stream of unknown length to one object, in 8 MiB parts (a single
 * PUT when it fits in one part). Past `maxBytes` the upload is aborted and
 * nothing is left behind. Returns the bytes written.
 */
export async function putObjectStream(
  args: {
    key: string
    contentType: string
    body: AsyncIterable<Uint8Array>
    maxBytes: number
    partSize?: number
    signal?: AbortSignal
  },
  d?: ObjectStorageDeps,
): Promise<number> {
  const { s3: c, bucket } = s3(d)
  const partSize = Math.max(MULTIPART_MIN_PART_BYTES, args.partSize ?? MULTIPART_MIN_PART_BYTES)
  let buffered: Uint8Array[] = []
  let bufferedBytes = 0
  let total = 0
  let uploadId: string | null = null
  const parts: Array<{ partNumber: number; etag: string }> = []

  const flushPart = async (final: boolean) => {
    if (bufferedBytes === 0 && !final) return
    const body = Buffer.concat(buffered, bufferedBytes)
    buffered = []
    bufferedBytes = 0
    if (!uploadId) {
      uploadId = await createMultipartUpload({ key: args.key, contentType: args.contentType }, d)
    }
    const partNumber = parts.length + 1
    if (partNumber > MULTIPART_MAX_PARTS) throw new StreamTooLargeError(args.maxBytes)
    const r = await c.send(
      new UploadPartCommand({
        Bucket: bucket,
        Key: args.key,
        UploadId: uploadId,
        PartNumber: partNumber,
        Body: body,
        ContentLength: body.byteLength,
      }),
      args.signal ? { abortSignal: args.signal } : {},
    )
    if (!r.ETag) throw new Error("The object store returned no ETag for a part")
    parts.push({ partNumber, etag: r.ETag })
  }

  try {
    for await (const chunk of args.body) {
      if (args.signal?.aborted) throw args.signal.reason ?? new Error("aborted")
      total += chunk.byteLength
      if (total > args.maxBytes) throw new StreamTooLargeError(args.maxBytes)
      buffered.push(chunk)
      bufferedBytes += chunk.byteLength
      if (bufferedBytes >= partSize) await flushPart(false)
    }
    if (!uploadId) {
      // It all fit in one part: one plain PUT.
      const body = Buffer.concat(buffered, bufferedBytes)
      await c.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: args.key,
          Body: body,
          ContentType: args.contentType,
        }),
        args.signal ? { abortSignal: args.signal } : {},
      )
      return total
    }
    if (bufferedBytes > 0) await flushPart(true)
    await completeMultipartUpload({ key: args.key, uploadId, parts }, d)
    return total
  } catch (err) {
    if (uploadId) await abortMultipartUpload({ key: args.key, uploadId }, d).catch(() => undefined)
    throw err
  }
}

export interface BucketCorsStatus {
  ok: boolean
  /** What is missing, for the warning; empty when ok. */
  problems: string[]
}

/**
 * Whether browsers can upload parts straight to the bucket: a CORS rule must
 * allow PUT and expose ETag (the browser reads each part's ETag to complete
 * the upload). A bucket with no CORS configuration is reported as a problem
 * too, although some stores (SeaweedFS) answer with permissive defaults.
 */
export async function checkBucketCorsForMultipart(
  d?: ObjectStorageDeps,
): Promise<BucketCorsStatus> {
  const { s3: c, bucket } = s3(d)
  try {
    const r = await c.send(new GetBucketCorsCommand({ Bucket: bucket }))
    const rules = r.CORSRules ?? []
    const put = rules.some((rule) =>
      (rule.AllowedMethods ?? []).some((m) => m.toUpperCase() === "PUT"),
    )
    const etag = rules.some((rule) =>
      (rule.ExposeHeaders ?? []).some((h) => h.toLowerCase() === "etag" || h === "*"),
    )
    const problems: string[] = []
    if (!put) problems.push("no CORS rule allows PUT")
    if (!etag) problems.push("no CORS rule exposes the ETag header")
    return { ok: problems.length === 0, problems }
  } catch (err) {
    const name = (err as { name?: string })?.name ?? "error"
    if (name === "NoSuchCORSConfiguration") {
      return { ok: false, problems: ["the bucket has no CORS configuration"] }
    }
    return { ok: false, problems: [`the bucket's CORS configuration could not be read (${name})`] }
  }
}

/** Test access: drop the cached client (tests that change the store env). */
export const MultipartTestAccess = {
  resetClient(): void {
    client = null
  },
}

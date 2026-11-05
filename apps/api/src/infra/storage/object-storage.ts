// SPDX-License-Identifier: FSL-1.1-ALv2
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { env } from "~/lib/env"

export interface ObjectStorageDeps {
  s3?: S3Client
  bucket?: string
  publicUrl?: string | undefined
}

let _s3: S3Client | null = null

/** The S3 client options for the configured store (exported for its test). */
export function storageClientConfig(e: typeof env = env): S3ClientConfig {
  return {
    endpoint: e.OBJECT_STORAGE_ENDPOINT,
    region: e.OBJECT_STORAGE_REGION,
    // "aws-default" leaves credentials to the SDK's default chain (the EC2
    // instance role on the box); it refreshes them itself, and a presigned URL
    // is valid for its own expiry within the role session's lifetime.
    ...(e.OBJECT_STORAGE_AUTH === "aws-default"
      ? {}
      : {
          credentials: {
            accessKeyId: e.OBJECT_STORAGE_ACCESS_KEY,
            secretAccessKey: e.OBJECT_STORAGE_SECRET_KEY,
          },
        }),
    forcePathStyle: e.OBJECT_STORAGE_FORCE_PATH_STYLE,
  }
}

export function getStorageClient(): S3Client {
  if (!_s3) _s3 = new S3Client(storageClientConfig())
  return _s3
}

/**
 * The client that signs URLs a BROWSER will use. Same store and credentials,
 * but checksums only when an operation requires one: by default the SDK adds
 * `x-amz-checksum-crc32` computed over the EMPTY body it sees at signing time
 * to every presigned PUT, so S3 rejects the browser's real bytes (BadDigest),
 * and adds `x-amz-checksum-mode` to every presigned GET.
 */
export function presignClientConfig(e: typeof env = env): S3ClientConfig {
  return {
    ...storageClientConfig(e),
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  }
}

let _presignS3: S3Client | null = null

function getPresignClient(): S3Client {
  if (!_presignS3) _presignS3 = new S3Client(presignClientConfig())
  return _presignS3
}

function deps(d?: ObjectStorageDeps) {
  return {
    s3: d?.s3 ?? getStorageClient(),
    bucket: d?.bucket ?? env.OBJECT_STORAGE_BUCKET,
    publicUrl: d?.publicUrl ?? env.OBJECT_STORAGE_PUBLIC_URL,
  }
}

function presignDeps(d?: ObjectStorageDeps) {
  return { ...deps(d), s3: d?.s3 ?? getPresignClient() }
}

export function rewritePublicHostFor(signedUrl: string, publicUrl: string | undefined): string {
  if (!publicUrl) return signedUrl
  const u = new URL(signedUrl)
  const p = new URL(publicUrl)
  u.protocol = p.protocol
  u.hostname = p.hostname
  u.port = p.port
  return u.toString()
}

/**
 * A presigned PUT for one object. Content-Type and Content-Length are SIGNED
 * headers, so the store refuses a body of another size or type outright; the
 * confirm step still HEADs the object before any row exists. A browser sends
 * just `Content-Type` (it sets the length itself).
 */
export async function presignPut(
  args: { key: string; contentLength: number; contentType: string; expiresInSec?: number },
  d?: ObjectStorageDeps,
): Promise<string> {
  const { s3, bucket, publicUrl } = presignDeps(d)
  const cmd = new PutObjectCommand({
    Bucket: bucket,
    Key: args.key,
    ContentLength: args.contentLength,
    ContentType: args.contentType,
  })
  const url = await getSignedUrl(s3, cmd, {
    expiresIn: args.expiresInSec ?? 900,
    signableHeaders: new Set(["content-type", "content-length"]),
  })
  return rewritePublicHostFor(url, publicUrl)
}

/**
 * A presigned GET. The `response*` overrides are signed into the URL, so the
 * store answers with exactly those headers: a download is pinned to
 * `attachment` and its stored type, never rendered from the bucket origin.
 */
export async function presignGet(
  args: {
    key: string
    expiresInSec?: number
    responseContentDisposition?: string
    responseContentType?: string
    responseCacheControl?: string
    responseContentEncoding?: string
  },
  d?: ObjectStorageDeps,
): Promise<string> {
  const { s3, bucket, publicUrl } = presignDeps(d)
  const cmd = new GetObjectCommand({
    Bucket: bucket,
    Key: args.key,
    ResponseContentDisposition: args.responseContentDisposition,
    ResponseContentType: args.responseContentType,
    ResponseCacheControl: args.responseCacheControl,
    ResponseContentEncoding: args.responseContentEncoding,
  })
  const url = await getSignedUrl(s3, cmd, { expiresIn: args.expiresInSec ?? 300 })
  return rewritePublicHostFor(url, publicUrl)
}

export interface HeadResult {
  contentLength: number
  contentType: string
  /** The stored Content-Encoding, or null when the object has none. */
  contentEncoding?: string | null
}

export async function headObject(key: string, d?: ObjectStorageDeps): Promise<HeadResult> {
  const { s3, bucket } = deps(d)
  const r = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
  return {
    contentLength: Number(r.ContentLength ?? 0),
    contentType: r.ContentType ?? "application/octet-stream",
    contentEncoding: r.ContentEncoding ?? null,
  }
}

export async function getObjectBuffer(
  key: string,
  d?: ObjectStorageDeps,
  opts?: { maxBytes?: number },
): Promise<Buffer> {
  const { s3, bucket } = deps(d)
  const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))

  // Fast path: the SDK may expose a transformToByteArray helper that reads the
  // entire body at once. When a maxBytes cap is set we skip it and stream
  // chunk-by-chunk so we can abort early.
  const body = r.Body as unknown as { transformToByteArray?: () => Promise<Uint8Array> }
  if (!opts?.maxBytes && body?.transformToByteArray) {
    return Buffer.from(await body.transformToByteArray())
  }

  // Streaming path — enforces the hard byte ceiling regardless of what the
  // Content-Length header said (or didn't say). A missing/zero Content-Length
  // is treated as unknown, never trusted as "no data".
  const stream = r.Body as unknown as AsyncIterable<Uint8Array>
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of stream) {
    total += chunk.byteLength
    if (opts?.maxBytes !== undefined && total > opts.maxBytes) {
      throw new Error(`Object exceeds maxBytes=${opts.maxBytes} during streaming`)
    }
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

export interface ObjectStreamResult {
  stream: ReadableStream<Uint8Array>
  contentType: string
  contentLength: number
}

/**
 * Streaming read for large-object delivery (downloads). Unlike
 * `getObjectBuffer` the bytes never accumulate in process memory, so there is
 * no size cap — the caller pipes the stream straight into the HTTP response.
 */
export async function getObjectStream(
  key: string,
  d?: ObjectStorageDeps,
): Promise<ObjectStreamResult> {
  const { s3, bucket } = deps(d)
  const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  const body = r.Body as unknown as { transformToWebStream: () => ReadableStream<Uint8Array> }
  return {
    stream: body.transformToWebStream(),
    contentType: r.ContentType ?? "application/octet-stream",
    contentLength: Number(r.ContentLength ?? 0),
  }
}

export interface ObjectRangeResult {
  bytes: Buffer
  contentType: string
  /** Bytes actually returned, which is the requested span. */
  contentLength: number
  /** Total object size, parsed from the store's `Content-Range`, or null. */
  totalLength: number | null
}

/**
 * Byte-range read, inclusive on both ends, exactly as HTTP means it.
 *
 * This is what serves a sealed attachment: the browser asks for the ciphertext
 * chunks covering the plaintext range it wants, decrypts them in its crypto
 * worker and slices the result. The server never assembles the file, and it
 * could not read it if it did.
 */
export async function getObjectRange(
  key: string,
  range: { start: number; end: number },
  d?: ObjectStorageDeps,
): Promise<ObjectRangeResult> {
  const { s3, bucket } = deps(d)
  const r = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=${range.start}-${range.end}` }),
  )
  const body = r.Body as unknown as {
    transformToByteArray?: () => Promise<Uint8Array>
  } & AsyncIterable<Uint8Array>
  let bytes: Buffer
  if (body.transformToByteArray) {
    bytes = Buffer.from(await body.transformToByteArray())
  } else {
    const chunks: Buffer[] = []
    for await (const chunk of body) chunks.push(Buffer.from(chunk))
    bytes = Buffer.concat(chunks)
  }
  const total = /\/(\d+)$/.exec(r.ContentRange ?? "")
  return {
    bytes,
    contentType: r.ContentType ?? "application/octet-stream",
    contentLength: bytes.byteLength,
    totalLength: total ? Number(total[1]) : null,
  }
}

export async function putObject(
  args: { key: string; body: Buffer | Uint8Array; contentType: string },
  d?: ObjectStorageDeps,
): Promise<void> {
  const { s3, bucket } = deps(d)
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: args.key,
      Body: args.body,
      ContentType: args.contentType,
    }),
  )
}

/**
 * Server-side copy of one stored object to a new key. Bytes never transit the
 * API process — S3 copies internally. CopySource is bucket-qualified and the
 * key is URL-encoded (path separators included) so spaces / unicode in
 * filenames cannot corrupt the request. AWS S3 and R2 accept a fully
 * URL-encoded key here; if a future S3-compatible endpoint rejects `%2F`,
 * encode only the filename segment and leave separators literal.
 */
export async function copyObject(
  args: { sourceKey: string; destKey: string },
  d?: ObjectStorageDeps,
): Promise<void> {
  const { s3, bucket } = deps(d)
  await s3.send(
    new CopyObjectCommand({
      Bucket: bucket,
      CopySource: `${bucket}/${encodeURIComponent(args.sourceKey)}`,
      Key: args.destKey,
    }),
  )
}

export async function deleteObject(key: string, d?: ObjectStorageDeps): Promise<void> {
  const { s3, bucket } = deps(d)
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
}

export async function deleteObjects(keys: string[], d?: ObjectStorageDeps): Promise<void> {
  if (keys.length === 0) return
  const { s3, bucket } = deps(d)
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000)
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: batch.map((Key) => ({ Key })) },
      }),
    )
  }
}

export interface ListedObject {
  Key: string
  LastModified: Date
}

/** `orgs/<orgId>/`, or a folder below it (`sub`, ending in `/`). */
function orgPrefix(args: { orgId: string; sub?: string }): string {
  if (!/^[0-9a-f-]{36}$/i.test(args.orgId)) throw new Error("orgPrefix: not an org uuid")
  const sub = args.sub ?? ""
  if (sub && (!/^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*\/$/.test(sub) || sub.includes(".."))) {
    throw new Error("orgPrefix: a sub-prefix is folder names ending in /")
  }
  return `orgs/${args.orgId}/${sub}`
}

export async function* listOrgPrefixIter(
  args: { orgId: string; sub?: string },
  d?: ObjectStorageDeps,
): AsyncGenerator<ListedObject> {
  yield* listPrefixIter(orgPrefix(args), d)
}

async function* listPrefixIter(
  prefix: string,
  d?: ObjectStorageDeps,
): AsyncGenerator<ListedObject> {
  const { s3, bucket } = deps(d)
  let token: string | undefined
  do {
    const r = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: token,
      }),
    )
    for (const o of r.Contents ?? []) {
      if (o.Key) yield { Key: o.Key, LastModified: o.LastModified ?? new Date(0) }
    }
    token = r.IsTruncated ? r.NextContinuationToken : undefined
  } while (token)
}

export async function listOrgPrefix(
  args: { orgId: string; maxKeys?: number },
  d?: ObjectStorageDeps,
): Promise<{ objects: ListedObject[] }> {
  const objects: ListedObject[] = []
  for await (const o of listOrgPrefixIter(args, d)) {
    objects.push(o)
    if (args.maxKeys && objects.length >= args.maxKeys) break
  }
  return { objects }
}

/**
 * Delete every object under `orgs/<orgId>/` (or a folder below it, `sub`), in
 * batches, and return how many went. For retiring a whole organisation (the
 * demo reaper) or a crashed import run's staged files; a missing prefix is
 * simply zero.
 */
export async function deleteOrgPrefix(
  args: { orgId: string; sub?: string },
  d?: ObjectStorageDeps,
): Promise<number> {
  orgPrefix(args)
  let batch: string[] = []
  let total = 0
  for await (const o of listOrgPrefixIter(args, d)) {
    batch.push(o.Key)
    if (batch.length >= 1000) {
      await deleteObjects(batch, d)
      total += batch.length
      batch = []
    }
  }
  if (batch.length > 0) {
    await deleteObjects(batch, d)
    total += batch.length
  }
  return total
}

/**
 * Delete every object under an instance-level folder (`instance/...`, ending in
 * `/`), in batches, and return how many went. A missing prefix is zero.
 */
export async function deleteInstancePrefix(prefix: string, d?: ObjectStorageDeps): Promise<number> {
  if (!/^instance\/([A-Za-z0-9._-]+\/)+$/.test(prefix) || prefix.includes("..")) {
    throw new Error("deleteInstancePrefix: an instance folder is instance/<names>/")
  }
  let batch: string[] = []
  let total = 0
  for await (const o of listPrefixIter(prefix, d)) {
    batch.push(o.Key)
    if (batch.length >= 1000) {
      await deleteObjects(batch, d)
      total += batch.length
      batch = []
    }
  }
  if (batch.length > 0) {
    await deleteObjects(batch, d)
    total += batch.length
  }
  return total
}

const PATH_SEP_RE = /[\\/]/g

export function sanitizeFilename(name: string): string {
  let n = name.normalize("NFC")
  if (n.includes("/") || n.includes("\\")) {
    const parts = n.split(PATH_SEP_RE).filter(Boolean)
    n = parts[parts.length - 1] ?? ""
  }
  // Strip any control chars and leading dots that would create hidden files.
  n = Array.from(n)
    .filter((char) => char.charCodeAt(0) > 0x1f)
    .join("")
  n = n.replace(/^\.+/, "")
  if (!n) return "file"
  // Limit to 255 bytes
  while (Buffer.byteLength(n, "utf8") > 255) {
    n = n.slice(0, -1)
  }
  return n
}

/**
 * Test access to this module's private state, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const ObjectStorageTestAccess = {
  resetClient(): void {
    _s3 = null
    _presignS3 = null
  },
}

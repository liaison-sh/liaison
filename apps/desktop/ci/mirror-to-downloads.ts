#!/usr/bin/env bun

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Copying a verified release onto the public downloads host.
//
// The GitHub release is the project's private record of what was built. It is
// not a distribution channel: the repository is private, so every asset on it
// answers 404 to an anonymous client. The public surface is the R2 bucket
// behind downloads.liaison.sh, and this is the step that puts a release there.
//
// TRANSPORT. Objects go through R2's S3 compatible endpoint, never through the
// Cloudflare REST object API: that one caps a request body at 100 MB and has
// no multipart, and the disk image is already past it. The body is streamed
// from a Bun.file, so nothing here holds an installer in memory, and the size
// is checked against the plan before a byte moves.
//
// The request is a PUT presigned by Bun's own S3 client rather than that
// client's `write`, for one reason: `write` sends Content-Type and NOTHING
// else. It has no cache-control option, so every object would land with the
// edge's default lifetime, and `latest.json` cached for hours is a release
// nobody is offered. A presigned url signs the host alone, so the PUT carries
// both headers, and R2 stores them as the object's metadata.
//
// ORDER IS THE SAFETY PROPERTY. latest.json is the one object every installed
// copy acts on with no human in the loop, and it names files by url. Publish
// it before those files exist and every machine that polls in that window
// downloads a 404, decides the update failed, and may well do it again on the
// next tick. So:
//
//   1. the versioned artifacts, under desktop/<version>/, immutable;
//   2. each one verified by a PUBLIC read of downloads.liaison.sh, because
//      what matters is not that the PUT was accepted, it is that the custom
//      domain serves the bytes (a bucket whose domain is not attached answers
//      every one of those reads with nothing while every upload succeeds);
//   3. the stable aliases under desktop/latest/, which a download page links;
//   4. latest.json, LAST, and only if everything above succeeded;
//   5. then, and only then, the channel's old version folders are pruned
//      down to the newest --keep (default 3; prune-downloads.ts). A prune
//      failure is a warning: the release has already gone out.
//
// It refuses to run at all unless the two signature gate passes again, here,
// over the same request the publish job acted on, AND the latest.json on disk
// is the manifest that gate just produced, field for field. That is a re-run
// of verify-and-publish.ts in dry run mode, not a second implementation of it:
// this script must never become a way to put bytes in front of customers that
// the gate never saw.
//
// Usage:
//   bun apps/desktop/ci/mirror-to-downloads.ts \
//     --request <publish-request.json> --manifest <latest.json> \
//     --artifacts <dir> [--dry-run] [--keep <n>]
//
// --keep 0 turns pruning off. A dry run prints the prune it would do when the
// bucket credentials are in the environment, and skips it when they are not.

import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { S3Client } from "bun"
import {
  ACCESS_KEY_ID_ENV,
  ACCOUNT_ENV,
  ALIAS_PREFIX,
  ALIASES,
  aliasSource,
  BUCKET,
  contentTypeFor,
  downloadUrl,
  IMMUTABLE_CACHE_CONTROL,
  isTestVersion,
  keyInChannel,
  MAX_SINGLE_PUT_BYTES,
  type ManifestShape,
  manifestKeyFor,
  manifestPayloadNames,
  ROLLING_CACHE_CONTROL,
  SECRET_ACCESS_KEY_ENV,
  s3Endpoint,
  versionPrefix,
} from "./downloads"
import { DEFAULT_KEEP, parseKeep, realPruneIo, runPrune } from "./prune-downloads"
import { type PublishRequest, publishManifest } from "./verify-and-publish"

/** Files that belong to the private record and not on a public host. The
 *  Windows job's signing marker is an internal note about what CI did. */
export const NOT_MIRRORED = new Set(["windows-signing.json", "latest.json"])

export interface MirrorFile {
  /** The name the object takes on the downloads host. */
  name: string
  /** Where the bytes are on this machine. */
  path: string
  size: number
}

export type MirrorStage = "versioned" | "alias" | "manifest"

export interface MirrorStep {
  stage: MirrorStage
  /** The R2 object key, which is also the path under downloads.liaison.sh. */
  key: string
  /** The file the body is STREAMED from. Never bytes: an installer read into
   *  memory to be uploaded is a runner that dies on the next one. */
  source: string
  size: number
  contentType: string
  cacheControl: string
}

/**
 * Every difference between the manifest on disk and the one the gate just
 * verified, as sentences. Empty means they are the same manifest.
 *
 * The gate writes latest.json and this script reads it back off the same
 * runner, so in a healthy release the two are identical. When they are not,
 * the file on disk is from another run or was edited between the two steps,
 * and mirroring it would publish a manifest no gate ever held.
 */
export function manifestDifferences(onDisk: ManifestShape, verified: ManifestShape): string[] {
  const differences: string[] = []
  if (onDisk.version !== verified.version) {
    differences.push(`version on disk is ${onDisk.version}, the gate verified ${verified.version}`)
  }
  // The notes are the one field a human writes, they reach a customer inside
  // the update prompt, and they are what an edit between the two steps would
  // most plausibly touch. `pub_date` is deliberately NOT compared: the gate
  // stamps it from the clock every time it runs, so the re-run here always
  // carries a later one and comparing it would refuse every release.
  if ((onDisk.notes ?? "") !== (verified.notes ?? "")) {
    differences.push("the release notes on disk are not the ones the gate verified")
  }
  const onDiskKeys = Object.keys(onDisk.platforms ?? {}).sort()
  const verifiedKeys = Object.keys(verified.platforms ?? {}).sort()
  if (onDiskKeys.join(",") !== verifiedKeys.join(",")) {
    differences.push(
      `platforms on disk are ${onDiskKeys.join(", ") || "none"}, the gate verified ${verifiedKeys.join(", ") || "none"}`,
    )
  }
  for (const key of verifiedKeys) {
    const mine = onDisk.platforms?.[key]
    const theirs = verified.platforms?.[key]
    if (!mine || !theirs) continue
    if (mine.url !== theirs.url) differences.push(`${key}: url on disk is ${mine.url}`)
    if (mine.signature !== theirs.signature) {
      differences.push(`${key}: the signature on disk is not the one the gate verified`)
    }
  }
  return differences
}

/**
 * The whole plan, as data, with no I/O anywhere in it.
 *
 * Everything this script can get wrong that a log would not show is decided
 * here: the order, the cache lifetimes, which file each alias is a copy of,
 * and the refusals. A test drives it directly.
 */
export function planMirror(input: {
  /** The latest.json that will be published. */
  manifest: ManifestShape
  /** The manifest the two signature gate just verified, to compare it with. */
  verified: ManifestShape
  /** Every artifact to publish, already walked out of the download. */
  files: MirrorFile[]
  /** The manifest itself, on disk. */
  manifestFile: MirrorFile
}): MirrorStep[] {
  const { manifest, verified, files, manifestFile } = input

  // Refusal one: the file about to be published is not the manifest the gate
  // held. Checked first, because every check after it is about a manifest
  // that may not be the one that matters.
  const drift = manifestDifferences(manifest, verified)
  if (drift.length > 0) {
    throw new Error(
      `the manifest on disk is not the one the two signature gate verified:\n  ${drift.join("\n  ")}`,
    )
  }

  const version = manifest.version
  // Refusal two: a url anywhere but the downloads host. Throws, by name.
  const payloads = manifestPayloadNames(manifest)

  const present = new Map<string, MirrorFile>()
  for (const file of files) {
    if (present.has(file.name)) {
      throw new Error(
        `two files in the download are both named ${file.name}: ` +
          "the downloads host is flat per version, so one of them would silently overwrite the other",
      )
    }
    present.set(file.name, file)
  }

  // Refusal three: the manifest names a payload the download does not carry.
  // Uploading the rest and the manifest would leave one platform pointing at
  // a url that is never written.
  for (const [key, name] of payloads) {
    if (!present.has(name)) {
      throw new Error(
        `the manifest names ${name} for ${key}, and it is not in the artifacts directory: ` +
          "publishing the manifest would point that platform at a file nothing ever uploads",
      )
    }
  }

  const steps: MirrorStep[] = []
  const prefix = versionPrefix(version)
  for (const file of [...files].sort((left, right) => left.name.localeCompare(right.name))) {
    steps.push({
      stage: "versioned",
      key: `${prefix}/${file.name}`,
      source: file.path,
      size: file.size,
      contentType: contentTypeFor(file.name),
      cacheControl: IMMUTABLE_CACHE_CONTROL,
    })
  }

  const names = new Set(present.keys())
  // A test build has no stable download links: desktop/latest/ is what the
  // download page links for customers.
  for (const spec of isTestVersion(version) ? [] : ALIASES) {
    const source = aliasSource(spec, version, names)
    if (!source) {
      throw new Error(
        `nothing in the artifacts directory can be published as ${spec.alias}: ` +
          `no ${spec.kind} was built for ${spec.platform} at ${version}. ` +
          "The download page links that name, so an absent alias is a dead link rather than a missing option.",
      )
    }
    const file = present.get(source) as MirrorFile
    steps.push({
      stage: "alias",
      key: `${ALIAS_PREFIX}/${spec.alias}`,
      source: file.path,
      size: file.size,
      contentType: contentTypeFor(spec.alias),
      cacheControl: ROLLING_CACHE_CONTROL,
    })
  }

  steps.push({
    stage: "manifest",
    key: manifestKeyFor(version),
    source: manifestFile.path,
    size: manifestFile.size,
    contentType: contentTypeFor("latest.json"),
    cacheControl: ROLLING_CACHE_CONTROL,
  })
  // THE CHANNEL WALL. A test version writes under desktop/test/ and nowhere
  // else, a release never there. Checked over the finished plan, the one thing
  // the upload loop acts on, so no future step can be added around it.
  const strays = steps.filter((step) => !keyInChannel(step.key, version))
  if (strays.length > 0) {
    throw new Error(
      `refusing to mirror ${version}: ${strays.map((step) => step.key).join(", ")} ` +
        (isTestVersion(version)
          ? "is outside desktop/test/, and a test build must never touch what customers download"
          : "is under desktop/test/, which is the test channel"),
    )
  }
  return steps
}

export interface DownloadsCredentials {
  accountId: string
  accessKeyId: string
  secretAccessKey: string
}

/** Everything a message must never carry out of this process. */
function secretsOf(credentials: DownloadsCredentials): string[] {
  return [credentials.secretAccessKey, credentials.accessKeyId, credentials.accountId]
}

/** Replaces any credential that found its way into a message. Cloudflare and
 *  the S3 client both name the account and the key in error text, and these
 *  errors end up in a CI log a wider set of people can read than can read the
 *  secret. Applied to every message this module throws or prints. */
export function redact(text: string, secrets: readonly string[]): string {
  let output = text
  for (const secret of secrets) {
    if (!secret || secret.length < 8) continue
    output = output.split(secret).join("[redacted]")
  }
  // A presigned url is itself a credential: anybody holding it can write that
  // object until it expires. The whole url goes, and a bare signature
  // parameter that reached the text some other way goes with it.
  output = output.replace(/https?:\/\/\S*[?&]X-Amz-Signature=\S*/gi, "[redacted url]")
  output = output.replace(/X-Amz-Signature=[A-Za-z0-9%]+/gi, "X-Amz-Signature=[redacted]")
  return output
}

/** A failure of the transport, carrying whether trying again could help.
 *  A 5xx or a dropped connection is worth another attempt; a 4xx is the
 *  server saying the request itself is wrong, and repeating it just spends
 *  the release's time. */
export class TransportError extends Error {
  readonly status: number | undefined
  readonly retryable: boolean
  constructor(message: string, status: number | undefined, retryable: boolean) {
    super(message)
    this.name = "TransportError"
    this.status = status
    this.retryable = retryable
  }
}

export function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 429
}

/** A READ BACK also retries a 404, which an upload never would.
 *
 *  On the upload side a 4xx is the server saying the request is wrong and
 *  repeating it just spends the release's time. On the read back side a 404
 *  is most often the object being a moment behind: R2 accepted the PUT and
 *  the edge has not seen it yet. That is the one 4xx worth another attempt,
 *  and it is why every read carries a fresh cache buster: the edge caches
 *  that 404, so a retry on the same url would read the miss it is retrying. */
export function isRetryableReadStatus(status: number): boolean {
  return isRetryableStatus(status) || status === 404
}

export const RETRY_ATTEMPTS = 3

/** The narrow slice of fetch this module uses, declared rather than taken
 *  from the global, so a test can hand it a function and TypeScript still
 *  checks both sides. */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<{
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  text(): Promise<string>
  arrayBuffer(): Promise<ArrayBuffer>
}>

/** One object, streamed from disk. The uploader is handed a PATH and a size,
 *  never bytes, which is what keeps a 123 MB disk image out of this process's
 *  heap no matter what the implementation behind it does. */
export type Uploader = (request: {
  key: string
  source: string
  size: number
  contentType: string
  cacheControl: string
}) => Promise<void>

/** Everything that touches the world, injectable so the ordering, the
 *  refusals and the retries can be driven with no network anywhere near
 *  them. There is deliberately no "read these bytes" member. */
export interface MirrorIo {
  upload: Uploader
  /** A public read of downloads.liaison.sh. */
  fetch: FetchLike
  /** The size of a file on disk, for the preflight. */
  fileSize(file: string): number
  log(message: string): void
  sleep(ms: number): Promise<void>
}

/**
 * The real uploader: a PUT presigned by Bun's built in S3 client, with the
 * body streamed from a Bun.file.
 *
 * `S3Client.write` would be shorter and it sends Content-Type and nothing
 * else, so every object would take the edge's default cache lifetime. A
 * presigned url signs the host alone, which leaves the PUT free to carry both
 * headers and R2 free to store them.
 */
export function realUploader(
  credentials: DownloadsCredentials,
  /** The S3 endpoint, overridable so a test can point the REAL uploader at a
   *  server on 127.0.0.1 and read the request it actually sends. */
  endpoint: string = s3Endpoint(credentials.accountId),
): Uploader {
  const client = new S3Client({
    endpoint,
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    bucket: BUCKET,
    region: "auto",
  })
  return async (request) => {
    const url = client.presign(request.key, { method: "PUT", expiresIn: 3600 })
    let response: { ok: boolean; status: number; text(): Promise<string> }
    try {
      response = await fetch(url, {
        method: "PUT",
        headers: {
          "Content-Type": request.contentType,
          "Cache-Control": request.cacheControl,
        },
        body: Bun.file(request.source),
      })
    } catch (error) {
      throw new TransportError(
        `${request.key}: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        true,
      )
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "")
      throw new TransportError(
        `${request.key}: ${response.status} ${detail}`.trim(),
        response.status,
        isRetryableStatus(response.status),
      )
    }
  }
}

export function realMirrorIo(credentials: DownloadsCredentials): MirrorIo {
  return {
    upload: realUploader(credentials),
    fetch: (url, init) => fetch(url, init as RequestInit),
    fileSize: (file) => statSync(file).size,
    log: (message) => console.log(redact(message, secretsOf(credentials))),
    sleep: (ms) => Bun.sleep(ms),
  }
}

/** Three attempts, backing off, and only while trying again could help. */
async function withRetry<T>(
  label: string,
  io: MirrorIo,
  attempt: (tries: number) => Promise<T>,
): Promise<T> {
  let last: unknown
  for (let tries = 1; tries <= RETRY_ATTEMPTS; tries += 1) {
    try {
      return await attempt(tries)
    } catch (error) {
      last = error
      const retryable = error instanceof TransportError ? error.retryable : true
      if (!retryable || tries === RETRY_ATTEMPTS) break
      io.log(`${label}: attempt ${tries} failed, retrying`)
      await io.sleep(500 * 2 ** (tries - 1))
    }
  }
  throw last
}

/** The size the public host reports, or undefined when it reports none.
 *
 *  Content-Length is absent on a chunked or compressed response, and
 *  `Number("")` is 0, so a missing header read as a number says the host
 *  serves an empty file and fails a release that is fine. Asked for with
 *  identity encoding first, then settled with a one byte ranged GET, and only
 *  a real disagreement is a failure. */
async function servedSize(
  url: string,
  step: MirrorStep,
  io: MirrorIo,
  headers: Record<string, string>,
): Promise<number | undefined> {
  const head = await io.fetch(url, { method: "HEAD", headers })
  if (!head.ok) {
    throw new TransportError(
      `${url} is not readable after it was uploaded: ${head.status}. ` +
        "Either the custom domain is not attached to the bucket or the object did not land.",
      head.status,
      isRetryableReadStatus(head.status),
    )
  }
  const reported = head.headers.get("content-length")
  if (reported !== null && reported.trim() !== "" && Number.isFinite(Number(reported))) {
    return Number(reported)
  }
  // No length: ask for one byte and read the total out of Content-Range.
  const ranged = await io.fetch(url, {
    method: "GET",
    headers: { ...headers, Range: "bytes=0-0" },
  })
  if (!ranged.ok) {
    throw new TransportError(
      `${url} answered ${ranged.status} to a ranged read`,
      ranged.status,
      isRetryableReadStatus(ranged.status),
    )
  }
  const range = ranged.headers.get("content-range") ?? ""
  const total = /\/(\d+)\s*$/.exec(range)?.[1]
  if (total !== undefined) return Number(total)
  // Still nothing, and the object is small enough to count: the manifest is
  // the one that matters, and it is a kilobyte.
  if (step.size <= 1024 * 1024) {
    const whole = await io.fetch(url, { method: "GET", headers })
    if (!whole.ok) {
      throw new TransportError(
        `${url} answered ${whole.status} to a full read`,
        whole.status,
        isRetryableReadStatus(whole.status),
      )
    }
    return (await whole.arrayBuffer()).byteLength
  }
  return undefined
}

/** The public read. Not a read of the API: what has to be true is that
 *  downloads.liaison.sh serves these bytes to somebody with no credential at
 *  all, which is a different question from whether the PUT was accepted.
 *
 *  EVERY read carries a cache busting query string, and a FRESH one on every
 *  attempt. Two different caches would otherwise answer with something other
 *  than what was just uploaded: a rolling key (an alias, the manifest) may
 *  still have the object it REPLACED at the edge, and a versioned key read a
 *  moment too early has its 404 NEGATIVELY cached, so a retry would re-read
 *  the miss it is retrying and a race with R2 would become a failed release.
 *  A rolling key sends the no-cache request header as well. */
async function verifyPublic(
  step: MirrorStep,
  io: MirrorIo,
  nonce: string,
  attempt: number,
): Promise<void> {
  const rolling = step.stage !== "versioned"
  const url = `${downloadUrl(step.key)}?mirror-check=${nonce}-${attempt}`
  const headers: Record<string, string> = { "Accept-Encoding": "identity" }
  if (rolling) headers["Cache-Control"] = "no-cache"
  const served = await servedSize(url, step, io, headers)
  if (served === undefined) {
    io.log(`${step.key}: the host reports no size, the read back checked reachability only`)
    return
  }
  if (served !== step.size) {
    throw new TransportError(
      `${url} serves ${served} bytes and the file uploaded is ${step.size}: the object on the host is not the artifact that was verified`,
      undefined,
      false,
    )
  }
}

/** Refuses before the transport: a source that is not the size the plan was
 *  built from is a file that changed under the run, and one past what a single
 *  request can carry has to fail by name rather than at the far end of an
 *  upload. */
function preflight(step: MirrorStep, io: MirrorIo): void {
  // Outside the retry loop on purpose, and its own failure is not a
  // TransportError: a source that is missing or unreadable is a local fact
  // that three attempts and a backoff cannot change.
  let actual: number
  try {
    actual = io.fileSize(step.source)
  } catch (error) {
    throw new Error(
      `${step.source} cannot be read, so ${step.key} cannot be published: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  if (actual !== step.size) {
    throw new Error(
      `${step.source} is ${actual} bytes and the plan was built from ${step.size}: the file changed after it was verified`,
    )
  }
  if (actual > MAX_SINGLE_PUT_BYTES) {
    throw new Error(
      `${step.source} is ${actual} bytes, past the ${MAX_SINGLE_PUT_BYTES} this uploader puts in one request: it needs a multipart upload`,
    )
  }
}

/**
 * Runs a plan. Every step of one stage is uploaded and read back publicly
 * before the next stage starts, and a failure anywhere throws, which is what
 * keeps latest.json from being written over a half published release.
 */
export async function runMirror(options: {
  steps: MirrorStep[]
  credentials: DownloadsCredentials
  io: MirrorIo
  dryRun?: boolean
  /** Makes the cache busting query string of a rolling read unique per run. */
  nonce?: string
}): Promise<{ uploaded: string[] }> {
  const { io, credentials } = options
  const secrets = secretsOf(credentials)
  const nonce = options.nonce ?? `${Date.now()}`
  const uploaded: string[] = []
  const stages: MirrorStage[] = ["versioned", "alias", "manifest"]
  try {
    for (const stage of stages) {
      const steps = options.steps.filter((step) => step.stage === stage)
      for (const step of steps) {
        if (options.dryRun) {
          io.log(`would upload ${step.key} (${step.contentType}, ${step.cacheControl})`)
          continue
        }
        preflight(step, io)
        await withRetry(`upload ${step.key}`, io, () =>
          io.upload({
            key: step.key,
            source: step.source,
            size: step.size,
            contentType: step.contentType,
            cacheControl: step.cacheControl,
          }),
        )
        uploaded.push(step.key)
        io.log(`uploaded ${step.key}`)
      }
      if (options.dryRun) continue
      for (const step of steps) {
        await withRetry(`read back ${step.key}`, io, (attempt) =>
          verifyPublic(step, io, nonce, attempt),
        )
      }
    }
  } catch (error) {
    // Nothing thrown from the transport leaves this function unredacted: the
    // S3 client and the edge both name the account and the key in error text.
    throw new Error(redact(error instanceof Error ? error.message : String(error), secrets))
  }
  return { uploaded }
}

/** The credentials, by name, out of the environment. Missing ones are a
 *  refusal that names them: a mirror that quietly did nothing would leave a
 *  release that exists only where nobody can reach it. */
export function credentialsFromEnv(
  env: Record<string, string | undefined> = process.env,
): DownloadsCredentials {
  const accountId = env[ACCOUNT_ENV] ?? ""
  const accessKeyId = env[ACCESS_KEY_ID_ENV] ?? ""
  const secretAccessKey = env[SECRET_ACCESS_KEY_ENV] ?? ""
  const missing = [
    accountId ? "" : ACCOUNT_ENV,
    accessKeyId ? "" : ACCESS_KEY_ID_ENV,
    secretAccessKey ? "" : SECRET_ACCESS_KEY_ENV,
  ].filter((name) => name.length > 0)
  if (missing.length > 0) {
    throw new Error(`${missing.join(", ")} is not set, so nothing can be published to ${BUCKET}`)
  }
  return { accountId, accessKeyId, secretAccessKey }
}

/** Every file in the download that belongs on the public host, flattened:
 *  the download lays artifacts out one directory per build job, and the
 *  downloads host is flat per version. */
export function collectArtifacts(root: string): MirrorFile[] {
  const found: MirrorFile[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const entry = path.join(dir, name)
      if (statSync(entry).isDirectory()) {
        walk(entry)
        continue
      }
      if (NOT_MIRRORED.has(name)) continue
      found.push({ name, path: entry, size: statSync(entry).size })
    }
  }
  walk(root)
  return found
}

function argument(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const requestFile = argument(argv, "--request")
  const manifestFile = argument(argv, "--manifest")
  const artifacts = argument(argv, "--artifacts")
  const dryRun = argv.includes("--dry-run")
  let keep = DEFAULT_KEEP
  try {
    keep = parseKeep(argv)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(2)
  }
  if (!requestFile || !manifestFile || !artifacts) {
    console.error(
      "usage: mirror-to-downloads.ts --request <request.json> --manifest <latest.json> --artifacts <dir> [--dry-run] [--keep <n>]",
    )
    process.exit(2)
  }
  try {
    // The gate again, over the same request, uploading nothing. A release
    // reaches customers through this host and through no other, so the bytes
    // it puts there are bytes both signatures held over minutes ago.
    const request = JSON.parse(readFileSync(requestFile, "utf8")) as PublishRequest
    // Same team as the verify step: the gate refuses a macOS app without it.
    const verified = publishManifest(request, {
      dryRun: true,
      appleTeamId: process.env.APPLE_TEAM_ID,
    })
    if (!verified.published) {
      throw new Error(
        `the two signature gate does not pass over ${requestFile}: ${verified.reason}${
          verified.detail ? ` (${verified.detail})` : ""
        }`,
      )
    }
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as ManifestShape
    const steps = planMirror({
      manifest,
      verified: verified.manifest,
      files: collectArtifacts(artifacts),
      manifestFile: {
        name: "latest.json",
        path: manifestFile,
        size: statSync(manifestFile).size,
      },
    })
    // A dry run touches no secret at all: it does not read one, so it cannot
    // leak one, and it is runnable by anybody rehearsing a release.
    const credentials = dryRun
      ? { accountId: "", accessKeyId: "", secretAccessKey: "" }
      : credentialsFromEnv()
    const io = dryRun
      ? {
          upload: async () => {},
          fetch: (() => {
            throw new Error("a dry run reads nothing")
          }) as unknown as FetchLike,
          fileSize: (file: string) => statSync(file).size,
          log: (message: string) => console.log(message),
          sleep: async () => {},
        }
      : realMirrorIo(credentials)
    const result = await runMirror({ steps, credentials, io, dryRun })
    console.log(
      dryRun
        ? `dry run, ${steps.length} objects planned, nothing uploaded`
        : `published ${result.uploaded.length} objects, ${downloadUrl(steps[steps.length - 1]?.key ?? "")} last`,
    )
    // The prune runs only here, after runMirror returned: latest.json is up
    // and was read back from the public host. It never fails the run.
    let pruneCredentials: DownloadsCredentials | undefined = dryRun ? undefined : credentials
    if (dryRun) {
      try {
        pruneCredentials = credentialsFromEnv()
      } catch {
        console.log("prune: dry run without bucket credentials, the prune plan is skipped")
      }
    }
    if (pruneCredentials) {
      const secrets = secretsOf(pruneCredentials)
      let warnings: string[]
      try {
        const pruned = await runPrune({
          published: manifest.version,
          keep,
          dryRun,
          io: realPruneIo(pruneCredentials, (message) => console.log(redact(message, secrets))),
        })
        warnings = pruned.warnings
      } catch (error) {
        warnings = [`prune: skipped, ${error instanceof Error ? error.message : String(error)}`]
      }
      for (const warning of warnings) {
        console.log(`::warning title=Desktop prune::${redact(warning, secrets)}`)
      }
    }
  } catch (error) {
    console.error(`refusing to mirror: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}

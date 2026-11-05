// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Transform sources for the import runner: a saved (or, from the CLI, a
 * shipped reference) transform run over uploaded files or an API connection.
 *
 * The runner reads its source once per kind level (parents before children),
 * so a transform is STAGED first: it runs once, its validated records are
 * spooled as `{"kind","record"}` lines to a local temp file, and the runner
 * then reads that spool like any NDJSON source. Staging does, between the
 * sandboxed calls and outside their deadline:
 *
 *   - uploads: each file (or each entry of an uploaded zip, in the order and
 *     with the parse options of the run's file rules) streamed through its
 *     parser into batches of `transform(batch, ctx)`;
 *   - API sources: `pull({cursor, state}, ctx)` page by page over the
 *     connection's bound GET (429 backoff in the executor);
 *   - files the transform names: a zip entry it declared (`declareFile`) is
 *     extracted into the run's storage prefix, a download it asked for
 *     (`downloadToFile`) is streamed there with the per-file limits (2 GB,
 *     10 minutes, the org's storage quota); a file that cannot be had is
 *     dropped from its record and reported as missing;
 *   - records: every `fileId` the kind declares as a file field that holds a
 *     ref the call returned is rewritten to the staged file's id, which the
 *     run's handlers resolve (`resolveStagedFile`) before any uploaded file.
 *
 * Staged objects are copies the handlers read; they are deleted with the
 * spool when the run ends. A preview (dry run) parses and calls the transform
 * on its first batches or pages only, and downloads and extracts nothing.
 */
import { createHash, randomUUID } from "node:crypto"
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { z } from "zod"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { putObjectStream, StreamTooLargeError } from "~/infra/storage/multipart"
import { deleteObjects } from "~/infra/storage/object-storage"
import {
  buildStorageKey,
  currentOrgUsageBytes,
  loadOrgSettings,
  orgQuotaBytes,
} from "~/modules/files/service"
import { kindRecordError } from "~/modules/imports/kind-schema"
import type { ImportKindInfo } from "~/modules/imports/kinds"
import type { ByteSource } from "~/modules/imports/parsers/common"
import { parseCsv } from "~/modules/imports/parsers/csv"
import { parseJson } from "~/modules/imports/parsers/json"
import { parseJsonl } from "~/modules/imports/parsers/jsonl"
import { parseXlsx } from "~/modules/imports/parsers/xlsx"
import { parseXml } from "~/modules/imports/parsers/xml"
import {
  DEFAULT_ZIP_CAPS,
  fileRangeSource,
  objectRangeSource,
  type RangeSource,
  readZipDirectory,
  readZipEntry,
  ZipBudget,
  type ZipEntry,
} from "~/modules/imports/parsers/zip"
import { resolveImportFile } from "~/modules/imports/source"
import { noteStagedBytes, orgStagedBytes } from "~/modules/imports/staging"
import {
  batchRecords,
  type ParsedRecord,
  RecordTooLargeError,
  type TransformBatch,
} from "~/modules/imports/transforms/batch"
import {
  type ApiGetAnswer,
  type DeferredDownload,
  type EmittedBatch,
  type RecordIssue,
  TRANSFORM_RECORD_MAX_BYTES,
} from "~/modules/imports/transforms/bridge"
import {
  runApiPull,
  runUploadTransform,
  type TransformSink,
  type UploadFileInfo,
} from "~/modules/imports/transforms/execute"
import {
  getTransform,
  listTransforms,
  resolvePinnedTransform,
  type SaveTransformInput,
  saveTransform,
  type TransformRef,
  TransformStoreError,
} from "~/modules/imports/transforms/store"
import { ImportError } from "~/modules/imports/types"

export type FileFormat = UploadFileInfo["kind"]

/** Which files of an upload a run reads, in what order, parsed how. */
export interface FileRule {
  /** A glob on the file name or zip entry path: `*` within a folder, `**` across folders. */
  match: string
  /** The parser; default from the extension. `skip` reads nothing (a file only declared). */
  as?: FileFormat | "skip"
  /** CSV: the field delimiter (detected when absent). */
  delimiter?: string
  /** XML: every outermost element of this name is a record. */
  recordElement?: string
  /** XML: elements at this depth are records (default 2, the root's children). */
  recordDepth?: number
}

export type TransformInput =
  | { type: "files"; fileIds: string[] }
  /** CLI runs only: files on the operator's disk. */
  | { type: "paths"; paths: string[] }
  | { type: "api"; connection: string }

export interface TransformSource {
  type: "transform"
  /** A saved version (every API run), or code given inline (a CLI run of a shipped reference). */
  transform: { id: string; version: number; sha256?: string } | { inline: string; name: string }
  input: TransformInput
  files?: FileRule[]
  /** A preview: stop after this many transform calls. */
  limit?: { batches?: number; pages?: number }
}

/** The bound side of an API connection a run pulls through (a test seam). */
export interface ApiConnectionClient {
  get(path: string, signal?: AbortSignal): Promise<ApiGetAnswer>
  download(
    path: string,
    signal: AbortSignal,
  ): Promise<{
    status: number
    body: ReadableStream<Uint8Array> | null
    contentType: string | null
    contentLength: number | null
    filename: string | null
    retryAfterMs: number | null
  }>
}

export interface TransformStageHooks {
  apiConnection?: (identifier: string) => ApiConnectionClient
  /** Per-file download cap (default 2 GB). */
  downloadMaxBytes?: number
  /** Per-file download time limit (default 10 minutes). */
  downloadTimeoutMs?: number
  /** Bytes the org may still store (default: its quota less its usage); null = unlimited. */
  storageQuotaBytesLeft?: () => Promise<number | null>
  afterTransformCall?: (call: number, runId: string) => Promise<void>
}

/** A staged file a handler reads through `ctx.resolveFile(id)`. */
export interface StagedFile {
  storageKey: string
  filename: string
  sizeBytes: number
  mimeType: string
}

export const DOWNLOAD_MAX_BYTES = 2 * 1024 * 1024 * 1024
export const DOWNLOAD_TIMEOUT_MS = 10 * 60_000
const MAX_MISSING_LISTED = 50
const MAX_DOWNLOAD_RETRIES = 3
const SPOOL_DIR = "liaison-import-spool"
const SPOOL_STALE_MS = 24 * 3600_000
const REF_RE = /^(?:file|download):\d+$/
/** Stands in for a ref while a record is validated (a ref is not a uuid yet). */
const REF_STANDIN = "00000000-0000-4000-8000-000000000000"

export const TRANSFORM_FORMATS: Record<string, FileFormat> = {
  csv: "csv",
  tsv: "csv",
  json: "json",
  jsonl: "jsonl",
  ndjson: "jsonl",
  xml: "xml",
  xlsx: "xlsx",
  txt: "text",
  md: "text",
  html: "text",
  htm: "text",
}

/** The code a run executes, resolved before the run row exists. */
export interface PreparedTransform {
  code: string
  name: string
  version: number | null
  sha256: string
  sourceType: "upload" | "api"
  kinds: string[]
  connection: string | null
}

const fileRuleSchema = z
  .object({
    match: z.string().min(1).max(256),
    as: z.enum(["csv", "json", "jsonl", "xml", "xlsx", "text", "skip"]).optional(),
    delimiter: z.string().min(1).max(4).optional(),
    recordElement: z.string().min(1).max(128).optional(),
    recordDepth: z.number().int().min(1).max(64).optional(),
  })
  .strict()

export const fileRulesSchema = z.array(fileRuleSchema).max(50)

export const transformInputSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("files"), fileIds: z.array(z.string().uuid()).min(1).max(20) })
    .strict(),
  z
    .object({ type: z.literal("api"), connection: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/) })
    .strict(),
])

const runSourceSchema = z.object({
  transform: z.object({
    id: z.string().uuid(),
    version: z.number().int().positive(),
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  }),
  input: transformInputSchema,
  files: fileRulesSchema.optional(),
})

/**
 * The transform source a queued run's row records, or null when the row names
 * none. Only a saved version and an upload or API input are accepted: a
 * server path or inline code never comes from a row.
 */
export function transformSourceOfRun(source: Record<string, unknown>): TransformSource | null {
  if (!("transform" in source)) return null
  const parsed = runSourceSchema.safeParse(source)
  if (!parsed.success) {
    throw new ImportError("invalid_source", "the run's transform source is malformed")
  }
  const { transform, input, files } = parsed.data
  return {
    type: "transform",
    transform: {
      id: transform.id,
      version: transform.version,
      ...(transform.sha256 ? { sha256: transform.sha256 } : {}),
    },
    input,
    ...(files ? { files } : {}),
  }
}

/** Save a new version of an org's transform (the agent tool and the Imports view). */
export async function saveTransformVersion(input: SaveTransformInput): Promise<TransformRef> {
  return withPrivilegedDb(input.orgId, "imports-transform-save", (tx) => saveTransform(tx, input))
}

/** One saved version of an org's transform (the latest when no version is given). */
export async function loadTransform(orgId: string, name: string, version?: number) {
  return withPrivilegedDb(orgId, "imports-transform-read", (tx) =>
    getTransform(tx, orgId, name, version),
  )
}

/** The latest version of each of an org's transforms (the Imports view). */
export async function listOrgTransforms(orgId: string) {
  return withPrivilegedDb(orgId, "imports-transform-list", (tx) => listTransforms(tx, orgId))
}

/** The exact version a preview or run pinned (id and version must both match). */
export async function loadPinnedTransform(orgId: string, pin: { id: string; version: number }) {
  return withPrivilegedDb(orgId, "imports-transform-pin", (tx) =>
    resolvePinnedTransform(tx, orgId, { transformId: pin.id, version: pin.version }),
  )
}

export function sha256Of(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex")
}

/**
 * Load and check the transform a run names: the pinned version (id and
 * version must both match, and the code its sha256 when given), its kinds
 * covering the run's, its source type matching the input.
 */
export async function prepareTransform(
  orgId: string,
  source: TransformSource,
  runKinds: string[],
): Promise<PreparedTransform> {
  let prepared: PreparedTransform
  if ("inline" in source.transform) {
    prepared = {
      code: source.transform.inline,
      name: source.transform.name,
      version: null,
      sha256: sha256Of(source.transform.inline),
      sourceType: source.input.type === "api" ? "api" : "upload",
      kinds: runKinds,
      connection: source.input.type === "api" ? source.input.connection : null,
    }
  } else {
    const pin = source.transform
    let row: Awaited<ReturnType<typeof resolvePinnedTransform>>
    try {
      row = await withPrivilegedDb(orgId, "imports-transform-pin", (tx) =>
        resolvePinnedTransform(tx, orgId, { transformId: pin.id, version: pin.version }),
      )
    } catch (err) {
      if (err instanceof TransformStoreError) {
        throw new ImportError(
          err.code === "transform_not_found" ? "not_found" : "invalid_request",
          err.message,
        )
      }
      throw err
    }
    prepared = {
      code: row.source,
      name: row.name,
      version: row.version,
      sha256: sha256Of(row.source),
      sourceType: row.sourceType === "api" ? "api" : "upload",
      kinds: row.kinds,
      connection: row.connectionIdentifier ?? null,
    }
    if (pin.sha256 && pin.sha256 !== prepared.sha256) {
      throw new ImportError(
        "invalid_request",
        `The code of "${row.name}" version ${row.version} is not the code the run was approved on.`,
      )
    }
  }
  const outside = runKinds.filter((k) => !prepared.kinds.includes(k))
  if (outside.length > 0) {
    throw new ImportError(
      "invalid_request",
      `The transform "${prepared.name}" does not emit ${outside.join(", ")}.`,
    )
  }
  const wantsApi = source.input.type === "api"
  if (wantsApi !== (prepared.sourceType === "api")) {
    throw new ImportError(
      "invalid_source",
      wantsApi
        ? `"${prepared.name}" is an upload transform; run it on uploaded files.`
        : `"${prepared.name}" pulls from an API connection; run it on its connection.`,
    )
  }
  if (
    wantsApi &&
    source.input.type === "api" &&
    prepared.connection &&
    prepared.connection !== source.input.connection
  ) {
    throw new ImportError(
      "invalid_source",
      `"${prepared.name}" pulls from the connection ${prepared.connection}, not ${source.input.connection}.`,
    )
  }
  return prepared
}

// ---------------------------------------------------------------------------
// File rules
// ---------------------------------------------------------------------------

/** Stars a file rule may hold (after runs collapse). */
export const MAX_GLOB_STARS = 16
const MAX_GLOB_CHARS = 256

type GlobToken =
  | { t: "char"; c: string }
  | { t: "one" }
  | { t: "star" }
  | { t: "any" }
  | { t: "anyDirs" }

function globTokens(glob: string): GlobToken[] {
  if (glob.length === 0 || glob.length > MAX_GLOB_CHARS) {
    throw new ImportError(
      "invalid_request",
      `A file rule's match is 1 to ${MAX_GLOB_CHARS} characters.`,
    )
  }
  const out: GlobToken[] = []
  let stars = 0
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c !== "*") {
      out.push(c === "?" ? { t: "one" } : { t: "char", c: c.toLowerCase() })
      continue
    }
    // A run of stars: one star stays in a folder, two or more cross folders.
    let j = i
    while (glob[j + 1] === "*") j++
    const run = j - i + 1
    i = j
    let tok: GlobToken
    if (run === 1) tok = { t: "star" }
    else if (glob[i + 1] === "/") {
      tok = { t: "anyDirs" }
      i++
    } else tok = { t: "any" }
    const prev = out[out.length - 1]
    // Adjacent star tokens collapse into the widest of them.
    if (prev && prev.t !== "char" && prev.t !== "one") {
      if (tok.t !== "star")
        out[out.length - 1] = tok.t === "any" || prev.t === "any" ? { t: "any" } : tok
      continue
    }
    out.push(tok)
    stars++
  }
  if (stars > MAX_GLOB_STARS) {
    throw new ImportError(
      "invalid_request",
      `A file rule's match has ${stars} wildcards; at most ${MAX_GLOB_STARS}.`,
    )
  }
  return out
}

/**
 * A glob as a matcher that runs as a state-set automaton: time is the name's
 * length times the pattern's, never exponential (no backtracking regex).
 * `*` stays within a folder, `**` crosses folders, `**\/` is zero or more
 * folders, `?` is one character; case-insensitive.
 */
export function globMatcher(glob: string): (name: string) => boolean {
  const tokens = globTokens(glob)
  const n = tokens.length
  const closure = (set: Uint8Array) => {
    for (let i = 0; i < n; i++) {
      const tok = tokens[i]!
      if (set[i] && (tok.t === "star" || tok.t === "any" || tok.t === "anyDirs")) set[i + 1] = 1
    }
  }
  return (name: string) => {
    let cur = new Uint8Array(n + 1)
    cur[0] = 1
    closure(cur)
    for (const raw of name) {
      const ch = raw.toLowerCase()
      const next = new Uint8Array(n + 1)
      let any = false
      for (let i = 0; i < n; i++) {
        if (!cur[i]) continue
        const tok = tokens[i]!
        switch (tok.t) {
          case "char":
            if (tok.c === ch) next[i + 1] = 1
            break
          case "one":
            if (ch !== "/") next[i + 1] = 1
            break
          case "star":
            if (ch !== "/") next[i] = 1
            break
          case "any":
            next[i] = 1
            break
          case "anyDirs":
            next[i] = 1
            if (ch === "/") next[i + 1] = 1
            break
        }
      }
      closure(next)
      for (let i = 0; i <= n; i++) if (next[i]) any = true
      if (!any) return false
      cur = next
    }
    return cur[n] === 1
  }
}

export function formatOf(name: string): FileFormat | null {
  const ext = name.toLowerCase().split(".").pop() ?? ""
  return TRANSFORM_FORMATS[ext] ?? null
}

interface PlannedFile<T> {
  name: string
  format: FileFormat
  rule: FileRule | null
  item: T
}

/**
 * The files a run reads, in order: with rules, the files each rule matches
 * (rule order, then name order), each read once, unmatched files skipped;
 * without rules, every file with a known format, in upload order.
 */
export function planFiles<T>(
  items: Array<{ name: string; item: T }>,
  rules: FileRule[] | undefined,
): Array<PlannedFile<T>> {
  if (!rules || rules.length === 0) {
    return items.flatMap(({ name, item }) => {
      const format = formatOf(name)
      return format ? [{ name, format, rule: null, item }] : []
    })
  }
  const taken = new Set<string>()
  const out: Array<PlannedFile<T>> = []
  for (const rule of rules) {
    const matches = globMatcher(rule.match)
    const hits = items
      .filter(({ name }) => !taken.has(name) && matches(name))
      .sort((a, b) => a.name.localeCompare(b.name))
    for (const { name, item } of hits) {
      taken.add(name)
      if (rule.as === "skip") continue
      const format = rule.as ?? formatOf(name)
      if (!format) {
        throw new ImportError(
          "invalid_source",
          `${name}: no parser for this file type; give the rule an "as" (csv, json, jsonl, xml, xlsx, text) or "skip".`,
        )
      }
      out.push({ name, format, rule, item })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------

export interface StageCallbacks {
  /** A record the transform emitted that its kind refused (`count` > 1 for the overflow). */
  onRejected(kind: string, at: string, message: string, count: number): void
  /** After each call; returns true when the run was asked to cancel. */
  onCall(call: number): Promise<boolean>
}

export interface StagedRun {
  spoolPath: string
  cancelled: boolean
  report: Record<string, unknown>
  /** Where a spool line came from ("batch 3 (tickets.csv)", "page 2"). */
  describeLine(line: number): string
  resolveStagedFile(id: string): StagedFile | null
  /** A file id a handler may resolve in this run: staged by it, or one of its input files. */
  fileAllowed(id: string): boolean
  cleanup(): Promise<void>
}

interface Origin {
  firstLine: number
  label: string
}

interface UploadUnit {
  name: string
  /** A top-level uploaded file (or local path), or an entry of an uploaded zip. */
  open(): Promise<ByteSource>
  range?: () => Promise<RangeSource>
  sizeBytes: number
  mimeType: string
  /** A top-level uploaded file's own storage key (staged without a copy). */
  storageKey?: string
  /** A local path (CLI). */
  path?: string
  zip?: { src: RangeSource; entry: ZipEntry; budget: ZipBudget }
}

function spoolPathFor(runId: string): string {
  const dir = join(tmpdir(), SPOOL_DIR)
  mkdirSync(dir, { recursive: true })
  // A crashed run leaves its spool behind: clear any older than a day.
  try {
    const now = Date.now()
    for (const f of readdirSync(dir)) {
      const p = join(dir, f)
      if (now - statSync(p).mtimeMs > SPOOL_STALE_MS) rmSync(p, { force: true })
    }
  } catch {
    // best effort
  }
  return join(dir, `${runId}.ndjson`)
}

function mimeOf(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? ""
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    pdf: "application/pdf",
    csv: "text/csv",
    txt: "text/plain",
    json: "application/json",
    xml: "application/xml",
    zip: "application/zip",
  }
  return map[ext] ?? "application/octet-stream"
}

/** The chunks of a web stream; an abort of `signal` cancels a read that is waiting. */
async function* webStream(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader()
  const onAbort = () => {
    reader.cancel(signal?.reason).catch(() => undefined)
  }
  signal?.addEventListener("abort", onAbort, { once: true })
  try {
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? new Error("aborted")
      const { value, done } = await reader.read()
      if (signal?.aborted) throw signal.reason ?? new Error("aborted")
      if (done) return
      if (value) yield value
    }
  } finally {
    signal?.removeEventListener("abort", onAbort)
    reader.releaseLock()
  }
}

function parse(
  unit: UploadUnit,
  plan: PlannedFile<UploadUnit>,
): Promise<AsyncIterable<ParsedRecord>> {
  const name = unit.name
  return (async () => {
    switch (plan.format) {
      case "csv":
        return parseCsv(await unit.open(), {
          name,
          ...(plan.rule?.delimiter ? { delimiter: plan.rule.delimiter } : {}),
        })
      case "json":
        return parseJson(await unit.open(), { name })
      case "jsonl":
        return parseJsonl(await unit.open(), { name })
      case "xml":
        return parseXml(await unit.open(), {
          name,
          ...(plan.rule?.recordElement ? { recordElement: plan.rule.recordElement } : {}),
          ...(plan.rule?.recordDepth ? { recordDepth: plan.rule.recordDepth } : {}),
        })
      case "xlsx": {
        if (!unit.range) {
          throw new ImportError(
            "invalid_source",
            `${name}: a workbook inside a zip cannot be read; upload it on its own.`,
          )
        }
        return parseXlsx(await unit.range(), { name })
      }
      case "text":
        return textRecords(await unit.open(), name)
    }
  })()
}

/**
 * A text file as one record `{text}`. Reading stops as soon as the file is
 * past one record's cap, which then fails the run with the record-cap error:
 * never more than a record's worth is held.
 */
export async function* textRecords(source: ByteSource, name: string): AsyncGenerator<ParsedRecord> {
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const c of source) {
    total += c.byteLength
    if (total > TRANSFORM_RECORD_MAX_BYTES) throw new RecordTooLargeError(name, 1, total)
    chunks.push(c)
  }
  yield { number: 1, value: { text: new TextDecoder().decode(Buffer.concat(chunks)) } }
}

/**
 * Walk the record's declared file fields (`messages.attachments`) and hand
 * each attachment object holding a ref in `fileId` to `fn`, which returns the
 * new id, or null to drop the attachment.
 */
function mapFileRefs(
  record: Record<string, unknown>,
  paths: readonly string[],
  fn: (ref: string) => string | null,
): Record<string, unknown> {
  const walk = (value: unknown, segs: string[]): unknown => {
    if (segs.length === 0) {
      const one = (v: unknown): unknown => {
        if (v === null || typeof v !== "object" || Array.isArray(v)) return v
        const id = (v as { fileId?: unknown }).fileId
        if (typeof id !== "string" || !REF_RE.test(id)) return v
        const next = fn(id)
        return next === null ? undefined : { ...(v as Record<string, unknown>), fileId: next }
      }
      if (Array.isArray(value)) return value.map(one).filter((v) => v !== undefined)
      return one(value)
    }
    if (Array.isArray(value)) return value.map((v) => walk(v, segs))
    if (value === null || typeof value !== "object") return value
    const [head, ...rest] = segs
    const obj = value as Record<string, unknown>
    if (!head || !(head in obj)) return value
    const next = walk(obj[head], rest)
    return { ...obj, [head]: next === undefined ? [] : next }
  }
  let out: unknown = record
  for (const p of paths) out = walk(out, p.split("."))
  return out as Record<string, unknown>
}

/** The `fileId`s in a record's declared file fields that are neither a ref nor an input file. */
function foreignFileIds(
  record: Record<string, unknown>,
  paths: readonly string[],
  inputFileIds: ReadonlySet<string>,
): string[] {
  const out: string[] = []
  const walk = (value: unknown, segs: string[]): void => {
    if (Array.isArray(value)) {
      for (const v of value) walk(v, segs)
      return
    }
    if (value === null || typeof value !== "object") return
    const obj = value as Record<string, unknown>
    if (segs.length === 0) {
      const id = obj.fileId
      if (
        id !== undefined &&
        (typeof id !== "string" || (!REF_RE.test(id) && !inputFileIds.has(id)))
      ) {
        out.push(String(id).slice(0, 64))
      }
      return
    }
    const [head, ...rest] = segs
    if (head && head in obj) walk(obj[head], rest)
  }
  for (const p of paths) walk(record, p.split("."))
  return out
}

function hasRefs(record: unknown): boolean {
  if (typeof record === "string") return REF_RE.test(record)
  if (record === null || typeof record !== "object") return false
  if (Array.isArray(record)) return record.some(hasRefs)
  return Object.values(record).some(hasRefs)
}

/** The org's quota less its stored files and every run's staged files (this run's included). */
async function defaultQuotaLeft(orgId: string): Promise<number | null> {
  const left = await withPrivilegedDb(orgId, "imports-transform-quota", async (tx) => {
    const quota = orgQuotaBytes(await loadOrgSettings(tx, orgId))
    if (quota === null) return null
    return quota - (await currentOrgUsageBytes(tx, orgId))
  })
  return left === null ? null : left - (await orgStagedBytes(orgId))
}

/** The bound client of an api-connector connection, as the person running the import. */
async function openApiConnection(
  orgId: string,
  userId: string,
  identifier: string,
): Promise<ApiConnectionClient> {
  const [{ getAdapterRow, resolveConnectionCredentials }, transport] = await Promise.all([
    import("~/apps/api-connector/store"),
    import("~/apps/api-connector/transport"),
  ])
  const row = await getAdapterRow(orgId, identifier)
  if (!row) {
    throw new ImportError(
      "invalid_source",
      `There is no API connection named ${identifier}. Create it with api-connector__connector_adapter_save (for a shipped reference, kernel__import_transform_save with fromReference and params.SITE returns the exact call), then ask for its credentials with kernel__request_secret.`,
    )
  }
  const creds = await resolveConnectionCredentials(orgId, userId, identifier)
  if (!creds) {
    throw new ImportError(
      "invalid_source",
      `The API connection ${identifier} has no saved credentials: ask for them with kernel__request_secret({ kind: "api_connector_credentials", target: { identifier: "${identifier}" } }) first.`,
    )
  }
  const base = {
    orgId,
    identifier,
    adapter: row.adapter,
    credentials: creds?.values ?? null,
    credentialVersion: creds?.version ?? "none",
  }
  return {
    get: (path, signal) => transport.boundGet({ ...base, path, ...(signal ? { signal } : {}) }),
    download: (path, signal) => transport.boundFetchToStream({ ...base, path, signal }),
  }
}

/**
 * What an API source reads through, as an approval binds it: the adapter
 * document (hash and save time) and the credentials' version. A change to
 * either after a preview makes the preview stale.
 */
export async function apiConnectionFacts(
  orgId: string,
  userId: string,
  identifier: string,
): Promise<{ adapter: string | null; adapterSavedAt: string | null; credentials: string | null }> {
  const { getAdapterRow, resolveConnectionCredentials } = await import("~/apps/api-connector/store")
  const row = await getAdapterRow(orgId, identifier)
  const creds = row ? await resolveConnectionCredentials(orgId, userId, identifier) : null
  return {
    adapter: row ? sha256Of(JSON.stringify(row.adapter)) : null,
    adapterSavedAt: row?.updatedAt ?? null,
    credentials: creds?.version ?? null,
  }
}

export interface StageInput {
  orgId: string
  runId: string
  actor: UserContext
  kinds: ImportKindInfo[]
  source: TransformSource
  prepared: PreparedTransform
  mode: "api" | "cli"
  dryRun: boolean
  callbacks: StageCallbacks
  hooks?: TransformStageHooks
}

/** Run the transform once and spool its validated records. */
export async function stageTransformSource(input: StageInput): Promise<StagedRun> {
  const { orgId, runId, source, prepared, dryRun, callbacks } = input
  const hooks = input.hooks ?? {}
  const kindByName = new Map(input.kinds.map((k) => [k.kind, k]))
  const spoolPath = spoolPathFor(runId)
  const writer = Bun.file(spoolPath).writer()
  const origins: Origin[] = []
  const staged = new Map<string, StagedFile>()
  const ownedKeys: string[] = []
  const missing: Array<{ path: string; reason: string }> = []
  let missingCount = 0
  let lines = 0
  let calls = 0
  let stagedBytes = 0
  let cancelled = false
  const report: Record<string, unknown> = { transform: prepared.name }
  if (prepared.version !== null) report.transformVersion = prepared.version
  const abort = new AbortController()

  const cleanup = async () => {
    await writer.end()
    rmSync(spoolPath, { force: true })
    if (ownedKeys.length > 0) await deleteObjects(ownedKeys.splice(0))
    await noteStagedBytes(orgId, runId, null)
  }

  // Ref ids → staged ids (or null: the file could not be had). `file:` refs
  // live for the run; `download:` refs are numbered per call.
  const fileRefs = new Map<string, string | null>()
  const inputFileIds = new Set(source.input.type === "files" ? source.input.fileIds : [])
  let callRefs = new Map<string, string | null>()

  const noteMissing = (path: string, reason: string) => {
    missingCount++
    if (missing.length < MAX_MISSING_LISTED) missing.push({ path, reason })
  }

  const quotaLeft = async (): Promise<number | null> => {
    if (!hooks.storageQuotaBytesLeft) return defaultQuotaLeft(orgId)
    const left = await hooks.storageQuotaBytesLeft()
    return left === null ? null : left - stagedBytes
  }

  const stageStream = async (
    name: string,
    body: AsyncIterable<Uint8Array>,
    mimeType: string,
    maxBytes: number,
    signal: AbortSignal = abort.signal,
  ): Promise<string> => {
    const id = randomUUID()
    const storageKey = buildStorageKey({
      orgId,
      app: "kernel",
      entityType: "import_run",
      entityId: runId,
      filename: name,
      objectId: id,
    })
    ownedKeys.push(storageKey)
    const size = await putObjectStream({
      key: storageKey,
      contentType: mimeType,
      body,
      maxBytes,
      signal,
    })
    stagedBytes += size
    await noteStagedBytes(orgId, runId, stagedBytes)
    staged.set(id, { storageKey, filename: name, sizeBytes: size, mimeType })
    return id
  }

  const validate = (kind: string, record: unknown): string | null => {
    const k = kindByName.get(kind)
    if (!k) return `kind ${kind} is not part of this run`
    const paths = k.decl.files ?? []
    const checked =
      paths.length > 0 && record && typeof record === "object" && !Array.isArray(record)
        ? mapFileRefs(record as Record<string, unknown>, paths, () => REF_STANDIN)
        : record
    return kindRecordError(k.decl, checked)
  }

  const spool = async (emitted: EmittedBatch[], label: string) => {
    origins.push({ firstLine: lines + 1, label })
    for (const batch of emitted) {
      const k = kindByName.get(batch.kind)
      const paths = k?.decl.files ?? []
      for (const [index, raw] of batch.records.entries()) {
        let record = raw as Record<string, unknown>
        // A transform names only its own files: a ref it was handed, or a
        // file of the run's input. Any other id (one the person happens to
        // be able to read) refuses the record.
        const foreign = paths.length > 0 ? foreignFileIds(record, paths, inputFileIds) : []
        if (foreign.length > 0) {
          callbacks.onRejected(
            batch.kind,
            `${label}, record ${index + 1} of an emitRecords call`,
            `fileId ${foreign[0]} is not a file of this import: name a file with ctx.declareFile or ctx.downloadToFile, or one of the run's uploaded files`,
            1,
          )
          continue
        }
        if (paths.length > 0 && hasRefs(record)) {
          record = mapFileRefs(record, paths, (ref) => {
            const hit = ref.startsWith("file:") ? fileRefs.get(ref) : callRefs.get(ref)
            return hit === undefined ? ref : hit
          })
        }
        writer.write(`${JSON.stringify({ kind: batch.kind, record })}\n`)
        lines++
      }
    }
    await writer.flush()
  }

  const rejected = (
    issues: Array<RecordIssue & { kind: string }>,
    label: string,
    total: number,
  ) => {
    for (const issue of issues) {
      callbacks.onRejected(
        issue.kind,
        `${label}, record ${issue.index + 1} of an emitRecords call`,
        issue.message,
        1,
      )
    }
    if (total > issues.length) {
      callbacks.onRejected(
        issues[0]?.kind ?? "",
        label,
        `and ${total - issues.length} more records refused`,
        total - issues.length,
      )
    }
  }

  const afterCall = async () => {
    calls++
    report.transformCalls = calls
    await hooks.afterTransformCall?.(calls, runId)
    if (await callbacks.onCall(calls)) {
      cancelled = true
      abort.abort(new Error("The import was cancelled."))
    }
  }

  try {
    if (source.input.type === "api") {
      const conn = source.input.connection
      const client = hooks.apiConnection
        ? hooks.apiConnection(conn)
        : await openApiConnection(orgId, input.actor.userId, conn)
      const maxFile = hooks.downloadMaxBytes ?? DOWNLOAD_MAX_BYTES
      const timeLimit = hooks.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS
      const timedOut = `the download took longer than its time limit (${Math.round(timeLimit / 1000)} s)`
      const download = async (d: DeferredDownload): Promise<string | null> => {
        if (dryRun) return randomUUID()
        for (let attempt = 0; ; attempt++) {
          const left = await quotaLeft()
          if (left !== null && left <= 0) {
            noteMissing(d.path, "the org's storage quota is used up")
            return null
          }
          const timer = AbortSignal.timeout(timeLimit)
          const signal = AbortSignal.any([timer, abort.signal])
          let res: Awaited<ReturnType<ApiConnectionClient["download"]>>
          try {
            res = await client.download(d.path, signal)
          } catch (err) {
            noteMissing(
              d.path,
              timer.aborted ? timedOut : err instanceof Error ? err.message : String(err),
            )
            return null
          }
          if (res.status === 429 && attempt < MAX_DOWNLOAD_RETRIES) {
            await Bun.sleep(Math.min(120_000, Math.max(1000, res.retryAfterMs ?? 1000)))
            continue
          }
          if (res.status < 200 || res.status >= 300 || !res.body) {
            noteMissing(d.path, `the API answered HTTP ${res.status}`)
            return null
          }
          if (res.contentLength !== null && res.contentLength > maxFile) {
            await res.body.cancel().catch(() => undefined)
            noteMissing(
              d.path,
              `the file is ${res.contentLength} bytes; the limit is ${maxFile} bytes`,
            )
            return null
          }
          if (left !== null && res.contentLength !== null && res.contentLength > left) {
            await res.body.cancel().catch(() => undefined)
            noteMissing(d.path, "it would take the org past its storage quota")
            return null
          }
          const cap = left === null ? maxFile : Math.min(maxFile, left)
          const name =
            d.filename ?? res.filename ?? (basename(d.path.split("?")[0] ?? "") || "download")
          try {
            return await stageStream(
              name,
              webStream(res.body, signal),
              res.contentType ?? mimeOf(name),
              cap,
              signal,
            )
          } catch (err) {
            if (abort.signal.aborted) throw err
            if (timer.aborted) {
              noteMissing(d.path, timedOut)
              return null
            }
            if (err instanceof StreamTooLargeError) {
              noteMissing(
                d.path,
                cap < maxFile
                  ? "it would take the org past its storage quota"
                  : `the file is more than ${maxFile} bytes; the limit is ${maxFile} bytes`,
              )
              return null
            }
            noteMissing(d.path, err instanceof Error ? err.message : String(err))
            return null
          }
        }
      }
      let page = 0
      const sink: TransformSink = {
        async onDownloads(downloads) {
          for (const d of downloads) callRefs.set(d.refId, await download(d))
          report.downloads = (Number(report.downloads) || 0) + downloads.length
        },
        async onEmitted(emitted, step) {
          await spool(emitted, `page ${step}`)
        },
        async onRejected(issues, step, total) {
          rejected(issues, `page ${step}`, total)
        },
      }
      const result = await runApiPull({
        source: prepared.code,
        host: {
          kinds: input.kinds.map((k) => k.kind),
          validateRecord: validate,
          apiGet: (path) => client.get(path, abort.signal),
        },
        sink,
        ...(source.limit?.pages ? { maxPages: source.limit.pages } : {}),
        signal: abort.signal,
        onPage: async (n: number) => {
          page = n
          callRefs = new Map()
          await afterCall()
        },
      }).catch((err: unknown) => {
        if (cancelled) return null
        throw err
      })
      if (result) {
        report.pages = result.pages
        report.throttleWaits = result.throttleWaitsMs.length
        if (result.stoppedOn === "max_pages") report.cutAtLimit = true
        if (result.stoppedOn === "repeated_cursor") report.stoppedOnRepeatedCursor = true
      } else {
        report.pages = page
      }
    } else {
      const units = await uploadUnits(input, source.input)
      const planned = planFiles(
        units.map((u) => ({ name: u.name, item: u })),
        source.files,
      )
      report.filesRead = planned.map((p) => p.name)
      const byName = new Map(units.map((u) => [u.name.replace(/^\.?\//, ""), u]))
      const pendingDeclared = new Map<string, string>()
      let nextRef = 0
      const flushDeclared = async () => {
        for (const [ref, path] of pendingDeclared) {
          pendingDeclared.delete(ref)
          if (dryRun) {
            fileRefs.set(ref, randomUUID())
            continue
          }
          const unit = byName.get(path)
          if (!unit) {
            noteMissing(path, "no such file in the upload")
            fileRefs.set(ref, null)
            continue
          }
          if (unit.storageKey) {
            // A whole uploaded file: read in place, never copied.
            const id = randomUUID()
            staged.set(id, {
              storageKey: unit.storageKey,
              filename: basename(unit.name),
              sizeBytes: unit.sizeBytes,
              mimeType: unit.mimeType,
            })
            fileRefs.set(ref, id)
            continue
          }
          // An extracted entry is stored bytes: held to the org's quota.
          const left = await quotaLeft()
          if (left !== null && unit.sizeBytes > left) {
            noteMissing(path, "it would take the org past its storage quota")
            fileRefs.set(ref, null)
            continue
          }
          try {
            fileRefs.set(
              ref,
              await stageStream(
                basename(unit.name),
                await unit.open(),
                mimeOf(unit.name),
                left === null ? DOWNLOAD_MAX_BYTES : Math.min(DOWNLOAD_MAX_BYTES, left),
              ),
            )
          } catch (err) {
            noteMissing(path, err instanceof Error ? err.message : String(err))
            fileRefs.set(ref, null)
          }
        }
      }
      const declaredByPath = new Map<string, string>()
      const resolveFile = async (raw: string): Promise<string> => {
        const path = raw.replace(/^\.?\//, "")
        const known = declaredByPath.get(path)
        if (known) return known
        if (!byName.has(path)) {
          throw new ImportError(
            "invalid_source",
            `declareFile: ${raw} is not in the upload (names are zip entry paths or uploaded file names).`,
          )
        }
        nextRef++
        const ref = `file:${nextRef}`
        declaredByPath.set(path, ref)
        pendingDeclared.set(ref, path)
        return ref
      }
      const files = planned.map((p) => ({ name: p.name, kind: p.format }))
      let label = ""
      async function* batches(): AsyncGenerator<TransformBatch> {
        let n = 0
        for (const plan of planned) {
          for await (const b of batchRecords(plan.name, await parse(plan.item, plan))) {
            n++
            if (source.limit?.batches && n > source.limit.batches) {
              report.cutAtLimit = true
              return
            }
            label = `batch ${n} (${plan.name})`
            yield b
          }
        }
      }
      const result = await runUploadTransform({
        source: prepared.code,
        files,
        batches: batches(),
        host: {
          kinds: input.kinds.map((k) => k.kind),
          validateRecord: validate,
          resolveFile,
        },
        sink: {
          async onEmitted(emitted) {
            await flushDeclared()
            await spool(emitted, label)
          },
          async onRejected(issues, _step, total) {
            rejected(issues, label, total)
          },
        },
        signal: abort.signal,
        onBatch: async () => {
          await afterCall()
        },
      }).catch((err: unknown) => {
        if (cancelled) return null
        throw err
      })
      if (result) report.batches = result.batches
    }
  } catch (err) {
    await cleanup().catch(() => undefined)
    throw err
  }
  await writer.flush()
  if (missingCount > 0) {
    report.attachmentsMissing = missingCount
    report.missingFiles = missing
  }
  if (dryRun) report.previewRecords = lines
  return {
    spoolPath,
    cancelled,
    report,
    describeLine(line) {
      let lo = 0
      let hi = origins.length - 1
      let hit: Origin | undefined
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        const o = origins[mid]!
        if (o.firstLine <= line) {
          hit = o
          lo = mid + 1
        } else hi = mid - 1
      }
      return hit ? `${hit.label}, record ${line - hit.firstLine + 1} emitted` : `record ${line}`
    },
    resolveStagedFile: (id) => staged.get(id) ?? null,
    fileAllowed: (id) => staged.has(id) || inputFileIds.has(id),
    cleanup,
  }
}

/** The files of an upload input: each uploaded file, and each entry of an uploaded zip. */
async function uploadUnits(
  input: { actor: UserContext; mode: "api" | "cli" },
  src: TransformInput,
): Promise<UploadUnit[]> {
  const units: UploadUnit[] = []
  const tops: Array<{
    name: string
    sizeBytes: number
    mimeType: string
    storageKey?: string
    path?: string
  }> = []
  if (src.type === "files") {
    for (const fileId of src.fileIds) {
      const f = await resolveImportFile(input.actor, fileId)
      tops.push({
        name: f.filename,
        sizeBytes: f.sizeBytes,
        mimeType: mimeOf(f.filename),
        storageKey: f.storageKey,
      })
    }
  } else if (src.type === "paths") {
    if (input.mode !== "cli") {
      throw new ImportError("invalid_source", "API runs read uploaded files only")
    }
    for (const p of src.paths) {
      tops.push({ name: basename(p), sizeBytes: Bun.file(p).size, mimeType: mimeOf(p), path: p })
    }
  }
  for (const top of tops) {
    const range = async (): Promise<RangeSource> =>
      top.storageKey ? objectRangeSource(top.storageKey) : fileRangeSource(top.path!, top.sizeBytes)
    const open = async (): Promise<ByteSource> => {
      if (top.storageKey) {
        const { getObjectStream } = await import("~/infra/storage/object-storage")
        return webStream((await getObjectStream(top.storageKey)).stream)
      }
      return webStream(Bun.file(top.path!).stream())
    }
    if (top.name.toLowerCase().endsWith(".zip")) {
      const zsrc = await range()
      const budget = new ZipBudget(zsrc.size, DEFAULT_ZIP_CAPS)
      for (const entry of await readZipDirectory(zsrc, DEFAULT_ZIP_CAPS)) {
        if (entry.isDirectory) continue
        units.push({
          name: entry.name,
          sizeBytes: entry.uncompressedSize,
          mimeType: mimeOf(entry.name),
          zip: { src: zsrc, entry, budget },
          open: async () => readZipEntry(zsrc, entry, budget, DEFAULT_ZIP_CAPS),
        })
      }
      continue
    }
    units.push({
      name: top.name,
      sizeBytes: top.sizeBytes,
      mimeType: top.mimeType,
      ...(top.storageKey ? { storageKey: top.storageKey } : {}),
      ...(top.path ? { path: top.path } : {}),
      open,
      range,
    })
  }
  return units
}

/** Records a sample shows per file, and files it reads. */
export const SAMPLE_RECORDS_PER_FILE = 3
const SAMPLE_MAX_FILES = 20
const SAMPLE_MAX_PATHS = 20

/**
 * The first records of each file of an upload, as a transform's batches will
 * carry them (the same parsers, file rules and zip reading), for a person or
 * the agent to see the source's shape before writing a transform. Files no
 * parser reads are named. Reads under the actor's RLS, like a run.
 */
export async function sampleUpload(input: {
  actor: UserContext
  fileIds: string[]
  files?: FileRule[]
  perFile?: number
}): Promise<{
  files: Array<{
    name: string
    format: FileFormat
    records: Array<{ path?: string; value: unknown }>
    totals?: Record<string, number>
  }>
  unread: string[]
}> {
  const units = await uploadUnits(
    { actor: input.actor, mode: "api" },
    { type: "files", fileIds: input.fileIds },
  )
  const planned = planFiles(
    units.map((u) => ({ name: u.name, item: u })),
    input.files,
  )
  const read = new Set(planned.map((p) => p.name))
  const perFile = Math.max(1, Math.min(input.perFile ?? SAMPLE_RECORDS_PER_FILE, 10))
  const files: Array<{
    name: string
    format: FileFormat
    records: Array<{ path?: string; value: unknown }>
    totals?: Record<string, number>
  }> = []
  for (const plan of planned.slice(0, SAMPLE_MAX_FILES)) {
    // A few records of each part of the file: a JSON object's arrays (and
    // its other members, path `$`) or a workbook's sheets each get their own.
    // A file without parts (CSV, JSONL, XML) stops at its first records.
    const records: Array<{ path?: string; value: unknown }> = []
    const perPath = new Map<string, number>()
    const totals = new Map<string, number>()
    let complete = true
    for await (const r of await parse(plan.item, plan)) {
      const key = r.path ?? ""
      totals.set(key, (totals.get(key) ?? 0) + 1)
      const seen = perPath.get(key) ?? 0
      if (seen < perFile && (seen > 0 || perPath.size < SAMPLE_MAX_PATHS)) {
        records.push({ ...(r.path !== undefined ? { path: r.path } : {}), value: r.value })
        perPath.set(key, seen + 1)
      }
      if (r.path === undefined && seen + 1 >= perFile) {
        complete = false
        break
      }
    }
    files.push({
      name: plan.name,
      format: plan.format,
      records,
      // Read to its end (a whole JSON file, a short CSV): how many records each part holds.
      ...(complete ? { totals: Object.fromEntries(totals) } : {}),
    })
  }
  return {
    files,
    unread: units
      .map((u) => u.name)
      .filter((n) => !read.has(n))
      .slice(0, 50),
  }
}

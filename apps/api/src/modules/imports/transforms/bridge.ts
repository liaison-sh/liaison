// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The transform bridge: the four host methods a transform's `ctx` has, and
 * nothing else. It is built by hand for one call, never from the app RPC
 * bridge factories, so a transform cannot reach a database, an app method or
 * the network, and an app bundle cannot reach these (the method sets are
 * disjoint, `transform-bridge-guard.test.ts`).
 *
 *   ctx.emitRecords(kind, records)   validate records of a declared kind; they
 *                                    reach the runner only when the call ends
 *                                    without error (a failed call emits nothing)
 *   ctx.declareFile(path | {path})   name a file inside the current upload (a
 *                                    zip entry); returns a file ref id
 *   ctx.downloadToFile(path, opts)   API sources: record a download from the
 *                                    connection's base URL; the host performs
 *                                    it after the call, outside its deadline,
 *                                    and the ref id it returns now names it
 *   ctx.apiGet(path)                 API sources: a bound GET on the
 *                                    connection, answered as
 *                                    {status, data, retryAfterMs}; a 429 is an
 *                                    answer, not a throw
 *
 * Arguments arrive JSON-encoded when the transform passes objects (the
 * sandbox shim's rule), so every method accepts either form.
 */

import { sanitizeFilename } from "~/infra/storage/object-storage"

/** The method names, in the order the sandbox shim lists them. */
export const TRANSFORM_BRIDGE_METHODS = [
  "emitRecords",
  "declareFile",
  "downloadToFile",
  "apiGet",
] as const

export type TransformBridgeMethod = (typeof TRANSFORM_BRIDGE_METHODS)[number]

/** One record is at most 1 MB serialized (A43). */
export const TRANSFORM_RECORD_MAX_BYTES = 1024 * 1024
/** What one call may emit before the host refuses more (host memory bound). */
export const TRANSFORM_CALL_MAX_RECORDS = 10_000
export const TRANSFORM_CALL_MAX_EMIT_BYTES = 32 * 1024 * 1024
/** Rejected records' issues one call keeps (the rest are counted). */
export const TRANSFORM_MAX_KEPT_ISSUES = 1000
/** Issues an emitRecords answer lists (the transform also gets the count). */
const ANSWER_MAX_ISSUES = 100
/** Downloads one call may record. */
export const TRANSFORM_CALL_MAX_DOWNLOADS = 500
/** API GETs one call may make. */
export const TRANSFORM_CALL_MAX_API_GETS = 50

/**
 * A refused bridge call. It carries an HTTP class and code so the sandbox
 * rejects with an Error (a `message` the transform can read and catch), not a
 * bare string.
 */
export class TransformBridgeError extends Error {
  readonly status = 422
  readonly code = "invalid_transform_call"
  constructor(message: string) {
    super(message)
    this.name = "TransformBridgeError"
  }
}

export interface RecordIssue {
  /** Position of the record in the emitRecords call (0-based). */
  index: number
  message: string
}

export interface ApiGetAnswer {
  status: number
  data: unknown
  /** Set on a 429 (from Retry-After), in milliseconds. */
  retryAfterMs: number | null
}

export interface DeferredDownload {
  /** The ref id handed to the transform. */
  refId: string
  path: string
  filename: string | null
}

export interface EmittedBatch {
  kind: string
  records: unknown[]
}

/** What the host supplies for one call; the bridge closes over it. */
export interface TransformBridgeHost {
  sourceType: "upload" | "api"
  /** Kinds this transform may emit. */
  kinds: readonly string[]
  /** Validate one record of a kind; return null when valid or the reason it is not. */
  validateRecord?: (kind: string, record: unknown) => string | null
  /** Upload sources: resolve a path inside the upload to a ref id, or throw. */
  resolveFile?: (path: string) => Promise<string>
  /** API sources: the bound GET on the run's connection. */
  apiGet?: (path: string) => Promise<ApiGetAnswer>
}

/** What one call produced, read by the executor once the call ends. */
export interface TransformCallLedger {
  emitted: EmittedBatch[]
  emittedRecords: number
  emittedBytes: number
  /** The first TRANSFORM_MAX_KEPT_ISSUES rejected records' issues... */
  rejected: Array<RecordIssue & { kind: string }>
  /** ...and how many records were rejected in all. */
  rejectedCount: number
  downloads: DeferredDownload[]
  apiGets: number
  /** The longest Retry-After any apiGet in this call answered with a 429. */
  throttledMs: number | null
}

export interface TransformBridge {
  methods: Record<TransformBridgeMethod, (...args: unknown[]) => Promise<unknown>>
  ledger: TransformCallLedger
}

function decodeArg(raw: unknown): unknown {
  if (typeof raw !== "string") return raw
  const t = raw.trimStart()
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      return JSON.parse(raw)
    } catch {
      return raw
    }
  }
  return raw
}

const MAX_PATH_CHARS = 4096

function pathArg(raw: unknown, method: string): string {
  const v = decodeArg(raw)
  const path =
    typeof v === "string"
      ? v
      : v && typeof v === "object" && typeof (v as { path?: unknown }).path === "string"
        ? (v as { path: string }).path
        : null
  if (path === null || path.length === 0) {
    throw new TransformBridgeError(`${method} needs a path (a string).`)
  }
  if (path.length > MAX_PATH_CHARS) {
    throw new TransformBridgeError(
      `${method}: the path is longer than ${MAX_PATH_CHARS} characters.`,
    )
  }
  return path
}

/**
 * Build the bridge for one transform call. The returned `methods` object is
 * the whole surface handed to the sandbox; `ledger` collects what the call
 * emitted and requested.
 */
export function buildTransformBridge(host: TransformBridgeHost): TransformBridge {
  const ledger: TransformCallLedger = {
    emitted: [],
    emittedRecords: 0,
    emittedBytes: 0,
    rejected: [],
    rejectedCount: 0,
    downloads: [],
    apiGets: 0,
    throttledMs: null,
  }
  const kinds = new Set(host.kinds)
  let nextRef = 0

  const emitRecords = async (rawKind: unknown, rawRecords: unknown): Promise<unknown> => {
    if (typeof rawKind !== "string" || !kinds.has(rawKind)) {
      throw new TransformBridgeError(
        `emitRecords: unknown kind ${JSON.stringify(rawKind)}; this transform emits ${[...kinds].join(", ") || "no kinds"}.`,
      )
    }
    const decoded = decodeArg(rawRecords)
    const list = Array.isArray(decoded) ? decoded : [decoded]
    const accepted: unknown[] = []
    const issues: RecordIssue[] = []
    list.forEach((record, index) => {
      if (record === null || typeof record !== "object" || Array.isArray(record)) {
        issues.push({ index, message: "a record is an object" })
        return
      }
      const bytes = Buffer.byteLength(JSON.stringify(record), "utf8")
      if (bytes > TRANSFORM_RECORD_MAX_BYTES) {
        issues.push({
          index,
          message: `the record is ${bytes} bytes serialized; the limit is ${TRANSFORM_RECORD_MAX_BYTES}`,
        })
        return
      }
      const problem = host.validateRecord?.(rawKind, record) ?? null
      if (problem) {
        issues.push({ index, message: problem })
        return
      }
      if (ledger.emittedRecords + accepted.length + 1 > TRANSFORM_CALL_MAX_RECORDS) {
        throw new TransformBridgeError(
          `emitRecords: one call may emit at most ${TRANSFORM_CALL_MAX_RECORDS} records.`,
        )
      }
      if (ledger.emittedBytes + bytes > TRANSFORM_CALL_MAX_EMIT_BYTES) {
        throw new TransformBridgeError(
          `emitRecords: one call may emit at most ${TRANSFORM_CALL_MAX_EMIT_BYTES} bytes of records.`,
        )
      }
      ledger.emittedBytes += bytes
      accepted.push(record)
    })
    if (accepted.length > 0) {
      ledger.emitted.push({ kind: rawKind, records: accepted })
      ledger.emittedRecords += accepted.length
    }
    ledger.rejectedCount += issues.length
    for (const issue of issues) {
      if (ledger.rejected.length >= TRANSFORM_MAX_KEPT_ISSUES) break
      ledger.rejected.push({ ...issue, kind: rawKind })
    }
    return {
      accepted: accepted.length,
      rejected: issues.slice(0, ANSWER_MAX_ISSUES),
      rejectedCount: issues.length,
    }
  }

  const declareFile = async (rawRef: unknown): Promise<unknown> => {
    if (host.sourceType !== "upload" || !host.resolveFile) {
      throw new TransformBridgeError(
        "declareFile is for upload sources; an API source uses downloadToFile.",
      )
    }
    const path = pathArg(rawRef, "declareFile")
    return host.resolveFile(path)
  }

  const downloadToFile = async (rawPath: unknown, rawOpts?: unknown): Promise<unknown> => {
    if (host.sourceType !== "api") {
      throw new TransformBridgeError(
        "downloadToFile is for API sources; an upload uses declareFile.",
      )
    }
    const path = pathArg(rawPath, "downloadToFile")
    if (ledger.downloads.length >= TRANSFORM_CALL_MAX_DOWNLOADS) {
      throw new TransformBridgeError(
        `downloadToFile: one call may record at most ${TRANSFORM_CALL_MAX_DOWNLOADS} downloads.`,
      )
    }
    const opts = decodeArg(rawOpts)
    const filename =
      opts &&
      typeof opts === "object" &&
      typeof (opts as { filename?: unknown }).filename === "string"
        ? sanitizeFilename((opts as { filename: string }).filename)
        : null
    nextRef++
    const refId = `download:${nextRef}`
    ledger.downloads.push({ refId, path, filename })
    return refId
  }

  const apiGet = async (rawPath: unknown): Promise<unknown> => {
    if (host.sourceType !== "api" || !host.apiGet) {
      throw new TransformBridgeError("apiGet is for API sources.")
    }
    const path = pathArg(rawPath, "apiGet")
    if (ledger.apiGets >= TRANSFORM_CALL_MAX_API_GETS) {
      throw new TransformBridgeError(
        `apiGet: one call may make at most ${TRANSFORM_CALL_MAX_API_GETS} requests; return a nextCursor and continue in the next call.`,
      )
    }
    ledger.apiGets++
    const answer = await host.apiGet(path)
    if (answer.status === 429) {
      const wait = answer.retryAfterMs ?? 0
      ledger.throttledMs = Math.max(ledger.throttledMs ?? 0, wait)
    }
    return answer
  }

  return { methods: { emitRecords, declareFile, downloadToFile, apiGet }, ledger }
}

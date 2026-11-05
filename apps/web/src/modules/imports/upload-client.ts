// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Upload one export file for an import (/api/imports/uploads): a multipart
// upload straight to object storage, part by part, or the API relay when the
// deployment relays uploads. Returns the uploaded file's id.
//
// A multipart upload survives a dropped connection. When a part fails, or
// complete answers PARTS_MISSING, the client backs off, reads the upload's
// status (the parts the store holds and those it lacks), re-signs the missing
// parts and sends only those: a part the store already holds is never sent
// again. After `attempts` failures in a row without progress it stops with an
// `ImportUploadInterruptedError` and leaves the upload open, so a later call
// with `resumeId` continues it.

import type { ApiClient } from "~/lib/api-client"
import { ApiError } from "~/lib/api-error"

const QUIET = { suppressGlobalError: true } as const
/** Part URLs the server signs at once (`IMPORT_SIGN_BATCH`). */
const SIGN_BATCH = 1000
/** Failures in a row, without a part getting through, before the upload stops. */
const DEFAULT_ATTEMPTS = 5
const BASE_DELAY_MS = 1000
const MAX_DELAY_MS = 30_000

interface PartUrl {
  partNumber: number
  url: string
}

interface CreatedUpload {
  id: string
  mode: "multipart" | "relay"
  partSize: number
  partCount: number
  parts?: PartUrl[]
  uploadUrl?: string
}

interface UploadState {
  id: string
  mode: "multipart" | "relay"
  status: "uploading" | "complete" | "aborted"
  size: number
  partSize: number
  partCount: number
  fileId: string | null
  received: Array<{ partNumber: number; size: number }>
  missing: number[]
}

export interface UploadImportFileOptions {
  onProgress?: (fraction: number) => void
  /** Continue this interrupted upload (from `ImportUploadInterruptedError.uploadId`). */
  resumeId?: string
  retry?: {
    /** Failures in a row before giving up (default 5). */
    attempts?: number
    /** Waits between attempts (tests pass one that returns at once). */
    sleep?: (ms: number) => Promise<void>
  }
}

/** The upload stopped after its retries; it stays open and `resumeId` continues it. */
export class ImportUploadInterruptedError extends Error {
  readonly code = "upload_interrupted"
  constructor(
    readonly uploadId: string,
    override readonly cause: unknown,
  ) {
    super("The upload was interrupted after several attempts; it can be resumed.")
    this.name = "ImportUploadInterruptedError"
  }
}

/** A part PUT that did not get through (network drop, expired URL, store error). */
class PartFailed extends Error {
  constructor(
    readonly partNumber: number,
    readonly status: number | null,
  ) {
    super(
      status === null
        ? `Part ${partNumber} of the upload failed (network error).`
        : `Part ${partNumber} of the upload failed (HTTP ${status}).`,
    )
  }
}

/** Worth another try after re-reading the upload: anything but a definite refusal. */
function recoverable(err: unknown): boolean {
  if (err instanceof PartFailed) return true
  if (err instanceof ApiError) return err.retryable || err.code === "PARTS_MISSING"
  // fetch rejects with a TypeError when the connection drops.
  return err instanceof TypeError
}

function backoff(attempt: number): number {
  const base = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempt - 1))
  return Math.round(base * (0.75 + Math.random() * 0.25))
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export async function uploadImportFile(
  api: ApiClient,
  file: File,
  opts: UploadImportFileOptions = {},
): Promise<string> {
  const { onProgress } = opts
  const attempts = opts.retry?.attempts ?? DEFAULT_ATTEMPTS
  const sleep = opts.retry?.sleep ?? defaultSleep

  let resumed: UploadState | null = null
  if (opts.resumeId) {
    const state = await api
      .get<UploadState>(`/imports/uploads/${opts.resumeId}`, QUIET)
      .catch(() => null)
    if (state?.status === "complete" && state.fileId) return state.fileId
    // Only an open multipart upload of this same file can be continued.
    if (state?.status === "uploading" && state.mode === "multipart" && state.size === file.size) {
      resumed = state
    }
  }

  const created: CreatedUpload =
    resumed ??
    (await api.post<CreatedUpload>(
      "/imports/uploads",
      { filename: file.name, mimeType: file.type || "application/octet-stream", size: file.size },
      QUIET,
    ))

  if (created.mode === "relay") {
    if (!created.uploadUrl) throw new Error("The upload has no destination.")
    const res = await fetch(created.uploadUrl, {
      method: "PUT",
      body: file,
      credentials: "include",
      headers: { "Content-Type": file.type || "application/octet-stream" },
    })
    if (!res.ok) throw new Error(`The upload failed (HTTP ${res.status}).`)
    onProgress?.(1)
    return complete(api, created.id)
  }

  const { id, partSize, partCount } = created
  const urls = new Map((created.parts ?? []).map((p) => [p.partNumber, p.url]))
  const held = new Set<number>(resumed ? resumed.received.map((p) => p.partNumber) : [])
  let todo = resumed ? resumed.missing : Array.from({ length: partCount }, (_, i) => i + 1)
  const report = () => onProgress?.(held.size / partCount)
  report()

  async function urlFor(n: number, from: number): Promise<string> {
    const known = urls.get(n)
    if (known) return known
    // Sign this part and the next ones still to send, a batch at a time.
    const wanted = todo.slice(from, from + SIGN_BATCH)
    const signed = await api.post<{ parts: PartUrl[] }>(
      `/imports/uploads/${id}/sign`,
      { partNumbers: wanted },
      QUIET,
    )
    for (const p of signed.parts) urls.set(p.partNumber, p.url)
    const url = urls.get(n)
    if (!url) throw new Error(`No upload address for part ${n}.`)
    return url
  }

  async function sendPart(n: number, url: string): Promise<void> {
    const start = (n - 1) * partSize
    let res: Response
    try {
      res = await fetch(url, {
        method: "PUT",
        body: file.slice(start, Math.min(file.size, start + partSize)),
      })
    } catch {
      throw new PartFailed(n, null)
    }
    if (!res.ok) throw new PartFailed(n, res.status)
  }

  let failures = 0
  for (;;) {
    try {
      for (let i = 0; i < todo.length; i++) {
        const n = todo[i]!
        if (held.has(n)) continue
        await sendPart(n, await urlFor(n, i))
        held.add(n)
        failures = 0
        report()
      }
      return await complete(api, id)
    } catch (err) {
      if (!recoverable(err)) throw err
      failures++
      if (failures > attempts) throw new ImportUploadInterruptedError(id, err)
      await sleep(backoff(failures))
      // What the store holds now decides what is sent next: only its missing
      // parts, each under a freshly signed URL.
      const state = await api.get<UploadState>(`/imports/uploads/${id}`, QUIET).catch((e) => {
        if (recoverable(e)) return null
        throw e
      })
      if (!state) continue
      if (state.status === "complete" && state.fileId) return state.fileId
      if (state.status !== "uploading") throw err
      held.clear()
      for (const p of state.received) held.add(p.partNumber)
      todo = state.missing
      for (const n of todo) urls.delete(n)
      report()
    }
  }
}

async function complete(api: ApiClient, id: string): Promise<string> {
  const done = await api.post<{ fileId: string | null }>(
    `/imports/uploads/${id}/complete`,
    undefined,
    QUIET,
  )
  if (!done.fileId) throw new Error("The upload did not complete.")
  return done.fileId
}

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Uploaded AcroForm templates: the server-side entry points. Every call runs in
// a fresh isolate process (pdf-form-worker.ts -> pdf-form-core.ts), never in
// the server: pdf-lib parses, walks and decodes synchronously, so a deadline
// raced against a promise cannot stop it, and one hostile upload would wedge
// or exhaust the API process for every user. The isolate is killed outright
// (SIGKILL) when it passes its wall clock (`parse_timeout`) or its resident
// memory ceiling (`too_complex`), and only a few run at once.
//
// A child process rather than a Bun Worker: a worker shares the server's
// process, so its heap counts against the server's and a native decode cannot
// be interrupted; a process can be capped by RSS and killed at any instruction.
// It follows the sandbox worker pool's pattern (worker-pool.ts): the same
// runtime binary, --smol, an env allowlist and the parent death pipe.
//
// The kill above runs on this process's event loop, and the isolate's own
// death pipe on the isolate's: a server that dies (or stalls) while an
// isolate is stuck in synchronous decoding would leave it running unbounded.
// So the kernel bounds it too, from the moment it starts: a CPU-seconds rlimit
// set by the shell that execs it (SIGXCPU, then SIGKILL a second later,
// enforced on Linux and macOS), and on Linux a data-segment rlimit the isolate
// sets on itself at startup, above its idle footprint by twice the RSS
// ceiling (macOS does not enforce RLIMIT_DATA or RLIMIT_AS, so there the CPU
// limit is the backstop: memory only grows while the CPU runs).

import { join } from "node:path"
import { pdfLogger as log } from "~/lib/logger"
import { readProcessRssBytes } from "../apps/sandbox/worker-pool"
import {
  type FillOptions,
  type FillResult,
  fromBase64,
  type InspectResult,
  PDF_FORM_MAX_BYTES,
  PdfFormError,
  type PdfFormField,
  type PdfFormImage,
  type PdfFormRequest,
  type PdfFormResponse,
  type PdfFormValue,
  type PdfFormWireResult,
  type PreparedTemplate,
  toBase64,
} from "./pdf-form-core"

export {
  DRY_RUN_SAMPLE,
  type FillOptions,
  type FillResult,
  type InspectResult,
  PDF_FORM_MAX_BYTES,
  PDF_FORM_MAX_FIELDS,
  PDF_FORM_MAX_IMAGE_SIDE,
  PDF_FORM_MAX_INFLATED_BYTES,
  PDF_FORM_MAX_OBJECTS,
  PDF_FORM_MAX_PAGES,
  PDF_FORM_MAX_TEXT_LENGTH,
  PDF_FORM_MAX_TREE_DEPTH,
  PdfFormError,
  type PdfFormErrorCode,
  type PdfFormField,
  type PdfFormFieldType,
  type PdfFormImage,
  type PdfFormRect,
  type PdfFormValue,
  type PreparedTemplate,
} from "./pdf-form-core"

/** Wall clock for one request, parse to answer, isolate start included. */
export const PDF_FORM_TIMEOUT_MS = 20_000
/** Resident memory one isolate may reach before it is killed. */
export const PDF_FORM_MAX_RSS_BYTES = 1024 * 1024 * 1024
/** Kernel CPU allowance of one isolate: the wall clock plus GC-thread slack. */
export const PDF_FORM_CPU_SECONDS = Math.ceil(PDF_FORM_TIMEOUT_MS / 1000) + 5
/** Isolates running at once; later requests wait their turn. */
export const PDF_FORM_MAX_CONCURRENT = 2

const WORKER_SCRIPT = join(import.meta.dir, "pdf-form-worker.ts")
const RSS_POLL_MS = 200
/** How long a killed isolate may take to be reaped before we stop waiting. */
const REAP_WAIT_MS = 2_000

interface IsolateLimits {
  timeoutMs: number
  maxRssBytes: number
  cpuSeconds: number
  structureWalk: boolean
  /** Test only: false stands for a dead parent (no wall-clock timer, no RSS poll). */
  parentKill: boolean
}

const DEFAULT_LIMITS: IsolateLimits = {
  timeoutMs: PDF_FORM_TIMEOUT_MS,
  maxRssBytes: PDF_FORM_MAX_RSS_BYTES,
  cpuSeconds: PDF_FORM_CPU_SECONDS,
  structureWalk: true,
  parentKill: true,
}
let limits: IsolateLimits = { ...DEFAULT_LIMITS }
let lastPid: number | undefined

// ---------------------------------------------------------------------------
// Concurrency gate
// ---------------------------------------------------------------------------

let running = 0
const waiting: Array<() => void> = []

async function acquire(): Promise<void> {
  if (running < PDF_FORM_MAX_CONCURRENT) {
    running++
    return
  }
  await new Promise<void>((resolve) => waiting.push(resolve))
}

function release(): void {
  const next = waiting.shift()
  if (next) next()
  else running--
}

// ---------------------------------------------------------------------------
// One isolate, one request
// ---------------------------------------------------------------------------

/** The isolate sees no host secret: only what the runtime needs to start. */
function isolateEnv(): Record<string, string> {
  const env: Record<string, string> = { NODE_ENV: process.env.NODE_ENV ?? "development" }
  if (process.env.PATH) env.PATH = process.env.PATH
  if (process.env.HOME) env.HOME = process.env.HOME
  return env
}

type IsolateMessage = { type: "ready" } | { type: "result"; response: PdfFormResponse }

function isIsolateMessage(msg: unknown): msg is IsolateMessage {
  return typeof msg === "object" && msg !== null && "type" in msg
}

function runInIsolate(req: PdfFormRequest): Promise<PdfFormWireResult> {
  return new Promise((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let poll: ReturnType<typeof setInterval> | undefined
    // Settle once, after the isolate is dead and reaped: no request outlives
    // its answer, and a caller never races a still-running parse.
    const settle = (outcome: () => void) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (poll) clearInterval(poll)
      try {
        proc.kill("SIGKILL")
      } catch {
        // Already gone.
      }
      const reaped = new Promise<void>((r) => setTimeout(r, REAP_WAIT_MS))
      void Promise.race([proc.exited.then(() => undefined), reaped]).then(outcome)
    }
    // Soft CPU limit N (SIGXCPU, which ends a Bun process), hard N + 1
    // (SIGKILL): with both at N, Linux sends SIGKILL and the cause is lost.
    // No core file where the limit reaches it (the isolate also turns dumps off
    // on Linux, pdf-form-worker.ts).
    // exec keeps the pid, so the kill below and the IPC channel reach the
    // isolate itself.
    const cmd = [
      "/bin/sh",
      "-c",
      'ulimit -c 0 && ulimit -S -t "$1" && ulimit -H -t $(($1 + 1)) || exit 70; shift; exec "$@"',
      "pdf-form-isolate",
      String(limits.cpuSeconds),
      process.execPath,
      "--smol",
      "run",
      WORKER_SCRIPT,
      String(2 * limits.maxRssBytes),
    ]
    const proc = Bun.spawn(cmd, {
      ipc(message: unknown) {
        if (!isIsolateMessage(message)) return
        if (message.type === "ready") {
          proc.send(req)
          return
        }
        const response = message.response
        settle(() => {
          if (response.ok) resolve(response.result)
          else reject(new PdfFormError(response.code, response.message, response.field))
        })
      },
      env: isolateEnv(),
      // The death pipe: the isolate exits when this process dies (orphan-exit.ts).
      stdin: "pipe",
      stdout: "ignore",
      stderr: "pipe",
    })
    lastPid = proc.pid
    // Drained so a chatty isolate never blocks on a full pipe; kept short for the log.
    let stderrTail = ""
    void (async () => {
      const decoder = new TextDecoder()
      for await (const chunk of proc.stderr) {
        stderrTail = (stderrTail + decoder.decode(chunk)).slice(-2_000)
      }
    })().catch(() => {})

    if (limits.parentKill) {
      timer = setTimeout(() => {
        settle(() =>
          reject(new PdfFormError("parse_timeout", `PDF took longer than ${limits.timeoutMs} ms`)),
        )
      }, limits.timeoutMs)
      poll = setInterval(() => {
        void readProcessRssBytes(proc.pid).then((rss) => {
          if (rss === null || rss <= limits.maxRssBytes) return
          settle(() =>
            reject(
              new PdfFormError("too_complex", "PDF needs more memory than a template may use"),
            ),
          )
        })
      }, RSS_POLL_MS)
    }
    void proc.exited.then((code) => {
      if (settled) return
      if (proc.signalCode === "SIGXCPU") {
        settle(() =>
          reject(
            new PdfFormError("parse_timeout", `PDF took more than ${limits.cpuSeconds} s of CPU`),
          ),
        )
        return
      }
      log.warn(
        { code, signal: proc.signalCode, stderr: stderrTail },
        "pdf form isolate exited without answering",
      )
      settle(() =>
        reject(new PdfFormError("parse_failed", "PDF could not be read (the reader stopped)")),
      )
    })
  })
}

async function run(req: Omit<PdfFormRequest, "structureWalk">): Promise<PdfFormWireResult> {
  // Cheap refusals before a process is spent on the request.
  const bytes = fromBase64(req.pdf)
  if (bytes.byteLength > PDF_FORM_MAX_BYTES) {
    throw new PdfFormError("input_too_large", `PDF is larger than ${PDF_FORM_MAX_BYTES} bytes`)
  }
  await acquire()
  try {
    return await runInIsolate({
      ...req,
      ...(limits.structureWalk ? {} : { structureWalk: false }),
    })
  } finally {
    release()
  }
}

function pdfOf(result: PdfFormWireResult): Uint8Array {
  if (result.pdf === undefined)
    throw new PdfFormError("parse_failed", "PDF reader returned no file")
  return fromBase64(result.pdf)
}

function fieldsOf(result: PdfFormWireResult): PdfFormField[] {
  if (!result.fields) throw new PdfFormError("parse_failed", "PDF reader returned no fields")
  return result.fields
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Inspect an upload: caps, encryption, XFA and fields. Throws PdfFormError. */
export async function inspectPdfForm(bytes: Uint8Array): Promise<InspectResult> {
  const result = await run({ op: "inspect", pdf: toBase64(bytes) })
  return { pageCount: result.pageCount ?? 0, fields: fieldsOf(result) }
}

/** The field list of a (stored, sanitized) template. */
export async function listPdfFormFields(bytes: Uint8Array): Promise<PdfFormField[]> {
  return fieldsOf(await run({ op: "list", pdf: toBase64(bytes) }))
}

/** Remove active content; saved, reloaded and re-scanned before it is returned. */
export async function sanitizePdfForm(bytes: Uint8Array): Promise<Uint8Array> {
  return pdfOf(await run({ op: "sanitize", pdf: toBase64(bytes) }))
}

/**
 * Fill a template and flatten it. `values` and `images` are keyed by fully
 * qualified field name; a field with neither prints as a grey placeholder
 * (options.placeholders, else its tooltip, else its label). The input is
 * re-sanitized first: stored templates are clean, but this is the last door
 * before a document leaves the platform.
 */
export async function fillPdfForm(
  bytes: Uint8Array,
  values: Record<string, PdfFormValue>,
  images: Record<string, PdfFormImage> = {},
  options: FillOptions = {},
): Promise<FillResult> {
  const wireValues: Record<string, string | boolean | null> = {}
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined) wireValues[name] = value
  }
  const wireImages: NonNullable<PdfFormRequest["images"]> = {}
  for (const [name, image] of Object.entries(images)) {
    wireImages[name] = { data: toBase64(image.bytes), type: image.type }
  }
  const result = await run({
    op: "fill",
    pdf: toBase64(bytes),
    values: wireValues,
    images: wireImages,
    options,
  })
  return { bytes: pdfOf(result), values: result.values ?? {}, blank: result.blank ?? [] }
}

/**
 * Fill every text field with a mixed-script sample and flatten. Run at upload,
 * so a template that cannot print is refused there (`flatten_failed`), not on
 * the day someone needs the document.
 */
export async function dryRunPdfForm(bytes: Uint8Array): Promise<Uint8Array> {
  return pdfOf(await run({ op: "dryRun", pdf: toBase64(bytes) }))
}

/**
 * The whole intake: inspect, sanitize, then dry-run the sanitized bytes, in one
 * isolate. Returns the bytes to store and the field list to store with them.
 */
export async function preparePdfFormTemplate(bytes: Uint8Array): Promise<PreparedTemplate> {
  const result = await run({ op: "prepare", pdf: toBase64(bytes) })
  return { bytes: pdfOf(result), pageCount: result.pageCount ?? 0, fields: fieldsOf(result) }
}

/**
 * Test access to the isolate's limits, grouped in one object so the production
 * surface carries a single named door. Production code never calls it.
 */
export const PdfFormTestAccess = {
  /** Override limits for the next requests; `{}` restores the defaults. */
  setLimits(overrides: Partial<IsolateLimits>): void {
    limits = { ...DEFAULT_LIMITS, ...overrides }
  },
  /** Pid of the most recently spawned isolate. */
  lastPid(): number | undefined {
    return lastPid
  },
}

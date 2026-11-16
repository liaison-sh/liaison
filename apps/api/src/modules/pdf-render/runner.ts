// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The render service's process control: one child per request (child.ts),
// killed outright (SIGKILL) past its page deadline, its file deadline or its
// memory ceiling, as the PDF form isolate is killed (documents/pdf-form.ts).
// Its own slots, not shared with form filling, and per organization one
// running and three waiting, then busy.
//
// The child sees no host secret: only what the runtime needs to start.

import { join } from "node:path"
import { pdfLogger as log } from "~/lib/logger"
import { readProcessRssBytes } from "~/modules/apps/sandbox/worker-pool"
import {
  PDF_RENDER_FILE_MS,
  PDF_RENDER_MAX_RSS_BYTES,
  PDF_RENDER_ORG_RUNNING,
  PDF_RENDER_ORG_WAITING,
  PDF_RENDER_PAGE_MS,
  PDF_RENDER_SLOTS,
  type PdfRenderRequest,
  type PdfRenderResponse,
} from "./protocol"

const CHILD_SCRIPT = join(import.meta.dir, "child.ts")
const RSS_POLL_MS = 200
const REAP_WAIT_MS = 2_000

interface Limits {
  pageMs: number
  fileMs: number
  maxRssBytes: number
}
const DEFAULT_LIMITS: Limits = {
  pageMs: PDF_RENDER_PAGE_MS,
  fileMs: PDF_RENDER_FILE_MS,
  maxRssBytes: PDF_RENDER_MAX_RSS_BYTES,
}
let limits: Limits = { ...DEFAULT_LIMITS }
let lastPid: number | undefined

// ---------------------------------------------------------------------------
// Slots: global, then per organization
// ---------------------------------------------------------------------------

let running = 0
const waiting: Array<() => void> = []
const orgRunning = new Map<string, number>()
const orgWaiting = new Map<string, Array<() => void>>()

function busy<T>(): PdfRenderResponse<T> {
  return {
    ok: false,
    code: "PDF_RENDER_BUSY",
    message: "The file reader is busy. Try again in a minute.",
  }
}

async function acquire(orgId: string): Promise<boolean> {
  const mine = orgRunning.get(orgId) ?? 0
  if (mine >= PDF_RENDER_ORG_RUNNING) {
    const queue = orgWaiting.get(orgId) ?? []
    if (queue.length >= PDF_RENDER_ORG_WAITING) return false
    await new Promise<void>((resolve) => {
      queue.push(resolve)
      orgWaiting.set(orgId, queue)
    })
  } else {
    orgRunning.set(orgId, mine + 1)
  }
  if (running < PDF_RENDER_SLOTS) running++
  else await new Promise<void>((resolve) => waiting.push(resolve))
  return true
}

function release(orgId: string): void {
  const next = waiting.shift()
  if (next) next()
  else running--
  const queue = orgWaiting.get(orgId)
  const nextOfOrg = queue?.shift()
  if (nextOfOrg) nextOfOrg()
  else orgRunning.set(orgId, Math.max(0, (orgRunning.get(orgId) ?? 1) - 1))
  if (queue && queue.length === 0) orgWaiting.delete(orgId)
}

function childEnv(): Record<string, string> {
  const env: Record<string, string> = { NODE_ENV: process.env.NODE_ENV ?? "development" }
  if (process.env.PATH) env.PATH = process.env.PATH
  if (process.env.HOME) env.HOME = process.env.HOME
  return env
}

function unreadable<T>(message: string): PdfRenderResponse<T> {
  return { ok: false, code: "PDF_UNREADABLE", message }
}

function runInChild<T>(req: PdfRenderRequest): Promise<PdfRenderResponse<T>> {
  return new Promise((resolve) => {
    let settled = false
    let fileTimer: ReturnType<typeof setTimeout> | undefined
    let pageTimer: ReturnType<typeof setTimeout> | undefined
    let poll: ReturnType<typeof setInterval> | undefined
    const settle = (response: PdfRenderResponse<T>) => {
      if (settled) return
      settled = true
      if (fileTimer) clearTimeout(fileTimer)
      if (pageTimer) clearTimeout(pageTimer)
      if (poll) clearInterval(poll)
      try {
        proc.kill("SIGKILL")
      } catch {
        // Already gone.
      }
      const reaped = new Promise<void>((r) => setTimeout(r, REAP_WAIT_MS))
      void Promise.race([proc.exited.then(() => undefined), reaped]).then(() => resolve(response))
    }
    const cpuSeconds = Math.ceil(limits.fileMs / 1000) + 5
    const proc = Bun.spawn(
      [
        "/bin/sh",
        "-c",
        'ulimit -c 0 && ulimit -S -t "$1" && ulimit -H -t $(($1 + 1)) || exit 70; shift; exec "$@"',
        "pdf-render-child",
        String(cpuSeconds),
        process.execPath,
        "--smol",
        "run",
        CHILD_SCRIPT,
        String(2 * limits.maxRssBytes),
      ],
      {
        ipc(message: unknown) {
          const m = message as { type?: string; n?: number; response?: PdfRenderResponse<T> }
          if (m?.type === "ready") {
            proc.send(req)
            return
          }
          if (m?.type === "page") {
            if (pageTimer) clearTimeout(pageTimer)
            pageTimer = setTimeout(
              () => settle(unreadable(`page ${m.n} took longer than ${limits.pageMs} ms`)),
              limits.pageMs,
            )
            return
          }
          if (m?.type === "result" && m.response) settle(m.response)
        },
        env: childEnv(),
        stdin: "pipe",
        stdout: "ignore",
        stderr: "pipe",
      },
    )
    lastPid = proc.pid
    let stderrTail = ""
    void (async () => {
      const decoder = new TextDecoder()
      for await (const chunk of proc.stderr) {
        stderrTail = (stderrTail + decoder.decode(chunk)).slice(-2_000)
      }
    })().catch(() => {})
    fileTimer = setTimeout(
      () => settle(unreadable(`the file took longer than ${limits.fileMs} ms`)),
      limits.fileMs,
    )
    poll = setInterval(() => {
      void readProcessRssBytes(proc.pid).then((rss) => {
        if (rss !== null && rss > limits.maxRssBytes)
          settle(unreadable("the file needs more memory than a reading may use"))
      })
    }, RSS_POLL_MS)
    void proc.exited.then((code) => {
      if (settled) return
      log.warn(
        { code, signal: proc.signalCode, stderr: stderrTail },
        "pdf render child exited without answering",
      )
      settle(unreadable("the file could not be read (the reader stopped)"))
    })
  })
}

/** Run one request in a fresh child, within this service's slots. Never throws. */
export async function runRenderRequest<T>(req: PdfRenderRequest): Promise<PdfRenderResponse<T>> {
  if (!(await acquire(req.orgId))) return busy()
  try {
    return await runInChild<T>(req)
  } finally {
    release(req.orgId)
  }
}

/** Test access to the child's limits; production code never calls it. */
export const PdfRenderTestAccess = {
  setLimits(overrides: Partial<Limits>): void {
    limits = { ...DEFAULT_LIMITS, ...overrides }
  },
  lastPid(): number | undefined {
    return lastPid
  },
}

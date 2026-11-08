// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Where an app run's console output goes, on either executor.
//
//  - Workers: worker-core.ts captures console.* and uncaught errors per run and
//    returns them in the /run answer (`logs`, `logsDropped`); executor.ts
//    reads them (`parseWorkerLogs`), runApp hands them to `deliverRunLogs`.
//  - QuickJS: the ctx shim defines a `console` whose lines go over the
//    bridge's `log_<level>` methods marked `{source:"console"}`
//    (ctx-shim.ts); the bridge hands them to `writeConsoleToProcessLog` and
//    to the run's app log sink (bridge/identity.ts). Workers lines are handed
//    to the same bridge methods after the run, so both executors file a line
//    the same way.
//
// Two destinations:
//  - The process log, for every app: at most PROCESS_CONSOLE_LINES_PER_MINUTE
//    lines per process per minute (past it lines are counted and dropped, and
//    the next window opens with one warning saying how many), each cut to 512
//    bytes. App text is first-party data: the cap keeps a webhook burst from
//    flooding the operator's log.
//  - The app logs (kernel.app_logs, modules/app-builder/logs.ts) of a custom
//    app or a draft preview: through the run's log sink, so the lines carry
//    that run's access tags and its caps, marked `fields.source = "console"`.
//    The tool that reads them back into an agent's context (apps_build_logs)
//    is a taint source: the turn is marked as having read outside text. A
//    line worker-core marks `shared` (logged while other runs shared the
//    isolate) cannot be attributed to one run's tags: it is not filed; one
//    notice line says how many were left out.

import { rootLogger } from "~/lib/logger"
import { runLogSinkOf } from "~/modules/app-builder/logs"
import type { WorkerLogLevel, WorkerLogLine } from "./worker-core"

export type { WorkerLogLine } from "./worker-core"

const log = rootLogger.child({ module: "app-console" })

export const PROCESS_CONSOLE_LINES_PER_MINUTE = 600
export const PROCESS_CONSOLE_LINE_MAX_BYTES = 512
const WINDOW_MS = 60_000
/** At most what worker-core keeps per run; anything past it is not ours to trust. */
const MAX_LINES_PER_ANSWER = 200
const MAX_MSG_CHARS = 4 * 1024

const LEVELS = new Set<WorkerLogLevel>(["debug", "info", "warn", "error"])

/** The `logs` of a loader answer, validated (anything malformed is skipped). */
export function parseWorkerLogs(raw: unknown): WorkerLogLine[] {
  if (!Array.isArray(raw)) return []
  const out: WorkerLogLine[] = []
  for (const l of raw.slice(0, MAX_LINES_PER_ANSWER)) {
    if (!l || typeof l !== "object") continue
    const r = l as { level?: unknown; msg?: unknown; at?: unknown; shared?: unknown }
    if (typeof r.msg !== "string") continue
    const level = LEVELS.has(r.level as WorkerLogLevel) ? (r.level as WorkerLogLevel) : "info"
    const at = typeof r.at === "number" && Number.isFinite(r.at) ? r.at : Date.now()
    const line: WorkerLogLine = { level, msg: r.msg.slice(0, MAX_MSG_CHARS), at }
    if (r.shared === true) line.shared = true
    out.push(line)
  }
  return out
}

/** A console line as the process log gets it: at most 512 bytes (UTF-8), marked when cut. */
export function cutConsoleLine(text: string): string {
  const max = PROCESS_CONSOLE_LINE_MAX_BYTES
  if (Buffer.byteLength(text) <= max) return text
  const mark = "…"
  const room = max - Buffer.byteLength(mark)
  let out = Buffer.from(text).subarray(0, room).toString("utf8")
  while (Buffer.byteLength(out) > room || out.endsWith("\uFFFD")) out = out.slice(0, -1)
  return `${out}${mark}`
}

class ProcessConsoleCap {
  private windowStart = 0
  private used = 0
  private dropped = 0

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number,
  ) {}

  take(): boolean {
    const now = this.now()
    if (now - this.windowStart >= WINDOW_MS) {
      if (this.dropped > 0) {
        log.warn(
          { dropped: this.dropped, perMinute: this.perMinute },
          "App console lines over this process's per-minute cap were dropped",
        )
      }
      this.windowStart = now
      this.used = 0
      this.dropped = 0
    }
    if (this.used >= this.perMinute) {
      this.dropped++
      return false
    }
    this.used++
    return true
  }

  droppedInWindow(): number {
    return this.dropped
  }
}

let processCap = new ProcessConsoleCap(PROCESS_CONSOLE_LINES_PER_MINUTE, Date.now)

export interface ConsoleLineContext {
  app: string
  orgId: string
  runId?: string
  executor: "workers" | "quickjs"
}

/** One app console line to the process log, capped per process and cut to 512 bytes. */
export function writeConsoleToProcessLog(
  ctx: ConsoleLineContext,
  level: WorkerLogLevel,
  msg: string,
): void {
  if (!processCap.take()) return
  const fields = {
    source: "app-console",
    app: ctx.app,
    orgId: ctx.orgId,
    executor: ctx.executor,
    ...(ctx.runId ? { runId: ctx.runId } : {}),
  }
  log[level](fields, cutConsoleLine(msg))
}

/**
 * A Workers run's captured lines, to the process log and (custom apps,
 * previews) the app logs. The lines take the same path as a QuickJS console
 * line: the sink bound to the bridge (a draft preview), else the bridge's own
 * `log_<level>` methods marked {source:"console"} (bridge/identity.ts: the
 * run's sink with its tags, and the capped process log), else the process log.
 */
export function deliverRunLogs(input: {
  bridge: Record<string, unknown>
  app: string
  orgId: string
  runId?: string
  logs: readonly WorkerLogLine[]
  dropped?: number
}): void {
  const ctx: ConsoleLineContext = {
    app: input.app,
    orgId: input.orgId,
    executor: "workers",
    ...(input.runId ? { runId: input.runId } : {}),
  }
  const sink = runLogSinkOf(input.bridge)
  const bridgeLog = (level: WorkerLogLevel) => {
    const fn = input.bridge[`log_${level}`]
    return typeof fn === "function" ? (fn as (msg: string, data: string) => unknown) : undefined
  }
  const fileLine = (level: WorkerLogLevel, msg: string, at?: number): boolean => {
    const fields = {
      source: "console",
      ...(at !== undefined ? { at: new Date(at).toISOString() } : {}),
    }
    if (sink) {
      sink.append(level, msg, fields)
      return false
    }
    const fn = bridgeLog(level)
    if (!fn) return false
    try {
      void Promise.resolve(fn(msg, JSON.stringify(fields))).catch(() => undefined)
      return true
    } catch (err) {
      log.debug({ err, app: input.app }, "app console line refused by the bridge")
      return false
    }
  }
  let unattributed = 0
  for (const line of input.logs) {
    // A shared line goes to the process log only: no run's tags fit it.
    if (line.shared) {
      unattributed++
      writeConsoleToProcessLog(ctx, line.level, line.msg)
      continue
    }
    // The bridge's log method writes the process log itself.
    if (!fileLine(line.level, line.msg, line.at))
      writeConsoleToProcessLog(ctx, line.level, line.msg)
  }
  if (!sink && !bridgeLog("warn")) return
  if (unattributed > 0) {
    fileLine(
      "warn",
      `${unattributed} console line(s) logged while other runs of this app shared the isolate were not filed under this run.`,
    )
  }
  if (input.dropped && input.dropped > 0) {
    fileLine(
      "warn",
      `${input.dropped} console line(s) past the per-run cap (200 lines or 64 KiB) were dropped.`,
    )
  }
}

/** Test seam. */
export const WorkerLogsTestAccess = {
  resetProcessCap(perMinute = PROCESS_CONSOLE_LINES_PER_MINUTE, now: () => number = Date.now) {
    processCap = new ProcessConsoleCap(perMinute, now)
  },
  droppedInWindow: () => processCap.droppedInWindow(),
}

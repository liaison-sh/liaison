// SPDX-License-Identifier: FSL-1.1-ALv2
import pino from "pino"

const level = import.meta.env.DEV ? "debug" : "info"

// Bounded ring buffer of recent log lines, shipped with in-app bug reports so a
// report carries what the console saw right before the problem. Capture is done
// by wrapping the level methods (not pino's browser `transmit`) so it works
// identically whichever pino build (browser or node) the bundler resolves.
// Console/stdout output itself is untouched — the original method still runs.
const MAX_BUFFER_ENTRIES = 300
const MAX_ENTRY_CHARS = 2_000
const buffer: string[] = []

function pushLogLine(line: string): void {
  buffer.push(line.length > MAX_ENTRY_CHARS ? `${line.slice(0, MAX_ENTRY_CHARS - 1)}…` : line)
  if (buffer.length > MAX_BUFFER_ENTRIES) buffer.shift()
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value
  if (value instanceof Error) return `${value.name}: ${value.message}`
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** Recent log lines, oldest first. Returns a copy — safe to mutate. */
export function getRecentLogs(): string[] {
  return [...buffer]
}

const CAPTURED_LEVELS = ["debug", "info", "warn", "error", "fatal"] as const

function instrument(logger: pino.Logger): pino.Logger {
  for (const lvl of CAPTURED_LEVELS) {
    const orig = logger[lvl].bind(logger)
    logger[lvl] = ((...args: unknown[]) => {
      pushLogLine(`${new Date().toISOString()} [${lvl}] ${args.map(formatValue).join(" ")}`)
      orig(...(args as [string]))
    }) as never
  }
  const origChild = logger.child.bind(logger)
  logger.child = ((bindings: pino.Bindings, options?: pino.ChildLoggerOptions) =>
    instrument(origChild(bindings, options))) as never
  return logger
}

export const log = instrument(pino({ browser: { asObject: false }, level }))

// Uncaught errors and rejections rarely go through the logger — capture them
// into the same buffer so bug reports include the crash that prompted them.
if (typeof window !== "undefined") {
  window.addEventListener("error", (event) => {
    pushLogLine(
      `${new Date().toISOString()} [uncaught] ${event.message} (${event.filename ?? "?"}:${event.lineno ?? "?"})`,
    )
  })
  window.addEventListener("unhandledrejection", (event) => {
    pushLogLine(`${new Date().toISOString()} [unhandledrejection] ${formatValue(event.reason)}`)
  })
}

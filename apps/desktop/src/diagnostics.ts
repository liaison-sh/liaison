// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The overlay's diagnostic bridge, for a DRIVEN WALK of the debug app.
//
// The webview serves apps/web unmodified and the overlay is injected into it,
// so the two things that break a walk are invisible from outside: a content
// security policy refusal (the page silently does not load something) and a
// script error in a page nobody has a devtools window open on. Both are
// forwarded here to the shell, which prints one line per report to its stderr,
// so the operator who launched the debug app reads a log instead of driving a
// devtools session.
//
// DEBUG BUILDS ONLY. The shell registers `report_webview_diagnostic` under
// `cfg(debug_assertions)`, so in a release build every forward below is a
// rejected invoke: it is swallowed, and nothing here ever throws into the
// host page. That is the whole release behaviour, and it is what makes it
// safe to install the listeners unconditionally.
import { invoke } from "./tauri"

/** The shell command, as registered in `src-tauri/src/main.rs` (debug only). */
export const DIAGNOSTIC_COMMAND = "report_webview_diagnostic"

/** What the shell truncates a message to. Truncated here too, so the bridge
 * never ships 10 MB of stack trace across the IPC boundary to have it cut. */
export const DIAGNOSTIC_MESSAGE_LIMIT = 2000

/** The report kinds the shell knows. `dom` is the walk probe (dom-probe.ts). */
export type DiagnosticKind = "csp" | "error" | "unhandledrejection" | "console" | "dom"

function clamp(text: string): string {
  return text.length > DIAGNOSTIC_MESSAGE_LIMIT ? text.slice(0, DIAGNOSTIC_MESSAGE_LIMIT) : text
}

/**
 * Hands one report to the shell. Fire and forget in both directions: an
 * unregistered command rejects, a page with no Tauri under it throws
 * synchronously, and a diagnostic that reports its own failure would be a
 * loop through the wrapped `console.error` below.
 */
export function reportDiagnostic(kind: DiagnosticKind, message: string, source?: string): void {
  const payload: { kind: DiagnosticKind; message: string; source?: string } = {
    kind,
    message: clamp(message),
  }
  if (source) payload.source = source
  try {
    void Promise.resolve(invoke(DIAGNOSTIC_COMMAND, payload)).catch(() => undefined)
  } catch {
    // A release build, or a plain browser. Silence is the contract.
  }
}

function describe(value: unknown): string {
  if (typeof value === "string") return value
  if (value instanceof Error) return `${value.name}: ${value.message}`
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function at(file: unknown, line: unknown, column?: unknown): string | undefined {
  if (typeof file !== "string" || file === "") return undefined
  const lineText = typeof line === "number" && line > 0 ? `:${line}` : ""
  const columnText = typeof column === "number" && column > 0 ? `:${column}` : ""
  return `${file}${lineText}${columnText}`
}

/** One install per window. A second injection of the bundle (a reload, a
 * second window) must not double every line the operator reads. */
let installed = false

/**
 * Installs the listeners and returns the uninstall. Idempotent: a second call
 * while one is installed returns a no-op.
 */
export function installWebviewDiagnostics(target: Window = window): () => void {
  if (installed) return () => undefined
  installed = true

  const onViolation = (event: Event): void => {
    const violation = event as SecurityPolicyViolationEvent
    reportDiagnostic(
      "csp",
      `${violation.violatedDirective} blocked ${violation.blockedURI}`,
      at(violation.sourceFile, violation.lineNumber),
    )
  }
  const onError = (event: Event): void => {
    const error = event as ErrorEvent
    reportDiagnostic(
      "error",
      describe(error.message || error.error),
      at(error.filename, error.lineno, error.colno),
    )
  }
  const onRejection = (event: Event): void => {
    reportDiagnostic("unhandledrejection", describe((event as PromiseRejectionEvent).reason))
  }

  target.addEventListener("securitypolicyviolation", onViolation)
  target.addEventListener("error", onError)
  target.addEventListener("unhandledrejection", onRejection)

  // The page's own console.error is the third source, and the only one that
  // is not an event: apps/web reports a failed request through it and nothing
  // else would carry that to the walk's log. The original is always called,
  // so a devtools window still shows exactly what it showed before.
  const console = (target as Window & { console?: Console }).console ?? globalThis.console
  const original = console.error.bind(console)
  console.error = (...args: unknown[]): void => {
    original(...args)
    reportDiagnostic("console", args.map(describe).join(" "))
  }

  return () => {
    installed = false
    target.removeEventListener("securitypolicyviolation", onViolation)
    target.removeEventListener("error", onError)
    target.removeEventListener("unhandledrejection", onRejection)
    console.error = original
  }
}

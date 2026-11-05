// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The driven walk reads the shell's stderr, so what is asserted here is the
// FORWARDING: each browser diagnostic the operator would otherwise open a
// devtools window for reaches the shell as one typed command, with the
// payload the Rust side prints. And the release case: the command is not
// registered there, so every forward rejects and none of it may surface as a
// page error of its own.
import { beforeEach, describe, expect, it, vi } from "vitest"

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn(async (_command: string, _args?: Record<string, unknown>) => undefined as unknown),
}))
vi.mock("./tauri", () => ({ invoke, listen: vi.fn() }))

import {
  DIAGNOSTIC_COMMAND,
  DIAGNOSTIC_MESSAGE_LIMIT,
  installWebviewDiagnostics,
} from "./diagnostics"

/** The last payload the shell was handed, or null. */
function lastReport(): { kind: string; message: string; source?: string } | null {
  const call = invoke.mock.calls.findLast(([command]) => command === DIAGNOSTIC_COMMAND)
  return call ? (call[1] as { kind: string; message: string; source?: string }) : null
}

function fire(type: string, props: Record<string, unknown>): void {
  window.dispatchEvent(Object.assign(new Event(type), props))
}

describe("the webview diagnostic bridge", () => {
  let uninstall: () => void

  beforeEach(() => {
    invoke.mockClear()
    invoke.mockImplementation(async () => undefined)
    uninstall?.()
    uninstall = installWebviewDiagnostics(window)
    return () => uninstall()
  })

  it("forwards a content security policy refusal with the directive and the blocked url", () => {
    fire("securitypolicyviolation", {
      // A CDN font: `font-src 'self' data:` still refuses it. The old example
      // here was a cross-origin SCRIPT, which `script-src https:` now allows,
      // so it described a violation the shipped policy can no longer produce.
      blockedURI: "https://fonts.gstatic.com/x.woff2",
      violatedDirective: "font-src",
      sourceFile: "http://localhost:3000/app.js",
      lineNumber: 42,
    })
    expect(lastReport()).toEqual({
      kind: "csp",
      message: "font-src blocked https://fonts.gstatic.com/x.woff2",
      source: "http://localhost:3000/app.js:42",
    })
  })

  it("forwards a page error with its file and line", () => {
    fire("error", {
      message: "boom",
      filename: "http://localhost:3000/app.js",
      lineno: 7,
      colno: 3,
    })
    expect(lastReport()).toEqual({
      kind: "error",
      message: "boom",
      source: "http://localhost:3000/app.js:7:3",
    })
  })

  it("forwards an unhandled rejection by its reason", () => {
    fire("unhandledrejection", { reason: new Error("nope") })
    const report = lastReport()
    expect(report?.kind).toBe("unhandledrejection")
    expect(report?.message).toContain("nope")
  })

  it("forwards a console error and still calls the original console", () => {
    uninstall()
    const original = console.error
    const seen = vi.fn()
    console.error = seen
    uninstall = installWebviewDiagnostics(window)
    console.error("bad", { id: 3 })
    const report = lastReport()
    console.error = original
    expect(report?.kind).toBe("console")
    expect(report?.message).toContain("bad")
    expect(seen).toHaveBeenCalled()
  })

  it("truncates a long message to the shell's limit", () => {
    fire("error", { message: "x".repeat(DIAGNOSTIC_MESSAGE_LIMIT + 500) })
    expect(lastReport()?.message.length).toBe(DIAGNOSTIC_MESSAGE_LIMIT)
  })

  it("stays silent when the command is not registered, as in a release build", () => {
    invoke.mockImplementation(async () => {
      throw new Error("Command report_webview_diagnostic not found")
    })
    expect(() => fire("error", { message: "boom" })).not.toThrow()
    expect(() =>
      fire("securitypolicyviolation", { blockedURI: "x", violatedDirective: "script-src" }),
    ).not.toThrow()
  })

  it("throws nothing when invoke itself is unavailable, as in a plain browser", () => {
    invoke.mockImplementation(() => {
      throw new Error("window.__TAURI_INTERNALS__ is undefined")
    })
    expect(() => fire("error", { message: "boom" })).not.toThrow()
  })

  it("stops forwarding once it is uninstalled", () => {
    uninstall()
    invoke.mockClear()
    fire("error", { message: "after" })
    expect(lastReport()).toBeNull()
    uninstall = installWebviewDiagnostics(window)
  })

  it("installs once, so a second call does not double every report", () => {
    const second = installWebviewDiagnostics(window)
    invoke.mockClear()
    fire("error", { message: "once" })
    expect(invoke.mock.calls.filter(([command]) => command === DIAGNOSTIC_COMMAND)).toHaveLength(1)
    second()
  })
})

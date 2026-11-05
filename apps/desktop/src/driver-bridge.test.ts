// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The return half of the shell's debug only DOM driver.

import { beforeEach, describe, expect, it, vi } from "vitest"

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn(async (_command: string, _args?: Record<string, unknown>) => undefined as unknown),
}))
vi.mock("./tauri", () => ({ invoke, listen: vi.fn(async () => () => undefined) }))

import {
  DRIVER_REPORT_KEY,
  DRIVER_RESULT_COMMAND,
  DRIVER_RESULT_LIMIT,
  installDriverReporter,
} from "./driver-bridge"

type Reporter = (id: unknown, payload: unknown) => void

describe("the DOM driver's return half", () => {
  beforeEach(() => {
    invoke.mockClear()
  })

  it("a script's answer reaches the shell under the id it was run as", () => {
    const target: Record<string, unknown> = {}
    installDriverReporter(target)
    ;(target[DRIVER_REPORT_KEY] as Reporter)("01-open-menu", '{"ok":true,"value":null}')
    expect(invoke).toHaveBeenCalledWith(DRIVER_RESULT_COMMAND, {
      id: "01-open-menu",
      payload: '{"ok":true,"value":null}',
    })
  })

  // A dumped subtree has no upper bound and a walk reads the file, so the cut
  // is here rather than at the far end of the IPC boundary.
  it("an answer over the cap is clamped before it crosses", () => {
    const target: Record<string, unknown> = {}
    installDriverReporter(target)
    ;(target[DRIVER_REPORT_KEY] as Reporter)("02-dump", "x".repeat(DRIVER_RESULT_LIMIT + 500))
    const [, args] = invoke.mock.calls[0] as [string, { payload: string }]
    expect(args.payload.length).toBe(DRIVER_RESULT_LIMIT)
  })

  // The function is on the window, so anything in the page can call it. It
  // decides nothing and forwards nothing it was not given as two strings.
  it("a call that is not two strings never reaches the shell", () => {
    const target: Record<string, unknown> = {}
    installDriverReporter(target)
    const report = target[DRIVER_REPORT_KEY] as Reporter
    report(null, "{}")
    report("01-step", { ok: true })
    report(7, 9)
    expect(invoke).not.toHaveBeenCalled()
  })
})

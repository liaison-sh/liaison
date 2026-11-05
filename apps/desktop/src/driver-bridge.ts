// SPDX-License-Identifier: FSL-1.1-ALv2
//
// DEBUG BUILDS ONLY, the same way `diagnostics.ts` is: the command below is
// registered by the shell under `cfg(debug_assertions)` alone, so in a release
// build the call is a rejected invoke and nothing more. That is what makes it
// safe to publish the function unconditionally.
//
// It is the RETURN half of the shell's DOM driver (`src-tauri/src/driver.rs`).
// The shell evaluates a walk's script in this page and the script's answer has
// to get back out; this is the one function it answers through. The page never
// asks for a script, never names the directory and never learns what is in it:
// everything that decides anything is on the shell's side.

import { invoke } from "./tauri"

/** The shell command, registered on a debug build alone (`driver.rs`). */
export const DRIVER_RESULT_COMMAND = "report_driver_result"

/** The window property the evaluated script calls, as `driver.rs` writes it. */
export const DRIVER_REPORT_KEY = "__LIAISON_DRIVER_REPORT__"

/** What one answer may carry. A rect or a style is small; a dumped subtree is
 * not, and a result file a walk cannot read is worse than a truncated one. */
export const DRIVER_RESULT_LIMIT = 200000

/**
 * Publishes the report function on the window. Fire and forget in both
 * directions, exactly like `reportDiagnostic`: a release build rejects the
 * invoke, a plain browser has no Tauri under it and throws synchronously, and
 * neither may reach the page.
 */
export function installDriverReporter(target: object = globalThis): void {
  ;(target as Record<string, unknown>)[DRIVER_REPORT_KEY] = (
    id: unknown,
    payload: unknown,
  ): void => {
    if (typeof id !== "string" || typeof payload !== "string") return
    const clamped =
      payload.length > DRIVER_RESULT_LIMIT ? payload.slice(0, DRIVER_RESULT_LIMIT) : payload
    try {
      void Promise.resolve(invoke(DRIVER_RESULT_COMMAND, { id, payload: clamped })).catch(
        () => undefined,
      )
    } catch {
      // A release build, or a plain browser. Silence is the contract.
    }
  }
}

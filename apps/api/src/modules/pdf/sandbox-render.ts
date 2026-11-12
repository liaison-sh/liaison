// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Run a PDF template in the app sandbox, then replay its emitted draw-command
// list against pdf-lib on the host.
//
// This is the bridge between the sandbox and the host replayer:
//   1. `runApp` (the one door, run-app.ts) evaluates the template bundle
//      (which set `globalThis.renderTemplate`) and calls
//      `renderTemplate(data, __ctx)` inside the isolated realm on an empty
//      bridge, in process on QuickJS — NO host code runs the template.
//   2. The template returns a JSON `DrawCommand[]`, marshaled back to the host.
//   3. `replayDrawCommands` zod-validates + bounds-checks the list and renders
//      the PDF. A non-array / garbage return fails closed at the schema gate.

import { runLimits } from "~/modules/apps/run-limits"
import type { SandboxPool } from "~/modules/apps/sandbox/pool"
import { runApp } from "~/modules/apps/sandbox/run-app"
import { type ReplayDrawCommandsOptions, replayDrawCommands } from "./replay"

export interface RunTemplateToPdfArgs {
  /** The org and the app the template belongs to (the run's record). */
  orgId: string
  appName: string
  /** Sandbox-executable bundle text that sets `globalThis.renderTemplate`. */
  bundleSource: string
  /** Caller-supplied template input (crosses the JSON sandbox bridge). */
  data: unknown
  /**
   * Sandbox pool to run in. Defaults to the process-global pool
   * (`getSandboxPool()`). Bare unit tests must pass an explicit pool — the
   * global throws if `initSandboxPool()` never ran.
   */
  pool?: SandboxPool
  /** Sandbox execution deadline. Mirrors the pool's 30s render deadline. */
  timeoutMs?: number
  /** Forwarded to `replayDrawCommands` — resolves `embedImage` file ids. */
  replay?: ReplayDrawCommandsOptions
}

export async function runTemplateToPdf(args: RunTemplateToPdfArgs): Promise<Uint8Array> {
  const { bundleSource, data } = args
  const commands = await runApp({
    trusted: false,
    appName: args.appName,
    orgId: args.orgId,
    // The template's own source, not an installed Worker module.
    installed: null,
    bundleSource,
    exportName: "renderTemplate",
    entry: "pdf-template:renderTemplate",
    params: data,
    bridge: {},
    timeoutMs: args.timeoutMs ?? runLimits("pdf-template").wallMs,
    holdsTx: false,
    quickjs: { inProcess: true, ...(args.pool ? { inProcessPool: args.pool } : {}) },
  })
  // `replayDrawCommands` zod-validates, so a non-array / garbage return fails
  // closed with `invalid_commands` rather than producing a corrupt PDF.
  return await replayDrawCommands(commands, args.replay)
}

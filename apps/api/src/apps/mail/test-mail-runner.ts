// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Test helper: runs a mail handler the way `runApp` does for a core app
// (modules/apps/core/run-core.ts): the module's named export, called in this
// process with a typed host ctx over the test's bridge, its result as plain
// JSON data. `mailRunner(entries)` adds test-only entries beside the module's
// exports, for a test that drives an internal step (`processMessages`) as one
// run. Test-only: nothing in the app imports this file.

import { CORE_APP_MODULES, type CoreAppModule } from "~/modules/apps/core/registry"
import { runCoreHandler } from "~/modules/apps/core/run-core"

type Bridge = Record<string, any>

export interface MailRunOptions {
  exportName: string
  params?: unknown
  bridge: Bridge
  extraArgs?: unknown[]
  timeoutMs?: number
  signal?: AbortSignal
  approval?: unknown
}

/** A test-only entry: `(params, ctx)`, as a module export is called. */
export type MailTestEntry = (params: any, ctx: any) => unknown

export function mailRunner(
  entries: Record<string, MailTestEntry> = {},
): (opts: MailRunOptions) => Promise<unknown> {
  const mail = CORE_APP_MODULES.mail as CoreAppModule
  const module: CoreAppModule = {
    modulePath: mail.modulePath,
    load: async () => ({ ...(await mail.load()), ...entries }),
  }
  return (opts) =>
    runCoreHandler({
      module,
      appName: "mail",
      exportName: opts.exportName,
      params: opts.params,
      bridge: opts.bridge,
      holdsTx: false,
      ...(opts.extraArgs !== undefined ? { extraArgs: opts.extraArgs } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      ...(opts.approval !== undefined ? { approval: opts.approval } : {}),
    })
}

/** Runs a mail module export on the given bridge. */
export const runMailHandler = mailRunner()

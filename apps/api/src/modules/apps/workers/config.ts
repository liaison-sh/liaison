// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Whether this process runs sandboxed apps on the remote V8 isolate loader
// ("Workers") instead of the local QuickJS sandbox, and with what settings.
//
// Workers is selected when the loader variables (LIAISON_APP_LOADER_URL,
// _CELL_ID, _KEY) are set and valid: then every installed sandboxed app runs
// there, no allowlist. Each run names the Worker module its installed version
// recorded at install (the package's worker.js, install-service.ts); a version
// installed from a package without one runs on QuickJS (sandbox/run-app.ts).
// The loader fetches the module's bytes from this cell (bundle-route.ts) when
// it has no copy.
//
// Every role (all, api, worker) may use it: the run registry behind
// /api/app-bridge is in memory, but a run id names the process that dispatched
// it, and a bridge call landing on another process is forwarded there
// (bridge-forward.ts). So a `worker` process (jobs, crons, webhooks) runs apps
// on Workers too, while its isolates call back on the public API's address
// (LIAISON_APP_BRIDGE_BASE_URL, else BASE_URL). Unset: everything runs on
// QuickJS, and the bridge routes answer 404. Read on every call, so a test (or
// an operator reload) sees the configuration as it is now.

import { env } from "~/lib/env"
import { rootLogger } from "~/lib/logger"

const log = rootLogger.child({ module: "apps-workers-config" })

export interface WorkersConfig {
  /** The loader's base URL; runs are posted to `<loaderUrl>/run`. */
  loaderUrl: string
  cellId: string
  /** The HMAC key the loader knows this cell by. Never logged. */
  loaderKey: string
  /** The origin + prefix the isolates call back on, without a trailing slash. */
  bridgeBaseUrl: string
}

export type WorkersSelection =
  | { kind: "workers"; config: WorkersConfig }
  /** Nothing set: the default, silent. */
  | { kind: "unset" }
  /** Something set but not usable: QuickJS, and the reason is worth a warning. */
  | { kind: "invalid"; reason: string }

const blank = (v: string | undefined) => v === undefined || v.trim() === ""

/** The selection as configured right now. */
export function readWorkersSelection(): WorkersSelection {
  const loader = [
    ["LIAISON_APP_LOADER_URL", env.LIAISON_APP_LOADER_URL],
    ["LIAISON_APP_LOADER_CELL_ID", env.LIAISON_APP_LOADER_CELL_ID],
    ["LIAISON_APP_LOADER_KEY", env.LIAISON_APP_LOADER_KEY],
  ] as const
  if (!loader.some(([, v]) => !blank(v))) return { kind: "unset" }
  const missing = loader.filter(([, v]) => blank(v)).map(([n]) => n)
  if (missing.length > 0) return { kind: "invalid", reason: `missing ${missing.join(", ")}` }

  return {
    kind: "workers",
    config: {
      loaderUrl: (env.LIAISON_APP_LOADER_URL ?? "").replace(/\/+$/, ""),
      cellId: (env.LIAISON_APP_LOADER_CELL_ID ?? "").trim(),
      loaderKey: env.LIAISON_APP_LOADER_KEY ?? "",
      bridgeBaseUrl: (env.LIAISON_APP_BRIDGE_BASE_URL ?? env.BASE_URL).replace(/\/+$/, ""),
    },
  }
}

/** The Workers configuration, or null when this process runs everything on QuickJS. */
export function readWorkersConfig(): WorkersConfig | null {
  const sel = readWorkersSelection()
  return sel.kind === "workers" ? sel.config : null
}

export function workersConfigured(): boolean {
  return readWorkersConfig() !== null
}

/** `<bridgeBaseUrl>/api/app-bridge/<runId>`: where a run's isolate calls back. */
export function bridgeUrlFor(config: WorkersConfig, runId: string): string {
  return `${config.bridgeBaseUrl}/api/app-bridge/${encodeURIComponent(runId)}`
}

let bootWarned = false

/**
 * One warning per process when the Workers variables are set but cannot be
 * used (every app then runs on QuickJS). Silent when nothing is set.
 */
export function warnWorkersSelectionOnce(): WorkersSelection {
  const sel = readWorkersSelection()
  if (sel.kind === "invalid" && !bootWarned) {
    bootWarned = true
    log.warn({ reason: sel.reason }, "Workers app executor not used; apps run on QuickJS")
  }
  return sel
}

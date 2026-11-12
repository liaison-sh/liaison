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
// (LIAISON_APP_BRIDGE_BASE_URL, else BASE_URL). The instance's own sandbox
// service (workerd, readSandboxConfig) takes the loader's fallbacks, and every
// sandboxed run when no loader is configured (a self-hosted instance). Neither
// set: everything runs on QuickJS, and the bridge routes answer 404. Read on
// every call, so a test (or an operator reload) sees the configuration as it
// is now.

import { randomBytes } from "node:crypto"
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

/**
 * The per-instance runtime switch of this release: `LIAISON_APP_RUNTIME=quickjs`
 * runs every app on the local QuickJS sandbox again, whatever else is
 * configured (the way back while an instance moves to the sandbox service; it
 * goes away with QuickJS).
 */
export function quickjsForced(): boolean {
  return env.LIAISON_APP_RUNTIME === "quickjs"
}

/** The cell id runs carry to the sandbox service when no loader names one. */
const SANDBOX_CELL_ID = "sandbox"

/**
 * The key a self-hosted instance signs its sandbox service requests with: the
 * service holds no key and checks none (it is reachable from the app only, and
 * a run can do nothing without its own run token), so a key per process is
 * enough and is never stored anywhere.
 */
const sandboxProcessKey = randomBytes(32).toString("hex")

/**
 * This instance's own sandbox service (workerd, packages/sandbox-supervisor),
 * set by one value, LIAISON_SANDBOX_URL: its base URL (runs are posted to
 * `<url>/run`, module bytes pushed to `<url>/modules/<sha256>`). With the
 * loader configured it is where the loader's fallbacks go and it shares the
 * loader's cell id and key; without one it runs every sandboxed app. Its runs
 * call back on LIAISON_SANDBOX_BRIDGE_URL, the app's bridge-only listener
 * (`LIAISON_APP_BRIDGE_PORT`), else on the loader's bridge address. Null when
 * unset.
 */
export function readSandboxConfig(
  primary: WorkersConfig | null = readWorkersConfig(),
): WorkersConfig | null {
  const url = env.LIAISON_SANDBOX_URL
  if (blank(url)) return null
  const bridgeBaseUrl =
    env.LIAISON_SANDBOX_BRIDGE_URL ??
    primary?.bridgeBaseUrl ??
    env.LIAISON_APP_BRIDGE_BASE_URL ??
    env.BASE_URL
  return {
    loaderUrl: (url ?? "").replace(/\/+$/, ""),
    cellId: primary?.cellId ?? SANDBOX_CELL_ID,
    loaderKey: primary?.loaderKey ?? sandboxProcessKey,
    bridgeBaseUrl: bridgeBaseUrl.replace(/\/+$/, ""),
  }
}

/**
 * Where a run meant for the loader goes when the loader cannot take it (its
 * breaker open, an app-level fallback, a loader fault before any bridge call;
 * fallback.ts): the instance's sandbox service when it is configured
 * (readSandboxConfig), else the local QuickJS sandbox.
 */
export type FallbackTarget = { kind: "quickjs" } | { kind: "workerd"; config: WorkersConfig }

export function readFallbackTarget(primary: WorkersConfig): FallbackTarget {
  const config = readSandboxConfig(primary)
  return config ? { kind: "workerd", config } : { kind: "quickjs" }
}

/**
 * Whether the bridge routes answer: a remote executor (the loader or the
 * sandbox service) may run this process's runs.
 */
export function appBridgeEnabled(): boolean {
  return workersConfigured() || readSandboxConfig(null) !== null
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

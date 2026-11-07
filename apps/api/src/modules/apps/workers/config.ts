// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Whether this process runs listed apps on the remote V8 isolate loader
// ("Workers") instead of the local QuickJS sandbox, and with what settings.
//
// Workers is selected only when the loader variables (LIAISON_APP_LOADER_URL,
// _CELL_ID, _KEY) are set and valid, at least one way of choosing apps is set
// (LIAISON_WORKERS_APPS with LIAISON_WORKERS_BUNDLES for listed apps,
// LIAISON_WORKERS_CUSTOM_APPS=1 for every custom app of the cell), AND the
// process role is `all`: the run registry behind /api/app-bridge is in memory,
// so the process that dispatches a run must be the one that answers its bridge
// calls. Anything else is QuickJS, and the bridge routes answer 404. Read on
// every call, so a test (or an operator reload) sees the configuration as it
// is now.
//
// Listed apps take their Worker module's sha from the static
// LIAISON_WORKERS_BUNDLES map. Custom apps (LIAISON_WORKERS_CUSTOM_APPS=1) take
// it from their installed row, where the app builder's publish recorded it
// (0278, sandbox/run-app.ts); the loader fetches the bytes from this cell
// (bundle-route.ts) when it has no copy.

import { env } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import { currentRole } from "~/lib/process-role"
import { isCustomAppName } from "~/modules/apps/custom-app-name"

const log = rootLogger.child({ module: "apps-workers-config" })

export interface WorkersConfig {
  /** The apps that run on Workers when their installed version has a bundle. */
  apps: ReadonlySet<string>
  /**
   * Every org's custom app of this cell runs on Workers when its installed
   * version carries a Worker module (LIAISON_WORKERS_CUSTOM_APPS=1).
   */
  customApps: boolean
  /** The loader's base URL; runs are posted to `<loaderUrl>/run`. */
  loaderUrl: string
  cellId: string
  /** The HMAC key the loader knows this cell by. Never logged. */
  loaderKey: string
  /** The origin + prefix the isolates call back on, without a trailing slash. */
  bridgeBaseUrl: string
  /** `<app>@<version>` -> sha256 (hex) of the bundle the loader runs (listed apps). */
  bundles: ReadonlyMap<string, string>
}

export type WorkersSelection =
  | { kind: "workers"; config: WorkersConfig }
  /** Nothing set: the default, silent. */
  | { kind: "unset" }
  /** Something set but not usable: QuickJS, and the reason is worth a warning. */
  | { kind: "invalid"; reason: string }

const SHA256_HEX = /^[0-9a-f]{64}$/

function parseBundles(raw: string): Map<string, string> | string {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return "LIAISON_WORKERS_BUNDLES is not valid JSON"
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return 'LIAISON_WORKERS_BUNDLES must be a JSON object {"<app>@<version>":"<sha256>"}'
  }
  const out = new Map<string, string>()
  for (const [key, value] of Object.entries(parsed)) {
    const at = key.lastIndexOf("@")
    if (at <= 0 || at === key.length - 1) {
      return `LIAISON_WORKERS_BUNDLES key "${key}" is not "<app>@<version>"`
    }
    if (typeof value !== "string" || !SHA256_HEX.test(value)) {
      return `LIAISON_WORKERS_BUNDLES["${key}"] is not a lowercase hex sha256`
    }
    out.set(key, value)
  }
  return out
}

const blank = (v: string | undefined) => v === undefined || v.trim() === ""

/** LIAISON_WORKERS_CUSTOM_APPS as a switch: "1"/"true" on, unset/"0"/"false" off. */
function parseCustomApps(raw: string | undefined): boolean | string {
  if (blank(raw)) return false
  const v = (raw ?? "").trim().toLowerCase()
  if (v === "1" || v === "true") return true
  if (v === "0" || v === "false") return false
  return 'LIAISON_WORKERS_CUSTOM_APPS must be "1" or "0"'
}

/** The selection as configured right now (env + role). */
export function readWorkersSelection(): WorkersSelection {
  const customApps = parseCustomApps(env.LIAISON_WORKERS_CUSTOM_APPS)
  const loader = [
    ["LIAISON_APP_LOADER_URL", env.LIAISON_APP_LOADER_URL],
    ["LIAISON_APP_LOADER_CELL_ID", env.LIAISON_APP_LOADER_CELL_ID],
    ["LIAISON_APP_LOADER_KEY", env.LIAISON_APP_LOADER_KEY],
  ] as const
  const listed = [
    ["LIAISON_WORKERS_APPS", env.LIAISON_WORKERS_APPS],
    ["LIAISON_WORKERS_BUNDLES", env.LIAISON_WORKERS_BUNDLES],
  ] as const
  // With custom apps on, the listed-app pair is optional (either, both or none).
  const required = customApps === true ? loader : [...listed, ...loader]
  const all = [...listed, ...loader]
  const anySet = all.some(([, v]) => !blank(v)) || customApps !== false
  if (!anySet) return { kind: "unset" }
  if (typeof customApps === "string") return { kind: "invalid", reason: customApps }
  const missing = required.filter(([, v]) => blank(v)).map(([n]) => n)
  if (missing.length > 0) return { kind: "invalid", reason: `missing ${missing.join(", ")}` }

  const role = currentRole()
  if (role !== "all") {
    return { kind: "invalid", reason: `LIAISON_ROLE is "${role}"; Workers needs "all"` }
  }

  const apps = new Set(
    (env.LIAISON_WORKERS_APPS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  )
  if (apps.size === 0 && !customApps) {
    return { kind: "invalid", reason: "LIAISON_WORKERS_APPS lists no app" }
  }

  const bundles = blank(env.LIAISON_WORKERS_BUNDLES)
    ? new Map<string, string>()
    : parseBundles(env.LIAISON_WORKERS_BUNDLES ?? "")
  if (typeof bundles === "string") return { kind: "invalid", reason: bundles }

  const bridgeBaseUrl = (env.LIAISON_APP_BRIDGE_BASE_URL ?? env.BASE_URL).replace(/\/+$/, "")

  return {
    kind: "workers",
    config: {
      apps,
      customApps,
      loaderUrl: (env.LIAISON_APP_LOADER_URL ?? "").replace(/\/+$/, ""),
      cellId: (env.LIAISON_APP_LOADER_CELL_ID ?? "").trim(),
      loaderKey: env.LIAISON_APP_LOADER_KEY ?? "",
      bridgeBaseUrl,
      bundles,
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

/** The bundle sha256 for an app version on Workers, or undefined (-> QuickJS). */
export function workersBundleSha(
  config: WorkersConfig,
  appName: string,
  version: string,
): string | undefined {
  if (!config.apps.has(appName)) return undefined
  return config.bundles.get(`${appName}@${version}`)
}

/** Whether an app's runs are chosen for Workers by name: listed, or a custom app with the switch on. */
export function workersSelectsApp(config: WorkersConfig, appName: string): boolean {
  return config.apps.has(appName) || (config.customApps && isCustomAppName(appName))
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

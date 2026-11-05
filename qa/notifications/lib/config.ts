// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Matrix runner configuration: flags win over environment, environment over
// defaults. Credentials only ever come from the environment (never a flag,
// never a default), so they stay out of shell history and out of the repo.

import { homedir } from "node:os"
import { join, resolve } from "node:path"
import type { McpCredentialSource } from "./api"
import { CONTROLLERS, type Controller } from "./types"

export interface Credentials {
  email: string
  password: string
}

export interface Config {
  baseUrl: string
  /** Where Chrome opens the web app (a dev server may differ from the API). */
  webUrl: string
  sender: Credentials | null
  recipient: Credentials | null
  /** A third user of the same org with no registered device (M3 no-device). */
  nodevice: Credentials | null
  /** MCP connection of the recipient: notify_user runs as them. */
  recipientMcp: McpCredentialSource | null
  /** MCP connection of the sender: the gated tool call (approvals). */
  senderMcp: McpCredentialSource | null
  approvalTool: string | null
  approvalArgs: Record<string, unknown>
  surfaces: Controller[]
  runs: number
  reportDir: string
  only: string[]
  dryRun: boolean
  awaitHuman: boolean
  humanTimeoutMs: number
  /** Pin receipts to the runner's own devices (stale devices ignored). */
  testflightDeviceId: string | null
  ios: {
    simulator: string
    bundleId: string
    appPath: string | null
    backgroundApp: string
    /** A shell command that taps "Allow" on the notification prompt. */
    allowCmd: string | null
    /** The build honours SIMCTL_CHILD_LIAISON_DEBUG_OPEN_ROUTE (thread on screen). */
    openRouteHook: boolean
  }
  desktop: {
    appPath: string | null
    bundleId: string
    driverDir: string
  }
  web: {
    profileDir: string
    mode: "auto" | "playwright" | "cdp"
    chromePath: string
    cdpPort: number
  }
}

export class ConfigError extends Error {}

const DEMO_URL = "https://demo.liaison.sh"

function flagMap(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue
    const eq = arg.indexOf("=")
    if (eq === -1) out.set(arg.slice(2), "true")
    else out.set(arg.slice(2, eq), arg.slice(eq + 1))
  }
  return out
}

/** `<prefix>_MCP_REFRESH_TOKEN` (minted as needed) wins over a static `<prefix>_MCP_TOKEN`. */
function mcpSource(
  env: Record<string, string | undefined>,
  prefix: string,
): McpCredentialSource | null {
  const refreshToken = env[`${prefix}_MCP_REFRESH_TOKEN`]?.trim()
  if (refreshToken) return { refreshToken }
  const accessToken = env[`${prefix}_MCP_TOKEN`]?.trim()
  return accessToken ? { accessToken } : null
}

function creds(env: Record<string, string | undefined>, prefix: string): Credentials | null {
  const email = env[`${prefix}_EMAIL`]?.trim()
  const password = env[`${prefix}_PASSWORD`]
  return email && password ? { email, password } : null
}

export function parseSurfaces(raw: string | undefined): Controller[] {
  if (!raw || raw === "all") return [...CONTROLLERS]
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  for (const s of list) {
    if (!(CONTROLLERS as readonly string[]).includes(s)) {
      throw new ConfigError(`Unknown surface "${s}" (expected ${CONTROLLERS.join(", ")})`)
    }
  }
  return [...new Set(list)] as Controller[]
}

const KNOWN_FLAGS = new Set([
  "base-url",
  "web-url",
  "surfaces",
  "runs",
  "report-dir",
  "only",
  "dry-run",
  "await-human",
  "human-timeout",
  "help",
])

export function parseConfig(argv: string[], env: Record<string, string | undefined>): Config {
  const f = flagMap(argv)
  for (const k of f.keys()) {
    if (!KNOWN_FLAGS.has(k)) throw new ConfigError(`Unknown flag --${k}`)
  }
  const baseUrl = (f.get("base-url") ?? env.MATRIX_BASE_URL ?? DEMO_URL).replace(/\/+$/, "")
  const runs = Number(f.get("runs") ?? env.MATRIX_RUNS ?? "2")
  if (!Number.isInteger(runs) || runs < 1)
    throw new ConfigError("--runs must be a positive integer")
  const humanTimeout = Number(f.get("human-timeout") ?? "600")
  let approvalArgs: Record<string, unknown> = {}
  if (env.MATRIX_APPROVAL_ARGS) {
    try {
      approvalArgs = JSON.parse(env.MATRIX_APPROVAL_ARGS) as Record<string, unknown>
    } catch {
      throw new ConfigError("MATRIX_APPROVAL_ARGS is not JSON")
    }
  }
  const mode = (env.MATRIX_CHROME_MODE ?? "auto") as Config["web"]["mode"]
  if (!["auto", "playwright", "cdp"].includes(mode)) {
    throw new ConfigError("MATRIX_CHROME_MODE must be auto, playwright or cdp")
  }
  const home = homedir()
  return {
    baseUrl,
    webUrl: (f.get("web-url") ?? env.MATRIX_WEB_URL ?? baseUrl).replace(/\/+$/, ""),
    sender: creds(env, "MATRIX_SENDER"),
    recipient: creds(env, "MATRIX_RECIPIENT"),
    nodevice: creds(env, "MATRIX_NODEVICE"),
    recipientMcp: mcpSource(env, "MATRIX_RECIPIENT"),
    senderMcp: mcpSource(env, "MATRIX_SENDER"),
    approvalTool: env.MATRIX_APPROVAL_TOOL?.trim() || null,
    approvalArgs,
    surfaces: parseSurfaces(f.get("surfaces") ?? env.MATRIX_SURFACES),
    runs,
    reportDir: resolve(
      f.get("report-dir") ?? env.MATRIX_REPORT_DIR ?? join(import.meta.dir, "..", "reports"),
    ),
    only: (f.get("only") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    dryRun: f.get("dry-run") === "true",
    awaitHuman: f.get("await-human") === "true",
    humanTimeoutMs: humanTimeout * 1000,
    testflightDeviceId: env.MATRIX_TESTFLIGHT_DEVICE_ID?.trim() || null,
    ios: {
      simulator: env.MATRIX_IOS_SIM ?? "booted",
      bundleId: env.MATRIX_IOS_BUNDLE ?? "sh.liaison.mobile",
      appPath: env.MATRIX_IOS_APP ?? null,
      backgroundApp: env.MATRIX_IOS_BACKGROUND_APP ?? "com.apple.Preferences",
      allowCmd: env.MATRIX_IOS_ALLOW_CMD ?? null,
      openRouteHook: env.MATRIX_IOS_OPEN_ROUTE === "1",
    },
    desktop: {
      appPath: env.MATRIX_DESKTOP_APP ?? null,
      bundleId: env.MATRIX_DESKTOP_BUNDLE ?? "sh.liaison.desktop",
      driverDir: env.MATRIX_DESKTOP_DRIVER_DIR ?? join(home, ".liaison-matrix", "driver"),
    },
    web: {
      profileDir: env.MATRIX_CHROME_PROFILE ?? join(home, ".liaison-matrix", "chrome-profile"),
      mode,
      chromePath:
        env.MATRIX_CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      cdpPort: Number(env.MATRIX_CHROME_CDP_PORT ?? "9333"),
    },
  }
}

/** `--only=M1,M2-ios-*`: a case id, a group, or an id prefix ending in `*`. */
export function selects(only: string[], id: string, group: string): boolean {
  if (only.length === 0) return true
  return only.some((o) =>
    o.endsWith("*") ? id.startsWith(o.slice(0, -1)) : o === id || o === group,
  )
}

/** What a live run cannot start without (dry-run needs none of it). */
export function missingForLive(c: Config): string[] {
  const out: string[] = []
  if (!c.sender) out.push("MATRIX_SENDER_EMAIL / MATRIX_SENDER_PASSWORD")
  if (!c.recipient) out.push("MATRIX_RECIPIENT_EMAIL / MATRIX_RECIPIENT_PASSWORD")
  if (c.surfaces.includes("desktop") && !c.desktop.appPath) out.push("MATRIX_DESKTOP_APP")
  return out
}

export const USAGE = `bun qa/notifications/matrix.ts [flags]

  --base-url=URL        API origin (default ${DEMO_URL}; env MATRIX_BASE_URL)
  --web-url=URL         where Chrome opens the app (default the base URL)
  --surfaces=LIST       ios,desktop,web (default all)
  --runs=N              consecutive full runs (default 2)
  --only=LIST           case ids, groups (M1..M5, A6, A13, H, TF) or id prefixes with *
  --report-dir=DIR      reports land here (env MATRIX_REPORT_DIR)
  --dry-run             print the case plan, touch nothing
  --await-human         run the human cells (H-1, TestFlight): wait, then poll receipts
  --human-timeout=SEC   how long to wait for the person (default 600)

Credentials (env only): MATRIX_SENDER_EMAIL/PASSWORD, MATRIX_RECIPIENT_EMAIL/PASSWORD,
MATRIX_NODEVICE_EMAIL/PASSWORD. See qa/notifications/README.md for the rest.`

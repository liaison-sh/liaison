// SPDX-License-Identifier: FSL-1.1-ALv2
// Filesystem discovery of Liaison apps.
//
// Two roots are walked:
//   - In-tree apps:  apps/api/src/apps/<name>/        (manifest + manifest-descriptor.ts)
//   - Installed apps: /var/lib/liaison/apps/<name>/<version>/  (manifest + bundle.js)
//
// This replaces the hardcoded `getDefaultApps()` list in init.ts so that
// scaffolding a new in-tree app — or installing a `.liaisonapp` at runtime —
// requires no edits to kernel code.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { delimiter, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const IN_TREE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../apps")

/**
 * Test-only apps (the app-contract fixture, the bridge pair) live in
 * apps/api/test-support/apps, which the production image does not
 * carry. Walked after the in-tree root when present, and still subject to the
 * TEST_ONLY_APPS gate below.
 */
const TEST_SUPPORT_APPS_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../test-support/apps",
)

/**
 * Extra source-app roots for development and test harnesses that keep their
 * fixture apps outside this repository: `LIAISON_DEV_APP_ROOTS`, a list joined
 * with the platform path delimiter. Read only when NODE_ENV is test or
 * development, and every app found there is still subject to the
 * TEST_ONLY_APPS gate below.
 */
export function devAppRoots(): string[] {
  const env = (process.env.NODE_ENV ?? "production").toLowerCase()
  if (!TEST_ENVS.has(env)) return []
  return (process.env.LIAISON_DEV_APP_ROOTS ?? "")
    .split(delimiter)
    .map((r) => r.trim())
    .filter((r) => r.length > 0)
}

/** Default runtime install root for `.liaisonapp` packages. */
export const DEFAULT_INSTALL_ROOT = "/var/lib/liaison/apps"

/**
 * Resolved on every discovery call (not captured at module-import time) so
 * tests and operators can swap `LIAISON_APPS_DIR` after the module loads.
 */
export function getInstallRoot(): string {
  return process.env.LIAISON_APPS_DIR ?? DEFAULT_INSTALL_ROOT
}

export interface DiscoveredApp {
  name: string
  version: string
  manifestPath: string
  /** Present for in-tree apps only — the TS descriptor module path. */
  descriptorPath?: string
  /** Present for installed apps only — the built handler bundle path. */
  bundlePath?: string
  /** Present for installed apps only — the UI bundle path, when ui.js was packaged. */
  uiBundlePath?: string
  source: "in-tree" | "installed"
}

// Apps whose discovery is gated by NODE_ENV — test scaffolding that must never
// load in production. Kept as an explicit set (rather than a name-prefix
// convention) so renames stay obvious and greppable. `test` (the app-contract
// fixture) and `example` (the plugin-author sample) are dev/test scaffolding
// too: on a production instance they registered real schemas (app_test,
// app_example) and surfaced in the Apps admin UI.
export const TEST_ONLY_APPS = new Set([
  "test-bridge-a",
  "test-bridge-b",
  "chaos-debug",
  "test",
  "example",
])

// Apps requiring an additional per-app run-flag on top of being in a test/dev
// env. chaos-debug bundles `agent.run` (credit-spending) + `realtime.publish`,
// so an inert "TEST_ONLY" flag is not enough — it loads only when a chaos
// session is intentionally active. Same `CHAOS_DEBUG` env var that already
// gates the host-side injector mount in app.ts.
const REQUIRED_ENV_FLAGS: Record<string, () => boolean> = {
  "chaos-debug": () => process.env.CHAOS_DEBUG === "1",
}

const TEST_ENVS = new Set(["test", "development"])

function shouldSkipForEnv(name: string): boolean {
  if (!TEST_ONLY_APPS.has(name)) return false

  // Default-deny: only load TEST_ONLY apps when NODE_ENV is one of the known
  // safe values. Unset, typo'd, "staging", "prod", "PRODUCTION", or anything
  // else → skip. Stricter than the previous `=== "production"` test, which
  // permitted any other NODE_ENV value (including unset) to load TEST_ONLY
  // apps. Security review 2026-05-23, Vuln 3.
  const env = (process.env.NODE_ENV ?? "production").toLowerCase()
  if (!TEST_ENVS.has(env)) return true

  const flagCheck = REQUIRED_ENV_FLAGS[name]
  if (flagCheck && !flagCheck()) return true

  return false
}

/**
 * Discover in-tree apps: any directory under `apps/api/src/apps/<name>/` (or
 * `apps/api/test-support/apps/<name>/` when the checkout carries it, or a
 * `LIAISON_DEV_APP_ROOTS` entry) that
 * contains both `app.manifest.json` and `manifest-descriptor.ts`.
 *
 * Throws if a directory name does not match its manifest's `name` field —
 * a mismatch produces inconsistent registry state and must fail loud.
 */
export async function discoverInTreeApps(opts?: {
  rootOverride?: string
}): Promise<DiscoveredApp[]> {
  const roots = opts?.rootOverride
    ? [opts.rootOverride]
    : [IN_TREE_ROOT, TEST_SUPPORT_APPS_ROOT, ...devAppRoots()]
  const out: DiscoveredApp[] = []
  for (const root of roots) {
    if (!existsSync(root)) continue
    for (const app of discoverAppsUnder(root)) {
      if (out.some((existing) => existing.name === app.name)) {
        throw new Error(`App '${app.name}' is defined under more than one in-tree root`)
      }
      out.push(app)
    }
  }
  return out
}

function discoverAppsUnder(root: string): DiscoveredApp[] {
  const out: DiscoveredApp[] = []
  for (const name of readdirSync(root)) {
    const dir = join(root, name)
    if (!statSync(dir).isDirectory()) continue
    if (shouldSkipForEnv(name)) continue
    const manifestPath = join(dir, "app.manifest.json")
    const descriptorPath = join(dir, "manifest-descriptor.ts")
    if (!existsSync(manifestPath) || !existsSync(descriptorPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
    if (manifest.name && manifest.name !== name) {
      throw new Error(
        `App dir '${name}' has manifest.name '${manifest.name}' — dir name must match manifest.name`,
      )
    }
    out.push({
      name,
      version: manifest.version ?? "0.0.0",
      manifestPath,
      descriptorPath,
      source: "in-tree",
    })
  }
  return out
}

/**
 * Discover installed apps: versioned directories under the install root,
 * `<root>/<name>/<version>/` containing both `app.manifest.json` and `bundle.js`.
 *
 * Throws if a directory name does not match its manifest's `name` field.
 */
export async function discoverInstalledApps(opts?: {
  rootOverride?: string
}): Promise<DiscoveredApp[]> {
  const root = opts?.rootOverride ?? getInstallRoot()
  if (!existsSync(root)) return []
  const out: DiscoveredApp[] = []
  for (const name of readdirSync(root)) {
    const appDir = join(root, name)
    if (!statSync(appDir).isDirectory()) continue
    for (const version of readdirSync(appDir)) {
      // An unpack in progress (`.tmp-<uuid>`, modules/apps/version-dir.ts) is no version.
      if (version.startsWith(".")) continue
      const verDir = join(appDir, version)
      if (!statSync(verDir).isDirectory()) continue
      const manifestPath = join(verDir, "app.manifest.json")
      const bundlePath = join(verDir, "bundle.js")
      if (!existsSync(manifestPath) || !existsSync(bundlePath)) continue
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
      if (manifest.name && manifest.name !== name) {
        throw new Error(
          `Installed app dir '${name}' has manifest.name '${manifest.name}' — dir name must match manifest.name`,
        )
      }
      const uiBundlePath = join(verDir, "ui.js")
      const hasUi = existsSync(uiBundlePath)
      out.push({
        name,
        version,
        manifestPath,
        bundlePath,
        ...(hasUi ? { uiBundlePath } : {}),
        source: "installed",
      })
    }
  }
  return out
}

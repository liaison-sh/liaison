// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The apps the contract covers: every bundled app (bundled-apps/*) and the
// in-tree sandboxed apps, with the bridge surface a production run of each
// sees (the RPC bridge's methods, plus an in-tree app's own extension
// methods), and their recorded egress fixtures (fixtures/<app>/*.json).

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { gitlabAppManifest } from "~/apps/gitlab/manifest-descriptor"
import { googleDriveAppManifest } from "~/apps/google-drive/manifest-descriptor"
import type { RlsClient } from "~/db"
import type { BridgeExtensionFactory } from "~/modules/apps/sandbox/bridge-extensions"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { buildVerifyBridge } from "~/modules/webhooks/verify-bridge"
import { contractEntries } from "./entries"
import {
  type AppUnderContract,
  type BridgeSurface,
  bundledAppScripts,
  inTreeAppScript,
} from "./harness"
import { CONTRACT_ORG_ID, CONTRACT_USER_ID, type EgressFixture } from "./replay-bridge"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..", "..")
export const BUNDLED_APPS_DIR = join(REPO_ROOT, "bundled-apps")
const IN_TREE_APPS_DIR = join(REPO_ROOT, "apps", "api", "src", "apps")
const FIXTURES_DIR = join(import.meta.dir, "fixtures")

/** In-tree apps that run sandboxed, with their manifest descriptors. */
const IN_TREE: Record<string, { _bundlePath: string; _bridgeExtension?: BridgeExtensionFactory }> =
  {
    gitlab: gitlabAppManifest,
    "google-drive": googleDriveAppManifest,
  }

/** Construction of a bridge never touches the database; any access throws. */
const poisonTx = new Proxy(
  {},
  {
    get(_t, prop) {
      if (typeof prop === "symbol" || prop === "then") return undefined
      throw new Error(`bridge construction touched txDb.${String(prop)}`)
    },
  },
) as unknown as RlsClient

function kindOf(fn: unknown): "sync" | "async" {
  return (fn as { constructor?: { name?: string } })?.constructor?.name === "AsyncFunction"
    ? "async"
    : "sync"
}

/** The bridge methods a run of `app` gets, with their sync/async kind. */
export function bridgeSurfaceOf(app: string, extension?: BridgeExtensionFactory): BridgeSurface {
  const bridge = createRpcBridge(app, CONTRACT_USER_ID, CONTRACT_ORG_ID, poisonTx, { name: app })
  const surface = new Map<string, "sync" | "async">()
  for (const [name, fn] of Object.entries(bridge)) {
    if (typeof fn === "function") surface.set(name, kindOf(fn))
  }
  if (extension) {
    const ext = extension({
      appName: app,
      orgId: CONTRACT_ORG_ID,
      userId: CONTRACT_USER_ID,
      txDb: poisonTx,
      actorType: "user",
    })
    // Extension methods are dispatched async (BridgeExtensionMethod returns a promise).
    for (const name of Object.keys(ext)) surface.set(name, "async")
  }
  return [...surface.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
}

/** The methods a webhook verifier's bridge has (all async), as production builds it. */
export function verifySurface(): BridgeSurface {
  const bridge = buildVerifyBridge({ readConfig: async () => null, secretConfigKeys: [] })
  return Object.keys(bridge)
    .sort()
    .map((name) => [name, "async"] as const)
}

function fixturesOf(app: string): Record<string, EgressFixture> {
  const dir = join(FIXTURES_DIR, app)
  if (!existsSync(dir)) return {}
  const out: Record<string, EgressFixture> = {}
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue
    const fixture = JSON.parse(readFileSync(join(dir, name), "utf8")) as EgressFixture
    out[fixture.entry] = fixture
  }
  return out
}

/** Names of every app under contract, bundled first. */
export function appsUnderContract(): string[] {
  const bundled = readdirSync(BUNDLED_APPS_DIR, { withFileTypes: true })
    .filter(
      (d) => d.isDirectory() && existsSync(join(BUNDLED_APPS_DIR, d.name, "app.manifest.json")),
    )
    .map((d) => d.name)
    .sort()
  return [...bundled, ...Object.keys(IN_TREE).sort()]
}

/** One app, ready for the harness on the QuickJS executor. */
export async function loadAppUnderContract(app: string): Promise<AppUnderContract> {
  const inTree = IN_TREE[app]
  if (inTree) {
    const dir = join(IN_TREE_APPS_DIR, app)
    const manifest = JSON.parse(readFileSync(join(dir, "app.manifest.json"), "utf8"))
    return {
      app,
      dir,
      entries: contractEntries(manifest),
      source: await inTreeAppScript(inTree._bundlePath),
      surface: bridgeSurfaceOf(app, inTree._bridgeExtension),
      verifySurface: verifySurface(),
      fixtures: fixturesOf(app),
    }
  }
  const dir = join(BUNDLED_APPS_DIR, app)
  const manifest = JSON.parse(readFileSync(join(dir, "app.manifest.json"), "utf8"))
  const scripts = await bundledAppScripts(dir)
  return {
    app,
    dir,
    entries: contractEntries(manifest),
    source: scripts.source,
    templateSource: scripts.templateSource,
    surface: bridgeSurfaceOf(app),
    verifySurface: verifySurface(),
    fixtures: fixturesOf(app),
  }
}

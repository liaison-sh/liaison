// SPDX-License-Identifier: FSL-1.1-ALv2
//
// GET /api/app-bridge/bundles/:sha256 — the app loader fetches a custom app's
// Worker module from this cell when its own store has no object for the sha.
//
// The bytes are the ones an org's publish recorded on the installed row from
// the build its approval pinned (0278, modules/app-builder/publish.ts): never
// a draft's bytes, never a module before its publish installed it. Served only
// while LIAISON_WORKERS_CUSTOM_APPS is on (config.ts), for a sha some
// installed, not disabled custom app version names.
//
// The module holds the app's handlers only (no name, no org): two apps with
// the same code have one module and one sha, and either install serves it.
//
// Cell-wide on purpose: the loader holds one key per cell, not per org, so an
// installed custom app of ANY org on this cell is servable to it. The loader
// runs only what a signed /run from this cell names, under that run's org.
//
// Authentication: the loader's v2 signature, direction "loader->cell", method
// GET, this exact path, an empty body (sign.ts), with this cell's id and key
// (LIAISON_APP_LOADER_CELL_ID / _KEY). Unsigned, v1, another direction (a
// /run signature replayed here), another path or a stale timestamp: 401.
// Mounted before the user JWT chain, like the bridge route.
//
// Statuses: 404 not configured / malformed or unknown sha, 401 refused
// signature, 200 the module (`application/javascript`, re-hashed before it
// leaves).

import { Hono } from "hono"
import { rootLogger } from "~/lib/logger"
import { readInstalledWorkerModule } from "~/modules/apps/sandbox/run-app"
import { readWorkersConfig, type WorkersConfig } from "./config"
import {
  CELL_ID_HEADER,
  CELL_SIGNATURE_HEADER,
  CELL_SIGNATURE_VERSION_HEADER,
  CELL_TS_HEADER,
  verifyCellRequestV2,
} from "./sign"

const log = rootLogger.child({ module: "app-bridge-bundles" })

const SHA256_HEX = /^[0-9a-f]{64}$/

export interface AppBridgeBundleRouteDeps {
  config?: () => WorkersConfig | null
  lookup?: typeof readInstalledWorkerModule
  now?: () => number
}

export function createAppBridgeBundleRoutes(deps: AppBridgeBundleRouteDeps = {}) {
  const config = deps.config ?? readWorkersConfig
  const lookup = deps.lookup ?? readInstalledWorkerModule
  const now = deps.now ?? Date.now

  return new Hono().get("/bundles/:sha256", async (c) => {
    const cfg = config()
    if (!cfg?.customApps) return c.json({ error: "Not found", reason: "not_found" }, 404)

    const cellId = c.req.header(CELL_ID_HEADER)
    const verdict =
      cellId !== cfg.cellId
        ? ({ ok: false, reason: "unknown_cell" } as const)
        : verifyCellRequestV2({
            cellKey: cfg.loaderKey,
            direction: "loader->cell",
            method: c.req.method,
            path: c.req.path,
            ts: c.req.header(CELL_TS_HEADER),
            signature: c.req.header(CELL_SIGNATURE_HEADER),
            version: c.req.header(CELL_SIGNATURE_VERSION_HEADER),
            body: "",
            now: now(),
          })
    if (!verdict.ok) {
      log.warn({ reason: verdict.reason, path: c.req.path }, "App loader bundle request refused")
      return c.json({ error: "Signature rejected", reason: verdict.reason }, 401)
    }

    const sha = c.req.param("sha256")
    if (!SHA256_HEX.test(sha)) return c.json({ error: "Not found", reason: "not_found" }, 404)
    const found = await lookup(sha)
    if (!found) {
      log.warn({ sha256: sha }, "App loader asked for a Worker module no installed app names")
      return c.json({ error: "Not found", reason: "not_found" }, 404)
    }
    return c.body(found.bytes as Uint8Array<ArrayBuffer>, 200, {
      "content-type": "application/javascript",
      "cache-control": "no-store",
      "x-content-sha256": sha,
    })
  })
}

export const appBridgeBundleRoutes = createAppBridgeBundleRoutes()

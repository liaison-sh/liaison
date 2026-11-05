// SPDX-License-Identifier: FSL-1.1-ALv2
//
// db-gate entrypoint. Loads config + catalog, runs the startup probe
// (write-grant + dangerous-EXECUTE-grant check), refuses to start under
// DB_GATE_ALLOW_QUERY=true if the probe isn't clean, then serves.

import { loadCatalogFromFile } from "./catalog-loader"
import { assertCleanStartupOrThrow, loadConfig } from "./config"
import { GateDb } from "./gate-db"
import { createDbGateHandler } from "./server"

async function main(): Promise<void> {
  const config = loadConfig()
  const catalog = loadCatalogFromFile(config.catalogPath)
  const db = new GateDb(config.dsn)

  const probe = await db.probe()
  for (const warning of probe.warnings) {
    // biome-ignore lint/suspicious/noConsole: startup warning, by design
    console.warn(`[db-gate] startup probe warning: ${warning}`)
  }
  try {
    assertCleanStartupOrThrow(config, probe)
  } catch (err) {
    await db.close()
    throw new Error(`[db-gate] ${err instanceof Error ? err.message : String(err)}`)
  }

  const handler = createDbGateHandler({ config, catalog, db })
  Bun.serve({ port: config.port, fetch: handler })
  // biome-ignore lint/suspicious/noConsole: startup banner, by design
  console.log(`[db-gate] listening on :${config.port} (allowQuery=${config.allowQuery})`)
}

if (import.meta.main) {
  main().catch((err) => {
    // biome-ignore lint/suspicious/noConsole: fatal startup error, by design
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}

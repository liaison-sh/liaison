// SPDX-License-Identifier: FSL-1.1-ALv2
import type { Hono } from "hono"

export interface BuildTestAppOptions {
  controlPlaneUrl?: string
  controlPlaneApiKey?: string
  maintenanceFlagPath?: string
}

/**
 * Build a fresh test instance of the API app with the supplied env overrides.
 *
 * Implementation note: we mutate `process.env` for the named keys, then dynamic
 * import `~/app` with a cache-busting query string so the module re-runs and
 * re-reads `env`. Each call gets its own Hono instance. Caller is responsible
 * for not interleaving requests across instances within the same test.
 */
export async function buildTestApp(opts: BuildTestAppOptions = {}): Promise<Hono> {
  const previous: Record<string, string | undefined> = {}
  const assignments: Record<string, string | undefined> = {
    CONTROL_PLANE_URL: opts.controlPlaneUrl,
    CONTROL_PLANE_API_KEY: opts.controlPlaneApiKey,
    MAINTENANCE_FLAG_PATH: opts.maintenanceFlagPath,
  }
  for (const [k, v] of Object.entries(assignments)) {
    previous[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    // Bun's loader honors query strings as cache-busters for re-running side-effects.
    const cacheBuster = `?t=${Date.now()}-${Math.random()}`
    const mod = (await import(`~/app${cacheBuster}`)) as { app: Hono }
    return mod.app
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

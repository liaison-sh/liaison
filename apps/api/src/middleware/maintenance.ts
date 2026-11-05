// SPDX-License-Identifier: FSL-1.1-ALv2
import { existsSync, readFileSync } from "node:fs"
import { createMiddleware } from "hono/factory"
import type { AppEnv } from "~/app"
import { env } from "~/lib/env"
import { markOwnDependencyDown } from "~/lib/own-dependency-down"
import { isOrgUnderMaintenance } from "~/middleware/org-maintenance"
import { verifyAccessToken } from "~/modules/auth/jwt"
import { maintenancePage } from "~/modules/maintenance/page"

// Production paths are hardcoded (spec issue 3.8). Tests use env overrides via
// buildTestApp({ maintenanceFlagPath }).
const PROD_FLAG_PATH = "/var/lib/liaison/maintenance"
const PROD_VERSION_PATH = "/var/lib/liaison/maintenance-version"

// Re-check interval: read the filesystem at most once per this window.
// Short enough that operators do not wait long for the flag to take effect;
// long enough that a steady stream of requests does not spam the kernel with
// synchronous I/O on every call.
const RECHECK_INTERVAL_MS = 2_000

function flagPath(): string {
  return process.env.MAINTENANCE_FLAG_PATH || PROD_FLAG_PATH
}

function versionPath(): string {
  return process.env.MAINTENANCE_VERSION_PATH || PROD_VERSION_PATH
}

interface MaintenanceState {
  active: boolean
  targetVersion: string | undefined
  checkedAt: number
  // The flag path this state was read from. In production the path never
  // changes, but tests point MAINTENANCE_FLAG_PATH at different temp files; the
  // cache must be invalidated when the path changes so one test's "active"
  // state never bleeds into the next test's request (which targets a different,
  // non-existent flag path) within the RECHECK_INTERVAL_MS window.
  path: string
}

let cached: MaintenanceState = {
  active: false,
  targetVersion: undefined,
  checkedAt: 0,
  path: "",
}

function readMaintenanceState(): MaintenanceState {
  const now = Date.now()
  const path = flagPath()
  if (path === cached.path && now - cached.checkedAt < RECHECK_INTERVAL_MS) {
    return cached
  }
  let active = false
  let targetVersion: string | undefined
  try {
    active = existsSync(path)
    if (active) {
      const vp = versionPath()
      if (existsSync(vp)) {
        targetVersion = readFileSync(vp, "utf8").trim() || undefined
      }
    }
  } catch {
    // If fs throws (permission error, etc.) treat as inactive; don't block
    // traffic on a transient read failure.
    active = false
    targetVersion = undefined
  }
  cached = { active, targetVersion, checkedAt: now, path }
  return cached
}

/** Exposed for tests — forcibly reset the in-memory cache. */
export function _resetMaintenanceCache(): void {
  cached = { active: false, targetVersion: undefined, checkedAt: 0, path: "" }
}

/**
 * Best-effort org resolution for the per-org gate below. This middleware is
 * mounted at `app.use("*", ...)` BEFORE every route-scoped `authMiddleware`
 * call in app.ts, so `c.get("orgId")` is never set yet when this runs.
 * Verifying the bearer token here (the same way `authMiddleware` does)
 * resolves the org without waiting for a later middleware that may never
 * run for this path. Any failure (missing header, bad/expired token)
 * resolves to `undefined`: an unauthenticated or invalid request is left
 * for the real auth chain to accept or reject on its own terms, not for
 * this gate.
 */
async function resolveOrgIdForGate(
  c: Parameters<Parameters<typeof createMiddleware<AppEnv>>[0]>[0],
): Promise<string | undefined> {
  const header = c.req.header("Authorization")
  if (!header?.startsWith("Bearer ")) return undefined
  try {
    const payload = await verifyAccessToken(header.slice(7), env.JWT_SECRET)
    return payload.orgId
  } catch {
    return undefined
  }
}

export function maintenanceMiddleware() {
  return createMiddleware<AppEnv>(async (c, next) => {
    // /healthz must remain reachable so load balancers and the upgrade CLI can
    // probe liveness while the maintenance flag is set. /diag (C3) gets the same
    // exemption -- defense-in-depth on top of being mounted before this middleware in
    // app.ts -- so the monitoring watchdog still gets diagnostics during an upgrade.
    if (c.req.path === "/healthz" || c.req.path === "/diag") return next()
    // Per-org gate: armed by the migration script around an org's rows
    // (armOrgMaintenance/disarmOrgMaintenance in org-maintenance.ts). Resolved
    // here directly (rather than reading a later auth middleware's `c.get
    // ("orgId")`, which has not run yet at this mount point) so the gate
    // actually sees the requesting org instead of always reading `undefined`.
    const orgId = await resolveOrgIdForGate(c)
    if (orgId && isOrgUnderMaintenance(orgId)) {
      markOwnDependencyDown(c)
      return c.html(maintenancePage(undefined), 503, { "Retry-After": "30" })
    }
    const state = readMaintenanceState()
    if (!state.active) return next()
    markOwnDependencyDown(c)
    return c.html(maintenancePage(state.targetVersion), 503, { "Retry-After": "30" })
  })
}

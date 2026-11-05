// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The visitor TTL, enforced.
//
// `LIAISON_DEMO_VISITOR_TTL_HOURS` used to write an `expiresAt` into the marker
// that nothing on the box ever read: `isDemoOrgExpired` had no callers at all,
// so a visitor org lived forever and a public box accumulated them for ever.
// Two halves close that:
//
//   ENFORCE   an expired visitor org stops being usable. The check rides on
//             `authMiddleware` (app.ts composes the two ONLY when
//             LIAISON_DEMO_MODE is on, so a normal deployment does not gain a
//             middleware, a branch or a query), which is the one place every
//             authenticated route already passes through and the one place the
//             org id is known. The refusal is a 403 the visitor can read, not a
//             401, because the credential is fine and the workspace is over.
//
//   COLLECT   `listExpiredDemoOrgs` is the query a reaper needs and the only
//             thing it needs: the org ids that are past their expiry, oldest
//             first, with the slug and variant an operator would want in a log.
//             The reaper itself (a nightly job that deletes them) is a later
//             batch; this is what it reads. The RESERVED org is never returned:
//             its marker carries a null `expiresAt` on purpose and a reaper must
//             never take the workspace Apple's App Review signs into.
//
// Expiry is read from the marker, never from `created_at` plus an env value, so
// retuning the env does not retroactively kill workspaces already handed out.
import {
  DEMO_WORKSPACE_EXPIRED_CODE,
  type DemoVariant,
  demoMarker,
  isDemoOrgExpired,
} from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import type { Context, MiddlewareHandler, Next } from "hono"
import { HTTPException } from "hono/http-exception"
import type { AppEnv } from "~/app"
import { withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { rootLogger } from "~/lib/logger"
import { isDemoModeEnabled } from "~/modules/demo/demo-mode"
import { demoPoolStateOf, loadDemoOrg } from "~/modules/demo/demo-org"
import { serverT } from "~/modules/i18n/server-i18n"

const log = rootLogger.child({ module: "demo-expiry" })

/**
 * Refuse an authenticated request whose demo workspace has expired. Composed
 * onto `authMiddleware` by app.ts, and only under the demo gate.
 */
export function demoExpiryMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c: Context<AppEnv>, next: Next) => {
    const orgId = c.get("orgId")
    if (orgId) await assertDemoOrgActive(orgId)
    return next()
  }
}

/**
 * Is this org an EXPIRED demo visitor workspace right now? False when demo mode
 * is off (without a query), for a normal org and for the reserved org.
 *
 * This is the one question every credential path asks, not only the REST auth
 * middleware: the bearer middleware, token refresh and login (`createSession`),
 * the websocket ticket and re-check, and the MCP token resolve/refresh all call
 * it, so a token or session minted before expiry stops working on every route
 * the moment the workspace is over, not just on the routes behind `authMw`.
 */
export async function isDemoOrgExpiredNow(orgId: string): Promise<boolean> {
  if (!isDemoModeEnabled()) return false
  const { marker } = await loadDemoOrg(orgId)
  if (!marker) return false
  return isDemoOrgExpired({ settings: { demo: marker } })
}

/**
 * The refusal for an expired demo workspace: a 403 with a readable message and
 * the stable `demo_workspace_expired` code (error-handler.ts passes an
 * HTTPException's own code through), so the web app leaves the workspace for
 * the demo door instead of reading it as any other 403.
 */
export class DemoWorkspaceExpiredError extends HTTPException {
  readonly code = DEMO_WORKSPACE_EXPIRED_CODE
  constructor(message: string) {
    super(403, { message })
  }
}

/** 403 `demo_workspace_expired` when the org is an expired demo workspace. */
export async function assertDemoOrgActive(orgId: string): Promise<void> {
  if (!isDemoModeEnabled()) return
  const { marker, locale } = await loadDemoOrg(orgId)
  if (!marker) return
  if (!isDemoOrgExpired({ settings: { demo: marker } })) return
  log.info({ orgId, expiresAt: marker.expiresAt }, "refused an expired demo workspace")
  throw new DemoWorkspaceExpiredError(serverT(locale, "kernel.demo.workspaceExpired"))
}

/**
 * How many visitor workspaces exist right now (live or expired but not yet
 * collected). The signup ceilings read it; the reaper's backlog alert reads the
 * expired part. The warm pool's unclaimed orgs are not visitors yet: a claim
 * turns one into a visitor without adding a row, so they do not count.
 *
 * `total` counts real visitors only; `synthetic` counts the load harness's
 * workspaces (marker `synthetic: true`), which have their own cap, so a load
 * run never fills the visitors' room. `expired` counts both: the reaper
 * collects both.
 */
export async function countVisitorOrgs(now: Date = new Date()): Promise<{
  total: number
  synthetic: number
  expired: number
}> {
  if (!isDemoModeEnabled()) return { total: 0, synthetic: 0, expired: 0 }
  const k = drizzleSql.raw(schemaRef("kernel"))
  const rows = await withSystemDb("demo-count-visitors", async (tx) => {
    const result = await tx.execute(drizzleSql`
      SELECT settings->'demo' AS demo
      FROM ${k}.organizations
      WHERE settings->'demo'->>'variant' = 'visitor'
        AND settings->'demo'->'pool' IS NULL
    `)
    return Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
  })
  let expired = 0
  let synthetic = 0
  for (const raw of rows as Array<Record<string, unknown>>) {
    const demo = typeof raw.demo === "string" ? JSON.parse(raw.demo) : raw.demo
    if (isDemoOrgExpired({ settings: { demo } }, now)) expired++
    if ((demo as { synthetic?: unknown } | null)?.synthetic === true) synthetic++
  }
  return { total: rows.length - synthetic, synthetic, expired }
}

export interface ExpiredDemoOrg {
  orgId: string
  slug: string
  name: string
  variant: DemoVariant
  expiresAt: string
}

/**
 * Every demo org whose marker has expired, oldest expiry first. This is the
 * whole read surface a nightly reset job needs; it performs no deletion of its
 * own, on purpose, so the destructive half lands with its own review.
 *
 * Returns an empty list when demo mode is off, without running a query.
 */
export async function listExpiredDemoOrgs(
  now: Date = new Date(),
  limit = 500,
): Promise<ExpiredDemoOrg[]> {
  if (!isDemoModeEnabled()) return []
  const k = drizzleSql.raw(schemaRef("kernel"))
  const rows = await withSystemDb("demo-list-expired", async (tx) => {
    const result = await tx.execute(drizzleSql`
      SELECT id, slug, name, settings->'demo' AS demo
      FROM ${k}.organizations
      WHERE settings->'demo' IS NOT NULL
      ORDER BY created_at ASC
    `)
    return Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
  })
  // Expiry is decided by the SAME pure helper the request path uses, in JS
  // rather than in SQL: `expiresAt` is a hand-editable string inside a jsonb
  // blob, and a `::timestamptz` cast over one malformed value would fail the
  // whole reap instead of skipping one row.
  const expired: ExpiredDemoOrg[] = []
  for (const raw of rows as Array<Record<string, unknown>>) {
    const demo = typeof raw.demo === "string" ? JSON.parse(raw.demo) : raw.demo
    const marker = demoMarker({ settings: { demo } })
    // A POOLED org (demo-pool.ts) belongs to nobody yet and its clock has not
    // started: never a reaper's, whatever its marker's expiry says.
    if (demoPoolStateOf(demo)) continue
    if (!marker?.expiresAt) continue
    if (!isDemoOrgExpired({ settings: { demo } }, now)) continue
    expired.push({
      orgId: String(raw.id),
      slug: String(raw.slug),
      name: String(raw.name),
      variant: marker.variant,
      expiresAt: marker.expiresAt,
    })
    if (expired.length >= limit) break
  }
  return expired.sort((a, b) => a.expiresAt.localeCompare(b.expiresAt))
}
